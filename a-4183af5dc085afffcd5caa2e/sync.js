/* Porchlight Ledger Debt Planner: optional sign-in and sync (client side).
   If no sync address is configured (config.js), nothing here makes a network request and the app shows no account section.
   When one is configured and the person signs in, an encrypted copy of their debt data is saved with the sync service.
   The passphrase and the encryption key never leave this device. Works in the browser (window.PLSync) and in Node (module.exports, for tests). */
(function (root) {
  "use strict";
  var V = root.PLVault || (typeof require !== "undefined" ? require("./vault.js") : null);
  var CORE = root.PLSyncCore || (typeof require !== "undefined" ? require("./sync-core.js") : null);
  var PS = root.PLStore || (typeof require !== "undefined" ? require("./store.js") : null);

  /* Where the signed-in details live on this device. IndexedDB can keep the encryption key as an object the page cannot read back out.
     If IndexedDB is not available, the details are kept in memory until the page closes. */
  function idbSessionStore() {
    var mem = null, DB = "plledger-sync", ST = "kv", K = "session";
    function open() {
      return new Promise(function (res, rej) {
        if (!root.indexedDB) { rej(new Error("no idb")); return; }
        var r = root.indexedDB.open(DB, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore(ST); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(ST, mode), out = fn(t.objectStore(ST));
          t.oncomplete = function () { db.close(); res(out && out.result); };
          t.onerror = t.onabort = function () { db.close(); rej(t.error); };
        });
      });
    }
    return {
      load: function () { return tx("readonly", function (s) { return s.get(K); }).then(function (v) { return v || mem; }, function () { return mem; }); },
      save: function (v) { mem = v; return tx("readwrite", function (s) { return s.put(v, K); }).catch(function () { /* memory only */ }); },
      clear: function () { mem = null; return tx("readwrite", function (s) { return s.delete(K); }).catch(function () {}); }
    };
  }

  function create(cfg) {
    var base = String(cfg.baseUrl || "").replace(/\/+$/, "");
    var enabled = /^https?:\/\/[^\s]+$/.test(base) && !!(V && V.supported());
    var fetchFn = cfg.fetch || (typeof fetch === "function" ? fetch.bind(typeof globalThis !== "undefined" ? globalThis : root) : null);
    var store = cfg.sessionStore || idbSessionStore();
    var KDF = cfg.kdfIter || V.DEFAULT_ITER; // tests use a small number; the app always uses the default
    var delay = cfg.delayMs === undefined ? 4000 : cfg.delayMs;
    var nowISO = cfg.now || function () { return new Date().toISOString(); };
    var session = null, ready = null, timer = null, running = null, again = false;
    var status = { state: enabled ? "signed-out" : "off", message: "", at: null };
    var features = null;

    function emit(state, message) {
      status = { state: state, message: message || "", at: session && session.lastSyncedAt || null };
      if (cfg.onStatus) cfg.onStatus(status);
    }

    function http(method, path, body, token) {
      var headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers["Authorization"] = "Bearer " + token;
      return fetchFn(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
      }, function () { var e = new Error("Could not reach the sync service."); e.offline = true; throw e; });
    }
    function fail(res, fallback) { var e = new Error((res.body && res.body.message) || fallback); e.status = res.status; e.code = res.body && res.body.error; return e; }

    function init() {
      if (!enabled) return Promise.resolve();
      if (!ready) ready = store.load().then(function (s) {
        session = s && s.token && s.encKey ? s : null;
        emit(session ? "idle" : "signed-out");
      });
      return ready;
    }

    function probe() {
      if (!enabled) return Promise.resolve(null);
      return http("GET", "/api/health").then(function (r) { features = r.status === 200 && r.body && r.body.ok ? (r.body.features || {}) : null; return features; }, function () { features = null; return null; });
    }

    function startSession(email, keys, iter, token, expiresAt) {
      session = { email: email, token: token, expiresAt: expiresAt, encKey: keys.encKey, kdfIter: iter, lastSyncedAt: null };
      return store.save(session);
    }

    function register(email, passphrase) {
      if (!enabled) return Promise.reject(new Error("Sign-in is not available."));
      emit("working", "Creating your account...");
      email = V.normEmail(email);
      return V.deriveKeys(passphrase, email, KDF).then(function (keys) {
        return http("POST", "/api/register", { email: email, authKey: keys.authKey, kdfIter: KDF }).then(function (r) {
          if (r.status !== 201) throw fail(r, "Could not create the account.");
          return startSession(email, keys, KDF, r.body.token, r.body.expiresAt);
        });
      }).then(function () { return syncNow({ fresh: false }); }).catch(function (e) { emit(session ? "idle" : "signed-out"); throw e; });
    }

    function login(email, passphrase) {
      if (!enabled) return Promise.reject(new Error("Sign-in is not available."));
      emit("working", "Signing in...");
      email = V.normEmail(email);
      return http("POST", "/api/prelogin", { email: email }).then(function (p) {
        if (p.status !== 200) throw fail(p, "Could not sign in.");
        var iter = p.body.kdfIter;
        return V.deriveKeys(passphrase, email, iter).then(function (keys) {
          return http("POST", "/api/login", { email: email, authKey: keys.authKey }).then(function (r) {
            if (r.status !== 200) throw fail(r, "Could not sign in.");
            return startSession(email, keys, iter, r.body.token, r.body.expiresAt);
          });
        });
      }).then(function () { return syncNow({ fresh: true }); }).catch(function (e) { emit(session ? "idle" : "signed-out"); throw e; });
    }

    function signOut() {
      var tok = session && session.token; session = null;
      if (timer) { clearTimeout(timer); timer = null; }
      var p = tok && enabled ? http("POST", "/api/logout", {}, tok).catch(function () {}) : Promise.resolve();
      return Promise.all([p, store.clear()]).then(function () { emit("signed-out"); });
    }

    function deleteAccount() {
      if (!session) return Promise.reject(new Error("Not signed in."));
      return http("DELETE", "/api/account", undefined, session.token).then(function (r) {
        if (r.status !== 200) throw fail(r, "Could not delete the account.");
        session = null; return store.clear();
      }).then(function () { emit("signed-out"); });
    }

    function requestReset(email) { return http("POST", "/api/reset/request", { email: V.normEmail(email) }).then(function (r) { if (r.status !== 200) throw fail(r, "Could not send the code."); }); }
    function confirmReset(email, code, newPassphrase) {
      email = V.normEmail(email);
      return V.deriveKeys(newPassphrase, email, KDF).then(function (keys) {
        return http("POST", "/api/reset/confirm", { email: email, code: String(code).trim(), authKey: keys.authKey, kdfIter: KDF }).then(function (r) {
          if (r.status !== 200) throw fail(r, "That code is not right or has expired.");
          return startSession(email, keys, KDF, r.body.token, r.body.expiresAt);
        });
      }).then(function () { return syncNow({ fresh: false }); });
    }

    /* Pull what is saved, combine it with this device, apply the result here, and push it back if it changed. */
    function syncOnce(opts) {
      var tries = 0;
      function step(remote) {
        var local = cfg.getState();
        var p = remote ? V.decrypt(session.encKey, remote.data).then(function (txt) {
          var r = PS.sanitize(JSON.parse(txt)); if (!r.ok) { var e = new Error("The saved copy could not be read."); e.code = "undecryptable"; throw e; } return r.state;
        }) : Promise.resolve(null);
        return p.then(function (remoteState) {
          var merged;
          if (!remoteState) merged = local;
          else {
            if (opts.fresh && tries === 0 && local.debts.every(function (d) { return d.sample; })) local = Object.assign({}, local, { debts: [], deleted: [], order: [], settingsAt: null });
            merged = CORE.merge(local, remoteState);
          }
          var changedLocal = CORE.canon(merged) !== CORE.canon(cfg.getState());
          var needPush = !remote || !remoteState || CORE.canon(merged) !== CORE.canon(remoteState);
          if (changedLocal) cfg.applyMerged(merged);
          if (!needPush) return { rev: remote.rev, changed: changedLocal };
          return V.encrypt(session.encKey, JSON.stringify(PS.toPayload(merged, false))).then(function (envelope) {
            return http("PUT", "/api/blob", { baseRev: remote ? remote.rev : 0, data: envelope }, session.token).then(function (r) {
              if (r.status === 200) return { rev: r.body.rev, changed: changedLocal };
              if (r.status === 409 && ++tries < 5) return step({ rev: r.body.rev, data: r.body.data });
              throw fail(r, "Could not save.");
            });
          });
        });
      }
      return http("GET", "/api/blob", undefined, session.token).then(function (r) {
        if (r.status !== 200) throw fail(r, "Could not load.");
        return step(r.body.data ? { rev: r.body.rev, data: r.body.data } : (r.body.rev ? null : null));
      });
    }

    function syncNow(opts) {
      opts = opts || {};
      if (!enabled || !session) return Promise.resolve(null);
      if (running) { again = true; return running; }
      emit("syncing", "Saving...");
      running = syncOnce(opts).then(function (res) {
        session.lastSyncedAt = nowISO(); store.save(session);
        emit("synced", "Saved."); return res;
      }).catch(function (e) {
        if (cfg.debug) cfg.debug(e);
        if (e.status === 401) { session = null; store.clear(); emit("signed-out", "Your sign-in expired. Please sign in again."); }
        else if (e.offline) emit("offline", "Can't reach the sync service right now. Your data is safe on this device.");
        else if (e.code === "undecryptable") emit("error", "The saved copy could not be opened with this passphrase. Nothing was changed.");
        else emit("error", "Syncing did not work this time. Your data is safe on this device.");
        return null;
      }).then(function (res) {
        running = null;
        if (again) { again = false; schedule(); }
        return res;
      });
      return running;
    }

    function schedule() {
      if (!enabled || !session) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; syncNow(); }, delay);
    }

    return {
      enabled: enabled, init: init, probe: probe, register: register, login: login, signOut: signOut, deleteAccount: deleteAccount,
      requestReset: requestReset, confirmReset: confirmReset, syncNow: syncNow, schedule: schedule,
      signedIn: function () { return !!session; }, email: function () { return session ? session.email : null; },
      status: function () { return status; }, features: function () { return features; }
    };
  }

  var api = { create: create, idbSessionStore: idbSessionStore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PLSync = api;
})(this);
