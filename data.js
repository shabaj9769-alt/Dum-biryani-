/* data.js — poore app ka data yahin se aata aur jaata hai (index.html + admin.html dono).
   Abhi MODE = 'firebase'. Vercel par shift karne ke baad:
     1) neeche MODE ko 'api' kar do
     2) dono HTML se do firebase <script src="...gstatic..."> tags hata do
   Baki app ka code badalne ki zaroorat nahi. API ka contract API.md me hai. */
(function () {
  var MODE = 'firebase';            // 'firebase' | 'api'
  var API = '/api', POLL_MS = 5000; // sirf 'api' mode ke liye
  var FB = {
    apiKey: "AIzaSyAZKvp9yhCq9i-7-wXiy-qkx3llHw_-6l8",
    authDomain: "biryani-category.firebaseapp.com",
    databaseURL: "https://biryani-category-default-rtdb.firebaseio.com",
    projectId: "biryani-category",
    storageBucket: "biryani-category.firebasestorage.app",
    messagingSenderId: "86398170612",
    appId: "1:86398170612:web:2029aeed3ca7cad88af5a1",
    measurementId: "G-XJ6RXX1GX3"
  };
  window.DATA_MODE = MODE;
  /* ⚠️ Website GitHub Pages par hai to yahan apna Vercel link likho (bina last slash), jaise 'https://dum-biryani.vercel.app'.
     Vercel par hi chal rahi ho to khali ('') chhod do. */
  var API_BASE = 'https://dumbiryani-ten.vercel.app';
  window.ORDER_URL = API_BASE + '/api/order';    // order yahin se server-check ho kar banta hai. Website kisi aur host par ho to poora URL likho.
  window.OTP_URL = API_BASE + '/api/otp';        // phone OTP (Fast2SMS)
  window.CANCEL_URL = API_BASE + '/api/cancel';  // customer apna order cooking se pehle yahin se cancel karta hai
  window.BILLS_URL = API_BASE + '/api/bills';    // customer: browser history clear hone par phone number se Delivered bills wapas laata hai
  window.CODE_URL = API_BASE + '/api/code';      // admin: customer ka code dekhne ke liye
  window.NOTIFY_URL = API_BASE + '/api/notify';  // Vercel function. Website kisi aur host par ho to poora URL likho: https://<project>.vercel.app/api/notify

  if (MODE === 'firebase') {
    firebase.initializeApp(FB);
    window.db = firebase.database();
    window.SERVER_TS = firebase.database.ServerValue.TIMESTAMP;
    window.DATA_AUTH = {
      required: !!firebase.auth,   // sirf admin page par firebase-auth script hai
      check: function () { return new Promise(function (r) { var u = firebase.auth().onAuthStateChanged(function (x) { u(); r(!!x); }); }); },
      login: function (pw, email) { return firebase.auth().signInWithEmailAndPassword(String(email || '').trim(), pw); },
      logout: function () { return firebase.auth().signOut(); }
    };
    return;
  }

  /* ---------- API mode: Firebase jaisa hi chhota ref() interface, REST par ---------- */
  window.SERVER_TS = { '.sv': 'timestamp' };           // server isse asli time se badal dega
  var clean = function (p) { return String(p || '').replace(/^\/+|\/+$/g, ''); };
  function req(method, path, body, qs) {
    var o = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(API + path + (qs ? '?' + qs : ''), o).then(function (r) {
      if (r.status === 204) return null;
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }
  var snap = function (v) { return { val: function () { return v === undefined ? null : v; }, exists: function () { return v != null; } }; };
  function Ref(p) { this.p = clean(p); }
  Ref.prototype = {
    once: function () {
      if (this.p === '.info/serverTimeOffset') {         // server ki asli clock - phone ki clock ka farak
        var t0 = Date.now();
        return req('GET', '/time').then(function (j) { return snap(Math.round((Number(j.now) - (t0 + Date.now()) / 2) / 1000) * 1000); });
      }
      return req('GET', '/data/' + this.p).then(snap);
    },
    on: function (ev, cb, err) {                         // polling; sirf badlav hone par cb chalta hai
      var self = this, last;
      var tick = function () {
        if (document.hidden && last !== undefined) return;
        self.once().then(function (s) { var j = JSON.stringify(s.val()); if (j !== last) { last = j; cb(s); } })
          .catch(function (e) { if (err) err(e); });
      };
      tick(); setInterval(tick, this.p === '.info/serverTimeOffset' ? 300000 : POLL_MS); return cb;
    },
    set: function (v) { return req('PUT', '/data/' + this.p, v); },
    update: function (o) { return req('PATCH', '/data/' + this.p, o); },   // ref() par multi-path update bhi chalta hai
    remove: function () { return req('DELETE', '/data/' + this.p); },
    push: function (v) { return req('POST', '/data/' + this.p, v).then(function (j) { return { key: j && j.key }; }); },
    orderByChild: function (k) {
      var p = this.p;
      return { equalTo: function (v) {
        return { once: function () { return req('GET', '/data/' + p, undefined, 'orderBy=' + encodeURIComponent(k) + '&equalTo=' + encodeURIComponent(v)).then(snap); } };
      } };
    }
  };
  window.db = { ref: function (p) { return new Ref(p); } };
  window.DATA_AUTH = {
    required: true,
    check: function () { return req('GET', '/me').then(function () { return true; }, function () { return false; }); },
    login: function (pw) { return req('POST', '/login', { password: pw }); },
    logout: function () { return req('POST', '/logout', {}); }
  };
})();
