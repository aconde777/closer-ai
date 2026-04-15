const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use((req, res, next) => {
  if (req.path === '/api/stripe-webhook') return next();
  express.json()(req, res, next);
});

// Inject Supabase credentials into HTML pages
const fs = require('fs');
function serveWithSupabase(file) {
  return (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
    html = html
      .replace('__SUPABASE_URL__', process.env.SUPABASE_URL || '')
      .replace('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  };
}

app.get('/', serveWithSupabase('landing.html'));
app.get('/landing.html', serveWithSupabase('landing.html'));
app.get('/app', serveWithSupabase('index.html'));
app.get('/index.html', serveWithSupabase('index.html'));
app.get('/auth.html', serveWithSupabase('auth.html'));
app.get('/call.html', serveWithSupabase('call.html'));
app.get('/warmup.html', serveWithSupabase('warmup.html'));

app.use(express.static(path.join(__dirname, 'public')));

// Supabase admin client (service role -- server only)
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Streak calculation
function calcStreak(profile) {
  const today = new Date().toISOString().split('T')[0];
  const last = profile.last_session_date;
  let streak = profile.streak_days || 0;

  if (!last) {
    streak = 1;
  } else if (last === today) {
    // Already trained today, no change
  } else {
    const diff = Math.floor((new Date(today) - new Date(last)) / 86400000);
    streak = diff === 1 ? streak + 1 : 1;
  }
  return { streak_days: streak, last_session_date: today };
}

async function updateStreak(userId, profile) {
  const data = calcStreak(profile);
  await supabaseAdmin.from('user_profiles').update(data).eq('id', userId);
}

// Check session count and increment if allowed
app.post('/api/session-start', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');

  // Verify the user's JWT
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const userId = user.id;

  // Get or create user profile
  let { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('session_count, is_pro, streak_days, last_session_date, minutes_balance, minutes_used')
    .eq('id', userId)
    .single();

  if (!profile) {
    // First time -- create profile
    const { data: newProfile } = await supabaseAdmin
      .from('user_profiles')
      .insert({ id: userId, session_count: 0, is_pro: false, minutes_balance: 45, minutes_used: 0 })
      .select()
      .single();
    profile = newProfile;
  }

  // GOD MODE -- admin accounts bypass all limits
  const ADMIN_EMAILS = ['alex.spartandesk@gmail.com'];
  if (ADMIN_EMAILS.includes(user.email)) {
    await updateStreak(userId, profile);
    return res.json({ allowed: true, sessionsUsed: profile.session_count, isPro: true, minutesBalance: 99999 });
  }

  // Check minutes balance for all users
  const balance = profile.minutes_balance ?? (profile.is_pro ? 120 : 45);
  if (balance <= 0) {
    return res.json({ allowed: false, reason: 'no_minutes', minutesBalance: 0, isPro: profile.is_pro });
  }

  // Pro users -- skip session count limit, just check minutes
  if (profile.is_pro) {
    await updateStreak(userId, profile);
    return res.json({ allowed: true, sessionsUsed: profile.session_count, isPro: true, minutesBalance: balance });
  }

  // Free trial limit
  if (profile.session_count >= 3) {
    return res.json({ allowed: false, reason: 'no_sessions', sessionsUsed: profile.session_count, isPro: false });
  }

  // Increment session count and update streak
  const streakData = calcStreak(profile);
  await supabaseAdmin
    .from('user_profiles')
    .update({ session_count: profile.session_count + 1, ...streakData })
    .eq('id', userId);

  res.json({ allowed: true, sessionsUsed: profile.session_count + 1, isPro: false, streak: streakData.streak_days });
});

// Load saved custom prospects for current user
app.get('/api/my-prospects', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error: dbErr } = await supabaseAdmin
    .from('custom_prospects')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (dbErr) return res.status(500).json({ error: dbErr.message });
  res.json({ prospects: data || [] });
});

