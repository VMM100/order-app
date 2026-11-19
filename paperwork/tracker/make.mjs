// Puts the master list (lib/onboarding-steps.js) into the Onboarding tracker page and Wasabi HQ
// (dashboard/wasabi-hq.html) and writes them to out/, which is what gets published as the artifacts. Run after changing either file:
//   node paperwork/tracker/make.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, "..", "out");
const steps = readFileSync(join(HERE, "..", "lib", "onboarding-steps.js"), "utf8");
mkdirSync(OUT, { recursive: true });
// Both pages carry the master list: the old tracker (retired into HQ on 20 Nov) and Wasabi HQ.
for (const [src, out] of [[join(HERE, "onboarding-tracker.html"), "onboarding-tracker.html"], [join(HERE, "..", "dashboard", "wasabi-hq.html"), "wasabi-hq.html"]]) {
  const page = readFileSync(src, "utf8");
  if (!page.includes("/*STEPS*/")) throw new Error(src + " has lost its /*STEPS*/ marker");
  writeFileSync(join(OUT, out), page.replace("/*STEPS*/", () => steps));
  console.log("✓ out/" + out);
}
