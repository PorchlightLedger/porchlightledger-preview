// Run with: node --test tests/   (from the app folder). Needs Node 20 or newer. No packages.
const test = require("node:test");
const assert = require("node:assert/strict");
const PP = require("../progress.js");
const PS = require("../store.js");
const PL = require("../plan.js");
const P = require("../payoff.js");

const mk = (o) => PP.makeDebt(Object.assign({ name: "Card", balance: 1000, apr: 20, minPayment: 50 }, o || {}), "2026-01-10", "d1").debt;

test("parseNumber accepts money-looking text and rejects junk", () => {
  assert.equal(PP.parseNumber("1,200.50"), 1200.5);
  assert.equal(PP.parseNumber("$30"), 30);
  assert.equal(PP.parseNumber(" 7 "), 7);
  assert.equal(PP.parseNumber(".5"), 0.5);
  for (const bad of ["", "abc", "1e3", "-5", "1.2.3", null, undefined, NaN, Infinity]) assert.ok(Number.isNaN(PP.parseNumber(bad)), String(bad));
});

test("isISODate checks real calendar dates", () => {
  assert.ok(PP.isISODate("2026-02-28"));
  assert.ok(!PP.isISODate("2026-02-30"));
  assert.ok(!PP.isISODate("2026-13-01"));
  assert.ok(!PP.isISODate("26-01-01"));
  assert.ok(!PP.isISODate("1999-01-01"));
  assert.ok(!PP.isISODate(20260101));
});

test("validateFields", () => {
  assert.deepEqual(PP.validateFields({ name: "A", balance: 10, apr: 0, minPayment: 5 }), {});
  const e = PP.validateFields({ name: " ", balance: 0, apr: 101, minPayment: 0 });
  assert.deepEqual(Object.keys(e).sort(), ["apr", "balance", "minPayment", "name"]);
  assert.ok(!PP.validateFields({ name: "A", balance: 0, apr: 5, minPayment: 5 }, { allowZeroBalance: true }).balance);
  assert.ok(PP.validateFields({ name: "A", balance: 2e8, apr: 5, minPayment: 5 }).balance);
});

test("makeDebt starts history at the starting balance", () => {
  const d = mk();
  assert.equal(d.balance, 1000); assert.equal(d.startBalance, 1000);
  assert.equal(d.history.length, 1); assert.equal(d.paidOffDate, null);
  assert.equal(PP.makeDebt({ name: "", balance: 5, apr: 1, minPayment: 1 }, "2026-01-10", "x").ok, false);
});

test("logEntry payment lowers balance, never below zero, and re-derives fields", () => {
  const d = mk();
  const r = PP.logEntry(d, { date: "2026-02-10", mode: "payment", value: 250.25 }, "2026-03-01");
  assert.ok(r.ok); assert.equal(r.debt.balance, 749.75); assert.equal(r.debt.startBalance, 1000);
  assert.equal(PP.percentPaid(r.debt.startBalance, r.debt.balance), 25);
  const over = PP.logEntry(r.debt, { date: "2026-02-11", mode: "payment", value: 5000 }, "2026-03-01");
  assert.equal(over.debt.balance, 0); assert.ok(over.paidOff); assert.equal(over.debt.paidOffDate, "2026-02-11");
});

test("logEntry balance mode, ordering by date, and balance increases", () => {
  let d = mk();
  d = PP.logEntry(d, { date: "2026-03-10", mode: "balance", value: 600 }, "2026-04-01").debt;
  d = PP.logEntry(d, { date: "2026-02-10", mode: "balance", value: 800 }, "2026-04-01").debt; // older date logged later
  assert.deepEqual(d.history.map((h) => h.date), ["2026-01-10", "2026-02-10", "2026-03-10"]);
  assert.equal(d.balance, 600);
  d = PP.logEntry(d, { date: "2026-04-01", mode: "balance", value: 1500 }, "2026-04-01").debt; // new charges
  assert.equal(d.startBalance, 1500); assert.equal(d.balance, 1500);
  assert.equal(PP.percentPaid(d.startBalance, d.balance), 0);
});

test("payment on a back dated entry uses the balance on that date", () => {
  let d = mk();
  d = PP.logEntry(d, { date: "2026-03-10", mode: "balance", value: 600 }, "2026-04-01").debt;
  const r = PP.logEntry(d, { date: "2026-02-01", mode: "payment", value: 100 }, "2026-04-01");
  assert.equal(r.newBalance, 900);
  assert.equal(r.debt.balance, 600); // latest dated entry still wins
});

