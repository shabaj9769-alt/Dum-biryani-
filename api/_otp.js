// OTP verify hone par server ek chhota signed token deta hai (phone + expiry). /api/order isi token ko check karta hai.
// Token ka secret: service account ki private key (alag secret banane ki zaroorat nahi).
const crypto = require('crypto');
const secret = (sa) => 'otp:' + String((sa && sa.private_key) || '');
exports.sign = (phone, sa, ttlMs) => {
  const p = Buffer.from(JSON.stringify({ p: phone, e: Date.now() + ttlMs })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', secret(sa)).update(p).digest('base64url');
};
exports.check = (token, phone, sa) => {
  try {
    const [p, s] = String(token || '').split('.');
    if (!p || !s) return false;
    const good = crypto.createHmac('sha256', secret(sa)).update(p).digest('base64url');
    if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return false;
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.p === String(phone).slice(-10) && d.e > Date.now();
  } catch (e) { return false; }
};
