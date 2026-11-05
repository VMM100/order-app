// Wasabi ring service (Cloudflare Worker, free plan). Rings waiters' phones, even with the screen off.
//
// The app sends POST {path, count} right after something happens:
//   restaurants/{rid}/alerts/{id}   a diner tapped Call waiter or Bill please
//   restaurants/{rid}/lines/{id}    the kitchen or bar marked an order ready
//   restaurants/{rid}/groups/{sid}  the first guest sat at a table with no waiter
// (demo/{room}/… the same, for live demo rooms.)
//
// It trusts nothing in the request except where to look: it reads that document from the database,
// rings only if it really just happened (last 2 minutes), and only once (rung/{key} records it). The
// table's waiter rings; if the table has no waiter yet, every waiter on shift rings.
//
// Secrets (set by the GitHub workflow): GOOGLE_SERVICE_ACCOUNT, the JSON key of a Google service account
// with the roles "Cloud Datastore User" and "Firebase Cloud Messaging API Admin".

const PROJECT = "order-app-47367";
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FRESH_MS = 2 * 60e3, SHIFT_MS = 16 * 3600e3;
const PATH = /^(restaurants|demo)\/([A-Za-z0-9_-]{1,64})\/(alerts|lines|groups)\/([A-Za-z0-9_.:-]{1,128})$/;
const SITE = "https://wasabi.co.tz/";
const ALERT = { call: "Call waiter", bill: "Bill please" };

export default {
  async fetch(req, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method === "GET") return new Response("Wasabi ring service is running.", { headers: cors });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
    let body; try { body = JSON.parse(await req.text()); } catch { return new Response("Bad request", { status: 400, headers: cors }); }
    const m = PATH.exec(String(body && body.path || ""));
    if (!m) return new Response("Bad path", { status: 400, headers: cors });
    // Each request costs a database read, so three limits (Cloudflare's free rate limiter, see wrangler.toml):
    //   one address: 60 a minute (a busy bar's whole Wi-Fi sends a few);
    //   one event: 10 a minute (the app asks once; repeats are someone hammering);
    //   one restaurant or demo room: 300 a minute from all addresses together.
    // If a limiter isn't set up or has a hiccup, requests go through: ringing matters more than the limit.
    const over = async (lim, key) => !!lim && !(await lim.limit({ key }).catch(() => ({ success: true }))).success;
    if (await over(env.LIMIT, req.headers.get("cf-connecting-ip") || "unknown")
      || await over(env.LIMIT_EVENT, m[0])
      || await over(env.LIMIT_PLACE, `${m[1]}/${m[2]}`)) return new Response("Too many requests", { status: 429, headers: cors });
    const count = Math.max(1, Math.min(20, Number(body.count) || 1));
    // Answer straight away; the ringing carries on in the background.
    ctx.waitUntil(handle(env, m, count).catch((e) => console.error("ring failed", m[0], e && e.stack || e)));
    return new Response(null, { status: 202, headers: cors });
  },
  // Every night (wrangler.toml [triggers]): guests' first names older than 30 days become "Guest", for every
  // restaurant, whether or not anyone opens the owner page. The owner page still does the same as a backup.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(forgetNames(env).catch((e) => console.error("forget names failed", e && e.message)));
  },
};

