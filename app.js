// Wasabi (order app): one page, several screens chosen by the link.
//   index.html?t=4        diner at table 4 (what the table QR code opens)
//   index.html?c=4821     diner joining a friend's table by code
//   index.html#waiter     waiter phone
//   index.html#kitchen    kitchen screen (also #bar, #grill)
//   index.html#setup      staff QR, table QR codes and demo reset (owner or manager)
//   index.html#owner      owner: dashboard, menu, look, staff, who can sign in (Google sign-in)
//   index.html#manager    manager: menu and staff only (Google sign-in)
// Who may see and change what is enforced by the database rules in firestore.rules.
import { db, app as fbApp } from "./firebase.js";
import { pushState, enablePush, refreshPush, testRing, ringFor } from "./push.js";
import {
  doc, collection, query, where, onSnapshot, getDocs, runTransaction, documentId,
  updateDoc, addDoc, writeBatch, deleteField, setDoc, getDoc, deleteDoc, collectionGroup,
  disableNetwork, enableNetwork, orderBy, startAfter, limit,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import morphdom from "./vendor/morphdom-esm.js";
import { MENU as START_MENU, STATIONS, WAITERS as START_WAITERS, TABLE_COUNT, RESTAURANT, RESTAURANT_ID } from "./menu.js";
import { auth, onUser, isAccount, ensureUser, authReady, googleSignIn, phoneStart, phoneConfirm, signOutUser, deleteMe, normalisePhone, authMessage } from "./account.js";
import { computeMetrics } from "./metrics.js";
import { genericPhoto } from "./photos.js";
import { COMPANY } from "./platform.js";
import { menuToCsv, readFile, rowsToMenu, mergeMenu } from "./menuio.js";
import { wasabiLockup, wasabiLeaf } from "./brand.js";

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
// The waiter already using this name (ignoring capitals and spaces), other than waiter number `skip`.
function takenName(n, skip = -1) { const k = String(n).trim().toLowerCase().replace(/\s+/g, " "); return WAITERS.find((w, i) => i !== skip && String(w.name).trim().toLowerCase().replace(/\s+/g, " ") === k); }
function fail(e) { console.error(e); toast(denied(e) ? "Not allowed from this phone." : "Could not save. Check your connection and try again."); }
const denied = (e) => String(e && (e.code || e.message)).includes("permission");

// Re-render without losing what someone is typing.
function paint(html) {
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  $("#view").dataset.soft = "";
  $("#view").innerHTML = html;
  hydratePhotos();
  if (id) { const el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
}

// The diner's table screen: change only what's different (one dish going sold out, a new order line,
// the waiter on the way), so photos, scrolling and anything being typed stay as they are.
function paintSoft(html) {
  const view = $("#view");
  if (view.dataset.soft !== "1") { paint(html); view.dataset.soft = "1"; return; }
  morphdom(view, `<main id="view">${html}</main>`, { childrenOnly: true, onBeforeElUpdated(from, to) {
    if (from.isEqualNode(to)) return false;
    if (from === document.activeElement && (from.tagName === "INPUT" || from.tagName === "TEXTAREA")) return false;
    // Photos already shown stay shown (the new HTML doesn't carry the loaded picture).
    if (from.tagName === "IMG" && from.dataset.phDone && from.dataset.photo === to.dataset.photo) {
      to.dataset.phDone = from.dataset.phDone; const src = from.getAttribute("src"); if (src) to.setAttribute("src", src);
    }
    if (from.classList && from.classList.contains("ph")) ["loaded", "none"].forEach((c) => from.classList.contains(c) && to.classList.add(c));
    return true;
  } });
  hydratePhotos();
}
// Pull down to refresh on live screens (table, waiter, kitchen, bar): reconnect and fetch only what
// changed since, instead of reloading the page. A newly published version of the app still reloads.
let APP_VERSION = null;
const appVersion = () => fetch(new URL("version.txt", location.href).href + "?" + Date.now(), { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).then((t) => t.trim()).catch(() => "");
appVersion().then((v) => { APP_VERSION = v || null; });
async function softRefresh() {
  const v = await appVersion();
  if (APP_VERSION && v && v !== APP_VERSION) return "reload";
  await disableNetwork(db); await enableNetwork(db);
  return true;
}

// ---------- the ☰ menu in the header ----------
// Each screen fills it with the things people need now and then; the actions that keep orders moving stay
// on the page. Items: {label, sub, run, href, danger, keep (stay open after the tap)} or {html} for text.
const MENU_UI = { items: [], open: false };
function setMenu(items) {
  MENU_UI.items = items || []; const b = $("#menubtn"); if (b) b.hidden = !MENU_UI.items.length;
  if (!MENU_UI.items.length) MENU_UI.open = false; drawMenu();
}
function drawMenu() {
  const d = $("#drawer"), b = $("#menubtn"); if (!d || !b) return;
  d.hidden = !MENU_UI.open; b.setAttribute("aria-expanded", String(MENU_UI.open));
  if (!MENU_UI.open) return;
  d.innerHTML = MENU_UI.items.map((it, i) => it.html ? `<div class="mitem info">${it.html}</div>`
    : it.href ? `<a class="mitem" href="${esc(it.href)}">${esc(it.label)}${it.sub ? `<span>${esc(it.sub)}</span>` : ""}</a>`
    : `<button class="mitem${it.danger ? " danger" : ""}" data-mi="${i}">${esc(it.label)}${it.sub ? `<span>${esc(it.sub)}</span>` : ""}</button>`).join("");
}
const menuOpen = (open) => { MENU_UI.open = open; drawMenu(); };
document.addEventListener("click", (e) => {
  if (e.target.closest("#menubtn")) return menuOpen(!MENU_UI.open);
  const mi = e.target.closest("[data-mi]");
  if (mi) { const it = MENU_UI.items[+mi.dataset.mi]; if (it && it.run) it.run(); if (!(it && it.keep)) menuOpen(false); else drawMenu(); return; }
  if (MENU_UI.open && !e.target.closest("#drawer")) menuOpen(false);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && MENU_UI.open) { menuOpen(false); $("#menubtn").focus(); } });

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
  ? ""
  : `<div class="soundbar"><span><b>Sound is off.</b> Turn it on to hear new orders and keep the screen awake.</span><button class="btn primary" data-act="sound">Turn on sound</button></div>`;

// Tell staff screens when something new arrives. Tables, orders and alerts load separately when a
// screen opens, so everything that arrives in its first few seconds counts as already there.
function watcher() {
  const seen = new Set(), born = Date.now();
  return (ids) => { let fresh = false; const settled = Date.now() - born > 4000;
    ids.forEach((id) => { if (!seen.has(id)) { seen.add(id); if (settled) fresh = true; } }); if (fresh) beep(); };
}

// ---------- data ----------
// Each restaurant on the platform has its own space: restaurants/{RID}/… holds its settings, tables,
// groups, orders, alerts and staff. RID comes from the link (?r=…), or for owners from their sign-in.
let RID = new URLSearchParams(location.search).get("r") || null;
let IS_CO = false;    // signed in as the company team (only they see the demo stage)
let ACCOUNT = null;   // accounts/{RID}: status, paid-until date, owner (only owners/managers can read it)
const rcol = (name) => collection(db, "restaurants", RID, name);
const rdoc = (name, id) => doc(db, "restaurants", RID, name, String(id));
const tableRef = (n) => rdoc("tables", n);
// Diner accounts work across every restaurant on the platform. diners/{uid} is the profile;
// each visit is a document in visits, labelled with its restaurant (rid).
const visitsCol = collection(db, "visits");
const dinerRef = (u) => doc(db, "diners", u);
// Consent to WhatsApp offers is per restaurant. Every yes or no is logged (diners/{uid}/consents) with the
// exact words the diner saw, when, and where, as proof under Tanzania's Personal Data Protection Act.
// Change OFFERS_VERSION whenever the wording changes.
const OFFERS_VERSION = "2026-10-22";
const offersText = (name) => `Send me ${name}'s offers and news on WhatsApp. I can stop any time in My account.`;
const offersOn = (profile, rid) => !!(profile && profile.offers && typeof profile.offers === "object" && profile.offers[rid]);
function logConsent(batch, u, rid, name, on, source) {
  batch.set(doc(collection(db, "diners", u.uid, "consents")), { rid, rname: name, on, channel: "whatsapp", phone: u.phoneNumber || null,
    text: on ? offersText(name) : `Stop ${name}'s offers on WhatsApp.`, version: OFFERS_VERSION, source, at: Date.now() });
}
// Terms: signing in (phone or Google) needs a ticked "I agree to the Terms and Privacy policy" box.
// The yes is kept on the profile (diners/{uid}.terms) and logged like offers consent, with the exact words
// and version. Change TERMS_VERSION when the terms change: everyone is asked once more.
const TERMS_VERSION = "2026-10-30-draft";
const TERMS_TEXT = "By continuing, you agree to Wasabi's Terms. Read our Privacy policy.";
const termsOk = (p) => !!(p && p.terms && p.terms.v === TERMS_VERSION);
// The tick survives a sign-in round trip (Google, SMS code) in this tab, so nobody is asked twice.
let TERMS_TICK = false;
const termsTicked = () => { if (TERMS_TICK) return true; try { return sessionStorage.getItem("wasabi-terms") === TERMS_VERSION; } catch { return false; } };
function setTermsTick(on) {
  TERMS_TICK = on; try { if (on) sessionStorage.setItem("wasabi-terms", TERMS_VERSION); else sessionStorage.removeItem("wasabi-terms"); } catch {}
}
// Shown right under the sign-in buttons; tapping one of them (or Continue) is agreeing, and is logged.
const termsBox = (verb = "continuing") => `<p class="note terms-note">By ${verb}, you agree to ${esc(COMPANY.name)}'s <a href="terms.html" target="_blank" rel="noopener">Terms</a>. Read our <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a>.</p>`;
const needTerms = () => "";
const agree = () => setTermsTick(true);
// Adds the agreement to a batch: on the profile (merged, so it can be the first thing on it) and in the log.
function logTerms(batch, u, profile, source) {
  const at = Date.now(), terms = { v: TERMS_VERSION, at };
  batch.set(dinerRef(u.uid), profile ? { terms } : { terms, phone: u.phoneNumber || null, email: u.email || null, offers: {}, offerNames: {}, created: at }, { merge: true });
  batch.set(doc(collection(db, "diners", u.uid, "consents")), { rid: "wasabi", rname: COMPANY.name, on: true, channel: "terms", phone: u.phoneNumber || null,
    text: TERMS_TEXT, version: TERMS_VERSION, source, at });
  return terms;
}
// Owner, manager, company and sign-up pages sign in with Google directly: the same tick, logged after.
function recordTerms(u, source) {
  if (!u || !termsTicked()) return;
  const b = writeBatch(db); logTerms(b, u, {}, source); b.commit().catch(() => {});
}
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
// Sold out tonight: names from restaurants/{rid}/live/stock (fast, small), plus any old "out" flag saved
// inside the menu itself (oldOut). it.out is what every screen shows.
let STOCK_OUT = new Set();
const applyStock = () => MENU.forEach((c) => c.items.forEach((it) => { it.out = !!it.oldOut || STOCK_OUT.has(it.n); }));
const stockRef = () => rdoc("live", "stock");
// A restaurant's logo until its owner uploads one (or removes it, which saves "" rather than nothing).
// Paths starting with img/ are files in this app; anything else is a photo id in the database.
const DEFAULT_LOGOS = { "crafty-dees": "img/logos/crafty-dees.png" };
const withDefaultLogo = (b) => (b.logo == null && RID && DEFAULT_LOGOS[RID] ? { ...b, logo: DEFAULT_LOGOS[RID] } : b);
const isFileLogo = (id) => typeof id === "string" && id.startsWith("img/");
let BRAND = withDefaultLogo({ name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...((RID && store.get("dees-brand-" + RID)) || {}) });
let TABLES = TABLE_COUNT, PAUSED = false;
const cfgListeners = new Set();
// Resolves once the restaurant settings (menu, shared tables…) have loaded, or failed to.
let cfgLoaded; const cfgReady = new Promise((r) => (cfgLoaded = r));
const menuFromDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: (c.items || []).map((it) => ({ ...it, oldOut: !!it.out, v: (it.v || []).map((x) => [x.l || "", Number(x.p) || 0]) })) }));
const menuToDb = (secs) => secs.map((c) => ({ c: c.c, st: c.st, items: c.items.map((it) => {
  const o = { n: it.n, v: it.v.map(([l, p]) => ({ l: l || "", p: Number(p) || 0 })) };
  if (it.d) o.d = it.d; if (it.m) o.m = it.m; if (legacyOut(it)) o.out = true; if (it.img) o.img = it.img; return o; }) }));
// Only the old in-menu flag is saved with the menu; tonight's sold-out list lives in live/stock.
const legacyOut = (it) => ("oldOut" in it ? it.oldOut : !!it.out);
// New restaurants start with two empty sections; the demo restaurant starts with Crafty Dee's menu.
const starterMenu = () => (RID === RESTAURANT_ID ? START_MENU : [{ c: "Drinks", st: "bar", items: [] }, { c: "Food", st: "kitchen", items: [] }]);
let cfgStarted = false, cfgTries = 0, PAUSED_AT = 0;
function listenConfig() {
  onSnapshot(cfgRef(), (snap) => {
    step("settings arrived");
    // Ordering was shown as off, but the settings came through after all: start again cleanly.
    if (PAUSED) { location.reload(); return; }
    if (snap.exists()) { const d = snap.data(); if (d.sections) MENU = menuFromDb(d.sections); if (d.waiters) WAITERS = d.waiters; CFG_STALE = !d.prices || "pin" in d || "mpin" in d; SHARED = d.shared || []; if (d.tables) TABLES = d.tables; if (d.brand) { BRAND = withDefaultLogo({ name: RESTAURANT, logo: null, c1: null, c2: null, font: "brew", ...d.brand }); store.set("dees-brand-" + RID, BRAND); } CFG_SAVED = true; }
    applyStock(); applyBrand();
    cfgLoaded(); cfgListeners.forEach((f) => f());
  }, async (e) => {
    // A refusal can be a hiccup (sign-in still settling, a new rules version rolling out). Ask again twice,
    // after making sure this phone is signed in, before telling diners ordering is off.
    if (denied(e) && cfgTries < 2) { cfgTries++; step("settings refused, asking again"); try { await ensureUser(); } catch {} setTimeout(listenConfig, 800 * cfgTries); return; }
    if (denied(e)) { PAUSED = true; PAUSED_AT = Date.now(); step("settings refused"); }
    cfgLoaded(); cfgListeners.forEach((f) => f());
  });
}
function startConfig() {
  if (cfgStarted || !RID) return; cfgStarted = true;
  if (RID !== RESTAURANT_ID) { MENU = starterMenu(); WAITERS = []; }
  listenConfig();
  // Sold-out changes arrive on their own: only this small list, never the whole menu.
  onSnapshot(stockRef(), (snap) => {
    STOCK_OUT = new Set(Object.keys((snap.exists() && snap.data().out) || {}));
    applyStock(); cfgListeners.forEach((f) => f());
  }, () => {});
}
// prices: "item|option" → price and station, for available items only. The database rules check every
// order against it, so nobody can order something sold out or at a price they typed themselves.
const priceMap = (secs) => { const m = {}; secs.forEach((c) => c.items.forEach((it) => { if (!legacyOut(it)) it.v.forEach(([l, p]) => (m[it.n + "|" + (l || "")] = { p: Number(p) || 0, st: c.st })); })); return m; };
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
// A button colour whose text (white or near-black) is readable: deepen or lighten it until it is.
const buttonColour = (c) => { const ink = inkOn(c), toward = ink === "#ffffff" ? "#000000" : "#ffffff"; let out = c;
  for (let t = 0.05; contrast(out, ink) < 4.5 && t <= 1; t += 0.05) out = mix(c, toward, t); return out; };
function brandCss(c1, c2) {
  if (!c1 || !c2) return "";
  const L = { bg: "#f6f4ee", surface: "#ffffff" }, D = { bg: "#161812", surface: "#20231b" };
  const a1 = buttonColour(mix(c1, "#ffffff", lum(c1) < 0.04 ? 0.35 : 0.15)), a2 = readable(c2, D.surface, "#ffffff");
  const b1 = buttonColour(c1);
  const light = `--accent:${b1};--accent-ink:${inkOn(b1)};--accent-soft:${mix(c1, L.surface, 0.84)};--hop:${readable(c2, L.surface, "#000000")};--hop-ink:${inkOn(readable(c2, L.surface, "#000000"))};--hop-soft:${mix(c2, L.surface, 0.86)}`;
  const dark = `--accent:${a1};--accent-ink:${inkOn(a1)};--accent-soft:${mix(c1, D.bg, 0.72)};--hop:${a2};--hop-ink:${inkOn(a2)};--hop-soft:${mix(c2, D.bg, 0.75)}`;
  return `:root{${light}}@media (prefers-color-scheme:dark){:root{${dark}}}`;
}
function applyBrand() {
  let el = document.getElementById("brandvars");
  if (!el) { el = document.createElement("style"); el.id = "brandvars"; document.head.appendChild(el); }
  // A new restaurant that hasn't picked colours yet starts in Wasabi green (the demo restaurant keeps its amber).
  const fresh = !BRAND.c1 && RID && RID !== RESTAURANT_ID;
  el.textContent = brandCss(fresh ? "#9cc43c" : BRAND.c1, fresh ? "#4a6716" : BRAND.c2) + fontCss(BRAND.font);
  if (BRAND.font && BRAND.font !== "brew" && FONTS[BRAND.font]) loadFonts("brandfont", [BRAND.font]);
  // Wasabi's own pages (no restaurant) keep the Wasabi logo; a restaurant shows its saved name, never
  // the demo restaurant's name as a stand-in.
  const h = $("#brandname"); if (h && RID) h.textContent = BRAND.name || (RID === RESTAURANT_ID ? RESTAURANT : h.textContent);
  const lg = $("#brandlogo"); if (lg) { if (BRAND.logo) { lg.dataset.photo = BRAND.logo; lg.hidden = false; delete lg.dataset.phDone; hydratePhotos(); } else { lg.hidden = true; lg.removeAttribute("src"); } }
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
// Speed: photos load only as they come near the screen, and the ones needed together arrive in one
// request (up to 30 at a time), instead of one request per dish.
const photoCache = new Map(), photoWant = new Set();
let photoTimer = null;
function photoFor(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  let done; const p = new Promise((r) => (done = r)); p.done = done;
  photoCache.set(id, p); photoWant.add(id);
  clearTimeout(photoTimer); photoTimer = setTimeout(fetchPhotos, 25);
  return p;
}
function fetchPhotos() {
  const ids = [...photoWant]; photoWant.clear();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    getDocs(query(rcol("photos"), where(documentId(), "in", chunk)))
      .then((s) => { const got = new Map(s.docs.map((d) => [d.id, d.data().data])); chunk.forEach((id) => photoCache.get(id).done(got.get(id) || null)); })
      .catch(() => chunk.forEach((id) => { photoCache.get(id).done(null); photoCache.delete(id); }));   // try again next time
  }
}
async function showPhoto(img) {
  const id = img.dataset.photo, src = await photoFor(id);
  if (src && img.dataset.photo === id) { img.src = src; img.closest(".ph")?.classList.add("loaded"); } else if (!src) img.closest(".ph")?.classList.add("none");
}
const photoSeen = "IntersectionObserver" in window
  ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { photoSeen.unobserve(e.target); showPhoto(e.target); } }), { rootMargin: "800px 0px" })
  : null;
