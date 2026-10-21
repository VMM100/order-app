// Tests for firestore.rules, run against the Firestore emulator (see .github/workflows/rules.yml).
import { readFileSync } from "node:fs";
import { test, before, beforeEach, after } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";

let env;
const OWNER = { email: "owner@example.com", email_verified: true };
const MANAGER = { email: "mgr@example.com", email_verified: true };
const anon = { firebase: { sign_in_provider: "anonymous" } };

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
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc("config/restaurant").set({ sections: [], waiters: [{ id: "w1", name: "Grace" }], shared: [6], prices: PRICES, brand: { name: "Dee's" } });
    await db.doc("tablekeys/4").set({ k: "KEY4" });
    await db.doc("tablekeys/5").set({ k: "KEY5" });
    await db.doc("tablekeys/6").set({ k: "KEY6" });
    await db.doc("secrets/staff").set({ token: "STAFFTOK" });
    await db.doc("admins/owner@example.com").set({ role: "owner" });
    await db.doc("admins/mgr@example.com").set({ role: "manager" });
    await db.doc("meta/claimed").set({ by: "owner@example.com" });
  });
});

const diner = (uid) => env.authenticatedContext(uid, anon).firestore();
const owner = () => env.authenticatedContext("owner", OWNER).firestore();
const manager = () => env.authenticatedContext("mgr", MANAGER).firestore();
const newGroup = (sid, table, code) => ({ table, session: sid, code, opened: 1, waiter: null, people: {}, split: "order", paid: {}, open: true, label: null });

// The diner flow from the app: scan the QR (key pass), start the table's group, join it.
async function seatAt(uid, table = 4, key = "KEY4", sid = "4-a", code = "1234") {
  const db = diner(uid);
  await db.doc(`passes/${uid}`).set({ table, via: "key", k: key, t: 1 });
  const b = db.batch();
  b.set(db.doc(`groups/${sid}`), newGroup(sid, table, code));
  b.set(db.doc(`tables/${table}`), { table, current: sid });
  b.set(db.doc(`codes/${code}`), { session: sid, table });
  b.set(db.doc(`passes/${uid}`), { table, via: "key", k: key, session: sid, t: 1 });
  await b.commit();
  await db.doc(`groups/${sid}`).update({ [`people.${uid}`]: { name: "Amani", t: 1, uid, acct: false }, label: "Amani" });
  return db;
}
const line = (uid, sid, extra = {}) => ({ table: 4, session: sid, batch: "b1", pid: uid, pname: "Amani", n: "Pilsner", v: "Full 400ml", pr: 10000, st: "bar", s: "new", t: 1, note: null, ...extra });

// ---------- secrets stay secret ----------
test("nobody outside can read table keys, staff token or admin list", async () => {
  const db = diner("x");
  await assertFails(db.doc("tablekeys/4").get());
  await assertFails(db.collection("tablekeys").get());
  await assertFails(db.doc("secrets/staff").get());
  await assertFails(db.collection("admins").get());
  await assertFails(db.collection("codes").get());
  await assertFails(db.collection("groups").get());
});
test("menu is public, even before sign-in", async () => {
  await assertSucceeds(env.unauthenticatedContext().firestore().doc("config/restaurant").get());
});
test("diners can't edit the menu or prices", async () => {
  await assertFails(diner("x").doc("config/restaurant").update({ prices: { "Pilsner|Full 400ml": { p: 1, st: "bar" } } }));
});

