# Wasabi (order app)

Table-side ordering for restaurants in Dar es Salaam, run as a subscription service: each restaurant signs up, is approved by the company, and stays switched on while it pays. Diners scan a QR code, join a shared table, order from their own phones and split the bill. Orders route to separate kitchen, bar and grill screens. The waiter who accepts a table gets that table's "Call waiter" and "Bill please" alerts, and diners see when the waiter is on the way.

Demo menu: Crafty Dee's Brewpub and Beer Garden (prices from public menu photos; confirm before use).

## Versions

- **v1** (20 Oct 2026): first complete demo version, saved as the `v1` branch. Never changed after saving; new work goes on `main` and becomes v2.
- **v2** (in progress, on `main`). 23 Oct 2026: Wasabi branding (name, logo, favicon and app icons; Wasabi look on the company, sign-up and account pages; "Ordered with Wasabi" on the diner menu and bill), the diner welcome screen, and Crafty Dee's logo.

To go back to v1, ask for the code to be reset to the `v1` branch, or browse it at https://github.com/VMM100/order-app/tree/v1.

## Screens

Live at https://vmm100.github.io/order-app/. Every restaurant has an id (`r`), e.g. `crafty-dees`, carried in its links.

| Screen | Link |
| --- | --- |
| Company (you): applications, approve with a trial, record payments, pause, change owner, add restaurants, company team. First Google sign-in sets it up | `#company` |
| Sign-up: a restaurant registers and waits for approval | `#signup` |
| Owner: dashboard, menu, look, staff, managers, subscription. Without `r`, finds the restaurants this Google account runs | `?r=ID#owner` |
| Manager: menu and staff (Google account added by the owner) | `?r=ID#manager` |
| Tables & QR (Setup): number of tables, table QR codes, new code for one table or all, print table cards, staff QR codes, demo reset (owner or manager; open it from the ☰ menu on their pages) | `?r=ID#setup` |
| Demo stage: 3–4 live screens on one iPad or laptop, table 8 (company team only; linked from the company page) | `demo.html?r=ID` |
| Diner at a table (what a table QR opens; `k` is the table's secret key). The first time on a visit, a welcome screen shows the restaurant's logo as a sticker with "Powered by Wasabi"; one tap opens the table | `?r=ID&t=4&k=…` |
| Join friends with their group's code (the Share invite) | `?r=ID&c=1234` |
| Waiter (own phone, set up once from the staff QR; each shift starts with name + PIN and ends with End shift or after 16 hours) | `?r=ID&s=…#waiter` |
| Kitchen / bar / grill (set up once from their staff QR) | `?r=ID&s=…#kitchen` |
| Diner's account: visits at every restaurant | `#account` |

## Files

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `demo.html`, `demo.js`: demo stage that frames several app screens on one device
- `menu.js`: the starting menu, waiters and tables. After the owner first opens `#owner`, the menu and staff live in the database and are edited there.
- `account.js`: diner sign-in (Firebase Authentication: Google, and phone number with SMS code). Optional; guests still join with a first name.
- `brand.js`, `img/brand/`: Wasabi's logo (inline, for the app's own pages and stickers), favicon and home-screen icons
- `img/logos/`: built-in restaurant logos (Crafty Dee's), used until the owner uploads one under Look
- `photos.js`, `img/`: generic menu photos matched to items by name (free-licence photos from [Pexels](https://www.pexels.com/license/), 320px). An owner-uploaded photo always takes priority.
- `metrics.js`: dashboard calculations (prep, pickup and order-to-table times, waiter response times and sales, sales by hour and day, best sellers) and the sample-week generator
- `platform.js`: the company's name, contact, prices and grace period, shown to restaurants
- `firebase.js`: Firebase project connection (public by design; access is controlled by Firestore rules)
- `firestore.rules`: the database security rules (publish them in Firebase, see below)
- `tests/`: automatic tests for the rules, run on GitHub in Google's database emulator on every change (Actions → "Security rules tests")

## Data (Cloud Firestore)

Platform:
- `company/{email}`: the company team (Google accounts). `meta/company`: set when the first one claims the company page.
- `accounts/{id}`: one per restaurant: name, owner's Google email, phone, area, tables, `status` (`pending`, `active`, `suspended`), `paidUntil` (date), plan, last payment. Only the company changes it. `accounts/{id}/payments`: payment history.
- `diners/{uid}`, `visits/{…}`: diner accounts and their visits, across restaurants (each visit has its restaurant id). `offers` holds the diner's WhatsApp offers choice per restaurant.
- `diners/{uid}/consents`: proof of consent: every yes or no to a restaurant's offers, with the exact wording shown, its version, where it was given, the phone number and the time. Entries can't be edited; they're deleted with the account.

Each restaurant, under `restaurants/{id}`:
- the restaurant document: menu sections and items, `prices` ("item|option" → price and station, used by the rules to check orders), waiters, look, shared tables, number of tables
- `admins/{email}`: managers. `secrets/staff`: the staff QR token. `secrets/waiters`: each waiter's 4-digit PIN (owner and managers only). `staff/{uid}`: staff phones that scanned the staff QR, and the waiter on shift on that phone (name, PIN, shift start).
- `tablekeys/{n}`: each table QR's secret key. `passes/{uid}`: a diner's proof (table key or group code) and their group.
- `tables/{n}`, `groups/{session}`, `codes/{code}`, `lines`, `alerts`, `sessions`, `photos/{id}`: tables, parties, invite codes, ordered items, waiter alerts, closed tables, photos

## Security and subscriptions

Every phone signs in: diners quietly (Firebase anonymous sign-in) or with phone/Google, staff phones through the staff QR, owners, managers and the company with Google. `firestore.rules` enforces:

| Who | Can |
| --- | --- |
| Company team | Everything at every restaurant; approve, record payments, pause, change owners |
| Owner (the account's email) | Their restaurant: dashboard, look, menu, staff, managers, Setup. Can't change their own subscription |
| Manager | Menu, waiters, tables, Setup |
| Kitchen / bar / grill phone | See open orders; mark items preparing and ready |
| Waiter phone, on shift (name + PIN) | Take free tables for themselves, hand back their own, answer alerts and serve as themselves, mark paid, close. A changed PIN or ended shift stops this straight away |
| Diner with the table's QR key / a group's code | Join that table or group; order at menu prices; call the waiter; see their bill |
| Anyone | A running restaurant's menu and look; register a restaurant (it waits for approval) |

A restaurant runs while `status` is `active` and today is before `paidUntil` + 7 days. In the grace week the owner sees a payment warning. After it, or when paused, diners and staff are told to order with staff, and the owner sees how to renew. Nothing is deleted.

Known limits: 4-digit codes could in principle be guessed by a script, so they only work while a group is open and the waiter sees who joins. Firebase App Check can be added later.

### Turning it on (Firebase console, once)

1. Authentication → Sign-in method → add **Anonymous** and enable it.
2. Firestore Database → Rules: paste `firestore.rules` and **Publish**.
3. Open `#company` and sign in with Google to set up the company page. Add each restaurant there (or approve sign-ups).
4. The owner opens `#owner`, signs in, and finds their restaurant; Setup has the table and staff QR codes.

Tests: `tests/rules.test.mjs` runs on GitHub in Google's database emulator on every change to the rules (Actions → "Security rules tests").
