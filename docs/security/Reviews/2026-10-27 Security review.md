# Security review: 27 Oct 2026

**Scope:** `firestore.rules`, the app (`app.js`, `account.js`, `push.js`, `sw.js`, `menuio.js`, `scan.js`),
the ring service (`worker/ring.js`), the publish workflow (`.github/workflows/publish.yml`), the page
security policy, and the outside tools in `package-lock.json` and `vendor/`.
**Version reviewed:** `staging` at `live-2026-10-27-0516` (same as live).
**Method:** read-only. Checklists from the review tools listed at the end, with every candidate traced
from where an attacker gets in to what they reach, then an attempt to disprove it. Nothing was changed.

## Summary

| ID | Severity | Finding | Status (27 Oct, afternoon) |
|---|---|---|---|
| H1 | **High** | Anyone online can guess a 4-digit table code and join any open table | **Fixed** (option A, approved by Vandan): database rules live; app on staging |
| M1 | Medium | Anyone can use up the free daily database allowance (or run up the bill on Blaze) | **Partly fixed**: ring service limited to 60 requests/min per address. Still open: Blaze + budget alert (Vandan), App Check (build list) |
| L1 | Low | Some diner-written fields have no size or type limit | **Fixed** (rules live) |
| L2 | Low | Menu template download can carry spreadsheet formulas | **Fixed** on staging |
| L3 | Low | The company founder's email is publicly readable | **Fixed**: rule live; the email is removed the next time the company page is opened (staging app) |
| L4 | Low | Demo rooms can be listed and written by any visitor while open | **Fixed** (rules live) |
| L5 | Low | Publish workflow: rollback input goes straight into a shell line; checks run with write permissions | **Fixed** on staging |
| L6 | Low | Ring notifications accept a link to any `*.web.app` site | **Fixed** (staging ring service) |

Already known and tracked in the Security Checklist (not repeated here): waiter PINs stored as plain
numbers, no lock-out after wrong PINs, `'unsafe-inline'` in the page security policy, 13 advisories
in the test and publishing tools.

**How H1 was fixed:** a friend's code now only lets someone *ask* to join. The people already at the table
see "Juma wants to join · Let in / No"; until someone taps Let in, the code holder can't see names or
orders, order, or call the waiter (`joins/{uid}` in `firestore.rules`, 6 new rules tests, 70 in all).
The table QR still joins straight away, because it proves the person is at the table.

## Findings

### H1 · Anyone online can guess a 4-digit table code and join any open table
(CWE-307 too many attempts allowed, CWE-639; OWASP A01 Broken Access Control, A07 Authentication Failures)

- **Where:** `firestore.rules` lines 53–61 (`invites`), 235–248 (`codes`), 148–155 (`validPass`, `via: 'code'`).
- **Path:** a script signs in anonymously (allowed for every visitor) → reads `invites/1000` … `invites/9999`
  (any signed-in user may read them) → every hit names a restaurant with a table open right now →
  reads `restaurants/{rid}/codes/{code}`, which gives the group's session → writes itself a pass with
  `via: 'code'` → is now a member of that table.
- **Impact:** from anywhere, with no QR and no presence in the bar, someone can:
  see the first names and orders of everyone at every open table;
  send orders to the kitchen and bar on that table's bill (shared equally if the table splits equally);
  call the waiter and ask for the bill.
  About 9,000 reads (a few US cents) finds every open table across all restaurants at once.
- **Proof:** the existing test "friend with the code can join and order" (`tests/rules.test.mjs`
  line 161) shows an anonymous user with the code getting in. Reading a wrong code returns
  "doesn't exist" instead of being refused, so trying every code is possible. Firestore rules can't
  count or slow down attempts.
- **Fix (needs your decision):**
  - **A. Recommended:** keep the easy 4-digit code, but joining with it sends a request to the table:
    a person already seated taps **Let Juma join**. A guessed code then gets nowhere. The QR on the
    table still joins straight away, because it proves you're there.
  - **B.** Longer codes (6 letters and digits, about 2 billion options) that stop working 2 hours after
    the table opens. No extra tap, but harder to read out across a table.
  - Either way, add **Firebase App Check**, already on the build list, so scripts can't use the database
    at all.

### M1 · Anyone can use up the free daily database allowance
(CWE-770 no limits on resource use; OWASP A06 Insecure Design)