// ---------- joining a table ----------
test("wrong table key gives no pass", async () => {
  await assertFails(diner("d1").doc("passes/d1").set({ table: 4, via: "key", k: "GUESS", t: 1 }));
  await assertFails(diner("d1").doc("passes/d1").set({ table: 4, via: "key", k: "KEY5", t: 1 }));
});
test("right table key: start group, join, order at menu price", async () => {
  const db = await seatAt("d1");
  await assertSucceeds(db.doc("lines/l1").set(line("d1", "4-a")));
  await assertSucceeds(db.collection("lines").where("session", "==", "4-a").get());
  await assertSucceeds(db.doc("groups/4-a").get());
});
test("a big order (10 items) in one go", async () => {
  const db = await seatAt("d1");
  const b = db.batch();
  for (let i = 0; i < 10; i++) b.set(db.doc(`lines/m${i}`), line("d1", "4-a", { n: i % 2 ? "Chips" : "Fish & Chips", v: "", pr: i % 2 ? 3000 : 21000, st: "kitchen" }));
  await assertSucceeds(b.commit());
});
test("can't change the price, station, or order for someone else", async () => {
  const db = await seatAt("d1");
  await assertFails(db.doc("lines/l1").set(line("d1", "4-a", { pr: 1 })));
  await assertFails(db.doc("lines/l2").set(line("d1", "4-a", { st: "kitchen" })));
  await assertFails(db.doc("lines/l3").set(line("d1", "4-a", { pid: "someone" })));
  await assertFails(db.doc("lines/l4").set(line("d1", "4-a", { n: "Free beer", v: "" })));
  await assertFails(db.doc("lines/l5").set(line("d1", "4-a", { s: "served" })));
});
test("must join before ordering", async () => {
  const db = diner("d1");
  await db.doc("passes/d1").set({ table: 4, via: "key", k: "KEY4", t: 1 });
  const b = db.batch();
  b.set(db.doc("groups/4-a"), newGroup("4-a", 4, "1234"));
  b.set(db.doc("passes/d1"), { table: 4, via: "key", k: "KEY4", session: "4-a", t: 1 });
  await b.commit();
  await assertFails(db.doc("lines/l1").set(line("d1", "4-a")));
});
test("a key for table 4 can't start a group at table 5", async () => {
  const db = diner("d1");
  await db.doc("passes/d1").set({ table: 4, via: "key", k: "KEY4", t: 1 });
  await assertFails(db.doc("groups/5-a").set(newGroup("5-a", 5, "5555")));
});
test("second diner scanning the same table joins the same group", async () => {
  await seatAt("d1");
  const db = diner("d2");
  await assertSucceeds(db.doc("passes/d2").set({ table: 4, via: "key", k: "KEY4", t: 1 }));
  await assertSucceeds(db.doc("tables/4").get());
  await assertSucceeds(db.doc("passes/d2").set({ table: 4, via: "key", k: "KEY4", session: "4-a", t: 1 }));
  await assertSucceeds(db.doc("groups/4-a").update({ "people.d2": { name: "Neha", t: 2, uid: "d2", acct: false } }));
  await assertSucceeds(db.doc("lines/l2").set(line("d2", "4-a", { pname: "Neha" })));
});

// ---------- friend's invite code ----------
test("friend with the code can join and order", async () => {
  await seatAt("d1");
  const db = diner("f1");
  const c = await assertSucceeds(db.doc("codes/1234").get());
  await assertSucceeds(db.doc("passes/f1").set({ table: 4, via: "code", c: "1234", session: c.data().session, t: 1 }));
  await assertSucceeds(db.doc("groups/4-a").get());
  await assertSucceeds(db.doc("groups/4-a").update({ "people.f1": { name: "Juma", t: 3, uid: "f1", acct: false } }));
  await assertSucceeds(db.doc("lines/f").set(line("f1", "4-a", { pname: "Juma" })));
  await assertSucceeds(db.doc("alerts/a1").set({ table: 4, session: "4-a", type: "call", pid: "f1", pname: "Juma", t: 1, ack: null, ackBy: null, done: false }));
});
test("wrong code, or a code for another group, gives no pass", async () => {
  await seatAt("d1");
  await assertFails(diner("f1").doc("passes/f1").set({ table: 4, via: "code", c: "9999", session: "4-a", t: 1 }));
  await assertFails(diner("f1").doc("passes/f1").set({ table: 4, via: "code", c: "1234", session: "4-zzz", t: 1 }));
});
test("code holder can't list the other groups at the table", async () => {
  await seatAt("d1");
  const db = diner("f1");
  await db.doc("passes/f1").set({ table: 4, via: "code", c: "1234", session: "4-a", t: 1 });
  await assertFails(db.collection("groups").where("table", "==", 4).get());
});
test("closed group's code stops working", async () => {
  await seatAt("d1");
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc("groups/4-a").update({ open: false }));
  await assertFails(diner("f1").doc("passes/f1").set({ table: 4, via: "code", c: "1234", session: "4-a", t: 1 }));
});
test("a closed group's leftover code can be reused by a new group", async () => {
  await seatAt("d1");
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc("groups/4-a").update({ open: false }));
  await assertSucceeds(seatAt("d9", 4, "KEY4", "4-b", "1234"));
});
test("an open group's code can't be taken over", async () => {
  await seatAt("d1");
  await assertFails(seatAt("d9", 5, "KEY5", "5-a", "1234"));
});