// Create Vapi assistant from prospect form
app.post('/api/create-prospect', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.replace('Bearer ', '') : null;
  let userId = null;
  if (token) {
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (user) userId = user.id;
  }

  const { type, name, age, description, occupation, income, objections, industry } = req.body;

  const systemPrompt = `You are ${name}, a ${age}-year-old ${type === 'b2b' ? 'business' : 'consumer'} prospect on a sales call.

Background: ${description}
Occupation: ${occupation}
Income range: ${income}

Your objections to raise during the call:
${objections}

Personality guidelines:
- Sound like a real human, not a robot
- Keep responses short -- 1 to 3 sentences
- You are genuinely interested but have real concerns
- When the closer handles your objection well, soften and show more interest
- When pushed without your concern being addressed, become more resistant
- Start the call by answering naturally as if you picked up the phone
- Never break character
- Never say you are an AI`;

  try {
    const response = await fetch('https://api.vapi.ai/assistant', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VAPI_PRIVATE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: name,
        model: {
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'system', content: systemPrompt }]
        },
        voice: {
          provider: '11labs',
          voiceId: 'pNInz6obpgDQGcFmaJgB'
        },
        firstMessage: `Hello?`
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Vapi error');

    // Save to Supabase so it persists across sessions
    if (userId) {
      await supabaseAdmin.from('custom_prospects').insert({
        user_id: userId,
        assistant_id: data.id,
        name,
        role: occupation,
        objections,
        type,
        age,
        description,
        income,
        industry: industry || 'custom',
      });
    }

    res.json({ assistantId: data.id, name });
  } catch (err) {
    console.error('Create prospect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update custom prospect (Vapi assistant + Supabase)
app.put('/api/update-prospect/:assistantId', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { assistantId } = req.params;
  const { type, name, age, description, occupation, income, objections } = req.body;

  const systemPrompt = `You are ${name}, a ${age}-year-old ${type === 'b2b' ? 'business' : 'consumer'} prospect on a sales call.

Background: ${description}
Occupation: ${occupation}
Income range: ${income}

Your objections to raise during the call:
${objections}

Personality guidelines:
- Sound like a real human, not a robot
- Keep responses short -- 1 to 3 sentences
- You are genuinely interested but have real concerns
- When the closer handles your objection well, soften and show more interest
- When pushed without your concern being addressed, become more resistant
- Start the call by answering naturally as if you picked up the phone
- Never break character
- Never say you are an AI`;

  try {
    await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${process.env.VAPI_PRIVATE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        model: { provider: 'openai', model: 'gpt-4o', messages: [{ role: 'system', content: systemPrompt }] }
      })
    });

    await supabaseAdmin.from('custom_prospects')
      .update({ name, role: occupation, objections, type })
      .eq('assistant_id', assistantId)
      .eq('user_id', user.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete custom prospect (Vapi assistant + Supabase)
app.delete('/api/delete-prospect/:assistantId', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { assistantId } = req.params;

  try {
    await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${process.env.VAPI_PRIVATE_KEY}` }
    });

    await supabaseAdmin.from('custom_prospects')
      .delete()
      .eq('assistant_id', assistantId)
      .eq('user_id', user.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save completed call to history
app.post('/api/save-call', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid session' });

  const { prospectName, prospectRole, durationSeconds, scores, transcript } = req.body;

  try {
    // Save call history
    await supabaseAdmin.from('call_history').insert({
      user_id: user.id,
      prospect_name: prospectName,
      prospect_role: prospectRole,
      duration_seconds: durationSeconds,
      overall_score: scores?.overall,
      objection_score: scores?.categories?.[0]?.score,
      tonality_score: scores?.categories?.[1]?.score,
      closing_score: scores?.categories?.[2]?.score,
      rapport_score: scores?.categories?.[3]?.score,
      coach_notes: scores?.notes,
      transcript
    });

    // Deduct minutes used
    const minutesUsed = Math.ceil((durationSeconds || 0) / 60);
    if (minutesUsed > 0) {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles').select('minutes_balance, minutes_used').eq('id', user.id).single();
      const currentBalance = profile?.minutes_balance ?? 0;
      const currentUsed = profile?.minutes_used ?? 0;
      await supabaseAdmin.from('user_profiles').update({
        minutes_balance: Math.max(0, currentBalance - minutesUsed),
        minutes_used: currentUsed + minutesUsed
      }).eq('id', user.id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Save call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Score a call transcript using OpenAI
app.post('/api/score-call', async (req, res) => {
  const { transcript, prospectName } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

  const scoringPrompt = `You are a world-class high-ticket sales coach. Analyze this sales call transcript and score the sales rep's performance.

Prospect name: ${prospectName || 'AI Prospect'}

Transcript:
${transcript}

Score the rep on these 4 categories (0-100 each):
1. Objection Handling - Did they address the objection with confidence and a clear reframe?
2. Tonality - Did they sound confident, calm, and certain? Not desperate or pushy?
3. Closing Attempt - Did they actually attempt to close or ask for commitment?
4. Rapport - Did they build connection and make the prospect feel understood?

Calculate an overall score (0-100) as a weighted average.

Respond ONLY with valid JSON in this exact format:
{
  "overall": 75,
  "categories": [
    { "label": "Objection Handling", "score": 70, "note": "One specific coaching note in 1 sentence." },
    { "label": "Tonality", "score": 80, "note": "One specific coaching note in 1 sentence." },
    { "label": "Closing Attempt", "score": 65, "note": "One specific coaching note in 1 sentence." },
    { "label": "Rapport", "score": 78, "note": "One specific coaching note in 1 sentence." }
  ],
  "notes": "2-3 sentences of overall coaching feedback. Be direct and specific. Tell them exactly what to do differently."
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: scoringPrompt }],
        temperature: 0.3,
        max_tokens: 600
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'OpenAI error');

    const raw = data.choices[0].message.content.trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    res.json(parsed);

  } catch (err) {
    console.error('Score call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: verify auth token and return user
async function getUser(req, res) {
  const auth = req.headers.authorization;
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(auth.replace('Bearer ', ''));
  if (error || !user) { res.status(401).json({ error: 'Invalid session' }); return null; }
  return user;
}

// Get current user's profile + team info
app.get('/api/me', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('plan, team_id, is_team_owner, session_count, streak_days, is_pro, stripe_customer_id')
    .eq('id', user.id)
    .single();

  let team = null;
  if (profile?.team_id) {
    const { data } = await supabaseAdmin
      .from('teams')
      .select('id, plan, max_seats, sessions_per_seat')
      .eq('id', profile.team_id)
      .single();
    team = data;
  }

  res.json({ profile, team, email: user.email });
});

// Create a team (owner upgrades from solo to team)
app.post('/api/create-team', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { plan } = req.body;
  const planConfig = {
    team_starter: { max_seats: 5, sessions_per_seat: 20 },
    team_pro:     { max_seats: 10, sessions_per_seat: 20 },
    team_elite:   { max_seats: 15, sessions_per_seat: 20 }
  };
  const config = planConfig[plan];
  if (!config) return res.status(400).json({ error: 'Invalid plan' });

  // Check if user already owns a team
  const { data: existing } = await supabaseAdmin
    .from('teams').select('id').eq('owner_id', user.id).single();
  if (existing) return res.status(400).json({ error: 'Already have a team' });

  const { data: team, error } = await supabaseAdmin
    .from('teams')
    .insert({ owner_id: user.id, plan, ...config })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });

  await supabaseAdmin.from('user_profiles').update({
    plan, team_id: team.id, is_team_owner: true, is_pro: true
  }).eq('id', user.id);

  res.json({ team });
});

