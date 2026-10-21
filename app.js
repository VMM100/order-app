// Order App: one page, several screens chosen by the link.
//   index.html?t=4        diner at table 4 (what the table QR code opens)
//   index.html?c=4821     diner joining a friend's table by code
//   index.html#waiter     waiter phone
//   index.html#kitchen    kitchen screen (also #bar, #grill)
//   index.html#setup      staff QR, table QR codes and demo reset (owner or manager)
//   index.html#owner      owner: dashboard, menu, look, staff, who can sign in (Google sign-in)
//   index.html#manager    manager: menu and staff only (Google sign-in)
// Who may see and change what is enforced by the database rules in firestore.rules.
import { db } from "./firebase.js";
import {
  doc, collection, query, where, onSnapshot, getDocs, runTransaction,
  updateDoc, addDoc, writeBatch, deleteField, setDoc, getDoc, deleteDoc, collectionGroup,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { MENU as START_MENU, STATIONS, WAITERS as START_WAITERS, TABLE_COUNT, RESTAURANT, RESTAURANT_ID } from "./menu.js";
import { auth, onUser, isAccount, ensureUser, authReady, googleSignIn, phoneStart, phoneConfirm, signOutUser, deleteMe, normalisePhone, authMessage } from "./account.js";
import { computeMetrics, sampleData } from "./metrics.js";
import { genericPhoto } from "./photos.js";
import { COMPANY } from "./platform.js";

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m / 60) + " h ago"; };
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
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
function fail(e) { console.error(e); toast(denied(e) ? "Not allowed from this phone." : "Could not save. Check your connection and try again."); }
const denied = (e) => String(e && (e.code || e.message)).includes("permission");

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
// Each restaurant on the platform has its own space: restaurants/{RID}/… holds its settings, tables,
// groups, orders, alerts and staff. RID comes from the link (?r=…), or for owners from their sign-in.
let RID = new URLSearchParams(location.search).get("r") || null;
let ACCOUNT = null;   // accounts/{RID}: status, paid-until date, owner (only owners/managers can read it)
const rcol = (name) => collection(db, "restaurants", RID, name);
const rdoc = (name, id) => doc(db, "restaurants", RID, name, String(id));
const tableRef = (n) => rdoc("tables", n);
// Diner accounts work across every restaurant on the platform. diners/{uid} is the profile;
// each visit is a document in visits, labelled with its restaurant (rid).
const dinersCol = collection(db, "diners"), visitsCol = collection(db, "visits");
const dinerRef = (u) => doc(db, "diners", u);
async function myVisits(u) { const s = await getDocs(query(visitsCol, where("uid", "==", u))); return s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.date - a.date); }
// What to suggest re-ordering: items on at least 2 of the last 5 visits ("Your usual"), most recent
// first; if nothing repeats, the last visit's order ("Last time"). Quantity in one night counts once.
// Only items still on the menu and not sold out, at today's price.
function usualFrom(visits) {
  const recent = [...visits].sort((a, b) => b.date - a.date).slice(0, 5);
  const onMenu = (n, v) => { let hit = null; MENU.forEach((sec) => sec.items.forEach((it) => { if (hit || it.n !== n || it.out) return; const opt = it.v.find(([l]) => (l || "") === v); if (opt) hit = { n, v, pr: opt[1], st: sec.st }; })); return hit; };
  const seen = {};
  recent.forEach((vis, rank) => new Set((vis.items || []).map((it) => it.n + "|" + (it.v || ""))).forEach((k) => {
    seen[k] ||= { k, visits: 0, last: rank }; seen[k].visits++; }));
  const pick = (keys) => keys.map((k) => { const [n, v] = k.split("|"); return onMenu(n, v); }).filter(Boolean).slice(0, 2);
  const usual = pick(Object.values(seen).filter((x) => x.visits >= 2).sort((a, b) => a.last - b.last || b.visits - a.visits).map((x) => x.k));
  if (usual.length) { usual.kind = "usual"; return usual; }
  const last = recent[0] ? pick([...new Set((recent[0].items || []).map((it) => it.n + "|" + (it.v || "")))]) : [];
  last.kind = "last"; return last;
}

// Each table has a secret key printed in its QR code, so a table can't be joined by guessing its number.
const keyRef = (n) => rdoc("tablekeys", String(n));
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
async function tableKey(n, rotate) {
  let k = null;
  await runTransaction(db, async (tx) => { const s = await tx.get(keyRef(n)); k = !rotate && s.exists() && s.data().k;
    if (!k) { k = newKey(); tx.set(keyRef(n), { k, t: Date.now() }); } });
  return k;
}
const tableLink = (n, k) => `${BASE}?r=${RID}&t=${n}&k=${k}`;

// Menu, staff and the restaurant's look live in one database document the owner edits.
// Until the owner saves for the first time, the starting menu from menu.js is used.
// The database can't store a list inside a list, so prices are saved as {l, p} pairs.
const cfgRef = () => doc(db, "restaurants", RID);
let MENU = START_MENU, WAITERS = START_WAITERS, SHARED = [], CFG_SAVED = false, CFG_STALE = false;
let BRAND = { name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...((RID && store.get("dees-brand-" + RID)) || {}) };
let TABLES = TABLE_COUNT, PAUSED = false;
const cfgListeners = new Set();
// Resolves once the restaurant settings (menu, shared tables…) have loaded, or failed to.
let cfgLoaded; const cfgReady = new Promise((r) => (cfgLoaded = r));
const menuFromDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: (c.items || []).map((it) => ({ ...it, v: (it.v || []).map((x) => [x.l || "", Number(x.p) || 0]) })) }));
const menuToDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: c.items.map((it) => {
  const o = { n: it.n, v: it.v.map(([l, p]) => ({ l: l || "", p: Number(p) || 0 })) };
  if (it.d) o.d = it.d; if (it.m) o.m = it.m; if (it.out) o.out = true; if (it.img) o.img = it.img; return o; }) }));
// New restaurants start with two empty sections; the demo restaurant starts with Crafty Dee's menu.
const starterMenu = () => (RID === RESTAURANT_ID ? START_MENU : [{ c: "Drinks", st: "bar", items: [] }, { c: "Food", st: "kitchen", items: [] }]);
let cfgStarted = false;
function startConfig() {
  if (cfgStarted || !RID) return; cfgStarted = true;
  if (RID !== RESTAURANT_ID) { MENU = starterMenu(); WAITERS = []; }
  onSnapshot(cfgRef(), (snap) => {
    PAUSED = false;
    if (snap.exists()) { const d = snap.data(); if (d.sections) MENU = menuFromDb(d.sections); if (d.waiters) WAITERS = d.waiters; CFG_STALE = !d.prices || "pin" in d || "mpin" in d; SHARED = d.shared || []; if (d.tables) TABLES = d.tables; if (d.brand) { BRAND = { name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...d.brand }; store.set("dees-brand-" + RID, BRAND); } CFG_SAVED = true; }
    applyBrand();
    cfgLoaded(); cfgListeners.forEach((f) => f());
  }, (e) => { if (denied(e)) PAUSED = true; cfgLoaded(); cfgListeners.forEach((f) => f()); });
}
// prices: "item|option" → price and station, for available items only. The database rules check every
// order against it, so nobody can order something sold out or at a price they typed themselves.
const priceMap = (secs) => { const m = {}; secs.forEach((c) => c.items.forEach((it) => { if (!it.out) it.v.forEach(([l, p]) => (m[it.n + "|" + (l || "")] = { p: Number(p) || 0, st: c.st })); })); return m; };
const saveConfig = () => setDoc(cfgRef(), { sections: menuToDb(MENU), waiters: WAITERS, shared: SHARED, brand: BRAND, prices: priceMap(MENU), tables: TABLES, updated: Date.now() });

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
    if (!photoCache.has(id)) photoCache.set(id, getDoc(rdoc("photos", id)).then((s) => (s.exists() ? s.data().data : null)).catch(() => null));
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
  const id = uid("ph"); await setDoc(rdoc("photos", id), { data: dataUrl, t: Date.now() });
  photoCache.set(id, Promise.resolve(dataUrl));
  if (old) deleteDoc(rdoc("photos", old)).catch(() => {});
  return id;
}

// ---------- groups ----------
// A group is one party ordering and paying together. Small tables have one group at a time;
// tables the owner marks as shared can hold several groups, each with its own code and bill.
const groupRef = (sid) => rdoc("groups", sid);
const isShared = (n) => SHARED.includes(Number(n));
const gname = (g) => (g && g.label ? `${g.label}'s group` : "New group");
// "Table 8", or "Table 8 · Amani's group" when the table has more than one group or is shared.
const where_ = (g, all) => `Table ${g.table}` + (isShared(g.table) || (all || []).filter((x) => x.table === g.table && x.open).length > 1 ? ` · ${gname(g)}` : "");

