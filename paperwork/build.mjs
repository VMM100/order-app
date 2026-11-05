// Makes Wasabi's paperwork as print-ready PDFs.
//
//   node paperwork/build.mjs                         every template, blank (to print and fill by hand)
//   node paperwork/build.mjs pilot-letter invoice    just these
//   node paperwork/build.mjs --data ~/x.json --out ~/Drive/…   filled in for one restaurant
//
// Company facts come from paperwork/wasabi.json, prices/grace days/phone from platform.js and the Terms
// and Privacy versions from terms.html/privacy.html, so a change there shows up here on the next build.
// A customer's details (--data) must live OUTSIDE this repository (it's public): the build refuses
// otherwise, and filled PDFs never go in the repository either (paperwork/out/ is ignored by git).
import { chromium } from "playwright";
import { readFileSync, mkdirSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, join, basename, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPANY } from "../platform.js";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "..");
const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args.splice(i, 2)[1]; };
const dataPath = opt("--data"), outDir = resolve(opt("--out") || join(HERE, "out"));
const only = args.filter((a) => !a.startsWith("--"));
const under = (dir, p) => { const r = relative(dir, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

if (dataPath && under(ROOT, realpathSync(dataPath))) { console.error("Refusing: customer details must stay out of this repository (it's public). Keep the file in Drive or your scratch folder."); process.exit(1); }
if (under(ROOT, outDir) && !under(join(HERE, "out"), outDir)) { console.error("Refusing: PDFs go to paperwork/out/ (ignored by git) or a folder outside the repository."); process.exit(1); }

// ---- facts ----
const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const version = (file) => { const t = readFileSync(join(ROOT, file), "utf8"), v = t.match(/Version\s+(\d{4}-\d{2}-\d{2})(?:\s*·\s*(Draft))?/);
  if (v) return v; const u = t.match(/Last updated:\s*(\d{1,2}) (\w+) (\d{4})/); // "Last updated: 3 November 2026" → 2026-11-03
  if (!u) throw new Error("No version date found in " + file);
  return [u[0], `${u[3]}-${String(MON.indexOf(u[2]) + 1).padStart(2, "0")}-${u[1].padStart(2, "0")}`]; };
const [, termsVersion, termsDraft] = version("terms.html"), [, privacyVersion] = version("privacy.html");
// The menu template's columns and example rows, straight from the app (menuio.js).
const mio = readFileSync(join(ROOT, "menuio.js"), "utf8");
const arr = (name) => JSON.parse(mio.match(new RegExp("const " + name + " = (\\[[\\s\\S]*?\\]);"))[1].replace(/,\s*\]$/, "]"));
const facts = {
  menuHead: arr("HEAD"), menuExample: arr("EXAMPLE"),
  ...JSON.parse(readFileSync(join(HERE, "wasabi.json"), "utf8")),
  phone: COMPANY.phone, whatsapp: "https://wa.me/255" + COMPANY.phone.replace(/\D/g, "").replace(/^0/, ""), phoneIntl: "+255 " + COMPANY.phone.replace(/^0/, ""),
  monthly: COMPANY.monthly, yearly: COMPANY.yearly, graceDays: COMPANY.graceDays,
  termsVersion, termsDraft: termsDraft ? "Draft for legal review" : "", privacyVersion,
};
const customer = dataPath ? JSON.parse(readFileSync(dataPath, "utf8")) : {};
// A customer's file may not overwrite Wasabi's own details (e.g. "phone" would replace Wasabi's number).
const clash = Object.keys(customer).filter((k) => k in facts);
if (clash.length) { console.error("Refusing: the customer file uses names kept for Wasabi's own details: " + clash.join(", ") + " (use ownerPhone, restaurantAddress, …)"); process.exit(1); }
const today =new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Dar es Salaam date
const DATA = { ...facts, today, issued: dataPath ? today : "", ...customer, _blank: !dataPath };

// ---- what to make ----
const list = (dir) => readdirSync(join(HERE, dir)).filter((f) => f.endsWith(".html")).map((f) => ({ dir, name: f.replace(/\.html$/, "") }));
let jobs = [...list("templates"), ...list("print"), { dir: "..", name: "terms", site: true }, { dir: "..", name: "privacy", site: true }];
if (only.length) { jobs = jobs.filter((j) => only.includes(j.name)); if (!jobs.length) { console.error("No template called " + only.join(", ")); process.exit(1); } }
mkdirSync(outDir, { recursive: true });

// The site pages, printed: no menu bar or links bar, A4 margins, local fonts.
const SITE_PRINT = `@page{size:A4;margin:16mm 16mm 18mm}
@font-face{font-family:"Work Sans";src:url(${pathToFileURL(join(HERE, "fonts/WorkSans.ttf"))});font-weight:100 900}
@font-face{font-family:"Bricolage Grotesque";src:url(${pathToFileURL(join(HERE, "fonts/BricolageGrotesque.ttf"))});font-weight:200 800}
header.bar nav,footer nav,.toc{display:none!important} header.bar{padding:0 0 6mm!important;background:none!important}
header.bar img{filter:invert(1) brightness(.2)} body{background:#fff!important;font-size:10pt} .doc{padding:0!important;max-width:none!important}
.doc h2{break-after:avoid} .box{break-inside:avoid} a{text-decoration:none}`;

const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, "-").trim();
// CHROME=/path/to/chrome uses a browser already on this computer instead of Playwright's own download.
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
let problems = 0;
for (const job of jobs) {
  const file = resolve(HERE, job.dir, job.name + ".html");
  const modes = job.dir === "print" ? ["office", "print-shop"] : [""];
  // <meta name="variants" content="Pro-forma invoice|Invoice|Receipt">: one template, several documents.
  const vm = readFileSync(file, "utf8").match(/<meta name="variants" content="([^"]+)">/);
  const variants = vm ? (DATA.docType ? [DATA.docType] : vm[1].split("|")) : [""];
  for (const mode of modes) for (const variant of variants) {
    const page = await browser.newPage();
    // Nothing leaves this computer: only local files load.
    await page.route("**/*", (r) => (r.request().url().startsWith("file:") ? r.continue() : r.abort()));
    await page.addInitScript((d) => { window.DATA = d; }, { ...DATA, _mode: mode, ...(variant ? { docType: variant } : {}) });
    await page.goto(pathToFileURL(file).href);
    if (job.site) await page.addStyleTag({ content: SITE_PRINT });
    else await page.waitForFunction(() => window.FILL_DONE === true, null, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    // Anything cut off at the bottom of an A4 sheet is a mistake: say so instead of printing it.
    const over = await page.evaluate(() => [...document.querySelectorAll(".sheet .body")].map((b, i) => b.scrollHeight > b.clientHeight + 1 ? i + 1 : 0).filter(Boolean));
    if (over.length) { console.error(`✗ ${job.name}: too long for the page on sheet ${over.join(", ")}`); problems++; }
    const title = variant || (await page.title()).replace(/ · Wasabi$/, "");
    const no = variant && DATA.number ? " " + DATA.number : "";
    const who = DATA.restaurant ? " - " + DATA.restaurant : "";
    const ver = job.site ? ` v${job.name === "terms" ? termsVersion : privacyVersion}` : "";
    const name = safe(`${dataPath ? today + " " : "Blank - "}${job.site ? "Wasabi " : ""}${title}${no}${ver}${mode ? " (" + mode + ")" : ""}${who}`) + ".pdf";
    await page.pdf({ path: join(outDir, name), preferCSSPageSize: true, printBackground: true });
    console.log("✓ " + name);
    await page.close();
  }
}
await browser.close();
console.log(`\n${problems ? problems + " problem(s). " : ""}PDFs in ${outDir}`);
process.exit(problems ? 1 : 0);