test("logEntry validation", () => {
  const d = mk();
  assert.ok(PP.logEntry(d, { date: "2026-05-01", mode: "payment", value: 5 }, "2026-04-01").errors.date);
  assert.ok(PP.logEntry(d, { date: "nope", mode: "payment", value: 5 }, "2026-04-01").errors.date);
  assert.ok(PP.logEntry(d, { date: "2026-02-01", mode: "payment", value: 0 }, "2026-04-01").errors.value);
  assert.ok(PP.logEntry(d, { date: "2026-02-01", mode: "payment", value: NaN }, "2026-04-01").errors.value);
  assert.ok(PP.logEntry(d, { date: "2026-02-01", mode: "balance", value: -1 }, "2026-04-01").errors.value);
  assert.ok(PP.logEntry(d, { date: "2026-02-01", mode: "balance", value: 0 }, "2026-04-01").ok);
});

test("history cap", () => {
  let d = mk();
  d.history = Array.from({ length: PP.MAX_HISTORY }, () => ({ date: "2026-01-10", balance: 5 }));
  assert.ok(PP.logEntry(d, { date: "2026-02-01", mode: "balance", value: 4 }, "2026-04-01").errors.value);
});

test("removeEntry keeps at least one entry and re-derives", () => {
  let d = PP.logEntry(mk(), { date: "2026-02-10", mode: "balance", value: 500 }, "2026-04-01").debt;
  const r = PP.removeEntry(d, 1);
  assert.ok(r.ok); assert.equal(r.debt.balance, 1000);
  assert.equal(PP.removeEntry(r.debt, 0).ok, false);
  assert.equal(PP.removeEntry(d, 9).ok, false);
});

test("editDebt: fields change, a changed balance becomes a dated history entry", () => {
  const d = mk();
  const r = PP.editDebt(d, { name: "Visa", balance: 900, apr: 18, minPayment: 40 }, "2026-02-01");
  assert.ok(r.ok); assert.equal(r.debt.name, "Visa"); assert.equal(r.debt.apr, 18);
  assert.equal(r.debt.balance, 900); assert.equal(r.debt.history.length, 2); assert.equal(r.debt.history[1].date, "2026-02-01");
  const same = PP.editDebt(d, { name: "Visa", balance: 1000, apr: 18, minPayment: 40 }, "2026-02-01");
  assert.equal(same.debt.history.length, 1);
  assert.equal(PP.editDebt(d, { name: "", balance: 900, apr: 18, minPayment: 40 }, "2026-02-01").ok, false);
  assert.equal(PP.editDebt(d, { name: "V", balance: 900, apr: 18, minPayment: 40, excluded: true }, "2026-02-01").debt.excluded, true);
});

test("summary and percentPaid", () => {
  const a = mk({ balance: 1000 }), b = PP.logEntry(mk({ balance: 500 }), { date: "2026-02-01", mode: "balance", value: 0 }, "2026-03-01").debt;
  const s = PP.summary([a, b]);
  assert.equal(s.count, 2); assert.equal(s.paidOff, 1); assert.equal(s.active, 1);
  assert.equal(s.totalStart, 1500); assert.equal(s.totalCurrent, 1000); assert.equal(s.totalPaidDown, 500); assert.equal(s.percent, 33);
  assert.equal(PP.summary([b]).allPaidOff, true);
  assert.equal(PP.summary([]).allPaidOff, false);
  assert.equal(PP.percentPaid(1000, 1), 99); // never shows 100 until it is $0
  assert.equal(PP.percentPaid(0, 0), 0);
  assert.equal(PP.percentPaid(1000, 0), 100);
  assert.equal(PP.percentPaid(1000, 1200), 0);
});

test("milestonesCrossed", () => {
  assert.deepEqual(PP.milestonesCrossed(20, 55), [25, 50]);
  assert.deepEqual(PP.milestonesCrossed(50, 50), []);
  assert.deepEqual(PP.milestonesCrossed(90, 100), [100]);
});

test("historyChanges", () => {
  const d = PP.logEntry(mk(), { date: "2026-02-01", mode: "payment", value: 200 }, "2026-03-01").debt;
  assert.deepEqual(PP.historyChanges(d).map((h) => h.change), [null, 200]);
});

