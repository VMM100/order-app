// Tests for firestore.rules, run against the Firestore emulator (see .github/workflows/rules.yml).
import { readFileSync } from "node:fs";
import { test, before, beforeEach, after } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";

let env;
const DAY = 864e5;
const OWNER = { email: "owner@example.com", email_verified: true };
const MANAGER = { email: "mgr@example.com", email_verified: true };
const BOSS = { email: "boss@example.com", email_verified: true };   // the company (platform admin)
const anon = { firebase: { sign_in_provider: "anonymous" } };
const R = "restaurants/r1";

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-order-app",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

const PRICES = {
  "Pilsner|Full 400ml": { p: 10000, st: "bar" },
  "Fish & Chips|": { p: 21000, st: "kitchen" },
  "Chips|": { p: 3000, st: "kitchen" },
};
const account = (extra = {}) => ({ name: "Crafty Dee's", ownerEmail: "owner@example.com", status: "active", paidUntil: Date.now() + 30 * DAY, ...extra });
async function seedRestaurant(db, rid, acct) {
  await db.doc(`accounts/${rid}`).set(acct);
  await db.doc(`restaurants/${rid}`).set({ sections: [], waiters: [{ id: "w1", name: "Grace" }], shared: [6], prices: PRICES, brand: { name: acct.name } });
  for (const n of [4, 5, 6]) await db.doc(`restaurants/${rid}/tablekeys/${n}`).set({ k: "KEY" + n });
  await db.doc(`restaurants/${rid}/secrets/staff`).set({ token: "STAFFTOK" });
  await db.doc(`restaurants/${rid}/secrets/waiters`).set({ pins: { w1: "1111", w2: "2222" } });
}
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await seedRestaurant(db, "r1", account());
    await seedRestaurant(db, "r2", account({ name: "Other Bar", ownerEmail: "other@example.com" }));
    await db.doc(`${R}/admins/mgr@example.com`).set({ role: "manager", email: "mgr@example.com" });
    await db.doc("company/boss@example.com").set({ name: "Vandan" });
    await db.doc("meta/company").set({ by: "boss@example.com" });
  });
});
const setAccount = (patch, rid = "r1") => env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`accounts/${rid}`).update(patch));

const diner = (uid) => env.authenticatedContext(uid, anon).firestore();
const owner = () => env.authenticatedContext("owner", OWNER).firestore();
const manager = () => env.authenticatedContext("mgr", MANAGER).firestore();
const boss = () => env.authenticatedContext("boss", BOSS).firestore();
const newGroup = (sid, table, code) => ({ table, session: sid, code, opened: 1, waiter: null, people: {}, split: "order", paid: {}, open: true, label: null });

// The diner flow from the app: scan the QR (key pass), start the table's group, join it.
async function seatAt(uid, table = 4, sid = "4-a", code = "1234", rid = "r1") {
  const db = diner(uid), P = `restaurants/${rid}`, key = "KEY" + table;
  await db.doc(`${P}/passes/${uid}`).set({ table, via: "key", k: key, t: 1 });
  const b = db.batch();
  b.set(db.doc(`${P}/groups/${sid}`), newGroup(sid, table, code));
  b.set(db.doc(`${P}/tables/${table}`), { table, current: sid });
  b.set(db.doc(`${P}/codes/${code}`), { session: sid, table });
  b.set(db.doc(`${P}/passes/${uid}`), { table, via: "key", k: key, session: sid, t: 1 });
  await b.commit();
  await db.doc(`${P}/groups/${sid}`).update({ [`people.${uid}`]: { name: "Amani", t: 1, uid, acct: false }, label: "Amani" });
  return db;
}
const line = (uid, sid, extra = {}) => ({ table: 4, session: sid, batch: "b1", pid: uid, pname: "Amani", n: "Pilsner", v: "Full 400ml", pr: 10000, st: "bar", s: "new", t: 1, note: null, ...extra });
const staffPhone = async (uid = "s1", token = "STAFFTOK", rid = "r1") => {
  const db = env.authenticatedContext(uid, anon).firestore();
  await db.doc(`restaurants/${rid}/staff/${uid}`).set({ token, t: 1 });
  return db;
};
// A waiter's own phone, set up with the staff code, starting a shift with name and PIN.
const waiterPhone = async (uid = "s1", waiter = "w1", pin = "1111") => {
  const db = await staffPhone(uid);
  await db.doc(`${R}/staff/${uid}`).set({ token: "STAFFTOK", t: 1, waiter, pin, shift: Date.now() });
  return db;
};

// ---------- secrets stay secret ----------
test("nobody outside can read table keys, staff token, managers, accounts", async () => {
  const db = diner("x");
  await assertFails(db.doc(`${R}/tablekeys/4`).get());
  await assertFails(db.collection(`${R}/tablekeys`).get());
  await assertFails(db.doc(`${R}/secrets/staff`).get());
  await assertFails(db.collection(`${R}/admins`).get());
  await assertFails(db.collection(`${R}/codes`).get());
  await assertFails(db.collection(`${R}/groups`).get());
  await assertFails(db.doc("accounts/r1").get());
  await assertFails(db.collection("accounts").get());
  await assertFails(db.collection("company").get());
});
test("menu of a running restaurant is public, even before sign-in", async () => {
  await assertSucceeds(env.unauthenticatedContext().firestore().doc(R).get());
});
test("diners can't edit the menu or prices", async () => {
  await assertFails(diner("x").doc(R).update({ prices: { "Pilsner|Full 400ml": { p: 1, st: "bar" } } }));
});

