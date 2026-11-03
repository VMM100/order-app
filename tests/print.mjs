// Print box logic (bridge/lib.js): which tickets to print, nothing twice, the off/catch-up window, and
// the ticket itself. No network, no printer needed.
import { plan, ticket, readable, waiting, plain } from "../bridge/lib.js";
let bad = 0; const check = (label, ok) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) bad++; };
const now = Date.UTC(2026, 10, 3, 16, 0), min = 60e3;
const P = (id, stations, extra = {}) => ({ id, name: id, ip: "10.0.0.1", port: 9100, stations, width: 80, on: true, since: now - 60 * min, ...extra });
const L = (batch, st, t, extra = {}) => ({ batch, st, t, n: "Light Lager", v: "Full 400ml", table: 8, session: "s1", pname: "Amani", ...extra });
const lines = [L("b1", "bar", now - 5 * min), L("b1", "kitchen", now - 5 * min, { n: "Wings" }), L("b2", "bar", now - 2 * min), L("b0", "bar", now - 90 * min)];
const printers = [P("bar1", ["bar"]), P("kit1", ["kitchen", "grill"])];

let jobs = plan({ printers, lines, printed: [], now, startedAt: now - 60 * min });
check("one ticket per order per printer, only that printer's stations", jobs.length === 3 && jobs.filter((j) => j.pid === "bar1").length === 2 && jobs.find((j) => j.pid === "kit1").lines.every((l) => l.st === "kitchen"));
check("orders from before the printer's start time aren't printed", !jobs.some((j) => j.batch === "b0"));
jobs = plan({ printers, lines, printed: ["b1_bar1"], now, startedAt: now - 60 * min });
check("a ticket already printed isn't printed again", !jobs.some((j) => j.batch === "b1" && j.pid === "bar1") && jobs.some((j) => j.batch === "b1" && j.pid === "kit1"));
jobs = plan({ printers: [P("bar1", ["bar"], { since: now - 20 * 3600e3 })], lines: [L("old", "bar", now - 13 * 3600e3), L("new", "bar", now - min)], printed: [], now, startedAt: now });
check("nothing older than 12 hours ever prints", jobs.length === 1 && jobs[0].batch === "new");
check("first ticket in the list is the oldest", plan({ printers, lines, printed: [], now, startedAt: now - 60 * min })[0].t === now - 5 * min);
const off = P("bar1", ["bar"], { on: false, offAt: now - 3 * min });
check("while off: counts only orders since it was switched off", waiting(off, { lines, printed: [], now, startedAt: now - 60 * min }) === 1);
const t = readable(ticket({ width: 80, station: "Bar", place: "Table 8", guest: "Amani", waiter: "Grace", lines: [L("b1", "bar", now), L("b1", "bar", now), L("b1", "bar", now, { note: "no ice" })], t: now - 10 * min, now, short: "B1" }));
check("ticket: station, table, guest, waiter", /BAR/.test(t) && /TABLE 8/.test(t) && /Guest: Amani/.test(t) && /Waiter: Grace/.test(t));
check("ticket: same item twice prints once with a count; notes shown", /2 x Light Lager/.test(t) && /1 x Light Lager/.test(t) && /> no ice/.test(t));
check("ticket: marked late when printed 10 minutes after ordering", /LATE: ordered/.test(t));
const raw = ticket({ width: 58, station: "Kitchen", place: "Bar tab: Juma", lines: [L("b", "kitchen", now, { n: "A very long dish name that has to wrap onto the next line nicely" })], t: now, now });
check("58 mm: no line wider than 32 characters", readable(raw).split("\n").every((r) => r.length <= 32));
check("ticket ends with a cut", raw.includes(Buffer.from([0x1d, 0x56])));
check("accents and curly quotes become plain letters", plain("Crafty Dee’s café · 2×") === "Crafty Dee's cafe - 2x");
check("reprints say so", /REPRINT/.test(readable(ticket({ station: "Bar", place: "Table 1", lines: [], kind: "reprint" }))));
if (bad) process.exit(1);
