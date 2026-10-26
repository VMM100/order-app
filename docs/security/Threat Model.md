# Threat Model.md: find the risks before someone else does

Map the app → list what's worth protecting → how it could be attacked → what stops it. Update this whenever a
new feature adds an entry point, and after any incident.

## 1. Entry points

| Entry point | Who uses it |
| --- | --- |
| Table QR link (`?r=…&t=…&k=…`) and friend codes (`?c=…`, scanner code box) | Anyone with the card or code |
| The database, directly (Firestore), with the public web config | **Anyone on the internet**: they can skip our screens entirely |
| Sign-in: anonymous, Google, phone SMS | Everyone |
| Staff links (staff token in the QR) and waiter PINs | Staff phones |
| Owner/manager/company pages | Restaurant admins, Wasabi |
| File uploads: menu template (.csv/.xlsx), logo, photos | Owners, managers |
| Ring service (`wasabi-ring*.workers.dev`) | Any phone (it's public) |
| Push notifications (FCM) | Staff phones |
| The publishing pipeline (GitHub Actions, secrets) | Vandan, Claude, Dependabot pull requests |
| Outside code (Firebase SDK, vendor/ libraries, CI tools) | Their authors and hosts |

## 2. Assets

Diners' names, orders and bills · diner accounts (phone numbers, emails, consents) · restaurants' sales data and
menus · staff PINs, staff tokens, table keys · subscription and payment records · service-account keys and
Cloudflare token · the live site and its reputation · restaurants' trust during service.

## 3. Risks and protections

| # | Risk | How it could happen | Protection today | Left to do |
| --- | --- | --- | --- | --- |
| R1 | **Ordering from outside the bar** (fake orders) | Guessing table numbers, reusing a photographed card | Table QR carries a secret key; rules require a pass proving the key or an open group's code | Rate-limit new groups per table |
| R2 | **Changing prices or ordering sold-out items** | Writing to the database directly | Rules check every line against the restaurant's price list and sold-out list | — |
| R3 | **Reading other tables' orders or names** | Querying groups/lines directly | Diners read only their own group (pass); staff need the current staff token | — |
| R4 | **Guessing a friend's code to join a stranger's table** | Trying 4-digit codes | Codes only work while a table is open; unique across restaurants while open | Limit failed code tries; consider 5-digit codes as Wasabi grows |
| R5 | **Waiter acting as another waiter / ex-staff still working** | Shared phone, old PIN, old staff link | Shift needs current PIN; actions recorded as the phone's waiter; new PIN or staff codes cut access; 16-hour shifts | Hash PINs; lock after 5 wrong PINs |
| R6 | **Manager or owner escalating** (subscription, owner, other restaurants) | Writing to accounts/others | Rules: managers limited to menu/staff; owners can't change status/paid-until; each restaurant isolated | — |
| R7 | **Company account takeover** (full access) | Phishing the Google account | Verified email + company list; **2-Step Verification required** | Check 2-step on every company account each quarter |
| R8 | **Malicious upload** | Crafted spreadsheet or image | Owner/manager only; files read as data; Excel reader replaced (SheetJS flaws); images re-drawn to small JPEGs | Size limits on all uploads |
| R9 | **Script injection (XSS)** | A name or menu item containing HTML/JS | All text shown through `esc()`; Content-Security-Policy blocks outside scripts | Remove `'unsafe-inline'` by moving inline scripts to files |
| R10 | **Ring service abuse** (spam rings, fake notifications) | Calling it repeatedly or with made-up paths | It only rings for real events in the last 2 minutes, once each; strict path format; only Wasabi links in notifications | Cloudflare rate limit rule |
| R11 | **Supply chain** (a library or tool turns malicious) | Hijacked package, CDN or GitHub step | Local, fingerprinted copies; exact versions + lockfile; GitHub steps pinned by commit; Dependabot into staging; CSP | Turn on Dependabot alerts + code scanning (to-do) |
| R12 | **Leaked keys** | Committed by mistake, stolen laptop | Keys only in GitHub/Cloudflare secrets; least-privilege service accounts | GitHub secret scanning; yearly rotation |
| R13 | **Bad release breaks service** | A bug during a busy night | Staging first, automatic checks, morning releases, one-click rollback | Uptime alerts |
| R14 | **Data loss** | Bad rule/bug deletes data | Rules block deletes by diners/staff | Daily backups + restore test (Blaze, to-do) |
| R15 | **Abuse of the database to run up costs / denial of service** | Scripts flooding reads/writes | Rules limit who can write and what; free-plan quotas cap spend | Firebase **App Check**; budget alert once on Blaze |
| R16 | **Legal: data stored abroad without permit** | Operating without PDPC registration/permit | — | Register with PDPC and get the transfer permit before launch |
| R17 | **Phishing diners with a fake "Wasabi" page** | Fake QR stickers on tables | Branded QR codes; scanner only opens Wasabi links | Teach restaurants to check cards; tamper-evident stands |
| R18 | **Live demo used to reach real data** | Demo room access | Demo data lives under `demo/{room}` only; rules forbid demo users anything else; company-only room start | — |

## 4. Review

Revisit this list: when a feature adds an entry point (new screen, upload, outside service, payment), before
launch, after any incident, and every quarter.