function hydratePhotos() {
  document.querySelectorAll("img[data-photo]").forEach((img) => {
    const id = img.dataset.photo; if (!id || img.dataset.phDone === id) return;
    img.dataset.phDone = id;
    if (isFileLogo(id)) { img.src = id; img.closest(".ph")?.classList.add("loaded"); return; }
    if (photoSeen) photoSeen.observe(img); else showPhoto(img);
  });
}
// ---------- QR codes in the restaurant's look ----------
// Dots in the restaurant's dark colour, the three corner squares in its accent colour, and its logo on a
// white badge in the middle. Uses the highest error correction (30%), so the logo covering the centre
// still scans. Colours are darkened if needed so every phone camera reads them against white.
function qrColours() {
  const fresh = !BRAND.c1 && RID && RID !== RESTAURANT_ID;
  const c1 = BRAND.c1 || (fresh ? "#9cc43c" : "#a8650f"), c2 = BRAND.c2 || (fresh ? "#4a6716" : "#3f5a2c");
  const deepen = (c, min) => { let out = c; for (let t = 0.1; contrast(out, "#ffffff") < min && t <= 1; t += 0.1) out = mix(c, "#000000", t); return out; };
  return { dot: deepen(c2, 7), eye: deepen(c1, 4.5), eyeDot: deepen(c2, 7) };
}
async function qrLogo() {
  if (!BRAND.logo) return null;
  const src = isFileLogo(BRAND.logo) ? BRAND.logo : await photoFor(BRAND.logo);
  if (!src) return null;
  return new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
}
async function brandQr(el, text, size) {
  if (!el || !window.QRCode) return;
  // The library works out the code's grid; we draw it ourselves.
  const tmp = document.createElement("div");
  const q = new QRCode(tmp, { text, width: 64, height: 64, correctLevel: QRCode.CorrectLevel.H });
  const m = q && q._oQRCode;
  if (!m || typeof m.getModuleCount !== "function") { el.innerHTML = ""; new QRCode(el, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.H }); return; }
  const n = m.getModuleCount(), quiet = 3, cells = n + quiet * 2, scale = 3;
  const px = Math.floor((size * scale) / cells), W = px * cells;
  const cv = document.createElement("canvas"); cv.width = cv.height = W;
  cv.style.width = cv.style.height = size + "px"; cv.setAttribute("role", "img"); cv.setAttribute("aria-label", "QR code");
  const g = cv.getContext("2d"), C = qrColours();
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, W);
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const at = (k) => (k + quiet) * px;
  // Centre badge: about a fifth of the code, kept clear of dots.
  const badge = Math.max(5, Math.round(n * 0.22)) | 1, b0 = (n - badge) >> 1, b1 = b0 + badge - 1;
  const inEye = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const inBadge = (r, c) => r >= b0 && r <= b1 && c >= b0 && c <= b1;
  g.fillStyle = C.dot;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!m.isDark(r, c) || inEye(r, c) || inBadge(r, c)) continue;
    rr(at(c) + px * 0.04, at(r) + px * 0.04, px * 0.92, px * 0.92, px * 0.26); g.fill();
  }
  // Corner squares: a rounded ring in the accent colour around a rounded dot.
  [[0, 0], [0, n - 7], [n - 7, 0]].forEach(([r, c]) => {
    g.fillStyle = C.eye; rr(at(c), at(r), px * 7, px * 7, px * 2); g.fill();
    g.fillStyle = "#ffffff"; rr(at(c) + px, at(r) + px, px * 5, px * 5, px * 1.3); g.fill();
    g.fillStyle = C.eyeDot; rr(at(c) + px * 2, at(r) + px * 2, px * 3, px * 3, px * 0.9); g.fill();
  });
  el.innerHTML = ""; el.appendChild(cv);
  // Logo (or the restaurant's initial) on a white rounded badge.
  const bx = at(b0), bw = px * badge, pad = px * 0.6;
  g.fillStyle = "#ffffff"; rr(bx, bx, bw, bw, px * 1.4); g.fill();
  const logo = await qrLogo();
  if (logo) {
    const box = bw - pad * 2, k = Math.min(box / logo.naturalWidth, box / logo.naturalHeight);
    const w = logo.naturalWidth * k, h = logo.naturalHeight * k;
    g.save(); rr(bx + pad, bx + pad, box, box, px); g.clip(); g.drawImage(logo, bx + (bw - w) / 2, bx + (bw - h) / 2, w, h); g.restore();
  } else {
    g.fillStyle = C.eye; rr(bx + pad, bx + pad, bw - pad * 2, bw - pad * 2, px); g.fill();
    g.fillStyle = "#ffffff"; g.font = `700 ${Math.round(bw * 0.5)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(((BRAND.name || "W").trim()[0] || "W").toUpperCase(), bx + bw / 2, bx + bw / 2 + bw * 0.03);
  }
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
  if (old && !isFileLogo(old)) deleteDoc(rdoc("photos", old)).catch(() => {});
  return id;
}

// ---------- groups ----------
// A group is one party ordering and paying together. Small tables have one group at a time;
// tables the owner marks as shared can hold several groups, each with its own code and bill.
const groupRef = (sid) => rdoc("groups", sid);
const isShared = (n) => SHARED.includes(Number(n));
// A diner's name as it is now (they can change it at the table); orders and alerts keep the name
// they were made with, used when the table has closed.
const nowName = (g, pid, was) => (g && g.people && g.people[pid] && g.people[pid].name) || was || "A guest";
const gname = (g) => (g && g.label ? `${g.label}'s group` : "New group");
// "Table 8", or "Table 8 · Amani's group" when the table has more than one group or is shared.
const where_ = (g, all) => g && g.tab ? `Bar · ${g.tab}` : `Table ${g.table}` + (isShared(g.table) || (all || []).filter((x) => x.table === g.table && x.open).length > 1 ? ` · ${gname(g)}` : "");

// Diners can't browse groups or codes. To see a table they hold a pass (passes/{their sign-in}),
// which the database only accepts with the table's QR key or an open group's code.
const passRef = (u) => rdoc("passes", u);
// A friend's request to join with the table code; someone at the table answers it.
const joinRef = (u) => rdoc("joins", u);
// invites/{code} → which restaurant a table code belongs to (for codes typed on the front page's scanner).
const inviteRef = (c) => doc(db, "invites", String(c));
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
      tx.set(codeRef(code), { session: sid, table: Number(n) }); tx.set(inviteRef(code), { rid: RID }); tx.set(passRef(me), { ...proof, session: sid, t: Date.now() });
    });
    return sid;
  });
}
// Shared table: a new group of its own.
function startGroup(n, proof) {
  const me = auth.currentUser.uid;
  return withFreshCode(async (code) => {
    const g = newGroup(n, code), b = writeBatch(db);
    b.set(groupRef(g.session), g); b.set(codeRef(code), { session: g.session, table: Number(n) }); b.set(inviteRef(code), { rid: RID }); b.set(passRef(me), { ...proof, session: g.session, t: Date.now() });
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
function billHtml(t, lines, staff, me) {
  const total = tableTotal(lines);
  const all = shares(t, lines), mine = me && all.find((s) => s.pid === me);
  const rows = mine ? [mine, ...all.filter((s) => s !== mine)] : all;
  return `<div class="seg" role="group" aria-label="Split method">
    <button aria-pressed="${t.split !== "equal"}" data-split="order" data-g="${t.session}">By what they ordered</button>
    <button aria-pressed="${t.split === "equal"}" data-split="equal" data-g="${t.session}">Equally</button></div>
   ${mine ? `<div class="myshare"><span>Your share${mine.paid ? " · paid" : ""}</span><b class="num ${mine.paid ? "paid" : ""}">TSh ${fmt(mine.amt)}</b></div>` : ""}
   ${rows.map((s) => `<div class="billrow${s === mine ? " me" : ""}"><div style="min-width:0"><div class="${s.paid ? "paid" : ""}" style="font-weight:600">${esc(s.name)}${s === mine ? " (you)" : ""}</div>
     ${t.split !== "equal" ? `<div class="note" style="margin:0">${s.items.map((l) => esc(l.n)).join(", ") || "Nothing ordered"}</div>` : ""}</div>
     <div class="row" style="flex-wrap:nowrap"><span class="amt num ${s.paid ? "paid" : ""}">${fmt(s.amt)}</span>
     ${staff ? `<button class="btn ${s.paid ? "" : "primary"}" data-paid="${s.pid}" data-g="${t.session}">${s.paid ? "Undo" : "Mark paid"}</button>` : s.paid ? `<span class="pill s-ready">Paid</span>` : ""}</div></div>`).join("")}
   <div class="total"><span>${isShared(t.table) ? "Group total" : "Table total"}</span><span class="num">TSh ${fmt(total)}</span></div>
   ${t.split === "equal" ? `<p class="note">Equal shares round up to the nearest 100 shillings.</p>` : ""}`;
}
async function setSplit(sid, mode) { try { await updateDoc(groupRef(sid), { split: mode }); } catch (e) { fail(e); } }
async function togglePaid(sid, pid, now) { try { await updateDoc(groupRef(sid), { [`paid.${pid}`]: now ? deleteField() : true }); } catch (e) { fail(e); } }

applyBrand();

// Start-up trace: each step a screen waits for is noted with its time, so a stuck screen can say exactly
// where it stopped (shown on "Still connecting…" and in the browser console).
const BOOT = { t0: performance.now(), steps: [] };
function step(name) { BOOT.steps.push([name, Math.round(performance.now() - BOOT.t0)]); }
async function stallReport() {
  const last = BOOT.steps[BOOT.steps.length - 1], net = navigator.onLine ? "connected" : "offline";
  let google = "not checked";
  try { const t = performance.now(); await Promise.race([fetch("https://firestore.googleapis.com/", { mode: "no-cors", cache: "no-store" }),
      new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 4000))]); google = `reachable (${Math.round(performance.now() - t)} ms)`; }
  catch { google = "not reachable"; }
  return { waitingFor: last ? last[0] : "starting", sinceSec: last ? Math.round((performance.now() - BOOT.t0 - last[1]) / 1000) : 0,
    internet: net, database: google, signedIn: !!(auth.currentUser), steps: BOOT.steps.map(([n, ms]) => `${n} ${ms}ms`).join(" · ") };
}

// If a screen is still loading (a skeleton) after 10 seconds, the connection probably stalled
// (it can happen when several live screens start at once on one device). Offer a reload,
// and reload by itself once if nobody taps.
setTimeout(() => {
  const v = $("#view"); if (!v || !(v.firstElementChild && v.firstElementChild.hasAttribute("data-loading"))) return;
  v.innerHTML = `<section><p class="empty">Still connecting…</p><button class="btn primary big" onclick="location.reload()">Reload</button><p class="note" id="stallwhy" style="text-align:center">Checking what's slow…</p></section>`;
  stallReport().then((r) => { console.warn("Wasabi start-up stalled", r); const el = document.getElementById("stallwhy");
    if (el) el.textContent = `Waiting for: ${r.waitingFor} (${r.sinceSec}s) · Internet: ${r.internet} · Database: ${r.database} · Signed in: ${r.signedIn ? "yes" : "no"}`; });
  let once = false; try { once = sessionStorage.getItem("dees-autoreload") === "1"; sessionStorage.setItem("dees-autoreload", "1"); } catch {}
  if (!once) setTimeout(() => location.reload(), 5000);
}, 10000);
setTimeout(() => { try { sessionStorage.removeItem("dees-autoreload"); } catch {} }, 60000);

// ---------- router ----------
const view = location.hash.slice(1);

// ---------- logging out (every page you reach after signing in) ----------
// A Log out button sits in the header while a real account (Google or phone) is signed in on the
// Sign in, owner, manager, Tables & QR and company pages. It goes back to the sign-in options.
// The back arrow: on the owner, manager and company pages it goes back to the "Continue as" choices
// (guest, owner, company…) without logging out; on Sign in itself it asks, then logs out; Tables & QR
// goes back to the owner page.
const LOGIN_PAGES = ["account", "owner", "manager", "setup", "company"];
let SETUP_ROLE = "owner";   // which page Tables & QR's back arrow returns to (set by setupScreen)
let SIGNED_IN = false;
async function logOut() {
  try { await signOutUser(); } catch {}
  toast("Logged out");
  if (view !== "account") location.replace(`${BASE}#account`);
}
function askLogOut() {
  return askSure("Log out?", "Are you sure you want to log out? You'll need to sign in again to get back here.", "Log out", "Stay signed in");
}
// A small yes/no box in the app's own look (never the browser's alert boxes).
function askSure(title, text, yes, no) {
  return new Promise((done) => {
    const back = document.activeElement, d = document.createElement("div"); d.className = "ask";
    d.innerHTML = `<div class="ask-box" role="alertdialog" aria-modal="true" aria-labelledby="ask-t" aria-describedby="ask-d">
      <h2 id="ask-t">${esc(title)}</h2><p id="ask-d">${esc(text)}</p>
      <div class="ask-acts"><button type="button" class="btn big" data-no>${esc(no)}</button><button type="button" class="btn danger big" data-yes>${esc(yes)}</button></div></div>`;
    document.body.appendChild(d); d.querySelector("[data-no]").focus();
    const end = (yes) => { d.remove(); removeEventListener("keydown", key); if (back && back.focus) back.focus(); done(yes); };
    const key = (e) => { if (e.key === "Escape") end(false); };
    addEventListener("keydown", key);
    d.addEventListener("click", (e) => { if (e.target.closest("[data-yes]")) end(true); else if (e.target.closest("[data-no]") || e.target === d) end(false); });
  });
}
if (LOGIN_PAGES.includes(view)) {
  const lb = $("#logoutbtn");
  onUser((u) => { SIGNED_IN = isAccount(u); if (lb) lb.hidden = !SIGNED_IN; });
  if (lb) lb.addEventListener("click", async () => { if (await askLogOut()) logOut(); });
  window.wasabiBack = () => {
    // Tables & QR always goes straight back to its owner or manager page, in one press, however many
    // times the person went back and forth (history would walk through every visit).
    if (view === "setup" && RID) { location.href = `${BASE}?r=${encodeURIComponent(RID)}#${SETUP_ROLE}`; return true; }
    if (!SIGNED_IN) return false;
    if (view !== "account") { location.href = `${BASE}?choose=1#account`; return true; }
    askLogOut().then((yes) => { if (yes) logOut(); });
    return true;
  };
}
window.addEventListener("hashchange", () => location.reload());
const params = new URLSearchParams(location.search);
if (view === "company") companyScreen();
else if (view === "signup") signupScreen();
else if (view === "account") accountScreen();
else if (STATIONS[view] || view === "waiter") staffGate((boss) => (view === "waiter" ? waiterScreen(boss) : stationScreen(view)));
else if (view === "setup") adminGate("setup", (role) => setupScreen(role === "manager" ? "manager" : "owner"));
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
const pausedHtml = () => `<section><p class="empty">Ordering by phone isn't available here right now.<br>Please order with a member of staff.</p>
  <p style="text-align:center"><button class="btn" onclick="location.reload()">Try again</button></p>
  <p class="note" style="text-align:center;opacity:.6">Ref ${esc(RID)} · ${PAUSED_AT ? new Date(PAUSED_AT).toLocaleTimeString("en-GB") : "-"} · ${navigator.onLine ? "online" : "offline"}</p></section>`;

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
  // All three lookups at once: one wait instead of three in a row.
  const [a, m, co] = await Promise.all([getDoc(doc(db, "accounts", RID)).catch(() => null), getDoc(rdoc("admins", em)).catch(() => null), isCompanyUser(u)]);
  if (a && a.exists()) { ACCOUNT = a.data(); if (ACCOUNT.ownerEmail === em) role = "owner"; }
  if (!role && m && m.exists()) role = "manager";
  IS_CO = co;
  if (!role && IS_CO) role = "company";
  return role;
}
// Restaurants this Google account owns or manages (including ones still waiting for approval).
async function myRestaurants(u) {
  const em = u.email.toLowerCase();
  // Both lookups at once, and every restaurant name at once: each trip to the database costs time.
  const [own, adm] = await Promise.all([
    getDocs(query(collection(db, "accounts"), where("ownerEmail", "==", em))).catch(() => null),
    getDocs(query(collectionGroup(db, "admins"), where("email", "==", em))).catch(() => null)]);
  const out = own ? own.docs.map((d) => ({ rid: d.id, name: d.data().name, role: "owner", acct: d.data() })) : [];
  const rids = adm ? [...new Set(adm.docs.map((d) => d.ref.parent.parent.id))].filter((rid) => !out.some((x) => x.rid === rid)) : [];
  out.push(...(await Promise.all(rids.map(async (rid) => {
    let name = rid; try { const r = await getDoc(doc(db, "restaurants", rid)); if (r.exists() && r.data().brand) name = r.data().brand.name || rid; } catch {}
    return { rid, name, role: "manager" }; }))));
  return out;
}
// Waiter, kitchen, bar and grill phones open the staff link from Setup (?r=…&s=…). The phone keeps the
// token and shows it to the database each time. A new staff link signs every staff phone out.
function staffGate(go) {
  const tok = params.get("s");
  if (!RID) RID = store.get("dees-rid");
  if (tok && RID) { store.set("dees-staff-" + RID, tok); store.set("dees-rid", RID); history.replaceState(null, "", `${BASE}?r=${RID}${location.hash}`); }
  paint(skPage());
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
    paint(skPage());
    step("sign-in"); G.u = await authReady(); step("sign-in done");
    if (!isAccount(G.u) || !G.u.email) return show(`<section><div class="label" style="margin-top:0">${title} sign-in</div>
      <p>Sign in with the Google account registered for your restaurant.</p>
      <button class="btn primary big" data-act="admin-in" ${G.busy ? "disabled" : ""}>${G.busy ? "Signing in…" : "Sign in with Google"}</button>${termsBox()}${G.err ? `<p class="err">${esc(G.err)}</p>` : ""}${signupLink}</section>`);
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
    step("checking your access"); const role = await adminRole(G.u); step("access checked");
    if (!role) return show(`<section><div class="label" style="margin-top:0">Not an owner or manager here</div>
      <p><b>${who}</b> isn't on this restaurant's list. Ask the owner to add this email under <b>Owner → Staff</b>.</p>${other}${signupLink}</section>`);
    if (role === "manager" && page === "owner") return show(`<section><div class="label" style="margin-top:0">Managers use the manager page</div>
      <p>You're signed in as a manager (${who}). <a href="${BASE}?r=${RID}#manager">Open the manager page</a>.</p></section>`);
    const st = subState(ACCOUNT);
    if (role !== "company" && !st.live) return show(blockedHtml(st, (ACCOUNT && ACCOUNT.name) || RID) + `<section>${other}</section>`);
    startConfig(); step("restaurant settings");
    await Promise.race([cfgReady, new Promise((r) => setTimeout(r, 5000))]); step("settings loaded");
    G.done = true; go(role === "company" ? "owner" : role);
  }
  const show = (html) => paint(html);
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || G.done) return; const a = b.dataset.act;
    if (a === "admin-out") { try { await signOutUser(); } catch {} G.err = ""; return check(); }
    if (a !== "admin-in" || G.busy) return;
    agree();
    G.busy = true; G.err = ""; check();
    try { recordTerms((await googleSignIn()).user, "owner page sign-in"); } catch (err) { G.err = authMessage(err); }
    G.busy = false; check();
  });
  check().catch((e) => paint(errorBox(e)));
}

