/* Porchlight Ledger debt payoff math. Pure functions, no side effects.
   Works in the browser (window.PLPayoff) and in Node (module.exports). */
(function (root) {
  "use strict";
  var EPS = 0.005; // half a cent

  function orderDebts(debts, method) {
    var idx = debts.map(function (_, i) { return i; });
    idx.sort(function (a, b) {
      var A = debts[a], B = debts[b];
      if (method === "avalanche") {
        if (B.apr !== A.apr) return B.apr - A.apr;
        if (A.balance !== B.balance) return A.balance - B.balance;
      } else {
        if (A.balance !== B.balance) return A.balance - B.balance;
        if (B.apr !== A.apr) return B.apr - A.apr;
      }
      return a - b;
    });
    return idx;
  }

  /* mode "plan": fixed budget = sum(min) + extra, leftovers roll to the focus debt.
     mode "minimums": each debt pays only its own minimum, no rollover, no extra. */
  function simulate(debts, opts) {
    opts = opts || {};
    var method = opts.method === "avalanche" ? "avalanche" : "snowball";
    var mode = opts.mode === "minimums" ? "minimums" : "plan";
    var extra = mode === "plan" ? Math.max(0, +opts.extra || 0) : 0;
    var maxMonths = opts.maxMonths || 600;
    var order = orderDebts(debts, method);
    var bal = debts.map(function (d) { return +d.balance; });
    var payoff = debts.map(function (d) { return +d.balance <= EPS ? 0 : null; });
    var interestBy = debts.map(function () { return 0; });
    var budget = debts.reduce(function (s, d) { return s + (+d.minPayment); }, 0) + extra;
    var totalInterest = 0, totalPaid = 0, month = 0;

    function remaining() { return bal.some(function (b) { return b > EPS; }); }

    while (remaining() && month < maxMonths) {
      month++;
      // 1. interest
      for (var i = 0; i < bal.length; i++) {
        if (bal[i] > EPS) {
          var int = bal[i] * (+debts[i].apr) / 100 / 12;
          bal[i] += int; interestBy[i] += int; totalInterest += int;
        }
      }
      // 2. minimums
      var available = budget;
      for (var k = 0; k < order.length; k++) {
        var j = order[k];
        if (bal[j] <= EPS) continue;
        var pay = Math.min(+debts[j].minPayment, bal[j]);
        if (mode === "plan") pay = Math.min(pay, available);
        bal[j] -= pay; totalPaid += pay; available -= pay;
      }
      // 3. leftover (extra + freed minimums + unused part of final payments) to focus debts in order
      if (mode === "plan") {
        for (var q = 0; q < order.length && available > EPS; q++) {
          var f = order[q];
          if (bal[f] <= EPS) continue;
          var p2 = Math.min(available, bal[f]);
          bal[f] -= p2; totalPaid += p2; available -= p2;
        }
      }
      for (var z = 0; z < bal.length; z++) {
        if (bal[z] <= EPS) { if (payoff[z] === null) payoff[z] = month; bal[z] = 0; }
      }
    }
    var done = !remaining();
    return {
      method: method, mode: mode, paidOff: done, capped: !done, months: done ? month : null,
      simulatedMonths: month, maxMonths: maxMonths,
      totalInterest: totalInterest, totalPaid: totalPaid, monthlyBudget: budget,
      order: order, payoffMonth: payoff, interestByDebt: interestBy,
      remainingBalance: bal.reduce(function (s, b) { return s + b; }, 0)
    };
  }

  // Debts whose minimum doesn't cover the first month's interest (they grow or never shrink on minimums alone).
  function minimumWarnings(debts) {
    var out = [];
    debts.forEach(function (d, i) {
      var int = (+d.balance) * (+d.apr) / 100 / 12;
      if (+d.balance > 0 && +d.minPayment <= int + 1e-9) out.push({ index: i, monthlyInterest: int });
    });
    return out;
  }

  function compare(debts, extra, method, maxMonths) {
    var plan = simulate(debts, { method: method, extra: extra, maxMonths: maxMonths });
    var base = simulate(debts, { method: method, mode: "minimums", maxMonths: maxMonths });
    var res = { plan: plan, minimumsOnly: base, warnings: minimumWarnings(debts) };
    if (plan.paidOff && base.paidOff) {
      res.monthsSaved = base.months - plan.months;
      res.interestSaved = base.totalInterest - plan.totalInterest;
    } else { res.monthsSaved = null; res.interestSaved = null; }
    return res;
  }

  function validate(rows) {
    var errors = [];
    rows.forEach(function (r, i) {
      var e = {};
      if (!(isFinite(r.balance) && r.balance > 0)) e.balance = "Enter a balance above $0.";
      else if (r.balance > 1e8) e.balance = "Enter a balance under $100,000,000.";
      if (!(isFinite(r.apr) && r.apr >= 0 && r.apr <= 100)) e.apr = "Enter an APR from 0 to 100.";
      if (!(isFinite(r.minPayment) && r.minPayment > 0)) e.minPayment = "Enter a minimum payment above $0.";
      if (Object.keys(e).length) errors.push({ index: i, fields: e });
    });
    return errors;
  }

  var api = { simulate: simulate, compare: compare, minimumWarnings: minimumWarnings, orderDebts: orderDebts, validate: validate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PLPayoff = api;
})(this);
