---
version: alpha
name: Wasabi
description: >-
  Table ordering for bars, cafés and restaurants in Dar es Salaam. White-label: diner and staff screens wear
  the restaurant's look (defaults below); sign-in, account, company and demo pages wear Wasabi's own look
  (the wasabi-* tokens, `body.wasabi`). Values match styles.css; change both together.
colors:
  # Restaurant screens, light (default :root). The restaurant's own choices replace primary, secondary and the
  # display font at run time (owner page → Look).
  primary: "#a8650f"
  on-primary: "#ffffff"
  primary-soft: "#f6e7cf"
  secondary: "#3f5a2c"
  on-secondary: "#ffffff"
  secondary-soft: "#e3ead9"
  neutral: "#f6f4ee"
  background: "#f6f4ee"
  surface: "#ffffff"
  on-surface: "#22261f"
  on-surface-muted: "#5d6255"
  outline: "#dfdcd1"
  success: "#2f7a45"
  warning: "#8a520c"
  error: "#b23a2e"
  error-soft: "#fbe9e6"
  # Restaurant screens, dark (prefers-color-scheme: dark).
  dark-primary: "#e0a14a"
  dark-on-primary: "#1b1408"
  dark-primary-soft: "#3a2c16"
  dark-secondary: "#a9c38c"
  dark-on-secondary: "#16200f"
  dark-secondary-soft: "#2a3421"
  dark-background: "#161812"
  dark-surface: "#20231b"
  dark-on-surface: "#ecebe3"
  dark-on-surface-muted: "#a2a596"
  dark-outline: "#34382c"
  dark-success: "#6cc487"
  dark-warning: "#e5a24d"
  dark-error: "#ec7a6c"
  dark-error-soft: "#3d1f1a"
  # Wasabi's own pages (body.wasabi), light then dark.
  wasabi-green: "#9cc43c"
  on-wasabi-green: "#1a2117"
  wasabi-green-soft: "#e8f0d2"
  wasabi-green-text: "#4a6716"
  on-wasabi-green-text: "#ffffff"
  wasabi-ginger: "#f2a493"
  dark-wasabi-green: "#a9d14a"
  dark-on-wasabi-green: "#121610"
  dark-wasabi-green-soft: "#2a3a1c"
  dark-wasabi-green-text: "#b8db6c"
typography:
  # Restaurant screens: Barlow Condensed uppercase display by default (the restaurant may choose another).
  headline-display:
    fontFamily: Barlow Condensed
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.02em
  # Wasabi's pages: Bricolage Grotesque, normal case.
  wasabi-headline-display:
    fontFamily: Bricolage Grotesque
    fontSize: 26px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: -0.01em
  title-md:
    fontFamily: Work Sans
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.3
  body-md:
    fontFamily: Work Sans
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.45
  body-sm:
    fontFamily: Work Sans
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
  label-md:
    fontFamily: Work Sans
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.2
  label-sm:
    fontFamily: Work Sans
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.2
  input:
    fontFamily: Work Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.3
  price:
    fontFamily: Work Sans
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.45
    fontFeature: '"tnum" 1'
rounded:
  sm: 8px
  md: 10px
  lg: 12px
  xl: 18px
  full: 999px
spacing:
  base: 16px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  gutter: 16px
  column-max: 560px
  touch-target: 44px
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    height: 44px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    height: 44px
  button-big:
    backgroundColor: "{colors.secondary-soft}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 14px
    height: 48px
  button-big-wasabi:
    backgroundColor: "{colors.wasabi-green}"
    textColor: "{colors.on-wasabi-green}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 14px
    height: 48px
  button-destructive:
    backgroundColor: "{colors.error-soft}"
    textColor: "{colors.error}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    height: 44px
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: 6px 12px
    height: 44px
  chip-selected:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
    rounded: "{rounded.full}"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.input}"
    rounded: "{rounded.md}"
    padding: 12px 14px
    height: 48px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 14px
  menu-item:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.title-md}"
    padding: 14px 0
  basket-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    padding: 12px 16px
  toast:
    backgroundColor: "{colors.on-surface}"
    textColor: "{colors.surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  sign-in-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xl}"
    padding: 26px 20px
