/* Porchlight Ledger Debt Planner. Everything runs and is stored in this browser.
   No analytics, no cookies, no requests to anyone else. */
(function () {
  "use strict";
  var PP = window.PLProgress, PS = window.PLStore, PL = window.PLPlan;

  /* ---------- storage ---------- */
  function getStorage() {
    try { var s = window.localStorage; s.getItem("plledger.probe"); return s; } catch (e) { return null; }
  }
  var realStorage = getStorage();
  var memory = {};
  var ls = realStorage || {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
    setItem: function (k, v) { memory[k] = String(v); },
    removeItem: function (k) { delete memory[k]; }
  };
  var loaded = PS.load(ls);
  var state = loaded.state;
  var loadStatus = loaded.status;
  var saveOK = !!realStorage && loadStatus !== "unavailable";
  var persistState = "unknown"; // unknown | granted | not-granted | unsupported

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  var money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  var moneyC = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
  var monthFmt = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
  var monthShort = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });
  var dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  function m$(n) { return '<span class="amt">' + money.format(n) + "</span>"; }
  function m0$(n) { return '<span class="amt">' + money0.format(n) + "</span>"; }
  function monthLabel(n, fmt) { var d = PL.monthDate(n); return (fmt || monthFmt).format(new Date(d.year, d.month, 1)); }
  function dayLabel(iso) { return dayFmt.format(new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))); }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function duration(m) {
    var y = Math.floor(m / 12), r = m % 12, p = [];
    if (y) p.push(plural(y, "year")); if (r || !y) p.push(plural(r, "month"));
    return p.join(", ");
  }
  var METHODS = { snowball: "Snowball", avalanche: "Avalanche", custom: "Your own order" };
  function planName(m) { return m === "custom" ? "Your own order" : METHODS[m] + " plan"; }
  function today() { return PP.todayISO(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isStandalone() { return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function findDebt(id) { for (var i = 0; i < state.debts.length; i++) if (state.debts[i].id === id) return state.debts[i]; return null; }

  /* ---------- saving, undo, toast ---------- */
  function save() { saveOK = PS.save(ls, state) && !!realStorage; renderPill(); }
  var toastTimer = null, undoSnap = null;
  function toast(text, snap) {
    $("toast-text").textContent = text;
    undoSnap = snap || null;
    $("toast-undo").hidden = !snap;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $("toast").hidden = true; undoSnap = null; }, snap ? 10000 : 6000);
  }
  $("toast-text").addEventListener("click", function () { $("toast").hidden = true; });
  $("toast-undo").addEventListener("click", function () {
    if (!undoSnap) return;
    state = undoSnap; undoSnap = null; save(); renderAll();
    toast("Undone.");
  });
  function mutate(fn, msg, canUndo) {
    var snap = canUndo ? clone(state) : null;
    fn(); save(); renderAll();
    if (msg) toast(msg, snap);
  }

  /* ---------- plan data ---------- */
  function planFor(st) {
    var active = PL.activeDebts(st.debts);
    if (!active.length) return null;
    var cfg = { method: st.method, order: st.order };
    var plan = PL.run(active, cfg, st.extra);
    var base = PL.minimumsOnly(active);
    return { active: active, cfg: cfg, plan: plan, base: base,
      saved: plan.paidOff && base.paidOff ? { months: base.months - plan.months, interest: base.totalInterest - plan.totalInterest } : null };
  }

  /* ---------- views ---------- */
  var TABS = ["home", "debts", "plan", "more"];
  var TITLES = { home: "Home", debts: "Your debts", plan: "Your plan", more: "More" };
  var currentTab = "home", firstRoute = true;
  function route() {
    var t = (location.hash || "#home").slice(1);
    if (TABS.indexOf(t) < 0) t = "home";
    currentTab = t;
    TABS.forEach(function (n) {
      $("view-" + n).hidden = n !== t;
      var a = document.querySelector('.tabbar a[data-tab="' + n + '"]');
      if (n === t) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.title = TITLES[t] + " | Porchlight Ledger Debt Planner";
    if (!firstRoute) { window.scrollTo(0, 0); $("view-" + t).focus({ preventScroll: true }); }
    firstRoute = false;
  }
  window.addEventListener("hashchange", route);
  function go(tab) { if (location.hash === "#" + tab) route(); else location.hash = "#" + tab; }

  function renderPill() {
    var pill = $("saved-pill"), txt = $("saved-pill-text");
    if (saveOK) { pill.classList.remove("warn"); txt.textContent = "Saved on this device only"; }
    else { pill.classList.add("warn"); txt.textContent = "Not saving. Export a backup"; }
  }

  function bar(pct, label, cls) {
    return '<div class="bar ' + (cls || "") + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="' + esc(label) + '"><span style="width:' + pct + '%"></span></div>';
  }
  var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-7"/></svg>';

  function debtCard(d, full) {
    var pct = PP.percentPaid(d.startBalance, d.balance), paid = d.balance <= 0;
    var h = '<article class="card debt' + (paid ? " paid" : "") + '" id="debt-' + esc(d.id) + '" tabindex="-1" aria-labelledby="dn-' + esc(d.id) + '">' +
      '<div class="debt-head"><h3 id="dn-' + esc(d.id) + '">' + esc(d.name) +
      (d.sample ? '<span class="tag terra">Example</span>' : "") + (d.excluded ? '<span class="tag">Not in plan</span>' : "") + '</h3>' +
      '<div class="debt-bal">' + money.format(d.balance) + '</div></div>' +
      bar(pct, d.name + ": " + pct + " percent paid", "") +
      '<p class="small muted" style="margin:0">' + pct + '% paid. ' + money.format(d.startBalance - d.balance) + ' of ' + money.format(d.startBalance) + '.</p>';
    if (paid) {
      h += '<p class="paid-mark">' + CHECK + 'Paid off' + (d.paidOffDate ? " on " + esc(dayLabel(d.paidOffDate)) : "") + '.</p>';
    } else {
      h += '<p class="small muted" style="margin:6px 0 0">' + d.apr + '% APR. Minimum <span class="amt">' + money.format(d.minPayment) + '</span> a month.</p>';
    }
    h += '<div class="row-actions">';
    if (!paid) h += '<button type="button" class="btn btn-small" data-act="log" data-id="' + esc(d.id) + '">Log a payment</button>';
    if (full) {
      h += '<button type="button" class="btn btn-small btn-ghost" data-act="edit" data-id="' + esc(d.id) + '" aria-label="Edit ' + esc(d.name) + '">Edit</button>' +
        '<button type="button" class="btn-link" data-act="delete" data-id="' + esc(d.id) + '" aria-label="Delete ' + esc(d.name) + '">Delete</button>';
    }
    h += '</div>';
    if (full) {
      var ch = PP.historyChanges(d);
      h += '<details class="hist"' + (openHist[d.id] ? " open" : "") + ' data-hist="' + esc(d.id) + '"><summary>History (' + ch.length + ')</summary><ul>';
      for (var i = ch.length - 1; i >= 0; i--) {
        var c = ch[i];
        h += '<li><span>' + esc(dayLabel(c.date)) + ': <span class="amt">' + money.format(c.balance) + '</span>' +
          (c.change === null ? ' <span class="muted">(starting balance)</span>' : c.change > 0 ? ' <span class="muted">(down ' + money.format(c.change) + ')</span>' : c.change < 0 ? ' <span class="muted">(up ' + money.format(-c.change) + ')</span>' : "") + '</span>' +
          (ch.length > 1 ? '<button type="button" class="btn-link" data-act="rmentry" data-id="' + esc(d.id) + '" data-i="' + i + '" aria-label="Remove the ' + esc(dayLabel(c.date)) + ' entry for ' + esc(d.name) + '">Remove</button>' : "") + '</li>';
      }
      h += '</ul></details>';
    }
    return h + '</article>';
  }
  var openHist = {};

  function thisMonthHTML(P) {
    var rows = PL.thisMonth(P.active, P.plan.order, state.extra), total = 0, h = "";
    rows.forEach(function (r) { total += r.total; });
    h += '<div class="card"><h3>This month</h3><ul class="list-plain">';
    rows.forEach(function (r) {
      h += '<li><div class="split"><span>' + esc(r.name) + (r.firstFocus ? ' <span class="tag terra">Focus</span>' : "") + '</span><strong>' + m$(r.total) + '</strong></div>' +
        (r.extra > 0.004 ? '<div class="small muted">Minimum ' + m$(r.minimum) + ' plus ' + m$(r.extra) + ' extra</div>' : '<div class="small muted">Minimum payment</div>') + '</li>';
    });
    h += '</ul><p class="small muted" style="margin:8px 0 0">Total this month: ' + m$(total) + '. Estimate based on your balances today.</p></div>';
    return h;
  }

  function sampleBanner() {
    if (!state.debts.some(function (d) { return d.sample; })) return "";
    return '<div class="notice"><p><strong>Sample plan.</strong> The debts marked Example are made up so you can look around. They are not yours.</p>' +
      '<button type="button" class="btn btn-small btn-ghost" data-act="rm-sample">Remove the example debts</button></div>';
  }

  function backupLine() {
    if (!state.debts.length) return "";
    var last = state.lastBackup ? new Date(state.lastBackup) : null;
    var days = last ? Math.floor((Date.now() - last.getTime()) / 864e5) : null;
    if (last && days < 14) return "";
    return '<div class="notice info"><p style="margin:0">' + (last ? "Last backup: " + esc(dayLabel(PP.todayISO(last))) + "." : "Last backup: never.") +
      ' Your numbers live only on this device. <button type="button" class="btn-link teal" data-act="export-json" style="min-height:44px;padding:0 4px">Back up now</button></p></div>';
  }
  function safariLine() {
    if (!isIOS() || isStandalone() || !state.debts.length) return "";
    return '<div class="notice"><p style="margin:0">You are in a Safari tab. Safari can clear saved data from tabs you have not opened in a while. Tap Share, then Add to Home Screen, and keep a backup file.</p></div>';
  }

  function renderHome() {
    var h = "", P = planFor(state), sum = PP.summary(state.debts);
    if (!state.debts.length) {
      h = '<div class="card hero"><h3>Nothing here yet, and that is okay.</h3><p>Add your first debt when you are ready. Your numbers stay on this device.</p>' +
        '<div class="row-actions"><button type="button" class="btn" data-act="add">Add a debt</button><button type="button" class="btn btn-ghost" data-act="sample">Try a sample plan</button></div>' +
        '<p class="small muted" style="margin:10px 0 0">The sample plan uses made up example debts and is labeled as an example.</p></div>';
      $("home").innerHTML = h; return;
    }
    h += sampleBanner();
    if (sum.allPaidOff) {
      h += '<div class="card hero"><p class="eyebrow">All paid off</p><p class="big">Every debt here is paid off.</p><p>You paid down ' + m$(sum.totalPaidDown) + ' in total. Take a moment with that.</p></div>';
    } else if (!P) {
      h += '<div class="card hero"><p class="eyebrow">Your debt-free date</p><p class="big">Not set yet</p><p>All your remaining debts are left out of the plan. Edit a debt to put it back in.</p></div>';
    } else if (!P.plan.paidOff) {
      h += '<div class="card hero"><p class="eyebrow">Your debt-free date</p><p class="big">Not within 50 years</p><p>At ' + m$(P.plan.monthlyBudget) + ' a month, these balances do not reach $0. A larger extra amount on the Plan tab can change that.</p></div>';
    } else {
      h += '<div class="card hero"><p class="eyebrow">Your debt-free date</p><p class="big">' + esc(monthLabel(P.plan.months)) + '</p>' +
        '<p style="margin:0">About ' + esc(duration(P.plan.months)) + ' from now, paying ' + m$(P.plan.monthlyBudget) + ' a month.' +
        (P.saved && P.saved.months > 0 ? " That is " + plural(P.saved.months, "month") + " sooner than minimums only." : "") + '</p>' +
        '<p class="small muted" style="margin:6px 0 0">' + esc(planName(state.method)) + '. Estimate, not a promise.</p></div>';
    }
    if (sum.active) h += '<button type="button" class="btn btn-block" data-act="log" style="margin-bottom:16px">Log a payment</button>';
    h += backupLine() + safariLine();
    if (P) h += thisMonthHTML(P);
    h += '<div class="card"><h3>Your progress</h3><div class="split"><span>Left to pay</span><strong>' + m$(sum.totalCurrent) + '</strong></div>' +
      '<div class="split"><span>Paid so far</span><strong>' + m$(sum.totalPaidDown) + '</strong></div>' +
      bar(sum.percent, "Overall: " + sum.percent + " percent paid", "") + '<p class="small muted" style="margin:0">' + sum.percent + '% paid across ' + plural(sum.count, "debt") + '.</p></div>';
    h += '<h3>Your debts</h3>';
    state.debts.forEach(function (d) { h += debtCard(d, false); });
    $("home").innerHTML = h;
  }

  function renderDebts() {
    var h = "";
    if (!state.debts.length) {
      h = '<div class="card"><p>No debts yet. Add one with the button below, or look around with a sample plan.</p><div class="row-actions"><button type="button" class="btn" data-act="add">Add a debt</button><button type="button" class="btn btn-ghost" data-act="sample">Try a sample plan</button></div></div>';
    } else {
      h += sampleBanner();
      state.debts.forEach(function (d) { h += debtCard(d, true); });
      h += '<div class="row-actions"><button type="button" class="btn" data-act="add">Add a debt</button><button type="button" class="btn btn-ghost" data-act="sample">Add the sample debts</button></div>';
    }
    $("debts").innerHTML = h;
  }

  function chartSVG(P) {
    var plan = P.plan, base = P.base;
    var horizon = plan.paidOff ? Math.max(plan.months, base.paidOff ? base.months : plan.months) : 0;
    if (!horizon) return "";
    var S = PL.chartSeries(P.active, P.cfg, state.extra, horizon);
    var W = 360, H = 230, L = 50, R = 12, T = 12, B = 34, pw = W - L - R, ph = H - T - B, max = S.startBalance || 1;
    function x(m) { return L + pw * m / horizon; }
    function y(b) { return T + ph * (1 - b / max); }
    function pts(a) { return a.map(function (p) { return x(p.m).toFixed(1) + "," + y(p.b).toFixed(1); }).join(" "); }
    var planPts = pts(S.plan), area = x(0).toFixed(1) + "," + y(0).toFixed(1) + " " + planPts + " " + x(horizon).toFixed(1) + "," + y(0).toFixed(1);
    var label = "Balance over time. Starts at " + money0.format(max) + " today. With your plan it reaches $0 in " + monthLabel(plan.months) + "." +
      (base.paidOff ? " With minimums only it reaches $0 in " + monthLabel(base.months) + "." : " With minimums only it does not reach $0.");
    var svg = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(label) + '" focusable="false">' +
      '<line x1="' + L + '" y1="' + y(0) + '" x2="' + (W - R) + '" y2="' + y(0) + '" stroke="#6f827e" stroke-width="1"/>' +
      '<line x1="' + L + '" y1="' + y(max / 2) + '" x2="' + (W - R) + '" y2="' + y(max / 2) + '" stroke="#dfe7e4" stroke-width="1"/>' +
      '<line x1="' + L + '" y1="' + y(max) + '" x2="' + (W - R) + '" y2="' + y(max) + '" stroke="#dfe7e4" stroke-width="1"/>' +
      '<polygon points="' + area + '" fill="#E3EFEC"/>' +
      '<polyline points="' + pts(S.minimums) + '" fill="none" stroke="#A94E34" stroke-width="2.5" stroke-dasharray="6 4" stroke-linejoin="round"/>' +
      '<polyline points="' + planPts + '" fill="none" stroke="#2F7A72" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<g font-size="11" fill="#4a5755" font-family="Source Sans Pro, system-ui, sans-serif">' +
      '<text x="' + (L - 6) + '" y="' + (y(max) + 4) + '" text-anchor="end">' + esc(moneyC.format(max)) + '</text>' +
      '<text x="' + (L - 6) + '" y="' + (y(max / 2) + 4) + '" text-anchor="end">' + esc(moneyC.format(max / 2)) + '</text>' +
      '<text x="' + (L - 6) + '" y="' + (y(0) + 4) + '" text-anchor="end">$0</text>' +
      '<text x="' + L + '" y="' + (H - 12) + '" text-anchor="start">Now</text>' +
      '<text x="' + (W - R) + '" y="' + (H - 12) + '" text-anchor="end">' + esc(monthLabel(horizon, monthShort)) + '</text></g></svg>';
    return '<div class="card"><h3>Balance over time</h3>' + svg +
      '<div class="legend"><span><i></i>With your plan</span><span><i class="dash"></i>Minimums only' + (base.paidOff ? "" : " (does not reach $0)") + '</span></div></div>';
  }

  function firstWin(sim, active) {
    var best = null;
    sim.payoffMonth.forEach(function (m, i) { if (m !== null && (best === null || m < best.m)) best = { m: m, name: active[i].name }; });
    return best;
  }

  function compareHTML(P) {
    var C = PL.compareMethods(P.active, state.extra, P.cfg), cols = [["Snowball", C.snowball], ["Avalanche", C.avalanche]];
    if (C.custom) cols.push(["Your order", C.custom]);
    function row(label, f) { return "<tr><th scope=\"row\">" + label + "</th>" + cols.map(function (c) { return '<td class="amt">' + f(c[1]) + "</td>"; }).join("") + "</tr>"; }
    var h = '<div class="card"><h3>Snowball and Avalanche, side by side</h3><p class="small muted">Same debts, same ' + m$(C.snowball.monthlyBudget) + ' a month. Only the order changes.</p>' +
      '<table class="cmp"><thead><tr><th scope="col"><span class="sr">Measure</span></th>' + cols.map(function (c) { return '<th scope="col" class="amt">' + c[0] + "</th>"; }).join("") + "</tr></thead><tbody>" +
      row("Debt-free", function (s) { return s.paidOff ? esc(monthLabel(s.months, monthShort)) : "Not in 50 years"; }) +
      row("Months", function (s) { return s.paidOff ? s.months : "n/a"; }) +
      row("Total interest", function (s) { return s.paidOff ? money0.format(s.totalInterest) : "n/a"; }) +
      row("Total paid", function (s) { return s.paidOff ? money0.format(s.totalPaid) : "n/a"; }) +
      row("First debt gone", function (s) { var f = firstWin(s, P.active); return f ? esc(monthLabel(f.m, monthShort)) : "n/a"; }) +
      "</tbody></table>";
    var sw = firstWin(C.snowball, P.active), aw = firstWin(C.avalanche, P.active), line = "";
    if (C.better === "same") line = "For these debts the two methods come out the same.";
    else if (C.better) {
      var who = C.better === "avalanche" ? "Avalanche" : "Snowball", other = C.better === "avalanche" ? "Snowball" : "Avalanche";
      line = who + " comes out " + money0.format(C.interestSaved) + " lower in interest" + (C.monthsSaved > 0 ? " and " + plural(C.monthsSaved, "month") + " sooner" : "") + " than " + other + ".";
      if (sw && aw && sw.m < aw.m) line += " Snowball clears a debt sooner (" + monthLabel(sw.m, monthShort) + " versus " + monthLabel(aw.m, monthShort) + "), which some people find helps them keep going.";
    }
    h += '<p style="margin:10px 0 0">' + esc(line) + ' <strong>Either path works.</strong> Pick the one you will stick with.</p></div>';
    return h;
  }

  function orderHTML(P) {
    var ids = P.plan.order.map(function (i) { return P.active[i].id; });
    var h = '<div class="card"><h3>Payoff order</h3><p class="small muted">The top debt gets the extra money. Use the arrows to set your own order.' + (state.method !== "custom" ? " Moving one switches to Your own order." : "") + '</p><ol class="list-plain">';
    P.plan.order.forEach(function (idx, pos) {
      var d = P.active[idx], m = P.plan.payoffMonth[idx];
      h += '<li class="order-item"><span class="order-num" aria-hidden="true">' + (pos + 1) + '</span><div><strong>' + esc(d.name) + '</strong>' +
        '<div class="small muted">' + (m ? "Paid off " + esc(monthLabel(m)) + " (month " + m + ")" : "Not paid off within 50 years") + '</div>' +
        '<div class="small muted"><span class="amt">' + money.format(d.balance) + "</span> at " + d.apr + "% APR</div></div>" +
        '<div class="mv" role="group" aria-label="Move ' + esc(d.name) + '">' +
        '<button type="button" id="mv-' + esc(d.id) + '-up" data-act="move" data-dir="-1" data-id="' + esc(d.id) + '" aria-label="Move ' + esc(d.name) + ' up"' + (pos === 0 ? " disabled" : "") + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button>' +
        '<button type="button" id="mv-' + esc(d.id) + '-down" data-act="move" data-dir="1" data-id="' + esc(d.id) + '" aria-label="Move ' + esc(d.name) + ' down"' + (pos === ids.length - 1 ? " disabled" : "") + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div></li>';
    });
    h += "</ol>";
    var ex = state.debts.filter(function (d) { return d.excluded && d.balance > 0; });
    if (ex.length) h += '<p class="small muted" style="margin:10px 0 0">Not in the plan: ' + ex.map(function (d) { return esc(d.name); }).join(", ") + ". Keep paying their minimums on your own.</p>";
    return h + "</div>";
  }

  function planResultsHTML() {
    var P = planFor(state), h = "";
    if (!P) return '<div class="card"><p>Add a debt that is in the plan and the results show up here.</p><button type="button" class="btn" data-act="add">Add a debt</button></div>';
    var warn = PO().minimumWarnings(P.active);
    if (warn.length) {
      h += '<div class="notice"><strong>Worth knowing:</strong> ' + warn.map(function (w) {
        var d = P.active[w.index]; return esc(d.name) + "'s minimum (" + money.format(d.minPayment) + ") does not cover its first month of interest (about " + money.format(w.monthlyInterest) + ")";
      }).join("; ") + ". Paying only the minimum, that balance would not go down.</div>";
    }
    var plan = P.plan;
    if (!plan.paidOff) {
      h += '<div class="card"><h3>This plan does not reach $0</h3><p>At ' + m$(plan.monthlyBudget) + ' a month, these debts are not paid off within 50 years. Try a larger extra amount above.</p></div>';
      return h;
    }
    h += '<div class="card hero"><p class="eyebrow">Your ' + esc(METHODS[state.method]) + ' plan</p><p class="big" style="font-size:2rem">Debt-free by ' + esc(monthLabel(plan.months)) + '</p>' +
      '<p style="margin:0">That is ' + esc(duration(plan.months)) + ', paying ' + m$(plan.monthlyBudget) + ' a month in total.</p>' +
      '<dl class="stats"><div><dt>Total interest</dt><dd>' + money0.format(plan.totalInterest) + '</dd></div><div><dt>Total paid</dt><dd>' + money0.format(plan.totalPaid) + '</dd></div>' +
      (P.saved ? '<div><dt>Interest saved</dt><dd>' + money0.format(P.saved.interest) + '</dd></div><div><dt>Months sooner</dt><dd>' + P.saved.months + '</dd></div>'
        : '<div class="wide"><dt>Minimums only</dt><dd style="font-size:1.1rem">Some balances never reach $0</dd></div>') + '</dl>' +
      '<p class="small muted" style="margin:6px 0 0">Saved is compared with paying only each debt\'s own minimum, with no extra and nothing rolled over.</p></div>';
    h += thisMonthHTML(P) + compareHTML(P) + orderHTML(P) + chartSVG(P);
    return h;
  }
  function PO() { return window.PLPayoff; }

  function renderPlanResults() { $("plan-results").innerHTML = planResultsHTML(); }
  function renderPlan() {
    var h = '<div class="card"><div class="field" style="margin:0 0 14px"><label for="extra">Extra each month, on top of your minimums</label>' +
      '<div class="input"><span aria-hidden="true">$</span><input id="extra" type="text" inputmode="decimal" autocomplete="off" value="' + (state.extra ? esc(String(state.extra)) : "") + '" placeholder="0" aria-describedby="extra-hint extra-err"></div>' +
      '<p class="hint" id="extra-hint">The results below update as you type. Try a small amount and watch the date move.</p><p class="err" id="extra-err" hidden></p></div>' +
      '<fieldset><legend>Payoff order</legend>';
    ["snowball", "avalanche", "custom"].forEach(function (m) {
      var txt = m === "snowball" ? "Smallest balance first. Faster first wins." : m === "avalanche" ? "Highest APR first. Usually the least interest." : "You choose the order with the arrows below.";
      h += '<label class="choice"><input type="radio" name="method" value="' + m + '"' + (state.method === m ? " checked" : "") + '><span><strong>' + METHODS[m] + '</strong><br><span class="small muted">' + txt + '</span></span></label>';
    });
    h += '</fieldset><p class="small muted" style="margin:0">Either path works. Pick the one you will stick with.</p></div>' +
      '<div id="plan-results"></div>' +
      '<div class="row-actions no-print"><button type="button" class="btn btn-ghost" data-act="print">Print this plan</button></div>';
    $("plan").innerHTML = h;
    renderPlanResults();
  }

  function renderMore() {
    var h = '<div class="card"><h3>Your data</h3><p><strong>Saved on this device only.</strong> Nothing you enter is sent anywhere. There are no accounts, no cookies and no tracking.</p>';
    if (!saveOK) h += '<div class="notice"><strong>This browser is not letting the app save.</strong> This can happen in private browsing. Your changes will be lost when you close the page, so export a backup before you leave.</div>';
    if (loadStatus === "corrupt") h += '<div class="notice">The saved data on this device could not be read, so the app started fresh. The old data was kept aside and not deleted.</div>';
    h += '<p class="small muted">' + (state.lastBackup ? "Last backup: " + esc(dayLabel(PP.todayISO(new Date(state.lastBackup)))) + "." : "Last backup: never.") + ' Keep a backup file somewhere you trust.</p>' +
      '<div class="row-actions"><button type="button" class="btn" data-act="export-json">Back up (JSON file)</button><button type="button" class="btn btn-ghost" data-act="export-csv">Export CSV</button><button type="button" class="btn btn-ghost" data-act="import">Import a file</button></div>' +
      '<p class="small muted" style="margin:10px 0 0">JSON restores everything. CSV opens in a spreadsheet, and can also add debts from a file with the headings name, balance, apr, min_payment.</p>' +
      '<div id="import-msg" role="alert" tabindex="-1" class="focus-target" hidden></div>';
    var ps = persistState === "granted" ? "Your browser has agreed to keep this data." : persistState === "not-granted" ? "Your browser did not agree to protect this data, so keep a backup." : persistState === "unsupported" ? "This browser cannot be asked to protect saved data, so keep a backup." : "You can ask your browser to keep this data when it is low on space.";
    h += '<p class="small muted" style="margin:10px 0 0">Storage protection: ' + ps + '</p>';
    if (persistState !== "granted" && persistState !== "unsupported") h += '<button type="button" class="btn btn-small btn-ghost" data-act="persist">Ask the browser to keep my data</button>';
    h += safariLine() + '<div class="row-actions"><button type="button" class="btn-link" data-act="clear">Clear all data</button></div></div>';

    h += '<div class="card" id="install-card"><h3>Install on your phone</h3>';
    if (isStandalone()) h += "<p>You are using the installed app.</p>";
    else {
      h += '<p>Installing puts the app on your home screen and lets it open offline.</p>' +
        '<button type="button" class="btn btn-small" id="install-btn" data-act="install"' + (deferredPrompt ? "" : " hidden") + '>Install the app</button>' +
        '<p style="margin-top:10px"><strong>iPhone:</strong> in Safari, tap Share, then Add to Home Screen.<br><strong>Android:</strong> in Chrome, tap Install app when it shows, or open the menu and tap Add to Home screen.</p>';
    }
    h += "</div>";

    h += '<div class="card"><h3>From Porchlight Ledger</h3><ul class="list-plain">' +
      '<li><a href="https://porchlight-ledger.kit.com/16208810d1" target="_blank" rel="noopener noreferrer">Free Debt Snowball Worksheet</a><div class="small muted">A printable worksheet, free by email.</div></li>' +
      '<li><a href="https://www.etsy.com/shop/PorchlightLedger" target="_blank" rel="noopener noreferrer">Shop all planners on Etsy</a></li>' +
      '<li><a href="https://www.etsy.com/listing/4587781978" target="_blank" rel="noopener noreferrer">Household Finance Bundle</a> <span class="muted">$19.99 on Etsy</span></li>' +
      '<li><a href="https://porchlightledger.com" target="_blank" rel="noopener noreferrer">porchlightledger.com</a></li>' +
      '<li><a href="https://porchlightledger.com/privacy.html" target="_blank" rel="noopener noreferrer">Privacy page</a></li></ul>' +
      '<p class="small muted" style="margin:8px 0 0">These links open in a new tab. This app does not send them anything about you.</p></div>';

    h += '<div class="card"><h3>How the numbers work</h3><p class="small">Interest is added each month at APR divided by 12. Then your payments are applied: each debt gets its minimum, and the rest (your extra, plus minimums freed up by paid off debts) goes to the first debt in your order. The plan assumes fixed APRs, no new charges and the same total payment every month. Real statements can differ a little.</p>' +
      '<p class="small" style="margin:0">Educational tool, not financial advice.</p></div>';
    h += '<p class="small muted">Debt Planner, private preview. Works offline once opened. Data stays in this browser.</p>';
    $("more").innerHTML = h;
  }

  function renderAll() {
    var ae = document.activeElement, id = ae && ae.id;
    renderPill(); renderHome(); renderDebts(); renderPlan(); renderMore();
    if (id) { var el = $(id); if (el && el !== document.activeElement && !el.disabled) el.focus({ preventScroll: true }); }
  }

  /* ---------- dialogs ---------- */
  function openDlg(d) { if (d.showModal) d.showModal(); else { d.setAttribute("open", ""); d.classList.add("fallback"); } }
  function closeDlg(d) { if (d.close) d.close(); else d.removeAttribute("open"); }
  Array.prototype.forEach.call(document.querySelectorAll("dialog"), function (d) {
    d.addEventListener("click", function (e) { if (e.target.hasAttribute && e.target.hasAttribute("data-close")) closeDlg(d); });
  });
  function setErr(inputId, msg) {
    var inp = $(inputId), p = $(inputId + "-err");
    if (!inp || !p) return;
    var box = inp.closest(".input");
    if (msg) { inp.setAttribute("aria-invalid", "true"); p.textContent = msg; p.hidden = false; if (box) box.classList.add("bad"); }
    else { inp.removeAttribute("aria-invalid"); p.textContent = ""; p.hidden = true; if (box) box.classList.remove("bad"); }
  }
  function confirmDlg(title, text, okLabel, onOk) {
    $("dlg-confirm-title").textContent = title; $("dlg-confirm-text").textContent = text; $("dlg-confirm-ok").textContent = okLabel;
    $("dlg-confirm-ok").onclick = function () { closeDlg($("dlg-confirm")); onOk(); };
    openDlg($("dlg-confirm"));
  }

  var editingId = null;
  function openDebtDialog(id) {
    editingId = id || null;
    var d = id ? findDebt(id) : null;
    $("dlg-debt-title").textContent = d ? "Edit debt" : "Add a debt";
    $("f-save").textContent = d ? "Save changes" : "Save debt";
    $("f-name").value = d ? d.name : ""; $("f-balance").value = d ? String(d.balance) : "";
    $("f-apr").value = d ? String(d.apr) : ""; $("f-min").value = d ? String(d.minPayment) : "";
    $("f-excluded").checked = d ? !!d.excluded : false;
    ["f-name", "f-balance", "f-apr", "f-min"].forEach(function (i) { setErr(i, ""); });
    openDlg($("dlg-debt")); $("f-name").focus();
  }
  function readDebtForm() {
    return { name: $("f-name").value, balance: PP.parseNumber($("f-balance").value), apr: PP.parseNumber($("f-apr").value.replace("%", "")),
      minPayment: PP.parseNumber($("f-min").value), excluded: $("f-excluded").checked };
  }
  function showFieldErrors(errs, map, order) {
    var first = null;
    Object.keys(map).forEach(function (k) { setErr(map[k], errs[k] || ""); });
    order.forEach(function (k) { if (!first && errs[k]) first = map[k]; });
    if (first) $(first).focus();
    return !!first;
  }
  var DEBT_MAP = { name: "f-name", balance: "f-balance", apr: "f-apr", minPayment: "f-min" };
  $("form-debt").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = readDebtForm(), r;
    if (editingId) r = PP.editDebt(findDebt(editingId), f, today());
    else {
      if (state.debts.length >= PS.MAX_DEBTS) { setErr("f-name", "You can keep up to " + PS.MAX_DEBTS + " debts."); return; }
      r = PP.makeDebt(f, today(), PS.newId());
    }
    if (!r.ok) { showFieldErrors(r.errors, DEBT_MAP, ["name", "balance", "apr", "minPayment"]); return; }
    var wasEmpty = !state.debts.length, id = r.debt.id;
    closeDlg($("dlg-debt"));
    mutate(function () {
      if (editingId) state.debts = state.debts.map(function (d) { return d.id === editingId ? r.debt : d; });
      else { state.debts.push(r.debt); state.onboarded = true; }
    }, editingId ? "Saved." : "Debt added.", !!editingId);
    if (wasEmpty) askPersist();
    var card = $("debt-" + id); if (card && currentTab !== "home") card.focus();
  });

  var logDebtId = null;
  function logMode() { return document.querySelector('input[name="l-mode"]:checked').value; }
  function updateLogHint() {
    var d = findDebt($("l-debt").value);
    $("l-current").textContent = d ? "Current balance: " + money.format(d.balance) + "." : "";
    $("l-value-label").textContent = logMode() === "payment" ? "Payment amount" : "New balance";
  }
  function openLog(id) {
    var act = state.debts.filter(function (d) { return d.balance > 0; });
    if (!act.length) { toast("Every debt here is already paid off."); return; }
    $("l-debt").innerHTML = act.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>"; }).join("");
    if (id && findDebt(id) && findDebt(id).balance > 0) $("l-debt").value = id;
    document.querySelector('input[name="l-mode"][value="payment"]').checked = true;
    $("l-value").value = ""; $("l-date").value = today(); $("l-date").max = today();
    setErr("l-value", ""); setErr("l-date", ""); updateLogHint();
    openDlg($("dlg-log")); $("l-value").focus();
  }
  $("l-debt").addEventListener("change", updateLogHint);
  Array.prototype.forEach.call(document.querySelectorAll('input[name="l-mode"]'), function (r) { r.addEventListener("change", updateLogHint); });
  $("form-log").addEventListener("submit", function (e) {
    e.preventDefault();
    var d = findDebt($("l-debt").value); if (!d) return;
    var r = PP.logEntry(d, { date: $("l-date").value, mode: logMode(), value: PP.parseNumber($("l-value").value) }, today());
    if (!r.ok) { showFieldErrors(r.errors, { value: "l-value", date: "l-date" }, ["value", "date"]); return; }
    var before = planFor(state), pctBefore = PP.percentPaid(d.startBalance, d.balance), name = d.name, nd = r.debt;
    closeDlg($("dlg-log"));
    var snap = clone(state);
    state.debts = state.debts.map(function (x) { return x.id === nd.id ? nd : x; });
    save(); renderAll();
    var after = planFor(state), msg;
    var left = state.debts.filter(function (x) { return x.balance > 0 && !x.excluded; }).length;
    if (r.paidOff) {
      msg = name + " is paid off." + (left ? " Its " + money.format(d.minPayment) + " a month can now go toward the next debt." : " That is every debt in the plan.");
    } else {
      msg = "Logged. Balance is now " + money.format(nd.balance) + ".";
      if (before && after && before.plan.paidOff && after.plan.paidOff) {
        var diff = before.plan.months - after.plan.months;
        if (diff > 0) msg = "Logged. Your debt-free date moved " + plural(diff, "month") + " closer.";
        else if (diff < 0) msg = "Logged. Your debt-free date moved " + plural(-diff, "month") + " later. That is okay, the plan is updated.";
        else msg = "Logged. Your debt-free date is still " + monthLabel(after.plan.months) + ".";
      }
      var ms = PP.milestonesCrossed(pctBefore, PP.percentPaid(nd.startBalance, nd.balance));
      if (ms.length) msg += " " + name + " is now " + ms[ms.length - 1] + "% paid.";
    }
    toast(msg, snap);
  });

  /* ---------- actions ---------- */
  var SAMPLE = [
    { name: "Example: Store card", balance: 800, apr: 12, minPayment: 30 },
    { name: "Example: Credit card", balance: 4500, apr: 24, minPayment: 110 },
    { name: "Example: Car loan", balance: 9000, apr: 6, minPayment: 250 }];
  function addSample() {
    var room = PS.MAX_DEBTS - state.debts.length;
    SAMPLE.slice(0, Math.max(0, room)).forEach(function (s) {
      var r = PP.makeDebt({ name: s.name, balance: s.balance, apr: s.apr, minPayment: s.minPayment, sample: true }, today(), PS.newId());
      if (r.ok) state.debts.push(r.debt);
    });
    if (!state.extra) state.extra = 200;
    state.onboarded = true;
  }

  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type })), a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener"; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function exportJSON() {
    download("porchlight-ledger-debt-planner-backup-" + today() + ".json", PS.serialize(state), "application/json");
    state.lastBackup = new Date().toISOString(); save(); renderAll();
    toast("Backup file downloaded. Keep it somewhere you trust.");
  }
  function exportCSV() {
    download("porchlight-ledger-debts-" + today() + ".csv", PS.toCSV(state), "text/csv");
    toast("CSV downloaded.");
  }
  function showImportMsg(lines) {
    var box = $("import-msg"); if (!box) return;
    box.innerHTML = '<div class="notice"><strong>That file was not imported.</strong><ul style="margin:6px 0 0;padding-left:20px">' + lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul><p style=\"margin:6px 0 0\">Nothing on this device was changed.</p></div>";
    box.hidden = false; box.focus();
  }
  function readFile(file, cb) {
    var r = new FileReader();
    r.onload = function () { cb(String(r.result)); };
    r.onerror = function () { showImportMsg(["The file could not be read."]); };
    r.readAsText(file);
  }
  $("file-import").addEventListener("change", function () {
    var f = this.files && this.files[0]; this.value = "";
    if (!f) return;
    go("more");
    readFile(f, function (text) {
      var isCSV = /\.csv$/i.test(f.name) || (text.replace(/^\uFEFF/, "").trim().charAt(0) !== "{");
      if (isCSV) {
        var c = PS.parseCSV(text, f.size);
        if (!c.ok) { showImportMsg(c.errors); return; }
        confirmDlg("Add " + plural(c.debts.length, "debt") + "?", "These debts from the CSV file are added to the ones already on this device. You can undo this for 10 seconds.", "Add them", function () {
          mutate(function () {
            c.debts.slice(0, Math.max(0, PS.MAX_DEBTS - state.debts.length)).forEach(function (x) {
              var r = PP.makeDebt(x, today(), PS.newId()); if (r.ok) state.debts.push(r.debt);
            });
            state.onboarded = true;
          }, "Debts added from the CSV file.", true);
        });
      } else {
        var j = PS.parseImport(text, f.size);
        if (!j.ok) { showImportMsg(j.errors); return; }
        confirmDlg("Restore this backup?", "This replaces the " + plural(state.debts.length, "debt") + " on this device with the " + plural(j.state.debts.length, "debt") + " in the file. You can undo this for 10 seconds.", "Restore", function () {
          mutate(function () { j.state.lastBackup = null; state = j.state; }, "Backup restored.", true);
        });
      }
    });
  });

  function askPersist() {
    if (!(navigator.storage && navigator.storage.persist)) { persistState = "unsupported"; return; }
    navigator.storage.persist().then(function (ok) { persistState = ok ? "granted" : "not-granted"; if (currentTab === "more") renderMore(); }).catch(function () {});
  }

  var deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferredPrompt = e;
    var b = $("install-btn"); if (b) b.hidden = false;
  });
  window.addEventListener("appinstalled", function () { deferredPrompt = null; renderMore(); toast("Installed. You can open it from your home screen."); });

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return;
    var act = t.getAttribute("data-act"), id = t.getAttribute("data-id");
    if (act === "add") openDebtDialog();
    else if (act === "edit") openDebtDialog(id);
    else if (act === "log") openLog(id);
    else if (act === "delete") {
      var d = findDebt(id); if (!d) return;
      mutate(function () { state.debts = state.debts.filter(function (x) { return x.id !== id; }); }, "Removed " + d.name + ". Undo within 10 seconds.", true);
    } else if (act === "rmentry") {
      var dd = findDebt(id), r = PP.removeEntry(dd, +t.getAttribute("data-i")); if (!r.ok) { toast(r.error); return; }
      openHist[id] = true;
      mutate(function () { state.debts = state.debts.map(function (x) { return x.id === id ? r.debt : x; }); }, "Entry removed.", true);
    } else if (act === "sample") {
      mutate(addSample, "Sample debts added. They are labeled Example.", true); askPersist();
    } else if (act === "rm-sample") {
      mutate(function () { state.debts = state.debts.filter(function (x) { return !x.sample; }); }, "Example debts removed.", true);
    } else if (act === "move") {
      var P = planFor(state); if (!P) return;
      var ids = P.plan.order.map(function (i) { return P.active[i].id; });
      var moved = PL.moveId(ids, id, +t.getAttribute("data-dir")), nm = findDebt(id).name;
      state.method = "custom"; state.order = moved; save(); renderAll();
      var pos = moved.indexOf(id), target = $("mv-" + id + (+t.getAttribute("data-dir") < 0 ? "-up" : "-down"));
      if (target && target.disabled) target = $("mv-" + id + (+t.getAttribute("data-dir") < 0 ? "-down" : "-up"));
      if (target) target.focus({ preventScroll: true });
      toast(nm + " is now number " + (pos + 1) + " of " + moved.length + ".");
    } else if (act === "print") {
      go("plan"); $("print-date").textContent = "Printed " + dayLabel(today()) + ". Estimates only.";
      setTimeout(function () { window.print(); }, 200);
    } else if (act === "export-json") exportJSON();
    else if (act === "export-csv") exportCSV();
    else if (act === "import") $("file-import").click();
    else if (act === "persist") askPersist();
    else if (act === "install") {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () { deferredPrompt = null; renderMore(); });
    } else if (act === "clear") {
      confirmDlg("Clear all data?", "This deletes every debt, payment record and setting stored on this device. If you have not made a backup, it cannot be brought back.", "Clear all data", function () {
        PS.clearAll(ls); state = PS.emptyState(); state.onboarded = true; loadStatus = "empty"; save(); renderAll(); go("home");
        toast("All data cleared from this device.");
      });
    }
  });
  document.addEventListener("toggle", function (e) {
    var t = e.target; if (t && t.getAttribute && t.getAttribute("data-hist")) openHist[t.getAttribute("data-hist")] = t.open;
  }, true);

  document.addEventListener("input", function (e) {
    if (e.target.id !== "extra") return;
    var raw = e.target.value.trim(), v = raw === "" ? 0 : PP.parseNumber(raw);
    if (!(isFinite(v) && v >= 0 && v <= 1e7)) { setErr("extra", "Enter an amount of $0 or more."); return; }
    setErr("extra", ""); state.extra = PP.round2(v); save(); renderPlanResults(); renderHome();
  });
  document.addEventListener("change", function (e) {
    if (e.target.name === "method") { state.method = e.target.value; save(); renderAll(); }
  });

  /* ---------- first run ---------- */
  var onbStep = 1;
  function onbSteps() {
    var s = '<div class="steps" aria-hidden="true">';
    for (var i = 1; i <= 3; i++) s += '<span class="' + (i <= onbStep ? "on" : "") + '"></span>';
    return s + "</div><p class=\"small muted\">Step " + onbStep + " of 3</p>";
  }
  function showOnboarding() {
    $("onboarding").hidden = false;
    document.getElementById("main").setAttribute("aria-hidden", "true");
    document.querySelector(".tabbar").setAttribute("aria-hidden", "true");
    renderOnb();
  }
  function endOnboarding() {
    state.onboarded = true; save();
    $("onboarding").hidden = true;
    document.getElementById("main").removeAttribute("aria-hidden");
    document.querySelector(".tabbar").removeAttribute("aria-hidden");
    askPersist(); renderAll(); go("home"); window.scrollTo(0, 0);
  }
  function renderOnb() {
    var h = onbSteps();
    if (onbStep === 1) {
      h += '<h1 id="onb-title" tabindex="-1" class="focus-target">Let us make a plan you can see at a glance.</h1>' +
        '<p>Your numbers stay on this device. No account, no tracking, nothing sent anywhere.</p>' +
        '<p class="muted">It takes about a minute. You can change anything later.</p>' +
        '<div class="row-actions" style="flex-direction:column;align-items:stretch"><button type="button" class="btn btn-block" data-onb="add">Add my first debt</button>' +
        '<button type="button" class="btn btn-ghost btn-block" data-onb="sample">Try a sample plan</button>' +
        '<button type="button" class="btn-link" data-onb="skip">Skip for now</button></div>' +
        '<p class="small muted">The sample plan uses made up example debts and is labeled as an example, so you can see how it works before typing your own numbers.</p>';
    } else if (onbStep === 2) {
      var sum = PP.summary(state.debts);
      h += '<h1 id="onb-title" tabindex="-1" class="focus-target">Add your debts</h1><p class="muted">Use the numbers on your latest statement. Close is fine.</p>';
      if (state.debts.length) {
        h += '<div class="card"><p class="label" style="margin:0 0 4px">' + plural(state.debts.length, "debt") + ', ' + m$(sum.totalCurrent) + ' in total</p><ul class="list-plain small">' +
          state.debts.map(function (d) { return "<li>" + esc(d.name) + ": " + m$(d.balance) + "</li>"; }).join("") + "</ul></div>";
      }
      h += '<form id="onb-form" novalidate class="card"><div class="field"><label for="o-name">Name</label><div class="input"><input id="o-name" type="text" maxlength="40" autocomplete="off" placeholder="e.g. Credit card" aria-describedby="o-name-err"></div><p class="err" id="o-name-err" hidden></p></div>' +
        '<div class="field"><label for="o-balance">Balance</label><div class="input"><span aria-hidden="true">$</span><input id="o-balance" type="text" inputmode="decimal" autocomplete="off" aria-describedby="o-balance-err"></div><p class="err" id="o-balance-err" hidden></p></div>' +
        '<div class="two"><div class="field"><label for="o-apr">APR</label><div class="input"><input id="o-apr" type="text" inputmode="decimal" autocomplete="off" aria-describedby="o-apr-err"><span aria-hidden="true">%</span></div><p class="err" id="o-apr-err" hidden></p></div>' +
        '<div class="field"><label for="o-min">Minimum payment</label><div class="input"><span aria-hidden="true">$</span><input id="o-min" type="text" inputmode="decimal" autocomplete="off" aria-describedby="o-min-err"></div><p class="err" id="o-min-err" hidden></p></div></div>' +
        '<div class="row-actions"><button type="submit" class="btn btn-ghost" value="another">Add another</button><button type="submit" class="btn" value="done">That is all</button></div></form>' +
        '<button type="button" class="btn-link" data-onb="back">Back</button>';
    } else {
      var P = planFor(state), C = P ? PL.compareMethods(P.active, state.extra, P.cfg) : null;
      h += '<h1 id="onb-title" tabindex="-1" class="focus-target">How much can you put toward debt each month?</h1>';
      if (state.debts.some(function (d) { return d.sample; })) h += '<p><span class="sample-tag">Sample plan</span> These are example debts, not yours.</p>';
      h += '<div class="card"><div class="field" style="margin:0"><label for="o-extra">Extra each month, on top of your minimums</label><div class="input"><span aria-hidden="true">$</span><input id="o-extra" type="text" inputmode="decimal" autocomplete="off" value="' + (state.extra ? esc(String(state.extra)) : "") + '" placeholder="0" aria-describedby="o-extra-err"></div><p class="hint">Even a small amount is fine. It can be $0.</p><p class="err" id="o-extra-err" hidden></p></div></div>';
      h += '<div id="onb-compare">' + onbCompare(P, C) + "</div>" +
        '<div class="row-actions"><button type="button" class="btn btn-block" data-onb="finish">See my plan</button></div><button type="button" class="btn-link" data-onb="back">Back</button>';
    }
    $("onb-body").innerHTML = h;
    var t = $("onb-title"); if (t) t.focus({ preventScroll: true });
  }
  function onbCompare(P, C) {
    if (!P || !C) return '<p class="muted">Add a debt first to see the comparison.</p>';
    function card(m, s) {
      var f = firstWin(s, P.active);
      return '<label class="choice"><input type="radio" name="o-method" value="' + m + '"' + (state.method === m || (m === "snowball" && state.method === "custom") ? " checked" : "") + '><span><strong>' + METHODS[m] + '</strong><br>' +
        (s.paidOff ? "Debt-free " + esc(monthLabel(s.months)) + ".<br>Interest " + m0$(s.totalInterest) + "." + (f ? "<br>First win: " + esc(f.name) + ", " + esc(monthLabel(f.m)) + "." : "") : "Not paid off within 50 years.") + "</span></label>";
    }
    return '<fieldset><legend>Pick a payoff order</legend>' + card("snowball", C.snowball) + card("avalanche", C.avalanche) +
      '<p class="small muted" style="margin:0">Snowball clears the smallest balance first. Avalanche goes after the highest APR first. Either path works. Pick the one you will stick with.</p></fieldset>';
  }
  $("onboarding").addEventListener("click", function (e) {
    var t = e.target.closest("[data-onb]"); if (!t) return;
    var a = t.getAttribute("data-onb");
    if (a === "add") { onbStep = 2; renderOnb(); }
    else if (a === "sample") { addSample(); save(); onbStep = 3; renderOnb(); }
    else if (a === "skip") endOnboarding();
    else if (a === "back") { onbStep = onbStep - 1; renderOnb(); }
    else if (a === "finish") { if (state.method === "custom") state.method = "snowball"; endOnboarding(); toast("Your plan is ready. It is saved on this device only."); }
  });
  $("onboarding").addEventListener("input", function (e) {
    if (e.target.id !== "o-extra") return;
    var raw = e.target.value.trim(), v = raw === "" ? 0 : PP.parseNumber(raw);
    if (!(isFinite(v) && v >= 0 && v <= 1e7)) { setErr("o-extra", "Enter an amount of $0 or more."); return; }
    setErr("o-extra", ""); state.extra = PP.round2(v); save();
    var P = planFor(state); $("onb-compare").innerHTML = onbCompare(P, P ? PL.compareMethods(P.active, state.extra, P.cfg) : null);
  });
  $("onboarding").addEventListener("change", function (e) {
    if (e.target.name === "o-method") { state.method = e.target.value; save(); }
  });
  $("onboarding").addEventListener("submit", function (e) {
    if (e.target.id !== "onb-form") return;
    e.preventDefault();
    var submitter = e.submitter ? e.submitter.value : "another";
    var f = { name: $("o-name").value, balance: PP.parseNumber($("o-balance").value), apr: PP.parseNumber($("o-apr").value.replace("%", "")), minPayment: PP.parseNumber($("o-min").value) };
    var empty = !f.name.trim() && isNaN(f.balance) && isNaN(f.apr) && isNaN(f.minPayment) && !$("o-apr").value && !$("o-min").value && !$("o-balance").value;
    var map = { name: "o-name", balance: "o-balance", apr: "o-apr", minPayment: "o-min" };
    if (empty && submitter === "done" && state.debts.length) { onbStep = 3; renderOnb(); return; }
    var r = PP.makeDebt(f, today(), PS.newId());
    if (!r.ok) { showFieldErrors(r.errors, map, ["name", "balance", "apr", "minPayment"]); return; }
    state.debts.push(r.debt); save();
    if (submitter === "done") { onbStep = 3; renderOnb(); }
    else { renderOnb(); $("o-name").focus(); }
  });

  /* ---------- start ---------- */
  renderAll();
  route();
  if (!state.onboarded && !state.debts.length) showOnboarding();
  else if (!state.onboarded) { state.onboarded = true; save(); }
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(function (p) { if (p) { persistState = "granted"; if (currentTab === "more") renderMore(); } }).catch(function () {});
  else persistState = "unsupported";

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
