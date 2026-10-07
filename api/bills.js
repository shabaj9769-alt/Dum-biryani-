// Vercel serverless function: /api/bills
// Browser history clear ho jaye to customer WhatsApp par mila apna koi bhi ek order code daale,
// aur us phone number ke sabhi DELIVERED orders ke bills ek sath download kar sake.
// Safety: sirf secret code wala hi dekh sakta hai (sirf phone number se kuch nahi milta).
// Sirf Delivered orders, sirf safe fields. Address (venue), asli order code, notes, lat/lng KABHI nahi jaate.
// Env var chahiye: FIREBASE_SERVICE_ACCOUNT (wahi jo /api/order me hai).
// Firebase rules me tracking ke andar ".indexOn": ["phone"] laga do (tez search ke liye).

const crypto = require('crypto');
const { hash } = require('./_code');

const DB_URL = 'https://biryani-category-default-rtdb.firebaseio.com';
let cached = { token: null, exp: 0 };
const b64 = (x) => Buffer.from(x).toString('base64url');

async function getAccessToken(sa) {
  const nowMs = Date.now();
  if (cached.token && nowMs < cached.exp) return cached.token;
  const now = Math.floor(nowMs / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
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

const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) return false;
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) hits.clear();
  return true;
}

const isDelivered = (s) => ['delivered', 'completed'].includes(String(s || '').trim().toLowerCase());

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const say = (c, error) => res.status(c).json({ ok: false, error });
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.private_key) return say(500, 'Server is not set up. Please call us.');
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const code = String(b.code || '');
    if (!/^DB-[A-Z2-9]{8}$/.test(code)) return say(400, 'Please enter a valid order code.');

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    if (!limit('ip:' + ip, 15, 10 * 60 * 1000) || !limit('code:' + code, 6, 10 * 60 * 1000))
      return say(429, 'Too many attempts. Please wait a few minutes or call us.');

    // 1) code sahi hai? tracking/<hash> (purane orders me tracking/<code>) se us order ka phone nikalo
    const at = await getAccessToken(sa);
    const get = async (path) => { const r = await fetch(DB_URL + '/' + path + '.json?access_token=' + at); if (!r.ok) throw new Error('db read failed ' + r.status); return r.json(); };
    let t0 = await get('tracking/' + hash(code));
    if (!t0) t0 = await get('tracking/' + code);
    if (!t0) return say(404, 'Code not found. Please check it again, or call us.');
    const ph = String(t0.phone || '').replace(/\D/g, '').slice(-10);
    if (ph.length !== 10) return res.status(200).json({ ok: true, orders: [] });

    // 2) us phone ke baaki Delivered orders. Phone 10 digit, 91 ke saath, ya 0 ke saath save ho sakta hai - teeno dhoondo
    const variants = [ph, '91' + ph, '0' + ph];
    const found = await Promise.all(variants.map(async (v) => {
      const q = '&orderBy=%22phone%22&equalTo=%22' + v + '%22&limitToLast=100';
      const r = await fetch(DB_URL + '/tracking.json?access_token=' + at + q);
      if (!r.ok) throw new Error('db read failed ' + r.status);
      return (await r.json()) || {};
    }));

    const seen = new Set(), out = [];
    for (const grp of found) for (const key of Object.keys(grp)) {
      const t = grp[key];
      if (!t || seen.has(key) || !isDelivered(t.status)) continue;
      seen.add(key);
      // ref: sirf dikhane ke liye ek chhota nishaan. Isse asli code ya order tak nahi pahunch sakte.
      const ref = 'REF-' + crypto.createHash('sha256').update('ref:' + key).digest('hex').slice(0, 8).toUpperCase();
      out.push({
        code: ref, name: t.name || '', phone: ph, status: 'Delivered',
        orderType: t.orderType || null, date: t.date || null, time: t.time || null,
        ts: t.ts || null, dAt: t.dAt || null,
        subtotal: t.subtotal, delivery: t.delivery || 0, itemTotal: t.itemTotal, deliveryFee: t.deliveryFee,
        gstPercentage: t.gstPercentage || 0, gstAmount: t.gstAmount || 0, grandTotal: t.grandTotal, total: t.total,
        items: (t.items || []).map((i) => ({ name: i.name, qty: i.qty || null, unit: i.unit || null, price: i.price, cost: i.cost })),
      });
    }
    out.sort((x, y) => (y.ts || 0) - (x.ts || 0));
    return res.status(200).json({ ok: true, orders: out.slice(0, 100) });
  } catch (e) {
    console.error(e);
    return say(500, 'Could not fetch your bills. Please try again or call us.');
  }
};
