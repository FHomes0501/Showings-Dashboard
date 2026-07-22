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
    const action = req.body.action;
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    if (action === 'extract') {
      const base64 = req.body.base64;
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
          temperature: 0,
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
      const text = data.content.map(function(b) { return b.text || ''; }).join('\n');
      console.log('EXTRACT TEXT SNIPPET:', text.substring(200, 400));
      const domMatch = text.match(/DOM\s*[\/\\]\s*CDOM\s*[:\s]+(\d+)\s*[\/\\]\s*(\d+)/i);
      const dom = domMatch ? parseInt(domMatch[1]) : null;
      const cdom = domMatch ? parseInt(domMatch[2]) : null;
      return res.status(200).json({ text: text, dom: dom, cdom: cdom, debug: 'v2' });

    } else if (action === 'analyze') {
      const texts = req.body.texts;

      // Parse the weekly agent comments with regex before any sanitization.
      // Reports accumulate one comment per week, written as
      // "2 Showings DOM / CDOM: 6 / 160" or "No showings DOM / CDOM: 20 / 174",
      // each under an "Ad Comment" entry with a date. We collect ALL of them
      // and keep only the MOST RECENT one (by the date right before it).
      const domCdomMap = {};
      const showingsMap = {};
      const feedbackMap = {};
      texts.forEach(function(t) {
        const rawText = t.text || '';
        const commentRe = /(No|\d+)\s+showings?\s+DOM\s*\/\s*CDOM\s*:?\s*(\d+)[\s\S]{0,60}?\/\s*(\d+)/gi;
        let m;
        let best = null;
        while ((m = commentRe.exec(rawText)) !== null) {
          // The comment's date is the nearest MM/DD/YYYY before it in the text
          const before = rawText.slice(Math.max(0, m.index - 200), m.index);
          const dates = before.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);
          const date = dates ? new Date(dates[dates.length - 1]) : null;
          const entry = {
            date: date,
            showings: /no/i.test(m[1]) ? 0 : parseInt(m[1], 10),
            dom: parseInt(m[2], 10),
            cdom: parseInt(m[3], 10)
          };
          if (!best) best = entry;
          else if (entry.date && (!best.date || entry.date > best.date)) best = entry;
        }
        if (best) {
          showingsMap[t.name] = best.showings;
          domCdomMap[t.name] = { dom: best.dom, cdom: best.cdom };
        } else {
          // Fallbacks if no full weekly comment was found
          let match = rawText.match(/DOM\s*[\/\\]\s*CDOM\s*:\s*(\d+)\s*[\/\\]\s*(\d+)/i);
          if (!match) match = rawText.match(/DOM\s*:\s*(\d+).*?CDOM\s*:\s*(\d+)/i);
          if (match) {
            domCdomMap[t.name] = { dom: parseInt(match[1]), cdom: parseInt(match[2]) };
          }
          const sMatch = rawText.match(/(\d+)\s+showings\b/i);
          if (sMatch) {
            showingsMap[t.name] = parseInt(sMatch[1], 10);
          } else if (/\bno\s+showings\b/i.test(rawText)) {
            showingsMap[t.name] = 0;
          }
        }
        // Feedback received during the report's final week: count
        // "Received on MM/DD/YYYY" entries dated within the last 7 days
        // of the snapshot period ("Snapshot for <start> - <end>").
        const snap = rawText.match(/Snapshot\s+for\s+([A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4})\s*-\s*([A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4})/i);
        const weekEnd = snap ? new Date(snap[2]) : null;
        const weekStart = weekEnd ? new Date(weekEnd.getTime() - 6 * 24 * 3600 * 1000) : null;
        let fbCount = 0;
        const fbRe = /Received\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/gi;
        let fm;
        while ((fm = fbRe.exec(rawText)) !== null) {
          const fbDate = new Date(fm[1]);
          if (!weekStart || (fbDate >= weekStart && fbDate <= new Date(weekEnd.getTime() + 24 * 3600 * 1000))) {
            fbCount++;
          }
        }
        feedbackMap[t.name] = fbCount;

        console.log('FILE:', t.name);
        console.log('LATEST COMMENT:', best ? JSON.stringify(best) : 'NONE (fallback used)');
        console.log('SHOWINGS:', showingsMap[t.name] !== undefined ? showingsMap[t.name] : 'NO MATCH');
        console.log('FEEDBACK THIS WEEK:', fbCount, '| week:', weekStart, '-', weekEnd);
      });

      // Sanitize text for prompt
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
        '- CRITICAL: metrics.totalShowings must be the SUM of each property\'s showingsThisWeek value only, never sum totalShowings (cumulative). Add up showingsThisWeek across all properties.\n' +
        '- CRITICAL: metrics.feedbackRate must reflect feedback received from THIS WEEK\'s showings only (showingsThisWeek), not cumulative feedback across the property\'s entire history.\n' +
        '- Sort: requiresDecision true first by cdom desc, then false by cdom desc\n' +
        '- urgent: price concerns, or 30+ CDOM no offers, or recurring negative feedback\n' +
        '- blocked: site or construction issue\n' +
        '- positive: active lead, liked or loved sentiment\n' +
        '- caution: monitoring, mixed, or new listing\n' +
        '- daysOnMarket: DOM from report if shown, else days from listedDate to today (' + today + ')\n' +
        '- cdom: CDOM from report if shown, else same as daysOnMarket\n' +
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
          temperature: 0,
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

      // Override showingsThisWeek with the regex-parsed value from each PDF.
      // Match property -> file by street number (must match if both have one)
      // plus best word-overlap score. No fallback: if there's no confident
      // match, the model's value is kept.
      if (parsed.properties && Object.keys(showingsMap).length > 0) {
        parsed.properties.forEach(function(prop) {
          const addr = (prop.address || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
          const addrWords = addr.split(/\s+/).filter(function(w) { return w.length > 2; });
          const addrNum = (addr.match(/\b(\d+)\b/) || [])[1];
          let matched = null;
          let bestScore = 0;
          Object.keys(showingsMap).forEach(function(filename) {
            // Use only the file name — ZIP entries include the folder path
            // (e.g. "Showing Report - July 7/..."), whose "7" would be
            // mistaken for the street number.
            const base = filename.split('/').pop();
            const fn = base.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
            const fnNum = (fn.replace(/^[^0-9]*report/i, '').match(/\b(\d+)\b/) || [])[1];
            if (addrNum && fnNum && addrNum !== fnNum) return;
            const words = addrWords.filter(function(w) { return fn.indexOf(w) !== -1; }).length;
            if (words === 0) return;
            // Street number match is a strong signal: filenames abbreviate
            // ("Ave" vs "AVENUE"), so 1 word + matching number is enough.
            const numBonus = (addrNum && fnNum && addrNum === fnNum) ? 2 : 0;
            const score = words + numBonus;
            if (score > bestScore) {
              bestScore = score;
              matched = filename;
            }
          });
          if (matched !== null && bestScore >= 2) {
            prop.showingsThisWeek = showingsMap[matched];
            if (feedbackMap[matched] !== undefined) {
              prop.feedbackReceived = feedbackMap[matched] + '/' + showingsMap[matched];
              prop.fbThisWeek = feedbackMap[matched];
            }
            // DOM/CDOM from the same matched file (replaces the old loose
            // matching that fell back to the first file's values)
            if (domCdomMap[matched]) {
              prop.daysOnMarket = domCdomMap[matched].dom;
              prop.cdom = domCdomMap[matched].cdom;
            }
          }
        });
      }

      // Recompute all aggregate metrics deterministically in code.
      // The model only extracts per-property facts; math is done here so
      // the same inputs always produce the same KPIs.
      if (parsed.properties && parsed.properties.length > 0) {
        const props = parsed.properties;

        const totalShowings = props.reduce(function(sum, p) {
          return sum + (parseInt(p.showingsThisWeek, 10) || 0);
        }, 0);

        let fbReceived = 0;
        let fbExpected = 0;
        props.forEach(function(p) {
          const m = String(p.feedbackReceived || '').match(/(\d+)\s*\/\s*(\d+)/);
          if (m) {
            fbReceived += parseInt(m[1], 10);
            fbExpected += parseInt(m[2], 10);
          }
        });

        // Positive sentiment: the DENOMINATOR is deterministic — properties
        // that received feedback this week according to the regex
        // (feedbackMap). Only the positive/negative reading of each comment
        // comes from the model (the numerator's labels).
        let withFeedback;
        if (Object.keys(feedbackMap).length === texts.length) {
          withFeedback = props.filter(function(p) {
            return (p.fbThisWeek || 0) > 0;
          });
        } else {
          withFeedback = props.filter(function(p) {
            return p.sentiment && !/none|no feedback|n\/a/i.test(p.sentiment);
          });
        }
        const positives = withFeedback.filter(function(p) {
          return /liked|loved|positive/i.test(p.sentiment || '');
        });

        // Avg CDOM and 30+ days: straight from the per-PDF regex values when
        // every PDF was parsed; fallback to per-property values otherwise.
        // Uses CDOM (cumulative days on market), the second number in
        // "No showings DOM / CDOM: 20 / 174" -> 174.
        const domFiles = Object.keys(domCdomMap);
        let avgDom;
        let over30;
        if (domFiles.length === texts.length) {
          avgDom = Math.round(domFiles.reduce(function(sum, k) {
            return sum + domCdomMap[k].cdom;
          }, 0) / domFiles.length);
          over30 = domFiles.filter(function(k) {
            return domCdomMap[k].cdom >= 30;
          }).length;
        } else {
          avgDom = Math.round(props.reduce(function(sum, p) {
            return sum + (parseInt(p.cdom, 10) || parseInt(p.daysOnMarket, 10) || 0);
          }, 0) / props.length);
          over30 = props.filter(function(p) {
            return (parseInt(p.cdom, 10) || 0) >= 30;
          }).length;
        }

        parsed.metrics = parsed.metrics || {};
        // If every uploaded PDF had a parsed weekly comment, the total comes
        // straight from the PDFs (showingsMap) — no matching involved.
        const mapFiles = Object.keys(showingsMap);
        if (mapFiles.length === texts.length) {
          parsed.metrics.totalShowings = mapFiles.reduce(function(sum, k) {
            return sum + showingsMap[k];
          }, 0);
        } else {
          parsed.metrics.totalShowings = totalShowings;
        }
        const fbFiles = Object.keys(feedbackMap);
        if (mapFiles.length === texts.length && fbFiles.length === texts.length) {
          // Showings and feedback were regex-parsed from every PDF:
          // compute the rate straight from the PDFs, no model involved.
          const fbTotal = fbFiles.reduce(function(sum, k) {
            return sum + feedbackMap[k];
          }, 0);
          const showTotal = parsed.metrics.totalShowings;
          parsed.metrics.feedbackRate = fbTotal + ' of ' + showTotal +
            ' (' + (showTotal > 0 ? Math.round((fbTotal / showTotal) * 100) : 0) + '%)';
        } else if (fbExpected > 0) {
          parsed.metrics.feedbackRate = fbReceived + ' of ' + fbExpected +
            ' (' + Math.round((fbReceived / fbExpected) * 100) + '%)';
        } else {
          parsed.metrics.feedbackRate = '0 of 0 (0%)';
        }
        parsed.metrics.positiveSentiment = withFeedback.length > 0
          ? Math.round((positives.length / withFeedback.length) * 100) + '%'
          : '0%';
        parsed.metrics.avgDom = avgDom;
        parsed.metrics.listingsOver30Days = over30;
        // One listing per uploaded PDF — not dependent on the model's output
        parsed.metrics.totalListings = texts.length;
        parsed.metrics.decisionsNeeded = props.filter(function(p) {
          return p.requiresDecision === true;
        }).length;
      }

      return res.status(200).json({ ...parsed, domCdomMap: domCdomMap, showingsMap: showingsMap, feedbackMap: feedbackMap });

    } else {
      return res.status(400).json({ error: { message: 'Unknown action' } });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
