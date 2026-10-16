"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PP = require("../progress.js");
const PS = require("../store.js");
const SC = require("../sync-core.js");
const V = require("../vault.js");

const ITER = 1000; // fast for tests; the app uses V.DEFAULT_ITER
function debt(id, name, bal, date, updatedAt) {
  const r = PP.makeDebt({ name, balance: bal, apr: 20, minPayment: 50 }, date, id);
  return Object.assign({}, r.debt, updatedAt ? { updatedAt } : {});
}
function st(over) { return Object.assign(PS.emptyState(), { onboarded: true }, over); }

test("vault: same passphrase and email give the same keys, different ones do not", async () => {
  const a = await V.deriveKeys("correct horse battery staple", "Me@Example.com ", ITER);
  const b = await V.deriveKeys("correct horse battery staple", "me@example.com", ITER);
  const c = await V.deriveKeys("correct horse battery stapl3", "me@example.com", ITER);
  const d = await V.deriveKeys("correct horse battery staple", "other@example.com", ITER);
  assert.equal(a.authKey, b.authKey);
  assert.notEqual(a.authKey, c.authKey);
  assert.notEqual(a.authKey, d.authKey);
  assert.match(a.authKey, /^[A-Za-z0-9_-]{43}$/);
});

test("vault: the encryption key cannot be exported and is separate from the sign-in value", async () => {
  const k = await V.deriveKeys("correct horse battery staple", "me@example.com", ITER);
  assert.equal(k.encKey.extractable, false);
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("raw", k.encKey));
});

test("vault: encrypt then decrypt round trips and the envelope hides the plaintext", async () => {
  const k = await V.deriveKeys("correct horse battery staple", "me@example.com", ITER);
  const text = JSON.stringify({ name: "Visa Example", balance: 1234.56 });
  const env = await V.encrypt(k.encKey, text);
  assert.ok(!env.includes("Visa") && !env.includes("1234"));
  assert.equal(await V.decrypt(k.encKey, env), text);
  const env2 = await V.encrypt(k.encKey, text);
  assert.notEqual(env, env2, "a fresh random IV each time");
});

test("vault: wrong passphrase and changed data are refused", async () => {
  const k = await V.deriveKeys("correct horse battery staple", "me@example.com", ITER);
  const w = await V.deriveKeys("some other long passphrase", "me@example.com", ITER);
  const env = await V.encrypt(k.encKey, "hello");
  await assert.rejects(() => V.decrypt(w.encKey, env), (e) => e.code === "undecryptable");
  const o = JSON.parse(env); o.ct = o.ct.slice(0, -2) + (o.ct.slice(-2) === "AA" ? "BB" : "AA");
  await assert.rejects(() => V.decrypt(k.encKey, JSON.stringify(o)), (e) => e.code === "undecryptable");
  await assert.rejects(() => V.decrypt(k.encKey, "not json"), (e) => e.code === "undecryptable");
});

test("vault: strength guide", () => {
  assert.equal(V.strength("short").ok, false);
  assert.equal(V.strength("aaaaaaaaaaaaaaaa").ok, false);
  assert.equal(V.strength("blue tractor window pencil").ok, true);
});

test("store: update stamps, deleted list and settings time survive a save and load", () => {
  const s = st({ debts: [debt("d1", "Card", 500, "2026-01-01", "2026-02-01T00:00:00.000Z")], deleted: [{ id: "dx", at: "2026-03-01T00:00:00.000Z" }], settingsAt: "2026-03-02T00:00:00.000Z" });
  const mem = {}; const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; }, removeItem: (k) => { delete mem[k]; } };
  PS.save(ls, s);
  const r = PS.load(ls);
  assert.equal(r.status, "ok");
  assert.equal(r.state.debts[0].updatedAt, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(r.state.deleted, s.deleted);
  assert.equal(r.state.settingsAt, s.settingsAt);
});

test("store: old backups without the new fields still load", () => {
  const r = PS.sanitize({ app: PS.APP, version: 1, method: "snowball", extra: 0, debts: [{ name: "A", apr: 5, minPayment: 20, history: [{ date: "2026-01-01", balance: 100 }] }] });
  assert.ok(r.ok);
  assert.deepEqual(r.state.deleted, []);
  assert.equal(r.state.settingsAt, null);
  assert.equal(r.state.debts[0].updatedAt, undefined);
});

