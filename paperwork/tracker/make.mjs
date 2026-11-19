// Puts the master list (lib/onboarding-steps.js) into the Onboarding tracker page and writes the result to
// out/onboarding-tracker.html, which is what gets published as the artifact. Run after changing either file:
//   node paperwork/tracker/make.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, "..", "out");
const page = readFileSync(join(HERE, "onboarding-tracker.html"), "utf8");
const steps = readFileSync(join(HERE, "..", "lib", "onboarding-steps.js"), "utf8");
if (!page.includes("/*STEPS*/")) throw new Error("The tracker page has lost its /*STEPS*/ marker");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "onboarding-tracker.html"), page.replace("/*STEPS*/", () => steps));
console.log("✓ out/onboarding-tracker.html");
