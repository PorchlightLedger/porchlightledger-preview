"""Independent Python check of the JS debt payoff math (written separately, not a port)."""
import json, math, subprocess, os
here = os.path.dirname(os.path.abspath(__file__))
cases = json.load(open(os.path.join(here, "cases.json")))
js = json.loads(subprocess.check_output(["node", os.path.join(here, "run_js.js")]))

def py_plan(debts, extra, method, cap=600):
    ds = [dict(d, bal=float(d["balance"]), paid_month=None) for d in debts]
    key = (lambda d: (-d["apr"], d["balance"])) if method == "avalanche" else (lambda d: (d["balance"], -d["apr"]))
    order = sorted(ds, key=key)
    budget = sum(d["minPayment"] for d in debts) + extra
    interest = 0.0; m = 0
    while any(d["bal"] > 0.005 for d in ds) and m < cap:
        m += 1
        for d in ds:
            if d["bal"] > 0.005:
                i = d["bal"] * d["apr"] / 1200; d["bal"] += i; interest += i
        cash = budget
        live = [d for d in order if d["bal"] > 0.005]
        for d in live:                       # minimums
            p = min(d["minPayment"], d["bal"], cash); d["bal"] -= p; cash -= p
        for d in live:                       # everything left to the first unpaid debt(s)
            if cash <= 0.005: break
            p = min(cash, d["bal"]); d["bal"] -= p; cash -= p
        for d in ds:
            if d["bal"] <= 0.005 and d["paid_month"] is None: d["paid_month"] = m; d["bal"] = 0
    done = all(d["bal"] <= 0.005 for d in ds)
    return (m if done else None), round(interest, 2), [d["name"] for d in order], [d["paid_month"] for d in ds]

def py_minimums(debts, cap=600):
    months, total = [], 0.0
    for d in debts:                          # each debt on its own minimum, independent amortization
        b, n, i_tot = float(d["balance"]), 0, 0.0
        while b > 0.005 and n < cap:
            n += 1; i = b * d["apr"] / 1200; b += i; i_tot += i; b -= min(d["minPayment"], b)
        if b > 0.005: return None, None
        months.append(n); total += i_tot
    return max(months), round(total, 2)

def closed_form(B, apr, P):
    r = apr / 1200
    n = -math.log(1 - r * B / P) / math.log(1 + r)
    return n

rows = []
def row(case, what, exp, got): rows.append((case, what, exp, got, "PASS" if exp == got else "FAIL"))

a = js["a"]["snowball"]
row("a", "months", 10, a["months"]); row("a", "interest", 0.0, a["interest"])

b = js["b"]["snowball"]; m, i, _, _ = py_plan(cases["b"]["debts"], 0, "snowball")
n = closed_form(5000, 18, 150)
row("b", "months vs python sim", m, b["months"]); row("b", "interest vs python sim", i, b["interest"])
row("b", f"months vs formula ceil({n:.3f})", math.ceil(n), b["months"])
# formula interest: full payments over the fractional term minus principal (approx; final partial payment)
r = 0.015; k = math.floor(n); bal_k = 5000*(1+r)**k - 150*((1+r)**k - 1)/r
formula_interest = round(k*150 + bal_k*(1+r) - 5000, 2)
row("b", "interest vs formula", formula_interest, b["interest"])

c = cases["c"]
for meth in ("snowball", "avalanche"):
    m, i, order, pm = py_plan(c["debts"], c["extra"], meth)
    g = js["c"][meth]
    row("c", f"{meth} months", m, g["months"]); row("c", f"{meth} interest", i, g["interest"])
    row("c", f"{meth} order", order, g["order"]); row("c", f"{meth} payoff months", pm, g["payoffMonth"])
    bm, bi = py_minimums(c["debts"])
    row("c", f"{meth} minimums-only months", bm, g["baseMonths"]); row("c", f"{meth} minimums-only interest", bi, g["baseInterest"])
row("c", "order differs", True, js["c"]["snowball"]["order"] != js["c"]["avalanche"]["order"])
row("c", "avalanche interest <= snowball", True, js["c"]["avalanche"]["interest"] <= js["c"]["snowball"]["interest"])

d = js["d"]["snowball"]; m, i, _, _ = py_plan(cases["d"]["debts"], cases["d"]["extra"], "snowball")
row("d", "warning on 'Card' (min $100 < $120 interest)", ["Card"], d["warnings"])
row("d", "minimums-only never pays off (capped)", True, d["baseCapped"])
row("d", "savings shown as null, not infinite", (None, None), (d["monthsSaved"], d["interestSaved"]))
row("d", "plan with extra still pays off: months vs python", m, d["months"])
row("d", "plan interest vs python", i, d["interest"])

e = json.loads(subprocess.check_output(["node","-e","const P=require('"+os.path.join(here,"../../payoff.js")+"');const r=P.compare([{balance:6000,apr:24,minPayment:100}],0,'snowball',600);console.log(JSON.stringify([r.plan.capped,r.plan.months,r.plan.simulatedMonths]))"]))
row("e", "plan with min < interest and no extra: capped at 600, months null", [True, None, 600], e)

for r_ in rows: print(" | ".join(str(x) for x in r_))
print("SUMMARY", sum(r_[4] == "PASS" for r_ in rows), "/", len(rows), "passed")
print("JS detail:", json.dumps(js))
