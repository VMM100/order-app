// Order App: one page, several screens chosen by the link.
//   index.html?t=4        diner at table 4 (what the table QR code opens)
//   index.html?c=4821     diner joining a friend's table by code
//   index.html#waiter     waiter phone
//   index.html#kitchen    kitchen screen (also #bar, #grill)
//   index.html#setup      links, table QR codes and demo reset
//   index.html#owner      owner: dashboard, menu, look, staff, PINs (owner PIN)
//   index.html#manager    manager: menu and staff only (manager PIN)
import { db } from "./firebase.js";
import {
  doc, collection, query, where, onSnapshot, getDocs, runTransaction,
  updateDoc, addDoc, writeBatch, deleteField, setDoc, getDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { MENU as START_MENU, STATIONS, WAITERS as START_WAITERS, TABLE_COUNT, RESTAURANT } from "./menu.js";
import { computeMetrics, sampleData } from "./metrics.js";

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
const label = (l) => esc(l.n) + (l.v ? ` · ${esc(l.v)}` : "");
const soldOut = (name) => MENU.some((c) => c.items.some((it) => it.n === name && it.out));
const wname = (id) => (WAITERS.find((w) => w.id === id) || {}).name || (id ? "Former staff" : "");

function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2200); }
function fail(e) { console.error(e); toast("Could not save. Check your connection and try again."); }

// Re-render without losing what someone is typing.
function paint(html) {
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  $("#view").innerHTML = html;
  hydratePhotos();
  if (id) { const el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
}

// Sound + vibration for staff screens (browsers only allow sound after a tap).
// The chime is a regular audio file (built here as a WAV), not Web Audio: iPhones mute Web Audio
// when the silent switch is on, but they still play media files like this one.
let audio = null, wakeLock = null;
function chimeUrl() {
  const sr = 22050, dur = 1.1, n = Math.floor(sr * dur), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr, second = t >= 0.32, f = second ? 1319 : 988, tt = second ? t - 0.32 : t;
    const env = Math.min(1, tt / 0.004) * Math.exp(-tt * 5);
    const s = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) / 1.3;
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s * env * 0.95)) * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
async function keepAwake() { try { if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
async function enableSound() {
  const a = new Audio(chimeUrl()); a.preload = "auto"; a.volume = 1;
  try { await a.play(); audio = a; } catch { toast("The browser blocked sound. Tap the button again."); return; }
  keepAwake(); toast("Alerts on. Keep this screen open with the volume up.");
}
function beep() {
  try { navigator.vibrate?.([300, 100, 300]); } catch {}
  document.body.classList.remove("flash"); void document.body.offsetWidth; document.body.classList.add("flash");
  if (!audio) return;
  try { audio.currentTime = 0; const p = audio.play(); p && p.catch(() => {}); } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && audio) keepAwake(); });
const soundBar = () => audio
  ? `<div class="soundbar"><span>Alerts on</span><button class="btn" data-act="testsound">Test sound</button></div>`
  : `<div class="soundbar"><span>Tap to turn on sound alerts and keep the screen awake</span><button class="btn primary" data-act="sound">Turn on alerts</button></div>`;

// Tell staff screens when something new arrives (skips the first load).
function watcher() {
  const seen = new Set(); let primed = false;
  return (ids) => { let fresh = false; ids.forEach((id) => { if (!seen.has(id)) { seen.add(id); if (primed) fresh = true; } }); primed = true; if (fresh) beep(); };
}

// ---------- data ----------
const tablesCol = collection(db, "tables"), linesCol = collection(db, "lines"), alertsCol = collection(db, "alerts");
const tableRef = (n) => doc(db, "tables", String(n));
const sessionsCol = collection(db, "sessions");

// Menu, staff and owner PIN live in one database document the owner edits.
// Until the owner saves for the first time, the starting menu from menu.js is used.
// The database can't store a list inside a list, so prices are saved as {l, p} pairs.
const cfgRef = doc(db, "config", "restaurant");
let MENU = START_MENU, WAITERS = START_WAITERS, PIN = "1234", MPIN = "5678", CFG_SAVED = false;
let BRAND = { name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...(store.get("dees-brand") || {}) };
const cfgListeners = new Set();
const menuFromDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: (c.items || []).map((it) => ({ ...it, v: (it.v || []).map((x) => [x.l || "", Number(x.p) || 0]) })) }));
const menuToDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: c.items.map((it) => {
  const o = { n: it.n, v: it.v.map(([l, p]) => ({ l: l || "", p: Number(p) || 0 })) };
  if (it.d) o.d = it.d; if (it.m) o.m = it.m; if (it.out) o.out = true; if (it.img) o.img = it.img; return o; }) }));
onSnapshot(cfgRef, (snap) => {
  if (snap.exists()) { const d = snap.data(); if (d.sections) MENU = menuFromDb(d.sections); if (d.waiters) WAITERS = d.waiters; if (d.pin) PIN = d.pin; if (d.mpin) MPIN = d.mpin; if (d.brand) { BRAND = { name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...d.brand }; store.set("dees-brand", BRAND); } CFG_SAVED = true; }
  applyBrand();
  cfgListeners.forEach((f) => f());
}, () => {});
const saveConfig = () => setDoc(cfgRef, { sections: menuToDb(MENU), waiters: WAITERS, pin: PIN, mpin: MPIN, brand: BRAND, updated: Date.now() });

