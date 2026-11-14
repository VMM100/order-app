// Wasabi print box. Runs on a small always-on computer (e.g. a Raspberry Pi) plugged into the
// restaurant's router, next to the kitchen and bar printers.
//
// It signs in like a staff phone (with the restaurant's staff code), watches for new orders, and prints
// a ticket on each printer that serves those items' stations: within a second or two of the diner tapping
// Place order. It never prints a ticket twice (printed/{batch_pid}), prints what it missed when a printer
// or the internet comes back (up to 12 hours), reports each printer's state to the bar and kitchen
// screens (printstatus/{pid}) and keeps a write-once log (printlog).
//
// Settings: config.json next to this file, { "restaurant": "crafty-dees", "staffCode": "…", "name": "Bar print box" }.
// The staff code is the one in the staff QR code on the Tables & QR page. For tests only: "emulator",
// "authEmulator", "projectId" and "heartbeatMs".
import fs from "node:fs";
import os from "node:os";
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { initializeFirestore, connectFirestoreEmulator, collection, doc, onSnapshot, query, where, setDoc, deleteDoc, addDoc, getDoc } from "firebase/firestore";
import { plan, ticket, waiting, MAX_AGE_MS } from "./lib.js";
import { sendWithRetry, probe } from "./printer.js";

const here = new URL(".", import.meta.url);
const cfg = JSON.parse(fs.readFileSync(new URL("config.json", here), "utf8"));
const RID = cfg.restaurant, BOX = String(cfg.name || os.hostname()).slice(0, 40);
if (!RID || !cfg.staffCode) { console.error("config.json needs \"restaurant\" and \"staffCode\""); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);   // order details are never logged, only counts and ids

const app = initializeApp({ apiKey: "AIzaSyA1AC8HPl9IZxf9tlb3fjoLB_mpCSx8L3g", authDomain: "auth.wasabi.co.tz", projectId: cfg.projectId || "order-app-47367", appId: "1:151565820125:web:4dc266a4bb5fa6ae793b34" });
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
if (cfg.emulator) { const [h, p] = cfg.emulator.split(":"); connectFirestoreEmulator(db, h, Number(p)); }
const R = (...p) => doc(db, "restaurants", RID, ...p), C = (name) => collection(db, "restaurants", RID, name);

const S = { printers: [], lines: [], printed: [], queue: [], groups: {}, waiters: [], shared: [], status: {}, startedAt: Date.now(), busy: false, again: false };

