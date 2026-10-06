// Vercel serverless function: /api/cancel
// Customer apna order sirf tab cancel kar sakta hai jab status 'New' ya 'Confirmed' ho (cooking shuru hone se pehle).
// Login nahi hai: order ka secret code (DB-XXXXXXXX, random, 32^8 possibilities) hi customer ki pehchaan hai.
// Env var chahiye: FIREBASE_SERVICE_ACCOUNT (wahi jo /api/notify me hai).

const crypto = require('crypto');
const { derive, hash } = require('./_code');

const DB_URL = 'https://biryani-category-default-rtdb.firebaseio.com';
const CAN_CANCEL = ['New', 'Confirmed'];

let cached = { token: null, exp: 0 };
const b64 = (x) => Buffer.from(x).toString('base64url');

async function getAccessToken(sa) {
  const nowMs = Date.now();
  if (cached.token && nowMs < cached.exp) return cached.token;
  const now = Math.floor(nowMs / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + head + '.' + claim + '.' + sig,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('auth failed');
  cached = { token: j.access_token, exp: nowMs + 50 * 60 * 1000 };
  return j.access_token;
}
const dbGet = async (path, at, q) => (await fetch(DB_URL + '/' + path + '.json?access_token=' + at + (q || ''))).json();

// Firebase push-key ke shuru ke 8 akshar time batate hain. Isse bina index ke purane order dhoondh lete hain.
const PC = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
function keyAt(ms) { let t = ms, id = ''; for (let i = 0; i < 8; i++) { id = PC[t % 64] + id; t = Math.floor(t / 64); } return id; }
async function findOrderByCode(code, ts, at) {
  const t = Number(ts); if (!t) return [null, null];
  const q = '&orderBy=%22%24key%22&startAt=%22' + encodeURIComponent(keyAt(t - 15 * 60 * 1000)) + '%22&endAt=%22' + encodeURIComponent(keyAt(t + 15 * 60 * 1000)) + '~%22';
  const r = await dbGet('orders', at, q);
  const k = r && Object.keys(r).find((x) => r[x] && r[x].code === code);
  return k ? [k, r[k]] : [null, null];
}

const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) return false;
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) hits.clear();
  return true;
}

async function pushAdmins(sa, at, title, text) {
  try {
    const tokens = (await dbGet('adminTokens', at)) || {};
    await Promise.all(Object.keys(tokens).map(async (key) => {
      const token = tokens[key] && tokens[key].t;
      if (!token) return;
      const r = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
        method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title, body: text }, android: { priority: 'HIGH', notification: { channel_id: 'orders_bell', sound: 'bell' } } } }),
      });
      if (!r.ok && (r.status === 404 || r.status === 400)) await fetch(DB_URL + '/adminTokens/' + encodeURIComponent(key) + '.json?access_token=' + at, { method: 'DELETE' });
    }));
  } catch (e) { console.error('push failed', e); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const say = (c, error, extra) => res.status(c).json({ ok: false, error, ...extra });
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.private_key) return say(500, 'Server is not set up. Please call us to cancel.');

    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const code = String(b.code || '');
    if (!/^DB-[A-Z2-9]{8}$/.test(code)) return say(400, 'Invalid request.');

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    if (!limit('ip:' + ip, 15, 10 * 60 * 1000) || !limit('code:' + code, 6, 10 * 60 * 1000)) return say(429, 'Too many attempts. Please wait a few minutes or call us.');

    // 1) code se order dhoondo (tracking/<code> me order ki key `k` saved hai)
    const at = await getAccessToken(sa);
    let tp = hash(code), t = await dbGet('tracking/' + tp, at);
    if (!t) { tp = code; t = await dbGet('tracking/' + tp, at); } // purane orders (jinka tracking/<code> seedha saved tha)
    if (!t) return say(404, 'We could not find this order. Please check your code or call us.');

    let key = t.k, o = key ? await dbGet('orders/' + key, at) : null;
    if (!o) [key, o] = await findOrderByCode(code, t.ts, at); // purane orders (jinme key save nahi thi)
    if (!o || !(o.code === code || (key && derive(key, sa) === code))) return say(404, 'We could not find this order. Please call us to cancel.');

    // 2) rule: sirf cooking shuru hone se pehle
    const s = o.status || 'New';
    if (s === 'Cancelled') return res.status(200).json({ ok: true, already: true });
    if (!CAN_CANCEL.includes(s)) return say(409, s === 'Delivered' ? 'This order has already been delivered.' : 'Cooking has started, so this order can no longer be cancelled here. Please call us to cancel.', { status: s });

    const ts = Date.now();
    const w = await fetch(DB_URL + '/.json?access_token=' + at, {
      method: 'PATCH',
      body: JSON.stringify({ ['orders/' + key + '/status']: 'Cancelled', ['orders/' + key + '/cancelledBy']: 'customer', ['orders/' + key + '/cancelledAt']: ts, ['tracking/' + tp + '/status']: 'Cancelled' }),
    });
    if (!w.ok) throw new Error('db write failed ' + w.status);
    await pushAdmins(sa, at, 'Order cancelled by customer', String(o.name || '').slice(0, 40) + ' \u2022 ' + code + (o.total ? ' \u2022 \u20B9' + o.total : ''));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return say(500, 'Could not cancel the order. Please try again or call us.');
  }
};
