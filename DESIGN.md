# Wasabi: how the app should look

Read this before changing any screen. It is the short version of the Wasabi brand system
(https://claude.ai/artifact/PvCUPLYqpkyAfqJJB1ZYMb) as it applies to this code. Security rules come first:
see [CLAUDE.md](CLAUDE.md). Change this file when the brand or `styles.css` changes.

## Two looks in one app

Wasabi is white-label. Every screen belongs to one of two looks, and the CSS variables in `styles.css`
switch between them. Write screens with the variables, never with fixed colours.

| Screens | Look | How |
| --- | --- | --- |
| Diner menu, basket, bill, waiter, kitchen, bar, owner and manager pages | **The restaurant's** (owner page → Look: logo, two colours, display font) | Default `:root` variables; the restaurant's choices override `--accent`, `--hop` and `--display` at run time |
| Sign in, My account, sign-up, company page, live demo stage, Coming soon | **Wasabi's** | `body.wasabi` |
| Restaurant screens | A small Wasabi signature only | "Ordered with Wasabi" line (`poweredBy()`) and the "Spiced by Wasabi" badge on the welcome sticker |

Never put the Wasabi lockup or Wasabi green on a restaurant's screens beyond those two signatures.

## Colour

Use the variables; each has a light and dark value (dark mode follows the phone setting).

| Variable | Use |
| --- | --- |
| `--bg` | Page background (rice paper `#f6f4ee` in light) |
| `--surface` | Cards, sheets, inputs |
| `--fg` / `--muted` | Main text / secondary text (prices' units, times, notes) |
| `--line` | Hairlines and borders |
| `--accent` + `--accent-ink` | Main fill for primary actions; text on it is `--accent-ink` |
| `--hop` + `--hop-ink` / `--hop-soft` | Second colour: links, table codes, selected states / tinted bands |
| `--good`, `--warn`, `--crit` (+ `--crit-soft`) | Status only: ready, waiting, errors and destructive actions |

Wasabi's own colours (inside `body.wasabi`): wasabi green `#9cc43c` is a **fill** with ink `#1a2117` on it,
never white text on green; green as text is `#4a6716` (light) / `#b8db6c` (dark). Ginger `#f2a493` is the rare
accent: at most one per page, as a fill with ink text.

Text must reach 4.5:1 contrast in light and dark. Never show status by colour alone: pair it with a word.

## Type

- Body: Work Sans (`--body`), 15px on phones. Nothing a diner must read is smaller than 12px.
- Display (`--display`): Barlow Condensed uppercase on restaurant screens by default (the restaurant may pick
  another); Bricolage Grotesque, normal case, on Wasabi's pages.
- Inputs are always **16px or larger**, or iPhone Safari zooms in when they're tapped.
- Prices, totals and codes use tabular figures (`.num`). Money is written `TSh 12,500`: no decimals, comma
  thousands, via `fmt()`.

## Layout and shape

- One phone-width column, max 560px, 16px side gutter (`max(16px, env(safe-area-inset-*))`); staff screens
  may widen to two columns on tablets.
- Corners: 8px small buttons, 10–12px cards, bars, big buttons and sheets, full round for chips.
- Borders, not shadows. A shadow only for things that float: the basket bar, sheets, toasts.
- Respect safe areas (notch and home bar) on anything fixed to the top or bottom.

## Touch and controls (checked against Vercel's Web Interface Guidelines, docs/design/vendor/)

- **Every control at least 44px tall on touch screens.** Small visual controls (basket − / +, chips, quiet
  icon buttons, text links) keep their look and get a bigger invisible tap area (`::after` with negative inset).
  The `@media (pointer:coarse)` block at the end of `styles.css` does this; reuse those classes.
- Real `<button>` for actions and `<a href>` for navigation; never a clickable `div` or `span`.
- Every input has a visible `<label for>` or an `aria-label`. Icon-only buttons have `aria-label`.
- Keyboard focus shows a 2px `--accent` outline (`:focus-visible`). Never remove an outline without a replacement.
- Destructive actions ask twice: the button changes to "Tap again to …" (`S.armed`), or offer Undo.
- Buttons keep a clear label while working: "Sending…", "Starting your shift…" (with `…`), and are disabled
  while the request runs.
- Toasts and live changes are announced (`#toast` has `role="status"`). Errors use `role="alert"`.
- Motion only under `prefers-reduced-motion: no-preference`; animate `transform` and `opacity` only.
- Zoom is never disabled.

## Words

Plain English, short sentences, said the way a good waiter would say it.

- Buttons are verbs for what happens: **Place order**, **Call waiter**, **Ask for the bill**, **Split equally**.
- Say what happened, then what's next: "Sent to the kitchen. Your waiter is Amina."
- No exclamation marks, no emoji in the interface, no jargon ("session", "sync", "token").
- Error messages say how to fix it: "Could not save. Check your connection and try again."
- The product is **Wasabi** in sentences; the logo is the only place it's lowercase.

## Logo and icons

- Logo files: `img/brand/`. In code use `wasabiLockup()` and `wasabiLeaf()` from `brand.js`.
- Line icons on a 24px grid, 2px stroke, rounded ends, `currentColor`. No emoji as icons.

## Checks before a screen change ships

1. Looks right at 390px wide, in light and dark, with a long restaurant name and a long item name.
2. Every new control is 44px tall on a phone and has a label.
3. Run the screen through `docs/design/vendor/web-interface-guidelines/command.md`.
4. Same change in `demo/` if the live demo has that screen.