// ================= DINER =================
// ---------- diner welcome ----------
// The first time a diner opens a table on this visit: the restaurant's logo as a die-cut sticker over a
// grey, blurred view of the join screen, with a small "Powered by Wasabi" sticker. One tap and it's gone.
// Not shown on the demo stage's diner slots (?as=1), which open many times over.
function welcomeSticker() {
  const logo = BRAND.logo;
  if (!logo) return `<span class="hello-name">${esc(rname())}</span>`;
  return `<img class="hello-logo" ${isFileLogo(logo) ? `src="${esc(logo)}"` : `data-photo="${esc(logo)}"`} alt="${esc(rname())}">`;
}
function welcomeSplash() {
  if (!RID || params.get("as") || !(params.get("t") || params.get("c"))) return;
  const key = `wasabi-hello-${RID}-${params.get("t") || "code"}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch {}
  const el = document.createElement("div");
  el.className = "hello"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", `Welcome to ${rname()}`);
  el.innerHTML = `<button class="hello-go" type="button"><span class="hello-stick" id="hellostick">${welcomeSticker()}</span>
    <span class="hello-tap">Tap to start ordering</span>
    <span class="hello-by"><img class="hello-wasabi" src="img/brand/powered-by-wasabi.png" alt="Spiced by Wasabi"></span></button>`;
  document.body.appendChild(el); document.body.classList.add("hello-on"); hydratePhotos();
  const btn = el.querySelector("button"), still = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const peel = stickerPeel(el.querySelector("#hellostick"), still);
  // The restaurant's look can arrive a moment later: swap the sticker if the logo changed.
  const refresh = () => { const st = document.getElementById("hellostick"); if (st && !st.querySelector(`[src="${BRAND.logo}"],[data-photo="${BRAND.logo}"]`)) { st.innerHTML = welcomeSticker(); hydratePhotos(); peel.reset(); } };
  cfgListeners.add(refresh);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; cfgListeners.delete(refresh); document.removeEventListener("keydown", onKey);
    await peel.off(); el.classList.add("out"); document.body.classList.remove("hello-on");
    setTimeout(() => el.remove(), still ? 0 : 220); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  btn.addEventListener("click", close); document.addEventListener("keydown", onKey);
}
// The sticker peels like a real one. Its top-right corner lifts a little while it waits; a tap peels it
// off along the diagonal, showing the plain back of the sticker as it folds over, then it lifts away.
// How: the fold is a 45° line. The front is clipped to the part still stuck down; a copy styled as the
// sticker's back is clipped to the peeled part and mirrored across the fold line, squashed (FORE) so the
// flap looks lifted towards you rather than lying flat. k is how far the fold has moved in from the corner.
const FORE = 0.55;
function stickerPeel(box, still) {
  let k = 0, front = null, flap = null, idle = 0, W = 0, H = 0, t0 = 0, kmin = 0, kmax = 0;
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
  function build() {
    front = box.firstElementChild; if (!front) return false;
    if (front.tagName === "IMG" && !(front.complete && front.naturalWidth)) { front.addEventListener("load", () => { if (!flap) start(); }, { once: true }); return false; }
    W = front.offsetWidth; H = front.offsetHeight; if (!W || !H) return false;
    flap = front.cloneNode(true); flap.removeAttribute("data-photo"); flap.removeAttribute("id"); flap.setAttribute("aria-hidden", "true"); flap.alt = "";
    if (front.tagName === "IMG") flap.src = front.currentSrc || front.src;
    flap.classList.add("hello-back"); flap.style.width = W + "px"; flap.style.height = H + "px";
    reach();
    box.classList.add("peeling"); box.appendChild(flap); set(k); return true;
  }
  // Where the sticker itself starts and ends along the diagonal: a round or odd-shaped logo has empty
  // corners, and peeling empty space shows nothing. Read from the logo's see-through pixels.
  function reach() {
    kmin = 0; kmax = W + H;
    if (front.tagName !== "IMG") return;
    try {
      const nw = front.naturalWidth, nh = front.naturalHeight, f = Math.min(W / nw, H / nh), dw = nw * f, dh = nh * f, ox = (W - dw) / 2, oy = (H - dh) / 2;
      const cv = document.createElement("canvas"); cv.width = Math.round(W); cv.height = Math.round(H);
      const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(front, ox, oy, dw, dh);
      const px = g.getImageData(0, 0, cv.width, cv.height).data; let lo = Infinity, hi = -Infinity;
      for (let y = 0; y < cv.height; y += 3) for (let x = 0; x < cv.width; x += 3) if (px[(y * cv.width + x) * 4 + 3] > 60) { const v = W - x + y; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo < hi) { kmin = Math.max(0, lo - 8); kmax = hi + 8; }   // 8: the white die-cut edge
    } catch {}
  }
  function set(v) {
    k = v; if (!front || !flap) return;
    const c = k - W, L = 4 * (W + H), gg = 1 + FORE;
    // Still stuck down: everything below-left of the fold line y = x + c. Peeled: above-right of it.
    front.style.clipPath = `polygon(${-L}px ${-L + c}px, ${L}px ${L + c}px, ${-L}px ${L + c}px)`;
    flap.style.clipPath = `polygon(${-L}px ${-L + c}px, ${L}px ${L + c}px, ${L}px ${-L + c}px)`;
    flap.style.transform = `matrix(${1 - gg / 2},${gg / 2},${gg / 2},${1 - gg / 2},${(gg * (W - k)) / 2},${(gg * (k - W)) / 2})`;
  }
  // While waiting: the corner lifts, then breathes a little, inviting a tap.
  function start() {
    if (still || !build()) return;
    const lift = 0.13 * Math.min(W, H); t0 = performance.now() + 450;
    const tick = (now) => { const t = now - t0;
      set(kmin + (t < 0 ? 0 : t < 500 ? lift * ease(t / 500) : lift * (1 + 0.2 * Math.sin((t - 500) / 380))));
      idle = requestAnimationFrame(tick); };
    idle = requestAnimationFrame(tick);
  }
  function reset() { cancelAnimationFrame(idle); flap?.remove(); flap = null; k = 0; box.classList.remove("peeling", "gone"); setTimeout(start, 0); }
  // Peel it right off, then lift it away. Resolves when the sticker has gone.
  function off() {
    cancelAnimationFrame(idle);
    if (still || (!flap && !build())) return Promise.resolve();
    const from = Math.max(k, kmin), to = kmin + 0.5 * (kmax - kmin), start = performance.now(), dur = 380;
    return new Promise((done) => {
      const tick = (now) => { const p = Math.min(1, (now - start) / dur); set(from + (to - from) * ease(p));
        if (p < 1) return requestAnimationFrame(tick);
        box.classList.add("gone"); setTimeout(done, 240); };
      requestAnimationFrame(tick);
    });
  }
  setTimeout(start, 0);
  return { off, reset };
}

function dinerScreen() {
  window.wasabiRefresh = softRefresh;   // pull down: fetch only what changed
  welcomeSplash();
  const S = { n: params.get("t"), sid: null, g: null, lines: [], alerts: [], me: null, cart: [], note: "", cat: 0, tab: "menu", name: params.get("name") || "",
    user: null, profile: null, visits: [], step: "", phone: "", offers: false, busy: false, authErr: "", uid: null, proof: null, switching: false,
    ask: null, pendingName: null, joins: [] };
  // Every diner's phone is signed in, at least quietly (anonymously). Diners who sign in with their
  // phone number or Google get their profile and their visits to this restaurant loaded too.
  onUser(async (u) => {
    if (!u) { if (S.uid) ensureUser().catch(() => {}); return; }   // signed out: back to a quiet sign-in
    const changed = S.uid && S.uid !== u.uid; S.uid = u.uid;
    // A new sign-in means a new identity: carry the table pass over to it before anything else.
    if (changed && S.proof && S.sid) { S.switching = true; try { await writePass(S.sid);
      if (S.proof.via === "code") { S.step = ""; S.authErr = ""; S.busy = false; if (isAccount(u)) recordTerms(u, "ask to join at table"); } if (S.proof.via === "code") askToJoin(S.sid, S.proof.table, (S.me && S.me.name) || S.name); else attach(S.sid); } catch (e) { console.error(e); } S.switching = false; }
    S.user = isAccount(u) ? u : null; S.profile = null; S.visits = [];
    // While the saved profile loads, show a skeleton, not the first-name question (it would flash up and vanish).
    if (S.user) { S.profileLoading = true; try { const p = await getDoc(dinerRef(u.uid)); S.profile = p.exists() ? p.data() : null;
      S.visits = (await myVisits(u.uid)).filter((v) => v.rid === RID); } catch {} S.profileLoading = false; }
    const justSignedIn = S.step === "code" || S.step === "phone" || S.step === "google";
    if (justSignedIn) S.step = S.user && !(S.profile && S.profile.name) ? "name" : "";
    // Signed in just now and already known: join straight away, no extra tap.
    if (justSignedIn && S.user && S.profile && S.profile.name && S.g && S.g.open && !S.me) { try { await joinAs(S.profile.name, S.user); return; } catch {} }
    render();
  });
  // On the demo page several diners share one browser, so each gets its own slot (?as=1, ?as=2).
  const meKey = () => `dees-me-${RID}-${S.n}${params.get("as") ? "-" + params.get("as") : ""}`;
  let subGroup = null, subLines = null, subAlerts = null, subMine = null, subJoins = null, joinsFailed = false;
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
    // A friend's code typed on the front page (?c=1234, no restaurant yet): find the restaurant, then join.
    if (!RID && c) return joinByInvite(c);
    if (!RID) { $("#cart").hidden = true; return paint(`<section><p class="empty">Scan the QR code on your table to see the menu and order.</p>
      <p class="note" style="text-align:center">Run a restaurant? <a href="${BASE}#signup">Register it with ${esc(COMPANY.name)}</a> · <a href="${BASE}#owner">Owner sign-in</a></p></section>`); }
    startConfig();
    step("sign-in"); try { S.uid = (await ensureUser()).uid; } catch (e) { return paint(errorBox(e)); }
    step("menu and settings"); await Promise.race([cfgReady, new Promise((r) => setTimeout(r, 5000))]); step("checking your table");
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
        if (p.exists() && p.data().session === saved.session) { const { t, session, ...proof } = p.data(); S.proof = proof; S.viaKey = proof.via === "key";
          return proof.via === "key" ? attach(saved.session) : askToJoin(saved.session, proof.table, saved.name); }
      }
      return codeEntry(S.n);
    } catch (e) { paint(errorBox(e)); }
  }
  async function joinByInvite(c) {
    $("#cart").hidden = true; paint(`<p class="empty">Finding your friends…</p>`);
    const again = (msg) => paint(`<section><div class="label">Join your friends</div><p class="err">${esc(msg)}</p>
      <form id="invform" class="grid"><input class="field num" id="invin" inputmode="numeric" maxlength="4" placeholder="Their 4-digit code" aria-label="Your friends' 4-digit code" autocomplete="off" value="${esc(c)}">
        <button class="btn primary big">Join their table</button></form>
      <p class="note">The code is on your friend's phone under ☰. Or <button class="linkbtn" data-scan>scan the QR code on the table</button>.</p></section>`);
    if (!/^\d{4}$/.test(String(c).trim())) return again("Codes are 4 digits. Check the number with your friend.");
    try {
      await ensureUser();
      const inv = await getDoc(inviteRef(String(c).trim()));
      const to = inv.exists() ? inv.data() : {};
      // A live demo room's table: open it in the demo.
      if (to.demo) return location.replace(`${BASE}demo/?r=${encodeURIComponent(to.demo)}&c=${encodeURIComponent(String(c).trim())}`);
      if (!to.rid) return again("No open table with that code. Check the number on your friend's phone.");
      location.replace(`${BASE}?r=${encodeURIComponent(to.rid)}&c=${encodeURIComponent(String(c).trim())}`);
    } catch (e) { again("Couldn't check that code. Check your connection and try again."); }
  }
  document.addEventListener("submit", (e) => { if (e.target.id !== "invform") return; e.preventDefault(); const v = ($("#invin").value || "").trim(); joinByInvite(v); });
  // Tables opened before codes were recorded in the shared code book (or reused since) get recorded the
  // first time someone opens them, so friends can type the code on the front page. Best effort.
  let codeChecked = null;
  async function registerCode(g) {
    if (!g || !g.open || !g.code || codeChecked === g.session) return; codeChecked = g.session;
    try { const inv = await getDoc(inviteRef(g.code)); if (!inv.exists() || inv.data().rid !== RID) await setDoc(inviteRef(g.code), { rid: RID }); } catch {}
  }
  function attach(sid) {
    step("loading your table");
    S.sid = sid; S.access = true; S.err = ""; S.gLoaded = false;
    subGroup && subGroup(); subLines && subLines(); subAlerts && subAlerts();
    subJoins && subJoins(); subJoins = null; joinsFailed = false; S.joins = []; S.ask = null;
    subGroup = onSnapshot(groupRef(sid), (snap) => {
      S.g = snap.data() || null; S.gLoaded = true; registerCode(S.g);
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
      askToJoin(session, table);
    } catch (e) { paint(errorBox(e)); }
  }
  // A friend's code doesn't let you in by itself: the table gets "Juma wants to join" and someone there
  // taps Let in. (Anyone could guess a 4-digit code; only the QR on the table proves you're there.)
  async function askToJoin(session, table, name) {
    S.sid = session; S.access = false; S.err = ""; $("#cart").hidden = true; setMenu([]);
    $("#sub").textContent = `Table ${table}`;
    subMine && subMine(); subMine = null;
    let mine = null;
    try { const j = await getDoc(joinRef(S.uid)); mine = j.exists() && j.data().session === session ? j.data() : null; } catch {}
    if (mine && mine.ok) return attach(session);
    S.ask = { session, table: Number(table), name: name || (mine && mine.name) || S.name || (S.profile && S.profile.name) || "", state: mine && !mine.no ? "waiting" : mine && mine.no ? "no" : "form" };
    if (S.ask.state === "waiting") watchAsk();
    else if (name && S.ask.state === "form") return sendAsk();   // signed in mid-meal: ask again under the new sign-in
    renderAsk();
  }
  async function sendAsk() {
    const a = S.ask; if (!a) return;
    try { await setDoc(joinRef(S.uid), { session: a.session, table: a.table, name: a.name, t: Date.now(), ok: false }); a.state = "waiting"; watchAsk(); renderAsk(); }
    catch (err) { if (!denied(err)) return fail(err); S.ask = null; S.err = "This invite has expired. Ask your friend for the new code."; codeEntry(String(a.table)); }
  }
  function watchAsk() {
    subMine && subMine();
    subMine = onSnapshot(joinRef(S.uid), (snap) => {
      const j = snap.data(), a = S.ask; if (!a || !j || j.session !== a.session) return;
      if (j.ok) { subMine && subMine(); subMine = null; S.pendingName = a.name; toast("You're in"); try { navigator.vibrate?.(200); } catch {} attach(a.session); }
      else if (j.no && a.state !== "no") { a.state = "no"; renderAsk(); }
    }, () => {});
  }
  function renderAsk() {
    const a = S.ask; if (!a) return;
    // Signing in from here: the same phone-number and code steps as at the table.
    if (a.state !== "waiting" && (S.step === "phone" || S.step === "code")) return paint(joinScreen({ people: {}, askTable: a.table }, false));
    if (a.state === "waiting") return paint(`<section class="askwait" aria-live="polite"><div class="label">Table ${esc(a.table)}</div>
      <h2 class="jtitle">Asking the table to let you in…</h2>
      <p>Your friends will see <b>${esc(a.name)} wants to join</b> on their phones. This screen moves on as soon as one of them taps <b>Let in</b>.</p>
      <div class="askdots" aria-hidden="true"><i></i><i></i><i></i></div>
      <button class="btn ghost" data-act="askcancel">Cancel</button></section>`);
    paint(`<section><div class="label">Table ${esc(a.table)}</div><h2 class="jtitle">Ask to join</h2>
      ${a.state === "no" ? `<p class="err">The table didn't let you in. Check it's the right code, or ask your friend to let you in when you ask again.</p>`
        : `<p style="margin-top:0">Your friends get a message and let you in with one tap.</p>`}
      <form id="askform" class="grid"><label class="flabel" for="askin">Your first name <span>So your friends know it's you</span></label>
        <input class="field" id="askin" maxlength="16" autocomplete="given-name" placeholder="e.g. Amani" value="${esc(a.name)}">
        <button class="btn primary big">${a.state === "no" ? "Ask again" : "Ask to join"}</button></form>
      ${S.user ? "" : `<div class="orline"><span>or sign in</span></div>
      <div class="grid two"><button class="btn big" data-act="auth-phone">Phone number</button>
        <button class="btn big" data-act="auth-google" ${S.busy ? "disabled" : ""}>Google</button></div>${termsBox("signing in")}
      ${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}`}
      <p class="note">Sitting at the table? Scan its QR code to join straight away.</p></section>`);
  }
  // People at the table see requests from friends using the code, and answer them.
  function watchJoins() {
    if (subJoins || joinsFailed || !S.sid) return;
    let first = true;
    subJoins = onSnapshot(query(rcol("joins"), where("session", "==", S.sid)), (s) => {
      const seen = new Set(S.joins.map((j) => j.id));
      S.joins = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((j) => !j.ok && !j.no);
      if (!first && S.joins.some((j) => !seen.has(j.id))) { try { navigator.vibrate?.([200, 100, 200]); } catch {} }
      first = false; render();
    }, () => { subJoins = null; joinsFailed = true; });
  }
  function codeEntry(n) {
    $("#cart").hidden = true;
    $("#sub").textContent = n ? `Table ${n}` : "Join a table";
    paint(`<section><div class="label">${n ? `Join table ${esc(n)}` : "Join your friends"}</div>
      <p>Scan the QR code on your table, or enter the 4-digit code shown on a friend's phone.</p>
      <form id="codeform" class="grid"><input class="field num" id="codein" inputmode="numeric" maxlength="4" placeholder="4-digit code" aria-label="4-digit table code" autocomplete="off">
      <button class="btn primary big">Join</button></form>${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}</section>`);
  }
  // Shared table with groups already ordering: join friends with their code, or start a new group.
  function chooseGroup(count) {
    S.choosing = true; S.count = count; $("#cart").hidden = true;
    paint(`<section><div class="tablebar"><b>Table ${esc(S.n)}</b><span class="note" style="margin:0">Shared table · ${count} group${count > 1 ? "s" : ""} ordering</span></div>
      <div class="label">Here with friends who already ordered?</div>
      <p style="margin-top:0">Enter the 4-digit code shown on their phone.</p>
      <form id="codeform" class="grid"><input class="field num" id="codein" inputmode="numeric" maxlength="4" placeholder="Their group code" aria-label="Their 4-digit group code" autocomplete="off">
      <button class="btn primary big">Join their group</button></form>${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}
      <div class="label">New here?</div>
      <button class="btn big" data-act="newgroup">Start a new group</button>
      <p class="note">Each group orders and pays separately, so you only see your own bill.</p></section>`);
  }
  // Joining: signed-in diners join in one tap; others choose phone, Google, or just a first name.
  function joinScreen(g, shared) {
    const names = Object.values(g.people || {}).map((p) => esc(p.name)), unit = shared ? "group" : "table";
    const bar = `<div class="tablebar slim"><span>${g.askTable ? `Joining your friends at table ${esc(g.askTable)}` : names.length ? `With <b>${names.join(", ")}</b>` : shared ? "Starting a new group" : "You're the first one here"}</span></div>`;
    const err = S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : "";
    const back = `<button class="btn ghost" data-act="authback">Back</button>`;
    if (S.step === "phone") return `<section>${bar}<div class="label">Your phone number</div>
      <p style="margin-top:0">We'll text you a 6-digit code. No password to remember.</p>
      <form id="phoneform" class="grid"><div class="vrow"><span class="field" style="flex:0 0 auto;width:auto">+255</span>
        <input class="field num" id="phonein" inputmode="tel" autocomplete="tel" placeholder="748 227 000" value="${esc(S.phone)}" aria-label="Mobile number"></div>
        <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Sending…" : "Send code"}</button></form>${err}
      <p class="note">You'll get one SMS with a sign-in code; standard SMS rates may apply. Your number is used to sign you in, and Google (which sends the code) keeps it to prevent abuse.
        This step is protected by reCAPTCHA; Google's <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noopener">Terms</a> apply.</p>${back}</section>`;
    if (S.step === "code") return `<section>${bar}<div class="label">Enter the code</div>
      <p style="margin-top:0">Sent by SMS to <b>${esc(S.phoneFull || "")}</b>.</p>
      <form id="smsform" class="grid"><input class="field num" id="smsin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" aria-label="6-digit code">
        <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Checking…" : "Confirm"}</button></form>${err}
      <div class="row" style="margin-top:12px"><button class="btn ghost" data-act="resend">Send a new code</button>${back}</div></section>`;
    if (S.user && S.profileLoading) return skPage();
    if (S.user && (S.step === "name" || !(S.profile && S.profile.name))) return `<section>${bar}<div class="label">You're signed in. What's your first name?</div>
      <form id="profileform" class="grid"><input class="field" id="profilein" maxlength="16" autocomplete="given-name" placeholder="First name" aria-label="Your first name" value="${esc(S.name || (S.user.displayName || "").split(" ")[0])}">
        ${S.user.phoneNumber ? `<label class="optin"><input type="checkbox" id="offersin"> <span>${esc(offersText(rname()))} <span class="note">Optional. Leave this unticked if you don't want offers.</span></span></label>` : ""}
        <button class="btn primary big">Join ${unit}</button>${termsOk(S.profile) ? "" : termsBox()}</form>${err}
      <div class="orline"><span>or</span></div>
      <button class="btn big" data-act="signout">Join as a guest instead</button>
      <p class="note">Just a first name, no account. This signs your account out on this phone.</p></section>`;
    if (S.user && S.profile && S.profile.name) return `<section>${bar}
      <button class="btn primary big" data-act="joinme" style="margin-top:16px">Join as ${esc(S.profile.name)}</button>${termsOk(S.profile) ? "" : termsBox()}
      <div class="orline"><span>or</span></div>
      <button class="btn big" data-act="signout">Join as a guest instead</button>
      <p class="note">Just a first name, no account. This signs your account out on this phone.</p>${err}</section>`;
    // Most people just type their name, so that comes first; signing in is the optional extra.
    return `<section>${bar}<h2 class="jtitle">Join the ${unit}</h2>
      <form id="joinform" class="grid"><label class="flabel" for="namein">Your first name <span>Just your first name, no account needed</span></label>
        <input class="field" id="namein" maxlength="16" placeholder="e.g. Amani" autocomplete="given-name" value="${esc(S.name)}">
        <button class="btn primary big">Join ${unit}</button></form>
      <div class="orline"><span>or sign in</span></div>
      <div class="grid two"><button class="btn big" data-act="auth-phone">Phone number</button>
        <button class="btn big" data-act="auth-google" ${S.busy ? "disabled" : ""}>Google</button></div>${termsBox("signing in")}${err}
      <p class="note">Signing in is optional: it keeps your receipts and lets you order your usual in one tap. Ordering and splitting the bill work the same either way.</p></section>`;
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
    const first = !Object.keys(S.g.people || {}).length && !S.g.waiter;
    await updateDoc(groupRef(S.sid), patch);
    if (first) ringFor(groupRef(S.sid).path);
    store.set(meKey(), { pid, name, session: S.sid }); S.me = { pid, name, session: S.sid };
    store.set("dees-lasttable", location.href); render();
  }
  function render() {
    if (S.ask && !S.access) return renderAsk();
    if (!S.n || !S.access) return;
    const shared = isShared(S.n), g = S.g;
    if (!S.gLoaded) { $("#cart").hidden = true; return paint(skMenu()); }
    if (!g || !g.open) {
      $("#cart").hidden = true;
      return paint(`<section><p class="empty">${shared ? "Your group's bill has been closed" : "This table has been closed"}. Thanks for visiting!</p>${S.viaKey
        ? `<button class="btn primary big" data-act="newsession">Start a new order at table ${esc(S.n)}</button>`
        : `<p class="note" style="text-align:center">To order again, scan the QR code on your table.</p>`}</section>`);
    }
    // Just let in with a friend's code: join with the name they asked with, no second form.
    if (!S.me && S.pendingName && !S.autoJoin) { const n = S.pendingName; S.pendingName = null; S.autoJoin = true;
      joinAs(n, S.user).catch((err) => { fail(err); }).finally(() => { S.autoJoin = false; render(); }); return paint(skMenu()); }
    if (!S.me) { $("#cart").hidden = true; setMenu([]); return paint(S.autoJoin ? skMenu() : joinScreen(g, shared)); }
    watchJoins();
    const asks = S.joins.map((j) => `<div class="joinask" role="alert"><span><b>${esc(j.name)}</b> wants to join your ${shared ? "group" : "table"}</span>
      <span class="row"><button class="btn small primary" data-letin="${esc(j.id)}">Let in</button><button class="btn small ghost" data-letno="${esc(j.id)}">No</button></span></div>`).join("");
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
       ${cat.items.map((it, ii) => { const gp = !it.img && genericPhoto(it.n), inCart = (l) => S.cart.filter((c) => c.n === it.n && (c.v || "") === (l || "")).length;
         return `<div class="item${it.out ? " out" : ""}${it.img || gp ? " withph" : ""}">
         <div class="itxt"><h3>${esc(it.n)}${it.out ? ` <span class="pill s-served">Sold out</span>` : ""}</h3>${it.d ? `<p class="d">${esc(it.d)}</p>` : ""}${it.m ? `<div class="meta">${esc(it.m)}</div>` : ""}</div>
         ${it.img ? `<div class="ph"><img data-photo="${esc(it.img)}" alt="${esc(it.n)}" loading="lazy"></div>` : gp ? `<div class="ph loaded"><img src="${gp}" alt="${esc(it.n)}" loading="lazy"></div>` : ""}
         ${it.out ? "" : `<div class="vars${it.v.length === 1 ? " one" : ""}">${it.v.map(([l, p], vi) => { const q = inCart(l), key = `${ci}.${ii}.${vi}`;
           // In the basket: the option stays highlighted with a count badge; each tap adds one more.
           return `<button class="var${q ? " on" : ""}" data-add="${key}" aria-label="Add ${esc(it.n)}${l ? " " + esc(l) : ""}, TSh ${fmt(p)}${q ? `, ${q} in basket` : ""}"><span class="vl">${l ? esc(l) : "Add"}</span><span class="num">${fmt(p)}</span>${q ? `<span class="vq num${S.bump === key ? " bump" : ""}" aria-hidden="true">${q}</span>` : ""}</button>`; }).join("")}</div>`}</div>`; }).join("")}</div>`).join("")}`;
    } else if (S.tab === "orders") {
      body = Object.entries(g.people || {}).sort(([a], [b]) => (a === S.me.pid ? -1 : b === S.me.pid ? 1 : 0)).map(([pid, p]) => { const ls = S.lines.filter((l) => l.pid === pid);
        return `<div class="who">${esc(p.name)}${pid === S.me.pid ? " (you)" : ""}</div>` + (ls.length ? ls.map((l) => `<div class="oline"><span class="l">${label(l)}${l.byName ? ` <span class="note">added by ${esc(l.byName)}</span>` : ""}${l.note ? `<span class="nt" style="display:block">${esc(l.note)}</span>` : ""}</span><span class="pill s-${l.s}">${l.s}</span></div>`).join("") : `<p class="note" style="margin:2px 0">Nothing yet</p>`); }).join("");
    } else body = billHtml(g, S.lines, false, S.me.pid) + `<p class="note">Pay your waiter as usual. In-app mobile money comes later.</p>`;
    if (S.tab !== "orders") body += poweredBy();
    // ☰: inviting friends, the account and help. Waiter, Call waiter and Bill please stay on the page.
    setMenu([
      { html: `<b>${esc(S.me.name)}</b> at Table ${esc(S.n)}${shared ? ` · ${esc(gname(g))}` : ""}<br>Friends join with code <b class="code num">${esc(g.code)}</b><div style="margin-top:8px"><button class="btn small primary" data-act="share">Share invite</button></div>` },
      { label: "Change my name", sub: `Your table and waiter see you as ${S.me.name}`, run: () => { S.renaming = true; S.help = false; render(); window.scrollTo(0, 0); const i = $("#renamein"); if (i) { i.focus(); i.select(); } } },
      ...(S.user ? [{ label: "My account", sub: "Your visits and WhatsApp offers", href: BASE + "#account" }] : []),
      { label: "How it works", sub: "Ordering, the bill and your waiter", run: () => { S.help = true; render(); window.scrollTo(0, 0); } },
    ]);
    const help = S.help ? `<div class="helpcard"><div class="trow"><b>How it works</b><button class="btn small ghost" data-act="helpclose">Close</button></div>
      <ol><li>Tap a size or price to add it to your basket, then <b>Place order</b>. It goes straight to the kitchen or bar.</li>
        <li>Everyone at the table orders on their own phone. See it all under <b>Table order</b>.</li>
        <li><b>Call waiter</b> or <b>Bill please</b> alerts your waiter, and you'll see when they're on the way.</li>
        <li><b>Bill</b> shows what each person owes. Pay your waiter as usual.</li>
        <li>Friends can join with the code under ☰ → Share invite. You'll get a message to let them in.</li></ol></div>` : "";
    // Change my name: a small card at the top, like How it works.
    const rename = S.renaming ? `<div class="helpcard"><div class="trow"><b>Change my name</b><button class="btn small ghost" data-act="renameclose">Cancel</button></div>
      <form id="renameform" class="grid" style="margin-top:8px"><label class="flabel" for="renamein">Your first name <span>Your table and waiter see this</span></label>
        <input class="field" id="renamein" maxlength="16" autocomplete="given-name" value="${esc(S.me.name)}">
        <button class="btn primary big">Save name</button></form></div>` : "";
    paintSoft(`<section class="dsec">${rename}${help}
      <div class="tcard">
        <div class="trow"><div class="who2"><span>Waiter</span> <b>${g.waiter ? esc(wname(g.waiter)) : "Being assigned"}</b></div>
          <div class="row">${Object.entries(ALERT).map(([k, l]) => { const a = open.find((x) => x.type === k);
            return `<button class="btn small${a ? "" : " primary"}" data-alert="${k}" ${a ? "disabled" : ""}>${a ? (a.ack ? "On the way" : k === "call" ? "Waiter called" : "Bill requested") : l}</button>`; }).join("")}</div></div>
      </div>
      ${asks}${banners}${welcomeCard()}
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
    // The basket survives a refresh or a trip back to the front page (until it's sent).
    const ck = `wasabi-cart-${RID}-${S.n || params.get("c") || "x"}`;
    if (!S.cartRestored) { S.cartRestored = true; try { const saved = JSON.parse(sessionStorage.getItem(ck) || "[]"); if (!S.cart.length && Array.isArray(saved)) S.cart = saved.filter((x) => x && x.n && !soldOut(x.n)); } catch {} }
    try { S.cart.length ? sessionStorage.setItem(ck, JSON.stringify(S.cart)) : sessionStorage.removeItem(ck); } catch {}
    const c = $("#cart"); if (!S.me || S.tab !== "menu" || !S.cart.length) { c.hidden = true; c.innerHTML = ""; document.body.classList.remove("hascart"); return; }
    const tot = S.cart.reduce((a, l) => a + l.pr, 0), n = S.cart.length; c.hidden = false;
    const a = document.activeElement, focused = a && a.id === "note"; S.notes = S.notes || {};
    // The same item and size twice shows once, with a count and − / +.
    const groups = []; S.cart.forEach((l) => { const k = l.n + "|" + (l.v || ""); const g = groups.find((x) => x.k === k); if (g) g.q++; else groups.push({ k, l, q: 1 }); });
    c.innerHTML = `<div class="in">
      ${S.cartOpen ? `<div class="clist">${groups.map((g) => `<div class="cline"><span class="cn">${label(g.l)}${S.notes[g.k] && S.noteKey !== g.k ? `<span class="nt" style="display:block">${esc(S.notes[g.k])}</span>` : ""}
            <button class="linkbtn cnote" data-cnote="${esc(g.k)}">${S.notes[g.k] ? "Edit note" : "+ Note"}</button></span>
          <span class="qty"><button class="qb" data-dec="${esc(g.k)}" aria-label="One fewer ${esc(g.l.n)}">−</button><b class="num">${g.q}</b><button class="qb" data-inc="${esc(g.k)}" aria-label="One more ${esc(g.l.n)}">+</button></span>
          <span class="num cp">${fmt(g.l.pr * g.q)}</span></div>
          ${S.noteKey === g.k ? `<input id="note" class="cnotein" maxlength="200" aria-label="Note for ${esc(g.l.n)}" placeholder="Note for this item (e.g. no ice, well done)" value="${esc(S.notes[g.k] || "")}">` : ""}`).join("")}</div>` : ""}
      <div class="cbar"><button class="cview" data-act="cart" aria-expanded="${!!S.cartOpen}"><b class="num">${n}</b> item${n > 1 ? "s" : ""}<span>${S.cartOpen ? "Hide" : "View"}</span></button>
        <button class="cartbtn" data-act="place" ${S.placing ? "disabled" : ""}><span>${S.placing ? "Sending…" : "Place order"}</span><span class="num">TSh ${fmt(tot)}</span></button></div></div>`;
    document.body.classList.toggle("hascart", true);
    if (focused && $("#note")) $("#note").focus();
  }

  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "askform") { const a = S.ask; if (!a) return; const name = $("#askin").value.trim(); if (!name) return toast("Enter your first name");
      a.name = name; S.name = name; return sendAsk(); }
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
      S.phone = $("#phonein").value;
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
    // Change my name at the table: only this diner's own entry in the group changes (the database
    // rules allow nothing else). Orders already placed show the new name on staff screens too.
    if (e.target.id === "renameform") {
      const name = $("#renamein").value.trim().slice(0, 16), me = S.me, p = S.g && S.g.people && me && S.g.people[me.pid];
      if (!name || !p) return;
      if (name === me.name) { S.renaming = false; return render(); }
      try { await updateDoc(groupRef(S.sid), { [`people.${me.pid}`]: { ...p, name } });
        S.me = { ...me, name }; store.set(meKey(), S.me); S.renaming = false; toast(`Your table now sees you as ${name}`); render(); }
      catch (err) { fail(err); }
      return;
    }
    if (e.target.id === "profileform") {
      const name = $("#profilein").value.trim(); if (!name || !S.user) return;
      agree();
      const on = !!($("#offersin") && $("#offersin").checked);
      const prof = { name, phone: S.user.phoneNumber || null, email: S.user.email || null, offers: on ? { [RID]: true } : {}, offerNames: on ? { [RID]: rname() } : {}, created: Date.now() };
      try { const b = writeBatch(db); b.set(dinerRef(S.user.uid), prof); if (on) logConsent(b, S.user, RID, rname(), true, "sign-up at table");
        if (termsOk(S.profile)) prof.terms = S.profile.terms; else prof.terms = logTerms(b, S.user, prof, "sign-up at table");
        await b.commit(); S.profile = prof; S.step = ""; await joinAs(name, S.user); } catch (err) { fail(err); }
    }
  });
  document.addEventListener("input", (e) => { if (e.target.id === "note" && S.noteKey) { S.notes = S.notes || {}; S.notes[S.noteKey] = e.target.value; } if (e.target.id === "namein") S.name = e.target.value; });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.tab) { S.tab = d.tab; render(); window.scrollTo(0, 0); }
    else if (d.letin || d.letno) { const id = d.letin || d.letno, who = (S.joins.find((j) => j.id === id) || {}).name || "They";
      try { await updateDoc(joinRef(id), d.letin ? { ok: true, by: S.uid, at: Date.now() } : { no: true, by: S.uid, at: Date.now() }); toast(d.letin ? `${who} can join now` : "Not let in"); }
      catch (err) { fail(err); } }
    else if (d.act === "askcancel") { const a = S.ask; S.ask = null; subMine && subMine(); subMine = null; deleteDoc(joinRef(S.uid)).catch(() => {}); S.err = ""; codeEntry(a ? String(a.table) : S.n); }
    else if (d.cat) { S.cat = +d.cat; markCat(); jumpTo(S.cat); }
    else if (d.add) { const [c, i, v] = d.add.split(".").map(Number), it = MENU[c]?.items[i]; if (!it || it.out || !it.v[v]) return render(); const [l, p] = it.v[v];
      S.cart.push({ n: it.n, v: l, pr: p, st: MENU[c].st }); toast(`Added ${it.n}${l ? " · " + l : ""}`); S.bump = d.add; render(); S.bump = null; }
    else if (d.rm) { S.cart.splice(+d.rm, 1); render(); }
    else if (d.inc) { const x = S.cart.find((l) => l.n + "|" + (l.v || "") === d.inc); if (x) S.cart.push({ ...x }); render(); }
    else if (d.cnote) { S.noteKey = S.noteKey === d.cnote ? null : d.cnote; render(); const i = $("#note"); if (i) i.focus(); }
    else if (d.dec) { const i = S.cart.map((l) => l.n + "|" + (l.v || "")).lastIndexOf(d.dec); if (i >= 0) S.cart.splice(i, 1); if (!S.cart.length) S.cartOpen = false; render(); }
    else if (d.act === "cart") { S.cartOpen = !S.cartOpen; renderCart(); }
    else if (d.split) setSplit(S.sid, d.split);
    else if (d.alert) {
      try { const ar = await addDoc(rcol("alerts"), { table: Number(S.n), session: S.sid, type: d.alert, pid: S.me.pid, pname: S.me.name, t: Date.now(), ack: null, ackBy: null, done: false }); ringFor(ar.path);
        toast(S.g.waiter ? `${wname(S.g.waiter)} has been notified` : "All waiters notified"); } catch (err) { fail(err); }
    }
    else if (d.act === "place" && S.cart.length && !S.placing) {
      S.placing = true; renderCart();
      const batch = writeBatch(db), bid = uid("b"), now = Date.now();
      S.cart.forEach((l) => batch.set(doc(rcol("lines")), { table: Number(S.n), session: S.sid, batch: bid, pid: S.me.pid, pname: S.me.name,
        n: l.n, v: l.v, pr: l.pr, st: l.st, s: "new", t: now, note: ((S.notes || {})[l.n + "|" + (l.v || "")] || S.note || "").trim().slice(0, 200) || null }));
      try { await batch.commit(); const sts = [...new Set(S.cart.map((l) => STATIONS[l.st]))]; S.cart = []; S.note = ""; S.notes = {}; S.noteKey = null; S.cartOpen = false; toast("Sent to " + sts.join(" and ")); }
      catch (err) { fail(err); }
      S.placing = false; render();
    }
    else if (d.act === "helpclose") { S.help = false; render(); }
    else if (d.act === "renameclose") { S.renaming = false; render(); }
    else if (d.act === "share") {
      const link = `${BASE}?r=${RID}&c=${S.g.code}`, what = isShared(S.n) ? "group" : "table";
      const txt = `Join our ${what} at ${rname()}: ${link} (code ${S.g.code}, works until the ${what} closes)`;
      try { if (navigator.share) { await navigator.share({ text: txt }); return; } } catch { return; }
      try { await navigator.clipboard.writeText(txt); toast("Invite copied. Paste it in WhatsApp."); } catch { toast(`Code: ${S.g.code}`); }
    }
    else if (d.act === "auth-phone") { agree(); S.step = "phone"; S.authErr = ""; render(); }
    else if (d.act === "authback") { S.step = ""; S.authErr = ""; render(); }
    else if (d.act === "resend") { S.step = "phone"; S.authErr = ""; render(); }
    else if (d.act === "auth-google" && !S.busy) { agree();
      S.busy = true; S.step = "google"; S.authErr = ""; render();
      try { await googleSignIn(); } catch (err) { S.authErr = authMessage(err); S.step = ""; }
      S.busy = false; render();
    }
    else if (d.act === "joinme" && S.profile) {
      agree();
      try { if (!termsOk(S.profile)) { const bt = writeBatch(db), t = logTerms(bt, S.user, S.profile, "join at table"); await bt.commit(); S.profile = { ...S.profile, terms: t }; }
        await joinAs(S.profile.name, S.user); } catch (err) { fail(err); } }
    else if (d.act === "signout") { try { await signOutUser(); } catch {} S.step = ""; S.user = null; S.profile = null; S.name = ""; render(); }
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
  window.wasabiRefresh = softRefresh;   // pull down: fetch only what changed
  $("#wrap").classList.add("wide"); $("#sub").textContent = STATIONS[st] + " screen"; document.title = STATIONS[st] + " · " + rname();
  const S = { lines: [], groups: {}, all: [] }; const notify = watcher();
  onSnapshot(query(rcol("lines"), where("s", "in", ["new", "preparing", "ready"])), (s) => {
    S.loaded = true; S.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => l.st === st);
    notify(S.lines.filter((l) => l.s === "new").map((l) => l.batch)); render();
  }, (e) => paint(errorBox(e)));
  onSnapshot(query(rcol("groups"), where("open", "==", true)), (s) => { S.all = s.docs.map((d) => d.data()); S.groups = {}; S.all.forEach((g) => (S.groups[g.session] = g)); render(); });
  function render() {
    const batches = [...new Set(S.lines.sort((a, b) => a.t - b.t).map((l) => l.batch))];
    const tix = batches.map((b) => {
      const bl = S.lines.filter((l) => l.batch === b), s = bl.some((l) => l.s === "new") ? "new" : bl.some((l) => l.s === "preparing") ? "preparing" : "ready";
      const g = S.groups[bl[0].session], w = g && g.waiter, tab = g && g.tab, via = bl.find((l) => l.byName);
      // One note for the whole order (older orders) shows once; otherwise each item shows its own.
      const notes = [...new Set(bl.map((l) => l.note || ""))], oneNote = notes.length === 1 && notes[0] ? notes[0] : "";
      // How long this order has waited, large enough to read across the kitchen; amber, then red when late.
      const mins = Math.max(0, Math.floor((Date.now() - bl[0].t) / 60000)), lim = st === "bar" ? [5, 10] : [15, 25];
      const late = s === "ready" ? "" : mins >= lim[1] ? " late" : mins >= lim[0] ? " warn" : "";
      return `<article class="ticket ${s}"><header><b>${esc(g ? where_(g, S.all) : `Table ${bl[0].table}`)}</b><span class="age num${late}" title="Waiting ${mins} min">${mins}<small> min</small></span></header>
        <div class="note" style="margin:2px 0 0">${esc(nowName(g, bl[0].pid, bl[0].pname))}${tab ? " · bar tab" : ` · waiter ${w ? esc(wname(w)) : "not assigned yet"}`}${via ? ` · taken by ${esc(via.byName)}` : ""}</div>
        <ul class="slines">${bl.map((l) => `<li class="sline${l.s === "ready" ? " done" : ""}"><span><span class="q">1×</span>${label(l)}${!oneNote && l.note ? `<span class="nt" style="display:block">${esc(l.note)}</span>` : ""}</span>${l.s === "ready"
          ? `<span class="pill s-ready">Ready</span>` : `<button class="btn" data-ready="${l.id}" aria-label="${esc(l.n)} ready">${tab ? "Done" : "Ready"}</button>`}</li>`).join("")}</ul>${oneNote ? `<div class="nt">${esc(oneNote)}</div>` : ""}
        <div class="acts"><span class="pill s-${s}">${s === "ready" ? "Waiting for waiter" : s}</span>${s === "new" ? `<button class="btn primary" data-adv="${b}" data-to="preparing">Start</button>` : ""}
          ${bl.filter((l) => l.s !== "ready").length > 1 ? `<button class="btn primary" data-adv="${b}" data-to="ready">All ready</button>` : ""}</div></article>`;
    });
    setMenu([{ html: `<b>${esc(STATIONS[st])} screen</b><br>${esc(rname())}. Orders for the ${esc(STATIONS[st].toLowerCase())} appear here.` },
      ...(audio ? [{ label: "Test sound", sub: "Alerts are on", keep: true, run: beep }] : [])]);
    paint(soundBar() + tabsHtml() + (!S.loaded ? skTickets(4) : tix.length ? `<section class="grid">${tix.join("")}</section>` : `<p class="empty">No open orders for the ${STATIONS[st]}.</p>`));
  }
  // ----- bar counter: named tabs for walk-up customers (bar screen only) -----
  const T = { open: false, naming: false, bill: null, confirm: null, lines: [] };
  if (st === "bar") onSnapshot(query(rcol("lines"), where("table", "==", 0)), (s) => { T.lines = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, () => {});
  const tabs = () => S.all.filter((g) => g.tab && g.open).sort((a, b) => a.opened - b.opened);
  function tabsHtml() {
    if (st !== "bar") return "";
    const list = tabs(), lines = (g) => T.lines.filter((l) => l.session === g.session);
    return `<section class="ticket" style="margin-bottom:14px"><div class="trow"><b>Bar tabs${list.length ? ` (${list.length})` : ""}</b>
        <div class="row"><button class="btn primary" data-tab="new">+ New tab</button>${list.length ? `<button class="btn" data-tab="toggle">${T.open ? "Hide tabs" : "Show tabs"}</button>` : ""}</div></div>
      ${T.naming ? `<form id="tabform" class="vrow" style="margin-top:10px"><input class="field" id="tabname" maxlength="20" placeholder="Customer's first name" aria-label="Customer's first name" autocomplete="off"><button class="btn primary">Start tab</button></form>` : ""}
      ${T.open ? list.map((g) => { const ls = lines(g), tot = tableTotal(ls);
        return `<div class="tabrow"><div class="trow"><span><b>${esc(g.tab)}</b> <span class="note">${ls.length} item${ls.length === 1 ? "" : "s"} · TSh ${fmt(tot)} · opened ${ago(g.opened)}</span></span>
          <div class="row"><button class="btn primary small" data-tabadd="${g.session}">Add round</button><button class="btn small" data-tabbill="${g.session}">${T.bill === g.session ? "Hide bill" : "Bill"}</button>
            ${T.confirm === g.session ? `<button class="btn danger small" data-tabclose="${g.session}">Tap again to close</button>` : `<button class="btn ghost small" data-tabconfirm="${g.session}">Close tab</button>`}</div></div>
          ${T.bill === g.session ? billHtml(g, ls, true) : ""}</div>`; }).join("") : ""}</section>`;
  }
  async function closeTab(sid) {
    const g = S.all.find((x) => x.session === sid); if (!g) return;
    const ls = T.lines.filter((l) => l.session === sid), b = writeBatch(db), now = Date.now();
    ls.filter((l) => l.s !== "served").forEach((l) => b.update(rdoc("lines", l.id), { s: "served", closedUnserved: true }));
    b.set(rdoc("sessions", sid), { table: 0, session: sid, opened: g.opened, accepted: null, closed: now, waiter: null, guests: Object.keys(g.people || {}).length, total: tableTotal(ls), paid: Object.keys(g.paid || {}).length });
    b.update(groupRef(sid), { open: false, closed: now });
    await b.commit();
  }
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "tabform") return; e.preventDefault();
    const n = ($("#tabname").value || "").trim().slice(0, 20); if (!n) return toast("Enter the customer's first name");
    T.naming = false; T.open = true; render();
    const pid = `tab-${Date.now().toString(36)}`, grp = { ...newGroup(0, null), session: `bar-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, tab: n, label: n,
      people: { [pid]: { name: n, t: Date.now(), guest: true, by: "counter" } } };
    orderTaker({ create: { group: grp }, by: "counter", byName: "Bar", title: `New tab · ${n}` });
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || st !== "bar") return; const d = b.dataset;
    try {
      if (d.tab === "new") { T.naming = !T.naming; render(); const i = $("#tabname"); if (i) i.focus(); }
      else if (d.tab === "toggle") { T.open = !T.open; render(); }
      else if (d.tabadd) { const g = S.all.find((x) => x.session === d.tabadd); if (g) orderTaker({ g, by: "counter", byName: "Bar", title: `Add to ${g.tab}'s tab` }); }
      else if (d.tabbill) { T.bill = T.bill === d.tabbill ? null : d.tabbill; render(); }
      else if (d.tabconfirm) { T.confirm = d.tabconfirm; render(); setTimeout(() => { if (T.confirm === d.tabconfirm) { T.confirm = null; render(); } }, 4000); }
      else if (d.tabclose) { const g = S.all.find((x) => x.session === d.tabclose); await closeTab(d.tabclose); T.confirm = null; if (T.bill === d.tabclose) T.bill = null; toast(`${g ? g.tab + "'s" : "The"} tab is closed`); render(); }
      else if (d.split && d.g && S.all.some((x) => x.session === d.g && x.tab)) await setSplit(d.g, d.split);
      else if (d.paid && d.g) { const g = S.all.find((x) => x.session === d.g); if (g && g.tab) await togglePaid(d.g, d.paid, !!((g.paid || {})[d.paid])); }
    } catch (err) { fail(err); }
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.act === "sound") { await enableSound(); render(); }
    if (d.act === "testsound") beep();
    if (d.adv) { b.disabled = true; const batch = writeBatch(db);
      const now = Date.now();
      const moving = S.lines.filter((l) => l.batch === d.adv && (d.to === "preparing" ? l.s === "new" : l.s !== "ready"));
      const isTab = (l) => !!(S.groups[l.session] && S.groups[l.session].tab);
      moving.forEach((l) =>
        batch.update(rdoc("lines", l.id), d.to === "preparing" ? { s: "preparing", tPrep: now }
          : isTab(l) ? { s: "served", tReady: now, tServed: now, tPrep: l.tPrep || now } : { s: "ready", tReady: now, tPrep: l.tPrep || now }));
      try { await batch.commit(); if (d.to !== "preparing" && moving.length && !isTab(moving[0])) ringFor(rdoc("lines", moving[0].id).path, moving.length); } catch (err) { fail(err); b.disabled = false; } }
    // One dish ready on its own: the waiter is alerted for just that dish.
    if (d.ready) { const l = S.lines.find((x) => x.id === d.ready); if (!l) return; b.disabled = true; const now = Date.now(), tab = S.groups[l.session] && S.groups[l.session].tab;
      try { await updateDoc(rdoc("lines", l.id), tab ? { s: "served", tReady: now, tServed: now, tPrep: l.tPrep || now } : { s: "ready", tReady: now, tPrep: l.tPrep || now });
        if (!tab) ringFor(rdoc("lines", l.id).path); } catch (err) { fail(err); b.disabled = false; } }
  });
  setInterval(render, 30000);
  cfgListeners.add(render);
}

