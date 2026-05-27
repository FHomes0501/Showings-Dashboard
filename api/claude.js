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
    const action = req.body.action;
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    if (action === 'extract') {
      const base64 = req.body.base64;

      // Send as both document AND image so Claude reads visible content including annotations
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
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: base64 }
              },
              {
                type: 'text',
                text: 'Read everything visible on this MLS showing report page including any handwritten notes, stamps, annotations, overlays, or text added on top of the document. Pay special attention to any DOM (Days on Market) and CDOM (Cumulative Days on Market) values — these may appear as annotations or added text rather than part of the original document. Return ALL visible text content exactly as it appears, nothing else.'
              }
            ]
          }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error });
      const text = data.content.map(function(b) { return b.text || ''; }).join('\n');
      return res.status(200).json({ text: text });

    } else if (action === 'analyze') {
      const texts = req.body.texts;

      const safeData = texts.map(function(t) {
        const safeName = (t.name || '').replace(/[^\w\s\-\.]/g, '');
        const safeText = (t.text || '')
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
          .replace(/\\/g, '/')
          .replace(/"/g, "'")
          .trim();
        return '=== ' + safeName + ' ===\n' + safeText;
      }).join('\n\n');

      const systemMsg = 'You are analyzing MLS weekly showing reports for a home builder called Foundation Homes. Today is ' + today + '. Return ONLY a single complete valid JSON object. No markdown. No code fences. No explanation. No text before or after the JSON. Keep all string values concise to avoid truncation.';

      const userMsg = 'Showing report data:\n\n' + safeData + '\n\n' +
        'Return a JSON object with this structure:\n' +
        '{\n' +
        '  "weekLabel": "Week of [dates from reports]",\n' +
        '  "reportTitle": "Weekly Showings Report",\n' +
        '  "reportSub": "Foundation Homes - [dates] - Emily Schroeder, MacDoc",\n' +
        '  "reportDate": "' + today + '",\n' +
        '  "metrics": {\n' +
        '    "totalShowings": 0,\n' +
        '    "feedbackRate": "X of Y (Z%)",\n' +
        '    "positiveSentiment": "X%",\n' +
        '    "avgDom": 0,\n' +
        '    "listingsOver30Days": 0,\n' +
        '    "decisionsNeeded": 0\n' +
        '  },\n' +
        '  "properties": [\n' +
        '    {\n' +
        '      "address": "street address",\n' +
        '      "city": "city, state",\n' +
        '      "price": "$XXX,XXX",\n' +
        '      "listPrice": 0,\n' +
        '      "listedDate": "Month D YYYY",\n' +
        '      "daysOnMarket": 0,\n' +
        '      "cdom": 0,\n' +
        '      "showingsThisWeek": 0,\n' +
        '      "totalShowings": 0,\n' +
        '      "feedbackReceived": "X/Y",\n' +
        '      "sentiment": "Liked",\n' +
        '      "sentimentColor": "green",\n' +
        '      "priceFeedback": "Just right",\n' +
        '      "status": "caution",\n' +
        '      "badgeText": "label",\n' +
        '      "badgeColor": "gray",\n' +
        '      "keyNotes": "brief notes",\n' +
        '      "recommendedAction": "direct action",\n' +
        '      "actionColor": "gray",\n' +
        '      "requiresDecision": false\n' +
        '    }\n' +
        '  ],\n' +
        '  "decisions": [\n' +
        '    {\n' +
        '      "property": "short address",\n' +
        '      "action": "owner ask",\n' +
        '      "tag": "Approve",\n' +
        '      "tagColor": "approve"\n' +
        '    }\n' +
        '  ]\n' +
        '}\n\n' +
        'Rules:\n' +
        '- Sort: requiresDecision true first by cdom desc, then false by cdom desc\n' +
        '- urgent: price concerns, or 30+ CDOM no offers, or recurring negative feedback\n' +
        '- blocked: site or construction issue\n' +
        '- positive: active lead, liked or loved sentiment\n' +
        '- caution: monitoring, mixed, or new listing\n' +
        '- daysOnMarket: look for "DOM / CDOM: X / Y" format in the report — use the FIRST number (X) as daysOnMarket. If not found calculate from listedDate to today (' + today + ')\n' +
        '- cdom: look for "DOM / CDOM: X / Y" format in the report — use the SECOND number (Y) as cdom. If not found set equal to daysOnMarket\n' +
        '- cdom: look for "CDOM", "Cumulative Days on Market", or "Cumulative DOM" anywhere in the report text including annotations. If not found set equal to daysOnMarket\n' +
        '- If CDOM is much higher than DOM, note relisting in keyNotes\n' +
        '- requiresDecision true: urgent or blocked status\n' +
        '- decisions: only requiresDecision true items\n' +
        '- sentimentColor: green=liked/loved, red=negative, amber=mixed, gray=none\n' +
        '- badgeColor: red=urgent, amber=watch, green=positive, gray=neutral\n' +
        '- Keep keyNotes and recommendedAction under 20 words each';

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 8000,
          system: systemMsg,
          messages: [{ role: 'user', content: userMsg }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error });

      const raw = data.content.map(function(b) { return b.text || ''; }).join('');
      let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON object in response');
      clean = clean.slice(start, end + 1);

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch (e1) {
        clean = clean.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\t/g, ' ');
        try {
          parsed = JSON.parse(clean);
        } catch (e2) {
          throw new Error('Parse failed: ' + e1.message);
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
