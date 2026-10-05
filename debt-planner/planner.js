/* Debt payoff calculator UI. No storage, no network requests. */
(function () {
  "use strict";
  var P = window.PLPayoff;
  var rowsEl = document.getElementById("dp-rows");
  var form = document.getElementById("dp-form");
  var errBox = document.getElementById("dp-errors");
  var results = document.getElementById("dp-results");
  var extraEl = document.getElementById("dp-extra");
  var extraErr = document.getElementById("dp-extra-err");
  var seq = 0;
  var MAX = 600;

  var money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  var money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  var monthFmt = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

  function monthLabel(n) { // month 1 = next calendar month
    var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n);
    return monthFmt.format(d);
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function duration(m) {
    var y = Math.floor(m / 12), r = m % 12, parts = [];
    if (y) parts.push(plural(y, "year")); if (r || !y) parts.push(plural(r, "month"));
    return parts.join(", ");
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function field(id, label, name, attrs, prefix, suffix) {
    return '<div class="dp-field"><label for="' + id + '">' + label + '</label>' +
      '<div class="dp-money">' + (prefix ? '<span aria-hidden="true">' + prefix + '</span>' : '') +
      '<input id="' + id + '" name="' + name + '" ' + attrs + ' aria-describedby="' + id + '-err">' +
      (suffix ? '<span aria-hidden="true">' + suffix + '</span>' : '') + '</div>' +
      '<p class="dp-err" id="' + id + '-err" hidden></p></div>';
  }

  function addRow(d) {
    seq++; var n = rowsEl.children.length + 1, id = "d" + seq;
    var row = document.createElement("div");
    row.className = "dp-row"; row.setAttribute("role", "group"); row.setAttribute("aria-label", "Debt " + n);
    row.innerHTML =
      field(id + "-name", "Name", "name", 'type="text" maxlength="40" autocomplete="off" placeholder="e.g. Credit card"') +
      field(id + "-bal", "Balance", "balance", 'type="number" inputmode="decimal" min="0" step="0.01" required', "$") +
      field(id + "-apr", "APR", "apr", 'type="number" inputmode="decimal" min="0" max="100" step="0.01" required', "", "%") +
      field(id + "-min", "Minimum payment", "minPayment", 'type="number" inputmode="decimal" min="0" step="0.01" required', "$") +
      '<button type="button" class="dp-remove" aria-label="Remove debt ' + n + '">Remove</button>';
    rowsEl.appendChild(row);
    if (d) { row.querySelector('[name=name]').value = d.name; row.querySelector('[name=balance]').value = d.balance; row.querySelector('[name=apr]').value = d.apr; row.querySelector('[name=minPayment]').value = d.minPayment; }
    relabel();
    return row;
  }
  function relabel() {
    Array.prototype.forEach.call(rowsEl.children, function (r, i) {
      r.setAttribute("aria-label", "Debt " + (i + 1));
      var b = r.querySelector(".dp-remove"); b.setAttribute("aria-label", "Remove debt " + (i + 1));
      b.hidden = rowsEl.children.length === 1;
    });
  }
  rowsEl.addEventListener("click", function (e) {
    if (e.target.classList.contains("dp-remove")) {
      var r = e.target.closest(".dp-row"), next = r.nextElementSibling || r.previousElementSibling;
      r.remove(); relabel(); if (next) next.querySelector("input").focus();
    }
  });
  document.getElementById("dp-add").addEventListener("click", function () { addRow().querySelector("input").focus(); });

  var EXAMPLE = { extra: 200, debts: [
    { name: "Store card", balance: 800, apr: 12, minPayment: 30 },
    { name: "Credit card", balance: 4500, apr: 24, minPayment: 110 },
    { name: "Car loan", balance: 9000, apr: 6, minPayment: 250 }] };
  function fillExample() {
    rowsEl.innerHTML = ""; EXAMPLE.debts.forEach(addRow); extraEl.value = EXAMPLE.extra;
  }
  document.getElementById("dp-example").addEventListener("click", function () { fillExample(); results.innerHTML = ""; });

  function num(v) { return v === "" ? NaN : Number(v); }
  function setErr(input, msg) {
    var p = document.getElementById(input.id + "-err");
    if (msg) { input.setAttribute("aria-invalid", "true"); p.textContent = msg; p.hidden = false; }
    else { input.removeAttribute("aria-invalid"); p.textContent = ""; p.hidden = true; }
  }

  function read() {
    var rows = Array.prototype.map.call(rowsEl.children, function (r, i) {
      return { el: r, name: r.querySelector("[name=name]").value.trim() || ("Debt " + (i + 1)),
        balance: num(r.querySelector("[name=balance]").value), apr: num(r.querySelector("[name=apr]").value),
        minPayment: num(r.querySelector("[name=minPayment]").value) };
    });
    return rows;
  }

  function run(focusResults) {
    var rows = read(), errs = P.validate(rows), count = 0;
    rows.forEach(function (r) { ["balance", "apr", "minPayment"].forEach(function (f) { setErr(r.el.querySelector("[name=" + f + "]"), ""); }); });
    errs.forEach(function (e) {
      Object.keys(e.fields).forEach(function (f) { setErr(rows[e.index].el.querySelector("[name=" + f + "]"), e.fields[f]); count++; });
    });
    var extra = extraEl.value === "" ? 0 : Number(extraEl.value);
    if (!(isFinite(extra) && extra >= 0 && extra <= 1e7)) { setErr(extraEl, "Enter an extra amount of $0 or more."); count++; } else setErr(extraEl, "");
    if (count) {
      errBox.hidden = false;
      errBox.textContent = "Please fix " + plural(count, "field") + " below.";
      errBox.focus(); results.innerHTML = ""; return;
    }
    errBox.hidden = true;
    var method = form.querySelector("[name=method]:checked").value;
    render(rows, P.compare(rows, extra, method, MAX), method, extra);
    if (focusResults) results.focus();
  }

  function render(rows, r, method, extra) {
    var plan = r.plan, base = r.minimumsOnly, h = [];
    if (r.warnings.length) {
      h.push('<div class="dp-warn" role="note"><strong>Heads up:</strong> ' + r.warnings.map(function (w) {
        return esc(rows[w.index].name) + "'s minimum (" + money.format(rows[w.index].minPayment) + ") doesn't cover its first month of interest (about " + money.format(w.monthlyInterest) + ")";
      }).join("; ") + ". On minimum payments alone, that balance would never be paid off.</div>");
    }
    if (!plan.paidOff) {
      h.push('<div class="dp-card dp-summary"><h2>This plan doesn\'t reach $0</h2><p>With ' + money.format(plan.monthlyBudget) + ' a month, these debts aren\'t paid off within ' + MAX + ' months (50 years). Try adding an extra monthly amount or raising a minimum payment.</p></div>');
      results.innerHTML = h.join(""); return;
    }
    var name = method === "avalanche" ? "Avalanche" : "Snowball";
    h.push('<div class="dp-card dp-summary"><p class="eyebrow">Your ' + name + ' plan</p>' +
      '<h2>Debt-free by ' + monthLabel(plan.months) + '</h2>' +
      '<p class="muted">That\'s ' + duration(plan.months) + ', paying ' + money.format(plan.monthlyBudget) + ' a month in total.</p>' +
      '<dl class="dp-stats">' +
      stat("Total interest", money0.format(plan.totalInterest)) +
      (base.paidOff ? stat("Months saved vs minimums only", String(r.monthsSaved)) + stat("Interest saved vs minimums only", money0.format(r.interestSaved))
        : stat("Minimums only", "Never paid off") ) +
      '</dl>' +
      (base.paidOff ? '<p class="muted dp-note">Minimums only means each debt gets just its own minimum, with no extra and nothing rolled over: ' + duration(base.months) + ' and ' + money0.format(base.totalInterest) + ' in interest.</p>'
        : '<p class="muted dp-note">On minimum payments alone, at least one balance never reaches $0, so there\'s no fair "saved" number to show.</p>') +
      '</div>');
    h.push('<div class="dp-card"><h2>Payoff order</h2><ol class="dp-list">');
    plan.order.forEach(function (i) {
      var m = plan.payoffMonth[i], pct = Math.max(3, Math.round(m / plan.months * 100));
      h.push('<li><div class="dp-li-head"><span class="dp-li-name">' + esc(rows[i].name) + '</span><span class="dp-li-when">' + monthLabel(m) + ' <span class="muted">(month ' + m + ')</span></span></div>' +
        '<div class="dp-bar" role="img" aria-label="Paid off in month ' + m + ' of ' + plan.months + '"><span style="width:' + pct + '%"></span></div>' +
        '<p class="muted dp-li-sub">' + money.format(rows[i].balance) + ' at ' + rows[i].apr + '% APR</p></li>');
    });
    h.push('</ol></div>');
    results.innerHTML = h.join("");
  }
  function stat(k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }

  form.addEventListener("submit", function (e) { e.preventDefault(); run(true); });
  form.addEventListener("change", function (e) { if (e.target.name === "method" && results.innerHTML) run(false); });

  if (/[?&]example\b/.test(location.search)) { fillExample(); run(false); }
  else { addRow(); addRow(); }
})();
