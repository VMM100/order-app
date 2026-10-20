// Order App: one page, several screens chosen by the link.
//   index.html?t=4        diner at table 4 (what the table QR code opens)
//   index.html?c=4821     diner joining a friend's table by code
//   index.html#waiter     waiter phone
//   index.html#kitchen    kitchen screen (also #bar, #grill)
//   index.html#setup      links, table QR codes and demo reset
import { db } from "./firebase.js";
import {
  doc, collection, query, where, onSnapshot, getDocs, runTransaction,
  updateDoc, addDoc, writeBatch, deleteField,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { MENU, STATIONS, WAITERS, TABLE_COUNT } from "./menu.js";

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m / 60) + " h ago"; };
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const BASE = location.origin + location.pathname;
const ALERT = { call: "Call waiter", bill: "Bill please" };
const wname = (id) => (WAITERS.find((w) => w.id === id) || {}).name;
const label = (l) => esc(l.n) + (l.v ? ` · ${esc(l.v)}` : "");

function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2200); }
function fail(e) { console.error(e); toast("Could not save. Check your connection and try again."); }

// Re-render without losing what someone is typing.
function paint(html) {
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  $("#view").innerHTML = html;
  if (id) { const el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
}

// Sound + vibration for staff screens (browsers only allow sound after a tap).
let audio = null, wakeLock = null;
async function enableSound() {
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); } catch {}
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  beep(); toast("Alerts on. Keep this screen open.");
}
function beep() {
  try { navigator.vibrate?.([200, 80, 200]); } catch {}
  if (!audio) return;
  [0, 0.25].forEach((d) => {
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + d;
    o.frequency.value = 880; g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.22);
  });
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && audio && (!wakeLock || wakeLock.released)) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
});
const soundBar = () => audio ? "" :
  `<div class="soundbar"><span>Tap to turn on sound alerts and keep the screen awake</span><button class="btn primary" data-act="sound">Turn on alerts</button></div>`;

// Tell staff screens when something new arrives (skips the first load).
function watcher() {
  const seen = new Set(); let primed = false;
  return (ids) => { let fresh = false; ids.forEach((id) => { if (!seen.has(id)) { seen.add(id); if (primed) fresh = true; } }); primed = true; if (fresh) beep(); };
}

// ---------- data ----------
const tablesCol = collection(db, "tables"), linesCol = collection(db, "lines"), alertsCol = collection(db, "alerts");
const tableRef = (n) => doc(db, "tables", String(n));

async function newCode() {
  for (let i = 0; i < 6; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    const s = await getDocs(query(tablesCol, where("code", "==", c)));
    if (s.empty) return c;
  }
  return String(Date.now()).slice(-4);
}
// Start a fresh session at a table if nobody is sitting there yet.
async function ensureSession(n) {
  const code = await newCode();
  await runTransaction(db, async (tx) => {
    const s = await tx.get(tableRef(n));
    if (s.exists() && s.data().session) return;
    tx.set(tableRef(n), { table: Number(n), code, session: `${n}-${Date.now().toString(36)}`, opened: Date.now(),
      waiter: null, people: {}, split: "order", paid: {} });
  });
}
const tableTotal = (lines) => lines.reduce((a, l) => a + l.pr, 0);
function shares(t, lines) {
  const ids = Object.keys(t.people || {}); const total = tableTotal(lines);
  return ids.map((pid) => ({ pid, name: t.people[pid].name, paid: !!(t.paid || {})[pid],
    items: lines.filter((l) => l.pid === pid),
    amt: t.split === "equal" ? Math.ceil(total / Math.max(ids.length, 1) / 100) * 100 : lines.filter((l) => l.pid === pid).reduce((a, l) => a + l.pr, 0) }));
}
function billHtml(t, lines, staff) {
  const total = tableTotal(lines);
  return `<div class="seg" role="group" aria-label="Split method">
    <button aria-pressed="${t.split !== "equal"}" data-split="order" data-t="${t.table}">By what they ordered</button>
    <button aria-pressed="${t.split === "equal"}" data-split="equal" data-t="${t.table}">Equally</button></div>
   ${shares(t, lines).map((s) => `<div class="billrow"><div style="min-width:0"><div class="${s.paid ? "paid" : ""}" style="font-weight:600">${esc(s.name)}</div>
     ${t.split !== "equal" ? `<div class="note" style="margin:0">${s.items.map((l) => esc(l.n)).join(", ") || "Nothing ordered"}</div>` : ""}</div>
     <div class="row" style="flex-wrap:nowrap"><span class="amt num ${s.paid ? "paid" : ""}">${fmt(s.amt)}</span>
     ${staff ? `<button class="btn ${s.paid ? "" : "primary"}" data-paid="${s.pid}" data-t="${t.table}">${s.paid ? "Undo" : "Mark paid"}</button>` : s.paid ? `<span class="pill s-ready">Paid</span>` : ""}</div></div>`).join("")}
   <div class="total"><span>Table total</span><span class="num">TSh ${fmt(total)}</span></div>
   ${t.split === "equal" ? `<p class="note">Equal shares round up to the nearest 100 shillings.</p>` : ""}`;
}
async function setSplit(n, mode) { try { await updateDoc(tableRef(n), { split: mode }); } catch (e) { fail(e); } }
async function togglePaid(n, pid, now) { try { await updateDoc(tableRef(n), { [`paid.${pid}`]: now ? deleteField() : true }); } catch (e) { fail(e); } }

