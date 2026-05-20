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
    const messages = req.body.messages || [];
    const firstContent = messages[0]?.content;
    const hasPdf = Array.isArray(firstContent) && firstContent.some(c => c.type === 'document');

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };

    if (hasPdf) {
      headers['anthropic-beta'] = 'pdfs-2024-09-25';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