// ---------- joining a table ----------
test("wrong table key gives no pass", async () => {
  await assertFails(diner("d1").doc(`${R}/passes/d1`).set({ table: 4, via: "key", k: "GUESS", t: 1 }));
  await assertFails(diner("d1").doc(`${R}/passes/d1`).set({ table: 4, via: "key", k: "KEY5", t: 1 }));
});
test("right table key: start group, join, order at menu price", async () => {
  const db = await seatAt("d1");
  await assertSucceeds(db.doc(`${R}/lines/l1`).set(line("d1", "4-a")));
  await assertSucceeds(db.collection(`${R}/lines`).where("session", "==", "4-a").get());
  await assertSucceeds(db.doc(`${R}/groups/4-a`).get());
});
test("a big order (10 items) in one go", async () => {
  const db = await seatAt("d1");
  const b = db.batch();
  for (let i = 0; i < 10; i++) b.set(db.doc(`${R}/lines/m${i}`), line("d1", "4-a", { n: i % 2 ? "Chips" : "Fish & Chips", v: "", pr: i % 2 ? 3000 : 21000, st: "kitchen" }));
  await assertSucceeds(b.commit());
});
test("can't change the price, station, or order for someone else", async () => {
  const db = await seatAt("d1");
  await assertFails(db.doc(`${R}/lines/l1`).set(line("d1", "4-a", { pr: 1 })));
  await assertFails(db.doc(`${R}/lines/l2`).set(line("d1", "4-a", { st: "kitchen" })));
  await assertFails(db.doc(`${R}/lines/l3`).set(line("d1", "4-a", { pid: "someone" })));
  await assertFails(db.doc(`${R}/lines/l4`).set(line("d1", "4-a", { n: "Free beer", v: "" })));
  await assertFails(db.doc(`${R}/lines/l5`).set(line("d1", "4-a", { s: "served" })));
});
test("must join before ordering", async () => {
  const db = diner("d1");
  await db.doc(`${R}/passes/d1`).set({ table: 4, via: "key", k: "KEY4", t: 1 });
  const b = db.batch();
  b.set(db.doc(`${R}/groups/4-a`), newGroup("4-a", 4, "1234"));
  b.set(db.doc(`${R}/passes/d1`), { table: 4, via: "key", k: "KEY4", session: "4-a", t: 1 });
  await b.commit();
  await assertFails(db.doc(`${R}/lines/l1`).set(line("d1", "4-a")));
});
test("a key for table 4 can't start a group at table 5", async () => {
  const db = diner("d1");
  await db.doc(`${R}/passes/d1`).set({ table: 4, via: "key", k: "KEY4", t: 1 });
  await assertFails(db.doc(`${R}/groups/5-a`).set(newGroup("5-a", 5, "5555")));
});
test("second diner scanning the same table joins the same group", async () => {
  await seatAt("d1");
  const db = diner("d2");
  await assertSucceeds(db.doc(`${R}/passes/d2`).set({ table: 4, via: "key", k: "KEY4", t: 1 }));
  await assertSucceeds(db.doc(`${R}/tables/4`).get());
  await assertSucceeds(db.doc(`${R}/passes/d2`).set({ table: 4, via: "key", k: "KEY4", session: "4-a", t: 1 }));
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ "people.d2": { name: "Neha", t: 2, uid: "d2", acct: false } }));
  await assertSucceeds(db.doc(`${R}/lines/l2`).set(line("d2", "4-a", { pname: "Neha" })));
});
test("the app's table transaction: read table, start group, move pass, all in one", async () => {
  const db = diner("t1");
  await db.doc(`${R}/passes/t1`).set({ table: 4, via: "key", k: "KEY4", t: 1 });
  await assertSucceeds(db.runTransaction(async (tx) => {
    const ts = await tx.get(db.doc(`${R}/tables/4`));
    if (ts.exists) throw new Error("expected an empty table");
    tx.set(db.doc(`${R}/groups/4-t`), newGroup("4-t", 4, "4321"));
    tx.set(db.doc(`${R}/tables/4`), { table: 4, current: "4-t" });
    tx.set(db.doc(`${R}/codes/4321`), { session: "4-t", table: 4 });
    tx.set(db.doc(`${R}/passes/t1`), { table: 4, via: "key", k: "KEY4", session: "4-t", t: 2 });
  }));
});

// ---------- friend's invite code ----------
// A friend with the code asks to join; someone already at the table lets them in.
const ask = (uid, name = "Juma", sid = "4-a", table = 4) => ({ session: sid, table, name, t: 1, ok: false });
const letIn = (by) => ({ ok: true, by, at: 2 });
test("friend with the code can join and order once the table lets them in", async () => {
  const d1 = await seatAt("d1");
  const db = diner("f1");
  const c = await assertSucceeds(db.doc(`${R}/codes/1234`).get());
  await assertSucceeds(db.doc(`${R}/passes/f1`).set({ table: 4, via: "code", c: "1234", session: c.data().session, t: 1 }));
  await assertSucceeds(db.doc(`${R}/joins/f1`).set(ask("f1")));
  await assertSucceeds(d1.doc(`${R}/joins/f1`).update(letIn("d1")));
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ "people.f1": { name: "Juma", t: 3, uid: "f1", acct: false } }));
  await assertSucceeds(db.doc(`${R}/lines/f`).set(line("f1", "4-a", { pname: "Juma" })));
  await assertSucceeds(db.doc(`${R}/alerts/a1`).set({ table: 4, session: "4-a", type: "call", pid: "f1", pname: "Juma", t: 1, ack: null, ackBy: null, done: false }));
});
test("a guessed code alone gets nowhere: no names, orders, ordering or calls until the table says yes", async () => {
  const d1 = await seatAt("d1");
  await d1.doc(`${R}/lines/l1`).set(line("d1", "4-a"));
  const db = diner("x1");
  await assertSucceeds(db.doc(`${R}/passes/x1`).set({ table: 4, via: "code", c: "1234", session: "4-a", t: 1 }));
  await assertSucceeds(db.doc(`${R}/joins/x1`).set(ask("x1", "Stranger")));
  await assertFails(db.doc(`${R}/groups/4-a`).get());
  await assertFails(db.doc(`${R}/lines/l1`).get());
  await assertFails(db.collection(`${R}/lines`).where("session", "==", "4-a").get());
  await assertFails(db.collection(`${R}/alerts`).where("session", "==", "4-a").get());
  await assertFails(db.doc(`${R}/groups/4-a`).update({ "people.x1": { name: "Stranger", t: 3, uid: "x1", acct: false } }));
  await assertFails(db.doc(`${R}/lines/x`).set(line("x1", "4-a", { pname: "Stranger" })));
  await assertFails(db.doc(`${R}/alerts/x`).set({ table: 4, session: "4-a", type: "call", pid: "x1", pname: "Stranger", t: 1, ack: null, ackBy: null, done: false }));
  // Can't let themselves in, and can't see other people's requests.
  await assertFails(db.doc(`${R}/joins/x1`).update(letIn("x1")));
  await assertFails(db.doc(`${R}/joins/x1`).set({ ...ask("x1"), ok: true }));
  await assertFails(db.collection(`${R}/joins`).where("session", "==", "4-a").get());
  // Saying no keeps them out.
  await assertSucceeds(d1.doc(`${R}/joins/x1`).update({ no: true, by: "d1", at: 2 }));
  await assertFails(db.doc(`${R}/groups/4-a`).get());
});
test("who can answer a join request: people at that table and staff, not other tables or strangers", async () => {
  const d1 = await seatAt("d1");
  await seatAt("e1", 5, "5-a", "5555");
  const f = diner("f1");
  await f.doc(`${R}/passes/f1`).set({ table: 4, via: "code", c: "1234", session: "4-a", t: 1 });
  await f.doc(`${R}/joins/f1`).set(ask("f1"));
  await assertSucceeds(d1.collection(`${R}/joins`).where("session", "==", "4-a").get());
  await assertFails(diner("e1").doc(`${R}/joins/f1`).update(letIn("e1")));          // another table
  await assertFails(diner("zz").doc(`${R}/joins/f1`).update(letIn("zz")));          // a stranger
  await assertFails(d1.doc(`${R}/joins/f1`).update({ ...letIn("d1"), name: "Boss" })); // only the answer changes
  await assertFails(d1.doc(`${R}/joins/f1`).update(letIn("someone-else")));         // signed as themselves
  const w = await staffPhone("s1");
  await assertSucceeds(w.doc(`${R}/joins/f1`).update({ ok: true, by: "s1", at: 2 }));
});
test("a join request needs a code pass for that group, a first name, and the group still open", async () => {
  await seatAt("d1");
  const f = diner("f1");
  await assertFails(f.doc(`${R}/joins/f1`).set(ask("f1")));                         // no pass yet
  await f.doc(`${R}/passes/f1`).set({ table: 4, via: "code", c: "1234", session: "4-a", t: 1 });
  await assertFails(f.doc(`${R}/joins/f1`).set(ask("f1", "")));
  await assertFails(f.doc(`${R}/joins/f1`).set(ask("f1", "A name far too long for a table")));
  await assertFails(f.doc(`${R}/joins/f1`).set(ask("f1", "Juma", "4-zzz")));
  await assertFails(f.doc(`${R}/joins/f2`).set(ask("f2")));                         // only their own request
  await assertSucceeds(f.doc(`${R}/joins/f1`).set(ask("f1")));
});
test("wrong code, or a code for another group, gives no pass", async () => {
  await seatAt("d1");
  await assertFails(diner("f1").doc(`${R}/passes/f1`).set({ table: 4, via: "code", c: "9999", session: "4-a", t: 1 }));
  await assertFails(diner("f1").doc(`${R}/passes/f1`).set({ table: 4, via: "code", c: "1234", session: "4-zzz", t: 1 }));
});
test("closed group's code stops working; its leftover code can be reused", async () => {
  await seatAt("d1");
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`${R}/groups/4-a`).update({ open: false }));
  await assertFails(diner("f1").doc(`${R}/passes/f1`).set({ table: 4, via: "code", c: "1234", session: "4-a", t: 1 }));
  await assertSucceeds(seatAt("d9", 4, "4-b", "1234"));
});
test("an open group's code can't be taken over", async () => {
  await seatAt("d1");
  await assertFails(seatAt("d9", 5, "5-a", "1234"));
});

