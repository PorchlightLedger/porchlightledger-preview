/* Porchlight Ledger Debt Planner: saving, loading, export and import.
   Everything stays in this browser. No network. Works in the browser (window.PLStore) and in Node (module.exports). */
(function (root) {
  "use strict";
  var PP = root.PLProgress || (typeof require !== "undefined" ? require("./progress.js") : null);
  var APP = "porchlight-ledger-debt-planner";
  var VERSION = 1;
  var KEY = "plledger.debtplanner.v1";
  var MAX_DEBTS = 50;
  var MAX_IMPORT_BYTES = 2 * 1024 * 1024;

  function emptyState() { return { version: VERSION, method: "snowball", extra: 0, order: [], onboarded: false, lastBackup: null, debts: [] }; }

  function newId() {
    var s = "";
    for (var i = 0; i < 3; i++) s += Math.floor(Math.random() * 0x7fffffff).toString(36);
    return "d" + s;
  }

  function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }

  /* Check an untrusted object and build a clean state from it.
     Returns { ok: true, state } or { ok: false, errors: [messages] }. Nothing is partly accepted. */
  function sanitize(obj) {
    var errors = [];
    if (!isObj(obj)) return { ok: false, errors: ["This file is not a Debt Planner backup."] };
    if (obj.app !== undefined && obj.app !== APP) return { ok: false, errors: ["This file is not a Porchlight Ledger Debt Planner backup."] };
    if (!(typeof obj.version === "number" && Math.floor(obj.version) === obj.version && obj.version >= 1)) {
      return { ok: false, errors: ["This backup has no valid version number."] };
    }
    if (obj.version > VERSION) return { ok: false, errors: ["This backup was made by a newer version of the app. Update the app and try again."] };
    if (!Array.isArray(obj.debts)) return { ok: false, errors: ["This backup has no list of debts."] };
    if (obj.debts.length > MAX_DEBTS) return { ok: false, errors: ["This backup has more than " + MAX_DEBTS + " debts."] };

    var seen = {}, debts = [];
    obj.debts.forEach(function (raw, i) {
      var label = "Debt " + (i + 1) + ": ";
      if (!isObj(raw)) { errors.push(label + "not a valid debt."); return; }
      var f = { name: raw.name, balance: 1, apr: raw.apr, minPayment: raw.minPayment };
      var fe = PP.validateFields(f);
      delete fe.balance;
      if (typeof raw.name === "string" && raw.name.length > 200) fe.name = "Name is too long.";
      var keys = Object.keys(fe);
      if (keys.length) { errors.push(label + fe[keys[0]]); return; }
      if (!Array.isArray(raw.history) || raw.history.length < 1) { errors.push(label + "no history entries."); return; }
      if (raw.history.length > PP.MAX_HISTORY) { errors.push(label + "too many history entries."); return; }
      var hist = [];
      for (var k = 0; k < raw.history.length; k++) {
        var h = raw.history[k];
        if (!isObj(h) || !PP.isISODate(h.date) || typeof h.balance !== "number" || !isFinite(h.balance) || h.balance < 0 || h.balance > PP.MAX_MONEY) {
          errors.push(label + "history entry " + (k + 1) + " is not valid."); return;
        }
        hist.push({ date: h.date, balance: h.balance });
      }
      var id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) && !seen[raw.id] ? raw.id : newId();
      seen[id] = true;
      debts.push(PP.recompute({ id: id, name: raw.name, apr: raw.apr, minPayment: raw.minPayment,
        excluded: raw.excluded === true, sample: raw.sample === true, history: hist }));
    });
    if (errors.length) return { ok: false, errors: errors.slice(0, 5) };

    var extra = obj.extra === undefined ? 0 : obj.extra;
    if (!(typeof extra === "number" && isFinite(extra) && extra >= 0 && extra <= 1e7)) return { ok: false, errors: ["The extra monthly amount is not valid."] };
    var method = obj.method === undefined ? "snowball" : obj.method;
    if (method !== "snowball" && method !== "avalanche" && method !== "custom") return { ok: false, errors: ["The payoff method is not valid."] };
    var ids = {}; debts.forEach(function (d) { ids[d.id] = true; });
    var order = [];
    if (Array.isArray(obj.order)) obj.order.forEach(function (id) { if (typeof id === "string" && ids[id] && order.indexOf(id) < 0) order.push(id); });
    var lastBackup = typeof obj.lastBackup === "string" && !isNaN(Date.parse(obj.lastBackup)) ? obj.lastBackup : null;
    return { ok: true, state: { version: VERSION, method: method, extra: PP.round2(extra), order: order,
      onboarded: obj.onboarded === undefined ? debts.length > 0 : obj.onboarded === true, lastBackup: lastBackup, debts: debts } };
  }

  function toPayload(state, withExportDate) {
    var p = { app: APP, version: VERSION, method: state.method, extra: state.extra, order: state.order, onboarded: state.onboarded,
      lastBackup: state.lastBackup, debts: state.debts };
    if (withExportDate) { p.exportedAt = new Date().toISOString(); p.lastBackup = p.exportedAt; }
    return p;
  }

  function serialize(state) { return JSON.stringify(toPayload(state, true), null, 2); }

  function parseImport(text, byteLength) {
    if (typeof text !== "string" || text.trim() === "") return { ok: false, errors: ["The file is empty."] };
    if ((byteLength || text.length) > MAX_IMPORT_BYTES) return { ok: false, errors: ["The file is too large to be a Debt Planner backup."] };
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, errors: ["The file is not valid JSON."] }; }
    return sanitize(obj);
  }

  /* CSV. Export is for opening in a spreadsheet; import adds debts (name, balance, APR, minimum payment). */
  function csvCell(v) {
    var t = String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stop spreadsheet programs treating text as a formula
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  function toCSV(state) {
    var rows = [["name", "balance", "apr", "min_payment", "original_balance", "percent_paid", "paid_off_date", "in_plan"]];
    state.debts.forEach(function (d) {
      rows.push([d.name, d.balance.toFixed(2), d.apr, d.minPayment.toFixed(2), d.startBalance.toFixed(2),
        PP.percentPaid(d.startBalance, d.balance), d.paidOffDate || "", d.excluded ? "no" : "yes"]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  function splitCSV(text) {
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = ""; rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ""; }); });
  }

  function parseCSV(text, byteLength) {
    if (typeof text !== "string" || text.trim() === "") return { ok: false, errors: ["The file is empty."] };
    if ((byteLength || text.length) > MAX_IMPORT_BYTES) return { ok: false, errors: ["The file is too large."] };
    text = text.replace(/^\uFEFF/, "");
    var rows = splitCSV(text);
    var head = rows.shift().map(function (h) { return h.trim().toLowerCase().replace(/[\s_-]+/g, ""); });
    function col() { for (var a = 0; a < arguments.length; a++) { var i = head.indexOf(arguments[a]); if (i >= 0) return i; } return -1; }
    var ci = { name: col("name", "debt"), balance: col("balance", "currentbalance"), apr: col("apr", "rate", "interestrate"), min: col("minpayment", "minimumpayment", "minimum", "min") };
    if (ci.name < 0 || ci.balance < 0 || ci.apr < 0 || ci.min < 0) {
      return { ok: false, errors: ["The first row needs the headings: name, balance, apr, min_payment."] };
    }
    if (rows.length === 0) return { ok: false, errors: ["The file has no debts in it."] };
    if (rows.length > MAX_DEBTS) return { ok: false, errors: ["The file has more than " + MAX_DEBTS + " debts."] };
    var errors = [], debts = [];
    rows.forEach(function (r, i) {
      function clean(x) { x = (x || "").trim(); return /^'[=+\-@]/.test(x) ? x.slice(1) : x; }
      var f = { name: clean(r[ci.name]), balance: PP.parseNumber(r[ci.balance]), apr: PP.parseNumber((r[ci.apr] || "").replace("%", "")), minPayment: PP.parseNumber(r[ci.min]) };
      var e = PP.validateFields(f), k = Object.keys(e);
      if (k.length) errors.push("Row " + (i + 2) + ": " + e[k[0]]); else debts.push(f);
    });
    if (errors.length) return { ok: false, errors: errors.slice(0, 5) };
    return { ok: true, debts: debts };
  }

  /* storage is window.localStorage (or a stand-in). Never throws.
     status: "ok", "empty" (nothing saved yet), "corrupt" (saved data unreadable, kept aside) or "unavailable". */
  function load(storage) {
    var raw;
    try { raw = storage.getItem(KEY); } catch (e) { return { state: emptyState(), status: "unavailable" }; }
    if (raw === null || raw === undefined) return { state: emptyState(), status: "empty" };
    var res;
    try { res = sanitize(JSON.parse(raw)); } catch (e) { res = { ok: false }; }
    if (res.ok) return { state: res.state, status: "ok" };
    try { storage.setItem(KEY + ".unreadable", raw); } catch (e) { /* ignore */ }
    return { state: emptyState(), status: "corrupt" };
  }

  function save(storage, state) {
    try { storage.setItem(KEY, JSON.stringify(toPayload(state, false))); return true; } catch (e) { return false; }
  }

  function clearAll(storage) {
    var ok = true;
    [KEY, KEY + ".unreadable"].forEach(function (k) { try { storage.removeItem(k); } catch (e) { ok = false; } });
    return ok;
  }

  var api = { APP: APP, VERSION: VERSION, KEY: KEY, MAX_DEBTS: MAX_DEBTS, emptyState: emptyState, newId: newId,
    sanitize: sanitize, serialize: serialize, parseImport: parseImport, toCSV: toCSV, parseCSV: parseCSV, load: load, save: save, clearAll: clearAll };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PLStore = api;
})(this);