// Invite a member to the team
app.post('/api/invite-member', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Must be a team owner
  const { data: profile } = await supabaseAdmin
    .from('user_profiles').select('team_id, is_team_owner').eq('id', user.id).single();
  if (!profile?.is_team_owner || !profile?.team_id)
    return res.status(403).json({ error: 'Not a team owner' });

  // Check seat limit
  const { data: team } = await supabaseAdmin
    .from('teams').select('max_seats').eq('id', profile.team_id).single();
  const { count } = await supabaseAdmin
    .from('user_profiles').select('id', { count: 'exact', head: true })
    .eq('team_id', profile.team_id);
  if (count >= team.max_seats)
    return res.status(400).json({ error: 'Seat limit reached. Upgrade your plan to add more members.' });

  // Check for existing pending invite
  const { data: existing } = await supabaseAdmin
    .from('team_invites').select('id, status').eq('team_id', profile.team_id).eq('email', email).single();
  if (existing?.status === 'accepted') return res.status(400).json({ error: 'That user is already on the team.' });

  let invite;
  if (existing) {
    // Resend -- reuse token
    invite = existing;
  } else {
    const { data: newInvite, error } = await supabaseAdmin
      .from('team_invites').insert({ team_id: profile.team_id, email }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    invite = newInvite;
  }

  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const inviteLink = `${baseUrl}/join.html?token=${invite.token}`;

  // Send invite email via Resend
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (RESEND_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Elite Closer <support@theelitecloser.io>',
        to: [email],
        subject: `You've been invited to train on The Elite Closer`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #222222;border-radius:16px;overflow:hidden;max-width:560px;">
        <tr><td style="background:linear-gradient(135deg,#0a0a0a,#1a1200);padding:36px 40px;border-bottom:1px solid #2a1f00;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:12px;"><img src="https://theelitecloser.io/lion-transparent.png" width="40" height="40" style="display:block;border-radius:8px;" alt="The Elite Closer"></td>
            <td style="font-size:17px;font-weight:900;color:#ffffff;">The Elite <span style="color:#D4920A;">Closer</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#D4920A,transparent);"></td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 8px;font-size:24px;font-weight:900;color:#ffffff;">You're invited to train.</p>
          <p style="margin:0 0 28px;font-size:14px;color:#888888;line-height:1.6;">Your team has added you to The Elite Closer -- an AI voice sales trainer that puts you on live calls with realistic prospects and scores your performance after every session.</p>
          <p style="margin:0 0 24px;font-size:14px;color:#888888;line-height:1.6;">Click the button below to accept your invite and get access. If you don't have an account yet, you'll be able to create one first.</p>
          <a href="${inviteLink}" style="display:inline-block;background:linear-gradient(135deg,#C8820A,#F5C842);color:#000;text-decoration:none;border-radius:100px;padding:16px 36px;font-size:15px;font-weight:800;">Accept Invite &rarr;</a>
          <p style="margin:24px 0 0;font-size:12px;color:#555;">Or copy this link: <a href="${inviteLink}" style="color:#D4920A;">${inviteLink}</a></p>
        </td></tr>
        <tr><td style="padding:24px 40px;border-top:1px solid #222;">
          <p style="margin:0;font-size:12px;color:#555;line-height:1.6;">You're receiving this because you were invited to train on theelitecloser.io.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
      })
    }).catch(err => console.error('Invite email error:', err.message));
  }

  res.json({ inviteLink, email });
});

