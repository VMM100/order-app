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
import { genericPhoto } from "./photos.js";

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

// Each table has a secret key printed in its QR code, so a table can't be joined by guessing its number.
const keyRef = (n) => doc(db, "tablekeys", String(n));
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
async function tableKey(n, rotate) {
  let k = null;
  await runTransaction(db, async (tx) => { const s = await tx.get(keyRef(n)); k = !rotate && s.exists() && s.data().k;
    if (!k) { k = newKey(); tx.set(keyRef(n), { k, t: Date.now() }); } });
  return k;
}
const tableLink = (n, k) => `${BASE}?t=${n}&k=${k}`;

// Menu, staff and owner PIN live in one database document the owner edits.
// Until the owner saves for the first time, the starting menu from menu.js is used.
// The database can't store a list inside a list, so prices are saved as {l, p} pairs.
const cfgRef = doc(db, "config", "restaurant");
let MENU = START_MENU, WAITERS = START_WAITERS, PIN = "1234", MPIN = "5678", SHARED = [], CFG_SAVED = false;
let BRAND = { name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...(store.get("dees-brand") || {}) };
const cfgListeners = new Set();
// Resolves once the restaurant settings (menu, shared tables…) have loaded, or failed to.
let cfgLoaded; const cfgReady = new Promise((r) => (cfgLoaded = r));
const menuFromDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: (c.items || []).map((it) => ({ ...it, v: (it.v || []).map((x) => [x.l || "", Number(x.p) || 0]) })) }));
const menuToDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: c.items.map((it) => {
  const o = { n: it.n, v: it.v.map(([l, p]) => ({ l: l || "", p: Number(p) || 0 })) };
  if (it.d) o.d = it.d; if (it.m) o.m = it.m; if (it.out) o.out = true; if (it.img) o.img = it.img; return o; }) }));
onSnapshot(cfgRef, (snap) => {
  if (snap.exists()) { const d = snap.data(); if (d.sections) MENU = menuFromDb(d.sections); if (d.waiters) WAITERS = d.waiters; if (d.pin) PIN = d.pin; if (d.mpin) MPIN = d.mpin; SHARED = d.shared || []; if (d.brand) { BRAND = { name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...d.brand }; store.set("dees-brand", BRAND); } CFG_SAVED = true; }
  applyBrand();
  cfgLoaded(); cfgListeners.forEach((f) => f());
}, () => cfgLoaded());
const saveConfig = () => setDoc(cfgRef, { sections: menuToDb(MENU), waiters: WAITERS, pin: PIN, mpin: MPIN, shared: SHARED, brand: BRAND, updated: Date.now() });

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

// ---------- groups ----------
// A group is one party ordering and paying together. Small tables have one group at a time;
// tables the owner marks as shared can hold several groups, each with its own code and bill.
const groupsCol = collection(db, "groups");
const groupRef = (sid) => doc(db, "groups", sid);
const isShared = (n) => SHARED.includes(Number(n));
const gname = (g) => (g && g.label ? `${g.label}'s group` : "New group");
// "Table 8", or "Table 8 · Amani's group" when the table has more than one group or is shared.
const where_ = (g, all) => `Table ${g.table}` + (isShared(g.table) || (all || []).filter((x) => x.table === g.table && x.open).length > 1 ? ` · ${gname(g)}` : "");

