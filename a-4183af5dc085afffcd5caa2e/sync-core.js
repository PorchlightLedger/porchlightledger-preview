/* Porchlight Ledger Debt Planner: combining data from two devices. Pure functions, no network, no storage.
   Rules (so two devices always end up with the same result):
   - Debts are matched by id. A debt that exists on one side only is kept.
   - If both sides have a debt, the name, APR, minimum and in-plan setting come from the side edited most recently.
     The payment history is the combination of both sides.
   - A deleted debt is remembered (with the time) so it does not come back from another device, unless it was edited later.
   - Plan settings (method, extra, order) come from the side changed most recently.
   Known limit: removing a single history entry on one device does not remove it from another device that still has it.
   Works in the browser (window.PLSync core as PLSyncCore) and in Node. */
(function (root) {
  "use strict";
  var PP = root.PLProgress || (typeof require !== "undefined" ? require("./progress.js") : null);
  var MAX_TOMBSTONES = 200;

  function debtFp(d) { var c = {}; Object.keys(d).forEach(function (k) { if (k !== "updatedAt") c[k] = d[k]; }); return JSON.stringify(c); }
  function settingsFp(s) { return JSON.stringify({ method: s.method, extra: s.extra, order: s.order, onboarded: s.onboarded }); }
  function later(a, b) { // true when a is later than b; null is oldest
    if (a === b) return false;
    if (!a) return false; if (!b) return true;
    return a > b;
  }
  function maxTime(a, b) { return later(a, b) ? a : (b || a || null); }

  /* Called whenever the app saves. Records when things changed on this device. Changes state in place. */
  function stampChanges(prev, next, nowISO) {
    var pm = {}; (prev ? prev.debts : []).forEach(function (d) { pm[d.id] = d; });
    var tomb = {}; (next.deleted || []).forEach(function (t) { tomb[t.id] = t.at; });
    var seen = {};
    next.debts = next.debts.map(function (d) {
      seen[d.id] = true;
      var p = pm[d.id], out = d;
      if (!p || debtFp(p) !== debtFp(d)) out = Object.assign({}, d, { updatedAt: nowISO });
      else if (!d.updatedAt && p.updatedAt) out = Object.assign({}, d, { updatedAt: p.updatedAt });
      if (tomb[d.id] && !later(tomb[d.id], out.updatedAt || null)) delete tomb[d.id]; // brought back after being removed
      return out;
    });
    Object.keys(pm).forEach(function (id) { if (!seen[id]) tomb[id] = nowISO; });
    var list = Object.keys(tomb).map(function (id) { return { id: id, at: tomb[id] }; });
    list.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1; });
    next.deleted = list.slice(0, MAX_TOMBSTONES);
    if (!prev || settingsFp(prev) !== settingsFp(next)) next.settingsAt = nowISO;
    else next.settingsAt = next.settingsAt || prev.settingsAt || null;
    return next;
  }

  function pickNewer(a, b) { // the debt object edited later; exact ties broken by content so both devices agree
    if (later(a.updatedAt || null, b.updatedAt || null)) return a;
    if (later(b.updatedAt || null, a.updatedAt || null)) return b;
    return debtFp(a) >= debtFp(b) ? a : b;
  }

  function mergeDebt(a, b) {
    var w = pickNewer(a, b), seen = {}, hist = [];
    a.history.concat(b.history).forEach(function (h) {
      var k = h.date + "|" + h.balance; if (!seen[k]) { seen[k] = true; hist.push({ date: h.date, balance: h.balance }); }
    });
    var d = PP.recompute({ id: w.id, name: w.name, apr: w.apr, minPayment: w.minPayment, excluded: w.excluded, sample: a.sample && b.sample, history: hist });
    d.updatedAt = maxTime(a.updatedAt || null, b.updatedAt || null);
    return d;
  }

  function merge(a, b) {
    var tomb = {};
    (a.deleted || []).concat(b.deleted || []).forEach(function (t) { if (!tomb[t.id] || later(t.at, tomb[t.id])) tomb[t.id] = t.at; });
    var am = {}, bm = {}, ids = [];
    a.debts.forEach(function (d) { am[d.id] = d; ids.push(d.id); });
    b.debts.forEach(function (d) { bm[d.id] = d; if (!am[d.id]) ids.push(d.id); });
    var debts = [], alive = {};
    ids.forEach(function (id) {
      var d = am[id] && bm[id] ? mergeDebt(am[id], bm[id]) : (am[id] || bm[id]);
      if (tomb[id] && !later(d.updatedAt || null, tomb[id])) return; // removed, and not edited since
      debts.push(d); alive[id] = true;
    });
    debts.sort(function (x, y) { var dx = x.history[0].date, dy = y.history[0].date; return dx < dy ? -1 : dx > dy ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
    debts = debts.slice(0, 50);
    var deleted = Object.keys(tomb).filter(function (id) { return !alive[id]; }).map(function (id) { return { id: id, at: tomb[id] }; });
    deleted.sort(function (x, y) { return x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? -1 : 1; });
    deleted = deleted.slice(0, MAX_TOMBSTONES);
    var sw;
    if (later(a.settingsAt || null, b.settingsAt || null)) sw = a;
    else if (later(b.settingsAt || null, a.settingsAt || null)) sw = b;
    else sw = settingsFp(a) >= settingsFp(b) ? a : b;
    var order = (sw.order || []).filter(function (id) { return alive[id]; });
    var lb = a.lastBackup || null; // about backup files on this device, so it is never taken from the other side
    return { version: 1, method: sw.method, extra: sw.extra, order: order, onboarded: !!(a.onboarded || b.onboarded),
      lastBackup: lb, debts: debts, deleted: deleted, settingsAt: maxTime(a.settingsAt || null, b.settingsAt || null) };
  }

  /* Stable text form, used to tell whether two states are the same. */
  function canon(state) {
    var debts = state.debts.slice().sort(function (x, y) { return x.id < y.id ? -1 : 1; });
    return JSON.stringify({ method: state.method, extra: state.extra, order: state.order, onboarded: !!state.onboarded,
      debts: debts.map(function (d) { return { id: d.id, name: d.name, apr: d.apr, minPayment: d.minPayment, excluded: !!d.excluded, sample: !!d.sample, history: d.history, updatedAt: d.updatedAt || null }; }),
      deleted: (state.deleted || []).slice().sort(function (x, y) { return x.id < y.id ? -1 : 1; }), settingsAt: state.settingsAt || null });
  }

  var api = { stampChanges: stampChanges, merge: merge, canon: canon };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PLSyncCore = api;
})(this);
