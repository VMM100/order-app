// Ring service rate limits (worker/ring.js): per address, per event, per restaurant; limiter trouble never blocks a ring.
import w from "../worker/ring.js";
const lim = (n) => { const c = {}; return { limit: async ({ key }) => ({ success: (c[key] = (c[key] || 0) + 1) <= n }) }; };
const env = { LIMIT: lim(60), LIMIT_EVENT: lim(10), LIMIT_PLACE: lim(300) };
const ctx = { waitUntil: (p) => p.catch(() => {}) };
const send = (path, ip) => w.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ path }), headers: { "cf-connecting-ip": ip } }), env, ctx).then((r) => r.status);
const run = async (n, f) => { const s = []; for (let i = 0; i < n; i++) s.push(await f(i)); return s.filter((x) => x === 429).length; };
globalThis.fetch = async () => new Response("", { status: 404 });   // no real Google calls
console.error = () => {};   // the background ring fails without a service account; that is expected here
let bad = 0; const check = (label, got, want) => { console.log(`${got === want ? "✓" : "✗"} ${label}: ${got} (expected ${want})`); if (got !== want) bad++; };
check("same event 15 times, refused", await run(15, () => send("restaurants/r1/alerts/a1", "1.1.1.1")), 5);
check("one address, 70 events, refused", await run(70, (i) => send(`restaurants/r2/alerts/e${i}`, "2.2.2.2")), 10);
check("one restaurant, 400 addresses, refused", await run(400, (i) => send(`restaurants/r3/lines/l${i}`, "9.9." + i)), 100);
const env2 = {}; check("no limiters set up, status", (await w.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ path: "restaurants/r1/alerts/a1" }) }), env2, ctx)).status, 202);
const env3 = { LIMIT: { limit: async () => { throw new Error("down"); } } }; check("limiter error, status", (await w.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ path: "restaurants/r1/alerts/a1" }) }), env3, ctx)).status, 202);
if (bad) process.exit(1);