// Diners can't browse groups or codes. To see a table they hold a pass (passes/{their sign-in}),
// which the database only accepts with the table's QR key or an open group's code.
const passRef = (u) => rdoc("passes", u);
const codeRef = (c) => rdoc("codes", String(c));
const newCode = () => String(1000 + Math.floor(Math.random() * 9000));
const newGroup = (n, code) => ({ table: Number(n), session: `${n}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, code,
  opened: Date.now(), waiter: null, people: {}, split: "order", paid: {}, open: true, label: null });
// A 4-digit code already used by an open group is refused by the database: try another.
async function withFreshCode(fn) {
  for (let i = 0; ; i++) { try { return await fn(newCode()); } catch (e) { if (!denied(e) || i >= 5) throw e; } }
}
// Small table: join the group already there, or start one. The transaction stops two phones scanning
// at the same moment from creating two groups. The diner's pass moves to the group in the same step.
function tableGroup(n, proof) {
  const me = auth.currentUser.uid;
  return withFreshCode(async (code) => {
    let sid = null;
    await runTransaction(db, async (tx) => {
      const ts = await tx.get(tableRef(n)), cur = ts.exists() && ts.data().current;
      if (cur) { const g = await tx.get(groupRef(cur)); if (g.exists() && g.data().open) { sid = cur; tx.set(passRef(me), { ...proof, session: cur, t: Date.now() }); return; } }
      const g = newGroup(n, code); sid = g.session;
      tx.set(groupRef(sid), g); tx.set(tableRef(n), { table: Number(n), current: sid });
      tx.set(codeRef(code), { session: sid, table: Number(n) }); tx.set(passRef(me), { ...proof, session: sid, t: Date.now() });
    });
    return sid;
  });
}
// Shared table: a new group of its own.
function startGroup(n, proof) {
  const me = auth.currentUser.uid;
  return withFreshCode(async (code) => {
    const g = newGroup(n, code), b = writeBatch(db);
    b.set(groupRef(g.session), g); b.set(codeRef(code), { session: g.session, table: Number(n) }); b.set(passRef(me), { ...proof, session: g.session, t: Date.now() });
    await b.commit(); return g.session;
  });
}
async function groupsAt(n) { const s = await getDocs(query(rcol("groups"), where("table", "==", Number(n)))); return s.docs.map((d) => d.data()).filter((g) => g.open); }

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
    <button aria-pressed="${t.split !== "equal"}" data-split="order" data-g="${t.session}">By what they ordered</button>
    <button aria-pressed="${t.split === "equal"}" data-split="equal" data-g="${t.session}">Equally</button></div>
   ${shares(t, lines).map((s) => `<div class="billrow"><div style="min-width:0"><div class="${s.paid ? "paid" : ""}" style="font-weight:600">${esc(s.name)}</div>
     ${t.split !== "equal" ? `<div class="note" style="margin:0">${s.items.map((l) => esc(l.n)).join(", ") || "Nothing ordered"}</div>` : ""}</div>
     <div class="row" style="flex-wrap:nowrap"><span class="amt num ${s.paid ? "paid" : ""}">${fmt(s.amt)}</span>
     ${staff ? `<button class="btn ${s.paid ? "" : "primary"}" data-paid="${s.pid}" data-g="${t.session}">${s.paid ? "Undo" : "Mark paid"}</button>` : s.paid ? `<span class="pill s-ready">Paid</span>` : ""}</div></div>`).join("")}
   <div class="total"><span>${isShared(t.table) ? "Group total" : "Table total"}</span><span class="num">TSh ${fmt(total)}</span></div>
   ${t.split === "equal" ? `<p class="note">Equal shares round up to the nearest 100 shillings.</p>` : ""}`;
}
async function setSplit(sid, mode) { try { await updateDoc(groupRef(sid), { split: mode }); } catch (e) { fail(e); } }
async function togglePaid(sid, pid, now) { try { await updateDoc(groupRef(sid), { [`paid.${pid}`]: now ? deleteField() : true }); } catch (e) { fail(e); } }

applyBrand();

// If a screen is still on "Loading…" after 10 seconds, the connection probably stalled
// (it can happen when several live screens start at once on one device). Offer a reload,
// and reload by itself once if nobody taps.
setTimeout(() => {
  const v = $("#view"); if (!v || v.textContent.trim() !== "Loading…") return;
  v.innerHTML = `<section><p class="empty">Still connecting…</p><button class="btn primary big" onclick="location.reload()">Reload</button></section>`;
  let once = false; try { once = sessionStorage.getItem("dees-autoreload") === "1"; sessionStorage.setItem("dees-autoreload", "1"); } catch {}
  if (!once) setTimeout(() => location.reload(), 5000);
}, 10000);
setTimeout(() => { try { sessionStorage.removeItem("dees-autoreload"); } catch {} }, 60000);

// ---------- router ----------
const view = location.hash.slice(1);
window.addEventListener("hashchange", () => location.reload());
const params = new URLSearchParams(location.search);
if (view === "company") companyScreen();
else if (view === "signup") signupScreen();
else if (view === "account") accountScreen();
else if (STATIONS[view] || view === "waiter") staffGate((boss) => (view === "waiter" ? waiterScreen(boss) : stationScreen(view)));
else if (view === "setup") adminGate("setup", () => setupScreen());
else if (view === "owner") adminGate("owner", (role) => ownerScreen(role === "owner" ? "owner" : "manager"));
else if (view === "manager") adminGate("manager", () => ownerScreen("manager"));
else dinerScreen();

// ================= SUBSCRIPTIONS =================
// A restaurant runs while its account is active and paid up, plus a grace week. The database rules
// enforce the same dates; these helpers only explain them on screen.
const DAY = 864e5;
const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
function subState(a) {
  if (!a) return { live: false, kind: "none" };
  if (a.status === "pending") return { live: false, kind: "pending" };
  if (a.status !== "active") return { live: false, kind: "suspended" };
  const pu = a.paidUntil || 0, now = Date.now(), stops = pu + COMPANY.graceDays * DAY;
  if (now >= stops) return { live: false, kind: "expired", until: pu };
  if (now >= pu) return { live: true, kind: "grace", until: pu, stops };
  return { live: true, kind: pu - now < 7 * DAY ? "soon" : "ok", until: pu };
}
const contactLine = () => `${esc(COMPANY.contact)} · <a href="tel:${esc(COMPANY.phone.replace(/\s/g, ""))}">${esc(COMPANY.phone)}</a> · <a href="mailto:${esc(COMPANY.email)}">${esc(COMPANY.email)}</a>`;
const price = () => `TSh ${fmt(COMPANY.monthly)} a month or TSh ${fmt(COMPANY.yearly)} a year`;
// Shown at the top of the owner, manager and setup pages when payment is due.
function subBanner() {
  const st = subState(ACCOUNT);
  if (st.kind === "grace") return `<div class="soundbar warnbar"><span><b>Payment overdue.</b> Ordering stops on ${day(st.stops)} unless the subscription is renewed. Contact ${contactLine()}</span></div>`;
  if (st.kind === "soon") return `<div class="soundbar"><span>Your subscription is paid until <b>${day(st.until)}</b>. To renew, contact ${contactLine()}</span></div>`;
  return "";
}
// What an owner or manager sees when their restaurant isn't running.
function blockedHtml(st, name) {
  const t = { pending: ["Waiting for approval", `Thanks for registering <b>${esc(name)}</b>. We'll call you to set things up, then switch it on. Questions? ${contactLine()}`],
    suspended: ["Paused", `Ordering at <b>${esc(name)}</b> is paused. Your menu, tables and history are kept safe. To switch it back on, contact ${contactLine()}`],
    expired: ["Subscription ended", `The subscription for <b>${esc(name)}</b> ended on ${st.until ? day(st.until) : "its end date"}, so ordering has stopped. Nothing is deleted. Renew for ${price()}: ${contactLine()}`],
    none: ["Not found", `We couldn't find this restaurant. Check the link, or contact ${contactLine()}`] }[st.kind] || ["Not available", contactLine()];
  return `<section><div class="label" style="margin-top:0">${t[0]}</div><p>${t[1]}</p></section>`;
}
// What diners and staff phones see when the restaurant isn't running (they can't see why).
const pausedHtml = () => `<section><p class="empty">Ordering by phone isn't available here right now.<br>Please order with a member of staff.</p></section>`;

// ================= SIGN-IN FOR OWNERS, MANAGERS AND STAFF =================
async function isCompanyUser(u) {
  if (!isAccount(u) || !u.email) return false;
  try { return (await getDoc(doc(db, "company", u.email))).exists(); } catch { return false; }
}
// The owner is the email on the restaurant's account (only the company can change it). Managers are
// listed in restaurants/{RID}/admins. The company can step into any restaurant to help.
async function adminRole(u) {
  if (!isAccount(u) || !u.email || !RID) return null;
  const em = u.email.toLowerCase(); let role = null;
  try { const a = await getDoc(doc(db, "accounts", RID)); if (a.exists()) { ACCOUNT = a.data(); if (ACCOUNT.ownerEmail === em) role = "owner"; } } catch {}
  if (!role) { try { if ((await getDoc(rdoc("admins", em))).exists()) role = "manager"; } catch {} }
  if (!role && (await isCompanyUser(u))) role = "company";
  return role;
}
// Restaurants this Google account owns or manages (including ones still waiting for approval).
async function myRestaurants(u) {
  const out = [], em = u.email.toLowerCase();
  try { (await getDocs(query(collection(db, "accounts"), where("ownerEmail", "==", em)))).docs.forEach((d) => out.push({ rid: d.id, name: d.data().name, role: "owner", acct: d.data() })); } catch {}
  try { for (const d of (await getDocs(query(collectionGroup(db, "admins"), where("email", "==", em)))).docs) {
      const rid = d.ref.parent.parent.id; if (out.some((x) => x.rid === rid)) continue;
      let name = rid; try { const r = await getDoc(doc(db, "restaurants", rid)); if (r.exists() && r.data().brand) name = r.data().brand.name || rid; } catch {}
      out.push({ rid, name, role: "manager" }); } } catch {}
  return out;
}
// Waiter, kitchen, bar and grill phones open the staff link from Setup (?r=…&s=…). The phone keeps the
// token and shows it to the database each time. A new staff link signs every staff phone out.
function staffGate(go) {
  const tok = params.get("s");
  if (!RID) RID = store.get("dees-rid");
  if (tok && RID) { store.set("dees-staff-" + RID, tok); store.set("dees-rid", RID); history.replaceState(null, "", `${BASE}?r=${RID}${location.hash}`); }
  paint(`<p class="empty">Loading…</p>`);
  (async () => {
    const notSet = (t) => paint(`<section><div class="label" style="margin-top:0">This phone isn't set up for staff</div>
      <p>${t ? "The staff link on this phone has been replaced." : "Staff screens only open on restaurant phones."} Ask the owner or manager to open <b>Setup</b> and scan the <b>staff QR code</b> with this phone.</p>
      <p class="note">Owner or manager? <a href="${BASE}${RID ? "?r=" + RID : ""}#setup">Sign in on the Setup page</a>, then come back.</p></section>`);
    if (!RID) return notSet(null);
    startConfig();
    const u = await ensureUser();
    await Promise.race([cfgReady, new Promise((r) => setTimeout(r, 5000))]);
    const role = await adminRole(u);
    if (role === "company" || (role && subState(ACCOUNT).live)) return go(true);
    if (PAUSED) return paint(pausedHtml());
    const t = store.get("dees-staff-" + RID);
    if (t) {
      // Already set up with this code (keep any shift in progress), or register this phone now.
      try { const mine = await getDoc(rdoc("staff", u.uid)); if (mine.exists() && mine.data().token === t) return go(false); } catch {}
      try { await setDoc(rdoc("staff", u.uid), { token: t, t: Date.now() }); return go(false); } catch (e) { if (!denied(e)) throw e; }
    }
    notSet(t);
  })().catch((e) => paint(errorBox(e)));
}
// Setup, owner and manager pages: Google sign-in as the restaurant's owner or one of its managers.
function adminGate(page, go) {
  const title = { setup: "Setup", owner: "Owner", manager: "Manager" }[page];
  $("#wrap").classList.add("wide"); $("#sub").textContent = title; document.title = title + " · " + rname();
  const G = { busy: false, err: "", u: null, done: false };
  const signupLink = `<p class="note">New to ${esc(COMPANY.name)}? <a href="${BASE}#signup">Register your restaurant</a>.</p>`;
  async function check() {
    paint(`<p class="empty">Loading…</p>`);
    G.u = await authReady();
    if (!isAccount(G.u) || !G.u.email) return show(`<section><div class="label" style="margin-top:0">${title} sign-in</div>
      <p>Sign in with the Google account registered for your restaurant.</p>
      <button class="btn primary big" data-act="admin-in" ${G.busy ? "disabled" : ""}>${G.busy ? "Signing in…" : "Sign in with Google"}</button>${G.err ? `<p class="err">${esc(G.err)}</p>` : ""}${signupLink}</section>`);
    const who = esc(G.u.email), other = `<button class="btn" data-act="admin-out">Use a different Google account</button>`;
    // No restaurant in the link: find the ones this account runs.
    if (!RID) {
      const mine = await myRestaurants(G.u);
      if (mine.length === 1 && mine[0].role !== "owner" || mine.length === 1 && subState(mine[0].acct).kind !== "pending") { RID = mine[0].rid; history.replaceState(null, "", `${BASE}?r=${RID}#${page}`); }
      else return show(`<section><div class="label" style="margin-top:0">Your restaurants</div>
        ${mine.length ? `<div class="grid" style="max-width:520px">${mine.map((m) => { const st = m.acct ? subState(m.acct) : { kind: "ok" };
          return `<a class="ticket ${st.live === false ? "" : "preparing"}" style="display:block;text-decoration:none;color:inherit" href="${BASE}?r=${esc(m.rid)}#${m.role === "manager" ? "manager" : page}">
            <b>${esc(m.name)}</b><div class="note" style="margin:2px 0 0">${m.role === "owner" ? "Owner" : "Manager"}${st.kind === "pending" ? " · waiting for approval" : st.kind === "suspended" ? " · paused" : st.kind === "expired" ? " · subscription ended" : ""}</div></a>`; }).join("")}</div>`
          : `<p><b>${who}</b> doesn't run a restaurant on ${esc(COMPANY.name)} yet.</p><p>Register your restaurant, or ask your restaurant's owner to add this email as a manager.</p>`}
        <div class="row" style="margin-top:14px"><a class="btn primary" href="${BASE}#signup">Register a restaurant</a>${other}</div></section>`);
    }
    const role = await adminRole(G.u);
    if (!role) return show(`<section><div class="label" style="margin-top:0">Not an owner or manager here</div>
      <p><b>${who}</b> isn't on this restaurant's list. Ask the owner to add this email under <b>Owner → Staff</b>.</p>${other}${signupLink}</section>`);
    if (role === "manager" && page === "owner") return show(`<section><div class="label" style="margin-top:0">Managers use the manager page</div>
      <p>You're signed in as a manager (${who}). <a href="${BASE}?r=${RID}#manager">Open the manager page</a>.</p></section>`);
    const st = subState(ACCOUNT);
    if (role !== "company" && !st.live) return show(blockedHtml(st, (ACCOUNT && ACCOUNT.name) || RID) + `<section>${other}</section>`);
    startConfig();
    await Promise.race([cfgReady, new Promise((r) => setTimeout(r, 5000))]);
    G.done = true; go(role === "company" ? "owner" : role);
  }
  const show = (html) => paint(html);
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || G.done) return; const a = b.dataset.act;
    if (a === "admin-out") { try { await signOutUser(); } catch {} G.err = ""; return check(); }
    if (a !== "admin-in" || G.busy) return;
    G.busy = true; G.err = ""; check();
    try { await googleSignIn(); } catch (err) { G.err = authMessage(err); }
    G.busy = false; check();
  });
  check().catch((e) => paint(errorBox(e)));
}