test("stampChanges: new, edited and unchanged debts; removals leave a dated note", () => {
  const prev = st({ debts: [debt("d1", "A", 100, "2026-01-01", "2026-01-02T00:00:00.000Z"), debt("d2", "B", 200, "2026-01-01", "2026-01-02T00:00:00.000Z")] });
  const next = JSON.parse(JSON.stringify(prev));
  next.debts = [next.debts[0], Object.assign({}, debt("d3", "C", 300, "2026-02-01"))];
  SC.stampChanges(prev, next, "2026-02-02T00:00:00.000Z");
  assert.equal(next.debts[0].updatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(next.debts[1].updatedAt, "2026-02-02T00:00:00.000Z");
  assert.deepEqual(next.deleted, [{ id: "d2", at: "2026-02-02T00:00:00.000Z" }]);
  const edited = JSON.parse(JSON.stringify(next)); edited.debts[0] = PP.editDebt(edited.debts[0], { name: "A2", balance: 100, apr: 20, minPayment: 50 }, "2026-02-03").debt;
  SC.stampChanges(next, edited, "2026-02-04T00:00:00.000Z");
  assert.equal(edited.debts[0].updatedAt, "2026-02-04T00:00:00.000Z");
});

test("stampChanges: undo of a removal brings the debt back and drops the note", () => {
  const prev = st({ debts: [debt("d1", "A", 100, "2026-01-01", "2026-01-02T00:00:00.000Z")] });
  const removed = JSON.parse(JSON.stringify(prev)); removed.debts = [];
  SC.stampChanges(prev, removed, "2026-02-02T00:00:00.000Z");
  assert.equal(removed.deleted.length, 1);
  const undone = JSON.parse(JSON.stringify(prev));
  SC.stampChanges(removed, undone, "2026-02-02T00:00:05.000Z");
  assert.equal(undone.deleted.length, 0);
  assert.equal(undone.debts[0].updatedAt, "2026-02-02T00:00:05.000Z");
});

test("merge: keeps debts from both sides and combines history", () => {
  const a = st({ debts: [debt("d1", "Card", 500, "2026-01-01", "2026-01-01T00:00:00.000Z")] });
  const b = st({ debts: [JSON.parse(JSON.stringify(a.debts[0])), debt("d2", "Loan", 900, "2026-01-05", "2026-01-05T00:00:00.000Z")] });
  b.debts[0] = PP.logEntry(b.debts[0], { date: "2026-02-01", mode: "payment", value: 100 }, "2026-02-01").debt;
  b.debts[0].updatedAt = "2026-02-01T00:00:00.000Z";
  const a2 = JSON.parse(JSON.stringify(a)); a2.debts[0] = PP.logEntry(a2.debts[0], { date: "2026-03-01", mode: "payment", value: 50 }, "2026-03-01").debt; a2.debts[0].updatedAt = "2026-03-01T00:00:00.000Z";
  const m = SC.merge(a2, b);
  assert.equal(m.debts.length, 2);
  const card = m.debts.find((d) => d.id === "d1");
  assert.equal(card.history.length, 3);
  assert.equal(card.updatedAt, "2026-03-01T00:00:00.000Z");
});

test("merge: same result whichever side goes first (so devices agree)", () => {
  const base = debt("d1", "Card", 500, "2026-01-01", "2026-01-01T00:00:00.000Z");
  const a = st({ debts: [Object.assign({}, base, { name: "Card A", updatedAt: "2026-02-01T00:00:00.000Z" })], method: "avalanche", settingsAt: "2026-02-01T00:00:00.000Z" });
  const b = st({ debts: [Object.assign({}, base, { name: "Card B", updatedAt: "2026-02-02T00:00:00.000Z" }), debt("d9", "Z", 10, "2026-01-02", "2026-01-02T00:00:00.000Z")], method: "snowball", settingsAt: "2026-02-02T00:00:00.000Z",
    deleted: [{ id: "gone", at: "2026-01-03T00:00:00.000Z" }] });
  const ab = SC.merge(a, b), ba = SC.merge(b, a);
  assert.equal(SC.canon(ab), SC.canon(ba));
  assert.equal(ab.debts.find((d) => d.id === "d1").name, "Card B");
  assert.equal(ab.method, "snowball");
  assert.equal(SC.canon(SC.merge(ab, ab)), SC.canon(ab), "merging the result again changes nothing");
});

test("merge: an exact tie is still settled the same way on both devices", () => {
  const t = "2026-02-01T00:00:00.000Z";
  const a = st({ debts: [Object.assign(debt("d1", "One", 100, "2026-01-01"), { updatedAt: t })] });
  const b = st({ debts: [Object.assign(debt("d1", "Two", 100, "2026-01-01"), { updatedAt: t })] });
  assert.equal(SC.canon(SC.merge(a, b)), SC.canon(SC.merge(b, a)));
});

test("merge: a removed debt stays removed unless it was edited after", () => {
  const d1 = debt("d1", "Card", 500, "2026-01-01", "2026-01-01T00:00:00.000Z");
  const removedSide = st({ debts: [], deleted: [{ id: "d1", at: "2026-02-01T00:00:00.000Z" }] });
  const oldSide = st({ debts: [d1] });
  assert.equal(SC.merge(oldSide, removedSide).debts.length, 0);
  assert.equal(SC.merge(removedSide, oldSide).debts.length, 0);
  const editedLater = st({ debts: [Object.assign({}, d1, { updatedAt: "2026-03-01T00:00:00.000Z" })] });
  assert.equal(SC.merge(removedSide, editedLater).debts.length, 1);
});

test("merge: order only keeps debts that still exist; last backup stays local", () => {
  const a = st({ debts: [debt("d1", "A", 1, "2026-01-01", "2026-01-01T00:00:00.000Z")], lastBackup: "2026-05-05T00:00:00.000Z" });
  const b = st({ debts: [debt("d1", "A", 1, "2026-01-01", "2026-01-01T00:00:00.000Z")], method: "custom", order: ["d1", "ghost"], settingsAt: "2026-04-01T00:00:00.000Z" });
  const m = SC.merge(a, b);
  assert.deepEqual(m.order, ["d1"]);
  assert.equal(m.lastBackup, "2026-05-05T00:00:00.000Z");
});
