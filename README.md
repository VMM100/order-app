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
| Setup (staff links, keyed table QR codes, new codes, demo reset); needs owner or manager PIN | `#setup` |
| Owner: dashboard, menu editor with photos, look (name, logo, colours, fonts), staff, owner and manager PINs (starting PIN 1234) | `#owner` |
| Manager: menu editor and staff only (starting manager PIN 5678) | `#manager` |
| Diner at table 4 (what a table QR opens; `k` is the table's secret key) | `?t=4&k=…` |
| Join a friend's table or group with its current code (the Share invite; stops working when it closes) | `?c=1234` |
| A bare table number (`?t=4`) asks for the table code instead of joining | |
| Diner's account: visits at every restaurant, offers setting, sign out, delete | `#account` |
| Waiter | `#waiter` |
| Kitchen / Bar / Grill | `#kitchen`, `#bar`, `#grill` |

## Files

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `demo.html`, `demo.js`: demo stage that frames several app screens on one device
- `menu.js`: the starting menu, waiters and tables. After the owner first opens `#owner`, the menu and staff live in the database and are edited there.
- `account.js`: diner sign-in (Firebase Authentication: Google, and phone number with SMS code). Optional; guests still join with a first name.
- `photos.js`, `img/`: generic menu photos matched to items by name (free-licence photos from [Pexels](https://www.pexels.com/license/), 320px). An owner-uploaded photo always takes priority.
- `metrics.js`: dashboard calculations (prep, pickup and order-to-table times, waiter response times and sales, sales by hour and day, best sellers) and the sample-week generator
- `firebase.js`: Firebase project connection (public by design; access is controlled by Firestore rules)

## Data (Cloud Firestore)

- `tablekeys/{n}`: secret key printed in each table's QR code (replaced by "Make new QR codes")
- `groups/{session}`: one party ordering together (table, 4-digit code, guests, waiter, split mode, who has paid, open/closed). Normal tables have one open group at a time; tables marked shared in Setup can have several.
- `tables/{n}`: pointer to the current group on a normal table
- `lines`: one document per ordered item, with station and status (new → preparing → ready → served)
- `lines` also record `tPrep`, `tReady`, `tServed` and `servedBy` for the dashboard
- `alerts`: call-waiter and bill requests, with on-my-way (`ack`, `ackBy`) and done (`doneAt`)
- `sessions/{session}`: one record per closed table (opened, closed, waiter, guests, total)
- `config/restaurant`: shared table numbers, menu sections and items (with sold-out flags and photo ids), waiters, owner PIN, manager PIN, brand (name, logo id, two colours, font pair)
- `photos/{id}`: logo and menu photos, resized on the owner's phone (JPEG about 640px, logo PNG 360px) and stored as data URLs so no paid Storage plan is needed. Move to Firebase Storage or a CDN before scaling up.
- `diners/{uid}`: signed-in diner's profile (first name, phone or email, offers opt-in). One account works at every restaurant.
- `visits/{uid}_{session}_{person}`: a signed-in diner's visit, saved when the waiter closes the table (restaurant id and name, table, items, their share). Each restaurant only reads visits with its own `rid`; enforce this in Firestore rules before launch.
- Sample data from the dashboard is marked `sample: true` and can be removed from the dashboard

The database currently runs in Firebase **test mode**, which allows anyone to read and write and expires after 30 days. Replace with proper rules and sign-in before real restaurant use.