- **Where:** public reads (a running restaurant's menu, open codes, invites) and the ring service
  (`worker/ring.js`), which does a database read for every well-formed request, with no sign-in.
- **Impact:** on the free plan, the database allows 50,000 reads a day. A simple script can use that up,
  and then **every restaurant's app stops loading until the next day.** On Blaze the app keeps working,
  but the bill grows instead.
- **Fix:** Blaze with the USD 5 budget alert (on your list); App Check (build list); and in the ring
  service, a per-address limit using Cloudflare's free rate limiting, before it touches the database.

### L1 · Some diner-written fields have no size or type limit
- **Where:** `firestore.rules`: the group's `label` (line 259), `pname`, `batch` and `t` on orders and
  waiter calls (lines 289, 308).
- **Impact:** a seated diner could write a huge or non-text value. It is always shown safely (escaped),
  but it could make screens look broken for that table or the staff. It only affects their own table.
- **Fix:** add text and length checks (name 20 characters, as `people` already has).

### L2 · Menu template download can carry spreadsheet formulas
(CWE-1236 CSV injection)
- **Where:** `menuio.js` `cell()`.
- **Impact:** a manager could name a dish `=HYPERLINK(...)`. When the owner opens the downloaded
  template in Excel, it becomes a live formula. This only affects people who can already edit the menu.
- **Fix:** put a `'` in front of any cell that starts with `=`, `+`, `-` or `@`.

### L3 · The company founder's email is publicly readable
- **Where:** `firestore.rules` line 64: `meta/company` is readable by anyone, and stores `by` (the
  claiming email).
- **Impact:** anyone can read the Gmail address of whoever claimed the company page, a target for
  phishing.
- **Fix:** let the public read only whether the company exists; keep `by` for company members only.

### L4 · Demo rooms can be listed and written by any visitor while open
- **Where:** `firestore.rules` lines 36–47.
- **Impact:** any signed-in visitor can list rooms and, for 12 hours, write anything into one (no size
  limits). Only throwaway demo data is involved, but a live sales demo could be disrupted.
- **Fix:** allow reading a room by its exact name only (no listing), and add size checks on demo writes.

### L5 · Publish workflow details
- **Where:** `.github/workflows/publish.yml` line 155 puts `${{ inputs.version }}` straight into a shell
  line. Lines 21–24 give every job, including the checks run for pull requests, permission to write.
- **Impact:** only people with write access to the repository can start a rollback, so the risk is low.
  It is still the standard pattern to avoid.
- **Fix:** pass the input through an environment variable; give write permissions only to the publish jobs.

### L6 · Ring notifications accept a link to any `*.web.app` site
- **Where:** `worker/ring.js` `safeUrl()`.
- **Impact:** only a staff phone can save its own link, so an attacker would need the staff code first.
- **Fix:** allow only `wasabi.co.tz` and `wasabi-tz-staging.web.app`.

## Checked and found sound

- **Showing user text:** every name, dish, note, label and code that reaches a page goes through `esc()`
  or `textContent`. No unescaped insertion found.
- **Restaurants kept apart:** orders, calls, groups and passes are all checked against the restaurant
  and the diner's own table pass. Nothing crosses restaurants except H1.
- **Prices:** the database rules recompute every price and refuse sold-out items. Diners can't set
  their own prices.
- **Keys:** table and staff keys are 12 characters from the browser's secure random generator (about
  59 bits).
- **Notification clicks** only open pages on our own site.
- **No secrets in the code.** GitHub steps are pinned to exact versions, and tools are installed without
  running their install scripts.
- **Outside tools:** all 5 are test and publishing tools that never reach phones. None is deprecated,
  and none runs code when installed. The online advisory database was blocked from this review machine;
  `npm audit` on 26 Oct found the 13 known advisories already listed.
- **Old PIN fields** in a restaurant's settings are cleaned out automatically the next time the owner
  opens the owner page.

## Review tools used (pinned, read-only, nothing installed)

| Tool | Version (commit) | Used for |
|---|---|---|
| OWASP Security skill (agamm/claude-code-owasp) | `8ac7965caa212b4a850aff8d3df0081ab3fa9eed` | Review workflow, triage rules, severity scale |
| Trail of Bits skills: insecure-defaults, sharp-edges, supply-chain-risk-auditor, differential-review | `196a9073ab10d35bacf111f945e02c00b2c6883a` | Fail-open and permissive defaults; risky API use; dependency checks; reviewing future changes |
| Cloudflare security-audit-skill | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | Kept for the full audit before launch |

Seven other skills were reviewed and deleted without use on 27 Oct: Anthropic Defending Code, PYA,
Ghost Security, CC Safety Net, Bug Hunter, vbsec and AgentGuard. They were either not relevant, or they
install software or send data outside in ways that break our own rules.
