// Kitchen and bar printers on the screens: the owner's Printers section (Tables & QR page), and the
// printer strip on the bar, kitchen and grill screens (status, On/Off on the bar screen, Reprint).
// The printing itself is done by the print box at the restaurant (bridge/print-box.js).
import { db } from "./firebase.js";
import { collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, addDoc, query, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const col = (rid, name) => collection(db, "restaurants", rid, name);
const ref = (rid, name, id) => doc(db, "restaurants", rid, name, id);
const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
export const OFF_REASONS = ["Out of paper", "Printer broken", "Not needed now", "Other"];

// Printers and their status, live. cb({ printers, status }) on every change.
export function watchPrinters(rid, cb) {
  const P = { printers: [], status: {}, loaded: false };
  const offs = [
    onSnapshot(col(rid, "printers"), (s) => { P.printers = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name)); P.loaded = true; cb(P); }, () => { P.loaded = true; cb(P); }),
    onSnapshot(col(rid, "printstatus"), (s) => { P.status = {}; s.docs.forEach((d) => (P.status[d.id] = d.data())); cb(P); }, () => {}),
  ];
  return () => offs.forEach((f) => f());
}

// How a printer is doing, in words for the screens.
export function stateOf(p, st, now = Date.now()) {
  if (p.on === false) return { kind: "off", text: `Off since ${p.offAt ? hhmm(p.offAt) : "earlier"}${p.offReason ? ` · ${p.offReason}` : ""}${p.offBy ? ` (${p.offBy})` : ""}` };
  if (!st || now - st.t > 150e3) return { kind: "down", text: "Print box not connected: check it's plugged in and the internet is on" };
  if (!st.ok) return { kind: "down", text: "Not responding: check paper, power and cable" };
  return { kind: "ok", text: "Ready" };
}

const sw = (p, attrs) => `<button class="psw" type="button" role="switch" aria-checked="${p.on !== false}" aria-label="${p.name}: printer on" ${attrs}><span class="swtrack" aria-hidden="true"><span class="swthumb"></span></span><span>${p.on !== false ? "On" : "Off"}</span></button>`;

// The strip at the top of the bar, kitchen and grill screens: the printers serving that station.
// The bar screen shows every printer and can switch them; other screens only see their own.
export function stripHtml(P, { station, canSwitch, choosing, esc }) {
  const list = canSwitch ? P.printers : P.printers.filter((p) => (p.stations || []).includes(station));
  if (!list.length) return "";
  return `<div class="pstrip">${list.map((p) => { const s = stateOf(p, P.status[p.id]);
    return `<div class="prow ${s.kind}"><span class="pdot" aria-hidden="true"></span><span class="ptxt"><b>${esc(p.name)}</b><span>${esc(s.text)}</span></span>
      ${canSwitch ? sw(p, `data-pswitch="${esc(p.id)}"`) : ""}</div>
      ${choosing === p.id ? `<div class="preasons"><span class="note" style="margin:0">Why switch it off?</span><div class="row">${OFF_REASONS.map((r) => `<button class="chip lg" data-poff="${esc(p.id)}" data-reason="${esc(r)}">${esc(r)}</button>`).join("")}
        <button class="btn ghost small" data-pcancel="1">Cancel</button></div></div>` : ""}`; }).join("")}</div>`;
}

// Switch a printer off (with a reason) or on. Turning on asks about tickets that came in while it was
// off: print them, or don't. Every switch goes in the printer log.
export async function switchOff(rid, p, reason, by) {
  const t = Date.now();
  await updateDoc(ref(rid, "printers", p.id), { on: false, offAt: t, offBy: by, offReason: reason, updated: t });
  await addDoc(col(rid, "printlog"), { pid: p.id, ev: "off", by, reason, t });
}
export async function switchOn(rid, p, st, by) {
  const n = (st && st.waiting) || 0, t = Date.now();
  let catchUp = false;
  if (n) {
    const pick = await ask3(`${n} ticket${n > 1 ? "s" : ""} came in while ${p.name} was off`, `Print ${n > 1 ? "them" : "it"} now? They're also on the screen.`, "Print them", "Don't print", "Cancel");
    if (pick === "cancel") return false;
    catchUp = pick === "yes";
  }
  await updateDoc(ref(rid, "printers", p.id), catchUp ? { on: true, offAt: null, offBy: null, offReason: null, updated: t } : { on: true, offAt: null, offBy: null, offReason: null, since: t, updated: t });
  await addDoc(col(rid, "printlog"), { pid: p.id, ev: "on", by, t, n });
  if (n) await addDoc(col(rid, "printlog"), { pid: p.id, ev: catchUp ? "catchup" : "skipped", by, t, n });
  return true;
}

// Reprint one order on the printers serving that station (only those switched on).
export async function reprint(rid, P, batch, station, by) {
  const ps = P.printers.filter((p) => p.on !== false && (p.stations || []).includes(station));
  await Promise.all(ps.map((p) => addDoc(col(rid, "printq"), { batch, pid: p.id, kind: "reprint", t: Date.now(), by })));
  return ps.length;
}
export const canReprint = (P, station) => P.printers.some((p) => p.on !== false && (p.stations || []).includes(station));

