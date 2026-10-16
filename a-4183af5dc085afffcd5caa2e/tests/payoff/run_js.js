// Runs the site's pure JS math on each case and prints JSON.
const P = require("../../payoff.js");
const cases = require("./cases.json");
const out = {};
for (const [k, c] of Object.entries(cases)) {
  const methods = c.method ? [c.method] : ["snowball", "avalanche"];
  out[k] = {};
  for (const m of methods) {
    const r = P.compare(c.debts, c.extra, m, 600);
    out[k][m] = { months: r.plan.months, interest: +r.plan.totalInterest.toFixed(2), payoffMonth: r.plan.payoffMonth,
      order: r.plan.order.map(i => c.debts[i].name),
      baseMonths: r.minimumsOnly.months, baseInterest: r.minimumsOnly.paidOff ? +r.minimumsOnly.totalInterest.toFixed(2) : null,
      baseCapped: r.minimumsOnly.capped, monthsSaved: r.monthsSaved,
      interestSaved: r.interestSaved == null ? null : +r.interestSaved.toFixed(2),
      warnings: r.warnings.map(w => c.debts[w.index].name) };
  }
}
console.log(JSON.stringify(out));