// ================= DINER =================
function dinerScreen() {
  const S = { n: params.get("t"), sid: null, g: null, lines: [], alerts: [], me: null, cart: [], note: "", cat: 0, tab: "menu", name: params.get("name") || "",
    user: null, profile: null, visits: [], step: "", phone: "", offers: false, busy: false, authErr: "", uid: null, proof: null, switching: false };
  // Every diner's phone is signed in, at least quietly (anonymously). Diners who sign in with their
  // phone number or Google get their profile and their visits to this restaurant loaded too.
  onUser(async (u) => {
    if (!u) { if (S.uid) ensureUser().catch(() => {}); return; }   // signed out: back to a quiet sign-in
    const changed = S.uid && S.uid !== u.uid; S.uid = u.uid;
    // A new sign-in means a new identity: carry the table pass over to it before anything else.
    if (changed && S.proof && S.sid) { S.switching = true; try { await writePass(S.sid); attach(S.sid); } catch (e) { console.error(e); } S.switching = false; }
    S.user = isAccount(u) ? u : null; S.profile = null; S.visits = [];
    if (S.user) { try { const p = await getDoc(dinerRef(u.uid)); S.profile = p.exists() ? p.data() : null;
      S.visits = (await myVisits(u.uid)).filter((v) => v.rid === RID); } catch {} }
    const justSignedIn = S.step === "code" || S.step === "phone" || S.step === "google";
    if (justSignedIn) S.step = S.user && !(S.profile && S.profile.name) ? "name" : "";
    // Signed in just now and already known: join straight away, no extra tap.
    if (justSignedIn && S.user && S.profile && S.profile.name && S.g && S.g.open && !S.me) { try { await joinAs(S.profile.name, S.user); return; } catch {} }
    render();
  });
  // On the demo page several diners share one browser, so each gets its own slot (?as=1, ?as=2).
  const meKey = () => `dees-me-${RID}-${S.n}${params.get("as") ? "-" + params.get("as") : ""}`;
  let subGroup = null, subLines = null, subAlerts = null;
  // The pass: proof of the table QR key or a friend's code, pointing at the group being joined.
  async function writePass(session) {
    const p = { ...S.proof, t: Date.now() }; if (session) p.session = session;
    await setDoc(passRef(auth.currentUser.uid), p);
  }
  const listenErr = (e) => { if (!S.switching) paint(errorBox(e)); };

  // Who may order: someone who scanned the table QR (secret key), someone with a group's current
  // code (a friend's invite), or a guest coming back to the group they already joined.
  async function start() {
    const c = params.get("c"), k = params.get("k");
    if (!RID) { $("#cart").hidden = true; return paint(`<section><p class="empty">Scan the QR code on your table to see the menu and order.</p>
      <p class="note" style="text-align:center">Run a restaurant? <a href="${BASE}#signup">Register it with ${esc(COMPANY.name)}</a> · <a href="${BASE}#owner">Owner sign-in</a></p></section>`); }
    startConfig();
    try { S.uid = (await ensureUser()).uid; } catch (e) { return paint(errorBox(e)); }
    await Promise.race([cfgReady, new Promise((r) => setTimeout(r, 5000))]);
    if (PAUSED) { $("#cart").hidden = true; return paint(pausedHtml()); }
    if (!S.n && c) return findByCode(c);
    if (!S.n) return codeEntry();
    $("#sub").textContent = `Table ${S.n}`;
    const saved = store.get(meKey());
    try {
      if (k) {
        S.proof = { table: Number(S.n), via: "key", k };
        try { await writePass(null); } catch (e) {
          if (!denied(e)) throw e;
          S.proof = null; S.err = "This QR code is out of date. Ask a waiter, or enter the code from a friend's phone."; return codeEntry(S.n);
        }
        S.viaKey = true;
        // Back at the group this phone already joined, if it's still open.
        if (saved && saved.session) { try { await writePass(saved.session); return attach(saved.session); } catch (e) { if (!denied(e)) throw e; } }
        if (!isShared(S.n)) return attach(await tableGroup(S.n, S.proof));
        const open = await groupsAt(S.n);
        if (!open.length) return attach(await startGroup(S.n, S.proof));
        return chooseGroup(open.length);
      }
      if (c) return findByCode(c, S.n);
      // No QR key or code in the link: a guest coming back to the group this phone joined.
      if (saved && saved.session) {
        const p = await getDoc(passRef(S.uid));
        if (p.exists() && p.data().session === saved.session) { const { t, session, ...proof } = p.data(); S.proof = proof; S.viaKey = proof.via === "key"; return attach(saved.session); }
      }
      return codeEntry(S.n);
    } catch (e) { paint(errorBox(e)); }
  }
  function attach(sid) {
    S.sid = sid; S.access = true; S.err = "";
    subGroup && subGroup(); subLines && subLines(); subAlerts && subAlerts();
    subGroup = onSnapshot(groupRef(sid), (snap) => {
      S.g = snap.data() || null;
      const saved = store.get(meKey());
      S.me = S.g && saved && saved.session === sid && saved.pid === S.uid && S.g.people && S.g.people[saved.pid] ? saved : null;
      render();
    }, listenErr);
    subLines = onSnapshot(query(rcol("lines"), where("session", "==", sid)), (s) => { S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.t - b.t); render(); }, listenErr);
    const acked = new Set(); let primed = false;
    subAlerts = onSnapshot(query(rcol("alerts"), where("session", "==", sid)), (s) => {
      S.alerts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      S.alerts.forEach((a) => { if (a.ack && !a.done && !acked.has(a.id)) { acked.add(a.id); if (primed) { try { navigator.vibrate?.(300); } catch {} } } });
      primed = true; render();
    }, listenErr);
  }
  // A friend's invite: the code leads to their group. At a shared table (n given) it must be a group there.
  async function findByCode(c, n) {
    paint(`<p class="empty">Finding your friends…</p>`);
    const bad = (m) => { S.err = m; return n && S.choosing ? chooseGroup(S.count || 1) : codeEntry(n || S.n); };
    try {
      c = String(c).trim(); if (!/^\d{4}$/.test(c)) return bad("Codes are 4 digits. Check the number with your friend.");
      const hit = await getDoc(codeRef(c));
      if (!hit.exists() || (n && hit.data().table !== Number(n))) return bad(n ? "That code doesn't match a group at this table. Check it on your friend's phone." : "No open table or group with that code. Check the number with your friend.");
      const { session, table } = hit.data();
      S.proof = { table, via: "code", c };
      try { await writePass(session); } catch (e) { if (!denied(e)) throw e; S.proof = null; return bad("This invite has expired. Ask your friend for the new code."); }
      const as = params.get("as");
      history.replaceState(null, "", `${BASE}?r=${RID}&t=${table}&c=${c}${as ? "&as=" + as : ""}`);
      params.set("t", table); params.set("c", c); params.delete("k"); S.n = String(table); S.choosing = false;
      $("#sub").textContent = `Table ${S.n}`; attach(session);
    } catch (e) { paint(errorBox(e)); }
  }
  function codeEntry(n) {
    $("#cart").hidden = true;
    $("#sub").textContent = n ? `Table ${n}` : "Join a table";
    paint(`<section><div class="label">${n ? `Join table ${esc(n)}` : "Join your friends"}</div>
      <p>Scan the QR code on your table, or enter the 4-digit code shown on a friend's phone.</p>
      <form id="codeform" class="grid"><input class="field num" id="codein" inputmode="numeric" maxlength="4" placeholder="4-digit code" autocomplete="off">
      <button class="btn primary big">Join</button></form>${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}</section>`);
  }
  // Shared table with groups already ordering: join friends with their code, or start a new group.
  function chooseGroup(count) {
    S.choosing = true; S.count = count; $("#cart").hidden = true;
    paint(`<section><div class="tablebar"><b>Table ${esc(S.n)}</b><span class="note" style="margin:0">Shared table · ${count} group${count > 1 ? "s" : ""} ordering</span></div>
      <div class="label">Here with friends who already ordered?</div>
      <p style="margin-top:0">Enter the 4-digit code shown on their phone.</p>
      <form id="codeform" class="grid"><input class="field num" id="codein" inputmode="numeric" maxlength="4" placeholder="Their group code" autocomplete="off">
      <button class="btn primary big">Join their group</button></form>${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}
      <div class="label">New here?</div>
      <button class="btn big" data-act="newgroup">Start a new group</button>
      <p class="note">Each group orders and pays separately, so you only see your own bill.</p></section>`);
  }
  // Joining: signed-in diners join in one tap; others choose phone, Google, or just a first name.
  function joinScreen(g, shared) {
    const names = Object.values(g.people || {}).map((p) => esc(p.name)), unit = shared ? "group" : "table";
    const bar = `<div class="tablebar"><b>Table ${esc(S.n)}</b><span class="note" style="margin:0">${names.length ? `With ${names.join(", ")}` : shared ? "Starting a new group" : "You're the first one here"}</span></div>`;
    const err = S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : "";
    const back = `<button class="btn ghost" data-act="authback">Back</button>`;
    if (S.step === "phone") return `<section>${bar}<div class="label">Your phone number</div>
      <p style="margin-top:0">We'll text you a 6-digit code. No password to remember.</p>
      <form id="phoneform" class="grid"><div class="vrow"><span class="field" style="flex:0 0 auto;width:auto">+255</span>
        <input class="field num" id="phonein" inputmode="tel" autocomplete="tel" placeholder="748 227 000" value="${esc(S.phone)}" aria-label="Mobile number"></div>
        <label class="optin"><input type="checkbox" id="offersin" ${S.offers ? "checked" : ""}> <span>Send me ${esc(rname())}'s offers on WhatsApp. <span class="note">Optional. Stop any time.</span></span></label>
        <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Sending…" : "Send code"}</button></form>${err}
      <p class="note">You'll get one SMS with a sign-in code; standard SMS rates may apply. Your number is used to sign you in, and Google (which sends the code) keeps it to prevent abuse.
        This step is protected by reCAPTCHA; Google's <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noopener">Terms</a> apply.</p>${back}</section>`;
    if (S.step === "code") return `<section>${bar}<div class="label">Enter the code</div>
      <p style="margin-top:0">Sent by SMS to <b>${esc(S.phoneFull || "")}</b>.</p>
      <form id="smsform" class="grid"><input class="field num" id="smsin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" aria-label="6-digit code">
        <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Checking…" : "Confirm"}</button></form>${err}
      <div class="row" style="margin-top:12px"><button class="btn ghost" data-act="resend">Send a new code</button>${back}</div></section>`;
    if (S.user && (S.step === "name" || !(S.profile && S.profile.name))) return `<section>${bar}<div class="label">You're signed in. What's your first name?</div>
      <form id="profileform" class="grid"><input class="field" id="profilein" maxlength="16" autocomplete="given-name" placeholder="First name" value="${esc(S.name || (S.user.displayName || "").split(" ")[0])}">
        <button class="btn primary big">Join ${unit}</button></form>${err}</section>`;
    if (S.user && S.profile && S.profile.name) return `<section>${bar}
      <button class="btn primary big" data-act="joinme" style="margin-top:16px">Join as ${esc(S.profile.name)}</button>
      <p class="note">Not ${esc(S.profile.name)}? <button class="linkbtn" data-act="signout">Sign out</button></p>${err}</section>`;
    return `<section>${bar}<div class="label">Join the ${unit}</div>
      <p style="margin-top:0">Sign in to keep your receipts and order your usual in one tap. Or just use your first name.</p>
      <div class="grid"><button class="btn primary big" data-act="auth-phone">Continue with phone number</button>
        <button class="btn big" data-act="auth-google" ${S.busy ? "disabled" : ""}>Continue with Google</button></div>${err}
      <div class="orline"><span>or</span></div>
      <form id="joinform" class="grid"><label class="note" for="namein" style="margin:0">Just your first name, no account</label>
        <input class="field" id="namein" maxlength="16" placeholder="First name" autocomplete="given-name" value="${esc(S.name)}">
        <button class="btn big">Join ${unit}</button></form>
      <p class="note">Signing in is optional. Ordering and splitting the bill work the same either way.</p></section>`;
  }
  // Welcome card for signed-in diners: visit number here, their usual, and a link to their account.
  function welcomeCard() {
    if (!S.user || !S.profile || S.tab !== "menu") return "";
    const n = S.visits.length + 1, usual = usualFrom(S.visits);
    return `<div class="welcome"><div class="row" style="justify-content:space-between"><b>${S.visits.length ? `Welcome back, ${esc(S.profile.name)}` : `Hi ${esc(S.profile.name)}`}</b>
      <a class="note" style="margin:0" href="${BASE}#account">My account</a></div>
      <div class="note" style="margin:2px 0 0">${S.visits.length ? `Your ${ordinal(n)} visit to ${esc(rname())}` : "Your visits here will be saved to your account"}</div>
      ${usual.length ? `<div class="usual"><span>${usual.kind === "usual" ? "Your usual" : "Last time"}: ${usual.map((u) => esc(u.n) + (u.v ? ` · ${esc(u.v)}` : "")).join(" + ")}</span>
        <button class="btn primary" data-act="usual">${usual.kind === "usual" ? "Add my usual" : "Order again"}</button></div>` : ""}</div>`;
  }
  // Each person in a group is keyed by their sign-in, so the database knows whose orders are whose.
  async function joinAs(name, u) {
    const pid = auth.currentUser.uid, person = { name, t: Date.now(), uid: pid, acct: isAccount(auth.currentUser) }, patch = {};
    patch[`people.${pid}`] = person; if (!S.g.label) patch.label = name;
    await updateDoc(groupRef(S.sid), patch);
    store.set(meKey(), { pid, name, session: S.sid }); S.me = { pid, name, session: S.sid };
    store.set("dees-lasttable", location.href); render();
  }
  function render() {
    if (!S.n || !S.access) return;
    const shared = isShared(S.n), g = S.g;
    if (!g || !g.open) {
      $("#cart").hidden = true;
      return paint(`<section><p class="empty">${shared ? "Your group's bill has been closed" : "This table has been closed"}. Thanks for visiting!</p>${S.viaKey
        ? `<button class="btn primary big" data-act="newsession">Start a new order at table ${esc(S.n)}</button>`
        : `<p class="note" style="text-align:center">To order again, scan the QR code on your table.</p>`}</section>`);
    }
    if (!S.me) { $("#cart").hidden = true; return paint(joinScreen(g, shared)); }
    const open = S.alerts.filter((a) => !a.done);
    const banners = open.filter((a) => a.ack).map((a) => `<div class="ontheway" role="status"><span>${esc(wname(a.ackBy) || "Your waiter")} ${a.type === "bill" ? "is bringing your bill" : "is on the way to your table"}</span><span class="note">${ago(a.ack)}</span></div>`).join("");
    const tabs = [["menu", "Menu"], ["orders", `${shared ? "Our order" : "Table order"}${S.lines.length ? ` (${S.lines.length})` : ""}`], ["bill", "Bill"]];
    let body = "";
    if (S.tab === "menu") {
      if (S.cat >= MENU.length) S.cat = 0;
      // One continuous list: every section in order, with its heading. The category bar sticks under
      // the header and highlights whichever section is on screen (see spy() below).
      body = `<div class="cats" id="cats">${MENU.map((m, i) => `<button class="chip" aria-pressed="${i === S.cat}" data-cat="${i}">${esc(m.c)}</button>`).join("")}</div>
       ${MENU.map((cat, ci) => `<div class="msec" id="sec-${ci}" data-sec="${ci}"><h2 class="sech">${esc(cat.c)}</h2>
       ${cat.items.map((it, ii) => { const gp = !it.img && genericPhoto(it.n); return `<div class="item${it.out ? " out" : ""}${it.img || gp ? " withph" : ""}">${it.img ? `<div class="ph"><img data-photo="${esc(it.img)}" alt="${esc(it.n)}" loading="lazy"></div>` : gp ? `<div class="ph loaded"><img src="${gp}" alt="${esc(it.n)}" loading="lazy"></div>` : ""}<h3>${esc(it.n)}${it.out ? ` <span class="pill s-served">Sold out</span>` : ""}</h3>${it.d ? `<p class="d">${esc(it.d)}</p>` : ""}${it.m ? `<div class="meta">${esc(it.m)}</div>` : ""}
       ${it.out ? "" : `<div class="vars">${it.v.map(([l, p], vi) => `<button class="var" data-add="${ci}.${ii}.${vi}">${l ? esc(l) + " " : "Add "}<span class="num">TSh ${fmt(p)}</span></button>`).join("")}</div>`}</div>`; }).join("")}</div>`).join("")}`;
    } else if (S.tab === "orders") {
      body = Object.entries(g.people || {}).map(([pid, p]) => { const ls = S.lines.filter((l) => l.pid === pid);
        return `<div class="who">${esc(p.name)}${pid === S.me.pid ? " (you)" : ""}</div>` + (ls.length ? ls.map((l) => `<div class="oline"><span class="l">${label(l)}</span><span class="pill s-${l.s}">${l.s}</span></div>`).join("") : `<p class="note" style="margin:2px 0">Nothing yet</p>`); }).join("");
    } else body = billHtml(g, S.lines, false) + `<p class="note">Pay your waiter as usual. In-app mobile money comes later.</p>`;
    paint(`<section>
      <div class="tablebar"><div><b>Table ${esc(S.n)}</b><div class="note" style="margin:2px 0 0">${shared ? `${esc(gname(g))} · ` : ""}Hi ${esc(S.me.name)} · friends join with code</div></div>
       <div class="row"><span class="code num">${esc(g.code)}</span><button class="btn" data-act="share">Share</button></div></div>
      ${banners}${welcomeCard()}
      <div class="waitbar"><div><div class="note" style="margin:0">Your waiter</div><b>${g.waiter ? esc(wname(g.waiter)) : "Being assigned…"}</b></div>
       <div class="row">${Object.entries(ALERT).map(([k, l]) => { const a = open.find((x) => x.type === k);
         return `<button class="btn${a ? "" : " primary"}" data-alert="${k}" ${a ? "disabled" : ""}>${a ? (a.ack ? "On the way" : k === "call" ? "Waiter called" : "Bill requested") : l}</button>`; }).join("")}</div></div>
      <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button aria-pressed="${S.tab === k}" data-tab="${k}">${l}</button>`).join("")}</div>
      ${body}</section>`);
    renderCart();
  }
  // Sticky category bar: sits right under the sticky header, whatever its height.
  const stickTop = () => { const h = $("header.top"); return h ? h.getBoundingClientRect().bottom : 0; };
  function markCat() {
    document.querySelectorAll("#cats .chip").forEach((c) => c.setAttribute("aria-pressed", String(+c.dataset.cat === S.cat)));
    const on = document.querySelector(`#cats .chip[data-cat="${S.cat}"]`), bar = $("#cats");
    if (!on || !bar) return; const x = on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2;
    if (bar.scrollTo) bar.scrollTo({ left: x, behavior: "smooth" }); else bar.scrollLeft = x;
  }
  let jumping = 0;
  function jumpTo(ci) {
    const sec = document.getElementById("sec-" + ci), bar = $("#cats"); if (!sec) return;
    const y = window.scrollY + sec.getBoundingClientRect().top - stickTop() - (bar ? bar.offsetHeight : 0) - 4;
    jumping = Date.now(); window.scrollTo({ top: y, behavior: "smooth" });
  }
  // Highlight the section whose heading has passed under the bar.
  function spy() {
    if (S.tab !== "menu" || Date.now() - jumping < 700) return;
    const bar = $("#cats"); if (!bar) return;
    const line = stickTop() + bar.offsetHeight + 12; let cur = 0;
    document.querySelectorAll(".msec").forEach((sec) => { if (sec.getBoundingClientRect().top <= line) cur = +sec.dataset.sec; });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = MENU.length - 1;
    if (cur !== S.cat) { S.cat = cur; markCat(); }
  }
  let spyQueued = false;
  window.addEventListener("scroll", () => { if (spyQueued) return; spyQueued = true; requestAnimationFrame(() => { spyQueued = false; spy(); }); }, { passive: true });
  const setBarTop = () => document.documentElement.style.setProperty("--bar-top", stickTop() + "px");
  window.addEventListener("resize", setBarTop);

  // After a redraw the bar starts scrolled to the left again: put the highlighted chip back in view.
  function keepBar() {
    const bar = $("#cats"), on = document.querySelector(`#cats .chip[data-cat="${S.cat}"]`);
    if (bar && on) bar.scrollLeft = on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2;
  }
  function renderCart() {
    setBarTop(); keepBar();
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
    if (e.target.id === "codeform") {
      const c = $("#codein").value.trim(); if (c.length !== 4) return;
      if (S.choosing) return findByCode(c, S.n);
      findByCode(c);
    }
    if (e.target.id === "joinform") {
      const name = $("#namein").value.trim(); if (!name) return;
      try { await joinAs(name, null); } catch (err) { fail(err); }
    }
    if (e.target.id === "phoneform") {
      S.phone = $("#phonein").value; S.offers = $("#offersin").checked;
      const full = normalisePhone(S.phone); if (!full) { S.authErr = "That doesn't look like a phone number. Try 0748 227 000."; return render(); }
      S.phoneFull = full; S.busy = true; S.authErr = ""; render();
      try { await phoneStart(full); S.step = "code"; } catch (err) { S.authErr = authMessage(err); }
      S.busy = false; render();
    }
    if (e.target.id === "smsform") {
      const code = $("#smsin").value.replace(/\D/g, ""); if (code.length !== 6) return;
      S.busy = true; S.authErr = ""; render();
      try { await phoneConfirm(code); } catch (err) { S.authErr = authMessage(err); S.busy = false; render(); return; }
      S.busy = false;
    }
    if (e.target.id === "profileform") {
      const name = $("#profilein").value.trim(); if (!name || !S.user) return;
      const prof = { name, phone: S.user.phoneNumber || null, email: S.user.email || null, offers: !!S.offers, created: Date.now() };
      try { await setDoc(dinerRef(S.user.uid), prof); S.profile = prof; S.step = ""; await joinAs(name, S.user); } catch (err) { fail(err); }
    }
  });
  document.addEventListener("input", (e) => { if (e.target.id === "note") S.note = e.target.value; if (e.target.id === "namein") S.name = e.target.value; });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.tab) { S.tab = d.tab; render(); window.scrollTo(0, 0); }
    else if (d.cat) { S.cat = +d.cat; markCat(); jumpTo(S.cat); }
    else if (d.add) { const [c, i, v] = d.add.split(".").map(Number), it = MENU[c]?.items[i]; if (!it || it.out || !it.v[v]) return render(); const [l, p] = it.v[v];
      S.cart.push({ n: it.n, v: l, pr: p, st: MENU[c].st }); toast(`Added ${it.n}`); renderCart(); }
    else if (d.rm) { S.cart.splice(+d.rm, 1); renderCart(); }
    else if (d.split) setSplit(S.sid, d.split);
    else if (d.alert) {
      try { await addDoc(rcol("alerts"), { table: Number(S.n), session: S.sid, type: d.alert, pid: S.me.pid, pname: S.me.name, t: Date.now(), ack: null, ackBy: null, done: false });
        toast(S.g.waiter ? `${wname(S.g.waiter)} has been notified` : "All waiters notified"); } catch (err) { fail(err); }
    }
    else if (d.act === "place" && S.cart.length && !S.placing) {
      S.placing = true; renderCart();
      const batch = writeBatch(db), bid = uid("b"), now = Date.now();
      S.cart.forEach((l) => batch.set(doc(rcol("lines")), { table: Number(S.n), session: S.sid, batch: bid, pid: S.me.pid, pname: S.me.name,
        n: l.n, v: l.v, pr: l.pr, st: l.st, s: "new", t: now, note: S.note.trim() || null }));
      try { await batch.commit(); const sts = [...new Set(S.cart.map((l) => STATIONS[l.st]))]; S.cart = []; S.note = ""; toast("Sent to " + sts.join(" and ")); }
      catch (err) { fail(err); }
      S.placing = false; render();
    }
    else if (d.act === "share") {
      const link = `${BASE}?r=${RID}&c=${S.g.code}`, what = isShared(S.n) ? "group" : "table";
      const txt = `Join our ${what} at ${rname()}: ${link} (code ${S.g.code}, works until the ${what} closes)`;
      try { if (navigator.share) { await navigator.share({ text: txt }); return; } } catch { return; }
      try { await navigator.clipboard.writeText(txt); toast("Invite copied. Paste it in WhatsApp."); } catch { toast(`Code: ${S.g.code}`); }
    }
    else if (d.act === "auth-phone") { S.step = "phone"; S.authErr = ""; render(); }
    else if (d.act === "authback") { S.step = ""; S.authErr = ""; render(); }
    else if (d.act === "resend") { S.step = "phone"; S.authErr = ""; render(); }
    else if (d.act === "auth-google" && !S.busy) {
      S.busy = true; S.step = "google"; S.authErr = ""; render();
      try { await googleSignIn(); } catch (err) { S.authErr = authMessage(err); S.step = ""; }
      S.busy = false; render();
    }
    else if (d.act === "joinme" && S.profile) { try { await joinAs(S.profile.name, S.user); } catch (err) { fail(err); } }
    else if (d.act === "signout") { try { await signOutUser(); } catch {} S.step = ""; render(); }
    else if (d.act === "usual") { usualFrom(S.visits).forEach((u) => S.cart.push({ ...u })); toast("Your usual is in the basket"); renderCart(); }
    else if (d.act === "newgroup" && S.viaKey) { S.choosing = false; try { attach(await startGroup(S.n, S.proof)); } catch (err) { fail(err); } }
    else if (d.act === "newsession" && S.viaKey) { S.access = false; S.sid = null; S.g = null; S.me = null; store.set(meKey(), null); start(); }
  });
  setInterval(() => { if (S.alerts.some((a) => a.ack && !a.done)) render(); }, 30000);
  cfgListeners.add(() => { S.cart = S.cart.filter((c) => !soldOut(c.n)); render(); });
  start();
}