// A three-way question (the app's own dialog only has two answers). Resolves "yes", "no" or "cancel".
function ask3(title, text, yes, no, cancel) {
  return new Promise((done) => {
    const d = document.createElement("div"); d.className = "ask";
    d.innerHTML = `<div class="ask-box" role="alertdialog" aria-modal="true" aria-labelledby="ask3-t"><h2 id="ask3-t"></h2><p></p>
      <div class="ask-acts" style="flex-wrap:wrap"><button type="button" class="btn big" data-v="cancel"></button><button type="button" class="btn big" data-v="no"></button><button type="button" class="btn primary big" data-v="yes"></button></div></div>`;
    d.querySelector("h2").textContent = title; d.querySelector("p").textContent = text;
    d.querySelector('[data-v="yes"]').textContent = yes; d.querySelector('[data-v="no"]').textContent = no; d.querySelector('[data-v="cancel"]').textContent = cancel;
    document.body.appendChild(d); d.querySelector('[data-v="yes"]').focus();
    const end = (v) => { d.remove(); removeEventListener("keydown", key); done(v); };
    const key = (e) => { if (e.key === "Escape") end("cancel"); };
    addEventListener("keydown", key);
    d.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) end(b.dataset.v); else if (e.target === d) end("cancel"); });
  });
}

// ----- Owner and manager: the Printers section -----
const IP = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;
export function settingsHtml(P, { stations, edit, logRows, esc, staffTok, rid, armed }) {
  const form = (p = { name: "", ip: "", port: 9100, width: 80, stations: [] }, id = "") => `<form class="grid pform" data-pid="${esc(id)}" style="max-width:560px;margin-top:10px">
      <div class="vrow"><label class="note" style="margin:0;flex:0 0 110px" for="pn-${esc(id)}">Name</label><input class="field" id="pn-${esc(id)}" maxlength="40" placeholder="e.g. Bar printer" value="${esc(p.name)}"></div>
      <div class="vrow"><label class="note" style="margin:0;flex:0 0 110px" for="pi-${esc(id)}">IP address</label><input class="field num" id="pi-${esc(id)}" inputmode="decimal" placeholder="e.g. 192.168.1.50" value="${esc(p.ip)}"></div>
      <div class="vrow"><label class="note" style="margin:0;flex:0 0 110px" for="pp-${esc(id)}">Port</label><input class="field num" id="pp-${esc(id)}" inputmode="numeric" value="${esc(String(p.port || 9100))}"></div>
      <div class="vrow"><label class="note" style="margin:0;flex:0 0 110px" for="pw-${esc(id)}">Paper</label><select class="field" id="pw-${esc(id)}"><option value="80"${p.width !== 58 ? " selected" : ""}>80 mm</option><option value="58"${p.width === 58 ? " selected" : ""}>58 mm</option></select></div>
      <fieldset class="pst"><legend class="note">Prints tickets for</legend>${Object.entries(stations).map(([k, v]) => `<label class="optin"><input type="checkbox" name="pst-${esc(id)}" value="${esc(k)}" ${(p.stations || []).includes(k) ? "checked" : ""}> <span>${esc(v)}</span></label>`).join("")}</fieldset>
      <div class="row"><button class="btn primary">${id ? "Save printer" : "Add printer"}</button>${id ? `<button type="button" class="btn ghost" data-pedit="">Cancel</button>` : ""}</div></form>`;
  const cfg = staffTok ? JSON.stringify({ restaurant: rid, staffCode: staffTok, name: "Print box" }) : "";
  return `<div class="label">Kitchen and bar printers</div>
    <p class="note" style="margin-top:0">A small always-on computer (the <b>print box</b>) plugged into the restaurant's router prints a ticket for every order, within seconds, on the printers below. The bar screen can switch printers off and on; every switch is logged.</p>
    ${P.printers.length ? `<div class="grid" style="max-width:640px">${P.printers.map((p) => { const s = stateOf(p, P.status[p.id]);
      return `<div class="ticket"><div class="prow ${s.kind}" style="border:0;padding:0"><span class="pdot" aria-hidden="true"></span><span class="ptxt"><b>${esc(p.name)}</b><span>${esc(s.text)}</span></span>${sw(p, `data-pswitch="${esc(p.id)}"`)}</div>
        <p class="note" style="margin:6px 0 0">${esc(p.ip)}:${esc(String(p.port || 9100))} · ${p.width === 58 ? "58" : "80"} mm · ${esc((p.stations || []).map((k) => stations[k] || k).join(", ") || "no stations")}</p>
        <div class="acts"><button class="btn" data-ptest="${esc(p.id)}" ${p.on === false ? "disabled" : ""}>Test print</button><button class="btn ghost" data-pedit="${esc(p.id)}">Edit</button>
          <button class="btn ghost danger" data-pdel="${esc(p.id)}">${armed === "pdel" + p.id ? "Tap again to remove" : "Remove"}</button></div>
        ${edit === p.id ? form(p, p.id) : ""}</div>`; }).join("")}</div>` : `<p class="note">No printers yet.</p>`}
    ${edit === "new" ? form() : `<button class="btn" data-pedit="new" style="margin-top:10px">+ Add a printer</button>`}
    ${P.printers.length ? `<details class="pbox" style="margin-top:14px;max-width:640px"><summary>Print box settings</summary>
      <p class="note">Put this in the print box's <code>config.json</code> (see the set-up guide). It holds the staff code: keep it private. Making new staff codes means updating the print box too.</p>
      ${cfg ? `<pre class="pcfg">${esc(cfg)}</pre><button class="btn small" data-pcopy="1">Copy settings</button>` : `<p class="note">Loading…</p>`}</details>` : ""}
    <div class="label">Printer log</div>
    ${logRows == null ? `<p class="note">Loading…</p>` : logRows.length ? `<div class="tablewrap" style="max-width:640px"><table><thead><tr><th style="text-align:left">When</th><th style="text-align:left">Printer</th><th style="text-align:left">What</th><th style="text-align:left" class="opt">By</th></tr></thead><tbody>
      ${logRows.map((r) => `<tr><td style="text-align:left">${esc(new Date(r.t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</td><td style="text-align:left">${esc((P.printers.find((p) => p.id === r.pid) || {}).name || r.pid)}</td><td style="text-align:left">${esc(EV[r.ev] ? EV[r.ev](r) : r.ev)}</td><td style="text-align:left" class="opt">${esc(r.by || "")}</td></tr>`).join("")}
    </tbody></table></div><button class="btn small" data-plogcsv="1" style="margin-top:8px">Download the full log</button>` : `<p class="note">Nothing yet.</p>`}`;
}
const EV = { on: () => "Switched on", off: (r) => `Switched off${r.reason ? `: ${r.reason}` : ""}`, offline: (r) => `Stopped responding${r.reason ? ` (${r.reason})` : ""}`, online: () => "Responding again",
  reprint: () => "Reprinted a ticket", test: () => "Test print", catchup: (r) => `Printed ${r.n || ""} missed ticket${r.n === 1 ? "" : "s"}`, skipped: (r) => `Skipped ${r.n || ""} missed ticket${r.n === 1 ? "" : "s"}`,
  added: () => "Added", changed: () => "Settings changed", removed: () => "Removed" };

