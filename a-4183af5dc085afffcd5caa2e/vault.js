/* Porchlight Ledger Debt Planner: encryption for optional sync.
   The passphrase never leaves this device. From it we derive two separate values:
   - an encryption key (AES-256-GCM) that stays on this device, and
   - a sign-in value ("authKey") that is sent to the sync service to prove who you are.
   The service stores only the encrypted envelope. Works in the browser (window.PLVault) and in Node (module.exports). */
(function (root) {
  "use strict";
  var C = (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : null;
  var DEFAULT_ITER = 600000;
  var AAD = "porchlight-ledger-debt-planner:blob:v1";
  var enc = new TextEncoder(), dec = new TextDecoder();

  function b64url(bytes) {
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64url(str) {
    var t = str.replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "=";
    var bin = atob(t), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
  function normEmail(e) { return String(e || "").trim().toLowerCase(); }
  function supported() { return !!C; }

  // Rough guide only: length and variety. Longer is what matters; four or more unrelated words is a good passphrase.
  function strength(pass) {
    var p = String(pass || "");
    if (p.length < 12) return { ok: false, label: "Too short. Use at least 12 characters." };
    var words = p.trim().split(/\s+/).length;
    var classes = (/[a-z]/.test(p) ? 1 : 0) + (/[A-Z]/.test(p) ? 1 : 0) + (/[0-9]/.test(p) ? 1 : 0) + (/[^A-Za-z0-9]/.test(p) ? 1 : 0);
    if (/^(.)\1+$/.test(p)) return { ok: false, label: "Too repetitive." };
    if (p.length >= 20 || words >= 4 || (p.length >= 14 && classes >= 3)) return { ok: true, label: "Good length." };
    return { ok: true, label: "Okay. A longer phrase of four or more unrelated words is stronger." };
  }

  /* Returns { encKey: CryptoKey (not extractable), authKey: string }. */
  function deriveKeys(passphrase, email, iterations) {
    if (!C) return Promise.reject(new Error("This browser cannot do the encryption needed for sign-in."));
    var iter = iterations || DEFAULT_ITER;
    var salt = enc.encode("porchlight-ledger:v1:" + normEmail(email));
    return C.subtle.importKey("raw", enc.encode(String(passphrase).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]).then(function (k) {
      return C.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iter }, k, 256);
    }).then(function (master) {
      return C.subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
    }).then(function (hk) {
      function info(s) { return { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(s) }; }
      return Promise.all([
        C.subtle.deriveKey(info("porchlight-enc-v1"), hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        C.subtle.deriveBits(info("porchlight-auth-v1"), hk, 256)
      ]);
    }).then(function (r) { return { encKey: r[0], authKey: b64url(new Uint8Array(r[1])) }; });
  }

  /* plaintext string in, envelope string out */
  function encrypt(encKey, plaintext) {
    var iv = new Uint8Array(12); C.getRandomValues(iv);
    return C.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: enc.encode(AAD) }, encKey, enc.encode(plaintext)).then(function (ct) {
      return JSON.stringify({ v: 1, alg: "A256GCM", iv: b64url(iv), ct: b64url(new Uint8Array(ct)) });
    });
  }

  /* envelope string in, plaintext string out. Rejects with code "undecryptable" for a wrong key or changed data. */
  function decrypt(encKey, envelope) {
    function bad() { var e = new Error("These saved details could not be opened with this passphrase."); e.code = "undecryptable"; return e; }
    var o; try { o = JSON.parse(envelope); } catch (e) { return Promise.reject(bad()); }
    if (!o || o.v !== 1 || o.alg !== "A256GCM" || typeof o.iv !== "string" || typeof o.ct !== "string") return Promise.reject(bad());
    var iv, ct; try { iv = unb64url(o.iv); ct = unb64url(o.ct); } catch (e) { return Promise.reject(bad()); }
    if (iv.length !== 12) return Promise.reject(bad());
    return C.subtle.decrypt({ name: "AES-GCM", iv: iv, additionalData: enc.encode(AAD) }, encKey, ct).then(function (pt) { return dec.decode(pt); }, function () { throw bad(); });
  }

  var api = { DEFAULT_ITER: DEFAULT_ITER, supported: supported, strength: strength, deriveKeys: deriveKeys, encrypt: encrypt, decrypt: decrypt, normEmail: normEmail };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PLVault = api;
})(this);
