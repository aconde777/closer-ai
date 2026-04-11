// Run once to create Sandra J. and Ray T. as Vapi assistants
// Usage: VAPI_KEY=your_key_here node create-assistants.js

const VAPI_KEY = process.env.VAPI_KEY;
if (!VAPI_KEY) { console.error('Missing VAPI_KEY env var'); process.exit(1); }

async function createAssistant({ name, age, description, occupation, income, objections, voice, firstMessage }) {
  const systemPrompt = `You are ${name}, a ${age}-year-old consumer prospect on a sales call about life insurance.

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
- Start the call by answering naturally as if you just picked up the phone
- Never break character
- Never say you are an AI`;

  const res = await fetch('https://api.vapi.ai/assistant', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      model: { provider: 'openai', model: 'gpt-4o', messages: [{ role: 'system', content: systemPrompt }] },
      voice: { provider: '11labs', voiceId: voice },
      firstMessage,
    })
  });

  const data = await res.json();
  if (!res.ok) { console.error(`Failed to create ${name}:`, data); return null; }
  console.log(`✓ ${name} created -- ID: ${data.id}`);
  return data.id;
}

async function main() {
  console.log('Creating Vapi assistants...\n');

  // Sandra J. -- female voice, intermediate difficulty
  const sandraId = await createAssistant({
    name: 'Sandra J.',
    age: '42',
    description: 'Married stay-at-home mom, financially cautious, always defers big decisions to her husband. Warm and friendly but noncommittal.',
    occupation: 'Stay-at-home parent',
    income: '$7,000-$15,000/month (household)',
    objections: '- "I need to talk to my husband before I make any decisions"\n- "We never make financial decisions without each other"\n- "Can you just send me something I can show him?"',
    voice: 'EXAVITQu4vr4xnSDxMaL', // ElevenLabs "Bella" -- female
    firstMessage: 'Hello?'
  });

  // Ray T. -- male voice, advanced difficulty
  const rayId = await createAssistant({
    name: 'Ray T.',
    age: '51',
    description: 'Retired engineer, very analytical and skeptical. Wants to see numbers and data before making any decision. Has been burned by salespeople before.',
    occupation: 'Retired engineer',
    income: '$15,000-$30,000/month',
    objections: '- "Let me run this by my accountant first"\n- "What are the actual projected returns? Show me the math"\n- "I\'ve heard these IUL policies have a lot of hidden fees"\n- "I need to compare this to my other investment options"',
    voice: 'ErXwobaYiN019PkySvjV', // ElevenLabs "Antoni" -- male
    firstMessage: 'Hello?'
  });

  console.log('\n--- COPY THESE INTO index.html ---');
  if (sandraId) console.log(`Sandra J. ID: ${sandraId}`);
  if (rayId) console.log(`Ray T. ID: ${rayId}`);
}

main();
