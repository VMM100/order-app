# Security Checklist.md: verify before merge, and before launch

Tick every box that applies. If a box can't be ticked, the change doesn't merge (or doesn't go live) until it can,
or Vandan accepts the risk in writing here.

## Before merge (every change)

- [ ] **No secrets in the code** (keys, tokens, passwords, service-account files). GitHub secret scanning is on.
- [ ] **Inputs validated**: on screen (`esc()`, lengths, shapes) *and* in `firestore.rules` (`hasOnly`, types, sizes).
- [ ] **Permissions tested**: new data has rules, with tests for who can and who can't; all rules tests pass.
      Every new collection gets a test that **someone else's record can't be read or changed by swapping its
      id** (another diner's table, another restaurant's orders), and that **admin powers are refused** to
      anyone who isn't the owner, a manager or the company (hiding a button is not protection).
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
- [ ] **The seven doors** (below) still shut. 10 minutes on staging, signed out, with the browser's developer tools.

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
- [ ] **Browser API key restricted** (Google Cloud → Credentials): only the Firebase APIs the app uses
      (Firestore, Identity Toolkit, Token Service, FCM registrations), and HTTP referrers wasabi.co.tz,
      auth.wasabi.co.tz and the staging site. The print box sends no referrer, so give it **its own key**
      restricted to the same APIs. Today the key has no restrictions (checked 25 Oct).
- [ ] **SMS sign-in limited to Tanzania** (Firebase → Authentication → Settings → SMS region policy: allow +255
      only), so nobody can run up an SMS bill by requesting codes to premium numbers abroad ("SMS pumping").
- [ ] **Anonymous accounts cleaned up** (accounts that never signed in again deleted after 30 days), so a
      script creating sign-ins can't pile them up.
- [ ] Uptime alert on wasabi.co.tz.
- [ ] Pre-launch pass with `docs/engineering/vendor/agent-skills/`: **shipping-and-launch** (incl. its accessibility, performance, security and observability checklists), **security-and-hardening** and **performance-optimization**; findings fixed or accepted in writing.

## The seven doors (attacker's-eye check)

The ways AI-built apps are usually broken into, from the outside, with nothing but a browser. Added 3 Nov 2026.
How Wasabi keeps each one shut, and how to check it before each live release:

| # | Door | Wasabi today | Check |
|---|---|---|---|
| 1 | **Secret keys in the page or a public repo** | No secrets in code (repo is public): service-account keys and the Cloudflare token live only in GitHub secrets; GitHub secret scanning + push protection on; `.env`, `*.pem`, `*service-account*.json`, `bridge/config.json` ignored. The Firebase web key in `firebase.js` is public by design: it identifies the project, the rules decide access. | DevTools → Sources → search `key`, `secret`, `token`, `sk-`: only the Firebase web key appears. |
| 2 | **Database with no row rules** | `firestore.rules` decides every read and write; 100+ emulator tests on every publish. | Rules tests green; `if true` appears only on reads of public things (menu photos, `meta/company`'s "claimed" flag) and never on a write. |
| 3 | **Swap an id, see someone else's** | Diners read only their own table (pass + table key or approved code); visits only their own; restaurants kept apart; table keys and auto ids are random. | Signed in as a diner, open another table's link without its key: refused. Change `?r=` to another restaurant on an owner page: refused. |
| 4 | **Admin page without a login** | Owner, manager and company powers are enforced in the rules (`boss`, `bossOwner`, `isCompany`), not by hiding pages. | Signed out, open `#company`, `?r=…#owner`: sign-in only; no data loads. |
| 5 | **Sign-up with no limits** | Restaurants need company approval; ring service rate-limited (per address, event, restaurant); Firebase limits new sign-ins per address. **Open:** SMS region limit, App Check, anonymous-account clean-up (see launch list). | Firebase console → Authentication → usage has no unexplained spikes. |
| 6 | **Unverified webhooks** | None yet. The ring service trusts nothing in the request: it re-reads the event from the database. **When payments arrive**, see below. | n/a until payments. |
| 7 | **Guessable ids** | Firestore auto ids and 12-character random keys (table, staff); 4-digit friend codes only work while a table is open and need the table's yes. | Rules tests cover it. |

## When payments arrive (mobile money, cards)

- [ ] Payment status comes **only** from the provider's signed callback, checked on our server (a Cloudflare
      Worker), never from the phone; the signature is verified and the payment is re-fetched from the provider.
- [ ] Callbacks are idempotent (the same one twice changes nothing) and amounts are checked against the bill.
- [ ] Provider keys only in Cloudflare/GitHub secrets; separate test and live keys.
- [ ] Rules: nobody, including staff, can write "paid by mobile money" directly.

## Known gaps (accepted for the pilot, fix before launch)

| Gap | Risk | Plan |
| --- | --- | --- |
| Waiter PINs stored as plain numbers | Owner/managers (and anyone with their access) can read PINs | Store a salted hash; rules compare hashes |
| No lock-out after wrong PINs / codes | Guessing 4 digits | Count failures per phone; pause after 5 |
| CSP allows inline scripts | Weaker protection against injected HTML | Move inline scripts into files, drop `'unsafe-inline'` |
| CI tools carry 13 upstream advisories (no fixes yet) | Low: tools run briefly on GitHub, no customer data | Dependabot updates when fixes ship |
