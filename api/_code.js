// Order code kabhi database me save nahi hota. Wo order ki key + server ke secret (service account private key) se
// har baar dobara banta hai. Database me sirf code ka SHA-256 hash (tracking/<hash>) rehta hai, jisse code wapas nahi nikalta.
// Customer ka browser bhi code ko isi tarah hash karke padhta hai (index.html me hashCode()).
const crypto = require('crypto');
const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
exports.derive = (key, sa) => {
  const h = crypto.createHmac('sha256', String((sa && sa.private_key) || '')).update('code:' + key).digest();
  return 'DB-' + [...h.subarray(0, 8)].map((x) => A[x % 32]).join('');
};
exports.hash = (code) => crypto.createHash('sha256').update('dbc:' + code).digest('hex');