// ---------- branding: name, logo and two colours chosen by the owner ----------
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgb2hex = (c) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => rgb2hex(hex2rgb(a).map((x, i) => x + (hex2rgb(b)[i] - x) * t));
const lum = (h) => { const c = hex2rgb(h).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Nudge a colour toward black or white until it reads as text on the given background.
const readable = (c, bg, toward) => { let out = c; for (let t = 0.1; contrast(out, bg) < 4.5 && t <= 1; t += 0.1) out = mix(c, toward, t); return out; };
const inkOn = (c) => (contrast(c, "#ffffff") >= contrast(c, "#1b1408") ? "#ffffff" : "#1b1408");
function brandCss(c1, c2) {
  if (!c1 || !c2) return "";
  const L = { bg: "#f6f4ee", surface: "#ffffff" }, D = { bg: "#161812", surface: "#20231b" };
  const a1 = mix(c1, "#ffffff", lum(c1) < 0.04 ? 0.35 : 0.15), a2 = readable(c2, D.surface, "#ffffff");
  const light = `--accent:${c1};--accent-ink:${inkOn(c1)};--accent-soft:${mix(c1, L.surface, 0.84)};--hop:${readable(c2, L.surface, "#000000")};--hop-soft:${mix(c2, L.surface, 0.86)}`;
  const dark = `--accent:${a1};--accent-ink:${inkOn(a1)};--accent-soft:${mix(c1, D.bg, 0.72)};--hop:${a2};--hop-soft:${mix(c2, D.bg, 0.75)}`;
  return `:root{${light}}@media (prefers-color-scheme:dark){:root{${dark}}}`;
}
function applyBrand() {
  let el = document.getElementById("brandvars");
  if (!el) { el = document.createElement("style"); el.id = "brandvars"; document.head.appendChild(el); }
  el.textContent = brandCss(BRAND.c1, BRAND.c2) + fontCss(BRAND.font);
  if (BRAND.font && BRAND.font !== "brew" && FONTS[BRAND.font]) loadFonts("brandfont", [BRAND.font]);
  const h = $("#brandname"); if (h) h.textContent = BRAND.name || RESTAURANT;
  const lg = $("#brandlogo"); if (lg) { if (BRAND.logo) { lg.dataset.photo = BRAND.logo; lg.hidden = false; delete lg.dataset.done; hydratePhotos(); } else { lg.hidden = true; lg.removeAttribute("src"); } }
  document.title = (document.title.includes("·") ? document.title.split("·")[0] + "· " : "") + (BRAND.name || RESTAURANT);
}
const rname = () => BRAND.name || RESTAURANT;

// Font pairs: a heading face and a text face. "upper" sets headings in capitals (suits condensed and geometric faces).
const FONTS = {
  brew:    { name: "Brewhouse",    d: "Barlow Condensed",   b: "Work Sans",     upper: true,  dt: "sans-serif", bt: "sans-serif" },
  bistro:  { name: "Classic bistro", d: "Playfair Display", b: "Source Sans 3", upper: false, dt: "serif", bt: "sans-serif" },
  modern:  { name: "Modern cafe",  d: "Poppins",            b: "DM Sans",       upper: false, dt: "sans-serif", bt: "sans-serif" },
  coastal: { name: "Coastal",      d: "Josefin Sans",       b: "Nunito Sans",   upper: true,  dt: "sans-serif", bt: "sans-serif" },
  rustic:  { name: "Rustic grill", d: "Zilla Slab",         b: "Karla",         upper: false, dt: "serif", bt: "sans-serif" },
  elegant: { name: "Fine dining",  d: "Cormorant Garamond", b: "Montserrat",    upper: false, dt: "serif", bt: "sans-serif" },
  playful: { name: "Playful",      d: "Fredoka",            b: "Nunito",        upper: false, dt: "sans-serif", bt: "sans-serif" },
  street:  { name: "Street food",  d: "Oswald",             b: "Rubik",         upper: true,  dt: "sans-serif", bt: "sans-serif" },
};
const fam = (f, w) => "family=" + f.replace(/ /g, "+") + ":wght@" + w;
const fontsUrl = (keys) => "https://fonts.googleapis.com/css2?" + [...new Set(keys.flatMap((k) => [fam(FONTS[k].d, "600;700"), fam(FONTS[k].b, "400;500;600;700")]))].join("&") + "&display=swap";
const stack = (f, t) => `"${f}",${t === "serif" ? "Georgia,serif" : "system-ui,-apple-system,sans-serif"}`;
function fontCss(key) {
  const f = FONTS[key]; if (!f || key === "brew") return "";
  return `:root{--display:${stack(f.d, f.dt)};--body:${stack(f.b, f.bt)};--dcase:${f.upper ? "uppercase" : "none"}}`;
}
// One stylesheet link per font pair, so a problem with one font never blocks the others.
function loadFonts(id, keys) {
  keys.forEach((k) => {
    const lid = `${id}-${k}`; if (document.getElementById(lid)) return;
    const l = document.createElement("link"); l.rel = "stylesheet"; l.id = lid; l.href = fontsUrl([k]); document.head.appendChild(l);
  });
}

// ---------- photos (menu items and logo) ----------
// Stored as small compressed images in their own database documents, loaded once per phone.
const photoCache = new Map();
function hydratePhotos() {
  document.querySelectorAll("img[data-photo]").forEach(async (img) => {
    const id = img.dataset.photo; if (!id || img.dataset.done === id) return;
    img.dataset.done = id;
    if (!photoCache.has(id)) photoCache.set(id, getDoc(doc(db, "photos", id)).then((s) => (s.exists() ? s.data().data : null)).catch(() => null));
    const src = await photoCache.get(id);
    if (src && img.dataset.photo === id) { img.src = src; img.closest(".ph")?.classList.add("loaded"); } else if (!src) img.closest(".ph")?.classList.add("none");
  });
}
async function resizeImage(file, max, keepAlpha) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("unreadable")); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext("2d"); if (!keepAlpha) { g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(img, 0, 0, c.width, c.height);
    let out = keepAlpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.74);
    if (out.length > 700000) out = c.toDataURL("image/jpeg", 0.6);
    if (out.length > 900000) throw new Error("too big");
    return out;
  } finally { URL.revokeObjectURL(url); }
}
async function savePhoto(dataUrl, old) {
  const id = uid("ph"); await setDoc(doc(db, "photos", id), { data: dataUrl, t: Date.now() });
  photoCache.set(id, Promise.resolve(dataUrl));
  if (old) deleteDoc(doc(db, "photos", old)).catch(() => {});
  return id;
}

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

applyBrand();

// ---------- router ----------
const view = location.hash.slice(1);
window.addEventListener("hashchange", () => location.reload());
const params = new URLSearchParams(location.search);
if (STATIONS[view]) stationScreen(view);
else if (view === "waiter") waiterScreen();
else if (view === "setup") setupScreen();
else if (view === "owner") ownerScreen("owner");
else if (view === "manager") ownerScreen("manager");
else dinerScreen();

