// Vercel serverless function: /api/otp  (Fast2SMS OTP)
// POST {action:'send', phone}            -> OTP bhejta hai
// POST {action:'verify', phone, otp}     -> sahi hone par {ok:true, token} deta hai (30 min valid)
// Env vars (Vercel -> Settings -> Environment Variables):
//   FAST2SMS_API_KEY  (Fast2SMS Dev API key)   FAST2SMS_OTP_ID  (Fast2SMS panel -> Smart OTP -> OTP ID)
//   FIREBASE_SERVICE_ACCOUNT (pehle se hai, token sign karne ke kaam aata hai)
const { sign } = require('./_otp');

const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) return false;
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) hits.clear();
  return true;
}
const f2s = async (path, body) => {
  const r = await fetch('https://www.fast2sms.com/dev/otp/' + path, {
    method: 'POST',
    headers: { Authorization: process.env.FAST2SMS_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const say = (c, error) => res.status(c).json({ ok: false, error });
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!process.env.FAST2SMS_API_KEY || !process.env.FAST2SMS_OTP_ID || !sa.private_key) return say(500, 'OTP setup adhura hai. Please call us to order.');
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone)) return say(400, 'Please enter a valid 10-digit mobile number.');
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';

    if (b.action === 'send') {
      // har SMS paise leta hai, isliye sakht limit
      if (!limit('si:' + ip, 10, 10 * 60 * 1000) || !limit('sp:' + phone, 3, 10 * 60 * 1000)) return say(429, 'Too many OTP requests. Please wait a few minutes.');
      const j = await f2s('send', { otp_id: process.env.FAST2SMS_OTP_ID, mobile: phone });
      if (!j.return) { console.error('fast2sms send', JSON.stringify(j)); return say(502, 'Could not send OTP. Please try again or call us.'); }
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'verify') {
      const otp = String(b.otp || '').replace(/\D/g, '');
      if (otp.length < 4 || otp.length > 8) return say(400, 'Please enter the OTP.');
      if (!limit('vi:' + ip, 30, 10 * 60 * 1000) || !limit('vp:' + phone, 6, 10 * 60 * 1000)) return say(429, 'Too many tries. Please wait a few minutes.');
      const j = await f2s('verify', { mobile: phone, otp });
      if (!j.return) return say(400, 'Wrong or expired OTP. Please try again.');
      return res.status(200).json({ ok: true, token: sign(phone, sa, 30 * 60 * 1000) });
    }
    return say(400, 'Invalid request.');
  } catch (e) {
    console.error(e);
    return say(500, 'OTP service error. Please try again.');
  }
};