// ---------- outsiders and other restaurants ----------
test("someone without a pass sees nothing", async () => {
  await seatAt("d1");
  const db = diner("x");
  await assertFails(db.doc(`${R}/groups/4-a`).get());
  await assertFails(db.collection(`${R}/lines`).where("session", "==", "4-a").get());
  await assertFails(db.doc(`${R}/lines/l9`).set(line("x", "4-a", { pid: "x" })));
});
test("a pass at one restaurant means nothing at another", async () => {
  await seatAt("d1");
  const db = diner("d1");
  await assertFails(db.doc("restaurants/r2/groups/4-a").get());
  await assertFails(db.doc("restaurants/r2/passes/d1").set({ table: 4, via: "key", k: "nope", t: 1 }));
});
test("staff of one restaurant can't see another's orders", async () => {
  await seatAt("d1", 4, "4-x", "7777", "r2");
  const s = await staffPhone("s1", "STAFFTOK", "r1");
  await assertFails(s.collection("restaurants/r2/lines").where("s", "==", "new").get());
  await assertFails(s.doc("restaurants/r2/groups/4-x").update({ waiter: "w1" }));
});

// ---------- what diners can and can't change ----------
test("diners can choose the split but not mark paid, assign a waiter or close", async () => {
  const db = await seatAt("d1");
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ split: "equal" }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ "paid.d1": true }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ waiter: "w1" }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ open: false }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ label: "Hacker" }));
});
test("diners can't remove someone else or fake a waiter's reply", async () => {
  const db = await seatAt("d1");
  await assertFails(db.doc(`${R}/groups/4-a`).update({ "people.zz": { name: "Ghost", t: 1, uid: "zz", acct: false } }));
  await assertFails(db.doc(`${R}/alerts/a1`).set({ table: 4, session: "4-a", type: "bill", pid: "d1", pname: "Amani", t: 1, ack: 5, ackBy: "w1", done: false }));
  await db.doc(`${R}/lines/l1`).set(line("d1", "4-a"));
  await assertFails(db.doc(`${R}/lines/l1`).update({ s: "served" }));
});
test("shared table: QR holder may see the groups there", async () => {
  await seatAt("d1", 6, "6-a", "6666");
  const db = diner("d2");
  await db.doc(`${R}/passes/d2`).set({ table: 6, via: "key", k: "KEY6", t: 1 });
  await assertSucceeds(db.collection(`${R}/groups`).where("table", "==", 6).get());
  await assertFails(db.collection(`${R}/groups`).where("table", "==", 4).get());
});