// ---------- outsiders ----------
test("someone without a pass sees nothing", async () => {
  await seatAt("d1");
  const db = diner("x");
  await assertFails(db.doc("groups/4-a").get());
  await assertFails(db.collection("lines").where("session", "==", "4-a").get());
  await assertFails(db.collection("alerts").where("session", "==", "4-a").get());
  await assertFails(db.doc("lines/l9").set(line("x", "4-a", { pid: "x" })));
});
test("diners at table 5 can't see table 4", async () => {
  await seatAt("d1");
  await seatAt("d5", 5, "KEY5", "5-a", "5555");
  const db = diner("d5");
  await assertFails(db.doc("groups/4-a").get());
  await assertFails(db.collection("lines").where("session", "==", "4-a").get());
  await assertFails(db.doc("passes/d5").set({ table: 5, via: "key", k: "KEY5", session: "4-a", t: 1 }));
});

// ---------- what diners can and can't change in their group ----------
test("diners can choose the split but not mark paid, assign a waiter or close", async () => {
  const db = await seatAt("d1");
  await assertSucceeds(db.doc("groups/4-a").update({ split: "equal" }));
  await assertFails(db.doc("groups/4-a").update({ "paid.d1": true }));
  await assertFails(db.doc("groups/4-a").update({ waiter: "w1" }));
  await assertFails(db.doc("groups/4-a").update({ open: false }));
  await assertFails(db.doc("groups/4-a").update({ label: "Hacker" }));
});
test("diners can't remove or rename someone else", async () => {
  await seatAt("d1");
  const db = diner("d2");
  await db.doc("passes/d2").set({ table: 4, via: "key", k: "KEY4", session: "4-a", t: 1 });
  await assertFails(db.doc("groups/4-a").update({ "people.d1": { name: "Bob", t: 1, uid: "d1", acct: false } }));
  await assertFails(db.doc("groups/4-a").update({ "people.zz": { name: "Ghost", t: 1, uid: "zz", acct: false } }));
});
test("diners can't fake a waiter's 'on my way'", async () => {
  const db = await seatAt("d1");
  await assertFails(db.doc("alerts/a1").set({ table: 4, session: "4-a", type: "bill", pid: "d1", pname: "Amani", t: 1, ack: 5, ackBy: "w1", done: false }));
  await assertSucceeds(db.doc("alerts/a2").set({ table: 4, session: "4-a", type: "bill", pid: "d1", pname: "Amani", t: 1, ack: null, ackBy: null, done: false }));
  await assertFails(db.doc("alerts/a2").update({ done: true }));
});
test("diners can't move their order along or delete it", async () => {
  const db = await seatAt("d1");
  await db.doc("lines/l1").set(line("d1", "4-a"));
  await assertFails(db.doc("lines/l1").update({ s: "served" }));
  await assertFails(db.doc("lines/l1").delete());
});

// ---------- shared tables ----------
test("shared table: QR holder may see the groups there, then start their own", async () => {
  await seatAt("d1", 6, "KEY6", "6-a", "6666");
  const db = diner("d2");
  await db.doc("passes/d2").set({ table: 6, via: "key", k: "KEY6", t: 1 });
  await assertSucceeds(db.collection("groups").where("table", "==", 6).get());
  await assertFails(db.collection("groups").where("table", "==", 4).get());
  const b = db.batch();
  b.set(db.doc("groups/6-b"), newGroup("6-b", 6, "6667"));
  b.set(db.doc("codes/6667"), { session: "6-b", table: 6 });
  b.set(db.doc("passes/d2"), { table: 6, via: "key", k: "KEY6", session: "6-b", t: 1 });
  await assertSucceeds(b.commit());
});

