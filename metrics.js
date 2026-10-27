// Owner dashboard numbers, worked out from the raw order, alert and table records.
// Pure functions (no database calls) so they can be tested on their own.

export const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (xs, p) => {
  const a = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((q, r) => q - r);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
};
const sum = (xs) => xs.reduce((a, x) => a + x, 0);
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// lines: ordered items; alerts: call/bill requests; sessions: closed tables; openTables: tables seated now.
export function computeMetrics({ lines = [], alerts = [], sessions = [], openTables = [], waiters = [], stations = {} }) {
  const waiterOf = {};
  sessions.forEach((s) => (waiterOf[s.session] = s.waiter || null));
  openTables.forEach((t) => (waiterOf[t.session] = t.waiter || null));

  const revenue = sum(lines.map((l) => l.pr || 0));
  const orders = new Set(lines.map((l) => l.batch)).size;
  const bySession = {};
  lines.forEach((l) => (bySession[l.session] = (bySession[l.session] || 0) + (l.pr || 0)));
  const closedBills = sessions.map((s) => bySession[s.session] || 0).filter((x) => x > 0);
  const guests = sum(sessions.map((s) => s.guests || 0)) + sum(openTables.map((t) => Object.keys(t.people || {}).length));
  const guestSpend = sessions.filter((s) => s.guests && bySession[s.session]).map((s) => bySession[s.session] / s.guests);

  const prep = {};
  Object.keys(stations).forEach((st) => {
    const xs = lines.filter((l) => l.st === st && l.tReady).map((l) => l.tReady - l.t);
    prep[st] = { median: median(xs), p90: pct(xs, 0.9), n: xs.length, items: lines.filter((l) => l.st === st).length };
  });
  const serveTimes = lines.filter((l) => l.tServed && l.tReady).map((l) => l.tServed - l.tReady);
  const toTable = lines.filter((l) => l.tServed).map((l) => l.tServed - l.t);

  const resp = (as) => as.filter((a) => a.ack).map((a) => a.ack - a.t);
  const waiterRows = waiters.map((w) => {
    const sess = Object.keys(waiterOf).filter((k) => waiterOf[k] === w.id);
    const mine = lines.filter((l) => waiterOf[l.session] === w.id);
    const myAlerts = alerts.filter((a) => a.ackBy === w.id);
    return {
      id: w.id, name: w.name, tables: sess.length, sales: sum(mine.map((l) => l.pr || 0)),
      callResp: median(resp(myAlerts.filter((a) => a.type === "call"))),
      billResp: median(resp(myAlerts.filter((a) => a.type === "bill"))),
      alerts: myAlerts.length,
      serve: median(lines.filter((l) => l.servedBy === w.id && l.tServed && l.tReady).map((l) => l.tServed - l.tReady)),
    };
  }).filter((r) => r.tables || r.alerts || r.sales).sort((a, b) => b.sales - a.sales);
  const unanswered = alerts.filter((a) => !a.ack).length;

  const byHour = Array.from({ length: 24 }, (_, h) => ({ h, revenue: 0, items: 0 }));
  lines.forEach((l) => { const h = new Date(l.t).getHours(); byHour[h].revenue += l.pr || 0; byHour[h].items++; });
  const days = {};
  lines.forEach((l) => { const k = dayKey(l.t); days[k] = (days[k] || 0) + (l.pr || 0); });
  const byDay = Object.keys(days).sort().map((k) => ({ day: k, revenue: days[k] }));

  const items = {};
  lines.forEach((l) => { const k = l.n; items[k] ||= { n: k, st: l.st, qty: 0, revenue: 0 }; items[k].qty++; items[k].revenue += l.pr || 0; });
  const best = Object.values(items).sort((a, b) => b.qty - a.qty || b.revenue - a.revenue);

  return {
    revenue, orders, items: lines.length, guests,
    tables: sessions.length + openTables.length, closedTables: sessions.length,
    avgBill: closedBills.length ? sum(closedBills) / closedBills.length : null,
    avgPerGuest: median(guestSpend) === null ? null : sum(guestSpend) / guestSpend.length,
    tableTime: median(sessions.filter((s) => s.closed && s.opened).map((s) => s.closed - s.opened)),
    prep, serve: median(serveTimes), toTable: median(toTable), toTableP90: pct(toTable, 0.9),
    callResp: median(resp(alerts.filter((a) => a.type === "call"))), billResp: median(resp(alerts.filter((a) => a.type === "bill"))),
    unanswered, waiters: waiterRows, byHour, byDay, best,
    sample: lines.some((l) => l.sample) || sessions.some((s) => s.sample),
  };
}

