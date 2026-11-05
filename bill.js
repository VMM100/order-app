// The bill: who owes what at a table. Shared by the main app and the live demo, and tested in tests/bill.mjs.
//
// - Only people who ordered something are on the bill (someone who joined and ordered nothing isn't).
// - "By what they ordered": each person pays for their own items.
// - "Equally": every person who ordered gets the same share, rounded to the nearest 100 shillings; the
//   person who sat down first pays the difference, so the shares always add up to exactly the bill.
// - Someone a diner added without a phone can be paid for by that diner ("payer"): their share moves to
//   the diner's line, with their name under it.

export const tableTotal = (lines) => lines.reduce((a, l) => a + l.pr, 0);

export function shares(t, lines) {
  const people = t.people || {}, total = tableTotal(lines);
  const own = (pid) => lines.filter((l) => l.pid === pid);
  // Everyone who ordered, in the order they sat down; the first is the head of the table.
  const ordered = Object.keys(people).filter((pid) => own(pid).length)
    .sort((a, b) => ((people[a].t || 0) - (people[b].t || 0)) || (a < b ? -1 : 1));
  const amt = {};
  if (t.split === "equal" && ordered.length) {
    const n = ordered.length;
    let each = Math.round(total / n / 100) * 100;
    if (each * (n - 1) > total) each = Math.floor(total / n / 100) * 100;   // tiny bills: never a negative head share
    ordered.forEach((pid, i) => { amt[pid] = i ? each : total - each * (n - 1); });
  } else ordered.forEach((pid) => { amt[pid] = own(pid).reduce((a, l) => a + l.pr, 0); });
  // Fold the people a diner pays for into that diner's line (only if the diner is still on the table).
  const payerOf = (pid) => { const p = people[pid] || {}; return p.payer && p.payer !== pid && people[p.payer] ? p.payer : pid; };
  const rows = new Map();
  ordered.forEach((pid) => {
    const to = payerOf(pid);
    if (!rows.has(to)) rows.set(to, { pid: to, name: people[to].name, paid: !!(t.paid || {})[to], items: [], amt: 0, covers: [], head: false });
    const r = rows.get(to); r.amt += amt[pid]; r.items.push(...own(pid));
    if (to !== pid) r.covers.push(people[pid].name);
  });
  const out = [...rows.values()];
  if (t.split === "equal" && ordered.length) { const h = rows.get(payerOf(ordered[0])); if (h) h.head = true; }
  return out;
}
