// Keeps customer details out of this public repository. Run by the checks before every publish
// (.github/workflows/publish.yml) and by hand: node paperwork/check.mjs
//
// paperwork/ may hold only blank templates and the code that fills them. It fails if it finds:
//   - a file type that could be a filled copy or a scan (PDF, images, Word, spreadsheets, CSV…)
//   - a JSON file other than wasabi.json (customer files live in Drive, never here)
//   - an email address or phone number that isn't Wasabi's own
//   - a TIN or registration number written out
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWED_EXT = new Set([".html", ".css", ".js", ".mjs", ".md", ".ttf", ".txt", ".json"]);
const OUR_EMAILS = new Set(["hello@wasabi.co.tz", "vandan@wasabi.co.tz"]);
const OUR_PHONES = new Set(["748227000"]); // last 9 digits
const SKIP = new Set(["out", "fonts"]);    // out/ is ignored by git; fonts are binary (checked by type only)

const problems = [];
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f), rel = relative(HERE, p);
  if (statSync(p).isDirectory()) return SKIP.has(f) && dir === HERE ? (f === "fonts" ? readdirSync(p).map((x) => join(p, x)) : []) : walk(p);
  return [p];
});
for (const p of walk(HERE)) {
  const rel = relative(HERE, p), ext = extname(p).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) { problems.push(`${rel}: ${ext || "this"} files don't belong here (filled copies and scans go in Drive)`); continue; }
  if (ext === ".json" && rel !== "wasabi.json") { problems.push(`${rel}: customer files go in Drive, not here`); continue; }
  if (ext === ".ttf") continue;
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g))
    if (!OUR_EMAILS.has(m[0].toLowerCase())) problems.push(`${rel}: email address ${m[0]}`);
  for (const m of text.matchAll(/(?:\+?255|\b0)[\s-]?\d{2,3}[\s-]?\d{3}[\s-]?\d{3}\b/g)) {
    const d = m[0].replace(/\D/g, "").slice(-9);
    if (!OUR_PHONES.has(d)) problems.push(`${rel}: phone number ${m[0].trim()}`);
  }
  for (const m of text.matchAll(/\b(?:TIN|reg(?:istration)?\.?\s*no\.?)[:\s#]*\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/gi)) problems.push(`${rel}: number written out: ${m[0]}`);
}
const facts = JSON.parse(readFileSync(join(HERE, "wasabi.json"), "utf8"));
for (const k of ["restaurant", "restaurantLegal", "ownerName", "ownerEmail", "ownerPhone", "lines"]) if (k in facts) problems.push(`wasabi.json: "${k}" is a customer detail`);

if (problems.length) { console.error("✗ Paperwork check failed: customer details must stay out of this public repository.\n  " + problems.join("\n  ")); process.exit(1); }
console.log("✓ Paperwork holds blank templates only");