// ---------- router ----------
const view = location.hash.slice(1);
window.addEventListener("hashchange", () => location.reload());
const params = new URLSearchParams(location.search);
if (STATIONS[view]) stationScreen(view);
else if (view === "waiter") waiterScreen();
else if (view === "setup") setupScreen();
else dinerScreen();

// ================= DINER =================
function dinerScreen() {
  const S = { n: params.get("t"), t: null, lines: [], alerts: [], me: null, cart: [], note: "", cat: 0, tab: "menu", name: "", code: "" };
  let unsub = [];
  const meKey = () => `dees-me-${S.n}`;

  async function start() {
    if (!S.n && params.get("c")) return findByCode(params.get("c"));
    if (!S.n) return codeEntry();
    $("#sub").textContent = `Table ${S.n}`;
    try { await ensureSession(S.n); } catch (e) { return paint(errorBox(e)); }
    unsub.push(onSnapshot(tableRef(S.n), (snap) => {
      const prev = S.t && S.t.session; S.t = snap.data() || null;
      if (S.t && S.t.session && S.t.session !== prev) listen(S.t.session);
      const saved = store.get(meKey());
      S.me = S.t && saved && saved.session === S.t.session && S.t.people && S.t.people[saved.pid] ? saved : null;
      render();
    }, (e) => paint(errorBox(e))));
  }
  let subLines = null, subAlerts = null;
  function listen(session) {
    subLines && subLines(); subAlerts && subAlerts();
    subLines = onSnapshot(query(linesCol, where("session", "==", session)), (s) => { S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.t - b.t); render(); });
    const acked = new Set(); let primed = false;
    subAlerts = onSnapshot(query(alertsCol, where("session", "==", session)), (s) => {
      S.alerts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      S.alerts.forEach((a) => { if (a.ack && !a.done && !acked.has(a.id)) { acked.add(a.id); if (primed) { try { navigator.vibrate?.(300); } catch {} } } });
      primed = true; render();
    });
  }
  async function findByCode(c) {
    paint(`<p class="empty">Finding table…</p>`);
    try {
      const s = await getDocs(query(tablesCol, where("code", "==", String(c).trim())));
      const hit = s.docs.map((d) => d.data()).find((t) => t.session);
      if (!hit) { S.err = "No open table with that code. Check the number with your friend."; return codeEntry(); }
      history.replaceState(null, "", `${BASE}?t=${hit.table}`); S.n = String(hit.table); start();
    } catch (e) { paint(errorBox(e)); }
  }
  function codeEntry() {
    $("#sub").textContent = "Join a table";
    paint(`<section><div class="label">Join your friends</div>
      <p>Enter the 4-digit table code they shared, or scan the QR code on your table.</p>
      <form id="codeform" class="grid"><input class="field num" id="codein" inputmode="numeric" maxlength="4" placeholder="Table code" autocomplete="off">
      <button class="btn primary big">Join table</button></form>${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}</section>`);
  }
  function render() {
    if (!S.n) return;
    if (!S.t || !S.t.session) {
      $("#cart").hidden = true;
      return paint(`<section><p class="empty">This table has been closed. Thanks for visiting!</p><button class="btn primary big" data-act="newsession">Start a new order at table ${esc(S.n)}</button></section>`);
    }
    if (!S.me) {
      $("#cart").hidden = true;
      const names = Object.values(S.t.people || {}).map((p) => esc(p.name));
      return paint(`<section><div class="tablebar"><b>Table ${esc(S.n)}</b><span class="note" style="margin:0">${names.length ? `With ${names.join(", ")}` : "You're the first one here"}</span></div>
        <div class="label">What's your name?</div>
        <form id="joinform" class="grid"><input class="field" id="namein" maxlength="16" placeholder="First name" autocomplete="given-name" value="${esc(S.name)}">
        <button class="btn primary big">Join table</button></form>
        <p class="note">Your name shows on your orders so the table can split the bill.</p></section>`);
    }
    const t = S.t, open = S.alerts.filter((a) => !a.done);
    const banners = open.filter((a) => a.ack).map((a) => `<div class="ontheway" role="status"><span>${esc(wname(a.ackBy) || "Your waiter")} ${a.type === "bill" ? "is bringing your bill" : "is on the way to your table"}</span><span class="note">${ago(a.ack)}</span></div>`).join("");
    const tabs = [["menu", "Menu"], ["orders", `Table order${S.lines.length ? ` (${S.lines.length})` : ""}`], ["bill", "Bill"]];
    let body = "";
    if (S.tab === "menu") {
      const cat = MENU[S.cat];
      body = `<div class="cats">${MENU.map((m, i) => `<button class="chip" aria-pressed="${i === S.cat}" data-cat="${i}">${m.c}</button>`).join("")}</div>
       ${cat.items.map((it, ii) => `<div class="item"><h3>${esc(it.n)}</h3>${it.d ? `<p class="d">${esc(it.d)}</p>` : ""}${it.m ? `<div class="meta">${esc(it.m)}</div>` : ""}
       <div class="vars">${it.v.map(([l, p], vi) => `<button class="var" data-add="${S.cat}.${ii}.${vi}">${l ? esc(l) + " " : "Add "}<span class="num">TSh ${fmt(p)}</span></button>`).join("")}</div></div>`).join("")}`;
    } else if (S.tab === "orders") {
      const ppl = Object.entries(t.people || {});
      body = ppl.map(([pid, p]) => { const ls = S.lines.filter((l) => l.pid === pid);
        return `<div class="who">${esc(p.name)}${pid === S.me.pid ? " (you)" : ""}</div>` + (ls.length ? ls.map((l) => `<div class="oline"><span class="l">${label(l)}</span><span class="pill s-${l.s}">${l.s}</span></div>`).join("") : `<p class="note" style="margin:2px 0">Nothing yet</p>`); }).join("");
    } else body = billHtml(t, S.lines, false) + `<p class="note">Pay your waiter as usual. In-app mobile money comes later.</p>`;
    paint(`<section>
      <div class="tablebar"><div><b>Table ${esc(S.n)}</b><div class="note" style="margin:2px 0 0">Hi ${esc(S.me.name)} · friends join with code</div></div>
       <div class="row"><span class="code num">${esc(t.code)}</span><button class="btn" data-act="share">Share</button></div></div>
      ${banners}
      <div class="waitbar"><div><div class="note" style="margin:0">Your waiter</div><b>${t.waiter ? esc(wname(t.waiter)) : "Being assigned…"}</b></div>
       <div class="row">${Object.entries(ALERT).map(([k, l]) => { const a = open.find((x) => x.type === k);
         return `<button class="btn${a ? "" : " primary"}" data-alert="${k}" ${a ? "disabled" : ""}>${a ? (a.ack ? "On the way" : k === "call" ? "Waiter called" : "Bill requested") : l}</button>`; }).join("")}</div></div>
      <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button aria-pressed="${S.tab === k}" data-tab="${k}">${l}</button>`).join("")}</div>
      ${body}</section>`);
    renderCart();
  }
  function renderCart() {
    const c = $("#cart"); if (!S.me || S.tab !== "menu" || !S.cart.length) { c.hidden = true; c.innerHTML = ""; return; }
    const tot = S.cart.reduce((a, l) => a + l.pr, 0); c.hidden = false;
    const a = document.activeElement, focused = a && a.id === "note";
    c.innerHTML = `<div class="in">${S.cart.map((l, i) => `<div class="cline"><span>${label(l)}</span><span class="num">${fmt(l.pr)} <button data-rm="${i}" aria-label="Remove">Remove</button></span></div>`).join("")}
      <input id="note" placeholder="Note for the kitchen or bar (e.g. no onions)" value="${esc(S.note)}">
      <button class="cartbtn" data-act="place" ${S.placing ? "disabled" : ""}><span>${S.placing ? "Sending…" : "Place order"}</span><span class="num">TSh ${fmt(tot)}</span></button></div>`;
    if (focused) $("#note").focus();
  }

  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "codeform") { const c = $("#codein").value.trim(); if (c.length === 4) findByCode(c); }
    if (e.target.id === "joinform") {
      const name = $("#namein").value.trim(); if (!name) return;
      const pid = uid("p");
      try { await updateDoc(tableRef(S.n), { [`people.${pid}`]: { name, t: Date.now() } });
        store.set(meKey(), { pid, name, session: S.t.session }); S.me = { pid, name, session: S.t.session }; render();
      } catch (err) { fail(err); }
    }
  });
  document.addEventListener("input", (e) => { if (e.target.id === "note") S.note = e.target.value; if (e.target.id === "namein") S.name = e.target.value; });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.tab) { S.tab = d.tab; render(); window.scrollTo(0, 0); }
    else if (d.cat) { S.cat = +d.cat; render(); }
    else if (d.add) { const [c, i, v] = d.add.split(".").map(Number), it = MENU[c].items[i], [l, p] = it.v[v];
      S.cart.push({ n: it.n, v: l, pr: p, st: MENU[c].st }); toast(`Added ${it.n}`); renderCart(); }
    else if (d.rm) { S.cart.splice(+d.rm, 1); renderCart(); }
    else if (d.split) setSplit(S.n, d.split);
    else if (d.alert) {
      try { await addDoc(alertsCol, { table: Number(S.n), session: S.t.session, type: d.alert, pid: S.me.pid, pname: S.me.name, t: Date.now(), ack: null, ackBy: null, done: false });
        toast(S.t.waiter ? `${wname(S.t.waiter)} has been notified` : "All waiters notified"); } catch (err) { fail(err); }
    }
    else if (d.act === "place" && S.cart.length && !S.placing) {
      S.placing = true; renderCart();
      const batch = writeBatch(db), bid = uid("b"), now = Date.now();
      S.cart.forEach((l) => batch.set(doc(linesCol), { table: Number(S.n), session: S.t.session, batch: bid, pid: S.me.pid, pname: S.me.name,
        n: l.n, v: l.v, pr: l.pr, st: l.st, s: "new", t: now, note: S.note.trim() || null }));
      try { await batch.commit(); const sts = [...new Set(S.cart.map((l) => STATIONS[l.st]))]; S.cart = []; S.note = ""; toast("Sent to " + sts.join(" and ")); }
      catch (err) { fail(err); }
      S.placing = false; render();
    }
    else if (d.act === "share") {
      const link = `${BASE}?t=${S.n}`, txt = `Join our table at Crafty Dee's: ${link} (table code ${S.t.code})`;
      try { if (navigator.share) { await navigator.share({ text: txt }); return; } } catch { return; }
      try { await navigator.clipboard.writeText(txt); toast("Invite copied. Paste it in WhatsApp."); } catch { toast(`Table code: ${S.t.code}`); }
    }
    else if (d.act === "newsession") { try { await ensureSession(S.n); } catch (err) { fail(err); } }
  });
  setInterval(() => { if (S.alerts.some((a) => a.ack && !a.done)) render(); }, 30000);
  start();
}

