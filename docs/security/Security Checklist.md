# Security Checklist.md: verify before merge, and before launch

Tick every box that applies. If a box can't be ticked, the change doesn't merge (or doesn't go live) until it can,
or Vandan accepts the risk in writing here.

## Before merge (every change)

- [ ] **No secrets in the code** (keys, tokens, passwords, service-account files). GitHub secret scanning is on.
- [ ] **Inputs validated**: on screen (`esc()`, lengths, shapes) *and* in `firestore.rules` (`hasOnly`, types, sizes).
- [ ] **Permissions tested**: new data has rules, with tests for who can and who can't; all rules tests pass.
- [ ] **Rules identical on `staging` and `main`**, and only additive.
- [ ] **Outside code reviewed**: audited, exact version, local copy, listed in `vendor/SOURCES.md`; CSP updated
      if it calls a new address.
- [ ] **No personal data in logs** (console, ring service, GitHub).
- [ ] **Automatic checks green**: scripts parse, pages open without errors, rules tests pass.
- [ ] Tried on staging by Vandan.

## Before deploy (every live release)

- [ ] Secrets configured (GitHub: FIREBASE_SERVICE_ACCOUNT, RINGER_SERVICE_ACCOUNT, CLOUDFLARE_*).
- [ ] HTTPS enforced on wasabi.co.tz.
- [ ] Safe logging (see above).
- [ ] Security checks passed (the workflow run is green).
- [ ] Morning or early afternoon; not Friday or Saturday night. Previous version tag noted for rollback.

## Before launch (once)

- [ ] **PDPC registration** as controller and processor.
- [ ] **PDPC cross-border transfer permit** (Firebase and Cloudflare store data outside Tanzania).
- [ ] **Data protection officer** named; quarterly report diary set.
- [ ] Privacy policy reviewed by a Tanzanian lawyer and matches Data Security.md.
- [ ] **Blaze on, USD 5 budget alert, daily backups + point-in-time recovery**; one restore tested.
- [ ] Old version-1 top-level data deleted (`alerts`, `config`, `groups`, `lines`, `sessions`, `tables`, `tablekeys`).
- [ ] Automatic retention job running (guests 12 months; alerts/rung 30 days; demo rooms 30 days).
- [ ] Dependabot alerts, Dependabot security updates and code scanning on.
- [ ] security@wasabi.co.tz forwarding works; `security.txt` published.
- [ ] Company accounts: only named people, each with Google 2-Step Verification.
- [ ] Firebase App Check on (blocks scripts that aren't the Wasabi app).
- [ ] Uptime alert on wasabi.co.tz.
- [ ] Pre-launch pass with `docs/engineering/vendor/agent-skills/`: **shipping-and-launch** (incl. its accessibility, performance, security and observability checklists), **security-and-hardening** and **performance-optimization**; findings fixed or accepted in writing.

## Known gaps (accepted for the pilot, fix before launch)

| Gap | Risk | Plan |
| --- | --- | --- |
| Waiter PINs stored as plain numbers | Owner/managers (and anyone with their access) can read PINs | Store a salted hash; rules compare hashes |
| No lock-out after wrong PINs / codes | Guessing 4 digits | Count failures per phone; pause after 5 |
| CSP allows inline scripts | Weaker protection against injected HTML | Move inline scripts into files, drop `'unsafe-inline'` |
| CI tools carry 13 upstream advisories (no fixes yet) | Low: tools run briefly on GitHub, no customer data | Dependabot updates when fixes ship |