// ================= STATION (kitchen / bar / grill) =================
function stationScreen(st) {
  $("#wrap").classList.add("wide"); $("#sub").textContent = STATIONS[st] + " screen"; document.title = STATIONS[st] + " · " + rname();
  const S = { lines: [], groups: {}, all: [] }; const notify = watcher();
  onSnapshot(query(rcol("lines"), where("s", "in", ["new", "preparing", "ready"])), (s) => {
    S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => l.st === st);
    notify(S.lines.filter((l) => l.s === "new").map((l) => l.batch)); render();
  }, (e) => paint(errorBox(e)));
  onSnapshot(query(rcol("groups"), where("open", "==", true)), (s) => { S.all = s.docs.map((d) => d.data()); S.groups = {}; S.all.forEach((g) => (S.groups[g.session] = g)); render(); });
  function render() {
    const batches = [...new Set(S.lines.sort((a, b) => a.t - b.t).map((l) => l.batch))];
    const tix = batches.map((b) => {
      const bl = S.lines.filter((l) => l.batch === b), s = bl.some((l) => l.s === "new") ? "new" : bl.some((l) => l.s === "preparing") ? "preparing" : "ready";
      const note = bl.find((l) => l.note), g = S.groups[bl[0].session], w = g && g.waiter;
      return `<article class="ticket ${s}"><header><b>${esc(g ? where_(g, S.all) : `Table ${bl[0].table}`)}</b><span class="note" style="margin:0">${esc(bl[0].pname)} · ${ago(bl[0].t)}</span></header>
        <div class="note" style="margin:2px 0 0">Waiter: ${w ? esc(wname(w)) : "not assigned yet"}</div>
        <ul class="slines">${bl.map((l) => `<li class="sline${l.s === "ready" ? " done" : ""}"><span><span class="q">1×</span>${label(l)}</span>${l.s === "ready"
          ? `<span class="pill s-ready">Ready</span>` : `<button class="btn" data-ready="${l.id}" aria-label="${esc(l.n)} ready">Ready</button>`}</li>`).join("")}</ul>${note ? `<div class="nt">${esc(note.note)}</div>` : ""}
        <div class="acts"><span class="pill s-${s}">${s === "ready" ? "Waiting for waiter" : s}</span>${s === "new" ? `<button class="btn primary" data-adv="${b}" data-to="preparing">Start</button>` : ""}
          ${bl.filter((l) => l.s !== "ready").length > 1 ? `<button class="btn primary" data-adv="${b}" data-to="ready">All ready</button>` : ""}</div></article>`;
    });
    paint(soundBar() + (tix.length ? `<section class="grid">${tix.join("")}</section>` : `<p class="empty">No open orders for the ${STATIONS[st]}.</p>`));
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.act === "sound") { await enableSound(); render(); }
    if (d.act === "testsound") beep();
    if (d.adv) { b.disabled = true; const batch = writeBatch(db);
      const now = Date.now();
      S.lines.filter((l) => l.batch === d.adv && (d.to === "preparing" ? l.s === "new" : l.s !== "ready")).forEach((l) =>
        batch.update(rdoc("lines", l.id), d.to === "preparing" ? { s: "preparing", tPrep: now } : { s: "ready", tReady: now, tPrep: l.tPrep || now }));
      try { await batch.commit(); } catch (err) { fail(err); b.disabled = false; } }
    // One dish ready on its own: the waiter is alerted for just that dish.
    if (d.ready) { const l = S.lines.find((x) => x.id === d.ready); if (!l) return; b.disabled = true; const now = Date.now();
      try { await updateDoc(rdoc("lines", l.id), { s: "ready", tReady: now, tPrep: l.tPrep || now }); } catch (err) { fail(err); b.disabled = false; } }
  });
  setInterval(render, 30000);
  cfgListeners.add(render);
}

