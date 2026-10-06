// Vercel serverless function: /api/order
// Order/enquiry yahin se banta hai. Customer ka bheja price, total, distance, time par bharosa NAHI kiya jata:
// price menu se, total/delivery server banata hai, radius (haversine) aur shop time server check karta hai.
// Env var chahiye: FIREBASE_SERVICE_ACCOUNT (wahi jo /api/notify me hai). Koi npm package nahi.

const crypto = require('crypto');
const { derive, hash } = require('./_code');

const DB_URL = 'https://biryani-category-default-rtdb.firebaseio.com';
const TZ = 'Asia/Kolkata';
const MAX_QTY = 500, MAX_ITEMS = 60;

let cached = { token: null, exp: 0 };
const b64 = (x) => Buffer.from(x).toString('base64url');
const r2 = (n) => Math.round(n * 100) / 100;
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

class Bad extends Error {}
const bad = (m) => { throw new Bad(m); };

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
const dbGet = async (path, at) => (await fetch(DB_URL + '/' + path + '.json?access_token=' + at)).json();

// ---- shop time (IST), server ki apni clock se ----
function shopNow() {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
  return { ymd: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}
const addD = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const tmin = (s) => {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1]; const p = (m[3] || '').toLowerCase();
  if (p) h = (h % 12) + (p === 'pm' ? 12 : 0);
  return h * 60 + +m[2];
};
const hav = (a, b, c, d) => {
  const R = 6371, r = (x) => (x * Math.PI) / 180, p = r(c - a), q = r(d - b);
  const h = Math.sin(p / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(q / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const serves = (m) => { const s = Number(m.servesPerUnit); if (s > 0) return s; const p = Number(m.perGuest); return p > 0 ? r2(1 / p) : 1; };

// ---- best-effort rate limit (serverless instance ki memory me) ----
const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) return false;
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) hits.clear();
  return true;
}

function pushId() {
  const C = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  let t = Date.now(), id = '';
  for (let i = 0; i < 8; i++) { id = C[t % 64] + id; t = Math.floor(t / 64); }
  const rb = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) id += C[rb[i] % 64];
  return id;
}
function mkCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', rb = crypto.randomBytes(8);
  return 'DB-' + [...rb].map((x) => A[x % 32]).join('');
}