// ---------- forgetting guests' names after 30 days ----------
// Same as forgetOldNames() in app.js (and Data Security.md): lines and calls keep "Guest" instead of the
// first name, join requests are deleted, closed tables' people become "Guest 1", "Guest 2"… Items, prices
// and totals stay. restaurants/{rid}/live/retention.upto remembers how far each restaurant has been done.
// Work is capped per run; anything left over is picked up by the next run (several runs each night).
const DAY = 864e5, KEEP_MS = 30 * DAY, PAGE = 300, MAX_WRITES = 1500;
function fixFor(col, d) {
  if (col === "lines" || col === "alerts") return d.pname && d.pname !== "Guest" ? { update: { pname: "Guest" } } : null;
  if (col === "joins") return { delete: true };
  if (col === "groups") {
    if (d.open !== false || d.forgot) return null;
    const people = {}; Object.entries(d.people || {}).forEach(([pid, p], i) => { people[pid] = { name: `Guest ${i + 1}`, t: num(p && p.t) }; });
    const u = { people, forgot: true }; if (d.tab) u.tab = "Tab";
    return { update: u, remove: d.label != null ? ["label"] : [] };
  }
  return null;
}
async function forgetNames(env, now = Date.now()) {
  const cutoff = now - KEEP_MS; let writes = 0;
  for (const rid of await listIds(env, "restaurants")) {
    if (writes >= MAX_WRITES) return;
    const ref = `restaurants/${rid}/live/retention`, cur = await getDoc(env, ref), from = num(cur && cur.upto);
    if (cutoff - from < DAY) continue;
    let done = true;
    for (const [col, field] of [["lines", "t"], ["alerts", "t"], ["joins", "t"], ["groups", "opened"]]) {
      let start = from, seen = new Set();
      for (;;) {
        const docs = await rangeQuery(env, `restaurants/${rid}`, col, field, start, cutoff);
        const fresh = docs.filter((x) => !seen.has(x.name)); fresh.forEach((x) => seen.add(x.name));
        const ws = fresh.map((x) => ({ name: x.name, fix: fixFor(col, x.data) })).filter((x) => x.fix);
        for (let i = 0; i < ws.length; i += 400) { await commit(env, ws.slice(i, i + 400)); }
        writes += ws.length;
        if (docs.length < PAGE || !fresh.length) break;
        if (writes >= MAX_WRITES) { done = false; break; }
        start = num(docs[docs.length - 1].data[field]);
      }
      if (!done) break;
    }
    if (!done) return;   // the next run carries on from the same place
    await patchDoc(env, ref, { upto: cutoff, t: now });
  }
}
async function listIds(env, col) {
  const ids = []; let page = "";
  for (;;) {
    const r = await fetch(`${DOCS}/${col}?pageSize=300&mask.fieldPaths=__none__${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { headers: { authorization: `Bearer ${await token(env)}` } });
    if (!r.ok) throw new Error(`list ${col}: ${r.status}`);
    const j = await r.json(); (j.documents || []).forEach((d) => ids.push(d.name.split("/").pop()));
    if (!j.nextPageToken) return ids; page = j.nextPageToken;
  }
}
async function rangeQuery(env, parent, col, field, from, to) {
  const j = await google(env, `${DOCS}/${parent}:runQuery`, { structuredQuery: {
    from: [{ collectionId: col }],
    where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: field }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: String(Math.floor(from)) } } },
      { fieldFilter: { field: { fieldPath: field }, op: "LESS_THAN", value: { integerValue: String(Math.floor(to)) } } }] } },
    orderBy: [{ field: { fieldPath: field }, direction: "ASCENDING" }], limit: PAGE } });
  return (Array.isArray(j) ? j : []).filter((x) => x.document).map((x) => ({ name: x.document.name, data: decode(x.document.fields) }));
}
async function commit(env, ws) {
  if (!ws.length) return;
  await google(env, `${DOCS.replace(/\/documents$/, "/documents:commit")}`, { writes: ws.map(({ name, fix }) => fix.delete ? { delete: name }
    : { update: { name, fields: encode(fix.update) }, updateMask: { fieldPaths: [...Object.keys(fix.update), ...(fix.remove || [])] }, currentDocument: { exists: true } }) });
}
async function patchDoc(env, path, obj) {
  const mask = Object.keys(obj).map((k) => `updateMask.fieldPaths=${k}`).join("&");
  const r = await fetch(`${DOCS}/${path}?${mask}`, { method: "PATCH", headers: { authorization: `Bearer ${await token(env)}`, "content-type": "application/json" }, body: JSON.stringify({ fields: encode(obj) }) });
  if (!r.ok) throw new Error(`save ${path}: ${r.status}`);
}
// Plain values → Firestore REST values (only what forgetNames writes).
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "object") return { mapValue: { fields: encode(v) } };
  return { nullValue: null };
}
function encode(o) { const f = {}; for (const [k, v] of Object.entries(o)) f[k] = enc(v); return f; }

async function handle(env, [path, root, rid, kind, id], count) {
  const base = `${root}/${rid}`, now = Date.now();
  const doc = await getDoc(env, path);
  if (!doc) return;
  let msg, key, group = null;
  // The diner's name as it is now (they can change it at the table), else the name on the order.
  const nameOf = (pid, was) => (group && group.people && group.people[pid] && group.people[pid].name) || was;
  if (kind === "alerts") {
    if (doc.done || !(now - num(doc.t) < FRESH_MS)) return;
    key = `a-${id}`; group = doc.session ? await getDoc(env, `${base}/groups/${doc.session}`) : null;
    const who = nameOf(doc.pid, doc.pname) || "A guest";
    msg = { title: `Table ${doc.table} · ${ALERT[doc.type] || "Needs you"}`,
      body: doc.type === "bill" ? `${who} wants the bill` : `${who} is calling you`, tag: `t${doc.table}-${doc.type}` };
  } else if (kind === "lines") {
    if (doc.s !== "ready" || !(now - num(doc.tReady) < FRESH_MS)) return;
    key = `l-${id}`; group = doc.session ? await getDoc(env, `${base}/groups/${doc.session}`) : null;
    const item = `${doc.n || "An order"}${doc.v ? ` (${doc.v})` : ""}`;
    msg = { title: `Table ${doc.table} · Ready to serve`, body: `${item}${count > 1 ? ` and ${count - 1} more` : ""} for ${nameOf(doc.pid, doc.pname) || "a guest"}`, tag: `t${doc.table}-ready` };
  } else {
    const people = Object.values(doc.people || {}), first = Math.min(...people.map((p) => num(p.t)));
    if (!doc.open || doc.waiter || !people.length || !(now - first < FRESH_MS)) return;
    key = `g-${id}`;
    msg = { title: `Table ${doc.table} · New guests`, body: "Waiting for a waiter. Tap to accept the table.", tag: `t${doc.table}-new` };
  }
  // Only once per event, however many times the app asks.
  if (!(await claimOnce(env, base, key))) return;
  const waiter = kind === "groups" ? null : (group && group.waiter) || null;
  const phones = await phonesFor(env, base, waiter);
  await Promise.all(phones.map((p) => send(env, base, p, msg)));
  console.log(`rang ${phones.length} phone(s)`, path);
}

// Push addresses of waiters on shift: the table's waiter, or all of them.
async function phonesFor(env, base, waiter) {
  const res = await google(env, `${DOCS}/${base}:runQuery`, { structuredQuery: { from: [{ collectionId: "staff" }],
    where: { fieldFilter: { field: { fieldPath: "shift" }, op: "GREATER_THAN", value: { integerValue: String(Date.now() - SHIFT_MS) } } } } });
  const uids = (res || []).filter((r) => r.document).map((r) => ({ id: r.document.name.split("/").pop(), ...decode(r.document.fields) }))
    .filter((s) => s.waiter && (!waiter || s.waiter === waiter)).map((s) => s.id);
  if (!uids.length) return [];
  const got = await google(env, `${DOCS}:batchGet`, { documents: uids.map((u) => `projects/${PROJECT}/databases/(default)/documents/${base}/push/${u}`) });
  return (got || []).filter((g) => g.found).map((g) => ({ name: g.found.name, ...decode(g.found.fields) })).filter((p) => p.token);
}

async function send(env, base, phone, msg) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
    method: "POST", headers: { authorization: `Bearer ${await token(env)}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { token: phone.token,
      data: { ...msg, url: safeUrl(phone.url), t: String(Date.now()) },
      // High urgency wakes an Android phone from sleep; a ring older than 10 minutes isn't worth delivering.
      webpush: { headers: { Urgency: "high", TTL: "600" } } } }),
  });
  if (r.ok) return;
  const err = await r.text();
  // The phone uninstalled Chrome or blocked notifications: forget its address.
  if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(err)) {
    await fetch(`https://firestore.googleapis.com/v1/${phone.name}`, { method: "DELETE", headers: { authorization: `Bearer ${await token(env)}` } }).catch(() => {});
  } else console.error("FCM", r.status, err.slice(0, 300));
}