async function main() {
  const auth = getAuth(app);
  if (cfg.emulator) { const { connectAuthEmulator } = await import("firebase/auth"); connectAuthEmulator(auth, `http://${cfg.authEmulator || "127.0.0.1:9099"}`, { disableWarnings: true }); }
  const u = (await signInAnonymously(auth)).user;
  // Join as a staff device: the same step a bar or kitchen phone takes when it scans the staff code.
  await setDoc(R("staff", u.uid), { token: cfg.staffCode, t: Date.now() });
  log(`signed in for ${RID} as ${BOX}`);
  const watch = (q, fn) => onSnapshot(q, (s) => { fn(s); kick(); }, (e) => log("watch failed:", e.code || e.message));
  watch(C("printers"), (s) => (S.printers = s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  const since = Date.now() - MAX_AGE_MS;
  watch(query(C("lines"), where("t", ">=", since)), (s) => (S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  watch(query(C("printed"), where("t", ">=", since)), (s) => (S.printed = s.docs.map((d) => d.id)));
  watch(C("printq"), (s) => (S.queue = s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  watch(query(C("groups"), where("open", "==", true)), (s) => { s.docs.forEach((d) => (S.groups[d.id] = d.data())); S.gotGroups = true; });
  watch(R(), (d) => { const x = d.data() || {}; S.waiters = x.waiters || []; S.shared = x.shared || []; S.gotRest = true; });
  setInterval(heartbeat, cfg.heartbeatMs || 30e3); heartbeat();
  setInterval(kick, Math.min(15e3, cfg.heartbeatMs || 15e3));   // retry anything that failed
}

// Run the print loop once at a time; if something changes meanwhile, run it again straight after.
function kick() { if (S.busy) { S.again = true; return; } S.busy = true; run().catch((e) => log("print loop:", e.message)).finally(() => { S.busy = false; if (S.again) { S.again = false; kick(); } }); }

const wname = (id) => (S.waiters.find((w) => w.id === id) || {}).name || "";
async function details(ls) {
  const l = ls[0]; let g = S.groups[l.session];
  if (!g && l.session) { try { const d = await getDoc(R("groups", l.session)); g = d.data(); if (g) S.groups[l.session] = g; } catch {} }
  const place = g && g.tab ? `Bar tab: ${g.tab}` : `Table ${l.table}` + (g && g.label && S.shared.includes(l.table) ? ` (${g.label})` : "");
  return { place, guest: [...new Set(ls.map((x) => x.pname).filter(Boolean))].join(", "), waiter: g ? wname(g.waiter) : "", by: (ls.find((x) => x.byName) || {}).byName || "" };
}
const STATION = { kitchen: "Kitchen", bar: "Bar", grill: "Grill" };
const stationOf = (p, ls) => [...new Set(ls.map((l) => STATION[l.st] || l.st))].join(" + ") || p.name;

async function print(p, job, kind) {
  const d = await details(job.lines);
  const bytes = ticket({ width: p.width, station: stationOf(p, job.lines), ...d, lines: job.lines, t: job.t, now: Date.now(), kind, short: job.batch.slice(-4).toUpperCase() });
  await sendWithRetry(p.ip, p.port || 9100, bytes);
}

async function run() {
  // Wait for the waiters' names and open tables, so the first tickets after starting aren't missing them.
  if (!S.gotRest || !S.gotGroups) return;
  const now = Date.now();
  const on = S.printers.filter((p) => p.on !== false && p.ip);
  // 1. New orders.
  for (const job of plan({ printers: on, lines: S.lines, printed: S.printed, now, startedAt: S.startedAt })) {
    const p = on.find((x) => x.id === job.pid);
    if (S.status[p.id] && S.status[p.id].ok === false && now - S.status[p.id].t < 10e3) continue;   // just failed: wait for the next round
    try {
      await print(p, job, "order");
      await setDoc(R("printed", `${job.batch}_${p.id}`), { batch: job.batch, pid: p.id, t: Date.now(), kind: "order" });
      S.printed.push(`${job.batch}_${p.id}`); await status(p, true, "");
      log(`printed order ${job.batch} on ${p.id}`);
    } catch (e) { await status(p, false, e.message); }
  }
  // 2. Reprints and test prints asked for on the screens or the owner page.
  for (const q of S.queue) {
    const p = S.printers.find((x) => x.id === q.pid);
    if (!p) { await deleteDoc(R("printq", q.id)).catch(() => {}); continue; }
    if (p.on === false) continue;   // waits until the printer is switched back on
    try {
      if (q.kind === "test") await sendWithRetry(p.ip, p.port || 9100, ticket({ width: p.width, station: p.name, place: "Test", lines: [{ n: "Test ticket", v: BOX }], now: Date.now(), kind: "test" }));
      else { const ls = S.lines.filter((l) => l.batch === q.batch && (p.stations || []).includes(l.st)); if (ls.length) await print(p, { batch: q.batch, lines: ls, t: Math.min(...ls.map((l) => l.t)) }, "reprint"); }
      await deleteDoc(R("printq", q.id));
      await addDoc(C("printlog"), { pid: p.id, ev: q.kind === "test" ? "test" : "reprint", by: String(q.by || "").slice(0, 40), t: Date.now() });
      await status(p, true, "");
    } catch (e) { await status(p, false, e.message); }
  }
}

// Tell the screens how each printer is doing; log when one stops or comes back.
async function status(p, ok, err) {
  const was = S.status[p.id], n = p.on === false ? waiting(p, { lines: S.lines, printed: S.printed, now: Date.now(), startedAt: S.startedAt }) : 0;
  S.status[p.id] = { ok, err, t: Date.now(), waiting: n };
  if (was && was.ok !== ok) await addDoc(C("printlog"), { pid: p.id, ev: ok ? "online" : "offline", by: BOX, reason: ok ? "" : String(err).slice(0, 60), t: Date.now() }).catch(() => {});
  if (!was || was.ok !== ok || was.waiting !== n || Date.now() - (was.sent || 0) > 60e3) {
    await setDoc(R("printstatus", p.id), { ok, err: ok ? "" : String(err).slice(0, 60), t: Date.now(), box: BOX, waiting: n }).catch((e) => log("status:", e.code || e.message));
    S.status[p.id].sent = Date.now();
  } else S.status[p.id].sent = was.sent;
}
async function heartbeat() {
  for (const p of S.printers) {
    if (!p.ip) continue;
    if (p.on === false) { await status(p, true, ""); continue; }   // switched off: no warnings, just keep "waiting" up to date
    await status(p, await probe(p.ip, p.port || 9100), "not responding");
  }
}

main().catch((e) => { console.error("could not start:", e.code || e.message); process.exit(1); });
process.on("unhandledRejection", (e) => log("error:", e && (e.code || e.message)));