// ================= STATION (kitchen / bar / grill) =================
function stationScreen(st) {
  $("#wrap").classList.add("wide"); $("#sub").textContent = STATIONS[st] + " screen"; document.title = STATIONS[st] + " · Crafty Dee's";
  const S = { lines: [], tables: {} }; const notify = watcher();
  onSnapshot(query(linesCol, where("st", "==", st)), (s) => {
    S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => l.s !== "served");
    notify(S.lines.filter((l) => l.s === "new").map((l) => l.batch)); render();
  }, (e) => paint(errorBox(e)));
  onSnapshot(tablesCol, (s) => { S.tables = {}; s.docs.forEach((d) => (S.tables[d.id] = d.data())); render(); });
  const NEXT = { new: ["preparing", "Start"], preparing: ["ready", "Ready"] };
  function render() {
    const batches = [...new Set(S.lines.sort((a, b) => a.t - b.t).map((l) => l.batch))];
    const tix = batches.map((b) => {
      const bl = S.lines.filter((l) => l.batch === b), s = bl.some((l) => l.s === "new") ? "new" : bl.some((l) => l.s === "preparing") ? "preparing" : "ready";
      const nx = NEXT[s], note = bl.find((l) => l.note), w = (S.tables[bl[0].table] || {}).waiter;
      return `<article class="ticket ${s}"><header><b>Table ${bl[0].table}</b><span class="note" style="margin:0">${esc(bl[0].pname)} · ${ago(bl[0].t)}</span></header>
        <div class="note" style="margin:2px 0 0">Waiter: ${w ? esc(wname(w)) : "not assigned yet"}</div>
        <ul>${bl.map((l) => `<li><span class="q">1×</span>${label(l)}</li>`).join("")}</ul>${note ? `<div class="nt">${esc(note.note)}</div>` : ""}
        <div class="acts"><span class="pill s-${s}">${s === "ready" ? "Waiting for waiter" : s}</span>${nx ? `<button class="btn primary" data-adv="${b}" data-to="${nx[0]}">${nx[1]}</button>` : ""}</div></article>`;
    });
    paint(soundBar() + (tix.length ? `<section class="grid">${tix.join("")}</section>` : `<p class="empty">No open orders for the ${STATIONS[st]}.</p>`));
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.act === "sound") { await enableSound(); render(); }
    if (d.adv) { b.disabled = true; const batch = writeBatch(db);
      S.lines.filter((l) => l.batch === d.adv && l.s !== "ready").forEach((l) => batch.update(doc(db, "lines", l.id), { s: d.to }));
      try { await batch.commit(); } catch (err) { fail(err); b.disabled = false; } }
  });
  setInterval(render, 30000);
}