// ================= STAFF ORDER TAKER =================
// Waiters (and owners or managers working as a waiter) order for their tables; the bar counter runs named
// tabs. One full-screen sheet: who it's for (someone at the table, or a phoneless guest), the menu with
// search, a basket with a note per item, then Send. The database checks every price, as for diners.
//   g:      the group (table or tab) to order for, or null when `create` opens a new one on Send
//   create: { group, extra(batch, code) } for a table or tab that doesn't exist yet
//   by / byName: who is ordering (waiter id or "counter", and the name shown to diners and the kitchen)
function orderTaker({ g, create, by, byName, title, onSent }) {
  const base = g || create.group;
  const T = { who: null, guests: [], cart: [], q: "", cat: 0, noteFor: null, sending: false, nameFor: null, renamed: {} };
  // Guests without a phone (just added, or added earlier by staff) can be renamed here at any time.
  const people = () => [...Object.entries(base.people || {}).map(([pid, p]) => ({ pid, name: T.renamed[pid] || p.name, guest: !!p.guest })), ...T.guests.map((p) => ({ ...p, guest: true }))];
  const nameOf = (pid) => (people().find((p) => p.pid === pid) || {}).name || "Guest";
  const addGuest = (name) => { const pid = `guest-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    T.guests.push({ pid, name: name || `Guest ${people().length + 1}`, fresh: true }); T.who = pid; T.nameFor = name ? null : pid; };
  if (people().length === 1) T.who = people()[0].pid;
  else if (!people().length) addGuest(base.tab || "");
  if (base.tab) T.nameFor = null;
  const el = document.createElement("div"); el.className = "otk"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", title);
  document.body.appendChild(el); document.body.classList.add("otk-open");
  const close = () => { el.remove(); document.body.classList.remove("otk-open"); };
  const out = (it) => it.out || STOCK_OUT.has(it.n);
  // The same item, size, person and note twice shows once, with a count.
  const keyOf = (l) => [l.pid, l.n, l.v, l.note || ""].join("|");
  const groups = () => { const gs = []; T.cart.forEach((l) => { const k = keyOf(l), x = gs.find((y) => y.k === k); if (x) x.q++; else gs.push({ k, l, q: 1 }); }); return gs; };
  // Who it's for, as chips. The picked guest without a phone grows a pen; the pen turns that chip into
  // a name box right where it is, with a tick to finish.
  function chipHtml(p) {
    const on = T.who === p.pid, editable = p.guest && !base.tab;
    if (T.nameFor === p.pid) { const v = p.name.startsWith("Guest ") && !T.renamed[p.pid] ? "" : p.name;
      return `<span class="chip otk-chip editing" aria-pressed="true"><input id="otname" class="otk-chipin" maxlength="20" style="width:${Math.max(6, (v || p.name).length + 1)}ch" placeholder="${esc(p.name)}" value="${esc(v)}" aria-label="Guest's name" autocomplete="off" enterkeyhint="done"><button type="button" class="otk-pen" data-ot="namedone" aria-label="Save name"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button></span>`; }
    if (on && editable) return `<span class="chip otk-chip" aria-pressed="true"><button type="button" class="otk-chipn" data-otwho="${esc(p.pid)}">${esc(p.name)}</button><button type="button" class="otk-pen" data-ot="rename" aria-label="Change ${esc(p.name)}'s name"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></span>`;
    return `<button class="chip" aria-pressed="${on}" data-otwho="${esc(p.pid)}">${esc(p.name)}</button>`;
  }
  function render() {
    const q = T.q.trim().toLowerCase(), tot = T.cart.reduce((a, l) => a + l.pr, 0);
    const secs = MENU.map((c, ci) => ({ c, ci, items: c.items.map((it, ii) => ({ it, ii })).filter(({ it }) => !q || it.n.toLowerCase().includes(q) || (it.d || "").toLowerCase().includes(q)) }))
      .filter((x) => x.items.length && (q || x.ci === T.cat));
    const who = people(), focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    el.innerHTML = `<div class="otk-in">
      <div class="otk-head"><b>${esc(title)}</b><button class="btn ghost" data-ot="close" aria-label="Close without sending">Close</button></div>
      <div class="label" style="margin-top:6px">For</div>
      <div class="row otk-who">${who.map(chipHtml).join("")}
        ${base.tab ? "" : `<button class="chip" data-ot="guest">+ Guest without phone</button>`}</div>
      <input class="field otk-search" id="otq" type="search" placeholder="Search the menu" value="${esc(T.q)}" aria-label="Search the menu" autocomplete="off">
      ${q ? "" : `<div class="row otk-cats">${MENU.map((c, i) => `<button class="chip" aria-pressed="${i === T.cat}" data-otcat="${i}">${esc(c.c)}</button>`).join("")}</div>`}
      <div class="otk-list">${secs.map(({ c, ci, items }) => `${q ? `<div class="label">${esc(c.c)}</div>` : ""}${items.map(({ it, ii }) => `<div class="otk-item${out(it) ? " out" : ""}">
          <div class="otk-n"><b>${esc(it.n)}</b>${out(it) ? ` <span class="pill s-served">Sold out</span>` : ""}</div>
          ${out(it) ? "" : `<div class="row">${it.v.map(([l, p], vi) => { const n = T.cart.filter((x) => x.n === it.n && x.v === (l || "") && x.pid === T.who).length;
            return `<button class="var${n ? " on" : ""}" data-otadd="${ci}.${ii}.${vi}"><span class="vl">${l ? esc(l) : "Add"}</span><span class="num">${fmt(p)}</span>${n ? `<span class="vq num">${n}</span>` : ""}</button>`; }).join("")}</div>`}</div>`).join("")}`).join("") || `<p class="note">Nothing on the menu matches "${esc(T.q)}".</p>`}</div>
      <div class="otk-cart">${T.cart.length ? `<div class="otk-lines">${groups().map((gr, i) => `<div class="otk-line"><div><b>${gr.q > 1 ? `${gr.q}× ` : ""}${label(gr.l)}</b> <span class="note">for ${esc(nameOf(gr.l.pid))}</span>
            ${T.noteFor === gr.k ? `<div class="vrow" style="margin-top:4px"><input class="field" id="otnote" maxlength="200" placeholder="e.g. no ice, well done" value="${esc(gr.l.note || "")}" aria-label="Note for ${esc(gr.l.n)}"><button class="btn" data-ot="notedone">OK</button></div>`
              : gr.l.note ? `<div class="nt">${esc(gr.l.note)}</div>` : ""}</div>
          <div class="row" style="flex-wrap:nowrap"><button class="btn ghost small" data-otnote="${i}">${gr.l.note ? "Edit note" : "Note"}</button>
            <span class="qty"><button class="qb" data-otdec="${i}" aria-label="One fewer ${esc(gr.l.n)}">−</button><button class="qb" data-otinc="${i}" aria-label="One more ${esc(gr.l.n)}">+</button></span></div></div>`).join("")}</div>` : ""}
        <button class="btn primary big" data-ot="send" ${!T.cart.length || T.sending ? "disabled" : ""}>${T.sending ? "Sending…" : T.cart.length ? `Send ${T.cart.length} item${T.cart.length > 1 ? "s" : ""} · TSh ${fmt(tot)}` : "Pick items to send"}</button></div></div>`;
    if (focused) { const f = document.getElementById(focused); if (f) { f.focus(); if (f.setSelectionRange && f.value) f.setSelectionRange(f.value.length, f.value.length); } }
  }
  async function send() {
    if (!T.cart.length || T.sending) return;
    if (T.nameFor) nameDone();
    if (T.cart.some((l) => out(MENU.flatMap((c) => c.items).find((it) => it.n === l.n) || {}))) { toast("Something in the basket just sold out. Remove it first."); return render(); }
    T.sending = true; render();
    const write = async (code) => {
      const b = writeBatch(db), now = Date.now(), bid = uid("b"), sid = base.session;
      const fresh = T.guests.filter((p) => T.cart.some((l) => l.pid === p.pid));
      const newPeople = Object.fromEntries(fresh.map((p) => [p.pid, { name: p.name.slice(0, 20), t: now, guest: true, by }]));
      if (create) { const grp = { ...create.group, people: { ...(create.group.people || {}), ...newPeople }, opened: now };
        if (code) grp.code = code; b.set(groupRef(sid), grp); if (create.extra) create.extra(b, code); }
      else if (fresh.length) b.update(groupRef(sid), Object.fromEntries(Object.entries(newPeople).map(([k, v]) => [`people.${k}`, v])));
      T.cart.forEach((l) => b.set(doc(rcol("lines")), { table: base.table, session: sid, batch: bid, pid: l.pid, pname: nameOf(l.pid).slice(0, 20),
        n: l.n, v: l.v, pr: l.pr, st: l.st, s: "new", t: now, note: (l.note || "").trim().slice(0, 200) || null, by, byName: String(byName || "Staff").slice(0, 30) }));
      await b.commit();
    };
    try {
      if (create && create.needsCode) await withFreshCode(write); else await write(null);
      const sts = [...new Set(T.cart.map((l) => STATIONS[l.st]))];
      toast(`Sent to ${sts.join(" and ")}`); close(); onSent && onSent(base.session);
    } catch (err) { T.sending = false; render(); fail(err); }
  }
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    // Tapping anywhere else while naming a guest keeps the name and carries on.
    if (T.nameFor && !b.closest(".editing")) { nameDone(); if (!d.otwho && !d.ot) render(); }
    if (d.ot === "close") { if (T.cart.length && !b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again: discard basket"; return; } return close(); }
    if (d.ot === "guest") { addGuest(""); render(); const i = el.querySelector("#otname"); if (i) i.focus(); return; }
    if (d.ot === "namedone") { if (T.nameFor) nameDone(); return render(); }
    if (d.ot === "rename") { T.nameFor = T.who; render(); const i = el.querySelector("#otname"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } return; }
    if (d.otwho) { T.who = d.otwho; return render(); }
    if (d.otcat) { T.cat = +d.otcat; el.querySelector(".otk-list") && el.scrollTo({ top: 0 }); return render(); }
    if (d.otadd) { if (!T.who) { toast("First pick who it's for"); return; }
      const [ci, ii, vi] = d.otadd.split(".").map(Number), it = MENU[ci] && MENU[ci].items[ii]; if (!it || out(it) || !it.v[vi]) return render();
      const [l, p] = it.v[vi]; T.cart.push({ pid: T.who, n: it.n, v: l || "", pr: p, st: MENU[ci].st, note: "" }); return render(); }
    if (d.otdec) { const gr = groups()[+d.otdec]; if (gr) { const i = T.cart.map(keyOf).lastIndexOf(gr.k); if (i >= 0) T.cart.splice(i, 1); } T.noteFor = null; return render(); }
    if (d.otinc) { const gr = groups()[+d.otinc]; if (gr) T.cart.push({ ...gr.l }); return render(); }
    if (d.otnote) { const gr = groups()[+d.otnote]; T.noteFor = gr && T.noteFor !== gr.k ? gr.k : null; render(); const i = el.querySelector("#otnote"); if (i) i.focus(); return; }
    if (d.ot === "notedone") { T.noteFor = null; return render(); }
    if (d.ot === "send") send();
  });
  el.addEventListener("input", (e) => {
    if (e.target.id === "otq") { T.q = e.target.value; render(); }
    // The note goes on every item in that row; the row is found again by its new key while typing.
    if (e.target.id === "otnote" && T.noteFor != null) { const k = T.noteFor; let nk = k; T.cart.forEach((l) => { if (keyOf(l) === k) { l.note = e.target.value; nk = keyOf(l); } }); T.noteFor = nk; }
    if (e.target.id === "otname" && T.nameFor) { const p = T.guests.find((x) => x.pid === T.nameFor), v = e.target.value.trim();
      if (p) p.name = v || `Guest ${people().findIndex((x) => x.pid === p.pid) + 1}`; else T.renamed[T.nameFor] = v || (base.people[T.nameFor] || {}).name;
      e.target.style.width = `${Math.max(6, (e.target.value || e.target.placeholder).length + 1)}ch`; }
  });
  // A guest who is already at the table keeps the new name straight away, even if nothing is sent.
  function nameDone() {
    const pid = T.nameFor; T.nameFor = null; if (!pid || !g || !(g.people || {})[pid]) return;
    const n = String(T.renamed[pid] || "").trim().slice(0, 20); if (!n || n === g.people[pid].name) return;
    updateDoc(groupRef(base.session), { [`people.${pid}.name`]: n }).then(() => { g.people[pid].name = n; toast(`Name changed to ${n}`); }, fail);
  }
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.target.id === "otnote" || e.target.id === "otname")) { e.preventDefault(); T.noteFor = null; if (e.target.id === "otname") nameDone(); render(); }
    if (e.key === "Escape") close(); });
  render();
  const i = el.querySelector("#otname") || el.querySelector("#otq"); if (i && !matchMedia("(pointer:coarse)").matches) i.focus();
  return { close };
}

// Closing a table (or bar tab): unfinished items and calls are closed, the visit is filed for the
// dashboard and for diners signed in with an account, and the friends' code stops working.
async function closeSession(g) {
  const sid = g.session;
  const [ls, as] = await Promise.all([getDocs(query(rcol("lines"), where("session", "==", sid))), getDocs(query(rcol("alerts"), where("session", "==", sid)))]);
  const allLines = ls.docs.map((x) => x.data()), batch = writeBatch(db), now = Date.now();
  // Items never marked served are closed without a serve time, so they don't skew the averages.
  ls.docs.forEach((x) => { if (x.data().s !== "served") batch.update(x.ref, { s: "served", closedUnserved: true }); });
  as.docs.forEach((x) => { if (!x.data().done) batch.update(x.ref, { done: true, doneAt: now }); });
  batch.set(rdoc("sessions", sid), { table: g.table, session: sid, opened: g.opened, accepted: g.accepted || null, closed: now,
    waiter: g.waiter || null, guests: Object.keys(g.people || {}).length, total: tableTotal(allLines), paid: Object.keys(g.paid || {}).length });
  batch.update(groupRef(sid), { open: false, closed: now });
  if (g.code) batch.delete(codeRef(g.code));   // the invite code stops working
  // Signed-in diners get this visit saved to their account: what they had and their share.
  const owed = shares(g, allLines);
  Object.entries(g.people || {}).forEach(([pid, p]) => {
    if (!p.uid || p.acct === false) return; const sh = owed.find((x) => x.pid === pid);
    batch.set(doc(db, "visits", `${p.uid}_${sid}_${pid}`), { uid: p.uid, rid: RID, rname: rname(), table: g.table, session: sid, date: now,
      items: allLines.filter((l) => l.pid === pid).map((l) => ({ n: l.n, v: l.v || "", pr: l.pr })), share: sh ? sh.amt : 0, groupTotal: tableTotal(allLines) });
  });
  await batch.commit();
}

// ================= WAITER =================
// Waiters use their own phones. A phone is set up once with the staff code; each shift starts with the
// waiter's name and PIN and ends with End shift (or after 16 hours). The database only accepts table,
// alert and serving actions from the waiter on shift. Owners and managers can work as any waiter.
const SHIFT_MS = 16 * 3600e3;
function waiterScreen(boss) {
  window.wasabiRefresh = softRefresh;   // pull down: fetch only what changed
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Waiter"; document.title = "Waiter · " + rname();
  const S = { me: boss ? store.get("dees-waiter-" + RID) : null, since: null, picking: null, pinErr: "", busy: false, endArmed: false,
    groups: [], lines: [], alerts: [], open: null, confirm: null, pin: "", shake: false };
  const myRef = () => rdoc("staff", auth.currentUser.uid);
  // Ringing with the screen off (push.js): offered once a shift starts, on the waiter's own phone.
  const pushRef = () => rdoc("push", auth.currentUser.uid);
  const pushUrl = () => `${location.origin}${location.pathname}?r=${encodeURIComponent(RID)}#waiter`;
  let ring = pushState(), ringBusy = false;
  const keepRing = () => { if (S.me && !boss && ring === "on") refreshPush(fbApp, pushRef(), pushUrl()); };
  // Always say where ringing stands, so nobody wonders whether it's on.
  const ringBar = () => !S.me || ring === "unsupported" ? ""
    : boss ? `<div class="soundbar"><span><b>This phone won't ring with the screen off</b> while you're signed in as owner or manager. Waiters' own phones ring.</span></div>`
    : ring === "on" ? `<div class="soundbar"><span><b>Rings with the screen off.</b> Calls, bill requests and ready orders ring this phone, even when it's locked.</span><button class="btn" data-act="testring">Test ring</button></div>`
    : ring === "blocked"
    ? `<div class="soundbar"><span><b>Notifications are blocked</b>, so this phone can't ring with the screen off. In Chrome: ⋮ → Settings → Site settings → Notifications → allow this site, then reload.</span></div>`
    : `<div class="soundbar"><span><b>Ring this phone when the screen is off.</b> Calls, bill requests and ready orders ring even when it's locked.</span><button class="btn primary" data-act="ring" ${ringBusy ? "disabled" : ""}>${ringBusy ? "Turning on…" : "Turn on"}</button></div>`;
  async function loadShift() {
    if (boss) return;
    try { const d = (await getDoc(myRef())).data() || {};
      const ok = d.waiter && d.shift && Date.now() - d.shift < SHIFT_MS && WAITERS.some((w) => w.id === d.waiter);
      S.me = ok ? d.waiter : null; S.since = ok ? d.shift : null; } catch { S.me = null; }
    keepRing(); update();
  }
  async function endShift(msg) {
    S.me = null; S.since = null; S.endArmed = false; S.picking = null; render();
    try { await setDoc(myRef(), { token: store.get("dees-staff-" + RID), t: Date.now() }); } catch {}
    if (msg) toast(msg);
  }
  // A shift that has run 16 hours ends by itself.
  setInterval(() => { if (!boss && S.since && Date.now() - S.since >= SHIFT_MS) endShift("Your shift has ended. Start a new one to keep working."); }, 60000);
  const notify = watcher();
  onSnapshot(query(rcol("groups"), where("open", "==", true)), (s) => { S.gotGroups = true; S.groups = s.docs.map((d) => d.data()).filter((g) => !g.tab).sort((a, b) => a.table - b.table || a.opened - b.opened); update(); }, (e) => paint(errorBox(e)));
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
      $("#sub").textContent = "Waiter"; setMenu([]);
      paint(waiterSignIn(S.picking && WAITERS.find((x) => x.id === S.picking)));
      if (S.shake) { S.shake = false; const dots = $(".pindots"); if (dots) { dots.classList.add("shake"); } }
      return;
    } else pick = "";
    // ☰: the shift, sound test and other waiters' tables. Table cards and their buttons stay on the page.
    const othersList = S.groups.filter((g) => g.waiter && g.waiter !== S.me);
    $("#sub").textContent = S.me && !boss ? `${wname(S.me)} · on shift` : "Waiter";
    setMenu(!S.me ? [] : [
      ...(!boss ? [{ html: `<b>${esc(wname(S.me))}</b><br>On shift since ${hhmm(S.since)}` },
        { label: S.endArmed ? "Tap again to end your shift" : "End shift", sub: S.endArmed ? "" : "Your tables stay yours until handed over", danger: true, keep: !S.endArmed,
          run: () => { if (!S.endArmed) { S.endArmed = true; setTimeout(() => { if (S.endArmed) { S.endArmed = false; render(); } }, 4000); render(); }
            else { const mine = S.groups.filter((g) => g.waiter === S.me).length; endShift(mine ? `Shift ended. Your ${mine} table${mine > 1 ? "s are" : " is"} still yours until handed over.` : "Shift ended. See you next time!"); } } }] : []),
      ...(audio ? [{ label: "Test sound", sub: "Alerts are on", keep: true, run: beep }] : []),
      ...(!boss && ring === "on" ? [{ label: "Test ring", sub: "Rings when the screen is off", keep: true, run: () => testRing(wname(S.me)).catch(() => toast("Couldn't show a test ring.")) }] : []),
      { html: othersList.length ? `<b>Other waiters' tables</b><br>${othersList.map((g) => `${esc(name(g))}: ${esc(wname(g.waiter))}`).join("<br>")}` : "<b>Other waiters' tables</b><br>None right now" },
    ]);
    const free = S.groups.filter((g) => !g.waiter && seated(g));
    const mine = S.groups.filter((g) => g.waiter === S.me);
    const others = S.groups.filter((g) => g.waiter && g.waiter !== S.me);
    // A guest's call or bill request sits at the top of their table's card.
    const alertRow = (a, g) => `<div class="arow"><div><b>${ALERT[a.type]}</b> <span class="note" style="margin:0">from ${esc(nowName(g, a.pid, a.pname))} · ${ago(a.t)}</span></div>
      <div class="row">${a.ack ? `<span class="pill s-preparing">On the way</span><button class="btn primary" data-done="${a.id}">${a.type === "bill" ? "Bill delivered" : "Done"}</button>`
        : `<button class="btn primary" data-ack="${a.id}">On my way</button>`}${a.type === "bill" && g.waiter === S.me && S.open !== g.session ? `<button class="btn" data-open="${g.session}">Open bill</button>` : ""}</div></div>`;
    const busy = (g) => S.alerts.filter(live(g)).some((a) => !a.ack) * 2 + S.lines.some((l) => live(g)(l) && l.s === "ready");
    free.sort((a, b) => busy(b) - busy(a)); mine.sort((a, b) => busy(b) - busy(a));
    const freeCards = free.map((g) => { const al = S.alerts.filter(live(g));
      return `<article class="ticket${al.some((a) => !a.ack) ? " alert" : ""}"><header><b>${esc(name(g))}</b><span class="pill s-new">No waiter</span></header>
       ${al.map((a) => alertRow(a, g)).join("")}
       <p class="note" style="margin:4px 0 0">${Object.values(g.people).map((p) => esc(p.name)).join(", ")} · opened ${ago(g.opened)}</p>
       <div class="acts"><button class="btn primary" data-accept="${g.session}">Accept</button></div></article>`; }).join("");
    const mineCards = mine.map((g) => {
      const al = S.alerts.filter(live(g)), ready = S.lines.filter((l) => live(g)(l) && l.s === "ready"), open = S.open === g.session, unit = isShared(g.table) ? "group" : "table";
      return `<article class="ticket${al.some((a) => !a.ack) ? " alert" : ""}"><header><b>${esc(name(g))}</b><span class="note" style="margin:0">code ${esc(g.code)}</span></header>
        ${al.map((a) => alertRow(a, g)).join("")}
        <p class="note" style="margin:4px 0 0">${Object.values(g.people || {}).map((p) => esc(p.name)).join(", ") || "No guests yet"}</p>
        ${ready.map((l) => `<div class="oline"><span class="l">${label(l)} <span class="note">for ${esc(nowName(g, l.pid, l.pname))} · ${STATIONS[l.st]}</span></span><button class="btn primary" data-serve="${l.id}">Served</button></div>`).join("")}
        ${S.lines.filter((l) => live(g)(l) && l.s === "new" && l.by && l.by === S.me).map((l) => `<div class="oline"><span class="l">${label(l)} <span class="note">for ${esc(nowName(g, l.pid, l.pname))} · not started yet</span></span><button class="btn ghost small" data-unline="${l.id}" aria-label="Remove ${esc(l.n)}">Remove</button></div>`).join("")}
        <div class="acts"><button class="btn primary" data-addorder="${g.session}">Add order</button><button class="btn" data-open="${g.session}">${open ? "Hide bill" : "Bill"}</button><button class="btn ghost" data-release="${g.session}">Hand over</button>
          ${S.confirm === g.session ? `<button class="btn danger" data-close="${g.session}">Tap again to close</button>` : `<button class="btn ghost" data-confirm="${g.session}">Close ${unit}</button>`}</div>
        ${open ? billHtml(g, billLines, true) : ""}</article>`;
    }).join("");
    paint(`<section>${pick}${ringBar()}${soundBar()}
      ${free.length ? `<div class="label">Waiting for a waiter · alerts go to everyone</div><div class="grid">${freeCards}</div>` : ""}
      <div class="trow" style="margin-top:22px"><div class="label" style="margin:0">My tables</div><button class="btn small" data-act="opentable" aria-expanded="${!!S.opening}">${S.opening ? "Cancel" : "+ Open a table"}</button></div>
      ${S.opening ? `<div class="ticket" style="margin-top:10px"><b>Which table?</b><p class="note" style="margin:2px 0 8px">For guests ordering without their phones. Diners can still scan the table's QR and join.</p>
        <div class="row">${Array.from({ length: TABLES }, (_, i) => i + 1).map((n) => {
          // Taken: guests already sat down there, or another waiter has it. Shared tables take more than one group.
          const g = !isShared(n) && S.groups.find((x) => x.table === n), why = g ? (g.waiter ? (g.waiter === S.me ? "yours already" : `${wname(g.waiter)}'s`) : "guests waiting") : "";
          return `<button class="chip" data-opennum="${n}" ${g ? `disabled aria-disabled="true" aria-label="Table ${n}, ${esc(why)}" title="${esc(why)}"` : `aria-label="Table ${n}"`}>${n}</button>`; }).join("")}</div>
        ${S.groups.some((x) => !isShared(x.table)) ? `<p class="note" style="margin:8px 0 0">Greyed out: already has guests or a waiter.</p>` : ""}</div>` : ""}
      ${!S.gotGroups ? skTickets(2) : mine.length ? `<div class="grid">${mineCards}</div>` : `<p class="note">No tables yet. Accept one when guests sit down, or open one for guests ordering through you.</p>`}
    </section>`);
  }
  // The sign-in card: a standard two-step sign-in (who are you, then PIN) in the restaurant's look.
  function waiterSignIn(w) {
    const initial = (n) => esc((String(n).trim()[0] || "?").toUpperCase());
    const head = `<div class="wsign-head">${BRAND.logo ? `<img class="wsign-logo" ${isFileLogo(BRAND.logo) ? `src="${esc(BRAND.logo)}"` : `data-photo="${esc(BRAND.logo)}"`} alt="">`
      : `<div class="wsign-mono" aria-hidden="true">${initial(rname())}</div>`}<div class="wsign-rname">${esc(rname())}</div><div class="wsign-title">Waiter sign-in</div></div>`;
    const step = w ? `<div class="wsign-step"><div class="wav big" aria-hidden="true">${initial(w.name)}</div>
        <p class="wsign-q">Hi ${esc(w.name)}, enter your PIN</p>
        <div class="pindots" role="status" aria-label="${S.pin.length} of 4 digits entered">${[0, 1, 2, 3].map((i) => `<span class="${i < S.pin.length ? "on" : ""}"></span>`).join("")}</div>
        ${S.busy ? `<p class="note" style="margin:6px 0 0">Starting your shift…</p>` : S.pinErr ? `<p class="err" role="alert">${esc(S.pinErr)}</p>` : ""}
        <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `<button type="button" data-key="${k}" ${S.busy ? "disabled" : ""}>${k}</button>`).join("")}
          <button type="button" class="kfn" data-act="notme">Not ${esc(w.name)}?</button><button type="button" data-key="0" ${S.busy ? "disabled" : ""}>0</button>
          <button type="button" class="kfn" data-key="del" aria-label="Delete last digit" ${S.busy ? "disabled" : ""}>⌫</button></div></div>`
      : `<div class="wsign-step"><p class="wsign-q">Who's working today?</p>
        ${WAITERS.length ? `<div class="wnames">${WAITERS.map((x) => `<button type="button" class="wname" data-pickme="${x.id}"><span class="wav" aria-hidden="true">${initial(x.name)}</span><span>${esc(x.name)}</span></button>`).join("")}</div>`
          : `<p class="note">No waiters yet. The owner or manager adds them under Staff.</p>`}</div>`;
    return `<section class="wsign"><div class="wsign-card">${head}${step}</div>
      <p class="note wsign-foot">Your PIN comes from the owner or manager. Your shift ends when you tap End shift, or after 16 hours.</p></section>`;
  }
  async function startShift() {
    const pin = S.pin, w = S.picking; if (!w || S.busy || !/^\d{4}$/.test(pin)) return;
    S.busy = true; S.pinErr = ""; render();
    try { const now = Date.now(); await setDoc(myRef(), { token: store.get("dees-staff-" + RID), t: now, waiter: w, pin, shift: now });
      S.me = w; S.since = now; S.picking = null; S.pin = ""; S.busy = false; toast(`Shift started. Welcome, ${wname(w)}!`); keepRing(); update(); return; }
    catch (err) { S.pinErr = denied(err) ? "That PIN didn't work. Try again, or ask the owner or manager." : "Couldn't connect. Try again."; S.pin = ""; S.shake = true; }
    S.busy = false; render();
  }
  function pinKey(k) {
    if (S.me || !S.picking || S.busy) return;
    if (k === "del") S.pin = S.pin.slice(0, -1); else if (S.pin.length < 4) S.pin += k;
    if (S.pin.length) S.pinErr = "";
    render(); if (S.pin.length === 4) startShift();
  }
  document.addEventListener("keydown", (e) => {
    if (S.me || !S.picking || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^\d$/.test(e.key)) { e.preventDefault(); pinKey(e.key); } else if (e.key === "Backspace") { e.preventDefault(); pinKey("del"); }
    else if (e.key === "Escape") { S.picking = null; S.pin = ""; S.pinErr = ""; render(); }
  });
  const find = (sid) => S.groups.find((g) => g.session === sid);
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    try {
      if (d.act === "testring") testRing(wname(S.me)).catch(() => toast("Couldn't show a test ring."));
      else if (d.act === "ring") { ringBusy = true; render();
        try { ring = await enablePush(fbApp, pushRef(), pushUrl());
          toast(ring === "on" ? "This phone will ring for your tables, even with the screen off" : ring === "blocked" ? "Notifications are blocked in Chrome's settings" : "Ringing not turned on"); }
        catch (err) { console.error("Turning on ringing failed", err);
          toast(denied(err) ? "Ringing isn't allowed for this phone yet. Ask the owner to make sure it's set up as a staff phone." : `Couldn't turn on ringing (${(err && (err.code || err.message)) || "error"}). Try again.`); }
        ringBusy = false; render(); }
      else if (d.act === "sound") { await enableSound(); render(); }
      else if (d.act === "testsound") beep();
      else if (d.me && boss) { S.me = d.me; store.set("dees-waiter-" + RID, d.me); update(); }
      else if (d.pickme) { S.picking = d.pickme; S.pin = ""; S.pinErr = ""; render(); }
      else if (d.key && !boss) pinKey(d.key);
      else if (d.act === "notme") { S.picking = null; S.pin = ""; S.pinErr = ""; render(); }
      else if (d.act === "endshift") { if (!S.endArmed) { S.endArmed = true; render(); setTimeout(() => { if (S.endArmed) { S.endArmed = false; render(); } }, 4000); return; }
        const mine = S.groups.filter((g) => g.waiter === S.me).length;
        await endShift(mine ? `Shift ended. Your ${mine} table${mine > 1 ? "s are" : " is"} still yours until handed over.` : "Shift ended. See you next time!"); }
      else if (d.accept) { await runTransaction(db, async (tx) => { const s = await tx.get(groupRef(d.accept)); if (!s.exists() || s.data().waiter) throw new Error("taken"); tx.update(groupRef(d.accept), { waiter: S.me, accepted: Date.now() }); }); toast(`${name(find(d.accept) || { table: "" })} is yours`); }
      else if (d.release) { await updateDoc(groupRef(d.release), { waiter: null }); toast("Open for another waiter"); }
      else if (d.ack) { await updateDoc(rdoc("alerts", d.ack), { ack: Date.now(), ackBy: S.me }); toast("Diner told you're on the way"); }
      else if (d.done) await updateDoc(rdoc("alerts", d.done), { done: true, doneAt: Date.now() });
      else if (d.serve) await updateDoc(rdoc("lines", d.serve), { s: "served", tServed: Date.now(), servedBy: S.me });
      else if (d.open) { S.open = S.open === d.open ? null : d.open; watchBill(S.open); render(); }
      else if (d.addorder) { const g = find(d.addorder); if (!g) return;
        orderTaker({ g, by: S.me, byName: wname(S.me), title: `Order for ${name(g)}` }); }
      else if (d.unline) { b.disabled = true; await deleteDoc(rdoc("lines", d.unline)); toast("Removed"); }
      else if (d.act === "opentable") { S.opening = !S.opening; render(); }
      else if (d.opennum) { const n = Number(d.opennum); S.opening = false; render();
        // A table nobody scanned: it opens as this waiter's when the first order is sent.
        const open = await groupsAt(n);
        if (open.length && !isShared(n)) { const w = open.map((x) => x.waiter).find(Boolean);
          toast(w ? `Table ${n} was just taken by ${w === S.me ? "you" : wname(w)}.` : `Table ${n} already has guests. Accept it under "Waiting for a waiter".`); return; }
        const grp = { ...newGroup(n, null), waiter: S.me, accepted: Date.now() };
        orderTaker({ create: { group: grp, needsCode: true, extra: (bt, code) => {
            bt.set(tableRef(n), { table: n, current: grp.session }); bt.set(codeRef(code), { session: grp.session, table: n }); bt.set(inviteRef(code), { rid: RID }); } },
          by: S.me, byName: wname(S.me), title: `Open table ${n}` }); }
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
  loadShift();
  // The back arrow goes back to the waiter sign-in, not the front page: from the PIN pad to the names,
  // and from a shift (after a yes) to the names, ending the shift. Tables stay the waiter's until handed over.
  window.wasabiBack = () => {
    const sheet = document.querySelector(".otk"); if (sheet) { sheet.remove(); document.body.classList.remove("otk-open"); return true; }
    if (boss) return false;
    if (!S.me && S.picking) { S.picking = null; S.pin = ""; S.pinErr = ""; render(); return true; }
    if (!S.me) return true;   // already on the sign-in names: stay here
    const mine = S.groups.filter((g) => g.waiter === S.me).length;
    askSure("End your shift?", `You'll go back to the waiter sign-in.${mine ? ` Your ${mine} table${mine > 1 ? "s stay" : " stays"} yours until handed over.` : ""}`, "End shift", "Stay on shift")
      .then((yes) => { if (yes) endShift(mine ? `Shift ended. Your ${mine} table${mine > 1 ? "s are" : " is"} still yours until handed over.` : "Shift ended. See you next time!"); });
    return true;
  };
  async function closeGroup(sid) {
    const g = find(sid); if (!g) return;
    return closeSession(g);
  }
  setInterval(render, 30000);
  cfgListeners.add(render);
}