// ================= DINER =================
function dinerScreen() {
  const S = { n: params.get("t"), t: null, lines: [], alerts: [], me: null, cart: [], note: "", cat: 0, tab: "menu", name: params.get("name") || "", code: "" };
  let unsub = [];
  // On the demo page several diners share one browser, so each gets its own slot (?as=1, ?as=2).
  const meKey = () => `dees-me-${S.n}${params.get("as") ? "-" + params.get("as") : ""}`;

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
      if (S.cat >= MENU.length) S.cat = 0;
      const cat = MENU[S.cat] || { items: [] };
      body = `<div class="cats">${MENU.map((m, i) => `<button class="chip" aria-pressed="${i === S.cat}" data-cat="${i}">${m.c}</button>`).join("")}</div>
       ${cat.items.map((it, ii) => `<div class="item${it.out ? " out" : ""}${it.img ? " withph" : ""}">${it.img ? `<div class="ph"><img data-photo="${esc(it.img)}" alt="${esc(it.n)}" loading="lazy"></div>` : ""}<h3>${esc(it.n)}${it.out ? ` <span class="pill s-served">Sold out</span>` : ""}</h3>${it.d ? `<p class="d">${esc(it.d)}</p>` : ""}${it.m ? `<div class="meta">${esc(it.m)}</div>` : ""}
       ${it.out ? "" : `<div class="vars">${it.v.map(([l, p], vi) => `<button class="var" data-add="${S.cat}.${ii}.${vi}">${l ? esc(l) + " " : "Add "}<span class="num">TSh ${fmt(p)}</span></button>`).join("")}</div>`}</div>`).join("")}`;
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
    else if (d.add) { const [c, i, v] = d.add.split(".").map(Number), it = MENU[c]?.items[i]; if (!it || it.out || !it.v[v]) return render(); const [l, p] = it.v[v];
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
      const link = `${BASE}?t=${S.n}`, txt = `Join our table at ${rname()}: ${link} (table code ${S.t.code})`;
      try { if (navigator.share) { await navigator.share({ text: txt }); return; } } catch { return; }
      try { await navigator.clipboard.writeText(txt); toast("Invite copied. Paste it in WhatsApp."); } catch { toast(`Table code: ${S.t.code}`); }
    }
    else if (d.act === "newsession") { try { await ensureSession(S.n); } catch (err) { fail(err); } }
  });
  setInterval(() => { if (S.alerts.some((a) => a.ack && !a.done)) render(); }, 30000);
  cfgListeners.add(() => { S.cart = S.cart.filter((c) => !soldOut(c.n)); render(); });
  start();
}

// ================= STATION (kitchen / bar / grill) =================
function stationScreen(st) {
  $("#wrap").classList.add("wide"); $("#sub").textContent = STATIONS[st] + " screen"; document.title = STATIONS[st] + " · " + rname();
  const S = { lines: [], tables: {} }; const notify = watcher();
  onSnapshot(query(linesCol, where("s", "in", ["new", "preparing", "ready"])), (s) => {
    S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => l.st === st);
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
    if (d.act === "testsound") beep();
    if (d.adv) { b.disabled = true; const batch = writeBatch(db);
      S.lines.filter((l) => l.batch === d.adv && l.s !== "ready").forEach((l) => batch.update(doc(db, "lines", l.id), { s: d.to, [d.to === "preparing" ? "tPrep" : "tReady"]: Date.now() }));
      try { await batch.commit(); } catch (err) { fail(err); b.disabled = false; } }
  });
  setInterval(render, 30000);
}

// ================= WAITER =================
function waiterScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Waiter"; document.title = "Waiter · " + rname();
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
      else if (d.act === "testsound") beep();
      else if (d.me) { S.me = d.me; store.set("dees-waiter", d.me); update(); }
      else if (d.accept) { await runTransaction(db, async (tx) => { const s = await tx.get(tableRef(d.accept)); if (s.data().waiter) throw new Error("taken"); tx.update(tableRef(d.accept), { waiter: S.me, accepted: Date.now() }); }); toast(`Table ${d.accept} is yours`); }
      else if (d.release) { await updateDoc(tableRef(d.release), { waiter: null }); toast(`Table ${d.release} is open for another waiter`); }
      else if (d.ack) { await updateDoc(doc(db, "alerts", d.ack), { ack: Date.now(), ackBy: S.me }); toast("Diner told you're on the way"); }
      else if (d.done) await updateDoc(doc(db, "alerts", d.done), { done: true, doneAt: Date.now() });
      else if (d.serve) await updateDoc(doc(db, "lines", d.serve), { s: "served", tServed: Date.now(), servedBy: S.me });
      else if (d.open) { const n = +d.open; S.open = S.open === n ? null : n; watchBill(S.open ? S.tables.find((t) => t.table === n)?.session : null); render(); }
      else if (d.split) await setSplit(d.t, d.split);
      else if (d.paid) { const t = S.tables.find((x) => x.table === +d.t); await togglePaid(d.t, d.paid, !!(t.paid || {})[d.paid]); }
      else if (d.confirm) { S.confirm = +d.confirm; render(); setTimeout(() => { if (S.confirm === +d.confirm) { S.confirm = null; render(); } }, 4000); }
      else if (d.close) { await closeTable(+d.close); S.confirm = null; if (S.open === +d.close) { S.open = null; watchBill(null); } toast(`Table ${d.close} closed`); }
    } catch (err) { if (err.message === "taken") toast("Another waiter just took that table"); else fail(err); }
  });
  async function closeTable(n) {
    const t = S.tables.find((x) => x.table === n); if (!t) return;
    const all = await getDocs(query(linesCol, where("session", "==", t.session)));
    const batch = writeBatch(db), now = Date.now();
    // Items never marked served are closed without a serve time, so they don't skew the averages.
    S.lines.filter(live(t)).forEach((l) => batch.update(doc(db, "lines", l.id), { s: "served", closedUnserved: true }));
    S.alerts.filter(live(t)).forEach((a) => batch.update(doc(db, "alerts", a.id), { done: true, doneAt: now }));
    batch.set(doc(db, "sessions", t.session), { table: n, session: t.session, opened: t.opened, accepted: t.accepted || null, closed: now,
      waiter: t.waiter || null, guests: Object.keys(t.people || {}).length, total: tableTotal(all.docs.map((x) => x.data())),
      paid: Object.keys(t.paid || {}).length });
    batch.set(tableRef(n), { table: n, code: null, session: null, waiter: null, people: {}, split: "order", paid: {}, closed: Date.now() });
    await batch.commit();
  }
  setInterval(render, 30000);
  cfgListeners.add(render);
}

