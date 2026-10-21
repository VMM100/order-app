// Demo stage: shows several live app screens side by side on one iPad or laptop.
// Each frame is the real app, so everything syncs through the database exactly as on separate phones.
import { db } from "./firebase.js";
import { collection, doc, getDoc, getDocs, query, where, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { authReady, isAccount, googleSignIn } from "./account.js";

const TABLE = 8; // demo table, kept apart from tables used for manual testing
// Which restaurant to demo: from the link (?r=…, the Setup page links here with it).
const RID = new URLSearchParams(location.search).get("r") || (() => { try { return JSON.parse(localStorage.getItem("dees-rid")); } catch { return null; } })();
const BASE = location.origin + location.pathname.replace(/demo\.html$/, "");
let KEY = "";
const SCREENS = {
  d1: { label: "Diner: Amani", url: () => `?r=${RID}&t=${TABLE}&k=${KEY}&as=1&name=Amani` },
  d2: { label: "Diner: Neha", url: () => `?r=${RID}&t=${TABLE}&k=${KEY}&as=2&name=Neha` },
  waiter: { label: "Waiter", url: () => `?r=${RID}#waiter` },
  bar: { label: "Bar screen", url: () => `?r=${RID}#bar` },
  kitchen: { label: "Kitchen screen", url: () => `?r=${RID}#kitchen` },
  grill: { label: "Grill screen", url: () => `?r=${RID}#grill` },
  owner: { label: "Owner dashboard", url: () => `?r=${RID}#owner` },
  manager: { label: "Manager", url: () => `?r=${RID}#manager` },
};
const DEFAULTS = { 3: ["d1", "waiter", "bar"], 4: ["d1", "d2", "waiter", "bar"] };
const $ = (s) => document.querySelector(s);
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2200); }

let count = store.get("demo-count") || 4;
let picks = store.get("demo-picks") || {};
const pickFor = (i) => picks[count]?.[i] || DEFAULTS[count][i];

function build() {
  $("#phones").value = String(count);
  const stage = $("#stage"); stage.style.setProperty("--n", count); stage.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const key = pickFor(i), slot = document.createElement("div"); slot.className = "slot";
    slot.innerHTML = `<div class="slotbar"><select aria-label="Screen ${i + 1}">${Object.entries(SCREENS).map(([k, s]) => `<option value="${k}" ${k === key ? "selected" : ""}>${s.label}</option>`).join("")}</select><button class="btn reload" title="Reload this phone" aria-label="Reload this phone">↻</button></div>
      <div class="frameBox"><div class="phone"><iframe title="${SCREENS[key].label}" src="${BASE}${SCREENS[key].url()}" allow="autoplay; screen-wake-lock"></iframe></div></div>`;
    slot.querySelector(".reload").addEventListener("click", () => { const f = slot.querySelector("iframe"); f.src = f.src; });
    slot.querySelector("select").addEventListener("change", (e) => {
      picks[count] = Array.from({ length: count }, (_, j) => pickFor(j)); picks[count][i] = e.target.value; store.set("demo-picks", picks); build();
    });
    stage.appendChild(slot);
  }
  fit();
}

// Scale each 390×780 phone so all of them fit the screen without scrolling.
function fit() {
  document.querySelectorAll(".slot").forEach((slot) => {
    const box = slot.querySelector(".frameBox"), phone = slot.querySelector(".phone");
    const w = 410, h = 800, narrow = innerWidth <= 700;
    const k = narrow ? box.clientWidth / w : Math.min(box.clientWidth / w, box.clientHeight / h, 1.15);
    phone.style.transform = `scale(${Math.max(0.3, k)})`;
    if (narrow) box.style.height = h * k + "px"; else box.style.height = "";
    phone.style.marginBottom = `${-(1 - k) * h}px`;
  });
}
addEventListener("resize", () => requestAnimationFrame(fit));