// ================= SETUP =================
// The same tabs as the owner and manager pages, with Tables & QR selected; the others open that page.
const ownerTabs = (role) => (role === "owner" ? [["dash", "Dashboard"], ["live", "Tables"], ["menu", "Menu"], ["brand", "Look"], ["staff", "Staff"]] : [["live", "Tables"], ["menu", "Menu"], ["staff", "Staff"]]);
// ☰ on the owner, manager and Tables & QR pages: things used now and then. extra = items for this page.
function bossMenu(role, extra = []) {
  const st = subState(ACCOUNT), page = role === "owner" ? "owner" : "manager";
  setMenu([
    { html: `<b>${esc(rname())}</b><br>${role === "owner" ? "Owner" : "Manager"}${auth.currentUser && auth.currentUser.email ? ` · ${esc(auth.currentUser.email)}` : ""}` },
    { label: "Tables & QR codes", sub: "Add tables, print cards, staff codes", href: `${BASE}?r=${RID}#setup` },
    ...(location.hash === "#setup" ? [{ label: role === "owner" ? "Owner page" : "Manager page", sub: "Dashboard, menu, staff", href: `${BASE}?r=${RID}#${page}` }] : []),
    ...(role === "owner" && ACCOUNT ? [{ html: `<b>Subscription</b><br>${ACCOUNT.status === "active" ? `Paid until ${day(ACCOUNT.paidUntil)}${st.kind === "grace" ? " · overdue" : ""}` : "Not active"}. ${price()}.` }] : []),
    { label: "My restaurants", sub: "Switch restaurant", href: `${BASE}#${page}` },
    ...(IS_CO ? [{ label: "Live demo", sub: "One QR code: everyone in the room picks a role. Separate from your restaurant", href: `${BASE}demo/` }] : []),
    ...extra,
    { html: `<b>Help from ${esc(COMPANY.name)}</b><br>${contactLine()}` },
    { label: "Log out", danger: true, run: async () => { if (await askLogOut()) logOut(); } },
  ]);
}
const tabBar = (tabs, cur) => `<div class="seg tabs" role="tablist" style="max-width:640px">${tabs.map(([k, l]) => `<button aria-pressed="${cur === k}" data-otab="${k}">${l}</button>`).join("")}</div>`;
function setupScreen(role) {
  SETUP_ROLE = role === "manager" ? "manager" : "owner";
  $("#wrap").classList.add("wide"); $("#sub").textContent = role === "owner" ? "Owner" : "Manager"; document.title = "Tables & QR · " + rname();
  const link = (h, l) => `<div><div class="note" style="margin:0">${l}</div><a href="${h}">${esc(h)}</a></div>`;
  let rot = false, keys = {}, staffTok = null, rotStaff = false, rekey = null;
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
      ${keys[n] ? `<a class="note" href="${tableLink(n, keys[n])}">Open</a>` : skInline(40)}
      <button class="btn ghost small" data-rekey="${n}">${rekey === n ? "Tap again" : "New code"}</button></div>`;
    bossMenu(role);
    paint(subBanner() + tabBar(ownerTabs(role), "tables") + `<section><h2 class="ptitle">Tables and QR codes</h2><p class="note" style="margin-top:0">Diners scan these.</p>
      <div class="row"><button class="btn" data-tables="-1" aria-label="One table fewer">−</button><b class="num">${TABLES} tables</b><button class="btn" data-tables="1" aria-label="One more table">+</button>
        <button class="btn primary" data-act="print" ${Object.keys(keys).length < TABLES ? "disabled" : ""}>Print table cards</button></div>
      <div class="qrs">${Array.from({ length: TABLES }, (_, i) => tableCard(i + 1)).join("")}</div>
      <p class="note">Each code carries a secret key, so nobody can order from outside by guessing a table number. If one table's card is damaged or photographed, tap <b>New code</b> under it and reprint just that one.</p>
      <p class="note">Mark big communal tables as <b>Shared</b>: several groups can then order there, each with its own code and bill. On normal tables everyone who scans joins the same bill.</p>
      <button class="btn" data-act="rotate">${rot ? "Tap again: every printed table card will stop working" : "Make new codes for all tables"}</button>
      <div class="label">Staff phones · scan once with each phone</div>
      <div class="qrs">${screens.map(([k, v]) => `<div class="qr sqr"><div class="box" id="sqr-${k}"></div><b>${esc(v)}</b>${staffTok ? `<a class="note" href="${staffLink(k)}">Open here</a>` : skInline(60)}</div>`).join("")}</div>
      <p class="note">Each waiter scans the <b>Waiter</b> code once with their own phone. After that they start each shift with their name and PIN (set the PINs under Owner → Staff). The kitchen, bar and grill phones scan their own code once. Keep these codes away from guests.</p>
      <p class="note">If a phone is lost or someone leaves, make new staff codes: every staff phone is signed out and scans again.</p>
      <button class="btn" data-act="rotstaff">${rotStaff ? "Tap again: every staff phone must scan again" : "Make new staff codes"}</button>
      <div class="label">Owner and manager pages</div>
      <div class="links">${IS_CO ? link(BASE + "demo/", "Live demo (company only): one QR code, everyone picks a role, separate from this restaurant") : ""}${link(BASE + "?r=" + RID + "#owner", "Owner (dashboard, menu, look, staff)")}${link(BASE + "?r=" + RID + "#manager", "Manager (menu and staff)")}</div>
      <p class="note">These open with the owner's or a manager's Google sign-in. The owner adds managers under Owner → Staff.</p></section>`);
    const draw = () => { for (let i = 1; i <= TABLES; i++) { const el = document.getElementById("qr" + i); if (el && !el.childNodes.length && keys[i]) brandQr(el, tableLink(i, keys[i]), 132); }
      screens.forEach(([k]) => { const el = document.getElementById("sqr-" + k); if (el && !el.childNodes.length && staffTok) brandQr(el, staffLink(k), 132); }); };
    if (window.QRCode) draw(); else window.addEventListener("load", draw, { once: true });
  }
  // A sheet of table cards to print and cut out: name, table number, QR, one line of instructions.
  function printCards() {
    let sheet = document.getElementById("printsheet"); if (sheet) sheet.remove();
    sheet = document.createElement("div"); sheet.id = "printsheet";
    sheet.innerHTML = Array.from({ length: TABLES }, (_, i) => `<div class="pcard"><div class="pname">${esc(rname())}</div><div class="ptable">Table ${i + 1}</div>
      <div class="pqr" id="pqr${i + 1}"></div><div class="phow">Scan to see the menu, order,<br>call your waiter and split the bill</div></div>`).join("");
    document.body.appendChild(sheet);
    // Wait until every code (and its logo) is drawn before opening the print dialog.
    const drawn = Array.from({ length: TABLES }, (_, i) => brandQr(document.getElementById("pqr" + (i + 1)), tableLink(i + 1, keys[i + 1]), 220).catch(() => {}));
    document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); sheet.remove(); };
    window.addEventListener("afterprint", done, { once: true });
    Promise.all(drawn).then(() => setTimeout(() => { try { window.print(); } catch { done(); } }, 150));
  }
  document.addEventListener("click", async (e) => {
    const ot = e.target.closest("button[data-otab]");
    if (ot && ot.dataset.otab !== "tables") { try { sessionStorage.setItem("dees-otab", ot.dataset.otab); } catch {} location.href = `${BASE}?r=${RID}#${role}`; return; }
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
  const TABS = ownerTabs(owner ? "owner" : "manager");
  let startTab = null; try { startTab = sessionStorage.getItem("dees-otab"); sessionStorage.removeItem("dees-otab"); } catch {}
  if (startTab === "open" || startTab === "past") startTab = "live";
  // Tables tab: Open (live) or Past (one day at a time, owners only).
  const S = { tab: TABS.some(([k]) => k === startTab) ? startTab : TABS[0][0], ttab: "open", edit: null, period: "7", m: null, loading: false, armed: null, pending: false, busy: "", admins: null, pins: null, wtok: null, wqr: false };
  // Who can sign in: the owner (set on the account by the company) and the managers the owner adds.
  // Waiter PINs live in restaurants/{RID}/secrets/waiters, readable only by the owner and managers.
  const pinsRef = () => rdoc("secrets", "waiters");
  async function loadPins() { try { const d = await getDoc(pinsRef()); S.pins = (d.exists() && d.data().pins) || {}; } catch { S.pins = {}; } render(); }
  // The waiter sign-in link is the staff link (secrets/staff) opening the waiter screen. Making new staff
  // codes on Tables & QR replaces it.
  async function loadWLink() {
    try { const ref = rdoc("secrets", "staff"), d = await getDoc(ref); let t = d.exists() && d.data().token;
      if (!t) { t = newKey() + newKey(); await setDoc(ref, { token: t, t: Date.now() }); } S.wtok = t; }
    catch { S.wtok = ""; }
    render();
  }
  const waiterLink = () => `${BASE}?r=${RID}&s=${S.wtok}#waiter`;
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
    bossMenu(owner ? "owner" : "manager");
    if (!TABS.some(([k]) => k === S.tab)) S.tab = TABS[0][0];
    paint(subBanner() + tabBar(TABS, S.tab) + `
      ${S.tab === "live" ? tablesTab() : S.tab === "menu" ? menuTab() : S.tab === "staff" ? staffTab() : owner && S.tab === "brand" ? brandTab() : owner ? dashTab() : menuTab()}`);
    const qr = document.getElementById("wlqr");
    if (qr && S.wtok) { const draw = () => { if (!qr.childNodes.length) brandQr(qr, waiterLink(), 160); };
      if (window.QRCode) draw(); else window.addEventListener("load", draw, { once: true }); }
  }

  // ----- open tables -----
  // Every open table and bar tab, live: who's sitting there, which waiter has it, calls waiting,
  // what's being made, the bill so far. The owner or manager can change the waiter or close it.
  const O = { on: false, groups: null, lines: {}, live: [], alerts: [], sids: "", subs: [], armed: null, busy: null };
  function watchOpen() {
    if (O.on) return; O.on = true;
    const again = () => { if (S.tab === "live" && S.ttab === "open" && !editing()) render(); };
    onSnapshot(query(rcol("groups"), where("open", "==", true)), (q) => {
      O.groups = q.docs.map((x) => x.data()); again();
      // The bill so far: every item at the open tables (30 tables per listener, the database's limit).
      const sids = O.groups.map((g) => g.session).sort(), key = sids.join(",");
      if (key === O.sids) return; O.sids = key; O.subs.forEach((u) => u()); O.subs = []; O.lines = {};
      for (let i = 0; i < sids.length; i += 30) { const part = sids.slice(i, i + 30);
        O.subs.push(onSnapshot(query(rcol("lines"), where("session", "in", part)), (ls) => {
          part.forEach((sid) => { O.lines[sid] = []; }); ls.docs.forEach((x) => { const l = x.data(); (O.lines[l.session] = O.lines[l.session] || []).push(l); }); again(); }, () => {})); }
    }, (e) => { O.groups = []; O.err = e; again(); });
    onSnapshot(query(rcol("alerts"), where("done", "==", false)), (q) => { O.alerts = q.docs.map((x) => ({ id: x.id, ...x.data() })); again(); }, () => {});
    setInterval(again, 30000);   // keeps "12 min" fresh
  }
  if (S.tab === "live") watchOpen();
  function tablesTab() {
    const past = owner && S.ttab === "past";
    return (owner ? `<div class="seg" role="tablist" aria-label="Tables" style="max-width:360px;margin:4px 0 6px"><button role="tab" aria-pressed="${!past}" data-ttab="open">Open now</button><button role="tab" aria-pressed="${past}" data-ttab="past">Past</button></div>` : "")
      + (past ? pastTab() : openTab());
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("button[data-ttab]"); if (!b || S.tab !== "live") return;
    S.ttab = b.dataset.ttab === "past" && owner ? "past" : "open"; if (S.ttab === "open") watchOpen(); render(); });
  function openTab() {
    if (O.err) return `<section>${errorBox(O.err)}</section>`;
    if (!O.groups) return `<section><h2 class="ptitle">Open tables</h2>${skTickets(3)}</section>`;
    const calls = (g) => O.alerts.filter((a) => a.session === g.session);
    const rank = (g) => (calls(g).some((a) => !a.ack) ? 0 : !g.waiter && !g.tab ? 1 : 2);
    const list = [...O.groups].sort((a, b) => rank(a) - rank(b) || (a.tab ? 1 : 0) - (b.tab ? 1 : 0) || a.table - b.table || a.opened - b.opened);
    const noWaiter = list.filter((g) => !g.waiter && !g.tab).length, waiting = list.filter((g) => calls(g).some((a) => !a.ack)).length;
    const opts = (cur) => `<option value="">No waiter</option>${WAITERS.map((w) => `<option value="${esc(w.id)}" ${w.id === cur ? "selected" : ""}>${esc(w.name)}</option>`).join("")}${cur && !WAITERS.some((w) => w.id === cur) ? `<option value="${esc(cur)}" selected>${esc(wname(cur))}</option>` : ""}`;
    const card = (g) => {
      const ls = O.lines[g.session] || [], al = calls(g), unit = g.tab ? "tab" : isShared(g.table) ? "group" : "table";
      const making = ls.filter((l) => l.s === "new" || l.s === "preparing").length, ready = ls.filter((l) => l.s === "ready").length;
      const ppl = Object.values(g.people || {}).map((p) => esc(p.name)).join(", ");
      return `<article class="ticket${al.some((a) => !a.ack) ? " alert" : ""}">
        <header><b>${esc(where_(g, O.groups))}</b>${g.tab ? `<span class="pill s-preparing">Bar tab</span>` : g.waiter ? `<span class="note" style="margin:0">${esc(wname(g.waiter))}</span>` : `<span class="pill s-new">No waiter</span>`}</header>
        ${al.map((a) => `<div class="arow"><div><b>${ALERT[a.type]}</b> <span class="note" style="margin:0">from ${esc(nowName(g, a.pid, a.pname))} · ${ago(a.t)}</span></div>
          ${a.ack ? `<span class="pill s-preparing">${esc(wname(a.ackBy) || "Waiter")} on the way</span>` : `<span class="pill s-new">Waiting</span>`}</div>`).join("")}
        <p class="note" style="margin:6px 0 0">${ppl || "No guests yet"} · open ${ago(g.opened).replace(" ago", "")}</p>
        <div class="ostats"><span><b class="num">TSh ${fmt(tableTotal(ls))}</b> so far</span><span>${ls.length} item${ls.length === 1 ? "" : "s"}</span>${making ? `<span>${making} being made</span>` : ""}${ready ? `<span class="hot">${ready} ready to serve</span>` : ""}</div>
        <div class="acts">${g.tab ? "" : `<label class="ow"><span class="note" style="margin:0">Waiter</span><select class="field sel" data-owaiter="${esc(g.session)}" aria-label="Waiter for ${esc(where_(g, O.groups))}">${opts(g.waiter)}</select></label>`}
          ${O.armed === g.session ? `<button class="btn danger" data-oclose="${esc(g.session)}" ${O.busy === g.session ? "disabled" : ""}>${O.busy === g.session ? "Closing…" : "Tap again to close"}</button>`
            : `<button class="btn ghost" data-oarm="${esc(g.session)}">Close ${unit}</button>`}</div>
      </article>`;
    };
    return `<section><h2 class="ptitle">Open tables</h2>
      <p class="note" style="margin-top:0">${list.length ? `${list.length} open${noWaiter ? ` · <b>${noWaiter} without a waiter</b>` : ""}${waiting ? ` · <b>${waiting} calling</b>` : ""}. Updates by itself.` : "No open tables right now. Tables appear here as soon as guests sit down."}</p>
      ${list.length ? `<div class="grid">${list.map(card).join("")}</div>` : ""}
      ${list.length ? `<p class="note">Closing ends the table for everyone at it: unfinished items and calls are cleared and the table's code stops working. Only close when they've paid and left.</p>` : ""}</section>`;
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || S.tab !== "live" || S.ttab !== "open") return; const d = b.dataset;
    if (d.oarm) { O.armed = d.oarm; render(); setTimeout(() => { if (O.armed === d.oarm && O.busy !== d.oarm) { O.armed = null; render(); } }, 4000); }
    else if (d.oclose) { const g = (O.groups || []).find((x) => x.session === d.oclose); if (!g || O.busy) return;
      O.busy = g.session; render();
      try { await closeSession(g); toast(`${where_(g, O.groups)} closed`); } catch (err) { fail(err); }
      O.busy = null; O.armed = null; render(); }
  });
  document.addEventListener("change", async (e) => {
    const sid = e.target.dataset && e.target.dataset.owaiter; if (!sid) return;
    const g = (O.groups || []).find((x) => x.session === sid), w = e.target.value || null; if (!g) return;
    try { await updateDoc(groupRef(sid), w ? { waiter: w, accepted: g.accepted || Date.now() } : { waiter: null });
      toast(w ? `${where_(g, O.groups)} is now ${wname(w)}'s` : `${where_(g, O.groups)} is open for any waiter`); }
    catch (err) { fail(err); }
    e.target.blur();
  });

  // ----- past tables -----
  // One day at a time, so it stays cheap: opening a day reads only that day's closed tables (one read
  // each), and a table's items are read only when it's tapped open. Nothing loads until the tab is used.
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const dayStart = (k) => new Date(k + "T00:00").getTime();
  const H = { day: dayKey(Date.now()), got: null, rows: null, err: null, open: null, rec: {}, csv: false };
  async function loadDay() {
    const k = H.day, a = dayStart(k); H.rows = null; H.err = null; H.open = null;
    try { const q = await getDocs(query(rcol("sessions"), where("closed", ">=", a), where("closed", "<", a + DAY)));
      if (H.day !== k) return; H.rows = q.docs.map((x) => x.data()).sort((x, y) => y.closed - x.closed); }
    catch (e) { if (H.day !== k) return; H.err = e; H.rows = []; }
    if (S.tab === "live" && S.ttab === "past") render();
  }
  async function loadRec(sid) {
    if (H.rec[sid] && !H.rec[sid].err) return;
    H.rec[sid] = { loading: true }; render();
    try { const [g, ls] = await Promise.all([getDoc(groupRef(sid)), getDocs(query(rcol("lines"), where("session", "==", sid)))]);
      H.rec[sid] = { g: g.exists() ? g.data() : { people: {} }, lines: ls.docs.map((x) => x.data()).sort((a, b) => a.t - b.t) }; }
    catch (e) { H.rec[sid] = { err: e }; }
    render();
  }
  const hm = (t) => (t ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "–");
  function receipt(r) {
    if (!r || r.loading) return `<div class="rcpt"><p class="note" style="margin:0">Loading the bill…</p></div>`;
    if (r.err) return `<div class="rcpt">${errorBox(r.err)}</div>`;
    const g = r.g, ls = r.lines, ppl = shares(g, ls), others = ls.filter((l) => !(g.people || {})[l.pid]);
    const item = (l) => `<div class="rl"><span>${label(l)}${l.note ? ` <span class="nt">${esc(l.note)}</span>` : ""}<span class="note" style="margin:0"> · ${hm(l.t)}${l.byName ? ` · added by ${esc(l.byName)}` : ""}</span>${l.closedUnserved ? ` <span class="pill s-new">Not served</span>` : ""}</span><span class="num">${fmt(l.pr)}</span></div>`;
    const person = (name, items, amt, paid) => `<div class="rp"><div class="rph"><b>${esc(name)}</b><span class="num">TSh ${fmt(amt)}${paid ? " · paid" : ""}</span></div>${items.map(item).join("") || `<p class="note" style="margin:0">Nothing ordered</p>`}</div>`;
    return `<div class="rcpt">${g.tab ? `<p class="note" style="margin:0 0 6px">Bar tab: ${esc(g.tab)}</p>` : ""}
      ${ppl.map((p) => person(p.name, p.items, p.amt, p.paid)).join("")}${others.length ? person("Others", others, tableTotal(others), false) : ""}
      <div class="rph rtot"><b>Total</b><span class="num">TSh ${fmt(tableTotal(ls))}</span></div>
      ${g.split === "equal" ? `<p class="note" style="margin:4px 0 0">Split equally.</p>` : ""}</div>`;
  }
  function pastTab() {
    if (H.got !== H.day) { H.got = H.day; H.rows = null; queueMicrotask(loadDay); }
    const today = dayKey(Date.now()), when = new Date(H.day + "T12:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const head = `<h2 class="ptitle">Past tables</h2>
      <div class="dayp"><button class="btn ghost" data-hday="-1" aria-label="Day before">‹</button>
        <input type="date" class="field sel" id="hday" value="${H.day}" max="${today}" aria-label="Day">
        <button class="btn ghost" data-hday="1" aria-label="Day after" ${H.day >= today ? "disabled" : ""}>›</button>
        ${H.day !== today ? `<button class="btn ghost small" data-hday="0">Today</button>` : ""}</div>
      <p class="note" style="margin:6px 0 0"><b>${esc(when)}</b></p>`;
    if (H.rows === null) return `<section>${head}${skRows(4)}</section>`;
    if (H.err) return `<section>${head}${errorBox(H.err)}</section>`;
    const sum = H.rows.reduce((a, x) => a + (x.total || 0), 0);
    const row = (x) => { const open = H.open === x.session, ppl = x.guests || 0;
      return `<div class="hrec${open ? " on" : ""}"><button class="hrow" data-hopen="${esc(x.session)}" aria-expanded="${open}">
        <span class="ht num">${hm(x.opened)}<br>${hm(x.closed)}</span>
        <span class="hn"><b>${x.table ? `Table ${x.table}` : "Bar tab"}</b><span class="note" style="margin:0">${x.waiter ? esc(wname(x.waiter)) : x.table ? "No waiter" : "Bar"} · ${ppl} guest${ppl === 1 ? "" : "s"}${x.opened ? ` · ${dur(x.closed - x.opened)}` : ""}</span></span>
        <span class="hs"><b class="num">TSh ${fmt(x.total)}</b><span class="note" style="margin:0">${x.paid ? `${x.paid} of ${ppl} paid` : "Not marked paid"}</span></span></button>
        ${open ? receipt(H.rec[x.session]) : ""}</div>`; };
    return `<section>${head}
      ${H.rows.length ? `<div class="trow" style="margin-top:12px"><span>${H.rows.length} table${H.rows.length === 1 ? "" : "s"} closed · <b class="num">TSh ${fmt(sum)}</b></span>
          <button class="btn small" data-act="hcsv" ${H.csv ? "disabled" : ""}>${H.csv ? "Preparing…" : "Download day"}</button></div>
        <div class="hlist">${H.rows.map(row).join("")}</div>`
        : `<p class="empty">No tables were closed on this day.</p>`}
      <p class="note">Tap a table to see who had what. Guests' first names are kept for 30 days, then replaced with "Guest 1", "Guest 2"… The items and totals stay.</p></section>`;
  }
  // The whole day as a spreadsheet: one row per item ordered that day.
  async function dayCsv() {
    const a = dayStart(H.day); H.csv = true; render();
    try {
      const q = await getDocs(query(rcol("lines"), where("t", ">=", a), where("t", "<", a + DAY)));
      const ls = q.docs.map((x) => x.data()).sort((x, y) => x.t - y.t);
      // A cell starting with = + - or @ would run as a formula in Excel: start it with ' instead.
      const cell = (v) => { let t = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const rows = [["Date", "Time", "Table", "Guest", "Item", "Option", "Price (TSh)", "Station", "Added by", "Note", "Status"],
        ...ls.map((l) => [H.day, hm(l.t), l.table ? l.table : "Bar tab", l.pname || "", l.n, l.v || "", l.pr, STATIONS[l.st] || "", l.byName || "Diner", l.note || "", l.closedUnserved ? "Not served" : l.s])];
      const url = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
      const lk = document.createElement("a"); lk.href = url; lk.download = `${RID}-orders-${H.day}.csv`; document.body.appendChild(lk); lk.click(); lk.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(ls.length ? `Downloaded ${ls.length} item${ls.length === 1 ? "" : "s"}` : "No items ordered on this day");
    } catch (e) { fail(e); }
    H.csv = false; render();
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || S.tab !== "live" || S.ttab !== "past") return; const d = b.dataset;
    if (d.hday != null) { H.day = d.hday === "0" ? dayKey(Date.now()) : dayKey(dayStart(H.day) + Number(d.hday) * DAY + 12 * 36e5); render(); }
    else if (d.hopen) { H.open = H.open === d.hopen ? null : d.hopen; if (H.open) loadRec(H.open); else render(); }
    else if (d.act === "hcsv") dayCsv();
  });
  document.addEventListener("change", (e) => {
    if (e.target.id !== "hday" || !/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) return;
    H.day = e.target.value > dayKey(Date.now()) ? dayKey(Date.now()) : e.target.value; e.target.blur(); render();
  });

  // ----- forgetting names after 30 days -----
  // Guests' first names stay 30 days. After that, an owner's or manager's phone replaces them with
  // "Guest 1, Guest 2…" when this page opens: at most once a day, and only the days not done yet
  // (live/retention remembers how far it got). Items, prices and totals stay for the dashboard.
  async function forgetOldNames() {
    const cutoff = Date.now() - 30 * DAY, ref = rdoc("live", "retention");
    let from = 0; try { const d = await getDoc(ref); from = (d.exists() && d.data().upto) || 0; } catch { return; }
    if (cutoff - from < DAY) return;
    const pages = async (col, field, fix) => {
      let last = null;
      for (;;) {
        const q = await getDocs(query(rcol(col), where(field, ">=", from), where(field, "<", cutoff), orderBy(field), ...(last ? [startAfter(last)] : []), limit(300)));
        if (q.empty) return;
        const b = writeBatch(db); let n = 0;
        q.docs.forEach((x) => { const u = fix(x.data()); if (u === "delete") { b.delete(x.ref); n++; } else if (u) { b.update(x.ref, u); n++; } });
        if (n) await b.commit();
        if (q.size < 300) return; last = q.docs[q.size - 1];
      }
    };
    try {
      await pages("lines", "t", (l) => (l.pname && l.pname !== "Guest" ? { pname: "Guest" } : null));
      await pages("alerts", "t", (a) => (a.pname && a.pname !== "Guest" ? { pname: "Guest" } : null));
      await pages("joins", "t", () => "delete");
      await pages("groups", "opened", (g) => {
        if (g.open !== false || g.forgot) return null;
        const people = {}; Object.entries(g.people || {}).forEach(([pid, p], i) => { people[pid] = { name: `Guest ${i + 1}`, t: (p && p.t) || 0 }; });
        const u = { people, forgot: true }; if (g.label) u.label = deleteField(); if (g.tab) u.tab = "Tab"; return u;
      });
      await setDoc(ref, { upto: cutoff, t: Date.now() });
    } catch (e) { console.warn("Older guest names not cleared yet:", (e && e.code) || "error"); }
  }
  setTimeout(forgetOldNames, 8000);   // after the page has settled; never in the way

  // ----- menu editor -----
  function menuTab() {
    const stationSel = (si, cur) => `<select class="field sel" id="ss-${si}" data-f="sst" data-si="${si}" aria-label="Station">${STN.map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${v}</option>`).join("")}</select>`;
    const imp = S.imp;
    const tmpl = `<div class="tmpl"><div style="min-width:0"><b>Menu template</b>
        <div class="note" style="margin:2px 0 0">Fill in your whole menu in Excel or Google Sheets (one row per price), then upload it here. The download already has your current menu in it.</div></div>
      <div class="row"><button class="btn" data-act="mdl">Download template</button>
        <label class="btn primary" for="mup">${S.busy === "mup" ? "Reading…" : "Upload template"}</label>
        <input type="file" id="mup" accept=".csv,.xlsx,text/csv" hidden></div></div>
      ${imp && imp.error ? `<div class="impbox"><p class="err" style="margin:0">${esc(imp.error)}</p><button class="btn" data-act="impcancel" style="margin-top:10px">OK</button></div>` : ""}
      ${imp && imp.menu ? `<div class="impbox"><b>Ready to import: ${imp.items} item${imp.items > 1 ? "s" : ""} in ${imp.menu.length} section${imp.menu.length > 1 ? "s" : ""}</b>
        <ul class="implist">${imp.menu.map((x) => `<li>${esc(x.c)} · ${x.items.length} item${x.items.length > 1 ? "s" : ""} · goes to ${esc(STATIONS[x.st] || x.st)}</li>`).join("")}</ul>
        ${imp.warn.length ? `<p class="note" style="margin:8px 0 4px"><b>${imp.warn.length} row${imp.warn.length > 1 ? "s" : ""} to check</b></p><ul class="implist warn">${imp.warn.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join("")}${imp.warn.length > 8 ? `<li>and ${imp.warn.length - 8} more</li>` : ""}</ul>` : ""}
        <div class="row" style="margin-top:12px"><button class="btn primary" data-act="impreplace">${S.armed === "impr" ? "Tap again to replace" : "Replace my menu"}</button>
          <button class="btn" data-act="impadd">Add to my menu</button><button class="btn ghost" data-act="impcancel">Cancel</button></div>
        <p class="note">Replace swaps your whole menu for the file. Add keeps your menu and adds the file's items, updating ones with the same name. Photos stay on items with the same name either way.</p></div>` : ""}`;
    return `<section>${tmpl}<p class="note" style="margin-top:14px">Changes save as you go and reach diners' phones straight away. Use <b>Sold out</b> for anything that runs out tonight.</p>
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
    const wl = S.wtok == null ? (loadWLink(), skRows(1))
      : !S.wtok ? `<p class="note">Couldn't load the link. Check the connection and open this tab again.</p>`
      : `<div class="vrow"><input class="field" id="wlinkin" readonly value="${esc(waiterLink())}" aria-label="Waiter sign-in link"><button class="btn" data-act="wlcopy">Copy</button></div>
        <div class="row" style="margin-top:8px"><button class="btn primary" data-act="wlshare">Send to a waiter</button><button class="btn ghost" data-act="wlqr">${S.wqr ? "Hide QR code" : "Show QR code"}</button></div>
        ${S.wqr ? `<div class="qrs" style="margin-top:10px"><div class="qr"><div class="box" id="wlqr"></div><b>Waiter sign-in</b></div></div>` : ""}`;
    return `<section><div class="label" style="margin-top:0">Waiter sign-in link</div>
      <p class="note" style="margin-top:0">Send this to each waiter, on WhatsApp for example. They open it once on their own phone, then sign in with their name and PIN at the start of every shift.</p>
      ${wl}
      <p class="note">Share it with staff only. The link alone can't take tables (that needs a waiter's PIN), but it does open staff screens. If it reaches the wrong person, tap <b>Make new staff codes</b> on Tables &amp; QR; every staff phone then needs the new link.</p>
      <div class="label">Waiters</div>
      <p class="note" style="margin-top:0">These names appear on the waiter phones${owner ? " and the dashboard" : ""}.</p>
      ${S.pins == null ? (loadPins(), "") : ""}
      <div class="grid" style="max-width:640px">${WAITERS.map((w, i) => `<div class="wrow"><div class="vrow"><input class="field" id="wn-${i}" data-f="wname" data-i="${i}" value="${esc(w.name)}" aria-label="Waiter name">
        ${S.armed === "w" + i ? `<button class="btn danger" data-delw="${i}">Tap again</button>`
          : `<button class="iconbtn brandbtn" data-delw="${i}" aria-label="Remove ${esc(w.name)}" title="Remove"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>`}</div>
        <form class="vrow pinset" data-wid="${esc(w.id)}"><span class="pill ${(S.pins || {})[w.id] ? "s-ready" : "s-new"}">${S.pins == null ? "…" : (S.pins || {})[w.id] ? "PIN set" : "No PIN yet"}</span>
          <input class="field num" id="wp-${i}" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="${(S.pins || {})[w.id] ? "New PIN" : "4-digit PIN"}" aria-label="PIN for ${esc(w.name)}">
          <button class="btn">${(S.pins || {})[w.id] ? "Change" : "Set PIN"}</button></form></div>`).join("")}</div>
      <p class="note">Each waiter starts a shift on their own phone with their name and PIN. Tell them their PIN in person. Changing a PIN ends that waiter's current shift.</p>
      <form id="addw" class="vrow" style="max-width:520px;margin-top:10px"><input class="field" id="addwin" maxlength="20" placeholder="New waiter's name" aria-label="New waiter's name"><button class="btn primary">Add</button></form>
      ${S.wErr ? `<p class="err" role="alert">${esc(S.wErr)}</p>` : ""}
      ${owner ? `<div class="label">Owner and managers</div>
      <p class="note" style="margin-top:0">They sign in with Google. Managers can edit the menu and staff and open Setup; the owner also sees the dashboard and look, and adds or removes managers.</p>
      ${S.admins == null ? (loadAdmins(), skRows(2)) : `<div class="grid" style="max-width:520px">${S.admins.map((a) => `<div class="vrow"><span class="field" style="overflow:hidden;text-overflow:ellipsis">${esc(a.email)}${a.email === myEmail ? " (you)" : ""}</span>
        <span class="pill ${a.role === "owner" ? "s-ready" : "s-preparing"}">${a.role === "owner" ? "Owner" : "Manager"}</span>
        ${a.email === myEmail || a.role === "owner" ? "" : `<button class="btn danger" data-deladmin="${esc(a.email)}">${S.armed === "a" + a.email ? "Tap again" : "Remove"}</button>`}</div>`).join("")}</div>`}
      <form id="addadmin" class="vrow" style="max-width:520px;margin-top:10px"><input class="field" id="adminemail" type="email" autocomplete="off" placeholder="New manager's Google email" aria-label="New manager's Google email">
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
    // No "All time" for now: it downloaded every order ever placed, which gets slow and costly as history grows.
    // Longer ranges come back with daily summaries (see docs/security/Security Checklist.md → scaling).
    const periods = [["today", "Today"], ["7", "7 days"], ["30", "30 days"]];
    const head = `<div class="periods">${periods.map(([k, l]) => `<button class="chip" aria-pressed="${S.period === k}" data-period="${k}">${l}</button>`).join("")}
      <button class="btn ghost small hide-phone" data-act="reload">${S.loading ? "Loading…" : "Refresh"}</button></div>`;
    if (!S.m) { if (!S.loading && !S.err) load(); return head + (S.err ? errorBox(S.err) : skKpis()); }
    const m = S.m;
    const sampleNote = m.sample ? `<div class="soundbar" style="margin-top:12px"><span>Includes <b>sample data</b> for demonstration, not real sales.</span><button class="btn" data-act="unsample">${S.busy === "unsample" ? "Removing…" : "Remove sample data"}</button></div>` : "";
    if (!m.items) return head + `<section><p class="empty">No orders in this period yet.<br>Numbers appear here as soon as diners order.</p></section>`;
    const kpi = (v, l, sub) => `<div class="kpi"><div class="kv num">${v}</div><div class="kl">${l}</div>${sub ? `<div class="note" style="margin:2px 0 0">${sub}</div>` : ""}</div>`;
    const hours = m.byHour.filter((h) => h.items); const h0 = hours.length ? hours[0].h : 12, h1 = hours.length ? hours.at(-1).h : 22;
    const hourRows = m.byHour.filter((h) => h.h >= h0 && h.h <= h1);
    const peak = hours.length ? hours.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null;
    return head + sampleNote + `<section>
      <div class="kpis">${kpi(fmt(m.revenue), "Sales · TSh", `${fmt(m.items)} items · ${fmt(m.orders)} orders`)}${kpi(fmt(m.tables), "Tables", `${fmt(m.guests)} guests`)}
        ${kpi(m.avgBill ? fmt(Math.round(m.avgBill / 100) * 100) : "–", "Average bill", "per closed table")}${kpi(m.avgPerGuest ? fmt(Math.round(m.avgPerGuest / 100) * 100) : "–", "Spend per guest", "")}
        ${kpi(dur(m.toTable), "Order to table", "typical item")}${kpi(dur(m.tableTime), "Table stay", "typical visit")}</div>

      <div class="label">Speed</div>
      <div class="tablewrap"><table><thead><tr><th>Step</th><th>Typical</th><th>Slowest 10%</th><th class="opt">Count</th></tr></thead><tbody>
        ${STN.map(([k, v]) => `<tr><td>${v} prep (order → ready)</td><td class="num">${dur(m.prep[k].median)}</td><td class="num">${dur(m.prep[k].p90)}</td><td class="num opt">${fmt(m.prep[k].items)}</td></tr>`).join("")}
        <tr><td>Waiter pickup (ready → served)</td><td class="num">${dur(m.serve)}</td><td></td><td class="opt"></td></tr>
        <tr><td>Order to table, all items</td><td class="num">${dur(m.toTable)}</td><td class="num">${dur(m.toTableP90)}</td><td class="opt"></td></tr>
        <tr><td>Response to "Call waiter"</td><td class="num">${dur(m.callResp)}</td><td></td><td class="opt"></td></tr>
        <tr><td>Response to "Bill please"</td><td class="num">${dur(m.billResp)}</td><td></td><td class="opt"></td></tr>
      </tbody></table></div>
      ${m.unanswered ? `<p class="note">${m.unanswered} alert${m.unanswered > 1 ? "s" : ""} never got an "On my way".</p>` : ""}

      <div class="label">Waiters</div>
      ${m.waiters.length ? `<div class="tablewrap"><table><thead><tr><th>Waiter</th><th>Tables</th><th>Sales (TSh)</th><th>Call response</th><th class="opt">Bill response</th><th class="opt">Pickup</th></tr></thead><tbody>
        ${m.waiters.map((w) => `<tr><td>${esc(w.name)}</td><td class="num">${fmt(w.tables)}</td><td class="num">${fmt(w.sales)}</td><td class="num">${dur(w.callResp)}</td><td class="num opt">${dur(w.billResp)}</td><td class="num opt">${dur(w.serve)}</td></tr>`).join("")}
      </tbody></table></div><p class="note">Times are typical (median). Pickup is how long finished items wait before the waiter serves them.</p>` : `<p class="note">No waiter activity yet.</p>`}

      <div class="label">Sales by hour${peak ? ` · busiest ${String(peak.h).padStart(2, "0")}:00` : ""}</div>
      ${bars(hourRows, "revenue", (r) => String(r.h).padStart(2, "0"))}
      ${m.byDay.length > 1 ? `<div class="label">Sales by day</div>${bars(m.byDay, "revenue", (r) => { const d = new Date(r.day + "T12:00"); return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + d.getDate(); })}` : ""}

      <div class="label">Best sellers</div>
      <div class="tablewrap"><table><thead><tr><th>Item</th><th style="text-align:left" class="opt">Station</th><th>Sold</th><th>Sales (TSh)</th></tr></thead><tbody>
        ${m.best.slice(0, 10).map((b) => `<tr><td>${esc(b.n)}</td><td class="opt">${esc(STATIONS[b.st] || "")}</td><td class="num">${fmt(b.qty)}</td><td class="num">${fmt(b.revenue)}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="note">Updated ${S.loaded ? ago(S.loaded) : ""}. <button class="linkbtn" data-act="reload">Refresh</button></p></section>`;
  }

  // ----- events -----
  function at(d) { const sec = MENU[+d.si], it = sec && d.ii != null ? sec.items[+d.ii] : null; return { sec, it }; }
  document.addEventListener("change", async (e) => {
    if (e.target.id !== "mup" || !e.target.files || !e.target.files[0]) return;
    const f = e.target.files[0]; e.target.value = "";
    S.busy = "mup"; render();
    try { const rows = await readFile(f); S.imp = rowsToMenu(rows, STATIONS); }
    catch { S.imp = { error: "Couldn't read that file. Save it as CSV or Excel (.xlsx) and try again." }; }
    S.busy = ""; render();
  });
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
    else if (d.f === "wname") { if (!v) return render();
      // Two waiters with one name can't be told apart on the sign-in screen, the tables or the dashboard.
      if (takenName(v, +d.i)) { S.wErr = `There's already a waiter called ${takenName(v, +d.i).name}. Add a surname or initial, e.g. "${v} M."`; toast("Same name already exists"); return render(); }
      S.wErr = ""; WAITERS = WAITERS.map((w, i) => (i === +d.i ? { ...w, name: v } : w)); }
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
    if (e.target.id === "addw") { const n = $("#addwin").value.trim(); if (!n) return;
      if (takenName(n)) { S.wErr = `There's already a waiter called ${takenName(n).name}. Add a surname or initial, e.g. "${n} M."`; toast("Same name already exists"); render(); const i = $("#addwin"); if (i) { i.value = n; i.focus(); i.select(); } return; }
      S.wErr = ""; WAITERS = [...WAITERS, { id: uid("w"), name: n }]; save(`${n} added`); $("#addwin").value = ""; render(); }
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
    if (d.act === "mdl") {
      const url = URL.createObjectURL(new Blob([menuToCsv(MENU, STATIONS)], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = `${RID || "menu"}-menu.csv`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000); toast("Template downloaded"); return; }
    if (d.act === "impcancel") { S.imp = null; render(); return; }
    if ((d.act === "impreplace" || d.act === "impadd") && S.imp && S.imp.menu) {
      if (d.act === "impreplace" && S.armed !== "impr") return arm("impr");
      const n = S.imp.items; MENU = mergeMenu(MENU, S.imp.menu, d.act === "impreplace" ? "replace" : "add");
      S.imp = null; S.armed = null; S.edit = null; render(); await save(`${n} items imported`); return; }
    if (d.act === "wlqr") { S.wqr = !S.wqr; render(); return; }
    if (d.act === "wlcopy" || d.act === "wlshare") {
      if (!S.wtok) return; const link = waiterLink();
      if (d.act === "wlshare" && navigator.share) { try { await navigator.share({ title: `Waiter sign-in · ${rname()}`, text: `Your waiter sign-in link for ${rname()}. Open it on your phone, then sign in with your name and PIN:`, url: link }); } catch {} return; }
      try { await navigator.clipboard.writeText(link); toast("Link copied. Paste it in WhatsApp."); }
      catch { const i = $("#wlinkin"); if (i) { i.focus(); i.select(); } toast("Select the link and copy it."); }
      return; }
    if (d.otab) { if (!TABS.some(([k]) => k === d.otab)) return; S.tab = d.otab; S.edit = null; if (S.tab === "dash") S.m = null; if (S.tab === "live") watchOpen(); render(); }
    else if (d.out) { const [si, ii] = ix(d.out), it = MENU[si].items[ii], want = !it.out, msg = want ? `${it.n} marked sold out` : `${it.n} back on the menu`;
      // Only the small sold-out list changes. An old sold-out flag saved inside the menu is cleared with one full save.
      const clearOld = !want && it.oldOut; it.oldOut = clearOld ? false : !!it.oldOut;
      if (want) STOCK_OUT.add(it.n); else STOCK_OUT.delete(it.n); applyStock(); render();
      try { await setDoc(stockRef(), { out: { [it.n]: want ? true : deleteField() }, t: Date.now() }, { merge: true });
        if (clearOld) await saveConfig(); toast(msg); } catch (err) { fail(err); } }
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
    else if (d.act === "rmlogo") { const old = BRAND.logo; BRAND = { ...BRAND, logo: "" }; applyBrand(); render(); await save("Logo removed"); if (old && !isFileLogo(old)) deleteDoc(rdoc("photos", old)).catch(() => {}); }
    else if (d.rmphoto) { const [si, ii] = ix(d.rmphoto), it = MENU[si].items[ii], old = it.img; delete it.img; render(); await save("Photo removed"); deleteDoc(rdoc("photos", old)).catch(() => {}); }
    else if (d.period) { S.period = d.period === "all" ? "30" : d.period; S.m = null; S.err = null; render(); }
    else if (d.act === "reload") { S.m = null; S.err = null; render(); }
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

// ================= COMPANY (the Wasabi business) =================
// For the company running the platform: approve restaurants, record payments, pause, change owners.
const slug = (n) => { const x = String(n).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30); return x.length >= 3 ? x : (x || "restaurant") + "-place"; };
const addMonths = (t, m) => { const d = new Date(t); d.setMonth(d.getMonth() + m); return d.getTime(); };
// Wasabi's own pages wear Wasabi's look: the logo in the header, green buttons, Bricolage headings.
function wasabiPage() {
  document.body.classList.add("wasabi");
  const h = $("#brandname"), lg = $("#brandlogo");
  if (lg) lg.hidden = true;
  if (h) { h.innerHTML = wasabiLockup(); h.setAttribute("aria-label", "Wasabi"); }
  if (!document.getElementById("wasabifont")) { const l = document.createElement("link"); l.id = "wasabifont"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&display=swap"; document.head.appendChild(l); }
}
const poweredBy = () => `<p class="poweredby">${wasabiLeaf()}<span>Ordered with Wasabi</span></p>`;
function companyScreen() {
  $("#wrap").classList.add("wide"); $("#sub").textContent = "Company"; document.title = "Company · " + COMPANY.name;
  wasabiPage();
  const C = { u: null, ok: false, claimed: true, list: [], team: [], filter: "all", busy: "", err: "", armed: null, edit: null };
  async function check() {
    paint(skPage());
    C.u = await authReady(); C.ok = await isCompanyUser(C.u);
    if (!C.ok) { try { C.claimed = (await getDoc(doc(db, "meta", "company"))).exists(); } catch { C.claimed = true; } return render(); }
    // The public "company claimed" marker used to hold the claimer's email: keep only that it's claimed.
    getDoc(doc(db, "meta", "company")).then((m) => { if (m.exists() && "by" in m.data()) return setDoc(doc(db, "meta", "company"), { claimed: true, t: Date.now() }); }).catch(() => {});
    await load();
  }
  async function load() {
    try {
      const [list, team] = await Promise.all([getDocs(collection(db, "accounts")), getDocs(collection(db, "company"))]);
      C.list = list.docs.map((d) => ({ rid: d.id, ...d.data() }));
      C.team = team.docs.map((d) => ({ email: d.id, ...d.data() }));
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
        <a class="btn ghost" href="${BASE}?r=${esc(a.rid)}#owner">Open</a>
        <a class="btn ghost" href="${BASE}demo/">Live demo</a></div>
      ${C.edit === a.rid ? `<form class="vrow ownform" data-rid="${a.rid}" style="margin-top:8px"><input class="field" type="email" id="own-${a.rid}" placeholder="New owner's Google email" aria-label="New owner's Google email" value="${esc(a.ownerEmail)}"><button class="btn primary">Save owner</button></form>
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
          : signedIn ? `<button class="btn" data-act="co-out">Use a different Google account</button>` : `<button class="btn primary big" data-act="co-in">Sign in with Google</button>${termsBox()}`}
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
      <form id="coadd" class="grid" style="max-width:520px"><input class="field" id="coname" placeholder="Restaurant name" aria-label="Restaurant name" maxlength="60">
        <input class="field" id="coemail" type="email" placeholder="Owner's Google email" aria-label="Owner's Google email">
        <div class="vrow"><label class="note" for="codays" style="margin:0">Free trial days</label><input class="field num" id="codays" inputmode="numeric" value="30"></div>
        <button class="btn primary">Add and switch on</button></form>
      <div class="label">Company team</div>
      <div class="grid" style="max-width:520px">${C.team.map((t) => `<div class="vrow"><span class="field">${esc(t.email)}${t.email === C.u.email ? " (you)" : ""}</span>${t.email === C.u.email ? "" : `<button class="btn danger" data-deltm="${esc(t.email)}">${C.armed === "tm" + t.email ? "Tap again" : "Remove"}</button>`}</div>`).join("")}</div>
      <form id="coteam" class="vrow" style="max-width:520px;margin-top:10px"><input class="field" id="cotm" type="email" placeholder="Partner's Google email" aria-label="Partner's Google email"><button class="btn">Add</button></form>
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
        if (!u) agree();
        try { if (!u) { u = (await googleSignIn()).user; recordTerms(u, "company page sign-in"); } } catch (err) { C.err = authMessage(err); C.busy = ""; return render(); }
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
  wasabiPage();
  const U = { u: null, mine: [], busy: false, err: "", done: null, form: false };
  async function check() {
    paint(skPage());
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
      <button class="btn primary big" data-act="su-in" ${U.busy ? "disabled" : ""}>${U.busy ? "Signing in…" : "Sign in with Google"}</button>${termsBox()}${err}</section>`);
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
    if (a === "su-in" && !U.busy) { agree();
      U.busy = true; U.err = ""; render(); try { recordTerms((await googleSignIn()).user, "restaurant sign-up"); } catch (err) { U.err = authMessage(err); } U.busy = false; check(); }
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
// Sign in (#account): one place for everyone. Diners sign in with Google or their phone number;
// owners and managers with the Google account on their restaurant. After signing in, anyone who runs a
// restaurant (or is on the Wasabi team) chooses how to continue: as a guest, or as owner/manager.
function accountScreen() {
  wasabiPage();
  const S = { user: null, profile: null, visits: [], loading: true, armed: false, err: "",
    step: "", phone: "", phoneFull: "", busy: false, authErr: "", roles: [], co: false, guest: false };
  const guestKey = () => "wasabi-guest-" + (S.user ? S.user.uid : "");
  const CHOOSE = params.get("choose") === "1";
  if (CHOOSE) history.replaceState(null, "", `${BASE}#account`);
  onUser(async (u) => {
    if (u && !isAccount(u)) u = null;   // the quiet sign-in every phone has isn't an account
    S.user = u || null; S.profile = null; S.loading = !!u; S.step = ""; S.busy = false; S.roles = []; S.co = false; S.guest = false; S.real = false;
    if (u) {
      // Arriving from an owner or company page's back arrow (?choose=1): show the choices, not the guest view.
      try { if (CHOOSE) sessionStorage.removeItem(guestKey()); S.guest = sessionStorage.getItem(guestKey()) === "1"; } catch {}
      // Show what this phone knew last time straight away (where this account can go), then check.
      const memo = "wasabi-acct-" + u.uid;
      // Only with the first name remembered too: otherwise the "What's your first name?" page would flash up
      // for a moment before the saved name arrives. Without it, the skeleton stays until everything is in.
      try { const c = JSON.parse(localStorage.getItem(memo) || "null"); if (c && c.name && ((c.roles || []).length || c.co) && !S.guest) { S.roles = c.roles || []; S.co = !!c.co; S.profile = { ...(S.profile || {}), name: c.name }; S.loading = false; } } catch {}
      render();
      // Everything at once: profile, visits, restaurants run and company membership.
      const [p, visits, roles, co] = await Promise.all([
        getDoc(dinerRef(u.uid)).catch(() => null), myVisits(u.uid).catch(() => null),
        u.email ? myRestaurants(u).catch(() => []) : [], u.email ? isCompanyUser(u).catch(() => false) : false]);
      if (S.user !== u) return;   // signed out or switched while loading
      S.profile = p && p.exists() ? p.data() : null; S.visits = visits || []; S.real = !!p;
      S.err = visits ? "" : "Couldn't load your visits. Check your connection.";
      S.roles = roles; S.co = co;
      try { localStorage.setItem(memo, JSON.stringify({ roles: roles.map(({ rid, name, role }) => ({ rid, name, role })), co, name: (S.profile && S.profile.name) || "" })); } catch {}
    }
    S.loading = false; render();
  });
  const back = () => { const t = store.get("dees-lasttable"); return t ? `<a class="btn" href="${esc(t)}">Back to your table</a>` : ""; };
  const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const runs = () => S.roles.length > 0 || S.co;
  function signInHtml() {
    const step = S.step === "phone" ? `<form id="acphone" class="grid"><label for="acphonein" style="font-weight:600">Your phone number</label>
          <input class="field" id="acphonein" type="tel" inputmode="tel" autocomplete="tel" placeholder="0748 227 000" value="${esc(S.phone)}">
          <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Sending…" : "Send code by SMS"}</button></form>
          <button class="btn ghost" data-act="ac-back" style="margin-top:10px">Back</button>`
      : S.step === "code" ? `<form id="acsms" class="grid"><label for="acsmsin">Enter the 6-digit code sent to <b>${esc(S.phoneFull)}</b></label>
          <input class="field num" id="acsmsin" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
          <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Checking…" : "Sign in"}</button></form>
          <button class="btn ghost" data-act="ac-phone" style="margin-top:10px">Use a different number</button>`
      : `<div class="grid"><button class="btn primary big" data-act="ac-google" ${S.busy ? "disabled" : ""}>${S.busy ? "Signing in…" : "Continue with Google"}</button>
          <button class="btn big" data-act="ac-phone">Continue with phone number</button></div>${termsBox()}
          <p class="note">Restaurant owners and managers: use the Google account registered for your restaurant.</p>`;
    return `<section class="wsign"><div class="wsign-card"><div class="wsign-head"><div class="wsign-rname">Sign in</div>
        <div class="wsign-title">For diners, restaurant owners and managers</div></div>
      <div class="wsign-step">${step}${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}</div></div>
      <p class="note wsign-foot">Diners don't need to sign in to order. Signing in keeps your visits and offers in one place. <a href="terms.html">Terms</a> · <a href="privacy.html">Privacy policy</a></p>
      <div style="text-align:center;margin-top:12px">${back()}</div></section>`;
  }
  function termsGateHtml() {
    return `<section class="wsign"><div class="wsign-card"><div class="wsign-head"><div class="wsign-rname">Before you continue</div>
        <div class="wsign-title">${S.profile && S.profile.terms ? "We've updated our Terms" : "Please agree to our Terms"}</div></div>
      <div class="wsign-step"><button class="btn primary big" data-act="ac-terms" style="width:100%">Continue</button>${termsBox()}
        ${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}</div></div>
      <p class="note wsign-foot">Signed in as ${esc(S.user.email || S.user.phoneNumber || "")} · <button class="linkbtn" data-act="signout">Use a different account</button></p></section>`;
  }
  function nameHtml() {
    const guess = (S.user.displayName || "").trim().split(/\s+/)[0] || "";
    return `<section class="wsign"><div class="wsign-card"><div class="wsign-head"><div class="wsign-rname">Welcome</div>
        <div class="wsign-title">What's your first name?</div></div>
      <div class="wsign-step"><form id="acname" class="grid"><label class="flabel" for="acnamein">Your first name <span>Waiters and your friends at the table see this</span></label>
        <input class="field" id="acnamein" maxlength="16" autocomplete="given-name" placeholder="First name" value="${esc(guess)}">
        <button class="btn primary big" ${S.busy ? "disabled" : ""}>${S.busy ? "Saving…" : "Continue"}</button></form>
        ${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}</div></div>
      <p class="note wsign-foot">Signed in as ${esc(S.user.email || S.user.phoneNumber || "")} · <button class="linkbtn" data-act="signout">Use a different account</button></p></section>`;
  }
  function chooserHtml(who) {
    const state = (m) => { if (!m.acct) return ""; const k = subState(m.acct).kind;
      return k === "pending" ? " · waiting for approval" : k === "suspended" ? " · paused" : k === "expired" ? " · subscription ended" : ""; };
    const ini = (n) => esc((String(n || "?").trim()[0] || "?").toUpperCase());
    return `<section><div class="label" style="margin-top:0">How do you want to continue?</div>
      <p style="margin-top:0">Signed in as <b>${esc(who)}</b></p>
      <div class="picks">
        <button class="pick" data-act="ac-guest"><span class="avatar"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span>
          <span><b>As a guest</b><span class="note">Your visits at every restaurant, and offers</span></span></button>
        ${S.roles.map((m) => `<a class="pick" href="${BASE}?r=${encodeURIComponent(m.rid)}#${m.role === "manager" ? "manager" : "owner"}"><span class="avatar">${ini(m.name)}</span>
          <span><b>${esc(m.name)}</b><span class="note">${m.role === "owner" ? "Owner" : "Manager"}${state(m)}</span></span></a>`).join("")}
        ${S.co ? `<a class="pick" href="${BASE}#company"><span class="avatar">${wasabiLeaf("wleaf", "#4a6716")}</span>
          <span><b>${esc(COMPANY.name)} company page</b><span class="note">Restaurants, approvals and payments</span></span></a>
        <a class="pick" href="${BASE}demo/"><span class="avatar"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20v.01M17 20h4v-3"/></svg></span>
          <span><b>Launch a live demo</b><span class="note">One QR code for the room; everyone picks a role</span></span></a>` : ""}
      </div>
      <button class="btn" data-act="signout" style="margin-top:18px">Use a different account</button></section>`;
  }
  function render() {
    $("#sub").textContent = S.user && !(runs() && !S.guest) ? "My account" : "Sign in";
    document.title = $("#sub").textContent + " · " + COMPANY.name;
    if (S.loading) return paint(skCards(2));
    if (!S.user) return paint(signInHtml());
    if (S.real && !termsOk(S.profile)) {
      // Ticked before signing in: record it now, quietly. Otherwise ask once (new or changed terms).
      if (termsTicked() && !S.termsSaving) { S.termsSaving = true; const u = S.user, b = writeBatch(db), t = logTerms(b, u, S.profile, "sign-in");
        b.commit().then(() => { if (S.user === u) S.profile = { ...(S.profile || {}), terms: t }; }, (err) => { S.authErr = authMessage(err); })
          .finally(() => { S.termsSaving = false; render(); }); }
      if (S.termsSaving) return paint(skCards(2));
      if (!termsTicked()) return paint(termsGateHtml());
    }
    // First sign-in: ask everyone for their first name once, before anything else.
    if (!(S.profile && S.profile.name)) return paint(nameHtml());
    if (runs() && !S.guest) return paint(chooserHtml(S.user.email || S.user.phoneNumber || ""));
    const by = {}; S.visits.forEach((v) => { (by[v.rid] ||= { name: v.rname, list: [] }).list.push(v); });
    const groups = Object.values(by).sort((a, b) => b.list[0].date - a.list[0].date);
    const who = S.user.phoneNumber || S.user.email || "";
    const also = [...S.roles.map((m) => m.name), ...(S.co ? [`the ${COMPANY.name} company page`] : [])];
    paint(`<section>
      ${runs() ? `<div class="soundbar" style="margin-bottom:14px"><span>You also run ${esc(also.join(", "))}.</span><button class="btn" data-act="ac-choose">Switch</button></div>` : ""}
      <div class="acct"><div class="avatar">${esc(((S.profile && S.profile.name) || "?").slice(0, 1).toUpperCase())}</div>
        ${S.editName ? `<form id="acname" class="vrow" style="flex:1;min-width:0"><input class="field" id="acnamein" maxlength="16" autocomplete="given-name" aria-label="Your first name" value="${esc(S.profile.name)}">
          <button class="btn primary" ${S.busy ? "disabled" : ""}>${S.busy ? "Saving…" : "Save"}</button><button type="button" class="btn ghost" data-act="ac-editname">Cancel</button></form>`
        : `<div style="min-width:0"><div class="row" style="gap:6px;flex-wrap:nowrap"><b style="font-size:20px">${esc((S.profile && S.profile.name) || "Diner")}</b>
          <button class="iconbtn dull" data-act="ac-editname" aria-label="Edit your name" title="Edit your name"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></div><div class="note" style="margin:0">${esc(who)}</div></div>`}</div>
      ${S.editName ? `<p class="note">Waiters and your friends at the table see this name.</p>${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}` : ""}
      ${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}
      <button class="btn primary big scanbtn" data-scan style="margin-top:18px"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="4" height="4" rx=".5"/><rect x="13" y="7" width="4" height="4" rx=".5"/><rect x="7" y="13" width="4" height="4" rx=".5"/><path d="M14 14h3v3"/></svg>Scan table QR</button>
      <p class="note" style="text-align:center">At a bar, café or restaurant with Wasabi? Scan the card on your table to order.</p>
      <div class="label">Your visits</div>
      ${groups.length ? groups.map((g) => `<div class="ticket preparing" style="margin-bottom:12px">
          <header><b>${esc(g.name)}</b><span class="note" style="margin:0">${g.list.length} visit${g.list.length > 1 ? "s" : ""} · TSh ${fmt(g.list.reduce((a, v) => a + (v.share || 0), 0))}</span></header>
          ${g.list.map((v) => `<div class="oline"><span class="l">${day(v.date)} · Table ${v.table}<br><span class="note">${(v.items || []).map((i) => esc(i.n)).join(", ") || "Nothing ordered"}</span></span><span class="num">TSh ${fmt(v.share)}</span></div>`).join("")}
        </div>`).join("") : `<p class="note">No visits yet. They'll appear here after your table's bill is closed.</p>`}
      <div class="label">WhatsApp offers</div>
      ${(() => { const names = { ...((S.profile && S.profile.offerNames) || {}) }; Object.entries(by).forEach(([rid, g]) => (names[rid] ||= g.name));
        const rids = Object.keys(names); if (!S.user.phoneNumber) return `<p class="note" style="margin-top:0">Offers come by WhatsApp, so they need a phone sign-in.</p>`;
        return rids.length ? `<div class="grid">${rids.map((rid) => `<label class="optin"><input type="checkbox" data-offers="${esc(rid)}" data-name="${esc(names[rid])}" ${offersOn(S.profile, rid) ? "checked" : ""}> <span>${esc(offersText(names[rid]))}</span></label>`).join("")}</div>
          <p class="note">Each restaurant can only message you if its box is ticked. Every change is saved with the date.</p>` : `<p class="note" style="margin-top:0">Restaurants you visit will appear here. You choose for each one.</p>`; })()}
      <div class="label">Settings</div>
      <div class="grid" style="margin-top:20px">${back()}
        <button class="btn" data-act="signout">Log out</button>
        <button class="btn danger" data-act="delete">${S.armed ? "Tap again to delete everything" : "Delete my account and data"}</button></div>
      <p class="note">Each restaurant only sees your visits to it, never your visits elsewhere.</p></section>`);
  }
  document.addEventListener("change", async (e) => {
    const rid = e.target.dataset && e.target.dataset.offers; if (!rid || !S.user) return;
    const on = e.target.checked, name = e.target.dataset.name;
    try {
      const b = writeBatch(db), offers = { ...(typeof (S.profile || {}).offers === "object" ? S.profile.offers : {}), [rid]: on }, offerNames = { ...((S.profile || {}).offerNames || {}), [rid]: name };
      if (S.profile) b.update(dinerRef(S.user.uid), { offers, offerNames }); else b.set(dinerRef(S.user.uid), { offers, offerNames, phone: S.user.phoneNumber || null, created: Date.now() });
      logConsent(b, S.user, rid, name, on, "My account");
      await b.commit(); S.profile = { ...(S.profile || {}), offers, offerNames }; toast(on ? `You'll get ${name}'s offers` : `No more offers from ${name}`);
    } catch (err) { e.target.checked = !on; fail(err); }
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id === "acname") { e.preventDefault(); if (!S.user || S.busy) return;
      const name = $("#acnamein").value.trim(); if (!name) { S.authErr = "Enter your first name."; return render(); }
      S.busy = true; S.authErr = ""; render();
      try {
        // Never wait forever: if the database doesn't answer in 12 seconds, say so instead of "Saving…".
        const write = S.profile ? updateDoc(dinerRef(S.user.uid), { name })
          : setDoc(dinerRef(S.user.uid), { name, phone: S.user.phoneNumber || null, email: S.user.email || null, offers: {}, offerNames: {}, created: Date.now() });
        await Promise.race([write, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error("timeout"), { code: "timeout" })), 12000))]);
        const was = S.editName; S.profile = { ...(S.profile || {}), name }; S.editName = false; toast(was ? "Name saved" : `Hi ${name}`);
      } catch (err) {
        console.error("Saving name failed", err);
        S.authErr = err && err.code === "timeout" ? "The database isn't answering, so your name wasn't saved yet. Check your connection and try again."
          : denied(err) ? "This account isn't allowed to save a name here. Try signing out and in again." : "Couldn't save your name. Check your connection and try again.";
      }
      S.busy = false; render(); return; }
    if (e.target.id === "acphone") { e.preventDefault();
      S.phone = $("#acphonein").value; const full = normalisePhone(S.phone);
      if (!full) { S.authErr = "That doesn't look like a phone number. Try 0748 227 000."; return render(); }
      S.phoneFull = full; S.busy = true; S.authErr = ""; render();
      try { await phoneStart(full); S.step = "code"; } catch (err) { S.authErr = authMessage(err); }
      S.busy = false; render(); }
    if (e.target.id === "acsms") { e.preventDefault();
      const code = $("#acsmsin").value.replace(/\D/g, ""); if (code.length !== 6) { S.authErr = "The code is 6 digits."; return render(); }
      S.busy = true; S.authErr = ""; render();
      try { await phoneConfirm(code); } catch (err) { S.authErr = authMessage(err); S.busy = false; render(); } }
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.act === "ac-google" || d.act === "ac-phone") agree();
    if (d.act === "ac-google" && !S.busy) { S.busy = true; S.authErr = ""; render(); try { await googleSignIn(); } catch (err) { S.authErr = authMessage(err); S.busy = false; render(); } return; }
    if (d.act === "ac-terms") { agree(); render(); return; }
    if (d.act === "ac-phone") { S.step = "phone"; S.authErr = ""; render(); const i = $("#acphonein"); if (i) i.focus(); return; }
    if (d.act === "ac-editname") { S.editName = !S.editName; S.authErr = ""; render(); if (S.editName) { const i = $("#acnamein"); if (i) { i.focus(); i.select(); } } return; }
    if (d.act === "ac-back") { S.step = ""; S.authErr = ""; render(); return; }
    if (!S.user) return;
    if (d.act === "ac-guest") { S.guest = true; try { sessionStorage.setItem(guestKey(), "1"); } catch {} render(); return; }
    if (d.act === "ac-choose") { S.guest = false; try { sessionStorage.removeItem(guestKey()); } catch {} render(); return; }
    if (d.act === "signout") { try { await signOutUser(); } catch {} toast("Signed out"); }
    if (d.act === "delete") {
      if (!S.armed) { S.armed = true; render(); setTimeout(() => { S.armed = false; render(); }, 4000); return; }
      b.disabled = true; b.textContent = "Deleting…";
      try {
        const u = S.user.uid, batch = writeBatch(db);
        (await getDocs(query(visitsCol, where("uid", "==", u)))).docs.forEach((x) => batch.delete(x.ref));
        (await getDocs(collection(db, "diners", u, "consents"))).docs.forEach((x) => batch.delete(x.ref));
        batch.delete(dinerRef(u)); await batch.commit();
        await deleteMe(); toast("Your account and visits are deleted");
      } catch (err) { S.err = authMessage(err); }
      S.armed = false; render();
    }
  });
  render();
}

