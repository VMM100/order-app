// End-to-end: the real print box program against a test copy of the database (the emulator) and two
// pretend printers. Checks: each order prints once on the right printer; a printer that stops answering
// shows as not responding and catches up when it's back; a printer switched off prints nothing and counts
// what's waiting; switching on without catch-up skips those; a reprint request prints and is logged.
// Run by tests/print-e2e.sh (inside the emulator).
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";

const PROJECT = "demo-order-app", R = "restaurants/r1", now = Date.now();
let bad = 0; const check = (label, ok) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(300); } return false; };

// Two pretend printers that remember every ticket they receive.
function fakePrinter(port) {
  const p = { tickets: [], server: null, start() { this.server = net.createServer((s) => { const c = []; s.on("data", (d) => c.push(d)); s.on("end", () => { const b = Buffer.concat(c); if (b.length) p.tickets.push(b.toString("latin1")); }); s.on("error", () => {}); }).listen(port, "127.0.0.1"); return this; },
    stop() { return new Promise((r) => this.server.close(r)); } };
  return p.start();
}
const bar = fakePrinter(19100), kitchen = fakePrinter(19101);

const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));
const get = async (path) => { let d; await admin(async (db) => { d = await db.doc(path).get(); }); return d; };
const list = async (path) => { let s; await admin(async (db) => { s = await db.collection(path).get(); }); return s.docs.map((d) => ({ id: d.id, ...d.data() })); };
const line = (batch, st, n, t = Date.now()) => ({ table: 8, session: "s1", batch, pid: "d1", pname: "Amani", n, v: "Full 400ml", pr: 9000, st, s: "new", t, note: null });

await admin(async (db) => {
  await db.doc("accounts/r1").set({ name: "Test bar", ownerEmail: "owner@example.com", status: "active", paidUntil: now + 30 * 864e5 });
  await db.doc(R).set({ waiters: [{ id: "w1", name: "Grace" }], shared: [], prices: {} });
  await db.doc(`${R}/secrets/staff`).set({ token: "STAFFTOK" });
  await db.doc(`${R}/groups/s1`).set({ table: 8, session: "s1", open: true, waiter: "w1", people: {}, code: "1234" });
  await db.doc(`${R}/printers/p1`).set({ name: "Bar printer", ip: "127.0.0.1", port: 19100, stations: ["bar"], width: 80, on: true, since: now - 1000, updated: now });
  await db.doc(`${R}/printers/p2`).set({ name: "Kitchen printer", ip: "127.0.0.1", port: 19101, stations: ["kitchen", "grill"], width: 58, on: true, since: now - 1000, updated: now });
});

writeFileSync("bridge/config.json", JSON.stringify({ restaurant: "r1", staffCode: "STAFFTOK", name: "Test box", projectId: PROJECT, emulator: "127.0.0.1:8080", authEmulator: "127.0.0.1:9099", heartbeatMs: 1500 }));
const box = spawn(process.execPath, ["bridge/print-box.js"], { stdio: ["ignore", "pipe", "pipe"] });
let boxOut = ""; box.stdout.on("data", (d) => (boxOut += d)); box.stderr.on("data", (d) => (boxOut += d));