// ================= WAITER =================
// Waiters use their own phones. A phone is set up once with the staff code; each shift starts with the
// waiter's name and PIN and ends with End shift (or after 16 hours). The database only accepts table,
// alert and serving actions from the waiter on shift. Owners and managers can work as any waiter.
const SHIFT_MS = 16 * 3600e3;
function waiterScreen(boss) {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Waiter"; document.title = "Waiter · " + rname();
  const S = { me: boss ? store.get("dees-waiter-" + RID) : null, since: null, picking: null, pinErr: "", busy: false, endArmed: false,
    groups: [], lines: [], alerts: [], open: null, confirm: null };
  const myRef = () => rdoc("staff", auth.currentUser.uid);
  async function loadShift() {
    if (boss) return;
    try { const d = (await getDoc(myRef())).data() || {};
      const ok = d.waiter && d.shift && Date.now() - d.shift < SHIFT_MS && WAITERS.some((w) => w.id === d.waiter);
      S.me = ok ? d.waiter : null; S.since = ok ? d.shift : null; } catch { S.me = null; }
    update();
  }
  async function endShift(msg) {
    S.me = null; S.since = null; S.endArmed = false; S.picking = null; render();
    try { await setDoc(myRef(), { token: store.get("dees-staff-" + RID), t: Date.now() }); } catch {}
    if (msg) toast(msg);
  }
  // A shift that has run 16 hours ends by itself.
  setInterval(() => { if (!boss && S.since && Date.now() - S.since >= SHIFT_MS) endShift("Your shift has ended. Start a new one to keep working."); }, 60000);
  const notify = watcher();
  onSnapshot(query(rcol("groups"), where("open", "==", true)), (s) => { S.groups = s.docs.map((d) => d.data()).sort((a, b) => a.table - b.table || a.opened - b.opened); update(); }, (e) => paint(errorBox(e)));
  onSnapshot(query(rcol("lines"), where("s", "in", ["new", "preparing", "ready"])), (s) => { S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })); update(); });
  onSnapshot(query(rcol("alerts"), where("done", "==", false)), (s) => { S.alerts = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.t - b.t); update(); });
  // Bill totals need every line of the group, including served ones.
  let billSub = null, billLines = [];
  function watchBill(sid) { billSub && billSub(); billLines = []; if (!sid) return;
    billSub = onSnapshot(query(rcol("lines"), where("session", "==", sid)), (s) => { billLines = s.docs.map((d) => d.data()); render(); }); }

  const live = (g) => (x) => x.session === g.session;
  const seated = (g) => Object.keys(g.people || {}).length > 0;
  const name = (g) => where_(g, S.groups);
  function update() {
    if (S.me) {
      const mine = S.groups.filter((g) => g.waiter === S.me || !g.waiter);
      notify([
        ...S.groups.filter((g) => !g.waiter && seated(g)).map((g) => "g" + g.session),
        ...S.alerts.filter((a) => mine.some((g) => live(g)(a))).map((a) => "a" + a.id),
        ...S.lines.filter((l) => l.s === "ready" && mine.some((g) => live(g)(l))).map((l) => "l" + l.id),
      ]);
    }
    render();
  }
  function render() {
    const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    let pick;
    if (boss) {
      pick = `<div class="label" style="margin-top:0">Working as</div><div class="row">${WAITERS.map((w) => `<button class="chip" aria-pressed="${w.id === S.me}" data-me="${w.id}">${esc(w.name)}</button>`).join("")}</div>`;
      if (!S.me) return paint(`<section>${pick}<p class="note">Owners and managers can work as any waiter.</p></section>`);
    } else if (!S.me) {
      const w = S.picking && WAITERS.find((x) => x.id === S.picking);
      return paint(`<section><div class="label" style="margin-top:0">Start your shift</div>
        ${w ? `<p style="margin-top:0">Hi <b>${esc(w.name)}</b>. Enter your 4-digit PIN.</p>
          <form id="pinform" class="grid" style="max-width:320px"><input class="field num" id="pinin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="Your PIN">
          <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Starting…" : "Start shift"}</button></form>
          ${S.pinErr ? `<p class="err">${esc(S.pinErr)}</p>` : ""}<button class="btn ghost" data-act="notme">Not ${esc(w.name)}?</button>`
        : `<p style="margin-top:0">Tap your name.</p><div class="row">${WAITERS.map((x) => `<button class="chip" data-pickme="${x.id}">${esc(x.name)}</button>`).join("")}</div>
          ${WAITERS.length ? "" : `<p class="note">No waiters yet. The owner adds them under Owner → Staff.</p>`}`}
        <p class="note">Your PIN comes from the owner or manager. Your shift ends when you tap End shift, or after 16 hours.</p></section>`);
    } else {
      pick = `<div class="shiftbar"><span><b>${esc(wname(S.me))}</b> · on shift since ${hhmm(S.since)}</span>
        <button class="btn ${S.endArmed ? "danger" : "ghost"}" data-act="endshift">${S.endArmed ? "Tap again to end shift" : "End shift"}</button></div>`;
    }
    const free = S.groups.filter((g) => !g.waiter && seated(g));
    const mine = S.groups.filter((g) => g.waiter === S.me);
    const others = S.groups.filter((g) => g.waiter && g.waiter !== S.me);
    const alertCard = (a, g) => `<article class="ticket alert"><header><b>${ALERT[a.type]}</b><span class="note" style="margin:0">${ago(a.t)}</span></header>
      <p class="note" style="margin:4px 0 0">${esc(name(g))} · from ${esc(a.pname)}</p>
      <div class="acts">${a.ack ? `<span class="pill s-preparing">Diner notified</span><button class="btn primary" data-done="${a.id}">${a.type === "bill" ? "Bill delivered" : "Done"}</button>`
        : `<button class="btn primary" data-ack="${a.id}">On my way</button>`}${a.type === "bill" && g.waiter === S.me ? `<button class="btn" data-open="${g.session}">Open bill</button>` : ""}</div></article>`;
    const freeCards = free.map((g) => { const al = S.alerts.filter(live(g));
      return `<article class="ticket"><header><b>${esc(name(g))}</b><span class="pill s-new">No waiter</span></header>
       <p class="note" style="margin:4px 0 0">${Object.values(g.people).map((p) => esc(p.name)).join(", ")} · opened ${ago(g.opened)}</p>
       <div class="acts"><button class="btn primary" data-accept="${g.session}">Accept</button></div></article>` + al.map((a) => alertCard(a, g)).join(""); }).join("");
    const mineCards = mine.map((g) => {
      const al = S.alerts.filter(live(g)), ready = S.lines.filter((l) => live(g)(l) && l.s === "ready"), open = S.open === g.session, unit = isShared(g.table) ? "group" : "table";
      return `<article class="ticket preparing"><header><b>${esc(name(g))}</b><span class="note" style="margin:0">code ${esc(g.code)}</span></header>
        <p class="note" style="margin:4px 0 0">${Object.values(g.people || {}).map((p) => esc(p.name)).join(", ") || "No guests yet"}</p>
        ${ready.map((l) => `<div class="oline"><span class="l">${label(l)} <span class="note">for ${esc(l.pname)} · ${STATIONS[l.st]}</span></span><button class="btn primary" data-serve="${l.id}">Served</button></div>`).join("")}
        <div class="acts"><button class="btn" data-open="${g.session}">${open ? "Hide bill" : "Bill"}</button><button class="btn ghost" data-release="${g.session}">Hand over</button>
          ${S.confirm === g.session ? `<button class="btn danger" data-close="${g.session}">Tap again to close</button>` : `<button class="btn ghost" data-confirm="${g.session}">Close ${unit}</button>`}</div>
        ${open ? billHtml(g, billLines, true) : ""}</article>` + al.map((a) => alertCard(a, g)).join("");
    }).join("");
    paint(`<section>${pick}${soundBar()}
      ${free.length ? `<div class="label">Waiting for a waiter · alerts go to everyone</div><div class="grid">${freeCards}</div>` : ""}
      <div class="label">My tables</div>${mine.length ? `<div class="grid">${mineCards}</div>` : `<p class="note">No tables yet. Accept one when guests sit down.</p>`}
      ${others.length ? `<div class="label">Other waiters</div><p class="note">${others.map((g) => `${esc(name(g))}: ${esc(wname(g.waiter))}`).join(" · ")}</p>` : ""}
    </section>`);
  }
  const find = (sid) => S.groups.find((g) => g.session === sid);
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    try {
      if (d.act === "sound") { await enableSound(); render(); }
      else if (d.act === "testsound") beep();
      else if (d.me && boss) { S.me = d.me; store.set("dees-waiter-" + RID, d.me); update(); }
      else if (d.pickme) { S.picking = d.pickme; S.pinErr = ""; render(); }
      else if (d.act === "notme") { S.picking = null; S.pinErr = ""; render(); }
      else if (d.act === "endshift") { if (!S.endArmed) { S.endArmed = true; render(); setTimeout(() => { if (S.endArmed) { S.endArmed = false; render(); } }, 4000); return; }
        const mine = S.groups.filter((g) => g.waiter === S.me).length;
        await endShift(mine ? `Shift ended. Your ${mine} table${mine > 1 ? "s are" : " is"} still yours until handed over.` : "Shift ended. See you next time!"); }
      else if (d.accept) { await runTransaction(db, async (tx) => { const s = await tx.get(groupRef(d.accept)); if (!s.exists() || s.data().waiter) throw new Error("taken"); tx.update(groupRef(d.accept), { waiter: S.me, accepted: Date.now() }); }); toast(`${name(find(d.accept) || { table: "" })} is yours`); }
      else if (d.release) { await updateDoc(groupRef(d.release), { waiter: null }); toast("Open for another waiter"); }
      else if (d.ack) { await updateDoc(rdoc("alerts", d.ack), { ack: Date.now(), ackBy: S.me }); toast("Diner told you're on the way"); }
      else if (d.done) await updateDoc(rdoc("alerts", d.done), { done: true, doneAt: Date.now() });
      else if (d.serve) await updateDoc(rdoc("lines", d.serve), { s: "served", tServed: Date.now(), servedBy: S.me });
      else if (d.open) { S.open = S.open === d.open ? null : d.open; watchBill(S.open); render(); }
      else if (d.split) await setSplit(d.g, d.split);
      else if (d.paid) { const g = find(d.g); await togglePaid(d.g, d.paid, !!((g && g.paid) || {})[d.paid]); }
      else if (d.confirm) { S.confirm = d.confirm; render(); setTimeout(() => { if (S.confirm === d.confirm) { S.confirm = null; render(); } }, 4000); }
      else if (d.close) { const g = find(d.close), n = g && name(g); await closeGroup(d.close); S.confirm = null; if (S.open === d.close) { S.open = null; watchBill(null); } toast(`${n || "Table"} closed`); }
    } catch (err) {
      if (err.message === "taken") toast("Another waiter just took it");
      // Refused: the shift has ended, or the owner changed this waiter's PIN.
      else if (denied(err) && !boss) await endShift("Your shift has ended (your PIN may have changed). Start it again with your PIN.");
      else fail(err);
    }
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "pinform") return; e.preventDefault();
    const pin = $("#pinin").value.trim(), w = S.picking; if (!w || S.busy) return;
    if (!/^\d{4}$/.test(pin)) { S.pinErr = "PINs are 4 digits."; return render(); }
    S.busy = true; S.pinErr = ""; render();
    try { const now = Date.now(); await setDoc(myRef(), { token: store.get("dees-staff-" + RID), t: now, waiter: w, pin, shift: now });
      S.me = w; S.since = now; S.picking = null; toast(`Shift started. Welcome, ${wname(w)}!`); update(); }
    catch (err) { S.pinErr = denied(err) ? "That PIN didn't work. Check it, or ask the owner or manager to set your PIN." : "Couldn't connect. Try again."; }
    S.busy = false; render();
  });
  loadShift();
  async function closeGroup(sid) {
    const g = find(sid); if (!g) return;
    const all = await getDocs(query(rcol("lines"), where("session", "==", sid)));
    const batch = writeBatch(db), now = Date.now();
    // Items never marked served are closed without a serve time, so they don't skew the averages.
    S.lines.filter(live(g)).forEach((l) => batch.update(rdoc("lines", l.id), { s: "served", closedUnserved: true }));
    S.alerts.filter(live(g)).forEach((a) => batch.update(rdoc("alerts", a.id), { done: true, doneAt: now }));
    batch.set(rdoc("sessions", sid), { table: g.table, session: sid, opened: g.opened, accepted: g.accepted || null, closed: now,
      waiter: g.waiter || null, guests: Object.keys(g.people || {}).length, total: tableTotal(all.docs.map((x) => x.data())),
      paid: Object.keys(g.paid || {}).length });
    batch.update(groupRef(sid), { open: false, closed: now });
    batch.delete(codeRef(g.code));   // the invite code stops working
    // Signed-in diners get this visit saved to their account: what they had and their share.
    const allLines = all.docs.map((x) => x.data()), owed = shares(g, allLines);
    Object.entries(g.people || {}).forEach(([pid, p]) => {
      if (!p.uid || p.acct === false) return; const sh = owed.find((x) => x.pid === pid);
      batch.set(doc(db, "visits", `${p.uid}_${sid}_${pid}`), { uid: p.uid, rid: RID, rname: rname(), table: g.table, session: sid, date: now,
        items: allLines.filter((l) => l.pid === pid).map((l) => ({ n: l.n, v: l.v || "", pr: l.pr })), share: sh ? sh.amt : 0, groupTotal: tableTotal(allLines) });
    });
    await batch.commit();
  }
  setInterval(render, 30000);
  cfgListeners.add(render);
}