/* ---------- store ---------- */
function fullState() {
  const s = PS.emptyState();
  s.debts.push(mk({ name: "Card" }), Object.assign(mk({ name: "Loan", balance: 5000, apr: 6, minPayment: 150 }), { id: "d2" }));
  s.extra = 75; s.method = "avalanche"; s.order = ["d2", "d1"]; s.onboarded = true;
  return s;
}

test("export then import round trips", () => {
  const s = fullState();
  const r = PS.parseImport(PS.serialize(s));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.state.debts.length, 2); assert.equal(r.state.extra, 75); assert.equal(r.state.method, "avalanche");
  assert.deepEqual(r.state.order, ["d2", "d1"]); assert.equal(r.state.debts[1].name, "Loan");
  assert.ok(r.state.lastBackup);
});

test("import rejects bad input and changes nothing partly", () => {
  const good = JSON.parse(PS.serialize(fullState()));
  const cases = {
    notJson: "{oops", empty: "  ", arrayTop: "[]", string: '"hi"', wrongApp: JSON.stringify(Object.assign({}, good, { app: "other" })),
    noVersion: JSON.stringify(Object.assign({}, good, { version: undefined })), newer: JSON.stringify(Object.assign({}, good, { version: 99 })),
    fraction: JSON.stringify(Object.assign({}, good, { version: 1.5 })), noDebts: JSON.stringify({ app: good.app, version: 1 }),
    badMethod: JSON.stringify(Object.assign({}, good, { method: "yolo" })), badExtra: JSON.stringify(Object.assign({}, good, { extra: -5 })),
    nanExtra: JSON.stringify(Object.assign({}, good, { extra: "5" }))
  };
  for (const [k, text] of Object.entries(cases)) assert.equal(PS.parseImport(text).ok, false, k);
  const bad = (mut) => { const c = JSON.parse(JSON.stringify(good)); mut(c); return PS.parseImport(JSON.stringify(c)); };
  assert.equal(bad((c) => { c.debts[0].apr = 500; }).ok, false);
  assert.equal(bad((c) => { c.debts[0].minPayment = 0; }).ok, false);
  assert.equal(bad((c) => { c.debts[0].name = ""; }).ok, false);
  assert.equal(bad((c) => { c.debts[0].history = []; }).ok, false);
  assert.equal(bad((c) => { c.debts[0].history[0].date = "2026-99-99"; }).ok, false);
  assert.equal(bad((c) => { c.debts[0].history[0].balance = -3; }).ok, false);
  assert.equal(bad((c) => { c.debts[0].history[0].balance = "10"; }).ok, false);
  assert.equal(bad((c) => { c.debts[1] = 7; }).ok, false);
  assert.equal(bad((c) => { c.debts = new Array(PS.MAX_DEBTS + 1).fill(c.debts[0]); }).ok, false);
  const r = bad((c) => { c.debts[0].apr = 500; });
  assert.ok(r.errors[0].startsWith("Debt 1:"));
});

test("import cleans names, repairs ids, drops unknown order ids, recomputes derived fields", () => {
  const good = JSON.parse(PS.serialize(fullState()));
  good.debts[0].name = "  Card\u0007   with   spaces  " + "x".repeat(80);
  good.debts[1].id = good.debts[0].id; // duplicate id
  good.debts[0].balance = 999999; good.debts[0].startBalance = 1; // lies about derived values
  good.order = ["d2", "ghost", "d2", 5];
  const r = PS.parseImport(JSON.stringify(good));
  assert.ok(r.ok);
  const [a, b] = r.state.debts;
  assert.ok(a.name.length <= 40 && !/[\u0000-\u001f]/.test(a.name));
  assert.notEqual(a.id, b.id);
  assert.equal(a.balance, a.history[a.history.length - 1].balance);
  assert.equal(a.startBalance, 1000);
  assert.ok(r.state.order.every((id) => r.state.debts.some((d) => d.id === id)));
});

test("import rejects oversized files and script-like content is just text", () => {
  assert.equal(PS.parseImport("x", 3 * 1024 * 1024).ok, false);
  const good = JSON.parse(PS.serialize(fullState()));
  good.debts[0].name = "<img src=x onerror=alert(1)>";
  const r = PS.parseImport(JSON.stringify(good));
  assert.ok(r.ok); assert.equal(r.state.debts[0].name, "<img src=x onerror=alert(1)>"); // stored as plain text; the UI escapes it
});

