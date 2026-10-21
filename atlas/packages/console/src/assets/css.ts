// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The whole stylesheet, as one string, inlined into the document.
 *
 * ## Why a string and not a file
 *
 * There is no web build in this repository — `vite.config.ts` bundles the CLI,
 * and `src/components/**` is Ink, which is terminal output that happens to be
 * written in JSX. Adding a second front-end pipeline to serve one operator page
 * would cost more than the page. So: a constant, inlined by `renderPage`, no
 * asset route, no cache-busting, no `<link>`.
 *
 * That is also a security property. The page loads **nothing** from anywhere —
 * no CDN, no web font, no remote image — so there is no third party that can
 * change what an operator sees, and the CSP in the document head can be tight
 * enough to say so.
 *
 * ## Where the token set comes from
 *
 * The palette is the one the conversation front speaks, so the management side
 * under `/admin` and the front read as one product: a near-white ground
 * (`#fcfcfb`) and a surface one step off it (`#f6f6f5`), near-black ink,
 * amber as the accent and the logo's sage (`#5e866c`) as the second accent,
 * each with a nine-step ramp on one shared lightness scale. The filled
 * controls take the reader's theme colour (`--color-accent-fill`, set from
 * `view/accent.ts`), ink when they have not picked one. Radii are 8 / 12 / 18px
 * and small controls go full pill; spacing is a six-step scale, and elevation
 * is two soft shadows plus one for the dialog. The structure below came from
 * the **Organic** design system, and keeps its rules:
 *
 * Three of those are worth stating, because each replaced a rule the
 * previous (shadcn-derived) sheet held:
 *
 * **① Cards are a surface, not a bordered box.** `--color-surface` sits a step
 * off `--color-bg`, so a card is legible without a hairline around it. What is
 * still bordered is the *input well* — Organic gives `.input` the same surface
 * colour as `.card`, and on a data-entry page an input that matches the card it
 * sits on disappears. So `.card .input` drops back to `--color-bg`.
 *
 * **② The dark scheme is a token flip, not a second sheet.** Every component
 * class below is written once. The dark block redefines the same custom
 * properties with the ramps' semantic direction reversed — light: 100 is a pale
 * fill and 900 is dark text; dark: 100 is a dark fill and 900 is pale text — so
 * `.tag-accent` ("background 100, text 800") keeps working byte for byte. There
 * is exactly one thing that flip cannot express, and it is why `--color-scrim`
 * exists: the dialog backdrop used to borrow `--color-neutral-900`, which after
 * the flip is the *lightest* step and would wash the screen with light instead
 * of dimming it.
 *
 * **③ Colour still states a fact; shape carries it too.** The four roster
 * states are four different *shapes* — filled disc, hollow accent ring,
 * neutral bar, hollow neutral ring — so the roster is readable without colour
 * vision. `--color-accent` is additionally spent on the primary action and on
 * the focus ring, which is the one deliberate exception, unchanged from the
 * previous sheet.
 *
 * ## Fonts, and why there is no `@font-face`
 *
 * Organic's own reference sheet opens with an `@import` of two Google fonts.
 * That line cannot come across: the console's CSP is `default-src 'none'` with
 * `font-src 'none'`, and a render-blocking request to a third party is exactly
 * what the inline-everything rule exists to prevent. The interface language is
 * Chinese, so the loss is smaller than it sounds — neither display face carries
 * CJK glyphs, which means the wordmark and nearly all body copy were already
 * falling through to the system stack. What changes is the Latin: headings buy
 * their hierarchy back with weight, size and letter-spacing instead of a display
 * face (`--font-heading-weight: 600`, the one deliberate deviation from
 * Organic's own `400`).
 *
 * ## No `url()`, anywhere
 *
 * Every icon on the page is an inline `<svg>` emitted by the view layer, and
 * that includes the `<select>` chevrons, which are absolutely positioned inside
 * a `.sel` wrapper rather than painted as a background image. `bun test` pins
 * this: a `url(` in here is either a remote fetch the CSP will refuse or a data
 * URI, and both are ways for the sheet to stop being one self-contained string.
 */

import { accentCss } from '../view/accent.js'

/**
 * A stylesheet without its comments (G1).
 *
 * The notes in this file are for whoever edits it; every document used to
 * carry them to every browser. No string in these sheets contains the
 * comment opener, so a plain scan is exact; blank lines left behind are
 * folded too. Whitespace inside a declaration is left as written.
 */
export function stripCssComments(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
}

/** The sheet as written, comments and all; {@link CONSOLE_CSS} is what ships. */
// P18.17: touch targets keep room for fingers. Last in the sheet, so the
// compact sizes of buttons and fields above give way to it on a phone.
const TOUCH_CSS = `
@media (pointer: coarse), (max-width: 600px) {
  button, .btn, .nav-item, summary, select, input:not([type=checkbox]):not([type=radio]), .linkish { min-height: 44px; }
  button, .btn, .linkish { min-width: 44px; }
  label:has(input[type=checkbox]), label:has(input[type=radio]) { min-height: 44px; display: inline-flex; align-items: center; }
}
`

const SOURCE_CSS = `
:root {
  color-scheme: light dark;

  /* Grounds, warm grey: the page, the side panel a step darker, a card and
     a menu or field a step lighter. */
  --color-bg: #f9f9f7;
  --color-side: #f3f2ee;
  --color-surface: #fdfdfc;
  --color-field: #ffffff;
  --color-text: #141413;
  --color-text-3: #898781;
  --color-accent: #c98a2e;
  --color-accent-2: #5e866c;
  --color-divider: rgba(20, 20, 19, 0.09);

  /* The interaction colour: focus, a switch that is on, the checked box, a
     link in running text, the unread dot. Never a resting surface. The brand
     terracotta only ever fills the brand. */
  --color-interactive: #2a78d6;
  --color-interactive-text: #1f64ba;
  --color-interactive-soft: rgba(42, 120, 214, 0.12);
  --color-focus: #2a78d6;
  --color-brand: #d97757;

  /* Status, four variants each: a fill, its text on the page, a border and a
     tinted ground. Warning and danger keep the ramps below as their source. */
  --color-success-fill: #4b6f58;
  --color-success-text: #2f5a3f;
  --color-success-border: rgba(75, 111, 88, 0.35);
  --color-success-bg: #edf3ef;
  --color-warning-fill: #c98a2e;
  --color-warning-text: #7a4f12;
  --color-warning-border: rgba(201, 138, 46, 0.4);
  --color-warning-bg: #fbf2e3;
  --color-danger-fill: #b83a26;
  --color-danger-text: #a53322;
  --color-danger-border: rgba(184, 58, 38, 0.35);
  --color-danger-bg: #fbece8;

  --color-neutral-100: #f3f2ee;
  --color-neutral-200: #e9e8e3;
  --color-neutral-300: #dcdbd5;
  --color-neutral-400: #c2c0b9;
  --color-neutral-500: #9e9c95;
  --color-neutral-600: #7c7a74;
  --color-neutral-700: #5e5c57;
  --color-neutral-800: #42413d;
  --color-neutral-900: #282725;

  --color-accent-100: #fcf3e4;
  --color-accent-200: #f8e2bf;
  --color-accent-300: #f0c88a;
  --color-accent-400: #e3a756;
  --color-accent-500: #c98a2e;
  --color-accent-600: #a76f1d;
  --color-accent-700: #825515;
  --color-accent-800: #5e3d10;
  --color-accent-900: #3d280b;

  --color-accent-2-100: #edf3ef;
  --color-accent-2-200: #d5e4da;
  --color-accent-2-300: #b2ccbb;
  --color-accent-2-400: #86ab93;
  --color-accent-2-500: #5e866c;
  --color-accent-2-600: #4b6f58;
  --color-accent-2-700: #3b5845;
  --color-accent-2-800: #2b4133;
  --color-accent-2-900: #1c2b22;

  --color-critical: #b83a26;

  /* Dialog scrim. Not a ramp step: the ramps flip direction in dark, and a
     backdrop that flips with them stops being a backdrop. */
  --color-scrim: #111110;

  /* Secondary text. 68% is the least that keeps 4.5:1 on every ground the
     sheet paints, in both schemes - the tag pill over the surface is the
     darkest (B1, test/browser/contrast.browser.test.ts). */
  --color-muted: color-mix(in srgb, var(--color-text) 68%, transparent);
  --color-quiet: color-mix(in srgb, var(--color-text) 78%, transparent);
  /* A fill with --color-bg text on it: the primary button, the checked
     segment of the front. The reader's theme colour (view/accent.ts), ink
     when they have not picked one. */
  --color-accent-fill: var(--qm-accent, #141413);
  --color-accent-fill-hover: color-mix(in srgb, var(--color-accent-fill) 86%, var(--color-bg));
  --color-accent-fill-active: var(--color-accent-fill);
  --color-on-accent-fill: var(--qm-accent-ink, #fafaf9);
  --qm-ink: #222623;

  /* Type: 11 caption, 12 footnote, 13 body, 14 heading, 20 title. The half
     sizes the pages were written with fold onto that scale. */
  --text-10: 10px;
  --text-10-5: 11px;
  --text-11: 11px;
  --text-11-5: 11px;
  --text-12: 12px;
  --text-12-5: 12px;
  --text-13: 13px;
  --text-13-5: 13px;
  --text-14: 14px;
  --text-14-5: 14.5px;
  --text-15: 15px;
  --text-16: 14px;
  --text-17: 14px;
  --text-18: 14px;
  --text-20: 20px;
  --text-21: 20px;
  --text-22: 20px;
  --text-24: 20px;
  --text-28: 20px;
  --text-29: 20px;
  --text-34: 20px;
  --text-40: 20px;
  --radius-pill: 999px;
  --z-menu: 30;
  --z-toast: 40;
  --z-skip: 50;
  --font-body: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --font-heading: var(--font-body);
  --font-heading-weight: 600;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  /* Compact spacing: 4 / 8 / 12 / 16 / 20 / 24 / 32. */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;

  /* Radii: 2 / 4 / 6 / 8 / 12 / 16 / 24. A control is 6 or 8, a card 12, a
     dialog 16, the front's composer 24. Only a tag, a dot and a switch are
     round. */
  --radius-2xs: 2px;
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
  --radius-3xl: 24px;

  --shadow-sm: 0 0 0 0.5px rgba(20, 20, 19, 0.12), 0 1px 2px rgba(0, 0, 0, 0.03);
  --shadow-md: 0 0 0 0.5px rgba(20, 20, 19, 0.1), 0 4px 14px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 0 0 0.5px rgba(20, 20, 19, 0.1), 0 12px 32px rgba(0, 0, 0, 0.12);

  /* The quiet layer both sides draw their controls with, all of it the text
     colour made translucent: a row under the pointer (5%), the current row
     (8%), a field (4%), a control's border (14%), a menu's ground. */
  --ui-hover: rgba(20, 20, 19, 0.05);
  --ui-selected: rgba(20, 20, 19, 0.08);
  --ui-field: rgba(20, 20, 19, 0.04);
  --ui-line: rgba(20, 20, 19, 0.14);
  --ui-menu: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #1a1a19;
    --color-side: #121211;
    --color-surface: #20201f;
    --color-field: #262625;
    --color-text: #f0efec;
    --color-text-3: #898781;
    --color-accent: #e2a957;
    --color-accent-2: #86ad93;
    --color-divider: rgba(240, 239, 236, 0.09);

    --color-interactive: #4a90e2;
    --color-interactive-text: #7ab0ee;
    --color-interactive-soft: rgba(74, 144, 226, 0.2);
    --color-focus: #5c9ce6;
    --color-brand: #d97757;

    --color-success-fill: #86ad93;
    --color-success-text: #a8c5b2;
    --color-success-border: rgba(134, 173, 147, 0.4);
    --color-success-bg: #1d2a22;
    --color-warning-fill: #e2a957;
    --color-warning-text: #efc386;
    --color-warning-border: rgba(226, 169, 87, 0.4);
    --color-warning-bg: #2e2416;
    --color-danger-fill: #e0705c;
    --color-danger-text: #ff9a86;
    --color-danger-border: rgba(255, 143, 122, 0.4);
    --color-danger-bg: #36201b;

    --color-neutral-100: #242423;
    --color-neutral-200: #2c2c2a;
    --color-neutral-300: #383836;
    --color-neutral-400: #4d4d4a;
    --color-neutral-500: #6b6a66;
    --color-neutral-600: #898781;
    --color-neutral-700: #a8a69f;
    --color-neutral-800: #c9c7c0;
    --color-neutral-900: #e6e4de;

    --color-accent-100: #2c200f;
    --color-accent-200: #453118;
    --color-accent-300: #694a21;
    --color-accent-400: #93672b;
    --color-accent-500: #c98a2e;
    --color-accent-600: #e2a957;
    --color-accent-700: #efc386;
    --color-accent-800: #f7dcb6;
    --color-accent-900: #fcefdc;

    --color-accent-2-100: #142019;
    --color-accent-2-200: #1d2f24;
    --color-accent-2-300: #2b4535;
    --color-accent-2-400: #3d604a;
    --color-accent-2-500: #6a9479;
    --color-accent-2-600: #86ad93;
    --color-accent-2-700: #a8c5b2;
    --color-accent-2-800: #cadccf;
    --color-accent-2-900: #e7f0ea;

    --color-critical: #ff8f7a;

    --color-scrim: #000000;

    --color-accent-fill: var(--qm-accent, #f0efec);
    --color-accent-fill-hover: color-mix(in srgb, var(--color-accent-fill) 86%, var(--color-bg));
    --color-accent-fill-active: var(--color-accent-fill);
    --color-on-accent-fill: var(--qm-accent-ink, #141413);
    --qm-ink: #e6ebe7;

    --shadow-sm: 0 0 0 0.5px rgba(240, 239, 236, 0.1);
    --shadow-md: 0 0 0 0.5px rgba(240, 239, 236, 0.12), 0 6px 18px rgba(0, 0, 0, 0.45);
    --shadow-lg: 0 0 0 0.5px rgba(240, 239, 236, 0.14), 0 16px 44px rgba(0, 0, 0, 0.6);

    --ui-hover: rgba(240, 239, 236, 0.05);
    --ui-selected: rgba(240, 239, 236, 0.08);
    --ui-field: rgba(240, 239, 236, 0.05);
    --ui-line: rgba(240, 239, 236, 0.14);
    --ui-menu: #262625;
  }
}

:root[data-theme="dark"] {
    --color-bg: #1a1a19;
    --color-side: #121211;
    --color-surface: #20201f;
    --color-field: #262625;
    --color-text: #f0efec;
    --color-text-3: #898781;
    --color-accent: #e2a957;
    --color-accent-2: #86ad93;
    --color-divider: rgba(240, 239, 236, 0.09);

    --color-interactive: #4a90e2;
    --color-interactive-text: #7ab0ee;
    --color-interactive-soft: rgba(74, 144, 226, 0.2);
    --color-focus: #5c9ce6;
    --color-brand: #d97757;

    --color-success-fill: #86ad93;
    --color-success-text: #a8c5b2;
    --color-success-border: rgba(134, 173, 147, 0.4);
    --color-success-bg: #1d2a22;
    --color-warning-fill: #e2a957;
    --color-warning-text: #efc386;
    --color-warning-border: rgba(226, 169, 87, 0.4);
    --color-warning-bg: #2e2416;
    --color-danger-fill: #e0705c;
    --color-danger-text: #ff9a86;
    --color-danger-border: rgba(255, 143, 122, 0.4);
    --color-danger-bg: #36201b;

    --color-neutral-100: #242423;
    --color-neutral-200: #2c2c2a;
    --color-neutral-300: #383836;
    --color-neutral-400: #4d4d4a;
    --color-neutral-500: #6b6a66;
    --color-neutral-600: #898781;
    --color-neutral-700: #a8a69f;
    --color-neutral-800: #c9c7c0;
    --color-neutral-900: #e6e4de;

    --color-accent-100: #2c200f;
    --color-accent-200: #453118;
    --color-accent-300: #694a21;
    --color-accent-400: #93672b;
    --color-accent-500: #c98a2e;
    --color-accent-600: #e2a957;
    --color-accent-700: #efc386;
    --color-accent-800: #f7dcb6;
    --color-accent-900: #fcefdc;

    --color-accent-2-100: #142019;
    --color-accent-2-200: #1d2f24;
    --color-accent-2-300: #2b4535;
    --color-accent-2-400: #3d604a;
    --color-accent-2-500: #6a9479;
    --color-accent-2-600: #86ad93;
    --color-accent-2-700: #a8c5b2;
    --color-accent-2-800: #cadccf;
    --color-accent-2-900: #e7f0ea;

    --color-critical: #ff8f7a;

    --color-scrim: #000000;

    --color-accent-fill: var(--qm-accent, #f0efec);
    --color-accent-fill-hover: color-mix(in srgb, var(--color-accent-fill) 86%, var(--color-bg));
    --color-accent-fill-active: var(--color-accent-fill);
    --color-on-accent-fill: var(--qm-accent-ink, #141413);
    --qm-ink: #e6ebe7;

    --shadow-sm: 0 0 0 0.5px rgba(240, 239, 236, 0.1);
    --shadow-md: 0 0 0 0.5px rgba(240, 239, 236, 0.12), 0 6px 18px rgba(0, 0, 0, 0.45);
    --shadow-lg: 0 0 0 0.5px rgba(240, 239, 236, 0.14), 0 16px 44px rgba(0, 0, 0, 0.6);

    --ui-hover: rgba(240, 239, 236, 0.05);
    --ui-selected: rgba(240, 239, 236, 0.08);
    --ui-field: rgba(240, 239, 236, 0.05);
    --ui-line: rgba(240, 239, 236, 0.14);
    --ui-menu: #262625;
  color-scheme: dark;
}
:root[data-theme="light"] { color-scheme: light; }

/* P18.17: nested detail panels are flat (touch targets: TOUCH_CSS, last). */
.card .audit-source { border-radius: 0; box-shadow: none; background: transparent; border-top: 1px solid var(--color-divider); }

/* ---- base ---- */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; height: 100%; }
body {
  margin: 0;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: var(--text-13);
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
/* Text is selectable: an error strip goes into a ticket, a node name into a
   terminal, and a page that refuses a triple-click is a page an operator
   retypes from (D7). Only the controls are not — dragging across the sidebar
   or double-clicking a button should not paint a selection. */
.nav-item, .nav-group-name, .btn, .sw, .seg-opt { user-select: none; }
h1, h2, h3, h4 {
  font-family: var(--font-heading);
  font-weight: var(--font-heading-weight);
  line-height: 1.15;
  letter-spacing: -0.012em;
  margin: 0;
}
h1 { font-size: var(--text-20); }
h2 { font-size: var(--text-14); }
h3 { font-size: var(--text-13); }
h4 { font-size: var(--text-13); }
p { margin: 0; }
a { color: var(--color-text); text-decoration-color: color-mix(in srgb, var(--color-text) 28%, transparent); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
::selection { background: var(--color-interactive-soft); }

/* Off screen until a keyboard reaches it (F1). */
.skip-link {
  position: absolute; left: var(--space-4); top: -120px; z-index: var(--z-skip);
  padding: var(--space-2) var(--space-4); border-radius: var(--radius-md);
  background: var(--color-accent-fill); color: var(--color-on-accent-fill); text-decoration: none;
}
.skip-link:focus { top: var(--space-2); }
/* The skip link's target: focusable so the next Tab starts there, not ringed. */
.main:focus { outline: none; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.mono, code { font-family: var(--font-mono); }
.absent { color: var(--color-muted); }
.note { font-size: var(--text-12); color: var(--color-muted); }
/* Labels are plain words in the muted ink: no capitals, no tracking. A Latin
   label in capitals reads as a shout in a Chinese interface. */
.kicker { font-size: var(--text-12); color: var(--color-muted); }
.flabel { font-size: var(--text-12); color: var(--color-quiet); }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.rowx { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.divider { height: 1px; background: var(--color-divider); border-radius: var(--radius-pill); }
.spacer { flex: 1 1 auto; }
.i { width: 16px; height: 16px; flex: none; }
.i-sm { width: 14px; height: 14px; flex: none; }
svg { display: block; }

/* ---- focus: the interaction colour's ring, a token, never a brand hex ---- */
:focus { outline: none; }
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, summary:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

/* ---- shell: a sand panel on the left, the ledger on the right ---- */
.shell {
  display: grid; grid-template-columns: 272px minmax(0, 1fr);
  gap: 0; padding: 0; width: 100%;
  align-items: stretch; min-height: 100vh;
}
/* The side panel is the conversation front's: flush with the window's edge,
   the surface colour, a hairline between it and the page. */
.side {
  background: var(--color-side);
  border-radius: 0;
  padding: 10px 8px 8px;
  display: flex; flex-direction: column; gap: 12px;
  min-width: 0;
  /* Sticky and exactly one viewport tall. Stretching it to the document — the
     way the design mock shows it — works at the mock's height and leaves the
     nav two screens above the operator on a real ledger. Fixing the height to
     the viewport keeps the left column a full panel at every scroll position
     and keeps the nav where it can be reached. */
  position: sticky; inset: auto; top: 0;
  height: 100vh;
  overflow-y: auto;
  /* It is a popover too (E1, drawers below): what the UA sheet gives one is
     undone here, so above 1000px it is the column above and nothing else. */
  margin: 0; border: 0; border-right: 0.5px solid var(--color-divider);
  width: auto; color: inherit;
}
/* The right column: the top bar, the notice line when there is one, the page. */
.frame {
  display: flex; flex-direction: column; gap: var(--space-4); min-width: 0;
  width: min(1100px, 100%); margin-inline: auto; box-sizing: border-box;
  padding: 0 var(--space-6) var(--space-8);
}
.main {
  display: flex; flex-direction: column; gap: var(--space-8);
  padding: 0 var(--space-2) var(--space-8);
  min-width: 0;
}

/* ---- top bar: one line, as on the front — where you are, then the page,
   its actions and the registry's health. Who you are sits at the foot of the
   side panel. The crumb for the page itself is not drawn: the title is it. */
.top {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-2) var(--space-4); flex-wrap: wrap;
  min-height: 48px; padding: 6px var(--space-2) 0;
}
.top-lead { display: flex; align-items: center; gap: 6px; min-width: 0; }
.crumbs {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: 6px;
  font-size: var(--text-13); color: var(--color-muted);
}
.crumbs li[aria-current="page"] { display: none; }
.crumbs li::after { content: "/"; margin-left: 6px; opacity: .6; }
.crumbs a { color: inherit; text-decoration: none; }
.crumbs a:hover { color: var(--color-text); }
.page-title { font-size: var(--text-20); overflow-wrap: anywhere; }
.top .page-title { font-size: var(--text-14); font-weight: 600; letter-spacing: 0; line-height: 1.3; }
.main h2 { font-size: var(--text-14); letter-spacing: 0; }
.main h3 { font-size: var(--text-13); letter-spacing: 0; }
.top-tail { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.top-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.health { display: flex; align-items: center; gap: var(--space-3); font-size: var(--text-12); color: var(--color-muted); }
/* The account menu at the foot of the side panel: the front's menu (below),
   with the console's own entries — the instance, 外观, the token, 退出. */
.usermenu-body { width: min(248px, 80vw); }
.usermenu-body .inst { padding: 6px 9px 0; }
.usermenu-body #tz-note { padding: 2px 9px 4px; }
.usermenu-body .adv { margin: 0; }
.usermenu-body .adv > summary { width: 100%; padding: 7px 9px; color: inherit; }
.usermenu-body .adv-body { padding: 4px 9px 8px; }

/* ---- brand: the logo (view/mark.ts), the wordmark beside it ---- */
.brand { display: flex; align-items: center; gap: 10px; }
/* In the side panel, the front's brand row: the mark at 22px and 阡陌 beside
   it, the ridges between the plots widened in the panel's own ground. */
.side .brand { gap: 9px; min-height: 32px; padding: 2px 0 0 6px; }
.side .brand-cn { font-size: 15px; letter-spacing: .06em; }
.side .brand .qm-mark path { stroke: var(--color-side); stroke-width: 18px; stroke-linejoin: round; }
.brand-cn {
  font-family: var(--font-heading); font-size: var(--text-18); font-weight: 600;
  line-height: 1.15; letter-spacing: .06em;
  color: var(--color-text); text-decoration: none;
}
a.brand-cn:hover { color: var(--color-quiet); }
.qm-mark { display: block; flex: none; }
.qm-mark .qm-ink { fill: var(--qm-ink); }

/* ---- nav: the everyday areas, then the operator's folded under 管理 ---- */
.nav { display: flex; flex-direction: column; gap: var(--space-3); }
.nav-group { display: flex; flex-direction: column; gap: 1px; }
.nav-group-name {
  padding: 0 10px 4px;
  font-size: var(--text-12);
  color: var(--color-muted);
}
.nav-fold > summary {
  display: flex; align-items: center; justify-content: space-between;
  list-style: none; cursor: pointer; border-radius: 8px;
  padding-top: var(--space-1);
}
.nav-fold > summary::-webkit-details-marker { display: none; }
.nav-fold > summary:hover { color: var(--color-text); }
.nav-fold > summary svg { width: 14px; height: 14px; transition: transform 150ms ease; }
.nav-fold[open] > summary svg { transform: rotate(180deg); }
.nav-fold > .nav-group { padding-top: var(--space-1); }
.nav-item {
  display: flex; align-items: center; gap: 9px; min-height: 30px;
  padding: 5px 10px; border-radius: var(--radius-md);
  font-size: var(--text-13); color: var(--color-text); text-decoration: none;
  transition: background-color 120ms ease, color 120ms ease;
}
.side svg.i, .side svg.i-sm { stroke-width: 1.9; }
.nav-item.nav-gap { margin-top: var(--space-3); }
.nav-item .i { width: 16px; height: 16px; color: var(--color-muted); }
.nav-item:hover { background: var(--ui-hover); }
.nav-item[aria-current="page"] { background: var(--ui-selected); font-weight: 500; }
.nav-item[aria-current="page"] .i { color: var(--color-text); }
.nav-item .cnt { margin-left: auto; font-size: var(--text-12); color: var(--color-muted); }
.nav-tag {
  margin-left: auto; padding: 0 6px; border-radius: var(--radius-xs); font-size: var(--text-11);
  background: var(--ui-selected);
  color: var(--color-quiet);
}
.nav-item[aria-current="page"] .nav-tag { background: var(--ui-field); }
/* A state beside an area (the front's rows use the same three): 待你处理 is
   the warning fill with how many, 运行中 a grey dot, 未读 the interaction
   colour. A 5px dot in a fixed 16px column, so the labels never shift. */
.nav-state { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-11); color: var(--color-muted); }
.nav-state + .cnt { margin-left: 6px; }
.nav-dot { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; }
.nav-dot::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--color-neutral-500); }
.nav-state-attention { color: var(--color-warning-text); font-weight: 600; }
.nav-state-attention .nav-dot::before { background: var(--color-warning-fill); }
.nav-state-unread .nav-dot::before { background: var(--color-interactive); }

/* ---- controls both sides draw: an icon button, a menu, the account row.
   Written once here; the front's sheet (view/frontStyle.ts) only lays them
   out in its frame. ---- */
.fx-icon-btn {
  display: inline-grid; place-items: center; width: 30px; height: 30px; flex: none; padding: 0;
  border: 0; border-radius: var(--radius-md); background: none; color: var(--color-muted);
  cursor: pointer; list-style: none; text-decoration: none;
  transition: background-color 120ms ease, color 120ms ease;
}
.fx-icon-btn::-webkit-details-marker { display: none; }
.fx-icon-btn:hover, details[open] > .fx-icon-btn { background: var(--ui-selected); color: var(--color-text); }
.fx-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; background: none; }
.fx-icon-btn .i-sm { width: 16px; height: 16px; }
.fx-icon-btn:focus-visible, .fx-menu-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.fx-more { position: relative; flex: none; }
.fx-more > summary { list-style: none; }
.fx-more > summary::-webkit-details-marker { display: none; }
.fx-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: var(--z-menu);
  display: flex; flex-direction: column; min-width: 176px; padding: 4px;
  background: var(--ui-menu); color: var(--color-text);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
}
.fx-menu-up { top: auto; bottom: calc(100% + 6px); }
.fx-menu-item {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px;
  border: 0; border-radius: var(--radius-sm); background: none; color: inherit; cursor: pointer;
  font: inherit; font-size: var(--text-13); text-align: left; text-decoration: none; white-space: nowrap;
}
.fx-menu-item .i-sm { color: var(--color-muted); }
.fx-menu-item:hover { background: var(--ui-selected); }
.fx-menu-field { justify-content: space-between; cursor: default; }
.fx-menu-field select {
  border: 0; border-radius: var(--radius-sm); padding: 3px 6px; font: inherit; font-size: var(--text-12);
  background: var(--ui-field); color: inherit;
}
.fx-menu-form { margin: 0; }
.fx-menu-sep { height: 1px; margin: 4px 6px; background: var(--color-divider); }
.fx-side-foot { display: flex; align-items: center; gap: 2px; padding: 6px 2px 0; }
.fx-me { display: inline-flex; align-items: center; gap: 9px; flex: 1; min-width: 0; padding: 2px 4px; }
.fx-me .avatar { display: block; flex: none; }
.fx-me-text { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.fx-me-text b { font-size: var(--text-13); font-weight: 500; }
.fx-me-text span { font-size: var(--text-11); color: var(--color-muted); }

/* ---- a page that is not there yet, and a page that failed ---- */
.stub {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-8) var(--space-6); max-width: 64ch;
}
.stub-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-14); }

/* ---- sidebar foot ---- */
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 4px; }
/* The refresh switch, one quiet line over the account row. */
.refresh-row {
  display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
  padding: 4px 6px; font-size: var(--text-12); color: var(--color-muted);
}
.refresh-row .sw { font-size: inherit; }
.refresh-row .sw .trk { width: 28px; height: 16px; }
.refresh-row .sw .trk::after { width: 12px; height: 12px; }
.refresh-row .sw input:checked + .trk::after { transform: translateX(12px); }
.refresh-row .sel select { min-height: 0; padding: 2px 22px 2px 8px; font-size: var(--text-12); }
/* Two short lines that wrap, not one line that ellipses: at 430px the instance
   label used to run off the panel and take the controls with it. */
.inst { font-size: var(--text-11-5); line-height: 1.45; color: var(--color-muted); }
.inst b {
  display: block; font-weight: 700; font-size: var(--text-12);
  color: color-mix(in srgb, var(--color-text) 84%, transparent);
  overflow-wrap: anywhere;
}
.fblock {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-2); font-size: var(--text-13); flex-wrap: wrap;
}
.fblock form { margin: 0; }

/* ---- the refresh switch: a pure-CSS pill ---- */
.sw { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: var(--text-13); }
.sw input { position: absolute; opacity: 0; width: 0; height: 0; }
.sw .trk {
  width: 32px; height: 18px; border-radius: var(--radius-pill); flex: none; position: relative;
  background: var(--color-neutral-400); transition: background-color 150ms ease;
}
.sw .trk::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: #ffffff; box-shadow: var(--shadow-sm); transition: transform 150ms ease;
}
.sw input:checked + .trk { background: var(--color-interactive); }
.sw input:checked + .trk::after { transform: translateX(14px); }
.sw input:disabled + .trk { opacity: .45; }
.sw:has(input:disabled) { cursor: not-allowed; }
.sw input:focus-visible + .trk { outline: 2px solid var(--color-focus); outline-offset: 2px; }
#refresh-state, #token-state, #stream-state { font-size: var(--text-11); color: var(--color-muted); }

/* ---- sections ---- */
.sec { display: flex; flex-direction: column; gap: var(--space-3); scroll-margin-top: var(--space-4); }
.sec-head {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: var(--space-4); flex-wrap: wrap;
}
.sec-head h2, .sec-head h3 { margin: 0; }
/* A polled fragment draws its own head over a block, not a flex column. */
.sec-head + .pane { margin-top: var(--space-3); }
:not(.sec) > .pane + .sec-head { margin-top: var(--space-8); }
.pane > .bar + .bar, .pane > .bar + .card { margin-top: var(--space-2); }
.cards { display: grid; gap: var(--space-3); }
.g4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.g3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }

/* ---- cards ---- */
.card {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-4); background: var(--color-surface);
  border-radius: var(--radius-xl);
  min-width: 0;
}
.card-kicker { font-size: var(--text-12); color: var(--color-muted); }
.card-meta { display: flex; align-items: center; gap: 6px; font-size: var(--text-12); color: var(--color-muted); }
.elev-sm { box-shadow: var(--shadow-sm); }
.elev-md { box-shadow: var(--shadow-md); }
.elev-lg { box-shadow: var(--shadow-lg); }

.stat { gap: var(--space-1); padding: var(--space-3) var(--space-4); }
.stat-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.stat-num {
  font-family: var(--font-heading); font-weight: 600;
  font-size: var(--text-20); line-height: 1.2; letter-spacing: -.01em;
}
.stat-num .u { font-size: var(--text-13); margin-left: 4px; color: var(--color-muted); }
.blob {
  width: 28px; height: 28px; border-radius: var(--radius-md); flex: none;
  display: grid; place-items: center;
  background: var(--ui-field); color: var(--color-quiet);
}
.blob-2 { background: var(--color-accent-2-100); color: var(--color-accent-2-800); }
.blob-n { background: var(--color-neutral-200); color: var(--color-neutral-700); }

/* ---- tags ---- */
.tag, .chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--text-11); line-height: 16px; padding: 1px 6px;
  border-radius: var(--radius-xs); white-space: nowrap;
  background: var(--ui-selected); color: var(--color-quiet);
}
.tag-accent { background: var(--color-warning-bg); color: var(--color-warning-text); }
.tag-accent-2 { background: var(--color-success-bg); color: var(--color-success-text); }
.tag-critical { background: var(--color-danger-bg); color: var(--color-danger-text); }
.tag-neutral { background: var(--ui-selected); color: var(--color-quiet); }
.chips, .tags { display: inline-flex; flex-wrap: wrap; gap: 4px; max-width: 100%; }
.chips .chip, .tags .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }

/* ---- tone: colour states a fact ---- */
.tone-ok { color: var(--color-accent-2-800); }
.tone-warn { color: var(--color-accent-800); }
.tone-bad { color: var(--color-accent-800); }
.tone-critical { color: var(--color-critical); font-weight: 700; }
.tone-muted { color: var(--color-muted); }
.total { color: var(--color-text); font-weight: 600; }
.ttl { color: var(--color-muted); }
.sep { color: var(--color-muted); }

/* ---- status: four states, four shapes ---- */
.state { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-13); white-space: nowrap; max-width: 100%; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--color-neutral-500); }
.state:has(.dot-ok) { color: var(--color-success-text); }
.dot-ok { background: var(--color-success-fill); }
.state:has(.dot-warn) { color: var(--color-warning-text); }
.dot-warn { background: transparent; border: 2px solid var(--color-warning-fill); }
.state:has(.dot-bad) { color: var(--color-neutral-700); }
.dot-bad { background: transparent; border: 1.5px solid var(--color-neutral-500); }
.state:has(.dot-critical) { color: var(--color-danger-text); }
.dot-critical { background: var(--color-danger-fill); }
.state:has(.dot-muted) { color: var(--color-muted); }
.dot-muted { width: 10px; height: 3px; border-radius: var(--radius-pill); background: var(--color-neutral-500); }

/* ---- the address, with its agent segment as a pill ---- */
.addr {
  font-family: var(--font-mono); font-size: var(--text-12-5);
  color: var(--color-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0; max-width: 100%;
}
.addr b {
  font-weight: 600; color: var(--color-text);
  background: var(--ui-field); border-radius: var(--radius-xs); padding: 1px 5px;
}

/* ---- the lease meter ---- */
.lease { display: flex; align-items: center; gap: var(--space-2); }
.lease-trk {
  width: 88px; height: 8px; border-radius: var(--radius-pill); flex: none;
  background: var(--color-neutral-300); overflow: hidden;
}
/* display:block is load-bearing: the track is blockified by its flex parent,
   the fill is not, and without this the width is ignored outright. */
.lease-fill { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--color-accent-2-500); }
.lease-stale { background: var(--color-accent-500); }
.lease-dead { background: var(--color-neutral-400); }
.lease-left { font-family: var(--font-mono); font-size: var(--text-11-5); white-space: nowrap; color: var(--color-muted); }
.lease-left.gone { color: var(--color-accent-800); }

/* ---- roster: one card per node, one disclosure row per agent ---- */
.grp { gap: var(--space-2); padding: var(--space-3) var(--space-4); }
.grp-head {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: 0 var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-divider);
}
.grp-name { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-14); }
.grp-tail { margin-left: auto; display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
/* ---- certificate line, under the node header (key-distribution.md §10.1) ---- */
.grp-cert {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-2) var(--space-2) 0;
}
.cert { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ct-w { font-weight: 600; }
.ct-left { font-family: var(--font-mono); font-size: var(--text-11-5); white-space: nowrap; color: var(--color-muted); }
/* The copyable "qm ca issue" line (§10.2: the command, never the button). It
   wraps rather than scrolls — an operator selects it with the mouse, and a
   horizontally scrolled command is one that gets copied half. */
.cmd {
  font-size: var(--text-11-5); color: var(--color-muted);
  overflow-wrap: anywhere; user-select: all;
  padding: 2px 6px; border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}
.row > summary {
  list-style: none; cursor: pointer;
  display: grid; grid-template-columns: minmax(0, 1fr) 116px 186px 82px 26px;
  align-items: center; gap: var(--space-3);
  padding: 8px var(--space-2); border-radius: var(--radius-md);
  transition: background-color 150ms ease;
}
.row > summary::-webkit-details-marker { display: none; }
.row > summary::marker { content: ""; }
.row > summary:hover, .row[open] > summary { background: var(--ui-hover); }
.chev { color: var(--color-muted); transition: transform 150ms ease; }
details[open] > summary .chev { transform: rotate(180deg); }
.row-panel {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4); padding: var(--space-4);
  margin: var(--space-1) var(--space-2) var(--space-2);
  background: transparent; border-radius: 0;
}
.kv { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.kv .k { font-size: var(--text-12); color: var(--color-muted); }
.kv .v { font-size: var(--text-13); overflow-wrap: anywhere; }
.row-acts {
  grid-column: 1 / -1; display: flex; align-items: center; gap: var(--space-2);
  flex-wrap: wrap; padding-top: var(--space-2); border-top: 1px solid var(--color-divider);
}

/* ---- disclosure: the advanced half of three forms ---- */
.adv { margin-top: var(--space-1); }
.adv > summary {
  list-style: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--text-13); color: var(--color-quiet);
  padding: 4px 8px; border-radius: var(--radius-sm);
  transition: background-color 150ms ease;
}
.adv > summary::-webkit-details-marker { display: none; }
.adv > summary::marker { content: ""; }
.adv > summary:hover { background: var(--ui-hover); }
.adv-body {
  margin-top: var(--space-2); padding: var(--space-4);
  background: var(--ui-field); border-radius: var(--radius-lg);
  display: grid; gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

/* ---- forms ---- */
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field > label, .field > span {
  display: block; font-size: var(--text-12); color: var(--color-quiet);
}
.field-wide { grid-column: 1 / -1; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
/* The wake form's two columns are not equal: the target picker has a known
   width and the prompt should take everything left over. A class rather than an
   inline style because an inline style outranks the collapse rule below, and a
   prompt box that stays in a 40px column at 430px is a prompt box nobody can
   type in. */
.wake-grid { grid-template-columns: minmax(0, 320px) minmax(0, 1fr); }
fieldset { border: 0; margin: 0; padding: 0; }
fieldset[disabled] { opacity: .55; }
.req { font-style: normal; color: var(--color-critical); margin-left: 2px; }

.input {
  width: 100%; min-height: 32px; padding: 5px 10px;
  font: inherit; font-family: var(--font-body); font-size: var(--text-13);
  color: var(--color-text); caret-color: var(--color-text);
  background: var(--color-field);
  border: 1px solid var(--ui-line); border-radius: var(--radius-md);
  min-width: 0;
}
/* A field is a step lighter than whatever it sits on, with its own border:
   on the page, on a card and inside a folded panel alike. */
.card .input, .adv-body .input, .composer .input { background: var(--color-field); }
.input:hover { border-color: color-mix(in srgb, var(--color-text) 28%, transparent); }
.input:focus-visible { border-color: var(--color-focus); outline: 2px solid var(--color-interactive-soft); outline-offset: 0; }
.input:disabled { opacity: .55; cursor: not-allowed; }
.input[readonly] { color: var(--color-muted); }
.input::placeholder { color: var(--color-text-3); }
textarea.input { border-radius: var(--radius-md); padding: 7px 10px; line-height: 1.5; resize: vertical; min-height: 72px; }

.sel { position: relative; display: block; }
.sel > select { appearance: none; -webkit-appearance: none; padding-right: 30px; }
.sel > .chev { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--color-muted); }

.hintline {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: var(--text-12); color: var(--color-muted);
  min-width: 0;
}
.hintline .mono { overflow: hidden; text-overflow: ellipsis; }

.chk {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  font-size: var(--text-13); padding: 4px 10px; border-radius: var(--radius-md); position: relative;
  border: 1px solid var(--ui-line); background: var(--color-field);
  transition: background-color 150ms ease, border-color 150ms ease;
}
.chk input { position: absolute; opacity: 0; width: 0; height: 0; }
.chk .bx {
  width: 14px; height: 14px; border-radius: var(--radius-xs); flex: none;
  display: grid; place-items: center; color: transparent;
  border: 1.5px solid var(--color-neutral-400);
  transition: background-color 150ms ease, border-color 150ms ease;
}
.chk:hover { background: var(--ui-hover); }
.chk:has(input:checked) { background: var(--color-interactive-soft); border-color: transparent; }
.chk:has(input:checked) .bx { background: var(--color-interactive); border-color: var(--color-interactive); color: #ffffff; }
.chk:has(input:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 2px; }

/* A segmented choice, the platform's own: a sunken track, the chosen
   segment a raised plate on it. */
.seg {
  display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px;
  background: var(--ui-selected); border-radius: var(--radius-md);
}
.seg-opt {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 3px 10px; min-height: 26px; font-size: var(--text-13); cursor: pointer;
  border-radius: var(--radius-sm); color: var(--color-quiet);
  transition: background-color 150ms ease, color 150ms ease;
}
.seg-opt input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
.seg-opt:has(input:checked) { background: var(--ui-menu); color: var(--color-text); box-shadow: var(--shadow-sm); }
.seg-opt:not(:has(input:checked)):hover { color: var(--color-text); }
.seg-opt:has(input:disabled) { opacity: .5; cursor: not-allowed; }
.seg-opt:has(input:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: -2px; }

/* ---- buttons ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; text-decoration: none; white-space: nowrap;
  font: inherit; font-family: var(--font-body); font-size: var(--text-13); font-weight: 500; line-height: 1.2;
  color: var(--color-text); background: transparent;
  border: 1px solid transparent; padding: 6px 12px; min-height: 32px;
  border-radius: var(--radius-md);
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
}
.btn:disabled, .btn[disabled] { opacity: .45; cursor: not-allowed; }
.btn-primary { background: var(--color-accent-fill); color: var(--color-on-accent-fill); }
.btn-primary:hover { background: var(--color-accent-fill-hover); }
.btn-primary:active { background: var(--color-accent-fill-active); }
.btn-secondary { border-color: var(--ui-line); background: var(--color-field); }
.btn-secondary:hover { background: color-mix(in srgb, var(--color-text) 5%, var(--color-field)); }
.btn-secondary:active { background: color-mix(in srgb, var(--color-text) 10%, var(--color-field)); }
.btn-ghost { color: var(--color-text); padding-inline: 10px; }
.btn-ghost:hover { background: var(--ui-hover); }
/* The one irreversible action. Terracotta's deep step, not a pure red, and
   never the resting state of anything — it is only ever the confirm button of
   a dialog, or a ghost link inside an expanded row. */
.btn-danger { background: var(--color-critical); color: var(--color-bg); border-color: transparent; }
.btn-danger:hover { background: var(--color-accent-800); }
.btn-ghost.btn-danger { background: transparent; color: var(--color-critical); }
.btn-ghost.btn-danger:hover { background: color-mix(in srgb, var(--color-critical) 10%, transparent); }
.btn-small { font-size: var(--text-12); padding: 3px 9px; min-height: 26px; border-radius: var(--radius-sm); }
.btn-block { width: 100%; }
.btn-icon { width: 32px; height: 32px; min-height: 0; padding: 0; flex: none; }
.linkish {
  font: inherit; font-family: var(--font-mono); font-size: var(--text-12);
  background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--color-text); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--color-text) 32%, transparent);
  text-underline-offset: 3px; transition: opacity 150ms ease;
}
.linkish:hover { opacity: .75; }

/* ---- strips: a fact and a number ---- */
.bar {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px;
  margin: 0; padding: 8px var(--space-3); border-radius: var(--radius-md);
  font-size: var(--text-13); background: var(--ui-field); color: var(--color-quiet);
}
.bar > .i-sm { align-self: center; }
.bar-bad { background: var(--color-warning-bg); color: var(--color-warning-text); }
.bar-warn { background: var(--color-warning-bg); color: var(--color-warning-text); }
.bar-critical { background: var(--color-danger-bg); color: var(--color-danger-text); }
.bar-muted { background: var(--ui-field); color: var(--color-muted); }
.bar-code { font-family: var(--font-mono); font-size: var(--text-11); opacity: .75; }
/* The connection line and the stamp on a region whose refresh failed (C2). */
.conn[hidden] { display: none; }
.asof { margin: 0 0 var(--space-2); font-size: var(--text-12); color: var(--color-muted); }
/* The original of a failure (C5): folded, selectable, never the sentence. */
.raw-detail, .toast-detail { flex-basis: 100%; min-width: 0; font-size: var(--text-12); }
.raw-detail > summary, .toast-detail > summary { cursor: pointer; width: max-content; }
.raw {
  margin: var(--space-1) 0 0; padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono); font-size: var(--text-11-5); line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12em; overflow: auto;
  border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text); user-select: text;
}
.bar .n { font-variant-numeric: tabular-nums; }
.hint { font-size: var(--text-13); color: var(--color-muted); padding: var(--space-3) var(--space-2); }
.status { font-size: var(--text-12); min-height: 1.25em; color: var(--color-muted); }
.status[data-tone='ok'] { color: var(--color-accent-2-800); }
.status[data-tone='bad'] { color: var(--color-accent-800); }
.status[data-tone='warn'] { color: var(--color-accent-800); }
/* A field that is wrong, and why, under it (D3). */
.field-error { margin: var(--space-1) 0 0; font-size: var(--text-12); color: var(--color-accent-800); }
/* The roster's filter (D6): a native GET form above the polled region. */
.roster-filter { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); margin: 0 0 var(--space-3); }
.roster-filter .roster-search { flex: 1 1 220px; }
.input[aria-invalid='true'] { border-color: var(--color-critical); }
.jump { color: var(--color-text); }

/* ---- the trail table ---- */
.scroll { overflow-x: auto; }
.trail { width: 100%; border-collapse: collapse; font-size: var(--text-13); }
.trail th {
  text-align: left; font-size: var(--text-12);
  color: var(--color-muted);
  padding: 6px var(--space-2); border-bottom: 1px solid var(--color-divider);
  font-weight: 400; white-space: nowrap;
}
.trail td {
  padding: var(--space-2); vertical-align: middle;
  border-bottom: 1px solid var(--color-divider);
}
.trail tbody tr:last-child td { border-bottom: 0; }
.trail tbody tr:hover { background: var(--ui-hover); }
/* Row actions stay out of the way until the row is pointed at or focused,
   as Claude Desktop's lists do; a touch screen always shows them. */
@media (hover: hover) and (pointer: fine) {
  .trail tbody td.acts > * { opacity: 0; transition: opacity 120ms ease; }
  .trail tbody tr:hover td.acts > *, .trail tbody tr:focus-within td.acts > *,
  .trail tbody td.acts:has(:popover-open) > * { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .trail tbody td.acts > * { transition: none; } }
/* A row's 更多 menu (view/kit.ts): a popover in the top layer, placed under
   its button by the runtime. */
.row-more-btn, .row-icon-btn { width: 26px; height: 26px; }
.row-more-menu[popover] { position: fixed; inset: auto; margin: 0; border: 0; min-width: 132px; }
.row-more-menu[popover]:not(:popover-open) { display: none; }
.fx-menu-danger { color: var(--color-danger-text); }
.trail td.when { white-space: nowrap; font-family: var(--font-mono); font-size: var(--text-12); }
.trail td.src, .trail td.result { white-space: nowrap; }
/* break-word, not anywhere: wake_dispatch split as wake_dispat / ch reads as
   two events. A long kind widens the column instead. */
.trail td.kind { overflow-wrap: break-word; }
.detail { margin-top: 4px; font-size: var(--text-11); color: var(--color-muted); }
.detail .dv { color: var(--color-text); }
.arrow { color: var(--color-muted); padding: 0 4px; }
.fp { color: var(--color-muted); }

/* ---- limits ---- */
.limits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.col-name { font-size: var(--text-12); color: var(--color-muted); margin: 0; }
.col-src { font-size: var(--text-12-5); color: var(--color-muted); margin: 0 0 var(--space-3); font-family: var(--font-mono); }
.dl { margin: 0; }
.lim-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-3); padding: 8px 0; font-size: var(--text-13);
  border-bottom: 1px solid var(--color-divider);
}
.lim-row:last-child { border-bottom: 0; }
.lim-row dt { color: var(--color-quiet); }
.lim-row dd { margin: 0; font-family: var(--font-mono); font-size: var(--text-13); }
.lim-row dd.plain { font-family: inherit; overflow-wrap: anywhere; }
.about-health, .about-paths { margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--color-divider); }
.strip {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  margin-top: var(--space-4); padding-top: var(--space-3);
  border-top: 1px solid var(--color-divider); font-size: var(--text-13);
}
.strip .k { color: var(--color-muted); font-size: var(--text-11); }
.strip .num { font-family: var(--font-mono); }

/* ---- the reconstructed chain, as a path rather than a second table ---- */
.chain-panel {
  padding: var(--space-4) var(--space-6);
  background: var(--color-surface); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm);
}
.chain-panel[hidden] { display: none; }
.chain-head { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; }
.chain-title { font-size: var(--text-12); color: var(--color-muted); margin: 0; }
.chain-count { font-size: var(--text-12); color: var(--color-muted); display: flex; gap: 8px; }
.hops {
  list-style: none; margin: var(--space-4) 0 0; padding: 0;
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-1) 0;
}
.hop { display: flex; align-items: center; gap: 8px; }
.hop-node {
  font-size: var(--text-12); padding: 2px 10px; border-radius: var(--radius-pill); white-space: nowrap;
  background: var(--color-neutral-100); color: var(--color-neutral-800);
  max-width: 176px; overflow: hidden; text-overflow: ellipsis;
}
.hop-link { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.hop-kind { font-size: var(--text-11); color: var(--color-muted); white-space: nowrap; }
.hop-line { display: block; width: 56px; border-top: 2px solid var(--color-accent-2-400); border-radius: var(--radius-pill); }
.hop[data-outcome='dropped'] .hop-line { border-top-style: dashed; border-top-color: var(--color-neutral-400); }
.hop[data-outcome='refused'] .hop-line { border-top-color: var(--color-accent-500); }
.hop-mark { display: block; flex: 0 0 auto; }
.mark-ok { width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent-2-600); }
.mark-refused { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--color-accent-600); }
.mark-dropped { width: 12px; height: 0; border-top: 2px dashed var(--color-neutral-500); }
.mark-muted { width: 8px; height: 8px; border-radius: 50%; background: var(--color-neutral-500); }
.hop-code { font-size: var(--text-11); color: var(--color-accent-800); white-space: nowrap; }
.hop[data-outcome='dropped'] .hop-code { color: var(--color-muted); }
.chain-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin-top: var(--space-3); font-size: var(--text-11); color: var(--color-muted); }
.chain-meta .k { min-width: 32px; }
.chain-foot { margin-top: var(--space-3); font-size: var(--text-11); color: var(--color-muted); }

/* ---- empty states: one line of what will appear here, and a way on ---- */
.empty {
  display: grid; grid-template-columns: minmax(0, 1fr);
  align-items: center; gap: var(--space-3);
  padding: var(--space-6) var(--space-5);
}
.empty-title { font-family: var(--font-heading); font-weight: 500; font-size: var(--text-14); line-height: 1.3; margin: 0; }
.empty-note { font-size: var(--text-13); color: var(--color-muted); max-width: 60ch; margin: 0; }
.empty-art { justify-self: end; }
.legend { display: flex; gap: var(--space-4); flex-wrap: wrap; font-size: var(--text-12-5); color: var(--color-muted); }

/* ---- toasts: one line per result, bottom right, never over a dialog ---- */
.toasts {
  position: fixed; right: var(--space-4); bottom: var(--space-4); z-index: var(--z-skip);
  display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2);
  width: min(380px, calc(100vw - var(--space-8))); pointer-events: none;
}
.toast {
  pointer-events: auto; cursor: pointer; max-width: 100%;
  padding: 9px 12px; border-radius: var(--radius-lg);
  background: var(--ui-menu); color: var(--color-text); box-shadow: var(--shadow-lg);
  border-left: 3px solid var(--color-success-fill); font-size: var(--text-13); overflow-wrap: anywhere;
}
.toast[data-tone='bad'] { border-left-color: var(--color-danger-fill); }
.toast-text { display: block; }
.toast-detail { margin-top: var(--space-1); }
.toast[data-tone='muted'] { border-left-color: var(--color-neutral-400); }
.toast[data-tone='warn'] { border-left-color: var(--color-warning-fill); }
/* Work in flight (C4): how long it has been, and a way to stop waiting. */
.progress {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-3);
  font-size: var(--text-12-5); font-variant-numeric: tabular-nums;
}
.progress > .toast-text { flex: 1 1 auto; }
.toast.progress { cursor: default; }
[aria-busy='true'] { cursor: progress; }

/* ---- dialogs: native <dialog>, opened with showModal() ----
   The browser owns the hard parts: the top layer, the focus trap, Escape, and
   giving focus back to the control that opened it. The closed state is the UA
   sheet's display:none, which is why display is only ever set on [open] —
   setting it on .dialog would draw every closed dialog on the page. */
dialog.dialog {
  width: min(440px, calc(100% - var(--space-8)));
  padding: var(--space-5); border: 0; border-radius: var(--radius-2xl);
  background: var(--ui-menu); color: var(--color-text); box-shadow: var(--shadow-lg);
  max-height: 90vh; overflow-y: auto;
}
dialog.dialog[open] { display: flex; flex-direction: column; gap: var(--space-3); }
dialog.dialog-wide { width: min(720px, calc(100% - var(--space-8))); }
dialog.dialog::backdrop { background: color-mix(in srgb, var(--color-scrim, #111110) 55%, transparent); }
/* A dialog says its question in the title and its consequence in the body;
   the glyph beside the title is not drawn. */
.dlg-top { display: flex; align-items: center; gap: var(--space-3); }
.dlg-icon { display: none; }
.dialog-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-14); line-height: 1.4; }
.dialog-body { font-size: var(--text-13); display: flex; flex-direction: column; gap: var(--space-3); color: var(--color-quiet); }
.recap {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--ui-field); border-radius: var(--radius-md); font-size: var(--text-13); color: var(--color-text);
}
.recap-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.recap-row .k { font-size: var(--text-11); color: var(--color-muted); flex: none; }
.quote {
  font-size: var(--text-13); line-height: 1.5; margin: 0;
  color: color-mix(in srgb, var(--color-text) 78%, transparent);
  max-height: 4.5em; overflow: hidden; white-space: pre-wrap;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-1); }

/* ---- /chat ---- */
.chat-head {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-2) var(--space-3) var(--space-3);
  border-bottom: 1px solid var(--color-divider);
}
.chat-name { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-22); }
.chat-tail { margin-left: auto; display: flex; align-items: center; gap: var(--space-3); }
.thread-mount { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.thread { display: flex; flex-direction: column; gap: var(--space-6); padding: var(--space-4) var(--space-3); }
.chat-none { font-size: var(--text-13); color: var(--color-muted); padding: var(--space-2); }

/* The session rail. It is the one part of the panel allowed to scroll: pinning
   the identity block to the bottom matters more than seeing every session, and
   without this the whole panel scrolls and 退出 leaves the screen. */
.chat-rail-mount {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  /* A popover below 1000px (E1, drawers): the UA sheet's popover box undone. */
  display: block; position: static; inset: auto; margin: 0; border: 0;
  padding: 0; width: auto; height: auto; color: inherit; background: none;
}
.chat-new { display: flex; flex-direction: column; gap: var(--space-2); }
.chat-groups { display: flex; flex-direction: column; gap: var(--space-4); }
.chat-group { display: flex; flex-direction: column; gap: var(--space-1); }
.chat-group-name { display: flex; align-items: center; gap: 7px; font-size: var(--text-12); padding: 0 var(--space-2); }
.chat-group-node { font-size: var(--text-11); padding: 0 var(--space-2); color: var(--color-muted); margin: 0; }
.chat-item {
  display: block; width: 100%; text-align: left; border: 0; background: none;
  cursor: pointer; padding: 9px var(--space-3); border-radius: var(--radius-lg);
  color: inherit; font: inherit; font-family: var(--font-body);
  transition: background-color 150ms ease;
}
.chat-item:hover { background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.chat-item-active { background: var(--color-accent-100); outline: 1px solid var(--color-accent-300); outline-offset: -1px; }
.chat-item-line {
  font-size: var(--text-13); line-height: 1.35; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.chat-item-meta { display: block; font-size: var(--text-11); margin-top: 3px; color: var(--color-muted); }

/* A turn: a round avatar in a 34px track, then the head, bubble and marks. */
.turn { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: var(--space-3); max-width: 800px; }
.turn-av {
  width: 34px; height: 34px; border-radius: 50%; flex: none;
  display: grid; place-items: center; font-size: var(--text-12); font-weight: 600;
  background: var(--color-accent-2-200); color: var(--color-accent-2-800);
}
.turn-operator .turn-av { background: var(--color-accent-200); color: var(--color-accent-800); }
.turn-head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-2); }
.turn-who { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-14); }
.turn-when { font-size: var(--text-11-5); font-family: var(--font-mono); color: var(--color-muted); }
.bubble {
  background: var(--color-surface); border-radius: var(--radius-xl);
  padding: var(--space-3) var(--space-4); font-size: var(--text-14-5); line-height: 1.6;
}
.turn-operator .bubble { background: var(--color-accent-100); }
.turn-failed .bubble { background: var(--color-accent-100); outline: 1px solid var(--color-accent-300); outline-offset: -1px; }
.turn-p { margin: 0; white-space: pre-wrap; }
.turn-p + .turn-p { margin-top: var(--space-2); }
.turn-empty { margin: 0; color: var(--color-muted); }
/* The closed markdown subset (view/richText.ts). Code scrolls inside its own
   box so a long command never makes the page scroll sideways. */
.turn-code {
  margin: var(--space-2) 0 0; padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  border-radius: var(--radius-md); overflow-x: auto;
  font-family: var(--font-mono); font-size: var(--text-12-5); line-height: 1.55;
}
.turn-code > code { white-space: pre; }
.bubble code.mono {
  padding: 1px 5px; border-radius: 5px; font-size: 0.9em;
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}
.turn-list { margin: var(--space-2) 0 0; padding-left: 1.15em; }
.turn-list > li { margin: 0; }
.turn-list > li + li { margin-top: 3px; }
.turn-p + .turn-code, .turn-p + .turn-list { margin-top: var(--space-2); }
.turn-marks { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }

/* A notice: the same left edge, a dot instead of an avatar, and no bubble.
   Flat rather than boxed on purpose — a card per tool call stops the column
   reading as a conversation (view/chat.ts on renderNotice). */
.turn-notice { align-items: start; }
.turn-av-notice { background: none; width: 34px; height: 22px; }
.notice-line { display: flex; align-items: baseline; gap: var(--space-2); min-height: 22px; }
.notice-text { font-size: var(--text-13); color: var(--color-muted); }
.notice-detail { margin-top: 2px; }
.notice-detail > summary { font-size: var(--text-12); color: var(--color-muted); cursor: pointer; list-style: none; display: flex; align-items: center; gap: 4px; }
.notice-detail > summary::-webkit-details-marker { display: none; }
/* 还在跑：一个静止的陶土色点。**刻意不做脉动** —— 这份样式表的动效纪律是
   「只有 ≤200ms 的 transition，一个关键帧动画都没有」（view.test.ts 钉着，
   而它是按整份样式表做字面查找的——连这行注释也不能写出那个 at-rule 的名字），
   而一个会呼吸的点是装饰，不是这条尾巴要说的那件事：说话的是「还在跑」四个字
   和旁边那个一直在涨的秒数。 */
.tail-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent-500); }
.turn-tail .notice-text { color: var(--color-muted); }
.notice-detail-body { margin: var(--space-2) 0 0; font-size: var(--text-13); line-height: 1.6; white-space: pre-wrap; color: color-mix(in srgb, var(--color-text) 72%, transparent); }

/* The delivery chain: three facts and the links between them. */
/* It wraps: at 375px the third fact used to run off the right edge (E1). */
.chain { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 0; max-width: 100%; }
.chain .lnk { width: 14px; height: 3px; border-radius: var(--radius-pill); background: var(--color-neutral-300); flex: none; }
.chain .lnk.done { background: var(--color-accent-2-400); }

/* The composer never scrolls and is never replaced — it holds half-typed text. */
.composer {
  flex: 0 0 auto;
  background: var(--color-surface); border-radius: var(--radius-xl);
  padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3);
  box-shadow: var(--shadow-sm);
}
.composer:focus-within { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.composer textarea {
  background: transparent; border: 0; padding: 0; width: 100%;
  min-height: 54px; max-height: 220px;
  font: inherit; font-family: var(--font-body); font-size: var(--text-14-5); line-height: 1.6;
  resize: none; color: var(--color-text); caret-color: var(--color-text);
}
.composer textarea:focus-visible { outline: none; }
.composer-foot { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.composer-foot .sel { display: inline-block; }
.composer-foot .sel > select { width: auto; min-width: 230px; max-width: 100%; }
.send { margin-left: auto; }

/* ---- /login: one panel on the plain ground ---- */
.stage {
  position: relative; overflow: hidden; min-height: 100vh;
  display: grid; place-items: center; padding: var(--space-8);
}
.panel {
  position: relative; width: min(420px, 100%); margin: auto;
  padding: var(--space-8); border-radius: 16px;
  display: flex; flex-direction: column; gap: var(--space-4);
}
.panel .brand { gap: 10px; }
.panel .brand-cn { font-size: var(--text-20); letter-spacing: .06em; }
.panel .brand .qm-mark path { stroke: var(--color-surface); stroke-width: 18px; stroke-linejoin: round; }
.panel .page-title { font-size: var(--text-20); }
.tokline {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--ui-field); border-radius: var(--radius-md);
}
.tokrow { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-12-5); color: var(--color-quiet); }
.tokrow .tag { flex: none; }
.foot { font-size: var(--text-11-5); color: var(--color-muted); }

/* ---- drawers (E1) ----
   Below 1000px the sidebar and the chat page's session list are native
   popovers: opened by a button with popovertarget and no script, put in the
   top layer by the browser, closed by Esc, a tap outside or their own close
   button, and focus goes back to the button. A browser without popovers
   keeps the stacked layout and never sees the buttons. */
.drawer-open, .drawer-close { display: none; }
@supports selector(:popover-open) {
  @media (max-width: 1000px) {
    .drawer:not(:popover-open) { display: none; }
    .drawer:popover-open {
      display: flex; flex-direction: column; gap: var(--space-4);
      position: fixed; inset: 0 auto 0 0; z-index: auto;
      width: min(300px, 86vw); height: 100dvh; max-height: none; margin: 0;
      padding: var(--space-4); overflow-y: auto;
      background: var(--color-side); color: var(--color-text);
      border-radius: 0 var(--radius-2xl) var(--radius-2xl) 0;
      box-shadow: var(--shadow-lg);
    }
    .drawer::backdrop { background: color-mix(in srgb, var(--color-scrim, #111110) 45%, transparent); }
    .drawer-open { display: inline-flex; }
    .drawer-close { display: inline-flex; align-self: flex-end; flex: none; }
  }
}

/* ---- narrow ---- */
@media (max-width: 1000px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .side {
    position: static; height: auto; gap: var(--space-4);
    border-right: 0; border-bottom: 1px solid var(--color-divider);
  }
  .nav-group { flex-direction: row; flex-wrap: wrap; gap: var(--space-1); }
  .nav-group-name { width: 100%; }
  .g4, .g3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .row > summary { grid-template-columns: minmax(0, 1fr) auto; row-gap: var(--space-2); }
  .row-panel, .form-grid, .limits, .adv-body { grid-template-columns: minmax(0, 1fr); }
  .empty { grid-template-columns: minmax(0, 1fr); }
  .empty-art { justify-self: start; }
}
@media (max-width: 620px) {
  .shell { padding: 0; gap: 0; }
  .frame { padding: var(--space-2) var(--space-3) var(--space-6); }
  .main { padding: var(--space-1); }
  .g4, .g3 { grid-template-columns: minmax(0, 1fr); }
  .turn { grid-template-columns: minmax(0, 1fr); }
  .turn-av { display: none; }
  .empty { padding: var(--space-6) var(--space-2); }
  .stage { padding: var(--space-4); }
  .panel { padding: var(--space-6); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; }
}

.gap-2 { gap: var(--space-2); }
.gap-3 { gap: var(--space-3); }
.gap-4 { gap: var(--space-4); }
.single-column { grid-template-columns: minmax(0,1fr); }
.audit-filter-row { gap: var(--space-6); align-items: flex-end; }
.push-right { margin-left: auto; }
.mt-2 { margin-top: var(--space-2); }
`

/** The shared sheet every document inlines, without the notes (G1). */
export const CONSOLE_CSS =
  stripCssComments(SOURCE_CSS + TOUCH_CSS) + accentCss()
