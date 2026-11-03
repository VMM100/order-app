# Print box: kitchen and bar tickets on the restaurant's printers

The print box is a small always-on computer plugged into the restaurant's router. It prints a ticket for every
Wasabi order, within a second or two, on the restaurant's Ethernet thermal printers. The bar screen can switch
printers off and on; every switch and every printer problem goes in the printer log.

Code: `bridge/` (print-box.js, lib.js, printer.js). Tests: `tests/print.mjs` (tickets and queue) and
`tests/print-e2e.mjs` (the real program against the database emulator and two pretend printers), both run on
every publish. Screens: `printers.js` (owner's Printers section on Tables & QR; the strip on bar, kitchen and
grill screens).

## How it works

```
Diner taps Place order → Wasabi (cloud)
                              ↓ internet
   Restaurant router ── print box (signs in like a staff phone, with the staff code)
        │                       ↓ ticket over the cable (port 9100)
        ├── Bar printer (fixed IP)
        ├── Kitchen printer (fixed IP)
        └── the till / POS (keeps printing to the same printers)
```

- One ticket per order per printer, with only the items for the stations that printer serves (a drink and a
  dish ordered together: a bar ticket and a kitchen ticket). Waiter orders and bar tabs print too.
- Never twice: each printed ticket is recorded (`printed/{order}_{printer}`).
- Printer not answering (no paper, off, cable out): the screens say so in red; the tickets print as soon as
  it's back (anything up to 12 hours old). Each stop and recovery goes in the log.
- Print box or internet down: the screens say "Print box not connected"; orders still show on the screens.
- **Switched off** on the bar screen (with a reason) or by the owner: no warnings, a grey "Off since 18:20 ·
  Out of paper (Bar screen)". Switching back on asks whether to print the tickets that came in meanwhile.
- **Reprint** on any ticket on the bar, kitchen or grill screen. **Test print** on the owner page.
- More printers later (grill, a second bar): add them on the owner page and tick their stations.

## What to buy (one box per restaurant)

- Raspberry Pi 4 or 5 (2 GB is plenty), its official power supply, a case, a 32 GB microSD card (A1 rated),
  and an Ethernet cable to the router. Or any small always-on PC with an Ethernet port running Debian or Ubuntu.
- A small UPS for the router and the box if the restaurant has frequent power cuts (the box restarts by
  itself, but a UPS avoids missed tickets during the cut).

## Network (do this with whoever looks after the till)

1. Plug the printers and the print box into the restaurant's router (or a switch connected to it). The router
   must reach the internet.
2. Give each printer a **fixed address**: in the router's settings, "DHCP reservation" for each printer's MAC
   address (or set a static IP on the printer itself). Write them down, e.g. bar 192.168.1.50, kitchen 192.168.1.51.
   Most printers print their settings when you hold the feed button while switching on.
3. **The till (Pilot POS) must be told the new printer addresses** if they change, or its own tickets stop
   printing. Arrange this with the POS supplier before moving any cables.
4. Staff phones don't need to be on this network; they can stay on mobile data.

## Setting up the box

1. Install Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager; set a strong password and turn on SSH.
2. Copy the `bridge` folder to the box (USB stick, or download the repository).
3. On the owner page: **Tables & QR → Kitchen and bar printers → + Add a printer**, once per printer (name, IP,
   port 9100, paper width, stations). Then open **Print box settings** and copy the settings into a file
   `config.json` in the `bridge` folder on the box.
4. On the box, in the `bridge` folder: `sudo ./install.sh`. It installs Node.js, sets the print box to start
   by itself (also after power cuts), and starts it.
5. Owner page: **Test print** on each printer. The screens should show "Ready".
6. Place a real test order at a test table and check both tickets.

Useful on the box: `journalctl -u wasabi-print-box -f` (what it's doing), `sudo systemctl restart wasabi-print-box`.
Without a printer you can try it with `node fake-printer.js 9100` and a printer address of the box itself.

## Security and data

- The box signs in with the restaurant's **staff code**, like a bar or kitchen phone: it can read that
  restaurant's orders and write print status, printed records and the log. It can't change orders, prices or
  settings, and can't see diner accounts. Keep `config.json` private. Making new staff codes signs it out:
  update `config.json` and restart it.
- The box makes outgoing connections only (to Firebase, and to the printers on port 9100). Nothing connects to it.
- Its log lists order and printer ids, never names or items.
- **Paper tickets carry guests' first names:** staff should bin them at the end of the night (Data Security.md).
- The printer log is write-once; it's kept with the restaurant's other records (deleted when the restaurant is).
