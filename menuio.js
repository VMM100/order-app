// Menu template: download the menu as a spreadsheet, fill it in, upload it back.
// One row per price: an item with three sizes is three rows with the same Section and Item.
// Columns: Section · Goes to · Item · Option · Price (TSh) · Description · Tag · Sold out
// Download is a CSV file (opens in Excel, Google Sheets and Numbers). Upload takes CSV or Excel (.xlsx);
// Excel files are read with SheetJS, loaded only when one is uploaded.

export const HEAD = ["Section", "Goes to", "Item", "Option", "Price (TSh)", "Description", "Tag", "Sold out"];
const EXAMPLE = [
  ["Drinks", "Bar", "Fresh juice", "", "5000", "Passion, mango or orange", "", "no"],
  ["Drinks", "Bar", "Draught lager", "Half 250ml", "6000", "", "ABV 4.5%", "no"],
  ["Drinks", "Bar", "Draught lager", "Full 400ml", "9000", "", "ABV 4.5%", "no"],
  ["Food", "Kitchen", "Chicken wings", "6 pieces", "15000", "With chilli sauce", "", "no"],
  ["Food", "Kitchen", "Chicken wings", "12 pieces", "26000", "With chilli sauce", "", "no"],
  ["Food", "Kitchen", "Garden salad", "", "12000", "", "Vegetarian", "no"],
];

const cell = (v) => { const s = String(v == null ? "" : v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// The current menu as CSV, or example rows if the menu is empty. Starts with a BOM so Excel reads
// accents and the shilling text correctly.
export function menuToCsv(menu, stations) {
  const rows = [];
  menu.forEach((sec) => sec.items.forEach((it) => it.v.forEach(([label, price]) =>
    rows.push([sec.c, stations[sec.st] || sec.st, it.n, label || "", price, it.d || "", it.m || "", it.out ? "yes" : "no"]))));
  return "﻿" + [HEAD, ...(rows.length ? rows : EXAMPLE)].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// CSV text → rows. Handles quotes, commas or semicolons (Excel in some countries), and Windows line ends.
export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "", sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
  const rows = []; let row = [], val = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { val += '"'; i++; } else q = false; } else val += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(val); val = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(val); rows.push(row); row = []; val = ""; }
    else val += ch;
  }
  if (val !== "" || row.length) { row.push(val); rows.push(row); }
  return rows;
}

let xlsxLoad = null;
const loadXlsx = () => xlsxLoad || (xlsxLoad = new Promise((ok, no) => {
  const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  s.onload = () => (window.XLSX ? ok(window.XLSX) : no(new Error("xlsx"))); s.onerror = () => { xlsxLoad = null; no(new Error("xlsx")); };
  document.head.appendChild(s);
}));

// A chosen file → rows (first sheet for Excel files).
export async function readFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const X = await loadXlsx(), wb = X.read(await file.arrayBuffer(), { type: "array" });
    return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
  }
  return parseCsv(await file.text());
}

