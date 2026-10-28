# Wasabi: notes for AI assistants working on this code

Before changing anything, read and follow **[docs/security/Security.md](docs/security/Security.md)**, and check
the change against **[docs/security/Security Checklist.md](docs/security/Security%20Checklist.md)** before committing.
Who can do what: [Auth.md](docs/security/Auth.md). Personal data: [Data Security.md](docs/security/Data%20Security.md).
Risks: [Threat Model.md](docs/security/Threat%20Model.md). Outside code register: [vendor/SOURCES.md](vendor/SOURCES.md).
How screens should look and behave (colours, type, touch sizes, words): **[DESIGN.md](DESIGN.md)**.
Before a release or launch, also check against the engineering checklists in `docs/engineering/vendor/agent-skills/`
(shipping-and-launch, security-and-hardening, performance-optimization, code-review-and-quality): read-only references.

Ground rules in short:
- `firestore.rules` is the security. New data → new rules + tests in the same change. Keep `firestore.rules`
  identical on `staging` and `main` (shared database); rules changes only add.
- Work on `staging`; `main` is live and only changes when Vandan says "put it live" (morning/early afternoon,
  never Friday/Saturday night). The live demo (`demo/`) shares the main modules; only `demo/app.js`
  (and its index and styles) are the demo's own copies: change both when a fix to `app.js` applies to both.
- No secrets in code. No loading code from public CDNs: vendor it, pin it, list it in vendor/SOURCES.md.
- Show user text with `esc()`. Never log personal data.
- Never delete or rename anything called from outside this code without asking Vandan first. That means: link
  formats on printed QR codes and shared links (`?r ?t ?k ?c ?s ?as ?join ?choose ?name` and the `#screen` names),
  forwarding pages (`demo.html`, `404.html`), the ring service address and the database paths it reads
  (`alerts`, `lines`, `groups`, `staff`, `push`, `rung`), notification links, `sw.js`, `version.txt`,
  `robots.txt`, `sitemap.xml`, `privacy.html`, `CNAME`, and database collections or fields the live site uses.
  Before removing code: list it with proof that nothing uses it, commit, then delete in a separate commit.