// ================= SETUP =================
function setupScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Setup"; document.title = "Setup · " + rname();
  const link = (h, l) => `<div><div class="note" style="margin:0">${l}</div><a href="${h}">${esc(h)}</a></div>`;
  let armed = false;
  function render() {
    paint(`<section><div class="label" style="margin-top:0">Staff screens · open each on its own phone</div>
      <div class="links">${link(BASE + "demo.html", "Demo stage: several phones on one iPad or laptop")}${link(BASE + "#owner", "Owner (dashboard, menu, look, staff)")}${link(BASE + "#manager", "Manager (menu and staff)")}${link(BASE + "#waiter", "Waiter")}${Object.entries(STATIONS).map(([k, v]) => link(BASE + "#" + k, v)).join("")}</div>
      <div class="label">Table QR codes · diners scan these</div>
      <div class="qrs">${Array.from({ length: TABLE_COUNT }, (_, i) => `<div class="qr"><div class="box" id="qr${i + 1}"></div><b>Table ${i + 1}</b><a class="note" href="${BASE}?t=${i + 1}">Open</a></div>`).join("")}</div>
      <p class="note">Screenshot a code, or open this page on a laptop and show it, for the demo table.</p>
      <div class="label">Demo</div>
      <p>Clear all orders, alerts, tables and dashboard history so the next demo starts fresh. The menu and staff list stay.</p>
      <button class="btn danger" data-act="reset">${armed ? "Tap again to erase everything" : "Reset demo"}</button></section>`);
    const draw = () => { for (let i = 1; i <= TABLE_COUNT; i++) { const el = document.getElementById("qr" + i); if (el && !el.childNodes.length) new QRCode(el, { text: `${BASE}?t=${i}`, width: 132, height: 132, correctLevel: QRCode.CorrectLevel.M }); } };
    if (window.QRCode) draw(); else window.addEventListener("load", draw, { once: true });
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.act !== "reset") return;
    if (!armed) { armed = true; render(); setTimeout(() => { armed = false; render(); }, 4000); return; }
    b.disabled = true; b.textContent = "Erasing…";
    try {
      for (const col of [linesCol, alertsCol, tablesCol, sessionsCol]) {
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

// ================= OWNER =================
// The owner sees everything. A manager (own PIN) sees only Menu and Staff, and can't change PINs.
function ownerScreen(role) {
  const owner = role === "owner", Title = owner ? "Owner" : "Manager";
  $("#wrap").classList.add("wide"); $("#sub").textContent = Title; document.title = Title + " · " + rname();
  let unlocked = false; try { unlocked = sessionStorage.getItem("dees-" + role) === "1"; } catch {}
  const TABS = owner ? [["dash", "Dashboard"], ["menu", "Menu"], ["brand", "Look"], ["staff", "Staff"]] : [["menu", "Menu"], ["staff", "Staff"]];
  const S = { tab: TABS[0][0], edit: null, period: "7", m: null, loading: false, armed: null, pending: false, busy: "" };
  const STN = Object.entries(STATIONS);

  const dur = (ms) => { if (ms == null) return "–"; const s = ms / 1000; if (s < 60) return Math.round(s) + " s";
    const m = s / 60; if (m < 60) return (m < 10 ? m.toFixed(1) : Math.round(m)) + " min"; return Math.floor(m / 60) + " h " + Math.round(m % 60) + " min"; };
  const editing = () => { const a = document.activeElement; return a && /^(INPUT|SELECT)$/.test(a.tagName) && $("#view").contains(a); };
  cfgListeners.add(() => { if (!unlocked) return; if (editing()) S.pending = true; else render(); });
  document.addEventListener("focusout", () => setTimeout(() => { if (S.pending && !editing()) { S.pending = false; render(); } }, 0));
  async function save(msg) { try { await saveConfig(); toast(msg || "Saved"); } catch (e) { fail(e); } }
  const arm = (key) => { S.armed = key; render(); setTimeout(() => { if (S.armed === key) { S.armed = null; render(); } }, 4000); };

  function render() {
    if (!unlocked) return paint(`<section><div class="label" style="margin-top:0">${Title} PIN</div>
      <form id="pinform" class="grid" style="max-width:320px"><input class="field num" id="pinin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" autocomplete="off">
      <button class="btn primary big">Open ${Title.toLowerCase()} page</button></form>
      <p class="note">${CFG_SAVED ? (owner ? "Ask the owner for the PIN." : "Ask the owner for the manager PIN.") : owner ? "First time? The starting PIN is 1234. Change it under Staff." : "First time? The starting manager PIN is 5678. The owner can change it."}</p></section>`);
    if (!TABS.some(([k]) => k === S.tab)) S.tab = TABS[0][0];
    paint(`<div class="seg" role="tablist" style="max-width:520px">${TABS.map(([k, l]) => `<button aria-pressed="${S.tab === k}" data-otab="${k}">${l}</button>`).join("")}</div>
      ${S.tab === "menu" ? menuTab() : S.tab === "staff" ? staffTab() : owner && S.tab === "brand" ? brandTab() : owner ? dashTab() : menuTab()}`);
  }

  // ----- menu editor -----
  function menuTab() {
    const stationSel = (si, cur) => `<select class="field sel" id="ss-${si}" data-f="sst" data-si="${si}" aria-label="Station">${STN.map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${v}</option>`).join("")}</select>`;
    return `<section><p class="note" style="margin-top:0">Changes save as you go and reach diners' phones straight away. Use <b>Sold out</b> for anything that runs out tonight.</p>
      ${MENU.map((sec, si) => `<article class="ticket preparing ed">
        <div class="edhead"><input class="field" id="sn-${si}" data-f="sname" data-si="${si}" value="${esc(sec.c)}" aria-label="Section name">
          <label class="note" style="margin:0" for="ss-${si}">Goes to</label>${stationSel(si, sec.st)}</div>
        ${sec.items.map((it, ii) => { const k = `${si}.${ii}`, open = S.edit === k;
          return `<div class="edrow${it.out ? " out" : ""}">
            <div class="edsum"><div style="min-width:0"><b>${esc(it.n)}</b><div class="note" style="margin:0">${it.v.map(([l, p]) => (l ? esc(l) + " " : "") + fmt(p)).join(" · ")}</div></div>
              <div class="row" style="flex-wrap:nowrap"><button class="btn ${it.out ? "danger" : ""}" data-out="${k}" aria-pressed="${!!it.out}">${it.out ? "Sold out" : "Available"}</button>
              <button class="btn ghost" data-edit="${open ? "" : k}">${open ? "Close" : "Edit"}</button></div></div>
            ${open ? `<div class="edform">
              <label class="note" for="in-${si}-${ii}">Name</label><input class="field" id="in-${si}-${ii}" data-f="iname" data-si="${si}" data-ii="${ii}" value="${esc(it.n)}">
              <label class="note" for="id-${si}-${ii}">Description (optional)</label><input class="field" id="id-${si}-${ii}" data-f="idesc" data-si="${si}" data-ii="${ii}" value="${esc(it.d || "")}">
              <div class="note">Photo (optional)</div>
              <div class="row">${it.img ? `<div class="ph sm"><img data-photo="${esc(it.img)}" alt=""></div>` : ""}
                <label class="btn" for="pf-${si}-${ii}">${S.busy === "ph" + k ? "Uploading…" : it.img ? "Change photo" : "Add photo"}</label>
                <input type="file" accept="image/*" id="pf-${si}-${ii}" data-photofor="${k}" hidden>
                ${it.img ? `<button class="btn ghost" data-rmphoto="${k}">Remove photo</button>` : ""}</div>
              <label class="note" for="im-${si}-${ii}">Tag, e.g. Vegetarian or ABV 4.5% (optional)</label><input class="field" id="im-${si}-${ii}" data-f="itag" data-si="${si}" data-ii="${ii}" value="${esc(it.m || "")}">
              <div class="note">Prices · add a size or option name only if there's more than one</div>
              ${it.v.map(([l, p], vi) => `<div class="vrow"><input class="field" id="vl-${si}-${ii}-${vi}" data-f="vl" data-si="${si}" data-ii="${ii}" data-vi="${vi}" value="${esc(l)}" placeholder="Size or option" aria-label="Size or option">
                <input class="field num" id="vp-${si}-${ii}-${vi}" data-f="vp" data-si="${si}" data-ii="${ii}" data-vi="${vi}" value="${p}" inputmode="numeric" aria-label="Price in TSh">
                ${it.v.length > 1 ? `<button class="btn ghost" data-rmv="${k}.${vi}" aria-label="Remove price">Remove</button>` : ""}</div>`).join("")}
              <div class="row"><button class="btn" data-addv="${k}">Add price option</button>
                <button class="btn danger" data-delitem="${k}">${S.armed === "i" + k ? "Tap again to delete" : "Delete item"}</button></div></div>` : ""}
          </div>`; }).join("")}
        <div class="row" style="margin-top:10px"><button class="btn primary" data-additem="${si}">Add item</button>
          <button class="btn ghost" data-delsec="${si}">${S.armed === "s" + si ? `Tap again to delete section and its ${sec.items.length} items` : "Delete section"}</button></div>
      </article>`).join("")}
      <button class="btn" data-act="addsec" style="margin-top:12px">Add section</button></section>`;
  }

  // ----- look: name, logo, colours -----
  const PRESETS = [["Brewhouse", "#b9741a", "#3f5a2c"], ["Coastal", "#0f7c8c", "#e0603c"], ["Classic red", "#b3262e", "#3b3230"],
    ["Navy & gold", "#1f3a68", "#b58a2a"], ["Garden", "#3f7d3a", "#8a5a2b"], ["Sunset", "#e2572b", "#4a3f6b"]];
  function brandTab() {
    loadFonts("fontsamples", Object.keys(FONTS));
    const c1 = BRAND.c1 || "#b9741a", c2 = BRAND.c2 || "#3f5a2c";
    return `<section style="max-width:640px">
      <div class="label" style="margin-top:0"><label for="bname">Restaurant name</label></div>
      <input class="field" id="bname" data-f="bname" maxlength="40" value="${esc(BRAND.name || RESTAURANT)}">
      <div class="label">Logo</div>
      <div class="row">${BRAND.logo ? `<div class="ph logo"><img data-photo="${esc(BRAND.logo)}" alt="Current logo"></div>` : `<span class="note" style="margin:0">No logo yet</span>`}
        <label class="btn primary" for="logofile">${S.busy === "logo" ? "Uploading…" : BRAND.logo ? "Change logo" : "Upload logo"}</label>
        <input type="file" accept="image/*" id="logofile" hidden>
        ${BRAND.logo ? `<button class="btn ghost" data-act="rmlogo">Remove</button>` : ""}</div>
      <p class="note">Shows at the top of every screen. A logo on a transparent or white background works best.</p>
      <div class="label">Colours</div>
      <div class="row">${PRESETS.map(([n, a, b], i) => `<button class="chip preset" data-preset="${i}" aria-pressed="${BRAND.c1 === a && BRAND.c2 === b}"><span class="sw" style="background:${a}"></span><span class="sw" style="background:${b}"></span>${n}</button>`).join("")}</div>
      <div class="colors">
        <label class="colorpick" for="c1"><input type="color" id="c1" data-f="c1" value="${c1}"><span><b>Main colour</b><span class="note" style="display:block;margin:0">Buttons and highlights</span></span></label>
        <label class="colorpick" for="c2"><input type="color" id="c2" data-f="c2" value="${c2}"><span><b>Second colour</b><span class="note" style="display:block;margin:0">Table banner, labels, tags</span></span></label>
      </div>
      <p class="note">Pick colours from the restaurant's sign or menu. If a colour is too light or dark to read, the app adjusts the text shade automatically.</p>
      ${BRAND.c1 ? `<button class="btn ghost" data-act="resetcolors">Back to the original colours</button>` : ""}
      <div class="label">Fonts</div>
      <p class="note" style="margin-top:0">A heading font for names and titles, paired with an easy-to-read font for menu text.</p>
      <div class="fontopts">${Object.entries(FONTS).map(([k, f]) => `<button class="fontopt" data-font="${k}" aria-pressed="${(BRAND.font || "brew") === k}">
        <span class="fd" style="font-family:${esc(stack(f.d, f.dt))};text-transform:${f.upper ? "uppercase" : "none"}">${esc(BRAND.name || RESTAURANT)}</span>
        <span class="fb" style="font-family:${esc(stack(f.b, f.bt))}">Pilsner, full 400ml · TSh 10,000</span>
        <span class="fn">${esc(f.name)} · ${esc(f.d)} + ${esc(f.b)}</span></button>`).join("")}</div>
      <div class="label">Preview</div>
      <div class="preview"><div class="tablebar"><div><b>Table 4</b><div class="note" style="margin:2px 0 0">Hi Amani · friends join with code</div></div><span class="code num">4821</span></div>
        <div class="row" style="margin-top:10px"><button class="chip" aria-pressed="true" tabindex="-1">On tap</button><button class="chip" tabindex="-1">Cocktails</button></div>
        <div class="item"><h3>Pilsner</h3><div class="meta">ABV 4.6%</div><div class="vars"><span class="var">Full 400ml <span class="num">TSh 10,000</span></span></div></div>
        <span class="cartbtn" style="margin-top:10px"><span>Place order</span><span class="num">TSh 10,000</span></span></div>
    </section>`;
  }

  // ----- staff -----
  function staffTab() {
    return `<section><div class="label" style="margin-top:0">Waiters</div>
      <p class="note" style="margin-top:0">These names appear on the waiter phones${owner ? " and the dashboard" : ""}.</p>
      <div class="grid" style="max-width:520px">${WAITERS.map((w, i) => `<div class="vrow"><input class="field" id="wn-${i}" data-f="wname" data-i="${i}" value="${esc(w.name)}" aria-label="Waiter name">
        <button class="btn danger" data-delw="${i}">${S.armed === "w" + i ? "Tap again" : "Remove"}</button></div>`).join("")}</div>
      <form id="addw" class="vrow" style="max-width:520px;margin-top:10px"><input class="field" id="addwin" maxlength="20" placeholder="New waiter's name"><button class="btn primary">Add</button></form>
      ${owner ? `<div class="label">Owner PIN</div>
      <form id="pinchange" class="vrow" style="max-width:520px"><input class="field num" id="newpin" type="password" inputmode="numeric" maxlength="6" placeholder="New owner PIN, 4 to 6 digits" autocomplete="new-password"><button class="btn">Change</button></form>
      <div class="label">Manager PIN</div>
      <form id="mpinchange" class="vrow" style="max-width:520px"><input class="field num" id="newmpin" type="password" inputmode="numeric" maxlength="6" placeholder="New manager PIN, 4 to 6 digits" autocomplete="new-password"><button class="btn">Change</button></form>
      <p class="note">Managers use <b>#manager</b> with their PIN and can only edit the menu and staff. The PINs keep diners and staff out during the demo; real sign-in comes before launch.</p>` : ""}</section>`;
  }

  // ----- dashboard -----
  async function load() {
    S.loading = true; render();
    const since = S.period === "all" ? 0 : S.period === "today" ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(S.period) * 864e5;
    try {
      const [ls, as, ss, ts] = await Promise.all([
        getDocs(since ? query(linesCol, where("t", ">=", since)) : linesCol),
        getDocs(since ? query(alertsCol, where("t", ">=", since)) : alertsCol),
        getDocs(since ? query(sessionsCol, where("closed", ">=", since)) : sessionsCol),
        getDocs(tablesCol)]);
      const open = ts.docs.map((d) => d.data()).filter((t) => t.session && Object.keys(t.people || {}).length);
      S.m = computeMetrics({ lines: ls.docs.map((d) => d.data()), alerts: as.docs.map((d) => d.data()), sessions: ss.docs.map((d) => d.data()),
        openTables: open, waiters: WAITERS, stations: STATIONS });
      S.loaded = Date.now();
    } catch (e) { S.m = null; S.err = e; }
    S.loading = false; render();
  }
  function bars(rows, key, lab) {
    const max = Math.max(...rows.map((r) => r[key]), 1);
    return `<div class="bars" role="img" aria-label="Bar chart">${rows.map((r) => `<div class="bar" title="${esc(lab(r))}: TSh ${fmt(r[key])}">
      <span class="bv num">${r[key] ? fmt(Math.round(r[key] / 1000)) + "k" : ""}</span><span class="bf" style="height:${Math.round((r[key] / max) * 100)}%"></span><span class="bl">${esc(lab(r))}</span></div>`).join("")}</div>`;
  }
  function dashTab() {
    const periods = [["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All time"]];
    const head = `<div class="row" style="margin-top:14px;justify-content:space-between"><div class="row">${periods.map(([k, l]) => `<button class="chip" aria-pressed="${S.period === k}" data-period="${k}">${l}</button>`).join("")}</div>
      <button class="btn ghost" data-act="reload">${S.loading ? "Loading…" : "Refresh"}</button></div>`;
    if (!S.m) { if (!S.loading && !S.err) load(); return head + (S.err ? errorBox(S.err) : `<p class="empty">Loading numbers…</p>`); }
    const m = S.m;
    const sampleNote = m.sample ? `<div class="soundbar" style="margin-top:12px"><span>Includes <b>sample data</b> for demonstration, not real sales.</span><button class="btn" data-act="unsample">${S.busy === "unsample" ? "Removing…" : "Remove sample data"}</button></div>` : "";
    if (!m.items) return head + `<section><p class="empty">No orders in this period yet.<br>Numbers appear here as soon as diners order.</p>
      <div style="text-align:center"><button class="btn" data-act="sample">${S.busy === "sample" ? "Adding…" : "Fill with a sample week for a demo"}</button>
      <p class="note">Sample orders are clearly marked and can be removed in one tap.</p></div></section>`;
    const kpi = (v, l, sub) => `<div class="kpi"><div class="kv num">${v}</div><div class="kl">${l}</div>${sub ? `<div class="note" style="margin:2px 0 0">${sub}</div>` : ""}</div>`;
    const hours = m.byHour.filter((h) => h.items); const h0 = hours.length ? hours[0].h : 12, h1 = hours.length ? hours.at(-1).h : 22;
    const hourRows = m.byHour.filter((h) => h.h >= h0 && h.h <= h1);
    const peak = hours.length ? hours.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null;
    return head + sampleNote + `<section>
      <div class="kpis">${kpi("TSh " + fmt(m.revenue), "Sales", `${fmt(m.items)} items · ${fmt(m.orders)} orders`)}${kpi(fmt(m.tables), "Tables", `${fmt(m.guests)} guests`)}
        ${kpi(m.avgBill ? fmt(Math.round(m.avgBill / 100) * 100) : "–", "Average bill", "per closed table")}${kpi(m.avgPerGuest ? fmt(Math.round(m.avgPerGuest / 100) * 100) : "–", "Spend per guest", "")}
        ${kpi(dur(m.toTable), "Order to table", "typical item")}${kpi(dur(m.tableTime), "Table stay", "typical visit")}</div>

      <div class="label">Speed</div>
      <div class="tablewrap"><table><thead><tr><th>Step</th><th>Typical</th><th>Slowest 10%</th><th>Count</th></tr></thead><tbody>
        ${STN.map(([k, v]) => `<tr><td>${v} prep (order → ready)</td><td class="num">${dur(m.prep[k].median)}</td><td class="num">${dur(m.prep[k].p90)}</td><td class="num">${fmt(m.prep[k].items)}</td></tr>`).join("")}
        <tr><td>Waiter pickup (ready → served)</td><td class="num">${dur(m.serve)}</td><td></td><td></td></tr>
        <tr><td>Order to table, all items</td><td class="num">${dur(m.toTable)}</td><td class="num">${dur(m.toTableP90)}</td><td></td></tr>
        <tr><td>Response to "Call waiter"</td><td class="num">${dur(m.callResp)}</td><td></td><td></td></tr>
        <tr><td>Response to "Bill please"</td><td class="num">${dur(m.billResp)}</td><td></td><td></td></tr>
      </tbody></table></div>
      ${m.unanswered ? `<p class="note">${m.unanswered} alert${m.unanswered > 1 ? "s" : ""} never got an "On my way".</p>` : ""}

      <div class="label">Waiters</div>
      ${m.waiters.length ? `<div class="tablewrap"><table><thead><tr><th>Waiter</th><th>Tables</th><th>Sales (TSh)</th><th>Call response</th><th>Bill response</th><th>Pickup</th></tr></thead><tbody>
        ${m.waiters.map((w) => `<tr><td>${esc(w.name)}</td><td class="num">${fmt(w.tables)}</td><td class="num">${fmt(w.sales)}</td><td class="num">${dur(w.callResp)}</td><td class="num">${dur(w.billResp)}</td><td class="num">${dur(w.serve)}</td></tr>`).join("")}
      </tbody></table></div><p class="note">Times are typical (median). Pickup is how long finished items wait before the waiter serves them.</p>` : `<p class="note">No waiter activity yet.</p>`}

      <div class="label">Sales by hour${peak ? ` · busiest ${String(peak.h).padStart(2, "0")}:00` : ""}</div>
      ${bars(hourRows, "revenue", (r) => String(r.h).padStart(2, "0"))}
      ${m.byDay.length > 1 ? `<div class="label">Sales by day</div>${bars(m.byDay, "revenue", (r) => { const d = new Date(r.day + "T12:00"); return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + d.getDate(); })}` : ""}

      <div class="label">Best sellers</div>
      <div class="tablewrap"><table><thead><tr><th>Item</th><th style="text-align:left">Station</th><th>Sold</th><th>Sales (TSh)</th></tr></thead><tbody>
        ${m.best.slice(0, 10).map((b) => `<tr><td>${esc(b.n)}</td><td>${esc(STATIONS[b.st] || "")}</td><td class="num">${fmt(b.qty)}</td><td class="num">${fmt(b.revenue)}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="note">Updated ${S.loaded ? ago(S.loaded) : ""}. Tap Refresh for the latest.</p></section>`;
  }
  async function writeAll(col, rows, idOf) {
    let batch = writeBatch(db), n = 0;
    for (const r of rows) { batch.set(idOf ? doc(db, col, idOf(r)) : doc(collection(db, col)), r); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
    await batch.commit();
  }

  // ----- events -----
  function at(d) { const sec = MENU[+d.si], it = sec && d.ii != null ? sec.items[+d.ii] : null; return { sec, it }; }
  document.addEventListener("change", (e) => {
    const el = e.target, d = el.dataset; if (!d.f || !unlocked) return;
    const v = el.value.trim(), { sec, it } = at(d);
    if (d.f === "sname" && sec) { if (!v) return render(); sec.c = v; }
    else if (d.f === "sst" && sec) sec.st = v;
    else if (d.f === "iname" && it) { if (!v) return render(); it.n = v; }
    else if (d.f === "idesc" && it) it.d = v;
    else if (d.f === "itag" && it) it.m = v;
    else if (d.f === "vl" && it) it.v[+d.vi][0] = v;
    else if (d.f === "vp" && it) { const p = Number(v.replace(/[^\d]/g, "")); if (!p) { toast("Enter a price in shillings"); return render(); } it.v[+d.vi][1] = p; }
    else if (!owner && ["bname", "c1", "c2"].includes(d.f)) return;
    else if (d.f === "bname") { BRAND = { ...BRAND, name: v || RESTAURANT }; applyBrand(); }
    else if (d.f === "c1" || d.f === "c2") { BRAND = { ...BRAND, c1: $("#c1").value, c2: $("#c2").value }; applyBrand(); render(); }
    else if (d.f === "wname") { if (!v) return render(); WAITERS = WAITERS.map((w, i) => (i === +d.i ? { ...w, name: v } : w)); }
    else return;
    save();
  });
  document.addEventListener("input", (e) => {
    if (!unlocked || (e.target.id !== "c1" && e.target.id !== "c2")) return;
    $("#brandvars").textContent = brandCss($("#c1").value, $("#c2").value);
  });
  document.addEventListener("change", async (e) => {
    const el = e.target; if (!unlocked || el.type !== "file" || !el.files || !el.files[0]) return;
    const file = el.files[0], isLogo = el.id === "logofile", k = el.dataset.photofor;
    if (isLogo && !owner) return;
    S.busy = isLogo ? "logo" : "ph" + k; render();
    try {
      const data = await resizeImage(file, isLogo ? 360 : 640, isLogo);
      if (isLogo) { BRAND = { ...BRAND, logo: await savePhoto(data, BRAND.logo) }; await saveConfig(); applyBrand(); toast("Logo updated"); }
      else { const [si, ii] = k.split(".").map(Number), it = MENU[si].items[ii]; it.img = await savePhoto(data, it.img); await saveConfig(); toast("Photo added"); }
    } catch (err) { if (err.message === "unreadable") toast("That file isn't a photo this phone can read. Try a JPG or PNG."); else if (err.message === "too big") toast("That image is too large. Try a smaller one."); else fail(err); }
    S.busy = ""; render();
  });
  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "pinform") {
      const v = $("#pinin").value.trim();
      if (v === PIN || (!owner && v === MPIN)) { unlocked = true; try { sessionStorage.setItem("dees-" + role, "1"); } catch {}
        if (!CFG_SAVED) save("Menu copied into the editor"); render(); }
      else { toast("Wrong PIN"); $("#pinin").value = ""; }
    }
    if (e.target.id === "addw") { const n = $("#addwin").value.trim(); if (!n) return; WAITERS = [...WAITERS, { id: uid("w"), name: n }]; save(`${n} added`); $("#addwin").value = ""; render(); }
    if (owner && e.target.id === "pinchange") { const p = $("#newpin").value.trim(); if (!/^\d{4,6}$/.test(p)) return toast("Use 4 to 6 digits"); PIN = p; save("Owner PIN changed"); $("#newpin").value = ""; }
    if (owner && e.target.id === "mpinchange") { const p = $("#newmpin").value.trim(); if (!/^\d{4,6}$/.test(p)) return toast("Use 4 to 6 digits"); if (p === PIN) return toast("Use a different PIN from the owner's"); MPIN = p; save("Manager PIN changed"); $("#newmpin").value = ""; }
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !unlocked) return; const d = b.dataset;
    const ix = (s) => s.split(".").map(Number);
    if (!owner && (d.font || d.preset || d.period || ["resetcolors", "rmlogo", "sample", "unsample", "reload"].includes(d.act))) return;
    if (d.otab) { if (!TABS.some(([k]) => k === d.otab)) return; S.tab = d.otab; S.edit = null; if (S.tab === "dash") S.m = null; render(); }
    else if (d.out) { const [si, ii] = ix(d.out), it = MENU[si].items[ii]; it.out = !it.out; render(); save(it.out ? `${it.n} marked sold out` : `${it.n} back on the menu`); }
    else if (d.edit !== undefined) { S.edit = d.edit || null; render(); }
    else if (d.addv) { const [si, ii] = ix(d.addv); MENU[si].items[ii].v.push(["", MENU[si].items[ii].v.at(-1)[1]]); render(); save(); }
    else if (d.rmv) { const [si, ii, vi] = ix(d.rmv); MENU[si].items[ii].v.splice(vi, 1); render(); save(); }
    else if (d.additem) { const si = +d.additem; MENU[si].items.push({ n: "New item", v: [["", 10000]] }); S.edit = `${si}.${MENU[si].items.length - 1}`; render(); save("Item added. Set its name and price."); }
    else if (d.delitem) { if (S.armed !== "i" + d.delitem) return arm("i" + d.delitem); const [si, ii] = ix(d.delitem); const n = MENU[si].items[ii].n; MENU[si].items.splice(ii, 1); S.edit = null; S.armed = null; render(); save(`${n} deleted`); }
    else if (d.delsec) { if (S.armed !== "s" + d.delsec) return arm("s" + d.delsec); MENU.splice(+d.delsec, 1); S.armed = null; render(); save("Section deleted"); }
    else if (d.act === "addsec") { MENU.push({ c: "New section", st: "kitchen", items: [] }); render(); save("Section added. Rename it and choose its station."); }
    else if (d.delw) { if (S.armed !== "w" + d.delw) return arm("w" + d.delw); const w = WAITERS[+d.delw]; WAITERS = WAITERS.filter((_, i) => i !== +d.delw); S.armed = null; render(); save(`${w.name} removed`); }
    else if (d.font) { BRAND = { ...BRAND, font: d.font }; applyBrand(); render(); save(`${FONTS[d.font].name} fonts applied`); }
    else if (d.preset) { const [, a, c] = PRESETS[+d.preset]; BRAND = { ...BRAND, c1: a, c2: c }; applyBrand(); render(); save("Colours updated"); }
    else if (d.act === "resetcolors") { BRAND = { ...BRAND, c1: null, c2: null }; applyBrand(); render(); save("Original colours back"); }
    else if (d.act === "rmlogo") { const old = BRAND.logo; BRAND = { ...BRAND, logo: null }; applyBrand(); render(); await save("Logo removed"); deleteDoc(doc(db, "photos", old)).catch(() => {}); }
    else if (d.rmphoto) { const [si, ii] = ix(d.rmphoto), it = MENU[si].items[ii], old = it.img; delete it.img; render(); await save("Photo removed"); deleteDoc(doc(db, "photos", old)).catch(() => {}); }
    else if (d.period) { S.period = d.period; S.m = null; S.err = null; render(); }
    else if (d.act === "reload") { S.m = null; S.err = null; render(); }
    else if (d.act === "sample" && !S.busy) {
      S.busy = "sample"; render();
      try { const x = sampleData(MENU, WAITERS, 7);
        await writeAll("lines", x.lines); await writeAll("alerts", x.alerts); await writeAll("sessions", x.sessions, (r) => r.session);
        toast("Sample week added"); } catch (err) { fail(err); }
      S.busy = ""; S.m = null; render();
    }
    else if (d.act === "unsample" && !S.busy) {
      S.busy = "unsample"; render();
      try { for (const col of [linesCol, alertsCol, sessionsCol]) {
          const s = await getDocs(query(col, where("sample", "==", true))); let batch = writeBatch(db), n = 0;
          for (const x of s.docs) { batch.delete(x.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
          await batch.commit(); }
        toast("Sample data removed"); } catch (err) { fail(err); }
      S.busy = ""; S.m = null; render();
    }
  });
  render();
}

function errorBox(e) {
  const denied = String(e && (e.code || e.message)).includes("permission");
  return `<section><div class="err">${denied
    ? "The database refused the request. In Firebase, open Firestore Database → Rules and check the demo rules are published."
    : "Can't reach the database. Check your internet connection, then reload."}</div><p class="note">${esc(e && (e.code || e.message))}</p></section>`;
}