// ---------- staff phones ----------
test("staff link with the wrong token is refused", async () => {
  await assertFails(staffPhone("s1", "nope"));
});
test("staff phone: sees orders, moves them along, can't change prices", async () => {
  const d = await seatAt("d1"); await d.doc(`${R}/lines/l1`).set(line("d1", "4-a"));
  const db = await staffPhone();
  await assertSucceeds(db.collection(`${R}/lines`).where("s", "in", ["new", "preparing", "ready"]).get());
  await assertSucceeds(db.collection(`${R}/groups`).where("open", "==", true).get());
  await assertSucceeds(db.doc(`${R}/lines/l1`).update({ s: "preparing", tPrep: 2 }));
  await assertFails(db.doc(`${R}/lines/l1`).update({ pr: 0 }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ waiter: "w1", accepted: 3 }));
  await assertFails(db.doc(`${R}/tablekeys/4`).get());
  await assertFails(db.doc(R).update({ waiters: [] }));
  await assertFails(db.collection(`${R}/sessions`).get());
});
test("waiter closes a busy table in one go, saving a visit", async () => {
  const d = await seatAt("d1");
  const ids = [];
  for (let i = 0; i < 12; i++) { ids.push("c" + i); await d.doc(`${R}/lines/c` + i).set(line("d1", "4-a")); }
  await d.doc(`${R}/alerts/a1`).set({ table: 4, session: "4-a", type: "bill", pid: "d1", pname: "Amani", t: 1, ack: null, ackBy: null, done: false });
  const db = await waiterPhone();
  const b = db.batch();
  ids.forEach((id) => b.update(db.doc(`${R}/lines/` + id), { s: "served", closedUnserved: true }));
  b.update(db.doc(`${R}/alerts/a1`), { done: true, doneAt: 9 });
  b.set(db.doc(`${R}/sessions/4-a`), { table: 4, session: "4-a", closed: 9, total: 120000 });
  b.update(db.doc(`${R}/groups/4-a`), { open: false, closed: 9 });
  b.delete(db.doc(`${R}/codes/1234`));
  b.set(db.doc("visits/d1_4-a"), { uid: "d1", rid: "r1", session: "4-a", date: 9, items: [], share: 0 });
  await assertSucceeds(b.commit());
});
test("staff can't save a visit for a restaurant they don't work at", async () => {
  const db = await staffPhone();
  await assertFails(db.doc("visits/fake").set({ uid: "d1", rid: "r2", date: 9 }));
});
test("making a new staff code signs out old staff phones", async () => {
  const db = await staffPhone();
  await assertSucceeds(db.collection(`${R}/lines`).where("s", "==", "new").get());
  await assertSucceeds(owner().doc(`${R}/secrets/staff`).set({ token: "NEWTOK" }));
  await assertFails(db.collection(`${R}/lines`).where("s", "==", "new").get());
});

// ---------- owner and manager ----------
test("manager edits menu and staff, not the look or the managers list", async () => {
  const db = manager();
  await assertSucceeds(db.doc(R).update({ waiters: [{ id: "w2", name: "Baraka" }], prices: PRICES, updated: 2 }));
  await assertFails(db.doc(R).update({ brand: { name: "Mine" } }));
  await assertFails(db.doc(`${R}/admins/new@example.com`).set({ role: "manager", email: "new@example.com" }));
  await assertSucceeds(db.doc(`${R}/tablekeys/4`).get());
  await assertSucceeds(db.doc("accounts/r1").get());
});
test("owner changes the look and adds a manager, but not another owner", async () => {
  const db = owner();
  await assertSucceeds(db.doc(R).update({ brand: { name: "Dee's Beer Garden" } }));
  await assertSucceeds(db.doc(`${R}/admins/new@example.com`).set({ role: "manager", email: "new@example.com", by: "owner@example.com", t: 1 }));
  await assertFails(db.doc(`${R}/admins/x@example.com`).set({ role: "owner", email: "x@example.com" }));
  await assertSucceeds(db.collection(`${R}/sessions`).get());
});
test("managers find the restaurants they help run", async () => {
  await assertSucceeds(manager().collectionGroup("admins").where("email", "==", "mgr@example.com").get());
  await assertFails(manager().collectionGroup("admins").where("email", "==", "owner@example.com").get());
});
test("an owner of one restaurant has no say at another", async () => {
  await assertFails(owner().doc("restaurants/r2").update({ brand: { name: "Mine" } }));
  await assertFails(owner().doc("restaurants/r2/tablekeys/4").get());
  await assertFails(owner().doc("accounts/r2").get());
});
test("unverified email isn't trusted", async () => {
  const db = env.authenticatedContext("fake", { email: "owner@example.com", email_verified: false }).firestore();
  await assertFails(db.doc(`${R}/secrets/staff`).get());
  await assertFails(db.doc("accounts/r1").get());
});

// ---------- subscriptions ----------
test("owners can't extend their own subscription or change their status", async () => {
  await assertFails(owner().doc("accounts/r1").update({ paidUntil: Date.now() + 365 * DAY }));
  await assertFails(owner().doc("accounts/r1").update({ status: "active" }));
  await assertFails(owner().doc("accounts/r1").update({ ownerEmail: "friend@example.com" }));
});
test("grace week: 3 days past paid-until, everything still works", async () => {
  await setAccount({ paidUntil: Date.now() - 3 * DAY });
  const db = await seatAt("d1");
  await assertSucceeds(db.doc(`${R}/lines/l1`).set(line("d1", "4-a")));
  await assertSucceeds(staffPhone());
  await assertSucceeds(owner().doc(R).update({ brand: { name: "Still here" } }));
});
test("more than 7 days unpaid: diners, staff and managers are blocked; owner can still look", async () => {
  const d = await seatAt("d1");
  const s = await staffPhone();
  await setAccount({ paidUntil: Date.now() - 8 * DAY });
  await assertFails(d.doc(`${R}/lines/l1`).set(line("d1", "4-a")));
  await assertFails(diner("d2").doc(`${R}/passes/d2`).set({ table: 4, via: "key", k: "KEY4", t: 1 }));
  await assertFails(env.unauthenticatedContext().firestore().doc(R).get());
  await assertFails(s.collection(`${R}/lines`).where("s", "==", "new").get());
  await assertFails(manager().doc(R).update({ waiters: [] }));
  await assertFails(owner().doc(R).update({ brand: { name: "x" } }));
  await assertSucceeds(owner().doc("accounts/r1").get());
  await assertSucceeds(owner().doc(R).get());
});
test("suspended: blocked straight away", async () => {
  const d = await seatAt("d1");
  await setAccount({ status: "suspended" });
  await assertFails(d.doc(`${R}/lines/l1`).set(line("d1", "4-a")));
  await assertFails(staffPhone());
});
test("the company records a payment and the restaurant runs again", async () => {
  await setAccount({ status: "suspended", paidUntil: Date.now() - 20 * DAY });
  await assertSucceeds(boss().doc("accounts/r1").update({ status: "active", paidUntil: Date.now() + 30 * DAY }));
  await assertSucceeds(env.unauthenticatedContext().firestore().doc(R).get());
  await assertSucceeds(seatAt("d1"));
});
test("the company changes the owner: old owner out, new owner in", async () => {
  await assertSucceeds(boss().doc("accounts/r1").update({ ownerEmail: "new@example.com" }));
  await assertFails(owner().doc(R).update({ brand: { name: "Old owner" } }));
  const n = env.authenticatedContext("n", { email: "new@example.com", email_verified: true }).firestore();
  await assertSucceeds(n.doc(R).update({ brand: { name: "New owner" } }));
  await assertSucceeds(n.doc(`${R}/secrets/staff`).get());
});
test("the company can see and help at any restaurant", async () => {
  await assertSucceeds(boss().collection("accounts").get());
  await assertSucceeds(boss().doc("restaurants/r2/tablekeys/4").get());
  await assertSucceeds(boss().doc("restaurants/r2").update({ brand: { name: "Fixed" } }));
});