async function newCode() {
  for (let i = 0; i < 6; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    const s = await getDocs(query(groupsCol, where("code", "==", c)));
    if (!s.docs.some((d) => d.data().open)) return c;
  }
  return String(Date.now()).slice(-4);
}
const newGroup = (n, code) => ({ table: Number(n), session: `${n}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, code,
  opened: Date.now(), waiter: null, people: {}, split: "order", paid: {}, open: true, label: null });
// Small table: join the group already there, or start one. The transaction stops two phones scanning
// at the same moment from creating two groups.
async function tableGroup(n) {
  const code = await newCode(); let sid = null;
  await runTransaction(db, async (tx) => {
    const ts = await tx.get(tableRef(n)), cur = ts.exists() && ts.data().current;
    if (cur) { const g = await tx.get(groupRef(cur)); if (g.exists() && g.data().open) { sid = cur; return; } }
    const g = newGroup(n, code); tx.set(groupRef(g.session), g); tx.set(tableRef(n), { table: Number(n), current: g.session }); sid = g.session;
  });
  return sid;
}
async function startGroup(n) { const g = newGroup(n, await newCode()); await setDoc(groupRef(g.session), g); return g.session; }
async function openGroups() { const s = await getDocs(query(groupsCol, where("open", "==", true))); return s.docs.map((d) => d.data()); }

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
if (STATIONS[view]) stationScreen(view);
else if (view === "waiter") waiterScreen();
else if (view === "setup") setupScreen();
else if (view === "owner") ownerScreen("owner");
else if (view === "manager") ownerScreen("manager");
else dinerScreen();

// ================= DINER =================
function dinerScreen() {
  const S = { n: params.get("t"), sid: null, g: null, lines: [], alerts: [], me: null, cart: [], note: "", cat: 0, tab: "menu", name: params.get("name") || "" };
  // On the demo page several diners share one browser, so each gets its own slot (?as=1, ?as=2).
  const meKey = () => `dees-me-${S.n}${params.get("as") ? "-" + params.get("as") : ""}`;
  let subGroup = null, subLines = null, subAlerts = null;

  // Who may order: someone who scanned the table QR (secret key), someone with a group's current
  // code (a friend's invite), or a guest coming back to the group they already joined.
  async function start() {
    const c = params.get("c"), k = params.get("k");
    if (!S.n && c) return findByCode(c);
    if (!S.n) return codeEntry();
    $("#sub").textContent = `Table ${S.n}`;
    const saved = store.get(meKey());
    await Promise.race([cfgReady, new Promise((r) => setTimeout(r, 5000))]);
    try {
      const open = (await openGroups()).filter((g) => g.table === Number(S.n));
      const mine = saved && open.find((g) => g.session === saved.session);
      if (k) {
        const ks = await getDoc(keyRef(S.n)); S.viaKey = ks.exists() && ks.data().k === k;
        if (!S.viaKey) { S.err = "This QR code is out of date. Ask a waiter, or enter the code from a friend's phone."; return codeEntry(S.n); }
        if (mine) return attach(mine.session);
        if (!isShared(S.n)) return attach(await tableGroup(S.n));
        if (!open.length) return attach(await startGroup(S.n));
        return chooseGroup(open.length);
      }
      const byCode = c && open.find((g) => g.code === c);
      if (byCode) return attach(byCode.session);
      if (mine) return attach(mine.session);
      if (c) S.err = "This invite has expired. Ask your friend for the new code.";
      return codeEntry(S.n);
    } catch (e) { paint(errorBox(e)); }
  }
  function attach(sid) {
    S.sid = sid; S.access = true; S.err = "";
    subGroup && subGroup(); subLines && subLines(); subAlerts && subAlerts();
    subGroup = onSnapshot(groupRef(sid), (snap) => {
      S.g = snap.data() || null;
      const saved = store.get(meKey());
      S.me = S.g && saved && saved.session === sid && S.g.people && S.g.people[saved.pid] ? saved : null;
      render();
    }, (e) => paint(errorBox(e)));
    subLines = onSnapshot(query(linesCol, where("session", "==", sid)), (s) => { S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.t - b.t); render(); });
    const acked = new Set(); let primed = false;
    subAlerts = onSnapshot(query(alertsCol, where("session", "==", sid)), (s) => {
      S.alerts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      S.alerts.forEach((a) => { if (a.ack && !a.done && !acked.has(a.id)) { acked.add(a.id); if (primed) { try { navigator.vibrate?.(300); } catch {} } } });
      primed = true; render();
    });
  }
  async function findByCode(c) {
    paint(`<p class="empty">Finding your friends…</p>`);
    try {
      const hit = (await openGroups()).find((g) => g.code === String(c).trim());
      if (!hit) { S.err = "No open table or group with that code. Check the number with your friend."; return codeEntry(S.n); }
      const as = params.get("as");
      history.replaceState(null, "", `${BASE}?t=${hit.table}&c=${hit.code}${as ? "&as=" + as : ""}`);
      params.set("t", hit.table); params.set("c", hit.code); params.delete("k"); S.n = String(hit.table);
      $("#sub").textContent = `Table ${S.n}`; attach(hit.session);
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
    S.choosing = true; $("#cart").hidden = true;
    paint(`<section><div class="tablebar"><b>Table ${esc(S.n)}</b><span class="note" style="margin:0">Shared table · ${count} group${count > 1 ? "s" : ""} ordering</span></div>
      <div class="label">Here with friends who already ordered?</div>
      <p style="margin-top:0">Enter the 4-digit code shown on their phone.</p>
      <form id="codeform" class="grid"><input class="field num" id="codein" inputmode="numeric" maxlength="4" placeholder="Their group code" autocomplete="off">
      <button class="btn primary big">Join their group</button></form>${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}
      <div class="label">New here?</div>
      <button class="btn big" data-act="newgroup">Start a new group</button>
      <p class="note">Each group orders and pays separately, so you only see your own bill.</p></section>`);
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
    if (!S.me) {
      $("#cart").hidden = true;
      const names = Object.values(g.people || {}).map((p) => esc(p.name));
      return paint(`<section><div class="tablebar"><b>Table ${esc(S.n)}</b><span class="note" style="margin:0">${names.length ? `With ${names.join(", ")}` : shared ? "Starting a new group" : "You're the first one here"}</span></div>
        <div class="label">What's your name?</div>
        <form id="joinform" class="grid"><input class="field" id="namein" maxlength="16" placeholder="First name" autocomplete="given-name" value="${esc(S.name)}">
        <button class="btn primary big">Join ${shared ? "group" : "table"}</button></form>
        <p class="note">Your name shows on your orders so ${shared ? "your group" : "the table"} can split the bill.</p></section>`);
    }
    const open = S.alerts.filter((a) => !a.done);
    const banners = open.filter((a) => a.ack).map((a) => `<div class="ontheway" role="status"><span>${esc(wname(a.ackBy) || "Your waiter")} ${a.type === "bill" ? "is bringing your bill" : "is on the way to your table"}</span><span class="note">${ago(a.ack)}</span></div>`).join("");
    const tabs = [["menu", "Menu"], ["orders", `${shared ? "Our order" : "Table order"}${S.lines.length ? ` (${S.lines.length})` : ""}`], ["bill", "Bill"]];
    let body = "";
    if (S.tab === "menu") {
      if (S.cat >= MENU.length) S.cat = 0;
      // One continuous list: every section in order, with its heading. The category bar sticks under
      // the header and highlights whichever section is on screen (see spy() below).
      body = `<div class="cats" id="cats">${MENU.map((m, i) => `<button class="chip" aria-pressed="${i === S.cat}" data-cat="${i}">${esc(m.c)}</button>`).join("")}</div>
       ${MENU.map((cat, ci) => `<div class="msec" id="sec-${ci}" data-sec="${ci}"><h2 class="sech"><span>${esc(cat.c)}</span><small>${cat.items.length} item${cat.items.length === 1 ? "" : "s"}</small></h2>
       ${cat.items.map((it, ii) => { const gp = !it.img && genericPhoto(it.n); return `<div class="item${it.out ? " out" : ""}${it.img || gp ? " withph" : ""}">${it.img ? `<div class="ph"><img data-photo="${esc(it.img)}" alt="${esc(it.n)}" loading="lazy"></div>` : gp ? `<div class="ph loaded"><img src="${gp}" alt="${esc(it.n)}" loading="lazy"></div>` : ""}<h3>${esc(it.n)}${it.out ? ` <span class="pill s-served">Sold out</span>` : ""}</h3>${it.d ? `<p class="d">${esc(it.d)}</p>` : ""}${it.m ? `<div class="meta">${esc(it.m)}</div>` : ""}
       ${it.out ? "" : `<div class="vars">${it.v.map(([l, p], vi) => `<button class="var" data-add="${ci}.${ii}.${vi}">${l ? esc(l) + " " : "Add "}<span class="num">TSh ${fmt(p)}</span></button>`).join("")}</div>`}</div>`; }).join("")}</div>`).join("")}`;
    } else if (S.tab === "orders") {
      body = Object.entries(g.people || {}).map(([pid, p]) => { const ls = S.lines.filter((l) => l.pid === pid);
        return `<div class="who">${esc(p.name)}${pid === S.me.pid ? " (you)" : ""}</div>` + (ls.length ? ls.map((l) => `<div class="oline"><span class="l">${label(l)}</span><span class="pill s-${l.s}">${l.s}</span></div>`).join("") : `<p class="note" style="margin:2px 0">Nothing yet</p>`); }).join("");
    } else body = billHtml(g, S.lines, false) + `<p class="note">Pay your waiter as usual. In-app mobile money comes later.</p>`;
    paint(`<section>
      <div class="tablebar"><div><b>Table ${esc(S.n)}</b><div class="note" style="margin:2px 0 0">${shared ? `${esc(gname(g))} · ` : ""}Hi ${esc(S.me.name)} · friends join with code</div></div>
       <div class="row"><span class="code num">${esc(g.code)}</span><button class="btn" data-act="share">Share</button></div></div>
      ${banners}
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
      if (S.choosing) {
        const hit = (await openGroups()).find((g) => g.table === Number(S.n) && g.code === c);
        if (!hit) { S.err = "That code doesn't match a group at this table. Check it on your friend's phone."; return chooseGroup((await openGroups()).filter((g) => g.table === Number(S.n)).length); }
        S.choosing = false; return attach(hit.session);
      }
      findByCode(c);
    }
    if (e.target.id === "joinform") {
      const name = $("#namein").value.trim(); if (!name) return;
      const pid = uid("p"), patch = { [`people.${pid}`]: { name, t: Date.now() } };
      if (!S.g.label) patch.label = name;
      try { await updateDoc(groupRef(S.sid), patch);
        store.set(meKey(), { pid, name, session: S.sid }); S.me = { pid, name, session: S.sid }; render();
      } catch (err) { fail(err); }
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
      try { await addDoc(alertsCol, { table: Number(S.n), session: S.sid, type: d.alert, pid: S.me.pid, pname: S.me.name, t: Date.now(), ack: null, ackBy: null, done: false });
        toast(S.g.waiter ? `${wname(S.g.waiter)} has been notified` : "All waiters notified"); } catch (err) { fail(err); }
    }
    else if (d.act === "place" && S.cart.length && !S.placing) {
      S.placing = true; renderCart();
      const batch = writeBatch(db), bid = uid("b"), now = Date.now();
      S.cart.forEach((l) => batch.set(doc(linesCol), { table: Number(S.n), session: S.sid, batch: bid, pid: S.me.pid, pname: S.me.name,
        n: l.n, v: l.v, pr: l.pr, st: l.st, s: "new", t: now, note: S.note.trim() || null }));
      try { await batch.commit(); const sts = [...new Set(S.cart.map((l) => STATIONS[l.st]))]; S.cart = []; S.note = ""; toast("Sent to " + sts.join(" and ")); }
      catch (err) { fail(err); }
      S.placing = false; render();
    }
    else if (d.act === "share") {
      const link = `${BASE}?c=${S.g.code}`, what = isShared(S.n) ? "group" : "table";
      const txt = `Join our ${what} at ${rname()}: ${link} (code ${S.g.code}, works until the ${what} closes)`;
      try { if (navigator.share) { await navigator.share({ text: txt }); return; } } catch { return; }
      try { await navigator.clipboard.writeText(txt); toast("Invite copied. Paste it in WhatsApp."); } catch { toast(`Code: ${S.g.code}`); }
    }
    else if (d.act === "newgroup" && S.viaKey) { S.choosing = false; try { attach(await startGroup(S.n)); } catch (err) { fail(err); } }
    else if (d.act === "newsession" && S.viaKey) { S.access = false; S.sid = null; S.g = null; S.me = null; start(); }
  });
  setInterval(() => { if (S.alerts.some((a) => a.ack && !a.done)) render(); }, 30000);
  cfgListeners.add(() => { S.cart = S.cart.filter((c) => !soldOut(c.n)); render(); });
  start();
}

