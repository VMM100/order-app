# Security.md: the rules for building Wasabi

**Who reads this:** anyone changing Wasabi, people and AI assistants alike. Read it before writing code; follow it while
writing code; check against [Security Checklist.md](Security%20Checklist.md) before merging. If a change can't follow
a rule here, stop and ask Vandan; don't work around it.

Related: [Auth.md](Auth.md) (who can do what) · [Data Security.md](Data%20Security.md) (personal data) ·
[Threat Model.md](Threat%20Model.md) (what we defend against) · [vendor/SOURCES.md](../../vendor/SOURCES.md) (outside code).

## 1. The database rules are the security

Wasabi has no server of its own: phones talk straight to the database (Firebase Firestore). Anything the app
"hides" in its screens is not protection; **`firestore.rules` is the only thing that stops someone reading or
changing data.** So:

- Every new collection or field gets a rule in `firestore.rules` **in the same change**. No rule means no access
  (the default is deny); never add a broad `allow read, write: if true` to "make it work".
- Every rule change gets tests in `tests/rules.test.mjs`: one that the right person **can**, and one that others
  **can't**. The checks refuse to publish if any test fails.
- Rules only ever **add** (backward compatible). Staging and live share one database, so `firestore.rules` must be
  **identical on the `staging` and `main` branches**; copy it to `main` in the same sitting.
- Prices, sold-out items, table keys, shifts and PINs are checked **by the rules**, never only in the app.

## 2. Keep secrets out of code

- No passwords, private keys, service-account files or tokens in the repository, ever. They live in
  **GitHub → Settings → Secrets** (used only by the publishing robot) or the Cloudflare/Firebase consoles.
- Public by design (fine in code): the Firebase web config (`firebase.js`), the Web Push public key (`push.js`),
  the ring service address. Access is controlled by the rules, not by hiding these.
- Secrets that belong to a restaurant (staff token, table keys, waiter PINs) live in `restaurants/{rid}/secrets`,
  `tablekeys`, and are readable only by that restaurant's owner/managers.
- Service accounts get only the roles they need (see [Auth.md](Auth.md) §5). A key that leaked is revoked in
  Google Cloud and replaced the same day.

## 3. Check every input

- **On phones:** treat everything typed or scanned as hostile. Show it with `esc()` (never put raw text into
  HTML), limit lengths (names 16, notes 200), and only accept the expected shape (4-digit codes, numbers).
- **In the rules:** every write lists its allowed fields (`keys().hasOnly([...])`), types and sizes. Orders must
  match the restaurant's own price list; nobody can set a price, a waiter or a paid flag they shouldn't.
- **In the ring service (worker/ring.js):** trust nothing in the request except *where to look*; read the real
  document, check it happened in the last 2 minutes, ring once only. It only opens links on Wasabi's own sites.
- **Scanned QR codes:** only open Wasabi table links (`scan.js`).
- **Uploaded files** (menu templates, logos, photos): owners/managers only; read as data, never run; size-limited.

## 4. Least privilege

Everyone gets the smallest access that lets them do their job: a diner sees only their own table, a waiter only
works while on shift, a manager can't change the look or the subscription, an owner can't extend their own
subscription. New features start from "nobody can" and add exactly who needs it. Details: [Auth.md](Auth.md).

## 5. Outside code is reviewed before it goes in

- Prefer writing it ourselves for small jobs. When outside code is needed: a well-known, maintained library;
  **check for known vulnerabilities** (npm audit / GitHub advisories); **pin the exact version**; keep a **local
  copy** in `vendor/` (no loading code from public CDNs); add it to [vendor/SOURCES.md](../../vendor/SOURCES.md)
  with its fingerprint.
- Publishing tools are pinned in `package.json` + `package-lock.json` (installed with `npm ci`); GitHub steps are
  pinned to commit fingerprints. Dependabot opens weekly update pull requests **into staging**.
- The pages' **Content-Security-Policy** lists every outside address allowed to run code or load data. A new
  outside service means updating the policy and SOURCES.md together.

## 6. How changes reach people

All changes go to **staging** first (wasabi-tz-staging.web.app), pass the automatic checks (scripts parse, main
pages open without errors, all database rules tests pass), get tried by Vandan, then go live on his word, in the
morning or early afternoon, never on a Friday or Saturday night. Every live release is tagged and can be rolled
back in a minute.

## 7. Log safely

Never log personal data, tokens, PINs, push addresses or full documents (in the browser console, the ring
service logs or GitHub). Log what happened and an id: "rang 2 phones, restaurants/x/alerts/y".

## 8. When something goes wrong

Follow the incident steps in [Data Security.md](Data%20Security.md) §7: contain, tell affected restaurants within
**24 hours**, the regulator (PDPC) without undue delay, affected diners where they could be harmed.
Report security problems to **security@wasabi.co.tz**.