// ---------- signing up ----------
const applicant = () => env.authenticatedContext("a1", { email: "newbar@example.com", email_verified: true }).firestore();
const application = (extra = {}) => ({ name: "New Bar", ownerEmail: "newbar@example.com", ownerName: "Asha", phone: "0700", area: "Masaki", tables: 12, status: "pending", created: 1, ...extra });
test("a restaurant applies and waits; it can't approve itself", async () => {
  const db = applicant();
  await assertSucceeds(db.doc("accounts/new-bar-x1").set(application()));
  await assertSucceeds(db.collection("accounts").where("ownerEmail", "==", "newbar@example.com").get());
  await assertFails(db.doc("accounts/new-bar-x1").update({ status: "active" }));
  await assertFails(db.doc("restaurants/new-bar-x1").set({ sections: [] }));
  await assertFails(db.doc("accounts/new-bar-x2").set(application({ status: "active", paidUntil: Date.now() + 365 * DAY })));
  await assertFails(db.doc("accounts/new-bar-x3").set(application({ ownerEmail: "someone@example.com" })));
  await assertFails(db.doc("accounts/r1").set(application()));
  await assertFails(env.authenticatedContext("a2", anon).firestore().doc("accounts/anon-bar").set(application()));
});
test("once approved, the new owner sets up their restaurant", async () => {
  await applicant().doc("accounts/new-bar-x1").set(application());
  await assertSucceeds(boss().doc("accounts/new-bar-x1").update({ status: "active", paidUntil: Date.now() + 60 * DAY }));
  const db = applicant();
  await assertSucceeds(db.doc("restaurants/new-bar-x1").set({ sections: [], waiters: [], prices: {}, brand: { name: "New Bar" } }));
  await assertSucceeds(db.doc("restaurants/new-bar-x1/secrets/staff").set({ token: "T" }));
  await assertSucceeds(db.doc("restaurants/new-bar-x1/tablekeys/1").set({ k: "K1" }));
});

// ---------- the company itself ----------
test("first sign-in claims the company page; nobody can claim it again", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc("meta/company").delete(); await ctx.firestore().doc("company/boss@example.com").delete(); });
  const first = env.authenticatedContext("u1", { email: "first@example.com", email_verified: true }).firestore();
  const b = first.batch();
  b.set(first.doc("company/first@example.com"), { name: "First", t: 1 });
  b.set(first.doc("meta/company"), { by: "first@example.com" });
  await assertSucceeds(b.commit());
  const second = env.authenticatedContext("u2", { email: "second@example.com", email_verified: true }).firestore();
  const b2 = second.batch();
  b2.set(second.doc("company/second@example.com"), { name: "Second", t: 1 });
  b2.set(second.doc("meta/company"), { by: "second@example.com" });
  await assertFails(b2.commit());
  await assertFails(second.doc("company/second@example.com").set({ name: "Second", t: 1 }));
  await assertSucceeds(first.doc("company/partner@example.com").set({ name: "Partner", by: "first@example.com", t: 1 }));
});

// ---------- diner accounts ----------
test("diners read only their own visits and profile", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc("visits/a").set({ uid: "g1", rid: "r1", date: 1 });
    await ctx.firestore().doc("visits/b").set({ uid: "g2", rid: "r1", date: 1 });
  });
  const db = env.authenticatedContext("g1", { phone_number: "+255700000000" }).firestore();
  await assertSucceeds(db.collection("visits").where("uid", "==", "g1").get());
  await assertFails(db.collection("visits").where("uid", "==", "g2").get());
  await assertSucceeds(db.doc("diners/g1").set({ name: "Amani" }));
  await assertFails(db.doc("diners/g2").get());
  await assertFails(db.doc("visits/c").set({ uid: "g1", rid: "r1", date: 1 }));
});
test("owner's Setup reset can clear codes and passes; diners can't", async () => {
  await seatAt("d1");
  await assertFails(diner("d1").doc(`${R}/codes/1234`).delete());
  const db = owner();
  const b = db.batch();
  (await db.collection(`${R}/passes`).get()).docs.forEach((d) => b.delete(d.ref));
  (await db.collection(`${R}/codes`).get()).docs.forEach((d) => b.delete(d.ref));
  await assertSucceeds(b.commit());
});
test("payment history: the company records it, the owner can read it, nobody edits it", async () => {
  await assertSucceeds(boss().doc("accounts/r1/payments/p1").set({ amount: 130000, months: 1, until: 2, by: "boss@example.com", t: 1 }));
  await assertSucceeds(owner().doc("accounts/r1/payments/p1").get());
  await assertFails(owner().doc("accounts/r1/payments/p2").set({ amount: 0, months: 12 }));
  await assertFails(boss().doc("accounts/r1/payments/p1").update({ amount: 1 }));
  await assertFails(diner("x").doc("accounts/r1/payments/p1").get());
});
test("manager can change the number of tables", async () => {
  await assertSucceeds(manager().doc(R).update({ tables: 12, updated: 3 }));
});

