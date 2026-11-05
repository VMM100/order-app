// Nightly name clean-up on the ring service (worker/ring.js forgetNames), against a pretend database.
import w, { _test } from "../worker/ring.js";
import { generateKeyPairSync } from "node:crypto";
const { fixFor, forgetNames } = _test;
let bad = 0; const check = (label, ok) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) bad++; };
const DAY = 864e5, now = Date.UTC(2026, 11, 1), old = now - 40 * DAY, recent = now - 5 * DAY;

// What gets changed, per kind of document.
check("an old order line keeps its items, the name becomes Guest", JSON.stringify(fixFor("lines", { pname: "Amani", n: "Pilsner" })) === JSON.stringify({ update: { pname: "Guest" } }));
check("already Guest: nothing to do", fixFor("lines", { pname: "Guest" }) === null);
check("join requests are deleted", fixFor("joins", { name: "Juma" }).delete === true);
const g = fixFor("groups", { open: false, label: "Amani", tab: "Juma", people: { a: { name: "Amani", t: 1, uid: "a" }, a_g1: { name: "Neema", t: 2, guest: true, host: "a", payer: "a" } } });
check("closed table: people become Guest 1, Guest 2, label removed, tab renamed", g.update.people.a.name === "Guest 1" && g.update.people.a_g1.name === "Guest 2" && !("uid" in g.update.people.a) && !("host" in g.update.people.a_g1) && g.remove[0] === "label" && g.update.tab === "Tab" && g.update.forgot === true);
check("open table: left alone", fixFor("groups", { open: true, people: { a: { name: "A" } } }) === null);

// A pretend Firestore: two restaurants; r1 has an old and a recent line, r2 was done yesterday.
const docs = { "restaurants/r1/lines/l1": { pname: "Amani", t: old }, "restaurants/r1/lines/l2": { pname: "Baraka", t: recent },
  "restaurants/r1/joins/j1": { name: "Juma", t: old }, "restaurants/r1/groups/s1": { open: false, opened: old, label: "Amani", people: { a: { name: "Amani", t: 1 } } } };
const retention = { r2: now - 30 * DAY - DAY / 2 };
const enc = (v) => typeof v === "number" ? { integerValue: String(v) } : typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : v && typeof v === "object" ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } } : { nullValue: null };
const commits = [], patches = [];
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url), json = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (u.startsWith("https://oauth2")) return json({ access_token: "T", expires_in: 3600 });
  if (/\/documents\/restaurants\?/.test(u)) return json({ documents: [{ name: "x/restaurants/r1" }, { name: "x/restaurants/r2" }] });
  if (/live\/retention$/.test(u) && (opt.method || "GET") === "GET") { const rid = u.match(/restaurants\/([^/]+)\/live/)[1]; return retention[rid] ? json({ fields: { upto: enc(retention[rid]) } }) : new Response("", { status: 404 }); }
  if (/live\/retention\?/.test(u) && opt.method === "PATCH") { patches.push(u); return json({}); }
  if (u.endsWith(":runQuery")) {
    const parent = u.match(/documents\/(restaurants\/[^/:]+):runQuery/)[1], q = JSON.parse(opt.body).structuredQuery;
    const col = q.from[0].collectionId, [lo, hi] = q.where.compositeFilter.filters.map((f) => Number(f.fieldFilter.value.integerValue)), field = q.orderBy[0].field.fieldPath;
    const out = Object.entries(docs).filter(([k, d]) => k.startsWith(`${parent}/${col}/`) && d[field] >= lo && d[field] < hi).map(([k, d]) => ({ document: { name: `projects/p/databases/(default)/documents/${k}`, fields: Object.fromEntries(Object.entries(d).map(([a, b]) => [a, enc(b)])) } }));
    return json(out.length ? out : [{ readTime: "x" }]);
  }
  if (u.endsWith("/documents:commit")) { commits.push(JSON.parse(opt.body)); return json({}); }
  return new Response("", { status: 404 });
};
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });   // a throwaway key, only for this test
const sa = JSON.stringify({ client_email: "test@example.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
await forgetNames({ GOOGLE_SERVICE_ACCOUNT: sa }, now).catch((e) => { console.log("error:", e.message); bad++; });
const writes = commits.flatMap((c) => c.writes);
check("the old line was renamed to Guest", writes.some((x) => x.update && x.update.name.endsWith("lines/l1") && x.update.fields.pname.stringValue === "Guest"));
check("the recent line (5 days) was left alone", !writes.some((x) => x.update && x.update.name.endsWith("lines/l2")));
check("the old join request was deleted", writes.some((x) => x.delete && x.delete.endsWith("joins/j1")));
check("the closed table's label is removed", writes.some((x) => x.update && x.update.name.endsWith("groups/s1") && x.updateMask.fieldPaths.includes("label")));
check("progress saved for r1 only (r2 was done yesterday)", patches.length === 1 && /restaurants\/r1\//.test(patches[0]));
check("the ring service has a nightly job", typeof w.scheduled === "function");
if (bad) process.exit(1);
