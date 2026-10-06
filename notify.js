// Vercel serverless function: /api/notify
// Naya order aane par admin phone(s) ko FCM push bhejta hai (app band ho tab bhi).
// Env var chahiye: FIREBASE_SERVICE_ACCOUNT (service account JSON, poora text)
// Koi npm package nahi chahiye.

const crypto = require('crypto');

const DB_URL = 'https://biryani-category-default-rtdb.firebaseio.com';
const CHANNEL_ID = 'orders_bell';
let lastSent = 0;

const b64 = (x) => Buffer.from(x).toString('base64url');

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + head + '.' + claim + '.' + sig,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('auth failed: ' + JSON.stringify(j));
  return j.access_token;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (Date.now() - lastSent < 3000) return res.status(429).json({ ok: false, error: 'too fast' });
    lastSent = Date.now();

    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.private_key) return res.status(500).json({ ok: false, error: 'FIREBASE_SERVICE_ACCOUNT missing' });

    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const clip = (v, d, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);
    const title = clip(body.title, 'Naya order aaya!', 80);
    const text = clip(body.body, 'Admin app kholkar order dekhein.', 160);

    const at = await getAccessToken(sa);

    const tr = await fetch(DB_URL + '/adminTokens.json?access_token=' + at);
    const tokens = (await tr.json()) || {};

    const results = [];
    for (const key of Object.keys(tokens)) {
      const token = tokens[key] && tokens[key].t;
      if (!token) continue;
      const r = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body: text },
            android: {
              priority: 'HIGH',
              notification: { channel_id: CHANNEL_ID, sound: 'bell' },
            },
          },
        }),
      });
      const j = await r.json();
      results.push({ ok: r.ok });
      // band/purane token ko database se hata do
      if (!r.ok && (r.status === 404 || (j.error && j.error.status === 'NOT_FOUND') || (j.error && j.error.status === 'INVALID_ARGUMENT'))) {
        await fetch(DB_URL + '/adminTokens/' + encodeURIComponent(key) + '.json?access_token=' + at, { method: 'DELETE' });
      } else if (!r.ok) {
        console.error('FCM error', JSON.stringify(j));
      }
    }
    return res.status(200).json({ ok: true, sent: results.filter((x) => x.ok).length, total: results.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