// ================= WAITER =================
function waiterScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Waiter"; document.title = "Waiter · Crafty Dee's";
  const S = { me: store.get("dees-waiter"), tables: [], lines: [], alerts: [], open: null, confirm: null };
  const notify = watcher();
  onSnapshot(tablesCol, (s) => { S.tables = s.docs.map((d) => d.data()).filter((t) => t.session).sort((a, b) => a.table - b.table); update(); }, (e) => paint(errorBox(e)));
  onSnapshot(query(linesCol, where("s", "in", ["new", "preparing", "ready"])), (s) => { S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })); update(); });
  onSnapshot(query(alertsCol, where("done", "==", false)), (s) => { S.alerts = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.t - b.t); update(); });
  // Bill totals need every line of open tables, including served ones.
  let billSub = null, billLines = [];
  function watchBill(session) { billSub && billSub(); billLines = []; if (!session) return;
    billSub = onSnapshot(query(linesCol, where("session", "==", session)), (s) => { billLines = s.docs.map((d) => d.data()); render(); }); }

  const live = (t) => (x) => x.session === t.session;
  function mineOrFree(t) { return t.waiter === S.me || !t.waiter; }
  function update() {
    if (S.me) {
      const mine = S.tables.filter(mineOrFree);
      notify([
        ...S.tables.filter((t) => !t.waiter && Object.keys(t.people || {}).length).map((t) => "t" + t.session),
        ...S.alerts.filter((a) => mine.some((t) => live(t)(a))).map((a) => "a" + a.id),
        ...S.lines.filter((l) => l.s === "ready" && mine.some((t) => live(t)(l))).map((l) => "l" + l.id),
      ]);
    }
    render();
  }
  function render() {
    const pick = `<div class="label" style="margin-top:0">I am</div><div class="row">${WAITERS.map((w) => `<button class="chip" aria-pressed="${w.id === S.me}" data-me="${w.id}">${esc(w.name)}</button>`).join("")}</div>`;
    if (!S.me) return paint(`<section>${pick}<p class="note">Pick your name once. This phone remembers it.</p></section>`);
    const free = S.tables.filter((t) => !t.waiter && Object.keys(t.people || {}).length);
    const mine = S.tables.filter((t) => t.waiter === S.me);
    const others = S.tables.filter((t) => t.waiter && t.waiter !== S.me);
    const alertCard = (a, t) => `<article class="ticket alert"><header><b>${ALERT[a.type]}</b><span class="note" style="margin:0">${ago(a.t)}</span></header>
      <p class="note" style="margin:4px 0 0">Table ${t.table} · from ${esc(a.pname)}</p>
      <div class="acts">${a.ack ? `<span class="pill s-preparing">Diner notified</span><button class="btn primary" data-done="${a.id}">${a.type === "bill" ? "Bill delivered" : "Done"}</button>`
        : `<button class="btn primary" data-ack="${a.id}">On my way</button>`}${a.type === "bill" && t.waiter === S.me ? `<button class="btn" data-open="${t.table}">Open bill</button>` : ""}</div></article>`;
    const freeCards = free.map((t) => { const al = S.alerts.filter(live(t));
      return `<article class="ticket"><header><b>Table ${t.table}</b><span class="pill s-new">No waiter</span></header>
       <p class="note" style="margin:4px 0 0">${Object.values(t.people).map((p) => esc(p.name)).join(", ")} · opened ${ago(t.opened)}</p>
       <div class="acts"><button class="btn primary" data-accept="${t.table}">Accept table</button></div></article>` + al.map((a) => alertCard(a, t)).join(""); }).join("");
    const mineCards = mine.map((t) => {
      const al = S.alerts.filter(live(t)), ready = S.lines.filter((l) => live(t)(l) && l.s === "ready");
      const open = S.open === t.table;
      return `<article class="ticket preparing"><header><b>Table ${t.table}</b><span class="note" style="margin:0">code ${esc(t.code)}</span></header>
        <p class="note" style="margin:4px 0 0">${Object.values(t.people || {}).map((p) => esc(p.name)).join(", ") || "No guests yet"}</p>
        ${ready.map((l) => `<div class="oline"><span class="l">${label(l)} <span class="note">for ${esc(l.pname)} · ${STATIONS[l.st]}</span></span><button class="btn primary" data-serve="${l.id}">Served</button></div>`).join("")}
        <div class="acts"><button class="btn" data-open="${t.table}">${open ? "Hide bill" : "Bill"}</button><button class="btn ghost" data-release="${t.table}">Hand over</button>
          ${S.confirm === t.table ? `<button class="btn danger" data-close="${t.table}">Tap again to close</button>` : `<button class="btn ghost" data-confirm="${t.table}">Close table</button>`}</div>
        ${open ? billHtml(t, billLines, true) : ""}</article>` + al.map((a) => alertCard(a, t)).join("");
    }).join("");
    paint(`<section>${pick}${soundBar()}
      ${free.length ? `<div class="label">New tables · alerts go to every waiter</div><div class="grid">${freeCards}</div>` : ""}
      <div class="label">My tables</div>${mine.length ? `<div class="grid">${mineCards}</div>` : `<p class="note">No tables yet. Accept one when guests sit down.</p>`}
      ${others.length ? `<div class="label">Other waiters</div><p class="note">${others.map((t) => `Table ${t.table}: ${esc(wname(t.waiter))}`).join(" · ")}</p>` : ""}
    </section>`);
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    try {
      if (d.act === "sound") { await enableSound(); render(); }
      else if (d.me) { S.me = d.me; store.set("dees-waiter", d.me); update(); }
      else if (d.accept) { await runTransaction(db, async (tx) => { const s = await tx.get(tableRef(d.accept)); if (s.data().waiter) throw new Error("taken"); tx.update(tableRef(d.accept), { waiter: S.me }); }); toast(`Table ${d.accept} is yours`); }
      else if (d.release) { await updateDoc(tableRef(d.release), { waiter: null }); toast(`Table ${d.release} is open for another waiter`); }
      else if (d.ack) { await updateDoc(doc(db, "alerts", d.ack), { ack: Date.now(), ackBy: S.me }); toast("Diner told you're on the way"); }
      else if (d.done) await updateDoc(doc(db, "alerts", d.done), { done: true });
      else if (d.serve) await updateDoc(doc(db, "lines", d.serve), { s: "served" });
      else if (d.open) { const n = +d.open; S.open = S.open === n ? null : n; watchBill(S.open ? S.tables.find((t) => t.table === n)?.session : null); render(); }
      else if (d.split) await setSplit(d.t, d.split);
      else if (d.paid) { const t = S.tables.find((x) => x.table === +d.t); await togglePaid(d.t, d.paid, !!(t.paid || {})[d.paid]); }
      else if (d.confirm) { S.confirm = +d.confirm; render(); setTimeout(() => { if (S.confirm === +d.confirm) { S.confirm = null; render(); } }, 4000); }
      else if (d.close) { await closeTable(+d.close); S.confirm = null; if (S.open === +d.close) { S.open = null; watchBill(null); } toast(`Table ${d.close} closed`); }
    } catch (err) { if (err.message === "taken") toast("Another waiter just took that table"); else fail(err); }
  });
  async function closeTable(n) {
    const t = S.tables.find((x) => x.table === n); if (!t) return;
    const batch = writeBatch(db);
    S.lines.filter(live(t)).forEach((l) => batch.update(doc(db, "lines", l.id), { s: "served" }));
    S.alerts.filter(live(t)).forEach((a) => batch.update(doc(db, "alerts", a.id), { done: true }));
    batch.set(tableRef(n), { table: n, code: null, session: null, waiter: null, people: {}, split: "order", paid: {}, closed: Date.now() });
    await batch.commit();
  }
  setInterval(render, 30000);
}