export async function recentLog(rid, n = 30) {
  const s = await getDocs(query(col(rid, "printlog"), orderBy("t", "desc"), limit(n)));
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}
export async function logCsv(rid, P) {
  const s = await getDocs(query(col(rid, "printlog"), orderBy("t", "asc")));
  const cell = (v) => { let t = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [["When", "Printer", "What", "By", "Reason", "Tickets"], ...s.docs.map((d) => { const r = d.data();
    return [new Date(r.t).toLocaleString("en-GB"), (P.printers.find((p) => p.id === r.pid) || {}).name || r.pid, EV[r.ev] ? EV[r.ev]({ ...r, reason: "" }) : r.ev, r.by || "", r.reason || "", r.n == null ? "" : r.n]; })];
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

// Read the add / edit form; returns the printer's fields, or an error message.
export function readForm(f, stations) {
  const id = f.dataset.pid || "", v = (k) => (f.querySelector(`#${k}-${CSS.escape(id)}`) || {}).value || "";
  const name = v("pn").trim(), ip = v("pi").trim(), port = Number(v("pp") || 9100), width = Number(v("pw")) === 58 ? 58 : 80;
  const st = [...f.querySelectorAll(`input[name="pst-${CSS.escape(id)}"]:checked`)].map((x) => x.value).filter((k) => k in stations);
  if (!name) return { err: "Give the printer a name." };
  if (!IP.test(ip) || ip.split(".").some((x) => +x > 255)) return { err: "Enter the printer's IP address, like 192.168.1.50." };
  if (!(port > 0 && port < 65536)) return { err: "The port is usually 9100." };
  if (!st.length) return { err: "Tick at least one station it prints for." };
  return { id, data: { name: name.slice(0, 40), ip, port, width, stations: st } };
}
export async function savePrinter(rid, id, data, by) {
  const t = Date.now();
  if (id) { await updateDoc(ref(rid, "printers", id), { ...data, updated: t }); await addDoc(col(rid, "printlog"), { pid: id, ev: "changed", by, t }); return id; }
  const nid = "p" + t.toString(36);
  await setDoc(ref(rid, "printers", nid), { ...data, on: true, since: t, updated: t });
  await addDoc(col(rid, "printlog"), { pid: nid, ev: "added", by, t });
  return nid;
}
export async function removePrinter(rid, id, by) {
  await deleteDoc(ref(rid, "printers", id));
  await addDoc(col(rid, "printlog"), { pid: id, ev: "removed", by, t: Date.now() });
}
export const testPrint = (rid, id, by) => addDoc(col(rid, "printq"), { batch: "", pid: id, kind: "test", t: Date.now(), by });
