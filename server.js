const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create Vapi assistant from prospect form
app.post('/api/create-prospect', async (req, res) => {
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
    res.json({ assistantId: data.id, name });
  } catch (err) {
    console.error('Create prospect error:', err.message);
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

app.listen(PORT, () => {
  console.log(`Closer AI running on port ${PORT}`);
});
