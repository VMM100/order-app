# Auth.md: who gets in, and what they can do

Identity is Firebase Authentication. Permission is decided **only** by `firestore.rules` (the screens follow it).
Every phone is signed in, at least anonymously, so the rules always know *which phone* is asking.

## 1. How each person signs in

| Who | How they sign in | Session |
| --- | --- | --- |
| **Diner (guest)** | Nothing to do: an anonymous sign-in happens quietly. Proves they're at the table with the table's QR key or a friend's 4-digit code (a *pass*). | Until the table closes; the pass only works for that table's open group. |
| **Diner (account)** | Google or phone number (SMS code + reCAPTCHA). Optional; keeps visits and offers. | Firebase session on that phone until they log out or delete the account. |
| **Waiter** | Their phone scans the restaurant's **staff code** once, then each shift: tap their name + 4-digit **PIN**. | Shift ends on *End shift*, after **16 hours**, or when the owner changes their PIN or makes new staff codes. |
| **Kitchen, bar, grill** | Their phone scans its **staff code** once. | Until the owner makes new staff codes. |
| **Manager** | Google account the owner added under Staff. | Firebase session; access ends the moment the owner removes them. |
| **Owner** | The Google account on the restaurant's subscription (`accounts/{rid}.ownerEmail`, verified email). | Firebase session. Only Wasabi can change the owner. |
| **Wasabi company** | Google account listed in `company/{email}`, verified email, **Google 2-Step Verification required**. | Firebase session. |
| **Live demo participant** | Nothing: anonymous; scans the room QR. | Room is open 12 hours, then read-only. Can't reach real restaurants. |

## 2. What each role can do

| | Diner | Waiter (on shift) | Kitchen/bar/grill | Manager | Owner | Company |
| --- | --- | --- | --- | --- | --- | --- |
| See the menu | ✓ (while the restaurant is active) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Order, call waiter, ask for the bill | own table only, own name only | | | | | |
| See their table's orders and bill | own group only | all tables | all orders | ✓ | ✓ | ✓ |
| Accept tables, answer calls, serve, mark paid | | as themselves | | ✓ | ✓ | ✓ |
| Move orders to preparing / ready | | | ✓ | ✓ | ✓ | ✓ |
| Menu, prices, sold out, staff, PINs, tables & QR | | | | ✓ | ✓ | ✓ |
| Look (logo, colours), managers list | | | | | ✓ | ✓ |
| Dashboard and history | | | | ✓ | ✓ | ✓ |
| Subscription, approval, pause, change owner | | | | | sees it, can't change | ✓ |
| A diner's own profile, visits, offers | own only | | | | sees visits *to their restaurant* | |

Key rules behind this table (all tested in `tests/rules.test.mjs`):
- **Restaurant must be live** (active and paid, or within the 7-day grace week) for diners, staff and managers.
  The owner can still sign in and see why it's paused.
- **Diners** can only add themselves to a group, only change their own entry, only order items on the price list
  at the listed price and not sold out, only act on their own group.
- **Waiters** can only act while on shift with the current PIN; "served by" and "on my way" record the waiter
  on that phone, so one waiter can't act as another.
- **Managers** can't change the look, the managers list, the owner or the subscription.
- **Owners** can't change their own subscription status or paid-until date.
- **Wasabi company** can step into any restaurant to help, and is the only role that approves restaurants,
  records payments, pauses accounts and starts live demo rooms.

## 3. Sessions and taking access away

| To remove… | Do this | Effect |
| --- | --- | --- |
| A waiter | Owner → Staff → change or delete their PIN | Their next action is refused; shift ends. |
| A lost staff phone | Owner → Tables & QR → **Make new staff codes** | Every staff phone must scan again. |
| A leaked table card | Tables & QR → **New code** on that table | Old card stops working. |
| A manager | Owner → Staff → remove | Immediate. |
| A restaurant that doesn't pay | Company page → pause / paid-until passes + 7 days | Diners, staff and managers blocked. |
| A company member | Delete `company/{email}` (company page) | Immediate. Review the list **every quarter**. |
| A diner's account | They tap *Delete my account and data* | Profile, visits and consents deleted. |

## 4. The Wasabi company team

- Today: **vandanmamlani@gmail.com** only.
- Partners can be added later, each with their own Google account (never shared), **2-Step Verification on**,
  added by an existing company member on the company page, and reviewed every quarter.
- Company accounts are the most powerful in Wasabi: never use them on shared or restaurant devices; sign out
  of demo phones.

## 5. Machine access (keys used by services)

| Key | Where it lives | Can do | Can't do |
| --- | --- | --- | --- |
| `github-publish` service account (FIREBASE_SERVICE_ACCOUNT) | GitHub secret | Publish database rules and the staging site. **Publishing rules means it controls who can read data**, so it's only used by checked, reviewed workflow runs. | Read or change data directly; change billing |
| `wasabi-ringer` service account (RINGER_SERVICE_ACCOUNT) | GitHub secret → Cloudflare secret | Read calls/orders/shifts, write `rung`, send pushes (Datastore User, FCM Admin) | Change rules, hosting, billing |
| Cloudflare API token | GitHub secret | Publish the two ring services | Anything outside Workers |
| Firebase web config, Web Push public key | In code (public by design) | Identify the project | Nothing on their own: rules decide |

Rotate a key if it may have leaked, when someone with access leaves, and at least once a year.