// Get team members list (owner only)
app.get('/api/team-members', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { data: profile } = await supabaseAdmin
    .from('user_profiles').select('team_id, is_team_owner').eq('id', user.id).single();
  if (!profile?.team_id) return res.status(403).json({ error: 'No team' });

  const { data: team } = await supabaseAdmin
    .from('teams').select('max_seats, plan').eq('id', profile.team_id).single();

  // Active members
  const { data: members } = await supabaseAdmin
    .from('user_profiles').select('id, plan, is_team_owner')
    .eq('team_id', profile.team_id);

  // Enrich with auth emails
  const enriched = await Promise.all((members || []).map(async m => {
    const { data: { user: u } } = await supabaseAdmin.auth.admin.getUserById(m.id);
    return { id: m.id, email: u?.email || 'Unknown', is_owner: m.is_team_owner };
  }));

  // Pending invites
  const { data: invites } = await supabaseAdmin
    .from('team_invites').select('email, token, status').eq('team_id', profile.team_id)
    .eq('status', 'pending');

  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const pendingWithLinks = (invites || []).map(i => ({
    ...i, inviteLink: `${baseUrl}/join.html?token=${i.token}`
  }));

  res.json({
    members: enriched,
    pending: pendingWithLinks,
    seatsUsed: enriched.length,
    maxSeats: team?.max_seats,
    plan: team?.plan
  });
});

