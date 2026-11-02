# Data Security.md: personal data, from collection to deletion

**Principle:** collect less, protect it, limit who sees it, delete it on schedule.
Wasabi is the *data controller* for diner accounts and the company's own records, and the *processor* for the
order data a restaurant's diners create, under Tanzania's **Personal Data Protection Act, Cap. 44 (PDPA)**.

## 1. What we hold (classified)

| Data | Where | Sensitivity | Why we need it |
| --- | --- | --- | --- |
| Diner first name at a table | `restaurants/{rid}/groups` (people), `lines.pname`, `alerts.pname` | Personal, low | So the table and waiter know whose order is whose |
| What a diner ordered, their share, paid flag | `lines`, `sessions`, `groups.paid` | Personal | Orders and the split bill |
| Diner account: name, phone **or** email, offers choices | `diners/{uid}` | **Personal, contact details** | Sign-in, visit history, WhatsApp offers they opted into |
| WhatsApp number linked by a Google account (`waPhone`, `waVerified`) | `diners/{uid}` | **Personal, contact details** | Offers only, for restaurants the diner ticked. **Not checked yet:** no offer may be sent to it until the number is confirmed by a code (`waVerified` true, which the diner can't set themselves). Removed with "Remove this number" or account deletion |
| Proof of consent to offers (date, restaurant, on/off) | `diners/{uid}/consents` | Personal | Legal proof of consent; never edited |
| Visits (restaurant, date, items, share) | `visits` | Personal | "My account" history and "your usual" |
| Restaurant owner and manager emails | `accounts`, `restaurants/{rid}/admins` | Personal | Sign-in and roles |
| Waiter names and PINs | `restaurants/{rid}` (names), `secrets/waiters` (PINs) | **Secret** (PINs) | Shifts |
| Staff token, table keys | `secrets/staff`, `tablekeys` | **Secret** | Staff phones, proof of being at a table |
| Phone push addresses | `restaurants/{rid}/push` | Personal device id | Ringing waiters' phones |
| Subscription, payments recorded | `accounts`, `accounts/{rid}/payments` | Business confidential | Billing |
| Menu, photos, logo, brand | `restaurants/{rid}`, `photos` | Public | Shown to diners |
| Phone number used for SMS sign-in | Firebase Authentication | **Personal** | Sign-in (Google sends the SMS) |

**We never collect:** card numbers, mobile-money PINs or wallet details, ID numbers, location, contacts, or
photos of people. Payments (later) go through a **licensed provider** (e.g. Selcom, Pesapal, AzamPay): Wasabi
stores only a payment reference and status, never card or wallet details.

## 2. Protection

- **In transit:** HTTPS everywhere (enforced on wasabi.co.tz; Firebase and Cloudflare are HTTPS-only).
- **At rest:** Google encrypts the database and authentication data at rest; Cloudflare stores the ring service's
  key as an encrypted secret.
- **Access:** `firestore.rules` (see [Auth.md](Auth.md)); every rule has tests.
- **Secrets:** PINs, staff token and table keys readable only by the restaurant's owner/managers. *Known gap:*
  waiter PINs are stored as plain 4-digit numbers (readable by the owner); hashing them is on the
  [checklist](Security%20Checklist.md).
- **Backups:** daily Firestore backups with 7-day point-in-time recovery, once the Firebase **Blaze** plan is on
  (with a USD 5 budget alert). Backups are restored into a test copy at least once before launch.

## 3. Who can see what

| Person | Sees |
| --- | --- |
| A diner | Their own table's names, orders and bill; their own account and visits |
| Restaurant staff | Open tables, orders, calls; first names only |
| Owner / manager | Their restaurant's orders, history and dashboard; visits **to their restaurant**; diners who opted into **their** offers |
| Wasabi company | Everything, only to support restaurants and run Wasabi |
| Ring service | Calls, orders, shifts and push addresses, only to ring the right phone |
| Google (Firebase), Cloudflare | Store and process data for us as our providers |

Restaurants never see a diner's visits to other restaurants, or contact details unless the diner opted into that
restaurant's offers.

## 4. Retention and deletion

| Data | Kept | Then |
| --- | --- | --- |
| Guest diners' first names at tables (on orders, calls, tables, bar tabs, join requests) | **30 days** (since 29 Oct 2026) | Replaced with "Guest 1", "Guest 2"…; join requests deleted. Runs from the owner's or manager's phone when the owner page opens (at most daily, `live/retention` marks progress); moves to the scheduled job when it's built |
| Guest diners' orders and bills (without names after 30 days) | **12 months** | Deleted; restaurants keep totals (sales, counts) |
| Diner accounts, visits, consents | Until the diner deletes the account | *Delete my account and data* removes profile, visits and consents |
| Consent records after an account is deleted | Deleted with the account | (we keep no contact details, so no offers can be sent) |
| Alerts (calls, bill requests), `rung` records | 30 days | Deleted |
| Push addresses | Until the phone stops accepting them | Deleted automatically when Google reports them invalid |
| Restaurant data after its service ends | **90 days** (so it can come back) | Service ends at the end of a cancelled paid period, or **30 days after ordering stopped for non-payment** (37 days after paid-until). Then: email the owner (and again ≥14 days before deletion), keep everything 90 days, then delete everything under `restaurants/{rid}` and diners' visits there. Earlier only on the **owner's written request** or a **court / PDPC order**. Decided 3 Nov 2026; **not built yet** (see To-dos). Until it's built, don't use *Delete restaurant* except on a written request |
| Setup file (menu, prices, photos, look, tables, waiters' first names; no diners' data) | **2 years** after deletion | Made when service ends or on request; stored in Firebase, readable by the company team only; deleted automatically after 2 years or sooner on the owner's request. Used to set a returning restaurant up again |
| History file (orders, bills, table activity, guests' first names not yet replaced) | **30 days** after it's made | Given to the owner through an expiring download link; Wasabi's copy deleted after 30 days. Never used to restore history. Never kept on laptops or sent as an email attachment |
| Account notices emailed to owners (service ended, deletion coming) | Same as the account record | Each notice logged against the account (what, to whom, when, delivered) plus a blind copy to a company mailbox |
| Restaurant account record (name, owner's contact details, invoices, payments) | **At least 5 years** after the year of income | TRA record-keeping rule. Kept, marked deleted, after the restaurant's other data goes; phone and area dropped |
| Live demo rooms | 30 days | Deleted |
| Full database backups (contain diners' data) | **7 days rolling** (at most 30) | Overwritten. Kept in a separate storage area, in a separate Google project, with a delete lock so a hacked admin account can't wipe them. Deleted data disappears from backups within this time (said in the Privacy Policy) |
| Records log (what happened: closures, notices sent and delivered, deletions with reason and requester, payments, file made/sent/deleted). **Never** contains the deleted data itself or diners' data | **6 years** (tax rule: 5 years after the year of income, plus a margin) | Write-once in Firebase (added, never changed or deleted, by rule), plus the off-Firebase copies below. **Not built yet** (After registration 5/5) |
| Monthly records pack (readable spreadsheet of the month's events and payments, with the log's latest fingerprint) and blind copies of every notice to owners | **6 years** | Emailed to the records mailbox (e.g. records@wasabi.co.tz, a different provider and password from Firebase, 2-step sign-in). Owners also keep the notices and invoices they receive. **Not built yet** |
| Old version-1 data in top-level `alerts`, `config`, `groups`, `lines`, `sessions`, `tables`, `tablekeys` | Unused since restaurants moved under `restaurants/{rid}` | **Delete before launch** (unreachable by apps today, but still stored) |

The automatic deletions run as a scheduled job (to be built; see the checklist).

### Records that survive a compromise (decided 3 Nov 2026, not built yet)

Two kinds of thing are kept, handled differently:

- **Records** say *what happened* (who, what, when, why). They hold very little personal data and never diners' data, so they're kept long (6 years) and in several independent places.
- **Data backups** are full copies of the database, with diners' data, so they're kept short (7 days rolling, 30 at most) and tightly locked.

Records live in three places that don't depend on each other:

1. **In the app:** a write-once records log (the rules allow adding entries, never changing or deleting them, even for the company team), shown on a *Records* tab on the company page and downloadable as a spreadsheet.
2. **In the records mailbox, off Firebase:** a blind copy of every notice to an owner, and a monthly records pack.
3. **With the other side:** owners receive every notice and invoice in their own inbox.

**Tamper check:** each log entry carries a fingerprint (hash) of the entry before it, so the entries form a chain. The monthly records pack includes the latest fingerprint. If an old entry is changed or removed in Firebase, the chain stops matching the emailed fingerprints.

**If Firebase is compromised:** an attacker can at worst stop new entries. Past records survive in the records mailbox (separate provider and sign-in) and in owners' inboxes, and backups can't be deleted during their lock period.

## 5. Diners' rights (PDPA)

Diners can: know what we hold (privacy policy + My account), correct it (change name), delete it (delete
account), object to marketing (untick offers per restaurant, each change logged), and ask for a copy. Requests by
email to **security@wasabi.co.tz** (or privacy@ later) are answered within **30 days**.

## 6. Tanzania's data protection law: what Wasabi must do

Based on the PDPA and the 2023 Collection and Processing Regulations (to be confirmed with a Tanzanian lawyer):

1. **Register with the Personal Data Protection Commission (PDPC)** as a data controller and processor
   (registration lasts 5 years). *Not yet done: required before launch.*
2. **Cross-border transfer permit:** Firebase stores data outside Tanzania, so Wasabi needs a **PDPC permit**
   for the transfer, backed by Google's and Cloudflare's data protection terms (contractual safeguards).
   *Required before launch.* (Check the Firestore location; see the to-do list.)
3. **Appoint a data protection officer** (can be Vandan at first) who handles requests and complaints and sends
   the PDPC quarterly compliance reports.
4. **Report breaches to the PDPC without undue delay** using its prescribed format (see §7).
5. Keep the **privacy policy** (privacy.html) in line with this document; have it reviewed by a lawyer.

## 7. If data is exposed (incident steps)

1. **Contain** within the hour: revoke keys, make new staff codes or table codes, tighten the rule, pause the
   affected restaurant if needed, roll back the release.
2. **Assess:** what data, whose, how many, since when, root cause.
3. **Tell affected restaurants within 24 hours.**
4. **Notify the PDPC without undue delay** (aim: within 72 hours) with: controller/processor details, summary,
   assessment, notifications made, root cause, measures taken, improvements, supporting documents, declaration.
5. **Tell affected diners** without undue delay where they could be harmed (e.g. phone numbers exposed).
6. **Fix and learn:** add a test that would have caught it; update [Threat Model.md](Threat%20Model.md).
Keep a written record of every incident, even small ones.