function fakeStorage(init, opts) {
  opts = opts || {};
  const m = Object.assign({}, init);
  return { m, getItem(k) { if (opts.throwGet) throw new Error("denied"); return k in m ? m[k] : null; },
    setItem(k, v) { if (opts.throwSet) throw new Error("quota"); m[k] = String(v); }, removeItem(k) { delete m[k]; } };
}

test("load/save with working, empty, corrupt and blocked storage", () => {
  const st = fakeStorage();
  assert.equal(PS.load(st).status, "empty");
  const s = fullState();
  assert.equal(PS.save(st, s), true);
  const l = PS.load(st);
  assert.equal(l.status, "ok"); assert.equal(l.state.debts.length, 2);
  const bad = fakeStorage({ [PS.KEY]: "{not json" });
  const lb = PS.load(bad);
  assert.equal(lb.status, "corrupt"); assert.equal(lb.state.debts.length, 0);
  assert.equal(bad.m[PS.KEY + ".unreadable"], "{not json"); // kept aside, not destroyed
  assert.equal(PS.load(fakeStorage({}, { throwGet: true })).status, "unavailable");
  assert.equal(PS.save(fakeStorage({}, { throwSet: true }), s), false);
  assert.equal(PS.clearAll(st), true); assert.equal(PS.load(st).status, "empty");
});

test("CSV export protects against formulas and round trips the basics", () => {
  const s = PS.emptyState();
  s.debts.push(mk({ name: '=SUM(1)' }), Object.assign(mk({ name: 'Smith, "Bob" loan' }), { id: "d2" }));
  const csv = PS.toCSV(s);
  assert.ok(csv.includes("'=SUM(1)"));
  const r = PS.parseCSV(csv);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.debts[0].name, "=SUM(1)"); assert.equal(r.debts[1].name, 'Smith, "Bob" loan');
  assert.equal(r.debts[0].balance, 1000); assert.equal(r.debts[0].apr, 20); assert.equal(r.debts[0].minPayment, 50);
});

test("CSV import validation", () => {
  assert.ok(PS.parseCSV("name,balance,apr,min_payment\nA,100,5,10").ok);
  assert.ok(PS.parseCSV("\uFEFFName,Balance,APR,Minimum Payment\r\nA,\"$1,100\",5%,10\r\n").ok);
  assert.equal(PS.parseCSV("a,b\n1,2").ok, false);
  assert.equal(PS.parseCSV("name,balance,apr,min_payment\n").ok, false);
  assert.equal(PS.parseCSV("name,balance,apr,min_payment\nA,abc,5,10").ok, false);
  assert.equal(PS.parseCSV("name,balance,apr,min_payment\nA,100,500,10").ok, false);
  assert.equal(PS.parseCSV("").ok, false);
});

/* ---------- plan ---------- */
const SAMPLE = [
  { id: "a", name: "Store card", balance: 800, apr: 12, minPayment: 30 },
  { id: "b", name: "Credit card", balance: 4500, apr: 24, minPayment: 110 },
  { id: "c", name: "Car loan", balance: 9000, apr: 6, minPayment: 250 }];

test("custom order simulation matches payoff.js when the order is Snowball or Avalanche", () => {
  for (const method of ["snowball", "avalanche"]) {
    for (const extra of [0, 50, 200, 1000]) {
      const a = P.simulate(SAMPLE, { method, extra }), b = PL.simulateOrdered(SAMPLE, P.orderDebts(SAMPLE, method), { extra });
      assert.equal(b.months, a.months); assert.ok(Math.abs(a.totalInterest - b.totalInterest) < 1e-9);
      assert.deepEqual(b.payoffMonth, a.payoffMonth); assert.ok(Math.abs(a.totalPaid - b.totalPaid) < 1e-9);
    }
  }
  const m1 = P.simulate(SAMPLE, { mode: "minimums" }), m2 = PL.simulateOrdered(SAMPLE, [0, 1, 2], { mode: "minimums" });
  assert.equal(m1.months, m2.months);
});

