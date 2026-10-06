// Vercel serverless function: /api/code  (sirf admin ke liye)
// Customer code bhool jaye to admin yahan se order ka code dekh sakta hai. Code database me save nahi hai, server dobara banata hai.
// Env var chahiye: FIREBASE_SERVICE_ACCOUNT (wahi), ADMIN_EMAILS (admin ke login email, comma se alag: a@x.com,b@y.com)
const crypto = require('crypto');
const { derive, hash } = require('./_code');

const DB_URL = 'https://biryani-category-default-rtdb.firebaseio.com';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyAZKvp9yhCq9i-7-wXiy-qkx3llHw_-6l8'; // public web key (data.js me bhi hai)
let cached = { token: null, exp: 0 };
const b64 = (x) => Buffer.from(x).toString('base64url');

async function getAccessToken(sa) {
  const nowMs = Date.now();
  if (cached.token && nowMs < cached.exp) return cached.token;
  const now = Math.floor(nowMs / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + head + '.' + claim + '.' + sig });
  const j = await r.json();
  if (!j.access_token) throw new Error('auth failed');
  cached = { token: j.access_token, exp: nowMs + 50 * 60 * 1000 };
  return j.access_token;
}

const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) return false;
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) hits.clear();
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const say = (c, error) => res.status(c).json({ ok: false, error });
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    const admins = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    if (!sa.private_key || !admins.length) return say(500, 'Server setup adhura hai: Vercel me ADMIN_EMAILS daalo.');
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const key = String(b.key || ''), idToken = String(b.idToken || '');
    if (!/^[-\w]{20}$/.test(key) || idToken.length < 20) return say(400, 'Invalid request.');
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    if (!limit('ip:' + ip, 60, 10 * 60 * 1000)) return say(429, 'Bahut zyada try. Thodi der baad karo.');

    const lk = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
    const lj = await lk.json().catch(() => ({}));
    const u = lj && lj.users && lj.users[0];
    if (!lk.ok || !u || !u.email) return say(401, 'Admin login zaroori hai. Dobara login karo.');
    if (!admins.includes(String(u.email).toLowerCase())) return say(403, 'Ye email admin list me nahi hai.');

    const at = await getAccessToken(sa);
    const o = await (await fetch(DB_URL + '/orders/' + key + '.json?access_token=' + at)).json();
    if (!o) return say(404, 'Order nahi mila.');
    const code = derive(key, sa);
    if (o.tk && hash(code) !== o.tk) return say(404, 'Is order ka code nahi bana sakte.');
    return res.status(200).json({ ok: true, code });
  } catch (e) {
    console.error(e);
    return say(500, 'Code nahi mil paya. Dobara try karo.');
  }
};