try {
  check("print box signs in and joins as a staff device", await until(() => /signed in for r1/.test(boxOut)));

  // 1. An order with a drink and a dish: one ticket on each printer, each with only its own items.
  await admin(async (db) => { const b = db.batch(); b.set(db.doc(`${R}/lines/l1`), line("b1", "bar", "Light Lager")); b.set(db.doc(`${R}/lines/l2`), line("b1", "kitchen", "Wings")); await b.commit(); });
  check("bar ticket printed", await until(() => bar.tickets.length === 1));
  check("kitchen ticket printed", await until(() => kitchen.tickets.length === 1));
  check("bar ticket has the table, waiter and drink, not the food", /TABLE 8/.test(bar.tickets[0]) && /Grace/.test(bar.tickets[0]) && /Light Lager/.test(bar.tickets[0]) && !/Wings/.test(bar.tickets[0]));
  check("kitchen ticket has the food only", /Wings/.test(kitchen.tickets[0]) && !/Light Lager/.test(kitchen.tickets[0]));
  check("both recorded as printed", await until(async () => (await get(`${R}/printed/b1_p1`)).exists && (await get(`${R}/printed/b1_p2`)).exists));
  await sleep(3500);
  check("nothing prints twice", bar.tickets.length === 1 && kitchen.tickets.length === 1);

  // 2. The kitchen printer stops answering, then comes back: shown on the screens, then catches up.
  await kitchen.stop();
  await admin((db) => db.doc(`${R}/lines/l3`).set(line("b2", "kitchen", "Burger")));
  check("kitchen printer shows as not responding", await until(async () => (await get(`${R}/printstatus/p2`)).data()?.ok === false));
  kitchen.start();
  check("missed kitchen ticket prints when the printer is back", await until(() => kitchen.tickets.some((t) => /Burger/.test(t)), 30000));
  check("kitchen printer shows as working again", await until(async () => (await get(`${R}/printstatus/p2`)).data()?.ok === true));
  check("the log has 'offline' then 'online'", await until(async () => { const l = await list(`${R}/printlog`); return l.some((x) => x.pid === "p2" && x.ev === "offline") && l.some((x) => x.pid === "p2" && x.ev === "online"); }));

  // 3. Bar printer switched off: nothing prints, the waiting count goes up, no warning.
  await admin((db) => db.doc(`${R}/printers/p1`).update({ on: false, offAt: Date.now(), offBy: "Bar screen", offReason: "Out of paper" }));
  await sleep(500);
  await admin((db) => db.doc(`${R}/lines/l4`).set(line("b3", "bar", "Pilsner")));
  check("switched off: counts 1 ticket waiting", await until(async () => (await get(`${R}/printstatus/p1`)).data()?.waiting === 1));
  check("switched off: nothing printed, and no warning", bar.tickets.length === 1 && (await get(`${R}/printstatus/p1`)).data()?.ok === true);

  // 4. Switched back on with "Don't print them": the waiting ticket is skipped.
  await admin((db) => db.doc(`${R}/printers/p1`).update({ on: true, since: Date.now() }));
  await sleep(4000);
  check("switched on without catch-up: the missed ticket isn't printed", !bar.tickets.some((t) => /Pilsner/.test(t)));

  // 5. Reprint from the bar screen.
  await admin((db) => db.doc(`${R}/printq/q1`).set({ batch: "b1", pid: "p1", kind: "reprint", t: Date.now(), by: "Bar screen" }));
  check("reprint printed and marked REPRINT", await until(() => bar.tickets.some((t) => /REPRINT/.test(t) && /Light Lager/.test(t))));
  check("reprint request cleared and logged", await until(async () => !(await get(`${R}/printq/q1`)).exists && (await list(`${R}/printlog`)).some((x) => x.ev === "reprint")));

  // 6. Switched off, an order comes in, switched on with "Print them": it prints.
  await admin((db) => db.doc(`${R}/printers/p1`).update({ on: false, offAt: Date.now() }));
  await sleep(500);
  await admin((db) => db.doc(`${R}/lines/l5`).set(line("b4", "bar", "Stout")));
  await sleep(2500);
  await admin((db) => db.doc(`${R}/printers/p1`).update({ on: true }));
  check("switched on with catch-up: the missed ticket prints", await until(() => bar.tickets.some((t) => /Stout/.test(t))));
} finally {
  box.kill(); rmSync("bridge/config.json", { force: true });
  await bar.stop().catch(() => {}); await kitchen.stop().catch(() => {}); await env.cleanup();
}
if (bad) { console.log("\n--- print box output ---\n" + boxOut.split("\n").slice(-40).join("\n")); process.exit(1); }
process.exit(0);