// ================= SETUP =================
function setupScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Setup"; document.title = "Setup · Crafty Dee's";
  const link = (h, l) => `<div><div class="note" style="margin:0">${l}</div><a href="${h}">${esc(h)}</a></div>`;
  let armed = false;
  function render() {
    paint(`<section><div class="label" style="margin-top:0">Staff screens · open each on its own phone</div>
      <div class="links">${link(BASE + "#waiter", "Waiter")}${Object.entries(STATIONS).map(([k, v]) => link(BASE + "#" + k, v)).join("")}</div>
      <div class="label">Table QR codes · diners scan these</div>
      <div class="qrs">${Array.from({ length: TABLE_COUNT }, (_, i) => `<div class="qr"><div class="box" id="qr${i + 1}"></div><b>Table ${i + 1}</b><a class="note" href="${BASE}?t=${i + 1}">Open</a></div>`).join("")}</div>
      <p class="note">Screenshot a code, or open this page on a laptop and show it, for the demo table.</p>
      <div class="label">Demo</div>
      <p>Clear all orders, alerts and tables so the next demo starts fresh.</p>
      <button class="btn danger" data-act="reset">${armed ? "Tap again to erase everything" : "Reset demo"}</button></section>`);
    const draw = () => { for (let i = 1; i <= TABLE_COUNT; i++) { const el = document.getElementById("qr" + i); if (el && !el.childNodes.length) new QRCode(el, { text: `${BASE}?t=${i}`, width: 132, height: 132, correctLevel: QRCode.CorrectLevel.M }); } };
    if (window.QRCode) draw(); else window.addEventListener("load", draw, { once: true });
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.act !== "reset") return;
    if (!armed) { armed = true; render(); setTimeout(() => { armed = false; render(); }, 4000); return; }
    b.disabled = true; b.textContent = "Erasing…";
    try {
      for (const col of [linesCol, alertsCol, tablesCol]) {
        const s = await getDocs(col); let batch = writeBatch(db), n = 0;
        for (const d of s.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
        await batch.commit();
      }
      try { Object.keys(localStorage).filter((k) => k.startsWith("dees-me-")).forEach((k) => localStorage.removeItem(k)); } catch {}
      toast("Demo reset");
    } catch (err) { fail(err); }
    armed = false; render();
  });
  render();
}

function errorBox(e) {
  const denied = String(e && (e.code || e.message)).includes("permission");
  return `<section><div class="err">${denied
    ? "The database refused the request. In Firebase, open Firestore Database → Rules and check the demo rules are published."
    : "Can't reach the database. Check your internet connection, then reload."}</div><p class="note">${esc(e && (e.code || e.message))}</p></section>`;
}
