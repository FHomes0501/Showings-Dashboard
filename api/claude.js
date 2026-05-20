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
      const dataSection = texts.map(t => '=== ' + t.name + ' ===\n' + t.text).join('\n\n');

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
          system: 'You are analyzing MLS weekly showing reports for a home builder called Foundation Homes. Today is ' + today + '. Return a single valid JSON object with no markdown, no code blocks, and no text before or after the JSON.',
          messages: [{
            role: 'user',
            content: dataSection + '\n\nAnalyze the showing reports above and return a JSON object with this structure:\n{\n  "weekLabel": "Week of [date range]",\n  "reportTitle": "Weekly Showings Report",\n  "reportSub": "Foundation Homes - [date range] - Emily Schroeder, MacDoc",\n  "reportDate": "' + today + '",\n  "metrics": { "totalShowings": 0, "feedbackRate": "X of Y (Z%)", "positiveSentiment": "X%", "avgDom": 0, "listingsOver30Days": 0, "decisionsNeeded": 0 },\n  "properties": [{ "address": "", "city": "", "price": "$XXX,XXX", "listPrice": 0, "listedDate": "Month D YYYY", "daysOnMarket": 0, "showingsThisWeek": 0, "totalShowings": 0, "feedbackReceived": "X/Y", "sentiment": "Liked", "sentimentColor": "green", "priceFeedback": "Just right", "status": "caution", "badgeText": "", "badgeColor": "gray", "keyNotes": "", "recommendedAction": "", "actionColor": "gray", "requiresDecision": false }],\n  "decisions": [{ "property": "", "action": "", "tag": "Approve", "tagColor": "approve" }]\n}\nRules: sort requiresDecision true first by daysOnMarket desc. urgent=price concerns or 30+ days no offers or negative feedback. blocked=site issue. positive=active lead or liked/loved. caution=monitoring or new listing. daysOnMarket=days from listedDate to today (' + today + '). Be direct in recommendedAction. sentimentColor: green=liked/loved, red=negative, amber=mixed, gray=none. badgeColor: red=urgent, amber=watch, green=positive, gray=neutral.'
          }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error });
      const raw = data.content.map(b => b.text || '').join('');
      const clean = raw.replace(/```json|```/g, '').trim();
      return res.status(200).json(JSON.parse(clean));

    } else {
      return res.status(400).json({ error: { message: 'Unknown action' } });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
