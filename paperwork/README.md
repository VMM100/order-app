# Wasabi paperwork

Wasabi's printed paperwork and print media as **blank templates**, in the Wasabi look, made into print-ready
PDFs by one script. This repository is public, so **customer details never go here**: filled copies, signed
scans and the files used to fill them live only in Google Drive (`Wasabi / 05 Customers / <Restaurant> (<link name>)`).
`node paperwork/check.mjs` enforces this, and runs in the checks before every publish.

## What's here

| Template | Makes | Filed in the restaurant's Drive folder |
| --- | --- | --- |
| `templates/pilot-letter.html` | Pilot agreement (free trial before the full agreement) | 02 Agreement & DPA |
| `templates/application-form.html` | Application form, filled from the online sign-up, checked and signed on the visit | 01 Application |
| `templates/service-agreement.html` | Service agreement: signature page for the Terms (incl. §11, the data processing agreement) | 02 Agreement & DPA |
| `../terms.html`, `../privacy.html` | The Terms and Privacy policy, printed from the website (same version as signed) | 02 Agreement & DPA |
| `templates/invoice.html` | Pro-forma invoice, invoice and receipt (one template, three documents) | 03 Invoices & receipts |
| `templates/welcome-letter.html` | Welcome letter to the owner | 05 Letters & notices |
| `templates/onboarding-checklist.html` | Steps from sign-up to the first week | 04 Setup |
| `templates/menu-guide.html` | How to send the menu; columns come from the app's menu template | 04 Setup |
| `templates/staff-cards.html` | Quick-start cards for waiters, bar and kitchen (3 to an A4, cut) | 04 Setup |
| `templates/letterhead.html` | Plain letterhead | |
| `print/business-card.html` | Business card, 85 × 55 mm | |
| `print/flyer-a5.html` | A5 flyer for owners | |
| `print/one-pager.html` | A4 one-pager for owners (leave behind after a demo) | |

Table cards and tent cards are printed from the app (Owner → Tables & QR → **Print table cards** /
**Print tent cards**), because each QR code carries the table's secret key, which must never leave the app.

Print pieces (`print/`) come out twice: **office** (as many as fit on A4, with crop marks) and **print-shop**
(trim size plus 3 mm bleed, one page per side).

## Making PDFs

```
node paperwork/build.mjs                       # every template, blank, into paperwork/out/ (ignored by git)
node paperwork/build.mjs invoice pilot-letter  # just these
node paperwork/build.mjs --data <customer.json> --out <folder>   # filled in for one restaurant
```

`--data` must be a file **outside** this repository (the script refuses otherwise). It holds the customer's
details, for example:

```json
{ "restaurant": "…", "restaurantLegal": "…", "restaurantAddress": "…", "restaurantTin": "…",
  "ownerName": "…", "ownerFirstName": "…", "ownerEmail": "…", "ownerPhone": "…", "rid": "…",
  "tables": 12, "trialEnd": "2026-11-20", "startDate": "2026-11-21",
  "docType": "Invoice", "number": "WSB-2026-001", "due": "2026-11-20",
  "lines": [{ "item": "Wasabi subscription, monthly", "period": "21 Nov – 20 Dec 2026", "qty": 1, "price": 130000 }] }
```

Anything left out prints as a blank line to fill in by hand. A customer file can't reuse the names of
Wasabi's own details (`phone`, `email`, `address`…): the script refuses, so Wasabi's number can't be replaced.

## Where the facts come from (so paper and app never disagree)

| Fact | Source |
| --- | --- |
| Prices, grace days, phone | `platform.js` (`COMPANY`) |
| Terms version and "Draft" | `terms.html` ("Version …") |
| Privacy policy version | `privacy.html` ("Last updated …") |
| Menu columns and example | `menuio.js` (`HEAD`, `EXAMPLE`) |
| Company name, emails, registration, TIN, how to pay | `paperwork/wasabi.json` |

**Keeping it up to date:** when a fee, term, address, sub-processor or feature changes, update the templates
that mention it in the same change, rebuild, and put the new blanks in Drive (`08 Product / Paperwork`) once
Vandan has OKed them. A new Terms version means re-signing: make a new service agreement for each restaurant.

## Look

Same rules as the app ([DESIGN.md](../DESIGN.md)): rice paper and ink, wasabi green as a fill, Bricolage
Grotesque for headings and Work Sans for text (local copies in `fonts/`, SIL OFL), and **one ginger-pink
accent per page** (`.pink`, a fill with ink text). English only. A4 for documents; nothing important closer
than 7 mm to a printed piece's edge.
