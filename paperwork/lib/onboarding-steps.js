// Wasabi's restaurant onboarding, from first contact to first payment: the one master list.
// Used by the printed checklist (templates/onboarding-checklist.html), the client sheet
// (templates/getting-started.html) and the Onboarding tracker page (tracker/onboarding-tracker.html,
// which carries a copy: republish it when this file changes). Decided with Vandan on 20 Nov 2026.
//
// kind:  collect = we get it from the restaurant · deliver = we give it to them · do = a task
// who:   W = Wasabi · R = restaurant · W+R = together
// file:  where the paper or file goes in Drive (05 Customers / <Name> (<link name>) / …)
// opt:   only some restaurants need it (the tracker can mark it "Not needed")
// needs: "printing" = only when they print kitchen and bar tickets through a Wasabi print box
// client: wording for the restaurant on the Getting started sheet (false: not shown there)
// due:   when it should be done: [from, days] where from is "signed" or "live"
(function (root) {
  const ONBOARDING = {
    version: "2026-11-20",
    trialDays: 30,       // the free trial starts on the go-live night
    liveWithinDays: 7,   // signed papers → first live night
    phases: [
      { id: "lead", name: "First contact", goal: "From hello to a yes" },
      { id: "signup", name: "Sign up", goal: "From a yes to signed papers" },
      { id: "collect", name: "Before set-up day", goal: "Everything we need from them" },
      { id: "prepare", name: "Prepare", goal: "Wasabi gets it ready, off site" },
      { id: "setup", name: "Set-up day", goal: "On site, with the staff" },
      { id: "live", name: "Go-live night", goal: "A quiet weekday, every table" },
      { id: "follow", name: "Follow-ups", goal: "Day 3, day 7 and before the trial ends" },
      { id: "paid", name: "First payment", goal: "Paid, filed, done" },
    ],
    steps: [
      // First contact
      { id: "lead-note", phase: "lead", kind: "do", who: "W", file: "00 Leads", title: "Note the lead in Drive", detail: "Place, area, kind of place, who you spoke to and how you met." },
      { id: "lead-demo", phase: "lead", kind: "deliver", who: "W", title: "Live demo on their own tables", detail: "Owner, and a waiter or bar lead if possible, each on their own phone." },
      { id: "lead-leave", phase: "lead", kind: "deliver", who: "W", title: "Leave the owners one-pager and a business card" },
      { id: "lead-follow", phase: "lead", kind: "do", who: "W", title: "Follow up within 3 days of the demo" },
      { id: "lead-yes", client: false, phase: "lead", kind: "collect", who: "R", title: "A yes, and the plan they want", detail: "Monthly or yearly." },

      // Sign up
      { id: "su-folder", phase: "signup", kind: "do", who: "W", title: "Make their Drive folder", detail: "05 Customers / Name (link name), with its 6 subfolders. Move anything from 00 Leads." },
      { id: "su-brela", client: "A copy of your BRELA certificate or business licence", phase: "signup", kind: "collect", who: "R", file: "01 Application", title: "BRELA certificate or business licence (copy)" },
      { id: "su-tin", client: "A copy of your TIN certificate", phase: "signup", kind: "collect", who: "R", file: "01 Application", title: "TIN certificate (copy)" },
      { id: "su-details", client: "Your registered name, address, opening hours and number of tables", phase: "signup", kind: "collect", who: "R", file: "01 Application", title: "Restaurant details", detail: "Registered name, address, opening hours, number of tables, kind of place." },
      { id: "su-owner", client: "The owner's name and phone, the Google account you'll sign in with, and an email for invoices", phase: "signup", kind: "collect", who: "R", file: "01 Application", title: "Owner's details", detail: "Full name, phone, the Google account they'll sign in with, and the email for invoices." },
      { id: "su-contacts", client: "Your manager, till or IT person and a staff champion, if you have them", phase: "signup", kind: "collect", who: "R", file: "01 Application", opt: true, title: "Other contacts, if they have them", detail: "Manager, till or IT person, and a staff champion (head waiter or bar lead): name and phone." },
      { id: "su-hardware", phase: "signup", kind: "do", who: "W+R", title: "Agree the hardware", detail: "Who supplies the bar and kitchen screens, whether they print tickets, who supplies the print box, and any set-up fee." },
      { id: "su-sign", phase: "signup", kind: "do", who: "W+R", file: "01 Application, 02 Agreement & DPA", title: "Application form and agreement signed and stamped", detail: "Two copies each. Pilot agreement until Wasabi's BRELA registration; then the service agreement. Scan the signed copies." },
      { id: "su-add", phase: "signup", kind: "do", who: "W", title: "Add the restaurant on the company page", detail: "With the owner's Google account. Public sign-up is off in pilot mode." },
      { id: "su-dates", phase: "signup", kind: "do", who: "W+R", title: "Book set-up day and the go-live night", detail: "Go live within 7 days of signing, on a quiet weekday." },
      { id: "su-welcome", client: "This sheet, a welcome letter and a guide to sending your menu", phase: "signup", kind: "deliver", who: "W", file: "05 Letters & notices", title: "Welcome letter, menu guide and Getting started sheet" },

      // Before set-up day (collect)
      { id: "col-menu", client: "Your menu: items, sizes, prices, allergy notes, and whether the bar or kitchen makes each one", phase: "collect", kind: "collect", who: "R", file: "04 Setup", title: "The menu", detail: "Sections, items, sizes, prices, and whether bar or kitchen makes each one. Allergy notes. Any form: Wasabi template, spreadsheet, PDF or photos." },
      { id: "col-photos", client: "Photos of your dishes and drinks, if you have them", phase: "collect", kind: "collect", who: "R", file: "04 Setup", opt: true, title: "Menu photos, if they have them", detail: "The menu goes live without photos if not." },
      { id: "col-logo", client: "Your logo (PNG or SVG, as large as you have) and your colours", phase: "collect", kind: "collect", who: "R", file: "04 Setup", title: "Logo file and colours", detail: "PNG or SVG, as large as they have." },
      { id: "col-staff", client: "Your staff's first names and roles", phase: "collect", kind: "collect", who: "R", file: "04 Setup", title: "Staff first names and roles", detail: "Waiters, bar, kitchen, managers. First names only. Managers' Google accounts if they'll use the manager page." },
      { id: "col-tables", client: "How your tables are numbered", phase: "collect", kind: "collect", who: "R", title: "Table numbers as they use them", detail: "And any shared or long tables." },
      { id: "col-screens", client: "A tablet or phone, a charging point and internet at the bar and in the kitchen (or ask us to supply them)", phase: "collect", kind: "collect", who: "R", title: "Where the bar and kitchen screens go", detail: "Which tablet or phone, a charging point at each, and how it gets internet (Wi-Fi or mobile data)." },
      { id: "col-printers", client: "If you'll print tickets: your printers' make and model, a network cable to the router, and your till or IT person on set-up day", phase: "collect", kind: "collect", who: "R", needs: "printing", title: "Printer details and the till or IT person", detail: "Make and model, a network cable to the router, router access. Tell the till (POS) supplier before any cable moves." },

      // Prepare (Wasabi)
      { id: "prep-menu", phase: "prepare", kind: "do", who: "W", title: "Load the menu and check every price with the owner" },
      { id: "prep-look", phase: "prepare", kind: "do", who: "W", title: "Set their look", detail: "Logo, colours and font." },
      { id: "prep-tables", client: "QR table cards and tent cards for every table, printed and laminated", phase: "prepare", kind: "deliver", who: "W", title: "Table cards and tent cards, printed and laminated", detail: "From Tables & QR. Included in the service." },
      { id: "prep-staff", phase: "prepare", kind: "do", who: "W", title: "Add waiters with PINs, and managers" },
      { id: "prep-printbox", phase: "prepare", kind: "do", who: "W", needs: "printing", title: "Set up the print box with their printers" },
      { id: "prep-cards", client: "Quick-start cards for waiters, bar and kitchen", phase: "prepare", kind: "deliver", who: "W", title: "Staff quick-start cards printed", detail: "Waiters, bar and kitchen." },
      { id: "prep-test", phase: "prepare", kind: "do", who: "W", title: "Test an order end to end before the visit" },

      // Set-up day
      { id: "set-cards", client: false, phase: "setup", kind: "deliver", who: "W", title: "Cards on every table" },
      { id: "set-screens", client: "Bar and kitchen screens set up, with sound", phase: "setup", kind: "deliver", who: "W", title: "Bar and kitchen screens open, sound on", detail: "Each opened with its staff code." },
      { id: "set-printers", client: "Order tickets on your own printers, through a Wasabi print box (if agreed)", phase: "setup", kind: "deliver", who: "W", needs: "printing", title: "Print box running, a test ticket at each printer", detail: "Printers on fixed addresses. Check the till still prints." },
      { id: "set-waiters", client: "Every waiter signed in on their own phone, with ringing tested", phase: "setup", kind: "deliver", who: "W+R", title: "Every waiter signed in on their own phone", detail: "Sign-in link sent by the owner or manager, PIN, ringing turned on and tested." },
      { id: "set-train", client: "Staff training on set-up day, about 20 minutes per station", phase: "setup", kind: "deliver", who: "W", title: "Training, about 20 minutes per station", detail: "Staff champion first. A quick-start card left at each station." },
      { id: "set-owner", client: "A walk-through of your owner page: sales, menu, sold out, staff", phase: "setup", kind: "deliver", who: "W", title: "Owner page walk-through", detail: "Dashboard, changing the menu and prices, sold out, staff and PINs." },
      { id: "set-test", phase: "setup", kind: "do", who: "W+R", title: "Full test with the staff", detail: "Order → bar and kitchen → ready → waiter → bill split." },
      { id: "set-pad", phase: "setup", kind: "do", who: "R", title: "Paper order pad at the bar, as a backup" },

      // Go-live night
      { id: "live-onsite", client: "Us on site on your first night, from opening until after the rush", phase: "live", kind: "deliver", who: "W", title: "On site from opening until after the rush" },
      { id: "live-trial", phase: "live", kind: "do", who: "W", title: "Start the free trial on the company page", detail: "Paid until: go-live night + 30 days." },
      { id: "live-notes", phase: "live", kind: "do", who: "W", title: "Write down every problem and request" },

      // Follow-ups
      { id: "fu-d3", phase: "follow", kind: "do", who: "W", due: ["live", 3], title: "Day 3: call the owner" },
      { id: "fu-d7", phase: "follow", kind: "do", who: "W+R", due: ["live", 7], title: "Day 7: visit for feedback", detail: "Owner, waiters, bar and kitchen. Agree the fixes." },
      { id: "fu-proforma", client: "A call on day 3, a visit on day 7, and a call before your free trial ends", phase: "follow", kind: "deliver", who: "W", file: "03 Invoices & receipts", due: ["live", 23], title: "A week before the trial ends: call, and send the pro-forma invoice" },

      // First payment
      { id: "pay-received", client: false, phase: "paid", kind: "collect", who: "R", due: ["live", 30], title: "Payment received" },
      { id: "pay-docs", client: "An invoice and receipt for every payment", phase: "paid", kind: "deliver", who: "W", file: "03 Invoices & receipts", title: "Invoice and receipt sent; paid-until set on the company page", detail: "Number logged in 04 Money." },
      { id: "pay-file", phase: "paid", kind: "do", who: "W", title: "Everything signed and scanned is in their Drive folder" },
    ],
  };
  // Due dates for the steps that don't carry their own.
  for (const s of ONBOARDING.steps) {
    if (s.due) continue;
    if (s.phase === "collect") s.due = ["signed", 3];
    if (s.phase === "prepare") s.due = ["signed", 5];
    if (s.phase === "setup") s.due = ["signed", 6];
    if (s.phase === "live") s.due = ["signed", 7];
  }
  root.ONBOARDING = ONBOARDING;
})(typeof window !== "undefined" ? window : globalThis);