// Remove a member from the team (owner only)
app.post('/api/remove-member', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { memberId } = req.body;
  const { data: profile } = await supabaseAdmin
    .from('user_profiles').select('team_id, is_team_owner').eq('id', user.id).single();
  if (!profile?.is_team_owner) return res.status(403).json({ error: 'Not a team owner' });

  await supabaseAdmin.from('user_profiles')
    .update({ team_id: null, plan: 'free' }).eq('id', memberId).eq('team_id', profile.team_id);

  res.json({ ok: true });
});

// Join a team via invite token
app.post('/api/join-team', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const { data: invite, error } = await supabaseAdmin
    .from('team_invites').select('*').eq('token', token).single();
  if (error || !invite) return res.status(404).json({ error: 'Invite not found or expired' });
  if (invite.status === 'accepted') return res.status(400).json({ error: 'Invite already used' });

  // Get team plan
  const { data: team } = await supabaseAdmin
    .from('teams').select('plan, max_seats').eq('id', invite.team_id).single();

  // Check seat limit
  const { count } = await supabaseAdmin
    .from('user_profiles').select('id', { count: 'exact', head: true })
    .eq('team_id', invite.team_id);
  if (count >= team.max_seats)
    return res.status(400).json({ error: 'Team is full. Ask your manager to upgrade the plan.' });

  await supabaseAdmin.from('user_profiles')
    .update({ team_id: invite.team_id, plan: team.plan, is_pro: true })
    .eq('id', user.id);

  await supabaseAdmin.from('team_invites')
    .update({ status: 'accepted' }).eq('id', invite.id);

  res.json({ ok: true, plan: team.plan });
});

// Upgrade team plan
app.post('/api/upgrade-team', async (req, res) => {
  const user = await getUser(req, res);
  if (!user) return;

  const { plan } = req.body;
  const planConfig = {
    team_starter: { max_seats: 5, sessions_per_seat: 20 },
    team_pro:     { max_seats: 10, sessions_per_seat: 20 },
    team_elite:   { max_seats: 15, sessions_per_seat: 20 }
  };
  const config = planConfig[plan];
  if (!config) return res.status(400).json({ error: 'Invalid plan' });

  const { data: profile } = await supabaseAdmin
    .from('user_profiles').select('team_id, is_team_owner').eq('id', user.id).single();
  if (!profile?.is_team_owner) return res.status(403).json({ error: 'Not a team owner' });

  await supabaseAdmin.from('teams')
    .update({ plan, ...config }).eq('id', profile.team_id);

  // Update all team members' plan
  await supabaseAdmin.from('user_profiles')
    .update({ plan }).eq('team_id', profile.team_id);

  res.json({ ok: true });
});

app.get('/join.html', serveWithSupabase('join.html'));