// ---------- waiter shifts ----------
test("a waiter starts a shift with the right PIN, not a wrong one", async () => {
  const db = await staffPhone();
  await assertFails(db.doc(`${R}/staff/s1`).set({ token: "STAFFTOK", t: 1, waiter: "w1", pin: "0000", shift: Date.now() }));
  await assertFails(db.doc(`${R}/staff/s1`).set({ token: "STAFFTOK", t: 1, waiter: "w1", pin: "2222", shift: Date.now() }));
  await assertFails(db.doc(`${R}/staff/s1`).set({ token: "STAFFTOK", t: 1, waiter: "w9", pin: "", shift: Date.now() }));
  await assertFails(db.doc(`${R}/staff/s1`).set({ token: "STAFFTOK", t: 1, waiter: "w1", pin: "1111", shift: Date.now() + 864e5 }));
  await assertSucceeds(db.doc(`${R}/staff/s1`).set({ token: "STAFFTOK", t: 1, waiter: "w1", pin: "1111", shift: Date.now() }));
  await assertFails(db.doc(`${R}/secrets/waiters`).get());
});
test("on shift, a waiter takes tables, answers alerts and serves, as themselves only", async () => {
  const d = await seatAt("d1"); await d.doc(`${R}/lines/l1`).set(line("d1", "4-a"));
  await d.doc(`${R}/alerts/a1`).set({ table: 4, session: "4-a", type: "call", pid: "d1", pname: "Amani", t: 1, ack: null, ackBy: null, done: false });
  const db = await waiterPhone();
  await assertFails(db.doc(`${R}/groups/4-a`).update({ waiter: "w2", accepted: 3 }));
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ waiter: "w1", accepted: 3 }));
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ "paid.d1": true }));
  await assertFails(db.doc(`${R}/alerts/a1`).update({ ack: 5, ackBy: "w2" }));
  await assertSucceeds(db.doc(`${R}/alerts/a1`).update({ ack: 5, ackBy: "w1" }));
  await assertFails(db.doc(`${R}/lines/l1`).update({ s: "served", tServed: 6, servedBy: "w2" }));
  await assertSucceeds(db.doc(`${R}/lines/l1`).update({ s: "served", tServed: 6, servedBy: "w1" }));
});
test("a waiter can't hand back another waiter's table", async () => {
  await seatAt("d1");
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`${R}/groups/4-a`).update({ waiter: "w2" }));
  const db = await waiterPhone();
  await assertFails(db.doc(`${R}/groups/4-a`).update({ waiter: null }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ waiter: "w1" }));
});
test("kitchen phone (no shift) marks items ready but can't serve or take tables", async () => {
  const d = await seatAt("d1"); await d.doc(`${R}/lines/l1`).set(line("d1", "4-a"));
  const k = await staffPhone("k1");
  await assertSucceeds(k.doc(`${R}/lines/l1`).update({ s: "ready", tReady: 2, tPrep: 1 }));
  await assertFails(k.doc(`${R}/lines/l1`).update({ s: "served", tServed: 3, servedBy: "w1" }));
  await assertFails(k.doc(`${R}/groups/4-a`).update({ waiter: "w1" }));
});
test("ending a shift, an old shift, or a changed PIN stops waiter actions", async () => {
  await seatAt("d1");
  const db = await waiterPhone();
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ split: "equal" }));
  await assertSucceeds(db.doc(`${R}/staff/s1`).set({ token: "STAFFTOK", t: 2 }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ split: "order" }));
  await waiterPhone();
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`${R}/staff/s1`).update({ shift: Date.now() - 17 * 3600e3 }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ split: "order" }));
  await waiterPhone();
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ split: "order" }));
  await assertSucceeds(owner().doc(`${R}/secrets/waiters`).set({ pins: { w1: "9999", w2: "2222" } }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ split: "equal" }));
});
test("owner and managers set waiter PINs; the owner can work as any waiter", async () => {
  await assertSucceeds(manager().doc(`${R}/secrets/waiters`).set({ pins: { w1: "4321" } }));
  await assertSucceeds(owner().doc(`${R}/secrets/waiters`).get());
  await seatAt("d1");
  await assertSucceeds(owner().doc(`${R}/groups/4-a`).update({ waiter: "w2" }));
});

// ---------- proof of consent to offers ----------
test("a diner logs consent to offers; nobody can change or read someone else's log", async () => {
  const db = env.authenticatedContext("p1", { phone_number: "+255748227000" }).firestore();
  const entry = { rid: "r1", rname: "Crafty Dee's", on: true, channel: "whatsapp", phone: "+255748227000", text: "Send me Crafty Dee's offers…", version: "2026-10-22", source: "My account", at: Date.now() };
  await assertSucceeds(db.doc("diners/p1/consents/c1").set(entry));
  await assertFails(db.doc("diners/p1/consents/c1").update({ on: false }));
  await assertFails(db.doc("diners/p1/consents/c2").set({ ...entry, at: Date.now() - 864e5 }));
  await assertFails(db.doc("diners/p1/consents/c3").set({ ...entry, extra: 1 }));
  await assertFails(env.authenticatedContext("p2", { phone_number: "+255700000000" }).firestore().doc("diners/p1/consents/c1").get());
  await assertFails(owner().doc("diners/p1/consents/c1").get());
  await assertSucceeds(db.doc("diners/p1/consents/c1").delete());
});

test("the company can remove who claimed it from the public marker; nobody else can change it", async () => {
  await assertFails(diner("x").doc("meta/company").set({ claimed: true, t: 1 }));
  await assertFails(owner().doc("meta/company").set({ claimed: true, t: 1 }));
  await assertFails(boss().doc("meta/company").set({ claimed: true, t: 1, by: "boss@example.com" }));
  await assertSucceeds(boss().doc("meta/company").set({ claimed: true, t: 1 }));
  await assertSucceeds(env.unauthenticatedContext().firestore().doc("meta/company").get());
});