// A clearly marked sample week, so the dashboard has something to show in a pitch.
export function sampleData(menu, waiters, days = 7, now = Date.now()) {
  const rnd = (a, b) => a + Math.random() * (b - a), pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  const min = 60000, out = { lines: [], alerts: [], sessions: [] };
  const names = ["Amani", "Neha", "Rehema", "Tom", "Asha", "Kevin", "Zawadi", "Priya", "Juma", "Sara", "Ali", "Maya"];
  const prepMin = { bar: [1.5, 5], kitchen: [9, 24], grill: [12, 28] };
  const pool = [];
  menu.forEach((sec) => sec.items.forEach((it) => { if (it.out) return; const w = sec.st === "bar" ? 3 : 1; for (let i = 0; i < w; i++) pool.push({ it, st: sec.st }); }));
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  for (let d = days - 1; d >= 0; d--) {
    const day = start.getTime() - d * 864e5, dow = new Date(day).getDay(), busy = dow === 5 || dow === 6 ? 26 : dow === 0 ? 18 : 12;
    const count = Math.round(rnd(busy * 0.8, busy * 1.2));
    for (let s = 0; s < count; s++) {
      const hr = Math.random() < 0.25 ? rnd(12, 16) : rnd(17, 22.5), opened = day + hr * 3600e3;
      if (opened > now - 30 * min) continue;
      const table = 1 + Math.floor(Math.random() * 10), session = `${table}-sample${d}x${s}`, waiter = pick(waiters).id;
      const guests = Math.round(rnd(1.6, 5.4)), stay = rnd(40, 130) * min, closed = Math.min(opened + stay, now - 5 * min);
      let total = 0;
      const rounds = Math.max(1, Math.round(stay / (35 * min)));
      for (let r = 0; r < rounds; r++) {
        const t = opened + rnd(3, 12) * min + r * 35 * min, batch = `${session}b${r}`;
        for (let g = 0; g < guests; g++) {
          if (r > 0 && Math.random() < 0.4) continue;
          const pname = names[(s + g) % names.length], pid = `${session}p${g}`, n = Math.random() < 0.5 ? 2 : 1;
          for (let k = 0; k < n; k++) {
            const { it, st } = pick(pool), [l, p] = pick(it.v), tPrep = t + rnd(0.3, 3) * min, tReady = t + rnd(...prepMin[st]) * min, tServed = tReady + rnd(0.5, 6) * min;
            if (tServed > closed) continue;
            total += p;
            out.lines.push({ table, session, batch, pid, pname, n: it.n, v: l, pr: p, st, s: "served", t, tPrep, tReady, tServed, servedBy: waiter, note: null, sample: true });
          }
        }
      }
      if (Math.random() < 0.5) { const t = opened + rnd(10, 40) * min; out.alerts.push({ table, session, type: "call", pid: `${session}p0`, pname: names[s % names.length], t, ack: t + rnd(0.3, 4) * min, ackBy: waiter, done: true, doneAt: t + rnd(4, 8) * min, sample: true }); }
      const tb = closed - rnd(6, 14) * min;
      out.alerts.push({ table, session, type: "bill", pid: `${session}p0`, pname: names[s % names.length], t: tb, ack: tb + rnd(0.5, 5) * min, ackBy: waiter, done: true, doneAt: tb + rnd(5, 10) * min, sample: true });
      out.sessions.push({ table, session, opened, closed, waiter, guests, total, sample: true });
    }
  }
  return out;
}
