// Syntax check: every script file, and every inline <script> in the HTML pages, must at least parse.
// A single typo here would stop the whole app loading on every phone.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = execFileSync("git", ["ls-files", "*.js", "*.mjs", "*.html"], { encoding: "utf8" }).split("\n")
  .filter((f) => f && !f.startsWith("vendor/") && !f.startsWith("tests/node_modules/"));
const dir = mkdtempSync(join(tmpdir(), "syntax-"));
let bad = 0, n = 0;
const check = (label, file, module) => {
  n++;
  try { execFileSync(process.execPath, ["--check", ...(module ? ["--input-type=module"] : []), ...(module ? [] : [file])],
    module ? { input: readFileSync(file), stdio: ["pipe", "pipe", "pipe"] } : { stdio: "pipe" }); }
  catch (e) { bad++; console.log(`✗ ${label}\n${String(e.stderr || e.message).split("\n").slice(0, 6).join("\n")}`); }
};
for (const f of files) {
  if (!f.endsWith(".html")) { check(f, f, /^\s*(import|export)\b/m.test(readFileSync(f, "utf8")) || f.endsWith(".mjs")); continue; }
  const html = readFileSync(f, "utf8");
  [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].forEach(([, attrs, code], i) => {
    if (/\bsrc=/.test(attrs) || !code.trim()) return;
    if (/application\/ld\+json/.test(attrs)) { n++; try { JSON.parse(code); } catch (e) { bad++; console.log(`✗ ${f}: structured data #${i + 1} isn't valid JSON (${e.message})`); } return; }
    const tmp = join(dir, `${f.replace(/\W/g, "_")}_${i}.js`); writeFileSync(tmp, code);
    check(`${f}: inline script #${i + 1}`, tmp, /type=["']?module/.test(attrs));
  });
}
console.log(bad ? `\n${bad} of ${n} scripts have errors.` : `✓ ${n} scripts parse.`);
process.exit(bad ? 1 : 0);
