// Checks for bill.js: who owes what. Run with: node tests/bill.mjs
import { shares, tableTotal } from "../bill.js";

let bad = 0; const check = (label, ok) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) bad++; };
const line = (pid, pr) => ({ pid, pr, n: "Item" });
const person = (name, t, extra = {}) => ({ name, t, ...extra });
const sum = (rows) => rows.reduce((a, r) => a + r.amt, 0);
const by = (rows, pid) => rows.find((r) => r.pid === pid);

// 3 people, TSh 10,050, split equally: 3,400 + 3,400 for two, the first to sit pays 3,250. Adds up exactly.
let t = { split: "equal", people: { a: person("Amani", 1), b: person("Baraka", 2), c: person("Chiku", 3) } };
let lines = [line("a", 5000), line("b", 3050), line("c", 2000)];
let r = shares(t, lines);
check("equal split adds up to exactly the bill", sum(r) === tableTotal(lines));
check("others pay the rounded share (3,400)", by(r, "b").amt === 3400 && by(r, "c").amt === 3400);
check("the first to sit down pays the difference (3,250)", by(r, "a").amt === 3250 && by(r, "a").head === true);

// Someone who joined and ordered nothing isn't on the bill, either way.
t = { split: "equal", people: { a: person("Amani", 1), b: person("Baraka", 2), z: person("Left early", 3) } };
lines = [line("a", 6000), line("b", 4000)];
r = shares(t, lines);
check("equal: only people who ordered count", r.length === 2 && by(r, "a").amt === 5000 && by(r, "b").amt === 5000);
check("by order: nobody with nothing ordered", shares({ ...t, split: "order" }, lines).length === 2);

// A person without a phone, paid for by the diner who added them.
t = { split: "order", people: { a: person("Amani", 1), a_g1: person("Neema", 2, { guest: true, host: "a", payer: "a" }), b: person("Baraka", 3) } };
lines = [line("a", 5000), line("a_g1", 3000), line("b", 4000)];
r = shares(t, lines);
check("paid for: their items move to the payer's line", r.length === 2 && by(r, "a").amt === 8000 && by(r, "a").covers[0] === "Neema");
check("paid for: equal split still counts them as a person", (() => { const e = shares({ ...t, split: "equal" }, lines); return sum(e) === 12000 && by(e, "a").amt === 8000 && by(e, "b").amt === 4000; })());

// Not paid for: their own line on the bill.
t.people.a_g1 = person("Neema", 2, { guest: true, host: "a" });
r = shares(t, lines);
check("not paid for: their own line", r.length === 3 && by(r, "a_g1").amt === 3000);

// A diner who only ordered for the person without a phone still gets the line they pay.
t = { split: "order", people: { a: person("Amani", 1), a_g1: person("Neema", 2, { guest: true, host: "a", payer: "a" }) } };
r = shares(t, [line("a_g1", 3000)]);
check("payer who ordered nothing for themselves still pays for their guest", r.length === 1 && by(r, "a").amt === 3000);

// A tiny bill can't give the head a negative share.
t = { split: "equal", people: { a: person("A", 1), b: person("B", 2), c: person("C", 3), d: person("D", 4) } };
lines = [line("a", 100), line("b", 100), line("c", 100), line("d", 50)];
r = shares(t, lines);
check("tiny bill: no negative share, still adds up", r.every((x) => x.amt >= 0) && sum(r) === 350);

// Marked paid follows the payer.
t = { split: "order", paid: { a: true }, people: { a: person("Amani", 1) } };
check("paid flag", shares(t, [line("a", 1000)])[0].paid === true);

if (bad) process.exit(1);