// ─── WELCOME EMAIL ──────────────────────────────────────────────────────────
app.post('/api/welcome-email', async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.json({ ok: false, reason: 'No Resend key' });

  const firstName = (name || 'there').split(' ')[0];

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #222222;border-radius:16px;overflow:hidden;max-width:560px;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#0a0a0a,#1a1200);padding:36px 40px;border-bottom:1px solid #2a1f00;">
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-right:12px;">
                <img src="https://theelitecloser.io/lion-transparent.png" width="40" height="40" style="display:block;border-radius:8px;" alt="The Elite Closer">
              </td>
              <td style="font-size:17px;font-weight:900;color:#ffffff;letter-spacing:-0.3px;">The Elite <span style="color:#D4920A;">Closer</span></td>
            </tr>
          </table>
        </td></tr>

        <!-- Gold accent line -->
        <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#D4920A,transparent);"></td></tr>

        <!-- Body -->
        <tr><td style="padding:40px;">
          <p style="margin:0 0 8px;font-size:24px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">Welcome, ${firstName}.</p>
          <p style="margin:0 0 28px;font-size:14px;color:#888888;line-height:1.6;">Your account is live. Here's how to get the most out of it.</p>

          <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:28px;">
            <tr>
              <td style="padding:16px;background:#0d0d0d;border:1px solid #222;border-left:3px solid #D4920A;border-radius:10px;margin-bottom:12px;display:block;">
                <p style="margin:0 0 4px;font-size:13px;font-weight:800;color:#ffffff;">1. Pick a prospect</p>
                <p style="margin:0;font-size:12px;color:#888888;line-height:1.6;">Choose Sandra J., Ray T., or build your own. Match the exact buyer you face on your calls.</p>
              </td>
            </tr>
            <tr><td style="height:10px;"></td></tr>
            <tr>
              <td style="padding:16px;background:#0d0d0d;border:1px solid #222;border-left:3px solid #D4920A;border-radius:10px;">
                <p style="margin:0 0 4px;font-size:13px;font-weight:800;color:#ffffff;">2. Run the call</p>
                <p style="margin:0;font-size:12px;color:#888888;line-height:1.6;">Click Start and talk. The AI pushes back in real time with real objections. Handle them or lose the deal.</p>
              </td>
            </tr>
            <tr><td style="height:10px;"></td></tr>
            <tr>
              <td style="padding:16px;background:#0d0d0d;border:1px solid #222;border-left:3px solid #D4920A;border-radius:10px;">
                <p style="margin:0 0 4px;font-size:13px;font-weight:800;color:#ffffff;">3. Get scored</p>
                <p style="margin:0;font-size:12px;color:#888888;line-height:1.6;">An AI coach scores you on objection handling, tonality, closing, and rapport. Real feedback, no fluff.</p>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 24px;font-size:13px;color:#888888;line-height:1.6;">You have <strong style="color:#D4920A;">3 free sessions</strong> to start. No credit card needed until you're ready to go Pro.</p>

          <table cellpadding="0" cellspacing="0" style="width:100%;">
            <tr><td align="center">
              <a href="https://theelitecloser.io/app" style="display:inline-block;background:linear-gradient(135deg,#C8820A,#F5C842);color:#000;font-size:15px;font-weight:800;text-decoration:none;padding:16px 48px;border-radius:100px;letter-spacing:-0.2px;">Start Training &rarr;</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 40px;border-top:1px solid #222;">
          <p style="margin:0;font-size:12px;color:#555;line-height:1.6;">You're receiving this because you signed up at theelitecloser.io.<br>Questions? Reply to this email.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Elite Closer <support@theelitecloser.io>',
        to: [email],
        subject: `Welcome to The Elite Closer, ${firstName}.`,
        html
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Resend error');

    // Notify owner of new signup
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Elite Closer <support@theelitecloser.io>',
        to: ['alex.spartandesk@gmail.com'],
        subject: `New signup: ${email}`,
        html: `<p style="font-family:sans-serif;font-size:15px;">New user just signed up on The Elite Closer.<br><br><strong>Email:</strong> ${email}<br><strong>Name:</strong> ${name || 'Not provided'}</p>`
      })
    }).catch(() => {}); // fire and forget

    res.json({ ok: true });
  } catch (err) {
    console.error('Welcome email error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.get('/settings', serveWithSupabase('settings.html'));
app.get('/settings.html', serveWithSupabase('settings.html'));
app.get('/drill', serveWithSupabase('drill.html'));
app.get('/drill.html', serveWithSupabase('drill.html'));

// ─── STRIPE ────────────────────────────────────────────────────────────────
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SK);

const PLANS = {
  solo:         { name: 'Solo Pro',      price: 4900,  plan: 'solo' },
  team_starter: { name: 'Team Starter',  price: 12900, plan: 'team_starter' },
  team_pro:     { name: 'Team Pro',      price: 24900, plan: 'team_pro' },
  team_elite:   { name: 'Team Elite',    price: 39900, plan: 'team_elite' },
};

// Minute packs -- one-time purchases
// Vapi cost ~$0.25/min. Priced for ~40%+ margin.
const MINUTE_PACKS = {
  minutes_60:  { name: '1 Hour Pack',   price: 2500,  minutes: 60  },  // $25 -- $10 profit
  minutes_120: { name: '3 Hour Pack',   price: 5900,  minutes: 120 },  // $59 -- $29 profit
  minutes_200: { name: '5 Hour Pack',   price: 8900,  minutes: 200 },  // $89 -- $39 profit
  minutes_400: { name: '10 Hour Pack',  price: 16900, minutes: 400 },  // $169 -- $69 profit
};

// Create Stripe Checkout session
app.post('/api/create-checkout', async (req, res) => {
  const { plan_key, user_id, email } = req.body;
  const plan = PLANS[plan_key];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  const appUrl = process.env.APP_URL || 'https://closer-ai-production-c51d.up.railway.app';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          recurring: { interval: 'month' },
          product_data: { name: plan.name },
          unit_amount: plan.price,
        },
        quantity: 1,
      }],
      customer_email: email,
      metadata: { user_id, plan_key },
      success_url: `${appUrl}/app?checkout=success&plan=${plan_key}`,
      cancel_url: `${appUrl}/app?checkout=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe billing portal -- let users update payment method
app.post('/api/billing-portal', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile } = await supabaseAdmin
      .from('user_profiles').select('stripe_customer_id').eq('id', user.id).single();

    if (!profile?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found.' });

    const appUrl = process.env.APP_URL || 'https://theelitecloser.io';
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/app`,
    });
    res.json({ url: session.url });
  } catch(err) {
    console.error('Billing portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Buy minute pack -- one-time Stripe checkout
app.post('/api/buy-minutes', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { pack_key } = req.body;
  const pack = MINUTE_PACKS[pack_key];
  if (!pack) return res.status(400).json({ error: 'Invalid pack' });

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

    const appUrl = process.env.APP_URL || 'https://theelitecloser.io';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `The Elite Closer -- ${pack.name}` },
          unit_amount: pack.price,
        },
        quantity: 1,
      }],
      metadata: { user_id: user.id, plan_key: pack_key },
      success_url: `${appUrl}/app?checkout=minutes`,
      cancel_url: `${appUrl}/app`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Buy minutes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook -- update user plan after successful payment
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, plan_key } = session.metadata || {};

    // Minute pack one-time purchase
    if (user_id && plan_key && MINUTE_PACKS[plan_key]) {
      const { data: p } = await supabaseAdmin.from('user_profiles').select('minutes_balance').eq('id', user_id).single();
      const addMinutes = MINUTE_PACKS[plan_key].minutes;
      await supabaseAdmin.from('user_profiles').update({
        minutes_balance: (p?.minutes_balance || 0) + addMinutes
      }).eq('id', user_id);
    }

    if (user_id && plan_key && !plan_key.startsWith('minutes_')) {
      const isTeam = plan_key.startsWith('team');
      const planMinutes = { solo: 120, team_starter: 400, team_pro: 800, team_elite: 1200 };

      // Try update first; if no row exists, insert with full defaults
      const { data: existing } = await supabaseAdmin.from('user_profiles').select('id').eq('id', user_id).single();
      if (existing) {
        const { error: updateErr } = await supabaseAdmin.from('user_profiles').update({
          plan: plan_key,
          is_pro: true,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          minutes_balance: planMinutes[plan_key] || 120,
        }).eq('id', user_id);
        if (updateErr) console.error('Webhook update error:', updateErr.message);
      } else {
        const { error: insertErr } = await supabaseAdmin.from('user_profiles').insert({
          id: user_id,
          plan: plan_key,
          is_pro: true,
          session_count: 0,
          streak_days: 0,
          minutes_balance: planMinutes[plan_key] || 120,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
        });
        if (insertErr) console.error('Webhook insert error:', insertErr.message);
      }

      if (isTeam) {
        // Create team if doesn't exist
        const { data: profile } = await supabaseAdmin
          .from('user_profiles').select('team_id').eq('id', user_id).single();
        if (!profile?.team_id) {
          const seats = { team_starter: 5, team_pro: 10, team_elite: 15 };
          const { data: team } = await supabaseAdmin.from('teams').insert({
            owner_id: user_id, plan: plan_key, max_seats: seats[plan_key] || 5
          }).select().single();
          if (team) {
            await supabaseAdmin.from('user_profiles')
              .update({ team_id: team.id, is_team_owner: true }).eq('id', user_id);
          }
        }
      }
    }
  }

  res.json({ received: true });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'elitecloser2024';

