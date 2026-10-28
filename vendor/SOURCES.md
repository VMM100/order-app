# Outside code used by Wasabi

Every piece of code we didn't write is listed here: where it came from, the exact version, a fingerprint
(first 16 characters of its SHA-256) and what was checked. **Rule:** nothing new goes in without an entry,
a check for known vulnerabilities (npm audit / GitHub advisories), a pinned version and a local copy where possible.
The pages' security policy (Content-Security-Policy in index.html and demo/index.html) only allows the
outside addresses listed under "Loaded from Google".

## In the website (runs on diners' and staff phones)

| File | What it does | Source and version | Licence | Fingerprint | Checked |
| --- | --- | --- | --- | --- | --- |
| vendor/morphdom-esm.js | Redraws only what changed on the table screen | npm morphdom 2.7.4, minified with esbuild | MIT | fe150148649ee866 | 26 Oct 2026: npm audit 0 issues; no network calls, no eval |
| vendor/qrcode.min.js | Works out the QR code grid (Wasabi draws it) | npm qrcodejs 1.0.0 (was loaded from cdnjs) | MIT | c541ef06327885a8 | 26 Oct 2026: no network calls, no eval; old but only draws |
| vendor/read-excel-file.min.js | Reads .xlsx menu templates | npm read-excel-file 9.3.12, bundle/read-excel-file.min.js | MIT | 479b8f6917d3478c | 26 Oct 2026: npm audit 0 issues; no network calls, no eval. Replaced SheetJS xlsx 0.18.5 (known flaws CVE-2023-30533, CVE-2024-22363; no fixed version on npm/cdnjs) |
| vendor/jsQR.min.js | Reads QR codes on phones without a built-in reader | jsQR (cozmo/jsQR) | Apache-2.0 | 41fdad3e08b3a5d1 | Added 23 Oct 2026; re-checked 26 Oct: no network calls |

### Loaded from Google (allowed by the security policy)
- Firebase JavaScript SDK 13.0.0 from www.gstatic.com (app, auth, firestore, messaging). Google's official host.
- Google sign-in and phone sign-in (reCAPTCHA): apis.google.com, www.google.com/recaptcha, www.gstatic.com/recaptcha; sign-in frame on auth.wasabi.co.tz.
- Fonts: fonts.googleapis.com / fonts.gstatic.com (styles only, no code).

## In the ring service (worker/ring.js)
No outside code.

## Only on GitHub's machines (checks and publishing; never sent to phones)
Pinned in package.json and package-lock.json (every file fingerprinted); GitHub's own steps are pinned to
commit fingerprints in .github/workflows/publish.yml.

| Tool | Version | Used for |
| --- | --- | --- |
| firebase-tools | 15.34.1 | Database rules tests (emulator), publishing rules and staging |
| @firebase/rules-unit-testing, firebase | 6.0.0, 13.1.0 | Database rules tests |
| playwright | 1.64.1 | Page checks in a real browser |
| wrangler | 4.152.0 | Publishing the ring service to Cloudflare |

Known advisories (26 Oct 2026, npm audit): 13 (6 high, 7 moderate), all inside the latest firebase,
firebase-tools and wrangler releases (grpc-js, undici, uuid, opentelemetry, gaxios). No fixed versions exist
yet. They affect servers handling untrusted network traffic; here the tools only run briefly on GitHub to
test and publish our own code. GitHub's Dependabot alerts flag fixes when they ship.

## Reference material (text only; never on the website, never run)

Kept in `docs/`, which publishing leaves out, so none of it is served on wasabi.co.tz.

| Folder | What it is | Source and version | Licence | Fingerprint | Checked |
| --- | --- | --- | --- | --- | --- |
| docs/design/vendor/web-interface-guidelines/ | Vercel's Web Interface Guidelines: a checklist for reviewing screens (accessibility, focus, forms, touch, loading states) | github.com/vercel-labs/web-interface-guidelines, commit 434b7f91364665f2f733b310ec54809bf8f37937 (5 Oct 2026); command.md and AGENTS.md | MIT | efba3de9439cfd3b (SHA-256 of MANIFEST.sha256) | 27 Oct 2026: text only, no code. Their one-line installer (curl from their main branch) not used, because it always fetches the newest version. Used to review the diner and waiter screens |
| docs/marketing/vendor/marketingskills/ | Marketing guidance for AI assistants (social, copywriting, ad creative, launch, psychology…); used to plan and write Wasabi's marketing | github.com/coreyhaines31/marketingskills, tag v2.13.5, commit 17772c7a80b7b8c7a47af30f648374cd8bd8adc5 | MIT | 885b7d4eb601d382 (SHA-256 of MANIFEST.sha256, which fingerprints every file) | 27 Oct 2026: only the 296 skill .md files and LICENSE copied; the repo's scripts, CLIs, JS snippets and workflows left out. Text scanned: no hidden or bidirectional characters, no instructions to override an assistant, no shell commands it asks to run. It lists 4 paid partners and has 1 referral link, so treat its tool recommendations as possibly sponsored. Update by copying a newer tag the same way and redoing these checks |
| docs/engineering/vendor/agent-skills/ | Engineering checklists for AI assistants (security hardening, shipping and launch, performance, code review, front-end quality, debugging, simplification, observability); used for pre-launch and pre-release checks | github.com/addyosmani/agent-skills, commit aeac41d4d005999432bb7312f7ff06383a91d59d (13 Oct 2026); 8 skills + references, Markdown only | MIT | 4835c9b01076ff71 (SHA-256 of MANIFEST.sha256, which fingerprints every file) | 28 Oct 2026: text only. Hooks, scripts and slash-command files left out; nothing runs. The other 16 skills not copied |