test("orderFor: custom ids first, unlisted debts after in snowball order, unknown ids ignored", () => {
  assert.deepEqual(PL.orderFor(SAMPLE, "custom", ["c", "zzz"]), [2, 0, 1]);
  assert.deepEqual(PL.orderFor(SAMPLE, "custom", []), P.orderDebts(SAMPLE, "snowball"));
  assert.deepEqual(PL.orderFor(SAMPLE, "avalanche"), P.orderDebts(SAMPLE, "avalanche"));
});

test("activeDebts skips paid off and left out debts", () => {
  const debts = [mk(), Object.assign(mk(), { id: "p", balance: 0 }), Object.assign(mk(), { id: "x", excluded: true })];
  assert.deepEqual(PL.activeDebts(debts).map((d) => d.id), ["d1"]);
});

test("compareMethods: avalanche saves interest on the sample, same answer when one debt", () => {
  const c = PL.compareMethods(SAMPLE, 200, { method: "snowball" });
  assert.equal(c.better, "avalanche"); assert.ok(c.interestSaved > 100);
  assert.equal(c.custom, null);
  const one = PL.compareMethods([SAMPLE[0]], 50, { method: "custom", order: ["a"] });
  assert.equal(one.better, "same"); assert.ok(one.custom.paidOff);
});

test("thisMonth matches the first month of the simulation", () => {
  for (const method of ["snowball", "avalanche"]) {
    const order = P.orderDebts(SAMPLE, method), rows = PL.thisMonth(SAMPLE, order, 200);
    const paid = rows.reduce((s, r) => s + r.total, 0), sim = P.simulate(SAMPLE, { method, extra: 200, maxMonths: 1 });
    assert.ok(Math.abs(paid - sim.totalPaid) < 1e-9);
    assert.equal(rows.filter((r) => r.firstFocus).length, 1);
    assert.equal(rows[0].extra, 200);
  }
  assert.equal(PL.thisMonth(SAMPLE, [0, 1, 2], 0).filter((r) => r.firstFocus).length, 0);
});

test("moveId", () => {
  assert.deepEqual(PL.moveId(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(PL.moveId(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(PL.moveId(["a", "b", "c"], "zz", 1), ["a", "b", "c"]);
});

test("monthDate rolls over years", () => {
  assert.deepEqual(PL.monthDate(1, new Date(2026, 11, 15)), { year: 2027, month: 0 });
  assert.deepEqual(PL.monthDate(0, new Date(2026, 9, 16)), { year: 2026, month: 9 });
  assert.deepEqual(PL.monthDate(14, new Date(2026, 9, 16)), { year: 2027, month: 11 });
});

test("chartSeries starts at the total, falls to zero, and is never below the minimums line at the end", () => {
  const plan = P.simulate(SAMPLE, { method: "snowball", extra: 200 });
  const s = PL.chartSeries(SAMPLE, { method: "snowball" }, 200, plan.months);
  assert.equal(s.plan[0].b, 14300); assert.equal(s.plan[s.plan.length - 1].b, 0);
  assert.equal(s.plan.length, s.months.length);
  for (let i = 1; i < s.plan.length; i++) assert.ok(s.plan[i].b <= s.plan[i - 1].b + 1e-6);
  assert.ok(s.minimums[s.minimums.length - 1].b >= s.plan[s.plan.length - 1].b);
});

test("balanceSeries per debt adds up to the plan's total balance and ends at zero", () => {
  const order = P.orderDebts(SAMPLE, "avalanche"), plan = P.simulate(SAMPLE, { method: "avalanche", extra: 200 });
  const b = PL.balanceSeries(SAMPLE, order, 200, plan.months), c = PL.chartSeries(SAMPLE, { method: "avalanche" }, 200, plan.months);
  assert.equal(b.series.length, 3);
  assert.deepEqual(b.months, c.months);
  b.months.forEach((m, k) => {
    const sum = b.series.reduce((s, line) => s + line[k], 0);
    assert.ok(Math.abs(sum - c.plan[k].b) < 1e-6, "month " + m);
  });
  assert.ok(b.series.every((line) => line[line.length - 1] === 0));
  assert.deepEqual(b.series.map((l) => l[0]), [800, 4500, 9000]);
});

test("simulateOrdered reports per debt interest that adds up to the total", () => {
  const r = PL.simulateOrdered(SAMPLE, P.orderDebts(SAMPLE, "snowball"), { extra: 200 });
  assert.ok(Math.abs(r.interestByDebt.reduce((s, x) => s + x, 0) - r.totalInterest) < 1e-9);
});
