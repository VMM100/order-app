# Order App

Table-side ordering for restaurants in Dar es Salaam. Diners scan a QR code, join a shared table, order from their own phones and split the bill. Orders route to separate kitchen, bar and grill screens. The waiter who accepts a table gets that table's "Call waiter" and "Bill please" alerts, and diners see when the waiter is on the way.

Demo menu: Crafty Dee's Brewpub and Beer Garden (prices from public menu photos; confirm before use).

## Screens

Live at https://vmm100.github.io/order-app/ once GitHub Pages is on.

| Screen | Link |
| --- | --- |
| Setup (staff links, table QR codes, demo reset) | `#setup` |
| Diner at table 4 (what a table QR opens) | `?t=4` |
| Join by table code | `?c=1234` or the page with no table |
| Waiter | `#waiter` |
| Kitchen / Bar / Grill | `#kitchen`, `#bar`, `#grill` |

## Files

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `menu.js`: restaurant name, tables, waiter names, menu, prices and which station each section goes to
- `firebase.js`: Firebase project connection (public by design; access is controlled by Firestore rules)

## Data (Cloud Firestore)

- `tables/{n}`: current session, table code, waiter, guests, split mode, who has paid
- `lines`: one document per ordered item, with station and status (new → preparing → ready → served)
- `alerts`: call-waiter and bill requests, with on-my-way and done

The database currently runs in Firebase **test mode**, which allows anyone to read and write and expires after 30 days. Replace with proper rules and sign-in before real restaurant use.