// ================= SETUP =================
function setupScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Setup"; document.title = "Setup · " + rname();
  const link = (h, l) => `<div><div class="note" style="margin:0">${l}</div><a href="${h}">${esc(h)}</a></div>`;
  let armed = false, rot = false, keys = {}, staffTok = null, rotStaff = false, rekey = null;
  const unlocked = true;   // only owners and managers reach this screen (see adminGate)
  // The staff link's secret token. Phones that opened the link stay signed in until it is replaced.
  const staffRef = rdoc("secrets", "staff");
  async function loadStaff(rotate) {
    try {
      const s = rotate ? null : await getDoc(staffRef);
      staffTok = s && s.exists() && s.data().token;
      if (!staffTok) { staffTok = newKey() + newKey(); await setDoc(staffRef, { token: staffTok, t: Date.now() }); }
    } catch (e) { fail(e); }
    document.querySelectorAll(".sqr .box").forEach((b) => (b.innerHTML = "")); render();
  }
  const staffLink = (screen) => `${BASE}?r=${RID}&s=${staffTok}#${screen}`;
  async function loadKeys(rotate) {
    try { const ks = await Promise.all(Array.from({ length: TABLES }, (_, i) => tableKey(i + 1, rotate))); ks.forEach((k, i) => (keys[i + 1] = k)); }
    catch (e) { fail(e); }
    document.querySelectorAll(".qr .box").forEach((b) => (b.innerHTML = "")); render();
  }
  function render() {
    const screens = [["waiter", "Waiter"], ...Object.entries(STATIONS)];
    const tableCard = (n) => `<div class="qr"><div class="box" id="qr${n}"></div><b>Table ${n}</b>
      <button class="chip sharetog" data-share="${n}" aria-pressed="${isShared(n)}">${isShared(n) ? "Shared table" : "Normal table"}</button>
      ${keys[n] ? `<a class="note" href="${tableLink(n, keys[n])}">Open</a>` : `<span class="note">Loading…</span>`}
      <button class="btn ghost small" data-rekey="${n}">${rekey === n ? "Tap again" : "New code"}</button></div>`;
    paint(subBanner() + `<section><div class="label" style="margin-top:0">Tables and QR codes · diners scan these</div>
      <div class="row"><button class="btn" data-tables="-1" aria-label="One table fewer">−</button><b class="num">${TABLES} tables</b><button class="btn" data-tables="1" aria-label="One more table">+</button>
        <button class="btn primary" data-act="print" ${Object.keys(keys).length < TABLES ? "disabled" : ""}>Print table cards</button></div>
      <div class="qrs">${Array.from({ length: TABLES }, (_, i) => tableCard(i + 1)).join("")}</div>
      <p class="note">Each code carries a secret key, so nobody can order from outside by guessing a table number. If one table's card is damaged or photographed, tap <b>New code</b> under it and reprint just that one.</p>
      <p class="note">Mark big communal tables as <b>Shared</b>: several groups can then order there, each with its own code and bill. On normal tables everyone who scans joins the same bill.</p>
      <button class="btn" data-act="rotate">${rot ? "Tap again: every printed table card will stop working" : "Make new codes for all tables"}</button>
      <div class="label">Staff phones · scan once with each phone</div>
      <div class="qrs">${screens.map(([k, v]) => `<div class="qr sqr"><div class="box" id="sqr-${k}"></div><b>${esc(v)}</b>${staffTok ? `<a class="note" href="${staffLink(k)}">Open here</a>` : `<span class="note">Loading…</span>`}</div>`).join("")}</div>
      <p class="note">Each waiter scans the <b>Waiter</b> code once with their own phone. After that they start each shift with their name and PIN (set the PINs under Owner → Staff). The kitchen, bar and grill phones scan their own code once. Keep these codes away from guests.</p>
      <p class="note">If a phone is lost or someone leaves, make new staff codes: every staff phone is signed out and scans again.</p>
      <button class="btn" data-act="rotstaff">${rotStaff ? "Tap again: every staff phone must scan again" : "Make new staff codes"}</button>
      <div class="label">Owner and manager pages</div>
      <div class="links">${link(BASE + "demo.html?r=" + RID, "Demo stage: several phones on one iPad or laptop")}${link(BASE + "?r=" + RID + "#owner", "Owner (dashboard, menu, look, staff)")}${link(BASE + "?r=" + RID + "#manager", "Manager (menu and staff)")}</div>
      <p class="note">These open with the owner's or a manager's Google sign-in. The owner adds managers under Owner → Staff.</p>
      <div class="label">Demo</div>
      <p>Clear all orders, alerts, tables and dashboard history so the next demo starts fresh. The menu and staff list stay.</p>
      <button class="btn danger" data-act="reset">${armed ? "Tap again to erase everything" : "Reset demo"}</button></section>`);
    const draw = () => { for (let i = 1; i <= TABLES; i++) { const el = document.getElementById("qr" + i); if (el && !el.childNodes.length && keys[i]) new QRCode(el, { text: tableLink(i, keys[i]), width: 132, height: 132, correctLevel: QRCode.CorrectLevel.M }); }
      screens.forEach(([k]) => { const el = document.getElementById("sqr-" + k); if (el && !el.childNodes.length && staffTok) new QRCode(el, { text: staffLink(k), width: 132, height: 132, correctLevel: QRCode.CorrectLevel.M }); }); };
    if (window.QRCode) draw(); else window.addEventListener("load", draw, { once: true });
  }
  // A sheet of table cards to print and cut out: name, table number, QR, one line of instructions.
  function printCards() {
    let sheet = document.getElementById("printsheet"); if (sheet) sheet.remove();
    sheet = document.createElement("div"); sheet.id = "printsheet";
    sheet.innerHTML = Array.from({ length: TABLES }, (_, i) => `<div class="pcard"><div class="pname">${esc(rname())}</div><div class="ptable">Table ${i + 1}</div>
      <div class="pqr" id="pqr${i + 1}"></div><div class="phow">Scan to see the menu, order,<br>call your waiter and split the bill</div></div>`).join("");
    document.body.appendChild(sheet);
    for (let i = 1; i <= TABLES; i++) { try { new QRCode(document.getElementById("pqr" + i), { text: tableLink(i, keys[i]), width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M }); } catch {} }
    document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); sheet.remove(); };
    window.addEventListener("afterprint", done, { once: true });
    setTimeout(() => { try { window.print(); } catch { done(); } }, 300);
  }
  document.addEventListener("click", async (e) => {
    const pr = e.target.closest("button[data-act=print]");
    if (pr) { printCards(); return; }
    const rk = e.target.closest("button[data-rekey]");
    if (rk) { const n = +rk.dataset.rekey;
      if (rekey !== n) { rekey = n; render(); setTimeout(() => { if (rekey === n) { rekey = null; render(); } }, 4000); return; }
      rekey = null; try { keys[n] = await tableKey(n, true); const el = document.getElementById("qr" + n); if (el) el.innerHTML = ""; render(); toast(`Table ${n} has a new code. Reprint its card.`); } catch (err) { fail(err); } return; }
    const tb = e.target.closest("button[data-tables]");
    if (tb) { TABLES = Math.max(1, Math.min(80, TABLES + Number(tb.dataset.tables))); render(); try { await saveConfig(); } catch (err) { fail(err); } loadKeys(false); return; }
    const rs = e.target.closest("button[data-act=rotstaff]");
    if (rs) { if (!rotStaff) { rotStaff = true; render(); setTimeout(() => { rotStaff = false; render(); }, 4000); return; }
      rotStaff = false; staffTok = null; render(); await loadStaff(true); toast("New staff codes made. Scan them with each staff phone."); return; }
    const sh = e.target.closest("button[data-share]");
    if (sh && unlocked) { const n = +sh.dataset.share; SHARED = isShared(n) ? SHARED.filter((x) => x !== n) : [...SHARED, n].sort((x, y) => x - y);
      render(); try { await saveConfig(); toast(`Table ${n} is now ${isShared(n) ? "shared" : "a normal table"}`); } catch (err) { fail(err); } return; }
    const r = e.target.closest("button[data-act=rotate]");
    if (r && unlocked) { if (!rot) { rot = true; render(); setTimeout(() => { rot = false; render(); }, 4000); return; }
      rot = false; keys = {}; render(); await loadKeys(true); toast("New QR codes made. Reprint them for the tables."); return; }
    const b = e.target.closest("button"); if (!b || b.dataset.act !== "reset" || !unlocked) return;
    if (!armed) { armed = true; render(); setTimeout(() => { armed = false; render(); }, 4000); return; }
    b.disabled = true; b.textContent = "Erasing…";
    try {
      for (const col of [rcol("lines"), rcol("alerts"), rcol("tables"), rcol("groups"), rcol("sessions"), rcol("codes"), rcol("passes")]) {
        const s = await getDocs(col); let batch = writeBatch(db), n = 0;
        for (const d of s.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
        await batch.commit();
      }
      try { Object.keys(localStorage).filter((k) => k.startsWith("dees-me-" + RID + "-")).forEach((k) => localStorage.removeItem(k)); } catch {}
      toast("Demo reset");
    } catch (err) { fail(err); }
    armed = false; render();
  });
  render();
  loadKeys(false); loadStaff(false);
  cfgListeners.add(() => render());
}

