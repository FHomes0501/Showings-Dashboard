export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    if (req.body.action === 'extract') {
      const { base64, filename } = req.body;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'pdfs-2024-09-25'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
              { type: 'text', text: 'Extract all text from this MLS showing report PDF. Return ONLY the raw text content, nothing else.' }
            ]
          }]
        })
      });
      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error });
      const text = data.content.map(b => b.text || '').join('\n');
      return res.status(200).json({ text });

    } else if (req.body.action === 'analyze') {
      const texts = req.body.texts;

      // Build the data section safely
      const dataSection = texts.map(t => {
        const safeName = t.name.replace(/[^\w\s\-\.\/]/g, '');
        const safeText = t.text
          .replace(/\\/g, ' ')
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
          .trim();
        return '=== ' + safeName + ' ===\n' + safeText;
      }).join('\n\n');

      const systemPrompt = 'You are analyzing MLS weekly showing reports for a home builder called Foundation Homes. Today is ' + today + '. Return ONLY a valid JSON object. No markdown. No code blocks. No text before or after the JSON. The JSON must be complete and valid.';

      const userMessage = 'Here is the showing report data:\n\n' + dataSection + '\n\n' +
        'Return a JSON object with this exact structure:\n' +
        '{"weekLabel":"Week of [dates]","reportTitle":"Weekly Showings Report","reportSub":"Foundation Homes - [dates] - Emily Schroeder, MacDoc","reportDate":"' + today + '","metrics":{"totalShowings":0,"feedbackRate":"X of Y (Z%)","positiveSentiment":"X%","avgDom":0,"listingsOver30Days":0,"decisionsNeeded":0},"properties":[{"address":"","city":"","price":"$0","listPrice":0,"listedDate":"Month D YYYY","daysOnMarket":0,"showingsThisWeek":0,"totalShowings":0,"feedbackReceived":"0/0","sentiment":"","sentimentColor":"gray","priceFeedback":"","status":"caution","badgeText":"","badgeColor":"gray","keyNotes":"","recommendedAction":"","actionColor":"gray","requiresDecision":false}],"decisions":[{"property":"","action":"","tag":"Approve","tagColor":"approve"}]}\n\n' +
        'Rules: sort requiresDecision true first by daysOnMarket desc. urgent=price concerns or 30+ days no offers or negative feedback. blocked=site issue. positive=active lead or liked/loved. caution=monitoring or new. daysOnMarket=days from listedDate to ' + today + '. Be direct, no hedging. sentimentColor: green=liked/loved, red=negative, amber=mixed, gray=none. badgeColor: red=urgent, amber=watch, green=positive, gray=neutral. Only include requiresDecision=true items in decisions array.';

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error });

      const raw = data.content.map(b => b.text || '').join('');
      const clean = raw.replace(/```json|```/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch (parseErr) {
        // Try to extract just the JSON object if there's extra text
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) {
          parsed = JSON.parse(match[0]);
        } else {
          throw new Error('Could not parse response as JSON: ' + parseErr.message);
        }
      }

      return res.status(200).json(parsed);

    } else {
      return res.status(400).json({ error: { message: 'Unknown action' } });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
