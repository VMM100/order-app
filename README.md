# Order App

Table-side ordering for restaurants in Dar es Salaam. Diners scan a QR code, join a shared table, order from their own phones and split the bill. Orders route to separate kitchen, bar and grill screens. The waiter who accepts a table gets that table's "Call waiter" and "Bill please" alerts, and diners see when the waiter is on the way.

Demo menu: Crafty Dee's Brewpub and Beer Garden (prices from public menu photos; confirm before use).

## Screens

Live at https://vmm100.github.io/order-app/ once GitHub Pages is on.

| Screen | Link |
| --- | --- |
| Demo stage: 3–4 live screens side by side on an iPad or laptop, using table 8 | `demo.html` |
| Setup (staff links, table QR codes, demo reset) | `#setup` |
| Owner: dashboard, menu editor with photos, look (name, logo, colours, fonts), staff, owner and manager PINs (starting PIN 1234) | `#owner` |
| Manager: menu editor and staff only (starting manager PIN 5678) | `#manager` |
| Diner at table 4 (what a table QR opens) | `?t=4` |
| Join by table code | `?c=1234` or the page with no table |
| Waiter | `#waiter` |
| Kitchen / Bar / Grill | `#kitchen`, `#bar`, `#grill` |

## Files

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `demo.html`, `demo.js`: demo stage that frames several app screens on one device
- `menu.js`: the starting menu, waiters and tables. After the owner first opens `#owner`, the menu and staff live in the database and are edited there.
- `metrics.js`: dashboard calculations (prep, pickup and order-to-table times, waiter response times and sales, sales by hour and day, best sellers) and the sample-week generator
- `firebase.js`: Firebase project connection (public by design; access is controlled by Firestore rules)

## Data (Cloud Firestore)

- `tables/{n}`: current session, table code, waiter, guests, split mode, who has paid
- `lines`: one document per ordered item, with station and status (new → preparing → ready → served)
- `lines` also record `tPrep`, `tReady`, `tServed` and `servedBy` for the dashboard
- `alerts`: call-waiter and bill requests, with on-my-way (`ack`, `ackBy`) and done (`doneAt`)
- `sessions/{session}`: one record per closed table (opened, closed, waiter, guests, total)
- `config/restaurant`: menu sections and items (with sold-out flags and photo ids), waiters, owner PIN, manager PIN, brand (name, logo id, two colours, font pair)
- `photos/{id}`: logo and menu photos, resized on the owner's phone (JPEG about 640px, logo PNG 360px) and stored as data URLs so no paid Storage plan is needed. Move to Firebase Storage or a CDN before scaling up.
- Sample data from the dashboard is marked `sample: true` and can be removed from the dashboard

The database currently runs in Firebase **test mode**, which allows anyone to read and write and expires after 30 days. Replace with proper rules and sign-in before real restaurant use.