// Rows → menu sections, plus what was skipped and why. Header names are matched loosely so a template
// with columns moved around, renamed slightly or in a different order still works.
export function rowsToMenu(rows, stations) {
  const warn = [], norm = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const hi = rows.findIndex((r) => r.some((c) => norm(c) === "item"));
  if (hi < 0) return { error: "Couldn't find the header row. Keep the first row of the template (Section, Goes to, Item, Option, Price…)." };
  const h = rows[hi].map(norm), col = (...names) => h.findIndex((x) => names.some((n) => x.startsWith(n)));
  const C = { sec: col("section", "category"), st: col("goesto", "station"), item: col("item", "name"), opt: col("option", "size"),
    price: col("price"), desc: col("description", "desc"), tag: col("tag"), out: col("soldout", "out") };
  if (C.price < 0) return { error: "Couldn't find the Price column." };
  const stKey = (v) => { const n = norm(v); if (!n) return null;
    const hit = Object.entries(stations).find(([k, l]) => norm(k) === n || norm(l) === n || norm(l).startsWith(n));
    return hit ? hit[0] : undefined; };
  const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n);
  const secs = [], bySec = new Map(); let lastSec = "Menu", lastItem = "";
  rows.slice(hi + 1).forEach((r, i) => {
    const line = hi + i + 2, get = (k) => (C[k] >= 0 ? r[C[k]] : "");
    if (!r.some((c) => String(c).trim())) return;
    if (secs.reduce((a, s) => a + s.items.length, 0) > 1500) { if (!warn.includes("over")) warn.push("over"); return; }
    const secName = clip(get("sec"), 60) || lastSec, itemName = clip(get("item"), 80) || lastItem;
    if (!itemName) { warn.push(`Row ${line}: no item name, skipped`); return; }
    const digits = String(get("price")).replace(/[^\d]/g, ""), price = Number(digits);
    if (!digits || !(price > 0) || price > 100000000) { warn.push(`Row ${line} (${itemName}): no price, skipped`); return; }
    let sec = bySec.get(secName.toLowerCase());
    if (!sec) { sec = { c: secName, st: "kitchen", items: [] }; bySec.set(secName.toLowerCase(), sec); secs.push(sec); }
    const st = stKey(get("st"));
    // A section goes to one station: the first one named for it counts.
    if (st && !sec.stSet) { sec.st = st; sec.stSet = true; }
    else if (st && st !== sec.st) warn.push(`Row ${line}: ${secName} already goes to ${stations[sec.st]}, so ${itemName} goes there too`);
    else if (st === undefined) warn.push(`Row ${line}: "${clip(get("st"), 30)}" isn't a station; ${secName} goes to ${stations[sec.st]}`);
    let it = sec.items.find((x) => x.n.toLowerCase() === itemName.toLowerCase());
    if (!it) { it = { n: itemName, v: [] }; sec.items.push(it); }
    const d = clip(get("desc"), 300), m = clip(get("tag"), 60), out = /^(y|yes|true|1|x|sold)/i.test(String(get("out")).trim());
    if (d) it.d = d; if (m) it.m = m; if (out) it.out = true;
    it.v.push([clip(get("opt"), 40), price]);
    lastSec = secName; lastItem = itemName;
  });
  secs.forEach((s) => delete s.stSet);
  const items = secs.reduce((a, s) => a + s.items.length, 0);
  if (!items) return { error: "No menu items found. Each row needs at least an item name and a price.", warn };
  return { menu: secs, items, warn: warn.map((w) => (w === "over" ? "Stopped at 1,500 items" : w)) };
}

// Put an uploaded menu into the current one. "replace": the upload becomes the menu. "add": new sections
// are added, and items already on the menu (same section and name) are updated. Either way, an item
// that already has a photo keeps it.
export function mergeMenu(current, upload, mode) {
  const photo = new Map();
  current.forEach((s) => s.items.forEach((it) => { if (it.img) photo.set(it.n.toLowerCase(), it.img); }));
  const keepPhoto = (it) => { const p = photo.get(it.n.toLowerCase()); return p && !it.img ? { ...it, img: p } : it; };
  if (mode === "replace") return upload.map((s) => ({ ...s, items: s.items.map(keepPhoto) }));
  const out = current.map((s) => ({ ...s, items: s.items.slice() }));
  upload.forEach((us) => {
    const cs = out.find((s) => s.c.toLowerCase() === us.c.toLowerCase());
    if (!cs) { out.push({ ...us, items: us.items.map(keepPhoto) }); return; }
    cs.st = us.st;
    us.items.forEach((ui) => { const k = cs.items.findIndex((x) => x.n.toLowerCase() === ui.n.toLowerCase());
      if (k >= 0) cs.items[k] = { ...cs.items[k], ...ui, out: !!ui.out, img: ui.img || cs.items[k].img }; else cs.items.push(keepPhoto(ui)); });
  });
  return out;
}
