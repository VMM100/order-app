// Smoke test: opens the main pages in a real (headless) browser and fails if any of them breaks.
// Run from the repo root: node tests/smoke.mjs   (needs: npm i playwright && npx playwright install chromium)
// It serves the site from this folder, so it tests exactly the files about to be published.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain", ".xml": "application/xml", ".ico": "image/x-icon" };
const server = createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let f = join(root, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); res.writeHead(200, { "content-type": types[extname(f)] || "application/octet-stream" }); res.end(await readFile(f)); }
  catch { res.writeHead(404, { "content-type": "text/html" }); res.end(await readFile(join(root, "404.html")).catch(() => "not found")); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://localhost:${server.address().port}/`;

// A fake camera, so the scanner can really start.
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const failures = [];
async function check(name, path, test, { wait = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"] });
  const page = await ctx.newPage(), errs = [];
  page.on("pageerror", (e) => errs.push("Script error: " + e.message));
  page.on("response", (r) => { const u = r.url(); if (u.startsWith(base) && !r.request().isNavigationRequest() && r.status() >= 400 && !u.endsWith("favicon.ico")) errs.push(`Missing file (${r.status()}): ${u.slice(base.length)}`); });
  try {
    await page.goto(base + path, { waitUntil: "load" });
    if (test) await test(page);
    if (wait) await page.waitForTimeout(wait);
  } catch (e) { errs.push(String(e.message || e).split("\n")[0]); }
  console.log(`${errs.length ? "✗" : "✓"} ${name}${errs.length ? "\n    " + errs.join("\n    ") : ""}`);
  if (errs.length) failures.push(name);
  await ctx.close();
}
const T = { timeout: 20000 };

await check("Landing page", "", async (p) => {
  await p.locator("#home h1").first().waitFor(T);
  await p.locator("[data-scan]:visible").first().click();
  await p.locator(".wscan").waitFor(T);
  await p.locator(".wscan-x").click();
}, { wait: 500 });
await check("Sign in", "#account", async (p) => { await p.getByText("Continue with Google").waitFor(T); });
await check("Owner page (asks to sign in)", "?r=crafty-dees#owner", null, { wait: 6000 });
await check("Table without a QR key (asks for a code)", "?r=crafty-dees&t=1", async (p) => { await p.locator("#codein").waitFor(T); });
await check("Live demo page", "demo/", null, { wait: 5000 });
await check("Privacy policy", "privacy.html", async (p) => { await p.locator("h1").first().waitFor(T); });
await check("Page not found", "this-page-does-not-exist", async (p) => { await p.getByText("isn't on the menu").first().waitFor(T); });

await browser.close(); server.close();
if (failures.length) { console.log(`\n${failures.length} page(s) broken: ${failures.join(", ")}. Nothing will be published.`); process.exit(1); }
console.log("\nAll pages open without errors.");