// ---------- staff phones ----------
const staffPhone = async (uid = "s1", token = "STAFFTOK") => {
  const db = env.authenticatedContext(uid, anon).firestore();
  await db.doc(`staff/${uid}`).set({ token, t: 1 });
  return db;
};
test("staff link with the wrong token is refused", async () => {
  await assertFails(staffPhone("s1", "nope"));
});
test("staff phone: sees orders, moves them along, can't change prices", async () => {
  const d = await seatAt("d1"); await d.doc("lines/l1").set(line("d1", "4-a"));
  const db = await staffPhone();
  await assertSucceeds(db.collection("lines").where("s", "in", ["new", "preparing", "ready"]).get());
  await assertSucceeds(db.collection("groups").where("open", "==", true).get());
  await assertSucceeds(db.collection("alerts").where("done", "==", false).get());
  await assertSucceeds(db.doc("lines/l1").update({ s: "preparing", tPrep: 2 }));
  await assertFails(db.doc("lines/l1").update({ pr: 0 }));
  await assertSucceeds(db.doc("groups/4-a").update({ waiter: "w1", accepted: 3 }));
  await assertSucceeds(db.doc("groups/4-a").update({ "paid.d1": true }));
  await assertFails(db.doc("tablekeys/4").get());
  await assertFails(db.doc("config/restaurant").update({ waiters: [] }));
  await assertFails(db.collection("sessions").get());
});
test("waiter closes a busy table in one go", async () => {
  const d = await seatAt("d1");
  const ids = [];
  for (let i = 0; i < 12; i++) { ids.push("c" + i); await d.doc("lines/c" + i).set(line("d1", "4-a")); }
  await d.doc("alerts/a1").set({ table: 4, session: "4-a", type: "bill", pid: "d1", pname: "Amani", t: 1, ack: null, ackBy: null, done: false });
  const db = await staffPhone();
  const b = db.batch();
  ids.forEach((id) => b.update(db.doc("lines/" + id), { s: "served", closedUnserved: true }));
  b.update(db.doc("alerts/a1"), { done: true, doneAt: 9 });
  b.set(db.doc("sessions/4-a"), { table: 4, session: "4-a", closed: 9, total: 120000 });
  b.update(db.doc("groups/4-a"), { open: false, closed: 9 });
  b.delete(db.doc("codes/1234"));
  b.set(db.doc("visits/d1_4-a"), { uid: "d1", rid: "craftydees", session: "4-a", date: 9, items: [], share: 0 });
  await assertSucceeds(b.commit());
});
test("making a new staff link signs out old staff phones", async () => {
  const db = await staffPhone();
  await assertSucceeds(db.collection("lines").where("s", "==", "new").get());
  await assertSucceeds(owner().doc("secrets/staff").set({ token: "NEWTOK" }));
  await assertFails(db.collection("lines").where("s", "==", "new").get());
});

// ---------- owner and manager ----------
test("manager edits menu and staff, not the look or admins", async () => {
  const db = manager();
  await assertSucceeds(db.doc("config/restaurant").update({ waiters: [{ id: "w2", name: "Baraka" }], prices: PRICES, updated: 2 }));
  await assertFails(db.doc("config/restaurant").update({ brand: { name: "Mine" } }));
  await assertFails(db.doc("admins/new@example.com").set({ role: "owner" }));
  await assertSucceeds(db.doc("tablekeys/4").get());
  await assertSucceeds(db.doc("secrets/staff").get());
});
test("owner changes the look and adds a manager; can't remove themselves", async () => {
  const db = owner();
  await assertSucceeds(db.doc("config/restaurant").update({ brand: { name: "Dee's Beer Garden" } }));
  await assertSucceeds(db.doc("admins/new@example.com").set({ role: "manager", by: "owner@example.com", t: 1 }));
  await assertFails(db.doc("admins/owner@example.com").delete());
  await assertSucceeds(db.collection("sessions").get());
});
test("unverified email isn't trusted", async () => {
  const db = env.authenticatedContext("fake", { email: "owner@example.com", email_verified: false }).firestore();
  await assertFails(db.doc("secrets/staff").get());
});
test("first sign-in claims the restaurant; nobody can claim it again", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc("meta/claimed").delete(); await ctx.firestore().doc("admins/owner@example.com").delete(); await ctx.firestore().doc("admins/mgr@example.com").delete(); });
  const first = env.authenticatedContext("u1", { email: "first@example.com", email_verified: true }).firestore();
  const b = first.batch();
  b.set(first.doc("admins/first@example.com"), { role: "owner", t: 1 });
  b.set(first.doc("meta/claimed"), { by: "first@example.com" });
  await assertSucceeds(b.commit());
  const second = env.authenticatedContext("u2", { email: "second@example.com", email_verified: true }).firestore();
  const b2 = second.batch();
  b2.set(second.doc("admins/second@example.com"), { role: "owner", t: 1 });
  b2.set(second.doc("meta/claimed"), { by: "second@example.com" });
  await assertFails(b2.commit());
  await assertFails(second.doc("admins/second@example.com").set({ role: "owner", t: 1 }));
});

// ---------- diner accounts ----------
test("diners read only their own visits and profile", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc("visits/a").set({ uid: "g1", rid: "craftydees", date: 1 });
    await ctx.firestore().doc("visits/b").set({ uid: "g2", rid: "craftydees", date: 1 });
  });
  const db = env.authenticatedContext("g1", { phone_number: "+255700000000" }).firestore();
  await assertSucceeds(db.collection("visits").where("uid", "==", "g1").get());
  await assertFails(db.collection("visits").where("uid", "==", "g2").get());
  await assertFails(db.collection("visits").get());
  await assertSucceeds(db.doc("diners/g1").set({ name: "Amani" }));
  await assertFails(db.doc("diners/g2").get());
  await assertFails(db.doc("visits/c").set({ uid: "g1", rid: "craftydees", date: 1 }));
});