// ---------- skeletons: grey shapes where content is about to appear ----------
// Each is shaped like what it stands in for, so nothing jumps when the real content arrives. They pulse
// gently (still, for people who turn motion off). Screen readers hear "Loading…"; data-loading tells the
// start-up watchdog the screen is still waiting.
function SK(c = "", st = "") { return `<i class="sk ${c}"${st ? ` style="${st}"` : ""}></i>`; }
function skel(inner) { return `<div class="skel" data-loading aria-busy="true"><span class="sr">Loading…</span>${inner}</div>`; }
// Function declarations (not consts) so screens drawn before this point in the file can use them.
function skRep(n, f) { return Array.from({ length: n }, (_, i) => f(i)).join(""); }
// A diner's menu: category chips, then dishes with a photo and price buttons.
function skMenu() {
  return skel(`<div class="row" style="margin:6px 0 14px">${skRep(4, (i) => SK("pill", `width:${[64, 82, 58, 74][i]}px`))}</div>`
    + skRep(5, (i) => `<div class="item withph"><div class="itxt">${SK("t", `width:${[52, 38, 60, 45, 56][i]}%`)}${SK("", `width:${[80, 66, 74, 58, 70][i]}%`)}</div>
      <div class="ph">${SK("fill")}</div><div class="vars">${SK("btn")}${i % 2 ? SK("btn") : ""}</div></div>`));
}
// Order tickets (kitchen, bar, waiter tables).
function skTickets(n = 4) {
  return skel(`<section class="grid">${skRep(n, (i) => `<article class="ticket"><header>${SK("t", "width:40%")}${SK("", "width:44px")}</header>
    <div style="display:grid;gap:8px;margin:12px 0">${SK("", `width:${[70, 55, 64, 48][i % 4]}%`)}${SK("", `width:${[50, 62, 40, 58][i % 4]}%`)}</div>${SK("btn", "width:96px")}</article>`)}</section>`);
}
// A list of rows with a button at the end (staff, managers, links).
function skRows(n = 3) {
  return skel(`<div class="grid" style="max-width:520px">${skRep(n, (i) => `<div class="vrow">${SK("field", `width:${[78, 64, 72][i % 3]}%`)}${SK("btn", "width:72px")}</div>`)}</div>`);
}
// Dashboard: number tiles, then a chart and a list.
function skKpis() {
  return skel(`<div class="kpis">${skRep(4, () => `<div class="kpi">${SK("", "width:60%")}${SK("t", "width:70%;height:26px;margin-top:8px")}</div>`)}</div>
    <div class="ticket" style="margin-top:14px">${SK("fill", "height:160px")}</div>
    <div class="ticket" style="margin-top:10px;display:grid;gap:10px">${skRep(4, (i) => SK("", `width:${[72, 60, 66, 50][i]}%`))}</div>`);
}
// Cards with a title, a couple of lines and buttons (company list, account, sign-in checks).
function skCards(n = 3) {
  return skel(`<section class="grid">${skRep(n, (i) => `<article class="ticket"><header>${SK("t", `width:${[46, 38, 52][i % 3]}%`)}${SK("pill", "width:80px")}</header>
    ${SK("", "width:62%;margin-top:10px")}<div class="row" style="margin-top:12px">${SK("btn", "width:110px")}${SK("btn", "width:90px")}</div></article>`)}</section>`);
}
// Any page before we know exactly what it will show.
function skPage() {
  return skel(`<section style="display:grid;gap:12px">${SK("t", "width:45%")}${SK("", "width:85%")}${SK("", "width:70%")}${SK("btn", "width:100%;height:48px;margin-top:6px")}</section>`);
}
// A small grey bar inside a line of text.
function skInline(w = 60) { return `<i class="sk" style="display:inline-block;width:${w}px;vertical-align:middle" aria-label="Loading"></i>`; }

function errorBox(e) {
  return `<section><div class="err">${denied(e)
    ? "This phone doesn't have access to that. Diners: scan the QR code on your table. Staff: scan the staff code from the Setup page."
    : "Can't reach the database. Check your internet connection, then reload."}</div><p class="note">${esc(e && (e.code || e.message))}</p></section>`;
}