// ================= OWNER =================
// The owner sees everything. A manager sees only Menu and Staff, and can't add owners or managers.
// Both have signed in with Google (see adminGate); the database rules hold the same limits.
function ownerScreen(role) {
  const owner = role === "owner", Title = owner ? "Owner" : "Manager";
  $("#wrap").classList.add("wide"); $("#sub").textContent = Title; document.title = Title + " · " + rname();
  const unlocked = true;
  const myEmail = auth.currentUser && auth.currentUser.email;
  const TABS = owner ? [["dash", "Dashboard"], ["menu", "Menu"], ["brand", "Look"], ["staff", "Staff"], ["tables", "Tables & QR"]] : [["menu", "Menu"], ["staff", "Staff"], ["tables", "Tables & QR"]];
  const S = { tab: TABS[0][0], edit: null, period: "7", m: null, loading: false, armed: null, pending: false, busy: "", admins: null, pins: null };
  // Who can sign in: the owner (set on the account by the company) and the managers the owner adds.
  // Waiter PINs live in restaurants/{RID}/secrets/waiters, readable only by the owner and managers.
  const pinsRef = () => rdoc("secrets", "waiters");
  async function loadPins() { try { const d = await getDoc(pinsRef()); S.pins = (d.exists() && d.data().pins) || {}; } catch { S.pins = {}; } render(); }
  async function savePins(msg) { try { await setDoc(pinsRef(), { pins: S.pins, t: Date.now() }); toast(msg); } catch (e) { fail(e); } render(); }
  async function loadAdmins() {
    let list = [];
    try { const s = await getDocs(rcol("admins")); list = s.docs.map((d) => ({ email: d.id, role: "manager" })).sort((a, b) => a.email.localeCompare(b.email)); } catch (e) {}
    S.admins = [...(ACCOUNT ? [{ email: ACCOUNT.ownerEmail, role: "owner" }] : []), ...list]; render();
  }
  const STN = Object.entries(STATIONS);

  const dur = (ms) => { if (ms == null) return "–"; const s = ms / 1000; if (s < 60) return Math.round(s) + " s";
    const m = s / 60; if (m < 60) return (m < 10 ? m.toFixed(1) : Math.round(m)) + " min"; return Math.floor(m / 60) + " h " + Math.round(m % 60) + " min"; };
  const editing = () => { const a = document.activeElement; return a && /^(INPUT|SELECT)$/.test(a.tagName) && $("#view").contains(a); };
  cfgListeners.add(() => { if (!unlocked) return; if (editing()) S.pending = true; else render(); });
  document.addEventListener("focusout", () => setTimeout(() => { if (S.pending && !editing()) { S.pending = false; render(); } }, 0));
  async function save(msg) { try { await saveConfig(); toast(msg || "Saved"); } catch (e) { fail(e); } }
  const arm = (key) => { S.armed = key; render(); setTimeout(() => { if (S.armed === key) { S.armed = null; render(); } }, 4000); };

  function render() {
    if (!TABS.some(([k]) => k === S.tab)) S.tab = TABS[0][0];
    paint(subBanner() + `<div class="seg" role="tablist" style="max-width:520px">${TABS.map(([k, l]) => `<button aria-pressed="${S.tab === k}" data-otab="${k}">${l}</button>`).join("")}</div>
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
      ${S.pins == null ? (loadPins(), "") : ""}
      <div class="grid" style="max-width:640px">${WAITERS.map((w, i) => `<div class="wrow"><div class="vrow"><input class="field" id="wn-${i}" data-f="wname" data-i="${i}" value="${esc(w.name)}" aria-label="Waiter name">
        <button class="btn danger" data-delw="${i}">${S.armed === "w" + i ? "Tap again" : "Remove"}</button></div>
        <form class="vrow pinset" data-wid="${esc(w.id)}"><span class="pill ${(S.pins || {})[w.id] ? "s-ready" : "s-new"}">${S.pins == null ? "…" : (S.pins || {})[w.id] ? "PIN set" : "No PIN yet"}</span>
          <input class="field num" id="wp-${i}" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="${(S.pins || {})[w.id] ? "New PIN" : "4-digit PIN"}" aria-label="PIN for ${esc(w.name)}">
          <button class="btn">${(S.pins || {})[w.id] ? "Change" : "Set PIN"}</button></form></div>`).join("")}</div>
      <p class="note">Each waiter starts a shift on their own phone with their name and PIN. Tell them their PIN in person. Changing a PIN ends that waiter's current shift.</p>
      <form id="addw" class="vrow" style="max-width:520px;margin-top:10px"><input class="field" id="addwin" maxlength="20" placeholder="New waiter's name"><button class="btn primary">Add</button></form>
      ${owner ? `<div class="label">Owner and managers</div>
      <p class="note" style="margin-top:0">They sign in with Google. Managers can edit the menu and staff and open Setup; the owner also sees the dashboard and look, and adds or removes managers.</p>
      ${S.admins == null ? (loadAdmins(), `<p class="note">Loading…</p>`) : `<div class="grid" style="max-width:520px">${S.admins.map((a) => `<div class="vrow"><span class="field" style="overflow:hidden;text-overflow:ellipsis">${esc(a.email)}${a.email === myEmail ? " (you)" : ""}</span>
        <span class="pill ${a.role === "owner" ? "s-ready" : "s-preparing"}">${a.role === "owner" ? "Owner" : "Manager"}</span>
        ${a.email === myEmail || a.role === "owner" ? "" : `<button class="btn danger" data-deladmin="${esc(a.email)}">${S.armed === "a" + a.email ? "Tap again" : "Remove"}</button>`}</div>`).join("")}</div>`}
      <form id="addadmin" class="vrow" style="max-width:520px;margin-top:10px"><input class="field" id="adminemail" type="email" autocomplete="off" placeholder="New manager's Google email">
        <button class="btn primary">Add</button></form>
      <p class="note">Waiter, kitchen, bar and grill phones don't need an account: they scan the staff code on the Setup page.</p>
      <div class="label">Subscription</div>
      ${ACCOUNT ? `<p style="margin-top:0">${ACCOUNT.status === "active" ? `Paid until <b>${day(ACCOUNT.paidUntil)}</b>.` : "Not active."} ${esc(COMPANY.name)} costs ${price()}.</p>
      <p class="note">Owner on the account: ${esc(ACCOUNT.ownerEmail)}. To renew, or to hand the restaurant to a new owner, contact ${contactLine()}</p>` : `<p class="note">Contact ${contactLine()}</p>`}` : ""}</section>`;
  }

  // ----- dashboard -----
  async function load() {
    S.loading = true; render();
    const since = S.period === "all" ? 0 : S.period === "today" ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(S.period) * 864e5;
    try {
      const [ls, as, ss, ts] = await Promise.all([
        getDocs(since ? query(rcol("lines"), where("t", ">=", since)) : rcol("lines")),
        getDocs(since ? query(rcol("alerts"), where("t", ">=", since)) : rcol("alerts")),
        getDocs(since ? query(rcol("sessions"), where("closed", ">=", since)) : rcol("sessions")),
        getDocs(query(rcol("groups"), where("open", "==", true)))]);
      const open = ts.docs.map((d) => d.data()).filter((t) => Object.keys(t.people || {}).length);
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
    for (const r of rows) { batch.set(idOf ? rdoc(col, idOf(r)) : doc(rcol(col)), r); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
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
    if (e.target.classList.contains("pinset")) {
      const wid = e.target.dataset.wid, inp = e.target.querySelector("input"), p = inp.value.trim();
      if (!/^\d{4}$/.test(p)) return toast("Use exactly 4 digits");
      if (Object.entries(S.pins || {}).some(([k, v]) => k !== wid && v === p)) return toast("Another waiter already has that PIN. Pick a different one.");
      S.pins = { ...(S.pins || {}), [wid]: p }; inp.value = ""; savePins(`PIN set for ${wname(wid)}`);
    }
    if (e.target.id === "addw") { const n = $("#addwin").value.trim(); if (!n) return; WAITERS = [...WAITERS, { id: uid("w"), name: n }]; save(`${n} added`); $("#addwin").value = ""; render(); }
    if (owner && e.target.id === "addadmin") {
      const em = $("#adminemail").value.trim().toLowerCase(), r = "manager";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return toast("Enter their Google email address");
      try { await setDoc(rdoc("admins", em), { role: r, email: em, by: myEmail || "", t: Date.now() }); toast(`${em} added as ${r}`); $("#adminemail").value = ""; loadAdmins(); } catch (err) { fail(err); }
    }
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !unlocked) return; const d = b.dataset;
    const ix = (s) => s.split(".").map(Number);
    if (!owner && (d.font || d.preset || d.period || ["resetcolors", "rmlogo", "sample", "unsample", "reload"].includes(d.act))) return;
    if (d.otab === "tables") { location.href = `${BASE}?r=${RID}#setup`; return; }
    if (d.otab) { if (!TABS.some(([k]) => k === d.otab)) return; S.tab = d.otab; S.edit = null; if (S.tab === "dash") S.m = null; render(); }
    else if (d.out) { const [si, ii] = ix(d.out), it = MENU[si].items[ii]; it.out = !it.out; render(); save(it.out ? `${it.n} marked sold out` : `${it.n} back on the menu`); }
    else if (d.edit !== undefined) { S.edit = d.edit || null; render(); }
    else if (d.addv) { const [si, ii] = ix(d.addv); MENU[si].items[ii].v.push(["", MENU[si].items[ii].v.at(-1)[1]]); render(); save(); }
    else if (d.rmv) { const [si, ii, vi] = ix(d.rmv); MENU[si].items[ii].v.splice(vi, 1); render(); save(); }
    else if (d.additem) { const si = +d.additem; MENU[si].items.push({ n: "New item", v: [["", 10000]] }); S.edit = `${si}.${MENU[si].items.length - 1}`; render(); save("Item added. Set its name and price."); }
    else if (d.delitem) { if (S.armed !== "i" + d.delitem) return arm("i" + d.delitem); const [si, ii] = ix(d.delitem); const n = MENU[si].items[ii].n; MENU[si].items.splice(ii, 1); S.edit = null; S.armed = null; render(); save(`${n} deleted`); }
    else if (d.delsec) { if (S.armed !== "s" + d.delsec) return arm("s" + d.delsec); MENU.splice(+d.delsec, 1); S.armed = null; render(); save("Section deleted"); }
    else if (d.act === "addsec") { MENU.push({ c: "New section", st: "kitchen", items: [] }); render(); save("Section added. Rename it and choose its station."); }
    else if (d.deladmin && owner) { if (S.armed !== "a" + d.deladmin) return arm("a" + d.deladmin); S.armed = null;
      try { await deleteDoc(rdoc("admins", d.deladmin)); toast(`${d.deladmin} can no longer sign in`); loadAdmins(); } catch (err) { fail(err); } }
    else if (d.delw) { if (S.armed !== "w" + d.delw) return arm("w" + d.delw); const w = WAITERS[+d.delw]; WAITERS = WAITERS.filter((_, i) => i !== +d.delw); S.armed = null; render(); save(`${w.name} removed`);
      if (S.pins && S.pins[w.id]) { const { [w.id]: _gone, ...rest } = S.pins; S.pins = rest; savePins(`${w.name} removed`); } }
    else if (d.font) { BRAND = { ...BRAND, font: d.font }; applyBrand(); render(); save(`${FONTS[d.font].name} fonts applied`); }
    else if (d.preset) { const [, a, c] = PRESETS[+d.preset]; BRAND = { ...BRAND, c1: a, c2: c }; applyBrand(); render(); save("Colours updated"); }
    else if (d.act === "resetcolors") { BRAND = { ...BRAND, c1: null, c2: null }; applyBrand(); render(); save("Original colours back"); }
    else if (d.act === "rmlogo") { const old = BRAND.logo; BRAND = { ...BRAND, logo: null }; applyBrand(); render(); await save("Logo removed"); deleteDoc(rdoc("photos", old)).catch(() => {}); }
    else if (d.rmphoto) { const [si, ii] = ix(d.rmphoto), it = MENU[si].items[ii], old = it.img; delete it.img; render(); await save("Photo removed"); deleteDoc(rdoc("photos", old)).catch(() => {}); }
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
      try { for (const col of [rcol("lines"), rcol("alerts"), rcol("sessions")]) {
          const s = await getDocs(query(col, where("sample", "==", true))); let batch = writeBatch(db), n = 0;
          for (const x of s.docs) { batch.delete(x.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
          await batch.commit(); }
        toast("Sample data removed"); } catch (err) { fail(err); }
      S.busy = ""; S.m = null; render();
    }
  });
  render();
  // First visit, or settings saved by an older version: save once so the order price list is in place.
  if (!CFG_SAVED || (CFG_STALE && owner)) cfgReady.then(() => {
    if (CFG_SAVED && !(CFG_STALE && owner)) return;
    if (!CFG_SAVED && ACCOUNT) { BRAND = { ...BRAND, name: ACCOUNT.name || BRAND.name }; TABLES = ACCOUNT.tables || TABLES; applyBrand(); }
    save(CFG_SAVED ? "Settings updated" : RID === RESTAURANT_ID ? "Menu copied into the editor" : "Welcome! Add your menu below."); render(); });
}

// ================= COMPANY (the Order App business) =================
// For the company running the platform: approve restaurants, record payments, pause, change owners.
const slug = (n) => { const x = String(n).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30); return x.length >= 3 ? x : (x || "restaurant") + "-place"; };
const addMonths = (t, m) => { const d = new Date(t); d.setMonth(d.getMonth() + m); return d.getTime(); };
function companyScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Company"; document.title = "Company · " + COMPANY.name;
  const h = $("#brandname"); if (h) h.textContent = COMPANY.name;
  const C = { u: null, ok: false, claimed: true, list: [], team: [], filter: "all", busy: "", err: "", armed: null, edit: null };
  async function check() {
    paint(`<p class="empty">Loading…</p>`);
    C.u = await authReady(); C.ok = await isCompanyUser(C.u);
    if (!C.ok) { try { C.claimed = (await getDoc(doc(db, "meta", "company"))).exists(); } catch { C.claimed = true; } return render(); }
    await load();
  }
  async function load() {
    try {
      C.list = (await getDocs(collection(db, "accounts"))).docs.map((d) => ({ rid: d.id, ...d.data() }));
      C.team = (await getDocs(collection(db, "company"))).docs.map((d) => ({ email: d.id, ...d.data() }));
    } catch (e) { C.err = denied(e) ? "This account can't read the company records." : "Couldn't load. Check the connection."; }
    render();
  }
  const arm = (k) => { C.armed = k; render(); setTimeout(() => { if (C.armed === k) { C.armed = null; render(); } }, 4000); };
  const badge = (a) => { const st = subState(a);
    return { pending: ["s-new", "Waiting for approval"], suspended: ["s-served", "Paused"], expired: ["s-new", `Stopped · unpaid since ${day(st.until)}`],
      grace: ["s-preparing", `Overdue · stops ${day(st.stops)}`], soon: ["s-preparing", `Paid until ${day(st.until)}`], ok: ["s-ready", `Paid until ${day(st.until)}`], none: ["", "?"] }[st.kind]; };
  function card(a) {
    const st = subState(a), [cls, txt] = badge(a), k = (x) => C.armed === x + a.rid;
    const who = `${esc(a.ownerEmail)}${a.ownerName ? ` (${esc(a.ownerName)})` : ""}${a.phone ? ` · ${esc(a.phone)}` : ""}${a.area ? ` · ${esc(a.area)}` : ""}`;
    if (st.kind === "pending") return `<article class="ticket new"><header><b>${esc(a.name)}</b><span class="pill ${cls}">${txt}</span></header>
      <p class="note" style="margin:4px 0 0">${who}${a.tables ? ` · ${a.tables} tables` : ""} · applied ${a.created ? day(a.created) : ""}</p>
      <div class="acts"><button class="btn primary" data-approve="${a.rid}" data-days="30">Approve · 30-day trial</button><button class="btn" data-approve="${a.rid}" data-days="60">60-day trial</button>
        <button class="btn danger" data-reject="${a.rid}">${k("rej") ? "Tap again to reject" : "Reject"}</button></div></article>`;
    return `<article class="ticket ${st.live ? "preparing" : ""}"><header><b>${esc(a.name)}</b><span class="pill ${cls}">${txt}</span></header>
      <p class="note" style="margin:4px 0 0">Owner: ${who}${a.plan ? ` · ${esc(a.plan)}` : ""}${a.lastPayment ? ` · last payment ${day(a.lastPayment)}` : ""}</p>
      <div class="acts">
        <button class="btn primary" data-pay="${a.rid}" data-months="1">${k("pay1") ? `Tap again: TSh ${fmt(COMPANY.monthly)} received` : "+1 month paid"}</button>
        <button class="btn primary" data-pay="${a.rid}" data-months="12">${k("pay12") ? `Tap again: TSh ${fmt(COMPANY.yearly)} received` : "+1 year paid"}</button>
        <button class="btn ${a.status === "suspended" ? "" : "danger"}" data-sus="${a.rid}">${a.status === "suspended" ? "Switch back on" : k("sus") ? "Tap again to pause" : "Pause"}</button>
        <button class="btn ghost" data-own="${a.rid}">Change owner</button>
        <a class="btn ghost" href="${BASE}?r=${esc(a.rid)}#owner">Open</a></div>
      ${C.edit === a.rid ? `<form class="vrow ownform" data-rid="${a.rid}" style="margin-top:8px"><input class="field" type="email" id="own-${a.rid}" placeholder="New owner's Google email" value="${esc(a.ownerEmail)}"><button class="btn primary">Save owner</button></form>
        <p class="note">The new owner signs in with this Google account. The old owner loses access straight away. Managers stay.</p>` : ""}
      ${a.status === "suspended" && st.kind !== "suspended" ? "" : a.status === "active" && !st.live ? `<p class="note">Switched on but unpaid: record a payment to start it again.</p>` : ""}</article>`;
  }
  function render() {
    if (!C.ok) {
      const signedIn = isAccount(C.u) && C.u.email;
      return paint(`<section><div class="label" style="margin-top:0">${esc(COMPANY.name)} company page</div>
        ${signedIn ? `<p><b>${esc(C.u.email)}</b> isn't on the company team.</p>` : `<p>For the ${esc(COMPANY.name)} team: approve restaurants, record payments and manage subscriptions.</p>`}
        ${!C.claimed ? `<p>No one has set up the company page yet. The first Google account to do so runs it, and can add partners later.</p>
          <button class="btn primary big" data-act="co-claim" ${C.busy ? "disabled" : ""}>${signedIn ? "Make this account the company admin" : "Sign in with Google and set up"}</button>`
          : signedIn ? `<button class="btn" data-act="co-out">Use a different Google account</button>` : `<button class="btn primary big" data-act="co-in">Sign in with Google</button>`}
        ${C.err ? `<p class="err">${esc(C.err)}</p>` : ""}</section>`);
    }
    const by = (k) => C.list.filter((a) => subState(a).kind === k);
    const pending = by("pending"), overdue = by("grace"), stopped = [...by("expired"), ...by("suspended")];
    const rest = C.list.filter((a) => subState(a).kind !== "pending").sort((a, b) => a.name.localeCompare(b.name));
    const shown = C.filter === "overdue" ? overdue : C.filter === "stopped" ? stopped : rest;
    const live = C.list.filter((a) => subState(a).live).length;
    paint(`<section>
      <div class="kpis">
        <div class="kpi"><div class="kv num">${live}</div><div class="kl">Running</div></div>
        <div class="kpi"><div class="kv num">${pending.length}</div><div class="kl">Waiting</div></div>
        <div class="kpi"><div class="kv num">${overdue.length}</div><div class="kl">Overdue</div></div>
        <div class="kpi"><div class="kv num">${stopped.length}</div><div class="kl">Stopped or paused</div></div></div>
      ${C.err ? `<p class="err">${esc(C.err)}</p>` : ""}
      ${pending.length ? `<div class="label">Waiting for approval</div><div class="grid">${pending.map(card).join("")}</div>` : ""}
      <div class="label">Restaurants</div>
      <div class="row">${[["all", "All"], ["overdue", "Overdue"], ["stopped", "Stopped or paused"]].map(([k, l]) => `<button class="chip" data-filter="${k}" aria-pressed="${C.filter === k}">${l}</button>`).join("")}</div>
      <div class="grid" style="margin-top:10px">${shown.map(card).join("") || `<p class="note">None.</p>`}</div>
      <p class="note">Payments add a month or a year from the paid-until date (or from today if it has passed). After the paid-until date a restaurant keeps working for ${COMPANY.graceDays} days with a warning, then stops until paid. Pause stops it straight away. Nothing is ever deleted.</p>
      <div class="label">Add a restaurant yourself</div>
      <form id="coadd" class="grid" style="max-width:520px"><input class="field" id="coname" placeholder="Restaurant name" maxlength="60">
        <input class="field" id="coemail" type="email" placeholder="Owner's Google email">
        <div class="vrow"><label class="note" for="codays" style="margin:0">Free trial days</label><input class="field num" id="codays" inputmode="numeric" value="30"></div>
        <button class="btn primary">Add and switch on</button></form>
      <div class="label">Company team</div>
      <div class="grid" style="max-width:520px">${C.team.map((t) => `<div class="vrow"><span class="field">${esc(t.email)}${t.email === C.u.email ? " (you)" : ""}</span>${t.email === C.u.email ? "" : `<button class="btn danger" data-deltm="${esc(t.email)}">${C.armed === "tm" + t.email ? "Tap again" : "Remove"}</button>`}</div>`).join("")}</div>
      <form id="coteam" class="vrow" style="max-width:520px;margin-top:10px"><input class="field" id="cotm" type="email" placeholder="Partner's Google email"><button class="btn">Add</button></form>
    </section>`);
  }
  const acc = (rid) => doc(db, "accounts", rid);
  const find = (rid) => C.list.find((a) => a.rid === rid);
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    try {
      if (d.act === "co-in" || d.act === "co-claim") {
        C.busy = "in"; C.err = ""; render();
        let u = isAccount(C.u) && C.u.email ? C.u : null;
        try { if (!u) u = (await googleSignIn()).user; } catch (err) { C.err = authMessage(err); C.busy = ""; return render(); }
        if (d.act === "co-claim" && !(await isCompanyUser(u))) {
          const batch = writeBatch(db);
          batch.set(doc(db, "company", u.email), { name: u.displayName || "", t: Date.now() });
          batch.set(doc(db, "meta", "company"), { by: u.email });
          try { await batch.commit(); } catch (err) { if (!denied(err)) throw err; C.err = "The company page has already been set up by someone else."; }
        }
        C.busy = ""; return check();
      }
      if (d.act === "co-out") { await signOutUser(); return check(); }
      if (!C.ok) return;
      if (d.filter) { C.filter = d.filter; return render(); }
      if (d.approve) { const days = Number(d.days);
        await updateDoc(acc(d.approve), { status: "active", paidUntil: Date.now() + days * DAY, plan: "trial", approved: Date.now() });
        toast(`${find(d.approve).name} approved: ${days}-day trial`); return load(); }
      if (d.reject) { if (C.armed !== "rej" + d.reject) return arm("rej" + d.reject); C.armed = null; await deleteDoc(acc(d.reject)); toast("Application removed"); return load(); }
      if (d.pay) { const m = Number(d.months), key = "pay" + m + d.pay; if (C.armed !== key) return arm(key); C.armed = null;
        const a = find(d.pay), until = addMonths(Math.max(Date.now(), a.paidUntil || 0), m), amount = m === 12 ? COMPANY.yearly : COMPANY.monthly * m;
        const batch = writeBatch(db);
        batch.update(acc(d.pay), { status: "active", paidUntil: until, plan: m === 12 ? "yearly" : "monthly", lastPayment: Date.now() });
        batch.set(doc(collection(db, "accounts", d.pay, "payments")), { amount, months: m, until, by: C.u.email, t: Date.now() });
        await batch.commit(); toast(`${a.name}: paid until ${day(until)}`); return load(); }
      if (d.sus) { const a = find(d.sus);
        if (a.status === "suspended") { await updateDoc(acc(d.sus), { status: "active" }); toast(`${a.name} switched back on`); return load(); }
        if (C.armed !== "sus" + d.sus) return arm("sus" + d.sus); C.armed = null;
        await updateDoc(acc(d.sus), { status: "suspended" }); toast(`${a.name} paused`); return load(); }
      if (d.own) { C.edit = C.edit === d.own ? null : d.own; return render(); }
      if (d.deltm) { if (C.armed !== "tm" + d.deltm) return arm("tm" + d.deltm); C.armed = null; await deleteDoc(doc(db, "company", d.deltm)); toast("Removed"); return load(); }
    } catch (err) { fail(err); }
  });
  document.addEventListener("submit", async (e) => {
    e.preventDefault(); if (!C.ok) return;
    const f = e.target, valid = (x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);
    try {
      if (f.classList.contains("ownform")) { const rid = f.dataset.rid, em = $("#own-" + rid).value.trim().toLowerCase();
        if (!valid(em)) return toast("Enter their Google email");
        await updateDoc(acc(rid), { ownerEmail: em }); C.edit = null; toast(`Owner is now ${em}`); return load(); }
      if (f.id === "coadd") { const name = $("#coname").value.trim(), em = $("#coemail").value.trim().toLowerCase(), days = Math.max(1, Number($("#codays").value) || 30);
        if (!name) return toast("Enter the restaurant's name"); if (!valid(em)) return toast("Enter the owner's Google email");
        let rid = slug(name); for (let i = 2; C.list.some((a) => a.rid === rid) || (await getDoc(acc(rid))).exists(); i++) rid = slug(name) + "-" + i;
        await setDoc(acc(rid), { name, ownerEmail: em, status: "active", paidUntil: Date.now() + days * DAY, plan: "trial", created: Date.now(), approved: Date.now() });
        toast(`${name} added. Send the owner: ${BASE}?r=${rid}#owner`); return load(); }
      if (f.id === "coteam") { const em = $("#cotm").value.trim().toLowerCase(); if (!valid(em)) return toast("Enter their Google email");
        await setDoc(doc(db, "company", em), { name: "", by: C.u.email, t: Date.now() }); toast(`${em} added to the company team`); return load(); }
    } catch (err) { fail(err); }
  });
  check().catch((e) => paint(errorBox(e)));
}