---

# Wasabi: how the app should look

Read this before changing any screen. It follows Google's DESIGN.md format (alpha): the tokens above are the
exact values, the sections below say how to use them. It is the short version of the Wasabi brand system
(https://claude.ai/artifact/PvCUPLYqpkyAfqJJB1ZYMb) as it applies to this code. Security rules come first: see
[CLAUDE.md](CLAUDE.md). Change this file when the brand or `styles.css` changes, and keep the two in step.

## Overview

Wasabi lets diners order from their own phone at the table, call the waiter and split the bill, and gives
waiters, the kitchen, the bar and owners their own screens. It should feel like a good waiter: calm, quick,
friendly, never loud. Phone first, one hand, often in a dim bar on a mid-range Android.

**Wasabi is white-label.** Every screen belongs to one of two looks, and the CSS variables in `styles.css`
switch between them. Write screens with the variables, never with fixed colours.

| Screens | Look | How |
| --- | --- | --- |
| Diner menu, basket, bill, waiter, kitchen, bar, owner and manager pages | **The restaurant's** (owner page → Look: logo, two colours, display font) | Default `:root` variables (`primary`, `secondary`, `headline-display` above); the restaurant's choices override `--accent`, `--hop` and `--display` at run time |
| Sign in, My account, sign-up, company page, live demo stage, Coming soon, For owners | **Wasabi's** | `body.wasabi` (the `wasabi-*` tokens) |
| Restaurant screens | A small Wasabi signature only | "Ordered with Wasabi" line (`poweredBy()`) and the "Spiced by Wasabi" badge on the welcome sticker |

New restaurants start in Wasabi's own look until the owner picks theirs; Crafty Dee's uses Brewhouse.

## Colors

Use the CSS variables; each has a light and a dark value (dark mode follows the phone setting).

| Token (light / dark) | CSS variable | Use |
| --- | --- | --- |
| `background` / `dark-background` | `--bg` | Page background: rice paper in light |
| `surface` / `dark-surface` | `--surface` | Cards, sheets, inputs |
| `on-surface`, `on-surface-muted` | `--fg`, `--muted` | Main text; secondary text (units, times, notes) |
| `outline` | `--line` | Hairlines and borders |
| `primary` + `on-primary`, `primary-soft` | `--accent`, `--accent-ink`, `--accent-soft` | Main fill for primary actions, with its ink on top; tinted selection |
| `secondary` + `on-secondary`, `secondary-soft` | `--hop`, `--hop-ink`, `--hop-soft` | Second colour: links, table codes, selected states; tinted bands |
| `success`, `warning`, `error` (+ `error-soft`) | `--good`, `--warn`, `--crit`, `--crit-soft` | Status only: ready, waiting, errors and destructive actions |

**Wasabi's own colours** (inside `body.wasabi`):
- **Wasabi green** (`wasabi-green`) is a **fill**, always with dark ink `on-wasabi-green` on it, never white text
  on green.
- As text, green is `wasabi-green-text` in light and `dark-wasabi-green-text` in dark.
- **Ginger** (`wasabi-ginger`) is the rare accent: at most one per page, as a fill with ink text.

Text must reach 4.5:1 contrast in light and dark. Never show status by colour alone: pair it with a word.

## Typography

- **Body:** Work Sans (`--body`), 15px on phones (`body-md`). Nothing a diner must read is smaller than 12px
  (`label-sm`).
- **Display** (`--display`):
  - restaurant screens: Barlow Condensed, uppercase by default (`headline-display`); the restaurant may pick
    another font;
  - Wasabi's pages: Bricolage Grotesque, normal case (`wasabi-headline-display`).
- **Inputs** are always **16px or larger** (`input`), or iPhone Safari zooms in when they're tapped.
- **Prices, totals and codes** use tabular figures (`.num`, the `price` token). Money is written `TSh 12,500`:
  no decimals, comma thousands, via `fmt()`.

## Layout

- **One phone-width column**, max 560px (`column-max`), with a 16px side gutter
  (`max(16px, env(safe-area-inset-*))`). Staff screens may widen to two columns on tablets.
- **Spacing** steps are 4, 8, 12, 16 and 24px (`spacing`).
- **Safe areas:** anything fixed to the top or bottom respects the notch and home bar.
- The basket bar sits fixed at the bottom; page content leaves room for it.

## Elevation & Depth

- **Flat by default:** borders (`outline`), not shadows. Hierarchy comes from surface on background and from
  weight and size.
- **A shadow only for things that float:** the basket bar, sheets and menus, toasts, the sign-in card.
- A highlighted ticket or selected option gets a 1px ring in `primary`, not a shadow.

## Shapes

Soft but not bubbly.
- 8px (`sm`): small buttons.
- 10px (`md`): inputs and big buttons.
- 12px (`lg`): cards and bars.
- 18px (`xl`): the sign-in card.
- Full round (`full`): chips and badges.

## Components

The tokens above give each component's exact colours, type, corners and padding. Behaviour:

- **Touch targets:** every control is at least 44px tall on touch screens (`touch-target`). Small visual
  controls (basket − / +, chips, quiet icon buttons, text links) keep their look and get a bigger invisible
  tap area (`::after` with negative inset). The `@media (pointer:coarse)` block at the end of `styles.css`
  does this; reuse those classes.
- **Real elements:** a `<button>` for actions and an `<a href>` for navigation; never a clickable `div` or
  `span`.
- **Labels:** every input has a visible `<label for>` or an `aria-label`. Icon-only buttons have `aria-label`.
- **Focus:** keyboard focus shows a 2px `--accent` outline (`:focus-visible`). Never remove an outline
  without a replacement.
- **Destructive actions** ask twice: the button changes to "Tap again to …" (`S.armed`), or offer Undo.
- **Working state:** buttons keep a clear label while working ("Sending…", "Starting your shift…", with `…`)
  and are disabled while the request runs.
- **Announcements:** toasts and live changes are announced (`#toast` has `role="status"`). Errors use
  `role="alert"`.
- **Motion:** only under `prefers-reduced-motion: no-preference`; animate `transform` and `opacity` only.
- **Zoom** is never disabled.

## Do's and Don'ts

- Do write every screen with the CSS variables; don't hard-code a colour.
- Don't put the Wasabi lockup or Wasabi green on a restaurant's screens beyond the two signatures.
- Do use the primary fill for the one main action on a screen (Place order, Start, Bill please).
- Don't put white text on wasabi green; use the dark ink.
- Do pair every status colour with a word ("Ready", "Waiting").
- Don't make anything a diner must read smaller than 12px, or any input smaller than 16px.
- Do keep money as `TSh 12,500` with tabular figures.
- Don't add shadows to things that don't float.
- Don't use emoji as icons or in the interface.

## Words

Plain English, short sentences, said the way a good waiter would say it.

- **Buttons** are verbs for what happens: **Place order**, **Call waiter**, **Ask for the bill**,
  **Split equally**.
- **Say what happened, then what's next:** "Sent to the kitchen. Your waiter is Amina."
- **Tone:** no exclamation marks, no emoji in the interface, no jargon ("session", "sync", "token").
- **Error messages** say how to fix it: "Could not save. Check your connection and try again."
- **The name:** the product is **Wasabi** in sentences; the logo is the only place it's lowercase.

## Logo and icons

- **Logo files:** `img/brand/`. In code use `wasabiLockup()` and `wasabiLeaf()` from `brand.js`.
- **Icons:** line icons on a 24px grid, 2px stroke, rounded ends, `currentColor`.

## Paper

Printed paperwork and print media follow the same look: see [paperwork/README.md](paperwork/README.md).
Printed table and tent cards are in the restaurant's look with the small "Spiced by Wasabi" badge, like its
screens.

## Checks before a screen change ships

1. It looks right at 390px wide, in light and dark, with a long restaurant name and a long item name.
2. Every new control is 44px tall on a phone and has a label.
3. Run the screen through `docs/design/vendor/web-interface-guidelines/command.md`.
4. Make the same change in `demo/` if the live demo has that screen.
5. If a colour, size or corner changed in `styles.css`, change the tokens at the top of this file too.