function adminAuth(req, res, next) {
  const auth = req.headers['x-admin-key'];
  if (auth !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Admin HTML page
app.get('/admin', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Admin stats endpoint
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const planPrices = { solo: 49, team_starter: 129, team_pro: 249, team_elite: 399 };

  const [
    { data: users },
    { data: calls },
    { data: teams },
    { data: { users: authUsers } },
  ] = await Promise.all([
    supabaseAdmin.from('user_profiles').select('id, plan, is_pro, session_count, streak_days, last_session_date, created_at'),
    supabaseAdmin.from('call_history').select('id, user_id, overall_score, duration_seconds, created_at'),
    supabaseAdmin.from('teams').select('id, plan, max_seats, owner_id'),
    supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  // Build email lookup map
  const emailMap = {};
  (authUsers || []).forEach(u => { emailMap[u.id] = u.email; });

  const totalUsers = users?.length || 0;
  const proUsers = users?.filter(u => u.is_pro).length || 0;
  const freeUsers = totalUsers - proUsers;
  const totalCalls = calls?.length || 0;
  const avgScore = calls?.length
    ? Math.round(calls.reduce((s, c) => s + (c.overall_score || 0), 0) / calls.length)
    : 0;
  const totalMinutes = Math.round((calls?.reduce((s, c) => s + (c.duration_seconds || 0), 0) || 0) / 60);

  // MRR estimate
  const mrr = users?.reduce((sum, u) => sum + (planPrices[u.plan] || 0), 0) || 0;

  // Plan breakdown
  const planCounts = { free: 0, solo: 0, team_starter: 0, team_pro: 0, team_elite: 0 };
  users?.forEach(u => { planCounts[u.plan || 'free'] = (planCounts[u.plan || 'free'] || 0) + 1; });

  // Recent signups (last 7 days)
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentSignups = users?.filter(u => u.created_at > week).length || 0;

  // Recent calls (last 7 days)
  const recentCalls = calls?.filter(c => c.created_at > week).length || 0;

  // Active users (trained in last 7 days)
  const activeUsers = users?.filter(u => u.last_session_date > week.split('T')[0]).length || 0;

  // Recent user list
  const recentUsers = [...(users || [])]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50)
    .map(u => ({
      id: u.id,
      email: emailMap[u.id] || '--',
      plan: u.plan || 'free',
      is_pro: u.is_pro,
      session_count: u.session_count || 0,
      streak_days: u.streak_days || 0,
      last_session_date: u.last_session_date,
      created_at: u.created_at,
    }));

  res.json({
    totalUsers, proUsers, freeUsers, totalCalls, avgScore, totalMinutes,
    mrr, planCounts, recentSignups, recentCalls, activeUsers, recentUsers,
    totalTeams: teams?.length || 0,
  });
});

app.listen(PORT, () => {
  console.log(`Closer AI running on port ${PORT}`);
});