// ================= SIGN-UP (a new restaurant applies) =================
function signupScreen() {
  $("#sub").textContent = "Register your restaurant"; document.title = "Register · " + COMPANY.name;
  const h = $("#brandname"); if (h) h.textContent = COMPANY.name;
  const U = { u: null, mine: [], busy: false, err: "", done: null, form: false };
  async function check() {
    paint(`<p class="empty">Loading…</p>`);
    U.u = await authReady();
    if (isAccount(U.u) && U.u.email) U.mine = (await myRestaurants(U.u)).filter((m) => m.role === "owner");
    render();
  }
  function render() {
    const err = U.err ? `<p class="err">${esc(U.err)}</p>` : "", D = U.draft || {};
    const intro = `<p style="margin-top:0">Guests order and pay from their own phones by scanning a QR code on the table. Orders go straight to your kitchen and bar screens, the bill splits itself, and you see the night's numbers on your dashboard.</p>
      <p class="note">${price()}, after a free trial. Nothing to install.</p>`;
    if (!isAccount(U.u) || !U.u.email) return paint(`<section><div class="label" style="margin-top:0">Register your restaurant</div>${intro}
      <p>Sign in with the Google account you'll use as the owner.</p>
      <button class="btn primary big" data-act="su-in" ${U.busy ? "disabled" : ""}>${U.busy ? "Signing in…" : "Sign in with Google"}</button>${err}</section>`);
    const list = U.mine.length ? `<div class="label">Your restaurants</div><div class="grid" style="max-width:520px">${U.mine.map((m) => { const st = subState(m.acct);
      return `<a class="ticket ${st.live ? "preparing" : ""}" style="display:block;text-decoration:none;color:inherit" href="${BASE}?r=${esc(m.rid)}#owner"><b>${esc(m.name)}</b>
        <div class="note" style="margin:2px 0 0">${st.kind === "pending" ? "Waiting for approval. We'll be in touch." : st.live ? "Running · open the owner page" : st.kind === "suspended" ? "Paused" : "Subscription ended"}</div></a>`; }).join("")}</div>` : "";
    if (U.done) return paint(`<section><div class="label" style="margin-top:0">Thanks! ${esc(U.done)} is registered</div>
      <p>We'll call you to check the details and switch it on, usually within a day. Then sign in on the owner page to add your menu and print your table QR codes.</p>
      <p class="note">Questions? ${contactLine()}</p>${list}</section>`);
    if (U.mine.length && !U.form) return paint(`<section>${list}<button class="btn" data-act="su-new" style="margin-top:14px">Register another restaurant</button>
      <p class="note">Signed in as ${esc(U.u.email)}.</p></section>`);
    paint(`<section><div class="label" style="margin-top:0">Register your restaurant</div>${intro}
      <form id="suform" class="grid" style="max-width:520px">
        <label class="note" for="suname" style="margin:0">Restaurant name</label><input class="field" id="suname" maxlength="60" autocomplete="organization" value="${esc(D.name || "")}">
        <label class="note" for="suowner" style="margin:0">Your name</label><input class="field" id="suowner" maxlength="40" autocomplete="name" value="${esc(D.ownerName ?? (U.u.displayName || ""))}">
        <label class="note" for="suphone" style="margin:0">Phone number</label><input class="field" id="suphone" inputmode="tel" autocomplete="tel" placeholder="0748 227 000" value="${esc(D.phone || "")}">
        <label class="note" for="suarea" style="margin:0">Area (e.g. Masaki, Dar es Salaam)</label><input class="field" id="suarea" maxlength="60" value="${esc(D.area || "")}">
        <label class="note" for="sutables" style="margin:0">Number of tables</label><input class="field num" id="sutables" inputmode="numeric" value="${D.tables || 10}">
        <button class="btn primary big" ${U.busy ? "disabled" : ""}>${U.busy ? "Sending…" : "Register"}</button></form>${err}
      <p class="note">The owner signs in with <b>${esc(U.u.email)}</b>. <button class="linkbtn" data-act="su-out">Use a different Google account</button></p></section>`);
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const a = b.dataset.act;
    if (a === "su-in" && !U.busy) { U.busy = true; U.err = ""; render(); try { await googleSignIn(); } catch (err) { U.err = authMessage(err); } U.busy = false; check(); }
    if (a === "su-out") { await signOutUser(); check(); }
    if (a === "su-new") { U.form = true; render(); }
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "suform") return; e.preventDefault();
    // Read everything before redrawing: a redraw resets the form.
    const name = $("#suname").value.trim(), phone = $("#suphone").value.trim(), tables = Math.max(1, Math.min(80, Number($("#sutables").value) || 10));
    const ownerName = $("#suowner").value.trim(), area = $("#suarea").value.trim();
    U.draft = { name, phone, tables, ownerName, area };
    if (!name) { U.err = "Enter your restaurant's name."; return render(); }
    if (phone.replace(/\D/g, "").length < 9) { U.err = "Enter a phone number we can call."; return render(); }
    U.busy = true; U.err = ""; render();
    const data = { name, ownerEmail: U.u.email.toLowerCase(), ownerName, phone, area, tables, status: "pending", created: Date.now() };
    // The id becomes part of every link (?r=…). If it's taken, the database refuses and we add a suffix.
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      const rid = slug(name) + (i ? "-" + Math.random().toString(36).slice(2, 5) : "");
      try { await setDoc(doc(db, "accounts", rid), data); ok = true; } catch (err) { if (!denied(err)) { U.err = "Couldn't send. Check your connection and try again."; break; } }
    }
    U.busy = false; if (ok) { U.done = name; U.form = false; U.draft = null; U.mine = (await myRestaurants(U.u)).filter((m) => m.role === "owner"); } else if (!U.err) U.err = "Couldn't register. Try a slightly different name.";
    render();
  });
  check().catch((e) => paint(errorBox(e)));
}

// ================= MY ACCOUNT (diners) =================
// One account across every restaurant on the platform: visits are listed by restaurant.
function accountScreen() {
  $("#sub").textContent = "My account"; document.title = "My account";
  const S = { user: null, profile: null, visits: [], loading: true, armed: false, err: "" };
  onUser(async (u) => {
    if (u && !isAccount(u)) u = null;   // the quiet sign-in every phone has isn't an account
    S.user = u || null; S.loading = !!u;
    if (u) { try { const p = await getDoc(dinerRef(u.uid)); S.profile = p.exists() ? p.data() : null; S.visits = await myVisits(u.uid); } catch (e) { S.err = "Couldn't load your visits. Check your connection."; } }
    S.loading = false; render();
  });
  const back = () => { const t = store.get("dees-lasttable"); return t ? `<a class="btn" href="${esc(t)}">Back to your table</a>` : ""; };
  const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  function render() {
    if (S.loading) return paint(`<p class="empty">Loading…</p>`);
    if (!S.user) return paint(`<section><div class="label" style="margin-top:0">My account</div>
      <p>You're not signed in on this phone. Scan the QR code on a table and choose "Continue with phone number" or Google to sign in.</p>
      ${back()}</section>`);
    const by = {}; S.visits.forEach((v) => { (by[v.rid] ||= { name: v.rname, list: [] }).list.push(v); });
    const groups = Object.values(by).sort((a, b) => b.list[0].date - a.list[0].date);
    const who = S.user.phoneNumber || S.user.email || "";
    paint(`<section>
      <div class="acct"><div class="avatar">${esc(((S.profile && S.profile.name) || "?").slice(0, 1).toUpperCase())}</div>
        <div><b style="font-size:20px">${esc((S.profile && S.profile.name) || "Diner")}</b><div class="note" style="margin:0">${esc(who)}</div></div></div>
      ${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}
      <div class="label">Your visits</div>
      ${groups.length ? groups.map((g) => `<div class="ticket preparing" style="margin-bottom:12px">
          <header><b>${esc(g.name)}</b><span class="note" style="margin:0">${g.list.length} visit${g.list.length > 1 ? "s" : ""} · TSh ${fmt(g.list.reduce((a, v) => a + (v.share || 0), 0))}</span></header>
          ${g.list.map((v) => `<div class="oline"><span class="l">${day(v.date)} · Table ${v.table}<br><span class="note">${(v.items || []).map((i) => esc(i.n)).join(", ") || "Nothing ordered"}</span></span><span class="num">TSh ${fmt(v.share)}</span></div>`).join("")}
        </div>`).join("") : `<p class="note">No visits yet. They'll appear here after your table's bill is closed.</p>`}
      <div class="label">Settings</div>
      <label class="optin"><input type="checkbox" id="acctoffers" ${S.profile && S.profile.offers ? "checked" : ""}> <span>WhatsApp offers from restaurants I've visited</span></label>
      <div class="grid" style="margin-top:20px">${back()}
        <button class="btn" data-act="signout">Sign out</button>
        <button class="btn danger" data-act="delete">${S.armed ? "Tap again to delete everything" : "Delete my account and data"}</button></div>
      <p class="note">Each restaurant only sees your visits to it, never your visits elsewhere.</p></section>`);
  }
  document.addEventListener("change", async (e) => {
    if (e.target.id !== "acctoffers" || !S.user) return;
    try { await updateDoc(dinerRef(S.user.uid), { offers: e.target.checked }); S.profile = { ...(S.profile || {}), offers: e.target.checked }; toast("Saved"); } catch (err) { fail(err); }
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !S.user) return; const d = b.dataset;
    if (d.act === "signout") { try { await signOutUser(); } catch {} toast("Signed out"); }
    if (d.act === "delete") {
      if (!S.armed) { S.armed = true; render(); setTimeout(() => { S.armed = false; render(); }, 4000); return; }
      b.disabled = true; b.textContent = "Deleting…";
      try {
        const u = S.user.uid, batch = writeBatch(db);
        (await getDocs(query(visitsCol, where("uid", "==", u)))).docs.forEach((x) => batch.delete(x.ref));
        batch.delete(dinerRef(u)); await batch.commit();
        await deleteMe(); toast("Your account and visits are deleted");
      } catch (err) { S.err = authMessage(err); }
      S.armed = false; render();
    }
  });
  render();
}

function errorBox(e) {
  return `<section><div class="err">${denied(e)
    ? "This phone doesn't have access to that. Diners: scan the QR code on your table. Staff: scan the staff code from the Setup page."
    : "Can't reach the database. Check your internet connection, then reload."}</div><p class="note">${esc(e && (e.code || e.message))}</p></section>`;
}
