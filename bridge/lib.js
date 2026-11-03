// Wasabi print box: the parts that don't touch the network, so they can be tested on their own.
//  - plan(): which tickets each printer still has to print
//  - ticket(): the bytes for one kitchen or bar ticket (ESC/POS, the language basic thermal printers speak)

export const MAX_AGE_MS = 12 * 3600e3;   // never print anything older than 12 hours, even after a long outage

// Basic printers only know plain letters reliably: turn accents and curly quotes into plain ones.
export function plain(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/·/g, "-")
    .replace(/×/g, "x").replace(/[^\x20-\x7e\n]/g, "");
}

// Group order lines into tickets: one ticket per order (batch) per printer, holding only the items for
// the stations that printer serves.
export function plan({ printers, lines, printed, now, startedAt }) {
  const done = new Set(printed);   // ids "batch_pid"
  const out = [];
  for (const p of printers) {
    const since = Math.max(p.since || startedAt, now - MAX_AGE_MS);
    const mine = lines.filter((l) => (p.stations || []).includes(l.st) && l.batch && (l.t || 0) >= since);
    const byBatch = new Map();
    mine.forEach((l) => { if (!byBatch.has(l.batch)) byBatch.set(l.batch, []); byBatch.get(l.batch).push(l); });
    for (const [batch, ls] of byBatch) {
      if (done.has(`${batch}_${p.id}`)) continue;
      out.push({ pid: p.id, batch, lines: ls.sort((a, b) => (a.t || 0) - (b.t || 0)), t: Math.min(...ls.map((l) => l.t || 0)) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// What a printer that is switched off would have printed (for "4 tickets came in while it was off").
export const waiting = (p, args) => plan({ ...args, printers: [{ ...p, since: p.offAt || p.since }] }).length;

const ESC = 0x1b, GS = 0x1d;
const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Dar_es_Salaam" });

// One ticket. width: 80 (48 characters a line) or 58 mm (32). kind: "order", "reprint" or "test".
export function ticket({ width = 80, station, place, guest, waiter, by, lines = [], t, now, kind = "order", short }) {
  const cols = width === 58 ? 32 : 48, big = Math.floor(cols / 2);
  const parts = [];
  const raw = (...b) => parts.push(Buffer.from(b));
  const text = (s) => parts.push(Buffer.from(plain(s) + "\n", "ascii"));
  const rule = () => text("-".repeat(cols));
  // Word-wrap to n characters; follow-on rows start with indent and still fit within n.
  const wrap = (s, n, indent = "") => {
    const words = plain(s).split(/\s+/).filter(Boolean), rows = []; let row = "";
    const room = () => (rows.length ? n - indent.length : n);
    words.forEach((w) => {
      while (w.length > room()) { if (row) { rows.push(row); row = ""; } const k = room(); rows.push(w.slice(0, k)); w = w.slice(k); }
      if (!w) return;
      if ((row ? row.length + 1 : 0) + w.length > room()) { rows.push(row); row = w; } else row = row ? row + " " + w : w;
    });
    if (row) rows.push(row);
    return rows.map((r, i) => (i ? indent : "") + r);
  };
  raw(ESC, 0x40);                                   // reset
  raw(ESC, 0x61, 1);                                // centre
  raw(GS, 0x21, 0x11); raw(ESC, 0x45, 1);           // double size, bold
  wrap(String(station || "").toUpperCase(), big).forEach(text);
  wrap(String(place || "").toUpperCase(), big).forEach(text);
  raw(GS, 0x21, 0); raw(ESC, 0x45, 0);
  if (kind === "reprint") { raw(ESC, 0x45, 1); text("** REPRINT **"); raw(ESC, 0x45, 0); }
  if (kind === "test") { raw(ESC, 0x45, 1); text("TEST PRINT"); raw(ESC, 0x45, 0); }
  raw(ESC, 0x61, 0);                                // left
  const head = [`Order ${short || ""}`.trim(), t ? hhmm(t) : ""].filter(Boolean).join("   ");
  if (head) text(head);
  if (guest) wrap(`Guest: ${guest}`, cols, "  ").forEach(text);
  if (waiter) wrap(`Waiter: ${waiter}`, cols, "  ").forEach(text);
  if (by) wrap(`Taken by: ${by}`, cols, "  ").forEach(text);
  rule();
  // Same item, size and note twice: print once with a count.
  const groups = [];
  lines.forEach((l) => { const k = [l.n, l.v || "", l.note || ""].join("|"); const g = groups.find((x) => x.k === k); if (g) g.q++; else groups.push({ k, l, q: 1 }); });
  raw(ESC, 0x45, 1);
  groups.forEach(({ l, q }) => {
    raw(GS, 0x21, 0x01);                            // double height: easy to read across a kitchen
    wrap(`${q} x ${l.n}`, cols, "    ").forEach(text);
    raw(GS, 0x21, 0);
    if (l.v) wrap(l.v, cols - 4, "    ").forEach((r) => text("    " + r));
    if (l.note) { raw(ESC, 0x45, 0); wrap(`> ${l.note}`, cols - 4, "      ").forEach((r) => text("    " + r)); raw(ESC, 0x45, 1); }
  });
  raw(ESC, 0x45, 0);
  if (kind === "test") text("If you can read this, the printer works.");
  rule();
  if (kind !== "test" && t && now && now - t > 3 * 60e3) { raw(ESC, 0x45, 1); text(`LATE: ordered ${hhmm(t)}, printed ${hhmm(now)}`); raw(ESC, 0x45, 0); }
  raw(ESC, 0x61, 1); text("Wasabi"); raw(ESC, 0x61, 0);
  raw(ESC, 0x64, 4);                                // feed 4 lines
  raw(GS, 0x56, 0x42, 0);                           // cut (most printers with a cutter)
  return Buffer.concat(parts);
}

// The ticket as readable text (for the simulated printer and tests): drops the printer's control codes.
export function readable(buf) {
  const out = []; const b = [...buf];
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === ESC) { const n = b[i + 1]; i += n === 0x40 ? 1 : 2; continue; }
    if (c === GS) { const n = b[i + 1]; i += n === 0x56 ? 3 : 2; continue; }
    out.push(c);
  }
  return Buffer.from(out).toString("ascii");
}
