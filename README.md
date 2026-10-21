# Order App

Table-side ordering for restaurants in Dar es Salaam. Diners scan a QR code, join a shared table, order from their own phones and split the bill. Orders route to separate kitchen, bar and grill screens. The waiter who accepts a table gets that table's "Call waiter" and "Bill please" alerts, and diners see when the waiter is on the way.

Demo menu: Crafty Dee's Brewpub and Beer Garden (prices from public menu photos; confirm before use).

## Versions

- **v1** (20 Oct 2026): first complete demo version, saved as the `v1` branch. Never changed after saving; new work goes on `main` and becomes v2.
- **v2** (in progress, on `main`).

To go back to v1, ask for the code to be reset to the `v1` branch, or browse it at https://github.com/VMM100/order-app/tree/v1.

## Screens

Live at https://vmm100.github.io/order-app/ once GitHub Pages is on.

| Screen | Link |
| --- | --- |
| Demo stage: 3–4 live screens side by side on an iPad or laptop, using table 8 | `demo.html` |
| Setup (staff QR codes, keyed table QR codes, new codes, demo reset); owner or manager Google sign-in | `#setup` |
| Owner: dashboard, menu editor with photos, look (name, logo, colours, fonts), staff, who can sign in. The first Google sign-in here claims the restaurant | `#owner` |
| Manager: menu editor and staff only (Google sign-in, added by the owner) | `#manager` |
| Diner at table 4 (what a table QR opens; `k` is the table's secret key) | `?t=4&k=…` |
| Join a friend's table or group with its current code (the Share invite; stops working when it closes) | `?c=1234` |
| A bare table number (`?t=4`) asks for the table code instead of joining | |
| Diner's account: visits at every restaurant, offers setting, sign out, delete | `#account` |
| Waiter (opened once from the staff QR on Setup, `?s=…#waiter`) | `#waiter` |
| Kitchen / Bar / Grill (same, from their staff QR) | `#kitchen`, `#bar`, `#grill` |

## Files

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `demo.html`, `demo.js`: demo stage that frames several app screens on one device
- `menu.js`: the starting menu, waiters and tables. After the owner first opens `#owner`, the menu and staff live in the database and are edited there.
- `account.js`: diner sign-in (Firebase Authentication: Google, and phone number with SMS code). Optional; guests still join with a first name.
- `photos.js`, `img/`: generic menu photos matched to items by name (free-licence photos from [Pexels](https://www.pexels.com/license/), 320px). An owner-uploaded photo always takes priority.
- `metrics.js`: dashboard calculations (prep, pickup and order-to-table times, waiter response times and sales, sales by hour and day, best sellers) and the sample-week generator
- `firebase.js`: Firebase project connection (public by design; access is controlled by Firestore rules)
- `firestore.rules`: the database security rules (publish them in Firebase, see below)
- `tests/`: automatic tests for the rules, run on GitHub in Google's database emulator on every change (Actions → "Security rules tests")

## Data (Cloud Firestore)

- `tablekeys/{n}`: secret key printed in each table's QR code (replaced by "Make new QR codes"). Owners and managers only.
- `passes/{uid}`: a diner's proof of access: the table key they scanned, or the group code a friend shared, and the group they joined. The rules only accept a correct key or an open group's code.
- `codes/{code}`: which open group uses each 4-digit code. Anyone signed in can look up one code; nobody but staff can list them. Deleted when the group closes.
- `secrets/staff`: the token in the staff QR codes. Making new staff codes signs every staff phone out.
- `staff/{uid}`: a staff phone that opened the staff QR
- `admins/{email}`: owners and managers (Google accounts). `meta/claimed`: set when the first owner claims the restaurant.
- `groups/{session}`: one party ordering together; people are keyed by their sign-in id (table, 4-digit code, guests, waiter, split mode, who has paid, open/closed). Normal tables have one open group at a time; tables marked shared in Setup can have several.
- `tables/{n}`: pointer to the current group on a normal table
- `lines`: one document per ordered item, with station and status (new → preparing → ready → served)
- `lines` also record `tPrep`, `tReady`, `tServed` and `servedBy` for the dashboard
- `alerts`: call-waiter and bill requests, with on-my-way (`ack`, `ackBy`) and done (`doneAt`)
- `sessions/{session}`: one record per closed table (opened, closed, waiter, guests, total)
- `config/restaurant`: shared table numbers, menu sections and items (with sold-out flags and photo ids), waiters, brand (name, logo id, two colours, font pair), and `prices` ("item|option" → price and station, available items only), which the rules use to check every order
- `photos/{id}`: logo and menu photos, resized on the owner's phone (JPEG about 640px, logo PNG 360px) and stored as data URLs so no paid Storage plan is needed. Move to Firebase Storage or a CDN before scaling up.
- `diners/{uid}`: signed-in diner's profile (first name, phone or email, offers opt-in). One account works at every restaurant.
- `visits/{uid}_{session}_{person}`: a signed-in diner's visit, saved when the waiter closes the table (restaurant id and name, table, items, their share). Each restaurant only reads visits with its own `rid`; enforce this in Firestore rules before launch.
- Sample data from the dashboard is marked `sample: true` and can be removed from the dashboard

## Security

Every phone signs in: diners quietly (Firebase anonymous sign-in) or with phone/Google, staff phones through the staff QR, owners and managers with Google. `firestore.rules` then allows:

| Who | Can |
| --- | --- |
| Anyone | Read the menu, look and photos |
| Diner with a table's QR key | Start or join a group at that table; at shared tables, see the groups there |
| Diner with a group's code | Join that group only, while it's open |
| Diner in a group | See its orders, alerts and bill; add themselves; choose the split; order at menu prices; call the waiter or ask for the bill |
| Staff phone | See open groups, orders and alerts; accept, serve, mark ready, mark paid, close; save visits |
| Manager | Everything staff can, plus Setup, table and staff QR codes, menu and waiters |
| Owner | Everything, plus dashboard, look, and who can sign in |
| Signed-in diner | Their own profile and visits, and delete them |

Known limits: 4-digit codes could in principle be guessed by someone with a script, so codes only work while a group is open and the waiter sees everyone who joins. Firebase App Check can be added later to block scripts. Anonymous sign-ins pile up in Firebase Authentication; that's free and harmless.

### Turning it on (Firebase console, once)

1. Authentication → Sign-in method → add **Anonymous** and enable it.
2. Open the app's `#owner` page and sign in with Google: the first sign-in becomes the owner. Add managers under Owner → Staff.
3. Open `#setup` and scan the staff QR codes with the waiter, kitchen, bar and grill phones.
4. Firestore Database → Rules: paste `firestore.rules` and **Publish**. This replaces test mode.
