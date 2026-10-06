// Vercel serverless function: /api/notify
// Har naye order/enquiry par admin phone(s) ko FCM push bhejta hai (app band ho tab bhi).
// 4-5-10 order ek saath aaye to har order ki alag notification jaati hai.
// Env var chahiye: FIREBASE_SERVICE_ACCOUNT (service account JSON, poora text)
// Koi npm package nahi chahiye.

const crypto = require('crypto');

const DB_URL = 'https://biryani-category-default-rtdb.firebaseio.com';
const CHANNEL_ID = 'orders_bell';
const MAX_AGE_MS = 15 * 60 * 1000; // sirf 15 min tak ke order ka push (purane order se spam nahi)

let cached = { token: null, exp: 0 };
let lastTest = 0;

const b64 = (x) => Buffer.from(x).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (v, d, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);

async function getAccessToken(sa) {
  const nowMs = Date.now();
  if (cached.token && nowMs < cached.exp) return cached.token;
  const now = Math.floor(nowMs / 1000);
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
  cached = { token: j.access_token, exp: nowMs + 50 * 60 * 1000 };
  return j.access_token;
}

async function dbGet(path, at) {
  const r = await fetch(DB_URL + '/' + path + '.json?access_token=' + at);
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.private_key) return res.status(500).json({ ok: false, error: 'FIREBASE_SERVICE_ACCOUNT missing' });

    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const id = typeof body.id === 'string' ? body.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) : '';

    const at = await getAccessToken(sa);
    let title, text;

    if (id) {
      // Asli order: database me hona chahiye, naya hona chahiye, aur ek hi baar notify hoga.
      let o = await dbGet('orders/' + id, at);
      if (!o) { await sleep(1200); o = await dbGet('orders/' + id, at); }
      if (!o) return res.status(404).json({ ok: false, error: 'order not found' });
      if (o.ts && Date.now() - o.ts > MAX_AGE_MS) return res.status(200).json({ ok: true, skipped: 'old order' });

      const done = await dbGet('notifyLog/' + id, at);
      if (done) return res.status(200).json({ ok: true, skipped: 'already notified' });
      await fetch(DB_URL + '/notifyLog/' + id + '.json?access_token=' + at, {
        method: 'PUT',
        body: JSON.stringify({ ts: Date.now() }),
      });

      const isEnq = o.status === 'Enquiry' || o.type === 'enquiry';
      const who = clip(o.name, '', 40);
      title = isEnq ? 'Naya enquiry aayi!' : 'Naya order aaya!';
      const parts = [];
      if (who) parts.push(who);
      if (!isEnq && o.total) parts.push('\u20B9' + o.total);
      if (o.orderType) parts.push(String(o.orderType).slice(0, 20));
      text = parts.length ? parts.join(' \u2022 ') : 'Admin app kholkar dekhein.';
    } else {
      // id ke bina = sirf test (browser se). Spam rokne ke liye 5 sec ki limit.
      if (Date.now() - lastTest < 5000) return res.status(429).json({ ok: false, error: 'test too fast' });
      lastTest = Date.now();
      title = clip(body.title, 'Test notification', 80);
      text = clip(body.body, 'Notification sahi chal rahi hai.', 160);
    }

    const tokens = (await dbGet('adminTokens', at)) || {};
    const keys = Object.keys(tokens);

    const results = await Promise.all(keys.map(async (key) => {
      const token = tokens[key] && tokens[key].t;
      if (!token) return false;
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
      if (r.ok) return true;
      const j = await r.json().catch(() => ({}));
      const st = j.error && j.error.status;
      if (r.status === 404 || st === 'NOT_FOUND' || st === 'UNREGISTERED' || st === 'INVALID_ARGUMENT') {
        await fetch(DB_URL + '/adminTokens/' + encodeURIComponent(key) + '.json?access_token=' + at, { method: 'DELETE' });
      } else {
        console.error('FCM error', JSON.stringify(j));
      }
      return false;
    }));

    return res.status(200).json({ ok: true, sent: results.filter(Boolean).length, total: keys.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