// ---------- live demo rooms (demo/ folder of the site) ----------
const room = (created = Date.now()) => ({ created, sections: [], waiters: [{ id: "w1", name: "Grace" }], shared: [], brand: { name: "Crafty Dee's" }, prices: PRICES, tables: 10, updated: created });
test("demo: only the company team can start a room", async () => {
  await assertFails(diner("p1").doc("demo/roomx").set(room()));
  await assertFails(owner().doc("demo/roomx").set(room()));
});
test("demo: the company presenter makes a room with its table key in one go", async () => {
  const db = boss(), b = db.batch();
  b.set(db.doc("demo/room1"), room());
  b.set(db.doc("demo/room1/tablekeys/8"), { k: "K", t: 1 });
  await assertSucceeds(b.commit());
  await assertSucceeds(db.doc("demo/room1").get());
});
test("demo: anyone in the room can order, serve and edit the menu; created can't change", async () => {
  await assertSucceeds(boss().doc("demo/room2").set(room()));
  const d = diner("d1");
  await assertSucceeds(d.doc("demo/room2/passes/d1").set({ table: 8, via: "key", k: "K", t: 1 }));
  await assertSucceeds(d.doc("demo/room2/groups/8-a").set(newGroup("8-a", 8, "4321")));
  await assertSucceeds(d.doc("demo/room2/lines/l1").set({ table: 8, session: "8-a", n: "Pilsner", v: "Full 400ml", pr: 10000, st: "bar", s: "new", t: 1 }));
  await assertSucceeds(diner("w").doc("demo/room2/staff/w").set({ token: "demo", waiter: "w1", pin: "0000", shift: Date.now(), t: 1 }));
  await assertSucceeds(diner("o").doc("demo/room2").set({ sections: [], updated: 2 }, { merge: true }));
  await assertFails(diner("o").doc("demo/room2").update({ created: 1 }));
});
test("demo: needs the quiet sign-in, and goes read-only after 12 hours", async () => {
  await assertFails(env.unauthenticatedContext().firestore().doc("demo/room3").set(room()));
  await assertFails(boss().doc("demo/room3").set(room(Date.now() - 2 * DAY)));   // can't backdate a room
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc("demo/old").set(room(Date.now() - 13 * 3600e3)));
  await assertSucceeds(diner("d1").doc("demo/old").get());
  await assertFails(diner("d1").doc("demo/old/lines/l1").set({ table: 8 }));
  await assertFails(diner("d1").doc("demo/old").set({ updated: 3 }, { merge: true }));
});
test("demo: rooms can't be listed by visitors, and writes are capped", async () => {
  await assertSucceeds(boss().doc("demo/room4").set(room()));
  await assertFails(diner("d1").collection("demo").get());
  await assertSucceeds(diner("d1").doc("demo/room4").get());
  await assertSucceeds(boss().collection("demo").get());
  const big = Object.fromEntries(Array.from({ length: 41 }, (_, i) => ["k" + i, i]));
  await assertFails(diner("d1").doc("demo/room4/lines/x").set(big));
  await assertFails(diner("d1").doc("demo/room4").set(big, { merge: true }));
});
test("demo: a room's table code goes in the shared code book, so the main scanner finds it", async () => {
  await assertSucceeds(boss().doc("demo/room5").set(room()));
  const d = diner("d1"), b = d.batch();
  b.set(d.doc("demo/room5/groups/8-a"), newGroup("8-a", 8, "4321"));
  b.set(d.doc("demo/room5/codes/4321"), { session: "8-a", table: 8 });
  b.set(d.doc("invites/4321"), { demo: "room5" });
  await assertSucceeds(b.commit());
  const hit = await assertSucceeds(diner("f1").doc("invites/4321").get());
  if (hit.data().demo !== "room5") throw new Error("invite should point at the room");
  // Not without the code itself, not for a closed room, not with extra fields.
  await assertFails(d.doc("invites/9876").set({ demo: "room5" }));
  await assertFails(d.doc("invites/4321").set({ demo: "room5", rid: "r1" }));
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc("demo/oldroom").set(room(Date.now() - 13 * 3600e3)); await ctx.firestore().doc("demo/oldroom/codes/5555").set({ session: "8-z", table: 8 }); });
  await assertFails(d.doc("invites/5555").set({ demo: "oldroom" }));
});
test("demo: a room can't take over a code a real restaurant table is using, and vice versa", async () => {
  await seatAt("d1");   // restaurant r1, code 1234, open
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc("invites/1234").set({ rid: "r1" }));
  await assertSucceeds(boss().doc("demo/room6").set(room()));
  const d = diner("d2"), b = d.batch();
  b.set(d.doc("demo/room6/codes/1234"), { session: "8-a", table: 8 });
  b.set(d.doc("invites/1234"), { demo: "room6" });
  await assertFails(b.commit());
  // A demo room's open code can't be taken over by a restaurant either.
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc("demo/room6/codes/2468").set({ session: "8-b", table: 8 }); await ctx.firestore().doc("invites/2468").set({ demo: "room6" }); });
  const r = await seatAt("d3", 5, "5-a", "2468");
  await assertFails(r.doc("invites/2468").set({ rid: "r1" }));
});
test("demo: only the company can end a room; after that nothing in it changes", async () => {
  await assertSucceeds(boss().doc("demo/room7").set(room()));
  const d = diner("d1");
  await assertSucceeds(d.doc("demo/room7/groups/8-a").set(newGroup("8-a", 8, "1357")));
  await assertSucceeds(d.doc("demo/room7/codes/1357").set({ session: "8-a", table: 8 }));
  await assertFails(d.doc("demo/room7").update({ ended: 1 }));                     // a visitor can't end it
  const co = boss(), b = co.batch();
  b.update(co.doc("demo/room7/groups/8-a"), { open: false, closed: 2 });
  b.delete(co.doc("demo/room7/codes/1357"));
  b.update(co.doc("demo/room7"), { ended: 2 });
  await assertSucceeds(b.commit());
  await assertFails(d.doc("demo/room7/lines/l1").set({ table: 8, session: "8-a", n: "Pilsner", s: "new", t: 1 }));
  await assertFails(d.doc("demo/room7").update({ updated: 3 }));
  await assertFails(boss().doc("demo/room7").update({ ended: null }));
  await assertSucceeds(d.doc("demo/room7").get());                                 // screens can still see it ended
});
test("demo: a room can't reach real restaurants", async () => {
  await assertSucceeds(boss().doc("demo/room4").set(room()));
  await assertFails(diner("p1").doc(`${R}/lines/x`).set({ table: 4 }));
  await assertFails(diner("p1").doc(`${R}/secrets/staff`).get());
});

// ---------- ringing staff phones (push) ----------
const push = (extra = {}) => ({ token: "fcm-token-abc", t: 1, url: "https://wasabi.co.tz/?r=r1#waiter", ...extra });
test("push: a staff phone saves its own push address, nobody else can read or forge it", async () => {
  const s = await staffPhone("s1");
  await assertSucceeds(s.doc(`${R}/push/s1`).set(push()));
  await assertSucceeds(s.doc(`${R}/push/s1`).get());
  await assertFails(s.doc(`${R}/push/s2`).set(push()));                       // not its own
  await assertFails(s.doc(`${R}/push/s1`).set(push({ extra: 1 })));           // unknown field
  await assertFails(s.doc(`${R}/push/s1`).set(push({ token: "" })));          // empty token
  await assertFails(owner().doc(`${R}/push/s1`).get());                       // only the server reads them
  const other = await staffPhone("s2");
  await assertFails(other.doc(`${R}/push/s1`).get());
  await assertFails(other.collection(`${R}/push`).get());
});
test("push: a phone without the current staff code can't register", async () => {
  await assertFails(diner("d1").doc(`${R}/push/d1`).set(push()));
  const s = await staffPhone("s1");
  await assertSucceeds(owner().doc(`${R}/secrets/staff`).set({ token: "NEWTOK" }));
  await assertFails(s.doc(`${R}/push/s1`).set(push()));
});
test("push: refused when the restaurant is more than 7 days unpaid", async () => {
  const s = await staffPhone("s1");
  await setAccount({ paidUntil: Date.now() - 8 * DAY });
  await assertFails(s.doc(`${R}/push/s1`).set(push()));
});

