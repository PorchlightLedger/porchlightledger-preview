/* Porchlight Ledger Debt Planner: debt records and progress math.
   Pure functions, no storage, no DOM. Works in the browser (window.PLProgress) and in Node (module.exports). */
(function (root) {
  "use strict";
  var MAX_MONEY = 1e8;
  var MAX_HISTORY = 500;
  var NAME_MAX = 40;

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function round2(x) { return Math.round(x * 100) / 100; }

  function todayISO(now) {
    now = now || new Date();
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  }

  function isISODate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 2000 || y > 2100) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // Accepts "1200", "1,200.50", "$1,200.50". Returns NaN for anything else.
  function parseNumber(v) {
    if (typeof v === "number") return isFinite(v) ? v : NaN;
    if (typeof v !== "string") return NaN;
    var s = v.replace(/[\s$,]/g, "");
    if (s === "" || !/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
    return Number(s);
  }

  function cleanName(s) {
    if (typeof s !== "string") return "";
    return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  }

  /* Validate the fields of a debt. opts.allowZeroBalance is true when editing a paid-off debt.
     Returns an object of messages keyed by field; empty object means valid. */
  function validateFields(f, opts) {
    opts = opts || {};
    var e = {};
    if (!cleanName(f.name)) e.name = "Give this debt a name.";
    if (!(isFinite(f.balance) && (opts.allowZeroBalance ? f.balance >= 0 : f.balance > 0))) {
      e.balance = opts.allowZeroBalance ? "Enter a balance of $0 or more." : "Enter a balance above $0.";
    } else if (f.balance > MAX_MONEY) e.balance = "Enter a balance under $100,000,000.";
    if (!(isFinite(f.apr) && f.apr >= 0 && f.apr <= 100)) e.apr = "Enter an APR from 0 to 100.";
    if (!(isFinite(f.minPayment) && f.minPayment > 0)) e.minPayment = "Enter a minimum payment above $0.";
    else if (f.minPayment > MAX_MONEY) e.minPayment = "Enter a minimum payment under $100,000,000.";
    return e;
  }

  // Derived fields: history sorted by date, current balance = latest entry, start = highest recorded balance.
  function recompute(debt) {
    var hist = debt.history.map(function (h, i) { return { date: h.date, balance: round2(h.balance), i: i }; });
    hist.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i; });
    hist = hist.map(function (h) { return { date: h.date, balance: h.balance }; });
    var last = hist[hist.length - 1];
    var start = hist.reduce(function (m, h) { return Math.max(m, h.balance); }, 0);
    return {
      id: debt.id, name: cleanName(debt.name), apr: debt.apr, minPayment: round2(debt.minPayment),
      excluded: !!debt.excluded, sample: !!debt.sample,
      history: hist, balance: last.balance, startBalance: start,
      paidOffDate: last.balance <= 0 ? last.date : null
    };
  }

  function makeDebt(fields, today, id) {
    var errors = validateFields(fields);
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    if (!isISODate(today)) return { ok: false, errors: { date: "Date is not valid." } };
    return { ok: true, debt: recompute({
      id: id, name: fields.name, apr: fields.apr, minPayment: fields.minPayment,
      excluded: !!fields.excluded, sample: !!fields.sample,
      history: [{ date: today, balance: round2(fields.balance) }]
    }) };
  }

  function withHistory(debt, history) {
    return { id: debt.id, name: debt.name, apr: debt.apr, minPayment: debt.minPayment, excluded: debt.excluded, sample: debt.sample, history: history };
  }

  function balanceOn(debt, date) {
    var b = debt.history[0].balance;
    for (var i = 0; i < debt.history.length; i++) if (debt.history[i].date <= date) b = debt.history[i].balance;
    return b;
  }

  /* input: { date, mode: "payment" | "balance", value }.
     "payment" subtracts the amount from the balance on that date (not below $0); "balance" sets the balance. */
  function logEntry(debt, input, today) {
    var errors = {};
    if (!isISODate(input.date)) errors.date = "Choose a valid date.";
    else if (input.date > today) errors.date = "Choose today or an earlier date.";
    var v = input.value;
    if (input.mode === "payment") {
      if (!(isFinite(v) && v > 0)) errors.value = "Enter a payment above $0.";
      else if (v > MAX_MONEY) errors.value = "Enter a payment under $100,000,000.";
    } else {
      if (!(isFinite(v) && v >= 0)) errors.value = "Enter a balance of $0 or more.";
      else if (v > MAX_MONEY) errors.value = "Enter a balance under $100,000,000.";
    }
    if (!Object.keys(errors).length && debt.history.length >= MAX_HISTORY) {
      errors.value = "This debt's history is full (" + MAX_HISTORY + " entries). Remove an old entry first.";
    }
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    var next = input.mode === "payment" ? Math.max(0, round2(balanceOn(debt, input.date) - v)) : round2(v);
    var d = recompute(withHistory(debt, debt.history.concat([{ date: input.date, balance: next }])));
    return { ok: true, debt: d, newBalance: next, paidOff: d.balance <= 0 };
  }

  function removeEntry(debt, index) {
    if (debt.history.length <= 1) return { ok: false, error: "A debt needs at least one history entry." };
    if (!(index >= 0 && index < debt.history.length)) return { ok: false, error: "That entry does not exist." };
    var h = debt.history.slice(); h.splice(index, 1);
    return { ok: true, debt: recompute(withHistory(debt, h)) };
  }

  // fields: { name, balance, apr, minPayment }. A changed balance is recorded as a history entry dated today.
  function editDebt(debt, fields, today) {
    var errors = validateFields(fields, { allowZeroBalance: true });
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    var d = recompute({ id: debt.id, name: fields.name, apr: fields.apr, minPayment: fields.minPayment,
      excluded: fields.excluded === undefined ? debt.excluded : fields.excluded, sample: debt.sample, history: debt.history });
    if (round2(fields.balance) !== d.balance) {
      var r = logEntry(d, { date: today, mode: "balance", value: fields.balance }, today);
      if (!r.ok) return { ok: false, errors: { balance: r.errors.value || r.errors.date } };
      d = r.debt;
    }
    return { ok: true, debt: d };
  }

  // Whole-percent progress for one debt. 100 only when the balance is $0.
  function percentPaid(start, current) {
    if (!(start > 0)) return 0;
    if (current <= 0) return 100;
    var p = Math.floor(100 * (start - current) / start);
    return Math.max(0, Math.min(99, p));
  }

  function summary(debts) {
    var s = { count: debts.length, paidOff: 0, active: 0, totalStart: 0, totalCurrent: 0, totalPaidDown: 0, percent: 0 };
    debts.forEach(function (d) {
      if (d.balance <= 0) s.paidOff++; else s.active++;
      s.totalStart += d.startBalance; s.totalCurrent += d.balance;
    });
    s.totalStart = round2(s.totalStart); s.totalCurrent = round2(s.totalCurrent);
    s.totalPaidDown = round2(s.totalStart - s.totalCurrent);
    s.percent = percentPaid(s.totalStart, s.totalCurrent);
    s.allPaidOff = s.count > 0 && s.active === 0;
    return s;
  }

  // For the history list: how much each entry moved the balance (positive = paid down).
  function historyChanges(debt) {
    return debt.history.map(function (h, i) {
      return { date: h.date, balance: h.balance, change: i === 0 ? null : round2(debt.history[i - 1].balance - h.balance) };
    });
  }

  // Milestones (25, 50, 75, 100 percent) newly reached when a debt moves from one percent to another.
  function milestonesCrossed(before, after) {
    return [25, 50, 75, 100].filter(function (m) { return before < m && after >= m; });
  }

  var api = {
    MAX_MONEY: MAX_MONEY, MAX_HISTORY: MAX_HISTORY, NAME_MAX: NAME_MAX,
    round2: round2, todayISO: todayISO, isISODate: isISODate, parseNumber: parseNumber, cleanName: cleanName,
    validateFields: validateFields, recompute: recompute, makeDebt: makeDebt, balanceOn: balanceOn,
    logEntry: logEntry, removeEntry: removeEntry, editDebt: editDebt, percentPaid: percentPaid,
    summary: summary, historyChanges: historyChanges, milestonesCrossed: milestonesCrossed
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PLProgress = api;
})(this);