$("#phones").addEventListener("change", (e) => { count = +e.target.value; store.set("demo-count", count); build(); });

// Reset only the demo table: its orders, alerts and guests. Dashboard history and other tables stay.
$("#reset").addEventListener("click", async (e) => {
  const b = e.target;
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to reset"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Reset demo table"; }, 4000); return; }
  b.disabled = true; b.textContent = "Resetting…";
  try {
    const batch = writeBatch(db);
    for (const name of ["lines", "alerts", "groups"]) {
      const s = await getDocs(query(collection(db, "restaurants", RID, name), where("table", "==", TABLE)));
      s.docs.forEach((d) => { if (!d.data().sample) batch.delete(d.ref); if (name === "groups" && d.data().code) batch.delete(doc(db, "restaurants", RID, "codes", d.data().code)); });
    }
    batch.set(doc(db, "restaurants", RID, "tables", String(TABLE)), { table: TABLE, current: null });
    await batch.commit();
    Object.keys(localStorage).filter((k) => k.startsWith(`dees-me-${RID}-${TABLE}`)).forEach((k) => localStorage.removeItem(k));
    toast("Demo table reset"); build();
  } catch (err) { console.error(err); toast("Couldn't reset. Check the connection."); }
  b.disabled = false; b.dataset.armed = ""; b.textContent = "Reset demo table";
});

// The demo table's secret key (made on first use), so the simulated diners and the QR can join it.
const keyChars = "abcdefghjkmnpqrstuvwxyz23456789";
async function demoKey() {
  const ref = doc(db, "restaurants", RID, "tablekeys", String(TABLE)); let k = "";
  await runTransaction(db, async (tx) => { const s = await tx.get(ref); k = s.exists() && s.data().k;
    if (!k) { k = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => keyChars[b % 31]).join(""); tx.set(ref, { k, t: Date.now() }); } });
  return k;
}
$("#tno").textContent = TABLE;
try { const b = store.get("dees-brand"); if (b && b.name) $("#title").textContent = `${b.name} · live demo`; } catch {}
// The demo stage runs the staff screens on this device, so it needs the owner's or a manager's
// Google sign-in. The simulated diners each get their own quiet sign-in inside their frame.
$("#stage").innerHTML = `<p style="color:var(--muted)">Connecting…</p>`;
async function begin() {
  if (!RID) { $("#stage").innerHTML = `<p style="color:var(--muted)">Open the demo from your restaurant's Setup page.</p>`; return; }
  const u = await authReady();
  // Owner (on the account), manager, or the company team.
  const has = (ref, f) => getDoc(ref).then((s) => s.exists() && (!f || f(s.data())), () => false);
  const role = isAccount(u) && u.email && ((await has(doc(db, "accounts", RID), (a) => a.ownerEmail === u.email)) || (await has(doc(db, "restaurants", RID, "admins", u.email))) || (await has(doc(db, "company", u.email))));
  if (!role) {
    $("#stage").innerHTML = `<div style="max-width:420px"><p>The demo stage shows staff screens, so it opens with the owner's or a manager's Google account.</p>
      <button class="btn primary" id="signin">Sign in with Google</button>${isAccount(u) ? `<p style="color:var(--muted)">${u.email || "This account"} isn't an owner or manager here.</p>` : ""}</div>`;
    $("#signin").addEventListener("click", async () => { try { await googleSignIn(); } catch (e) { console.error(e); } begin(); });
    return;
  }
  KEY = await demoKey();
  try { $("#qr").innerHTML = ""; new QRCode($("#qr"), { text: `${BASE}?r=${RID}&t=${TABLE}&k=${KEY}`, width: 128, height: 128, correctLevel: QRCode.CorrectLevel.M }); } catch {}
  build();
}
begin().catch((e) => { console.error(e); $("#stage").innerHTML = `<p style="color:var(--muted)">Can't reach the database. Check the internet connection, then reload.</p>`; });
