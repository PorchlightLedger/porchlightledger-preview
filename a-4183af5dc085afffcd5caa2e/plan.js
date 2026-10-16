/* Porchlight Ledger Debt Planner: glue between saved debts and the payoff math in payoff.js.
   payoff.js is used unchanged. This file adds a "your own order" simulation that follows the same rules
   (tests check it gives identical results when the order matches Snowball or Avalanche).
   Pure functions. Works in the browser (window.PLPlan) and in Node (module.exports). */
(function (root) {
  "use strict";
  var P = root.PLPayoff || (typeof require !== "undefined" ? require("./payoff.js") : null);
  var MAX_MONTHS = 600;
  var EPS = 0.005;

  // Debts in the plan: still have a balance and not left out. Shape payoff.js expects.
  function activeDebts(debts) {
    return debts.filter(function (d) { return d.balance > 0 && !d.excluded; }).map(function (d) {
      return { id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.minPayment };
    });
  }

  /* Indexes into `active` in the order they will be paid.
     snowball / avalanche use payoff.js. custom uses the saved list of ids; anything not listed goes last, smallest balance first. */
  function orderFor(active, method, orderIds) {
    if (method !== "custom") return P.orderDebts(active, method);
    var pos = {}, out = [];
    (orderIds || []).forEach(function (id) { pos[id] = true; });
    (orderIds || []).forEach(function (id) {
      for (var i = 0; i < active.length; i++) if (active[i].id === id && out.indexOf(i) < 0) out.push(i);
    });
    P.orderDebts(active, "snowball").forEach(function (i) { if (out.indexOf(i) < 0) out.push(i); });
    return out;
  }

  /* Same monthly rules as payoff.js simulate (interest, then minimums, then everything left goes to the debts in order),
     but with an order you choose. opts: { extra, mode: "plan" | "minimums", maxMonths }. */
  function simulateOrdered(debts, order, opts) {
    opts = opts || {};
    var mode = opts.mode === "minimums" ? "minimums" : "plan";
    var extra = mode === "plan" ? Math.max(0, +opts.extra || 0) : 0;
    var maxMonths = opts.maxMonths || MAX_MONTHS;
    var bal = debts.map(function (d) { return +d.balance; });
    var payoff = debts.map(function (d) { return +d.balance <= EPS ? 0 : null; });
    var interestBy = debts.map(function () { return 0; });
    var budget = debts.reduce(function (s, d) { return s + (+d.minPayment); }, 0) + extra;
    var totalInterest = 0, totalPaid = 0, month = 0;
    function remaining() { return bal.some(function (b) { return b > EPS; }); }
    while (remaining() && month < maxMonths) {
      month++;
      for (var i = 0; i < bal.length; i++) {
        if (bal[i] > EPS) { var int = bal[i] * (+debts[i].apr) / 100 / 12; bal[i] += int; interestBy[i] += int; totalInterest += int; }
      }
      var available = budget;
      for (var k = 0; k < order.length; k++) {
        var j = order[k];
        if (bal[j] <= EPS) continue;
        var pay = Math.min(+debts[j].minPayment, bal[j]);
        if (mode === "plan") pay = Math.min(pay, available);
        bal[j] -= pay; totalPaid += pay; available -= pay;
      }
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
    return { method: "custom", mode: mode, paidOff: done, capped: !done, months: done ? month : null, simulatedMonths: month,
      maxMonths: maxMonths, totalInterest: totalInterest, totalPaid: totalPaid, monthlyBudget: budget, order: order,
      payoffMonth: payoff, interestByDebt: interestBy, remainingBalance: bal.reduce(function (s, b) { return s + b; }, 0) };
  }

  // One plan for the chosen method.
  function run(active, cfg, extra, maxMonths) {
    maxMonths = maxMonths || MAX_MONTHS;
    if (cfg.method === "custom") {
      return simulateOrdered(active, orderFor(active, "custom", cfg.order), { extra: extra, maxMonths: maxMonths });
    }
    return P.simulate(active, { method: cfg.method, extra: extra, maxMonths: maxMonths });
  }

  function minimumsOnly(active, maxMonths) {
    return P.simulate(active, { method: "snowball", mode: "minimums", maxMonths: maxMonths || MAX_MONTHS });
  }

  // Snowball and Avalanche side by side (plus the chosen plan when it is "custom").
  function compareMethods(active, extra, cfg) {
    var snow = P.simulate(active, { method: "snowball", extra: extra, maxMonths: MAX_MONTHS });
    var aval = P.simulate(active, { method: "avalanche", extra: extra, maxMonths: MAX_MONTHS });
    var r = { snowball: snow, avalanche: aval, custom: cfg && cfg.method === "custom" ? run(active, cfg, extra) : null,
      better: null, interestSaved: null, monthsSaved: null };
    if (snow.paidOff && aval.paidOff) {
      var di = snow.totalInterest - aval.totalInterest, dm = snow.months - aval.months;
      if (Math.abs(di) < EPS && dm === 0) { r.better = "same"; r.interestSaved = 0; r.monthsSaved = 0; }
      else if (di > EPS || (Math.abs(di) < EPS && dm > 0)) { r.better = "avalanche"; r.interestSaved = Math.max(0, di); r.monthsSaved = Math.max(0, dm); }
      else { r.better = "snowball"; r.interestSaved = Math.max(0, -di); r.monthsSaved = Math.max(0, -dm); }
    }
    return r;
  }

  /* What to pay in the coming month, per debt: interest is added, every debt gets its minimum (up to what is owed),
     and the extra goes to the first unpaid debt in the plan order. Matches month 1 of the simulation. */
  function thisMonth(active, order, extra) {
    var bal = active.map(function (d) { return d.balance * (1 + d.apr / 100 / 12); });
    var out = active.map(function (d, i) { return { id: d.id, name: d.name, minimum: 0, extra: 0, total: 0, firstFocus: false }; });
    var budget = active.reduce(function (s, d) { return s + d.minPayment; }, 0) + Math.max(0, extra || 0);
    var available = budget, i, j;
    for (i = 0; i < order.length; i++) {
      j = order[i];
      if (bal[j] <= EPS) continue;
      var pay = Math.min(active[j].minPayment, bal[j], available);
      out[j].minimum = pay; bal[j] -= pay; available -= pay;
    }
    var focusSet = false;
    for (i = 0; i < order.length && available > EPS; i++) {
      j = order[i];
      if (bal[j] <= EPS) continue;
      var p2 = Math.min(available, bal[j]);
      out[j].extra = p2; bal[j] -= p2; available -= p2;
      if (!focusSet && p2 > EPS) { out[j].firstFocus = true; focusSet = true; }
    }
    out.forEach(function (o) { o.total = o.minimum + o.extra; });
    return order.map(function (idx) { return out[idx]; });
  }

  // Move an id up (-1) or down (+1) in a list of ids. Returns a new list.
  function moveId(ids, id, dir) {
    var a = ids.slice(), i = a.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return a;
    var t = a[i]; a[i] = a[j]; a[j] = t;
    return a;
  }

  // Calendar position of plan month n. Month 0 is the current month; month 1 is next month.
  function monthDate(n, now) {
    now = now || new Date();
    var total = now.getFullYear() * 12 + now.getMonth() + n;
    return { year: Math.floor(total / 12), month: total % 12 };
  }

  /* Total balance at the end of each sampled month, for the chart. Uses the same simulations as the plan, capped by month. */
  function chartSeries(active, cfg, extra, horizon, maxPoints) {
    maxPoints = maxPoints || 48;
    var step = Math.max(1, Math.ceil(horizon / maxPoints));
    var months = [];
    for (var m = 0; m < horizon; m += step) months.push(m);
    months.push(horizon);
    var total = active.reduce(function (s, d) { return s + d.balance; }, 0);
    function line(planLine) {
      return months.map(function (m) {
        if (m === 0) return { m: 0, b: total };
        var r = planLine ? run(active, cfg, extra, m) : minimumsOnly(active, m);
        return { m: m, b: r.paidOff ? 0 : r.remainingBalance };
      });
    }
    return { months: months, plan: line(true), minimums: line(false), startBalance: total };
  }

  var api = { MAX_MONTHS: MAX_MONTHS, activeDebts: activeDebts, orderFor: orderFor, simulateOrdered: simulateOrdered, run: run,
    minimumsOnly: minimumsOnly, compareMethods: compareMethods, thisMonth: thisMonth, moveId: moveId, monthDate: monthDate, chartSeries: chartSeries };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PLPlan = api;
})(this);