// rung/{key}: created only if missing, so a second request for the same event rings nobody.
async function claimOnce(env, base, key) {
  const r = await fetch(`${DOCS}/${base}/rung?documentId=${encodeURIComponent(key)}`, {
    method: "POST", headers: { authorization: `Bearer ${await token(env)}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: { t: { integerValue: String(Date.now()) } } }),
  });
  if (r.ok) return true;
  if (r.status !== 409) console.error("claim", r.status, (await r.text()).slice(0, 200));
  return false;
}

// ---------- Google APIs ----------
async function getDoc(env, path) {
  const r = await fetch(`${DOCS}/${path}`, { headers: { authorization: `Bearer ${await token(env)}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`read ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return decode((await r.json()).fields);
}
async function google(env, url, body) {
  const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${await token(env)}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url.split("/").pop()}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// An OAuth token for the service account, kept until shortly before it expires.
let cached = { token: null, exp: 0 };
async function token(env) {
  if (cached.token && Date.now() < cached.exp - 60e3) return cached.token;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT), now = Math.floor(Date.now() / 1000);
  const b64 = (o) => btoa(typeof o === "string" ? o : String.fromCharCode(...new Uint8Array(o))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging" }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const keyObj = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyObj, new TextEncoder().encode(`${head}.${claim}`));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${head}.${claim}.${b64(sig)}` });
  if (!r.ok) throw new Error(`Google sign-in: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}
// Firestore REST values → plain values.
function val(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("mapValue" in v) return decode(v.mapValue.fields);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  return null;
}
function decode(fields) { const o = {}; for (const [k, v] of Object.entries(fields || {})) o[k] = val(v); return o; }
const num = (x) => (typeof x === "number" ? x : Number(x) || 0);
// Notifications only open our own sites: the live site and the staging copy.
const OUR_HOSTS = new Set(["wasabi.co.tz", "www.wasabi.co.tz", "wasabi-tz-staging.web.app"]);
function safeUrl(u) { try { const x = new URL(u); return x.protocol === "https:" && OUR_HOSTS.has(x.hostname) ? x.href : SITE; } catch { return SITE; } }

export const _test = { decode, PATH, safeUrl, fixFor, forgetNames, encode };