// ---------- changing your name at the table ----------
test("what diners write is limited in size and type", async () => {
  const d1 = await seatAt("d1");
  await assertFails(d1.doc(`${R}/lines/a`).set(line("d1", "4-a", { pname: "x".repeat(21) })));
  await assertFails(d1.doc(`${R}/lines/b`).set(line("d1", "4-a", { pname: { evil: 1 } })));
  await assertFails(d1.doc(`${R}/lines/c`).set(line("d1", "4-a", { batch: "x".repeat(41) })));
  await assertFails(d1.doc(`${R}/lines/d`).set(line("d1", "4-a", { t: "soon" })));
  await assertSucceeds(d1.doc(`${R}/lines/e`).set(line("d1", "4-a")));
  const call = { table: 4, session: "4-a", type: "call", pid: "d1", pname: "Amani", t: 1, ack: null, ackBy: null, done: false };
  await assertFails(d1.doc(`${R}/alerts/a`).set({ ...call, pname: "x".repeat(21) }));
  await assertFails(d1.doc(`${R}/alerts/b`).set({ ...call, t: "now" }));
  await assertSucceeds(d1.doc(`${R}/alerts/c`).set(call));
});
test("a group's label is set once, as a short name", async () => {
  const db = diner("d1");
  await db.doc(`${R}/passes/d1`).set({ table: 4, via: "key", k: "KEY4", t: 1 });
  const b = db.batch();
  b.set(db.doc(`${R}/groups/4-a`), newGroup("4-a", 4, "1234"));
  b.set(db.doc(`${R}/codes/1234`), { session: "4-a", table: 4 });
  b.set(db.doc(`${R}/passes/d1`), { table: 4, via: "key", k: "KEY4", session: "4-a", t: 1 });
  await b.commit();
  const me = { "people.d1": { name: "Amani", t: 1, uid: "d1", acct: false } };
  await assertFails(db.doc(`${R}/groups/4-a`).update({ ...me, label: "x".repeat(21) }));
  await assertFails(db.doc(`${R}/groups/4-a`).update({ ...me, label: { a: 1 } }));
  await assertSucceeds(db.doc(`${R}/groups/4-a`).update({ ...me, label: "Amani" }));
});
test("a diner can change their own name at the table, not anyone else's", async () => {
  const d1 = await seatAt("d1");
  // A friend joins with the group's code.
  const d2 = diner("d2");
  await d2.doc(`${R}/passes/d2`).set({ table: 4, via: "code", c: "1234", session: "4-a", t: 1 });
  await d2.doc(`${R}/joins/d2`).set(ask("d2", "Neha"));
  await d1.doc(`${R}/joins/d2`).update(letIn("d1"));
  await assertSucceeds(d2.doc(`${R}/groups/4-a`).update({ "people.d2": { name: "Neha", t: 2, uid: "d2", acct: false } }));
  await assertSucceeds(d1.doc(`${R}/groups/4-a`).update({ "people.d1": { name: "Vandan", t: 1, uid: "d1", acct: false } }));
  await assertFails(d1.doc(`${R}/groups/4-a`).update({ "people.d2": { name: "Haha", t: 2, uid: "d2", acct: false } }));
  await assertFails(d1.doc(`${R}/groups/4-a`).update({ "people.d1": { name: "", t: 1, uid: "d1", acct: false } }));
  await assertFails(d1.doc(`${R}/groups/4-a`).update({ "people.d1": { name: "A name far too long for a table", t: 1, uid: "d1", acct: false } }));
  await assertFails(d1.doc(`${R}/groups/4-a`).update({ label: "Vandan" }));   // the group's label stays
});

// ---------- invites: a table code typed on the front page ----------
test("invites: a code can only point to a restaurant where it's open, and can't be taken while open", async () => {
  const d1 = await seatAt("d1", 4, "4-a", "1234", "r1");
  await assertSucceeds(d1.doc("invites/1234").set({ rid: "r1" }));
  await assertSucceeds(diner("x").doc("invites/1234").get());
  await assertFails(d1.doc("invites/5555").set({ rid: "r1" }));                 // no open table with that code
  await assertFails(d1.doc("invites/1234").set({ rid: "r1", extra: 1 }));
  // Another restaurant opens a table with the same code: it can't take the invite while r1's is open.
  const d2 = await seatAt("d2", 4, "4-b", "1234", "r2");
  await assertFails(d2.doc("invites/1234").set({ rid: "r2" }));
  // r1's table closes (its code goes): now r2 can use it.
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`${R}/codes/1234`).delete());
  await assertSucceeds(d2.doc("invites/1234").set({ rid: "r2" }));
});

// ---------- sold-out list (live/stock) ----------
test("sold out: owner and manager mark items, nobody else; a sold-out item can't be ordered", async () => {
  await assertSucceeds(owner().doc(`${R}/live/stock`).set({ out: { Pilsner: true }, t: 1 }));
  await assertSucceeds(manager().doc(`${R}/live/stock`).set({ out: { Pilsner: true, "Fish & Chips": true }, t: 2 }));
  await assertFails(owner().doc(`${R}/live/other`).set({ out: {}, t: 1 }));
  await assertFails(owner().doc(`${R}/live/stock`).set({ out: {}, t: 1, extra: 1 }));
  const d = await seatAt("d1");
  await assertSucceeds(d.doc(`${R}/live/stock`).get());
  await assertFails(d.doc(`${R}/live/stock`).set({ out: {}, t: 3 }));
  const s = await staffPhone("s1");
  await assertFails(s.doc(`${R}/live/stock`).set({ out: {}, t: 3 }));
  // Pilsner is sold out: ordering it is refused; once it's back, it's accepted.
  await assertFails(d.doc(`${R}/lines/l1`).set(line("d1", "4-a")));
  await assertSucceeds(owner().doc(`${R}/live/stock`).set({ out: { "Fish & Chips": true }, t: 4 }));
  await assertSucceeds(d.doc(`${R}/lines/l1`).set(line("d1", "4-a")));
});