async function build(b, st, menu, now) {
  const enq = b.type === 'Enquiry';
  const name = str(b.name, 60);
  const phone = String(b.phone || '').replace(/\D/g, '').slice(0, 15);
  if (!name || phone.length < 10) bad('Please enter your name and a 10-digit phone number.');
  const orderType = b.orderType === 'Booking' ? 'Booking' : 'Daily';
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const rv = b.replyVia === 'Email' ? 'Email' : 'WhatsApp';
  const email = str(b.email, 120);
  if (enq && rv === 'Email' && !emailRe.test(email)) bad('Please enter a valid email address so we can reply.');

  // ---- items: price hamesha menu se ----
  if (!Array.isArray(b.items) || !b.items.length) bad('Please add at least one dish.');
  if (b.items.length > MAX_ITEMS) bad('Too many dishes in one order.');
  const seen = new Set(), items = [];
  let sub = 0, guests = 0;
  for (const it of b.items) {
    const id = String((it && it.id) || '');
    const m = menu && menu[id];
    if (!m || seen.has(id)) bad('A dish in your cart is no longer on the menu. Please refresh and try again.');
    seen.add(id);
    if (m.available === false) bad(`${String(m.name || 'A dish').slice(0, 40)} is sold out. Please remove it and try again.`);
    const q = Number(it.qty), step = /^kg$/i.test(String(m.unit || '').trim()) ? 0.5 : 1;
    if (!isFinite(q) || q <= 0 || q > MAX_QTY || Math.abs(q / step - Math.round(q / step)) > 1e-9) bad('Invalid quantity for ' + String(m.name || 'a dish').slice(0, 40) + '.');
    const p = Number(m.price) || 0, sv = serves(m), people = q * sv;
    items.push({ id, name: m.name || '', category: m.category || 'Biryani', unit: m.unit || '', price: p, qty: q, servesPerUnit: sv, serves: Math.max(1, Math.round(people)), cost: r2(q * p) });
    sub += q * p; guests = Math.max(guests, people);
  }
  sub = r2(sub);

  const od = { type: enq ? 'Enquiry' : 'Order', name, phone, orderType, notes: str(b.notes, 300) };
  if (enq) { od.replyVia = rv; if (rv === 'Email' && email) od.email = email; }

  let delivery = 0;
  if (!enq) {
    const venue = str(b.venue, 300), date = str(b.date, 10), time = str(b.time, 12);
    if (!venue || !/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('Add your name, a 10-digit phone number, date and venue address.');
    if (b.terms !== '2026-10-06') bad('Please agree to the Terms, Cash on Delivery & Privacy Policy.');
    const daily = orderType === 'Daily';
    const o = tmin(st.shopOpen), c = tmin(st.shopClose);
    const inHours = (x) => (o == null || c == null || o === c) ? true : (o < c ? (x >= o && x < c) : (x >= o || x < c));

    if (daily) {
      if (st.dailyOn === false || !inHours(now.min)) bad('The shop is closed, so Daily Parcel is unavailable right now.');
      if (date < now.ymd || date > addD(now.ymd, 1)) bad('Please choose today or tomorrow.');
      const tm = tmin(time);
      if (tm != null && !inHours(tm)) bad('Please choose a time within shop hours.');
      if (date === now.ymd && tm != null && tm < now.min) bad('That time has already passed. Please choose a later time.');
    } else {
      if (st.bookingOn === false) bad('Order Booking is closed right now.');
      const n = Math.floor(Number(st.bookMinDays));
      if (date < addD(now.ymd, isNaN(n) || n < 0 ? 1 : n)) bad('Please choose a later date for Order Booking.');
    }

    // ---- delivery radius: server khud doori nikalta hai ----
    const la = Number(st.shopLat), lo = Number(st.shopLng), km = Number(daily ? st.dailyKm : st.bookKm);
    if (st.shopLat != null && st.shopLng != null && isFinite(la) && isFinite(lo) && km > 0) {
      const cl = Number(b.custLat), cn = Number(b.custLng);
      if (b.custLat == null || b.custLng == null || !isFinite(cl) || !isFinite(cn) || Math.abs(cl) > 90 || Math.abs(cn) > 180)
        bad('Please tap "Use my current location" to check your location first.');
      const d = hav(cl, cn, la, lo);
      if (d > km) bad(`You are ${d.toFixed(1)} km away. We deliver only within ${km} km.`);
      od.custLat = cl; od.custLng = cn; od.distKm = Math.round(d * 10) / 10;
    }

    const ch = Number(daily ? st.dailyCharge : st.bookCharge) || 0, fr = Number(daily ? st.dailyFree : st.bookFree) || 0;
    delivery = ch > 0 && !(fr > 0 && sub >= fr) ? ch : 0;
    Object.assign(od, { venue, date, time });
    od.terms = b.terms;
  }
  Object.assign(od, { guests: Math.round(guests), itemCount: items.length, items, subtotal: sub, delivery, total: r2(sub + delivery), status: enq ? 'Enquiry' : 'New', ts: now.ts });
  return { od, enq };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.private_key) return res.status(500).json({ ok: false, error: 'Server is not set up. Please call us to order.' });

    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    if (!b || typeof b !== 'object' || (b.type !== 'Order' && b.type !== 'Enquiry')) return res.status(400).json({ ok: false, error: 'Invalid request.' });

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    const ph = String(b.phone || '').replace(/\D/g, '').slice(-10);
    if (!limit('ip:' + ip, 8, 10 * 60 * 1000) || !limit('ph:' + ph, 4, 10 * 60 * 1000))
      return res.status(429).json({ ok: false, error: 'Too many orders in a short time. Please wait a few minutes or call us.' });

    const at = await getAccessToken(sa);
    const [st, menu] = await Promise.all([dbGet('settings', at), dbGet('menu', at)]);
    const now = { ...shopNow(), ts: Date.now() };
    const { od, enq } = await build(b, st || {}, menu || {}, now);

    const key = pushId(), up = { ['orders/' + key]: od };
    let code = '';
    if (!enq) {
      code = derive(key, sa); od.tk = hash(code); // code database me save nahi hota, sirf hash
      up['tracking/' + od.tk] = { k: key, status: 'New', orderType: od.orderType, date: od.date || null, time: od.time || null, total: od.total, ts: now.ts, items: od.items.map((i) => ({ name: i.name, qty: i.qty || null, unit: i.unit || null })) };
    }
    const w = await fetch(DB_URL + '/.json?access_token=' + at, { method: 'PATCH', body: JSON.stringify(up) });
    if (!w.ok) throw new Error('db write failed ' + w.status);
    return res.status(200).json({ ok: true, key, code, total: od.total });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ ok: false, error: e.message });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Could not place the order. Please try again or call us.' });
  }
};

module.exports._build = build; // sirf test ke liye
