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
| Guest diners' orders, bills, names at tables | **12 months** | Deleted; restaurants keep totals (sales, counts) without names |
| Diner accounts, visits, consents | Until the diner deletes the account | *Delete my account and data* removes profile, visits and consents |
| Consent records after an account is deleted | Deleted with the account | (we keep no contact details, so no offers can be sent) |
| Alerts (calls, bill requests), `rung` records | 30 days | Deleted |
| Push addresses | Until the phone stops accepting them | Deleted automatically when Google reports them invalid |
| Restaurant data after it leaves Wasabi | 90 days (so it can come back) | Deleted on request or after 90 days |
| Live demo rooms | 30 days | Deleted |
| Backups | 7 days rolling | Overwritten |
| Old version-1 data in top-level `alerts`, `config`, `groups`, `lines`, `sessions`, `tables`, `tablekeys` | Unused since restaurants moved under `restaurants/{rid}` | **Delete before launch** (unreachable by apps today, but still stored) |

The automatic deletions run as a scheduled job (to be built; see the checklist).

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