// ================= STATION (kitchen / bar / grill) =================
function stationScreen(st) {
  $("#wrap").classList.add("wide"); $("#sub").textContent = STATIONS[st] + " screen"; document.title = STATIONS[st] + " · " + rname();
  const S = { lines: [], groups: {}, all: [] }; const notify = watcher();
  onSnapshot(query(linesCol, where("s", "in", ["new", "preparing", "ready"])), (s) => {
    S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => l.st === st);
    notify(S.lines.filter((l) => l.s === "new").map((l) => l.batch)); render();
  }, (e) => paint(errorBox(e)));
  onSnapshot(query(groupsCol, where("open", "==", true)), (s) => { S.all = s.docs.map((d) => d.data()); S.groups = {}; S.all.forEach((g) => (S.groups[g.session] = g)); render(); });
  const NEXT = { new: ["preparing", "Start"], preparing: ["ready", "Ready"] };
  function render() {
    const batches = [...new Set(S.lines.sort((a, b) => a.t - b.t).map((l) => l.batch))];
    const tix = batches.map((b) => {
      const bl = S.lines.filter((l) => l.batch === b), s = bl.some((l) => l.s === "new") ? "new" : bl.some((l) => l.s === "preparing") ? "preparing" : "ready";
      const nx = NEXT[s], note = bl.find((l) => l.note), g = S.groups[bl[0].session], w = g && g.waiter;
      return `<article class="ticket ${s}"><header><b>${esc(g ? where_(g, S.all) : `Table ${bl[0].table}`)}</b><span class="note" style="margin:0">${esc(bl[0].pname)} · ${ago(bl[0].t)}</span></header>
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
  cfgListeners.add(render);
}

// ================= WAITER =================
function waiterScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Waiter"; document.title = "Waiter · " + rname();
  const S = { me: store.get("dees-waiter"), groups: [], lines: [], alerts: [], open: null, confirm: null };
  const notify = watcher();
  onSnapshot(query(groupsCol, where("open", "==", true)), (s) => { S.groups = s.docs.map((d) => d.data()).sort((a, b) => a.table - b.table || a.opened - b.opened); update(); }, (e) => paint(errorBox(e)));
  onSnapshot(query(linesCol, where("s", "in", ["new", "preparing", "ready"])), (s) => { S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })); update(); });
  onSnapshot(query(alertsCol, where("done", "==", false)), (s) => { S.alerts = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.t - b.t); update(); });
  // Bill totals need every line of the group, including served ones.
  let billSub = null, billLines = [];
  function watchBill(sid) { billSub && billSub(); billLines = []; if (!sid) return;
    billSub = onSnapshot(query(linesCol, where("session", "==", sid)), (s) => { billLines = s.docs.map((d) => d.data()); render(); }); }

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
    const pick = `<div class="label" style="margin-top:0">I am</div><div class="row">${WAITERS.map((w) => `<button class="chip" aria-pressed="${w.id === S.me}" data-me="${w.id}">${esc(w.name)}</button>`).join("")}</div>`;
    if (!S.me) return paint(`<section>${pick}<p class="note">Pick your name once. This phone remembers it.</p></section>`);
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
      else if (d.me) { S.me = d.me; store.set("dees-waiter", d.me); update(); }
      else if (d.accept) { await runTransaction(db, async (tx) => { const s = await tx.get(groupRef(d.accept)); if (!s.exists() || s.data().waiter) throw new Error("taken"); tx.update(groupRef(d.accept), { waiter: S.me, accepted: Date.now() }); }); toast(`${name(find(d.accept) || { table: "" })} is yours`); }
      else if (d.release) { await updateDoc(groupRef(d.release), { waiter: null }); toast("Open for another waiter"); }
      else if (d.ack) { await updateDoc(doc(db, "alerts", d.ack), { ack: Date.now(), ackBy: S.me }); toast("Diner told you're on the way"); }
      else if (d.done) await updateDoc(doc(db, "alerts", d.done), { done: true, doneAt: Date.now() });
      else if (d.serve) await updateDoc(doc(db, "lines", d.serve), { s: "served", tServed: Date.now(), servedBy: S.me });
      else if (d.open) { S.open = S.open === d.open ? null : d.open; watchBill(S.open); render(); }
      else if (d.split) await setSplit(d.g, d.split);
      else if (d.paid) { const g = find(d.g); await togglePaid(d.g, d.paid, !!((g && g.paid) || {})[d.paid]); }
      else if (d.confirm) { S.confirm = d.confirm; render(); setTimeout(() => { if (S.confirm === d.confirm) { S.confirm = null; render(); } }, 4000); }
      else if (d.close) { const g = find(d.close), n = g && name(g); await closeGroup(d.close); S.confirm = null; if (S.open === d.close) { S.open = null; watchBill(null); } toast(`${n || "Table"} closed`); }
    } catch (err) { if (err.message === "taken") toast("Another waiter just took it"); else fail(err); }
  });
  async function closeGroup(sid) {
    const g = find(sid); if (!g) return;
    const all = await getDocs(query(linesCol, where("session", "==", sid)));
    const batch = writeBatch(db), now = Date.now();
    // Items never marked served are closed without a serve time, so they don't skew the averages.
    S.lines.filter(live(g)).forEach((l) => batch.update(doc(db, "lines", l.id), { s: "served", closedUnserved: true }));
    S.alerts.filter(live(g)).forEach((a) => batch.update(doc(db, "alerts", a.id), { done: true, doneAt: now }));
    batch.set(doc(db, "sessions", sid), { table: g.table, session: sid, opened: g.opened, accepted: g.accepted || null, closed: now,
      waiter: g.waiter || null, guests: Object.keys(g.people || {}).length, total: tableTotal(all.docs.map((x) => x.data())),
      paid: Object.keys(g.paid || {}).length });
    batch.update(groupRef(sid), { open: false, closed: now });
    await batch.commit();
  }
  setInterval(render, 30000);
  cfgListeners.add(render);
}

// ================= SETUP =================
function setupScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Setup"; document.title = "Setup · " + rname();
  const link = (h, l) => `<div><div class="note" style="margin:0">${l}</div><a href="${h}">${esc(h)}</a></div>`;
  let armed = false, rot = false, keys = {}, unlocked = false;
  try { unlocked = sessionStorage.getItem("dees-setup") === "1"; } catch {}
  async function loadKeys(rotate) {
    try { const ks = await Promise.all(Array.from({ length: TABLE_COUNT }, (_, i) => tableKey(i + 1, rotate))); ks.forEach((k, i) => (keys[i + 1] = k)); }
    catch (e) { fail(e); }
    document.querySelectorAll(".qr .box").forEach((b) => (b.innerHTML = "")); render();
  }
  function render() {
    if (!unlocked) return paint(`<section><div class="label" style="margin-top:0">Setup is for restaurant staff</div>
      <form id="setupform" class="grid" style="max-width:320px"><input class="field num" id="setuppin" type="password" inputmode="numeric" maxlength="6" placeholder="Owner or manager PIN" autocomplete="off">
      <button class="btn primary big">Open setup</button></form></section>`);
    paint(`<section><div class="label" style="margin-top:0">Staff screens · open each on its own phone</div>
      <div class="links">${link(BASE + "demo.html", "Demo stage: several phones on one iPad or laptop")}${link(BASE + "#owner", "Owner (dashboard, menu, look, staff)")}${link(BASE + "#manager", "Manager (menu and staff)")}${link(BASE + "#waiter", "Waiter")}${Object.entries(STATIONS).map(([k, v]) => link(BASE + "#" + k, v)).join("")}</div>
      <div class="label">Table QR codes · diners scan these</div>
      <div class="qrs">${Array.from({ length: TABLE_COUNT }, (_, i) => `<div class="qr"><div class="box" id="qr${i + 1}"></div><b>Table ${i + 1}</b><button class="chip sharetog" data-share="${i + 1}" aria-pressed="${isShared(i + 1)}">${isShared(i + 1) ? "Shared table" : "Normal table"}</button>${keys[i + 1] ? `<a class="note" href="${tableLink(i + 1, keys[i + 1])}">Open</a>` : `<span class="note">Loading…</span>`}</div>`).join("")}</div>
      <p class="note">Each code carries a secret key, so nobody can join a table by guessing its number. Print these for the tables, or screenshot one for a demo.</p>
      <p class="note">Mark big communal tables as <b>Shared</b>: several groups can then order there, each with its own code and bill. On normal tables everyone who scans joins the same bill.</p>
      <button class="btn" data-act="rotate">${rot ? "Tap again: old printed codes will stop working" : "Make new QR codes"}</button>
      <div class="label">Demo</div>
      <p>Clear all orders, alerts, tables and dashboard history so the next demo starts fresh. The menu and staff list stay.</p>
      <button class="btn danger" data-act="reset">${armed ? "Tap again to erase everything" : "Reset demo"}</button></section>`);
    const draw = () => { for (let i = 1; i <= TABLE_COUNT; i++) { const el = document.getElementById("qr" + i); if (el && !el.childNodes.length && keys[i]) new QRCode(el, { text: tableLink(i, keys[i]), width: 132, height: 132, correctLevel: QRCode.CorrectLevel.M }); } };
    if (window.QRCode) draw(); else window.addEventListener("load", draw, { once: true });
  }
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "setupform") return; e.preventDefault();
    const v = $("#setuppin").value.trim();
    if (v === PIN || v === MPIN) { unlocked = true; try { sessionStorage.setItem("dees-setup", "1"); } catch {} render(); loadKeys(false); }
    else { toast("Wrong PIN"); $("#setuppin").value = ""; }
  });
  document.addEventListener("click", async (e) => {
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
      for (const col of [linesCol, alertsCol, tablesCol, groupsCol, sessionsCol]) {
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
  if (unlocked) loadKeys(false);
  cfgListeners.add(() => { if (unlocked) render(); });
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
        getDocs(query(groupsCol, where("open", "==", true)))]);
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
