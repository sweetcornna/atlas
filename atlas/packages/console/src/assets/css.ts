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
 * would cost more than the page. So: a constant, inlined in every document, no
 * asset route, no cache-busting, no `<link>`.
 *
 * That is also a security property. The page loads **nothing** from anywhere —
 * no CDN, no web font, no remote image — so there is no third party that can
 * change what an operator sees, and the CSP in the document head can be tight
 * enough to say so.
 *
 * ## Where the token set comes from
 *
 * One set of measures serves `/admin` and both fronts (`/`, `/app`,
 * `/app/quick`): this sheet is inlined into every document, so `:root` below
 * defines the tokens once and `view/frontStyle.ts` only reads them
 * (`docs/dev/qmo-local.md` §3.4). The rhythm follows the reference studied
 * for the desktop app (Claude Desktop, values measured from its package on
 * 2026-10-24): a warm grey page (`#f9f9f7`, dark `#0b0b0b`) with the side
 * panel on the first surface, rules between rows in the ink at 10% and 0.5px
 * wide, interface text 14/20, conversation text 16/24, captions 12/17,
 * footnotes 13/17, headings 15/20, titles 22/28, page heads 24/32, three
 * weights, 32px controls (24 / 28 / 40) with 8px corners, 12px panels and
 * menus, 20px icons, spacing on 4 / 8 / 12 / 16 / 24 / 40, and motion in
 * 60 / 120 / 200 / 300 ms on one ease-out curve. Only the numbers are taken:
 * no font, colour, class name or source of theirs. The
 * colours that are ours stay ours: amber as the accent and the logo's sage
 * (`#5e866c`) as the second accent, each with a nine-step ramp on one shared
 * lightness scale; the filled controls take the reader's theme colour
 * (`--color-accent-fill`, set from `view/accent.ts`), ink when they have not
 * picked one. The structure below came from the **Organic** design system,
 * and keeps its rules:
 *
 * Three of those are worth stating, because each replaced a rule the
 * previous (shadcn-derived) sheet held:
 *
 * **① A card is a group, not a box.** On a page it has no ground, corner or
 * shadow of its own; a heading and the hairline between rows tell one group
 * from the next, and several of one kind are a list. What is still bordered
 * is the *input well*: a field is a step lighter than the page, with its own
 * border, wherever it sits.
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
 * folded too, and so is what only the source needs: the indentation, and
 * the line break before or after a declaration (a selector never has a
 * space after a colon, a declaration always does). Every rule still starts
 * on a line of its own; whitespace inside a line is left as written.
 */
export function stripCssComments(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/;\n|\{\n(?=(?:--)?[a-z-]+: )/g, match => match[0] ?? '')
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

  /* Grounds, warm grey (qmo-local.md §3.4): the page; the first surface,
     which the side panel sits on (in dark the page with 20% black mixed
     in); a raised panel, and a menu or field. */
  --color-bg: #f9f9f7;
  --color-surface-1: #fcfcfb;
  --color-side: var(--color-surface-1);
  --color-surface: #ffffff;
  --color-field: #ffffff;
  --color-text: #0b0b0b;
  /* Weak text, the same in both schemes: placeholders only, since it does
     not keep 4.5:1 on the light page. */
  --color-text-3: #898781;
  --color-accent: #c98a2e;
  --color-accent-2: #5e866c;
  /* A rule between rows: the ink at 10%, drawn 0.5px wide (--hairline). */
  --color-divider: rgba(11, 11, 11, 0.1);

  /* The interaction colour: focus, a switch that is on, the checked box, a
     link in running text, the unread dot. Never a resting surface. */
  --color-interactive: #2a78d6;
  --color-interactive-text: #1f64ba;
  --color-interactive-soft: rgba(42, 120, 214, 0.12);
  /* The knob of a switch and the tick of a checkbox, on the blue; the
     same white in both schemes, so the dark blocks do not repeat it. */
  --color-on-interactive: #ffffff;
  --color-focus: #2a78d6;

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
  /* Secondary text: a row's label, a quiet value. */
  --color-quiet: #52514e;
  /* A fill with --color-bg text on it: the primary button, the checked
     segment of the front. The reader's theme colour (view/accent.ts), ink
     when they have not picked one. */
  --color-accent-fill: var(--qm-accent, #0b0b0b);
  --color-accent-fill-hover: color-mix(in srgb, var(--color-accent-fill) 86%, var(--color-bg));
  --color-accent-fill-active: var(--color-accent-fill);
  --color-on-accent-fill: var(--qm-accent-ink, #fafaf9);
  --qm-ink: #222623;

  /* ---- the one set of measures, for /admin and the fronts alike
     (qmo-local.md §3.4; view/frontStyle.ts reads these, defines none) ---- */

  /* Type, three weights: captions 12/17, footnotes 13/17, interface 14/20,
     headings 15/20, conversation 16/24, titles 22/28, a page's head 24/32;
     code 13/19 beside them. */
  --text-small: 12px;
  --lh-small: 17px;
  --text-footnote: 13px;
  --lh-footnote: 17px;
  --text-ui: 14px;
  --lh-ui: 20px;
  --text-prose: 16px;
  --lh-prose: 24px;
  --text-heading: 15px;
  --lh-heading: 20px;
  --text-title: 22px;
  --lh-title: 28px;
  --text-page: 24px;
  --lh-page: 32px;
  /* The one display size: the welcome page's greeting. */
  --text-display: 30px;
  --lh-display: 38px;
  --text-code: 13px;
  --lh-code: 19px;
  /* The wordmark beside the mark in the side list. */
  --text-brand: 15px;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --radius-pill: 999px;
  --z-menu: 30;
  --z-toast: 40;
  --z-skip: 50;
  /* The area in the settings card, dimmed while the next one loads (P37.13 nav). */
  --opacity-busy: 0.55;
  /* The system's own faces; YaHei and Noto for Chinese where the first
     ones are missing. */
  --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --font-heading: var(--font-body);
  --font-heading-weight: 600;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  /* Spacing, multiples of four: 4 / 8 / 12 / 16 / 24 / 40. The fifth step
     folds onto the sixth. */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 24px;
  --space-8: 40px;

  /* Controls 32px tall (24 / 28 / 40) with 8px corners (6 / 7 / 10 beside
     them, 5 on a checkbox); a panel, a menu and a dialog 12; the composer
     14, the welcome page's large one 20. Icons 20, 16 inline. Only a tag, a
     dot and a switch are round. */
  --control-h: 32px;
  --control-h-xs: 24px;
  --control-h-sm: 28px;
  --control-h-lg: 40px;
  --radius-control: 8px;
  --radius-panel: 12px;
  --radius-composer: 14px;
  --radius-composer-lg: 20px;
  --radius-2xs: 2px;
  --radius-check: 5px;
  --radius-xs: 6px;
  --radius-sm: 7px;
  --radius-lg: 10px;
  --icon: 20px;
  --icon-sm: 16px;
  /* A message bubble in the conversation; the quick-entry card. */
  --radius-bubble: 18px;
  --radius-quick: 16px;

  /* The frame: the side list, the header row, the reading column. */
  --side-w: 288px;
  --top-h: 48px;
  --column-w: 768px;
  /* Room the brand row and the header keep for the macOS window buttons,
     which the shell draws about 17px in from the window's corner. */
  --shell-lights-x: 80px;
  /* The settings card (P37.13, qmo-local.md §3.6): at most 1080 by 800,
     32px clear of the window on every side; its list 220 wide; it grows
     from 98% as it opens, over a scrim of black at 40% (50% in dark). */
  --settings-w: 1080px;
  --settings-h: 800px;
  --settings-inset: 64px;
  --settings-side-w: 220px;
  --settings-from: 0.98;
  --settings-scrim: rgba(0, 0, 0, 0.4);

  /* Motion: four durations and one curve. */
  --motion-fast: 60ms;
  --motion-snap: 120ms;
  --motion-base: 200ms;
  --motion-sheet: 300ms;
  --ease-out: cubic-bezier(0.165, 0.84, 0.44, 1);

  /* A rule between two rows of a list. */
  --hairline: 0.5px solid var(--color-divider);

  /* Elevation: a hairline ring and a soft shadow. sm is a panel, md a
     floating control, lg a menu or a dialog. */
  --shadow-sm: 0 0 0 0.5px rgba(11, 11, 11, 0.1), 0 1px 2px rgba(11, 11, 11, 0.04);
  --shadow-md: 0 0 0 0.5px rgba(11, 11, 11, 0.1), 0 2px 4px rgba(11, 11, 11, 0.04), 0 6px 16px rgba(11, 11, 11, 0.06);
  --shadow-lg: 0 0 0 0.5px rgba(11, 11, 11, 0.1), 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08);

  /* The quiet layer both sides draw their controls with, all of it the text
     colour made translucent: a row under the pointer (5%), the current row
     (10%), a field (4%), a control's border (the strong rule, 20%), a
     menu's ground. */
  --ui-hover: rgba(11, 11, 11, 0.05);
  --ui-selected: rgba(11, 11, 11, 0.1);
  --ui-field: rgba(11, 11, 11, 0.04);
  --ui-line: rgba(11, 11, 11, 0.2);
  --ui-menu: #ffffff;
  /* The chosen segment of a switch, raised off its track. */
  --ui-raised: #ffffff;
  /* The fronts' own inks: the seal on an unread or live row, the agent's
     bubble and the user's block in the conversation. */
  --color-seal: #d9462b;
  --color-agent-bubble: rgba(16, 16, 0, 0.045);
  --color-user-block: rgba(11, 11, 11, 0.055);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #0b0b0b;
    --color-surface-1: #151515;
    --color-side: color-mix(in srgb, var(--color-bg) 80%, #000000);
    --color-surface: #1a1a19;
    --color-field: #20201f;
    --color-text: #f0efec;
    --color-quiet: #c3c2b7;
    --color-accent: #e2a957;
    --color-accent-2: #86ad93;
    --color-divider: rgba(240, 239, 236, 0.1);

    --color-interactive: #4a90e2;
    --color-interactive-text: #7ab0ee;
    --color-interactive-soft: rgba(74, 144, 226, 0.2);
    --color-focus: #5c9ce6;

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
    --color-on-accent-fill: var(--qm-accent-ink, #0b0b0b);
    --qm-ink: #e6ebe7;

    --shadow-sm: 0 0 0 0.5px rgba(240, 239, 236, 0.1);
    --shadow-md: 0 0 0 0.5px rgba(240, 239, 236, 0.1), 0 6px 16px rgba(0, 0, 0, 0.24);
    --shadow-lg: 0 0 0 0.5px rgba(240, 239, 236, 0.1), 0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2);

    --ui-hover: rgba(240, 239, 236, 0.075);
    --ui-selected: rgba(240, 239, 236, 0.15);
    --ui-field: rgba(240, 239, 236, 0.05);
    --ui-line: rgba(240, 239, 236, 0.2);
    --ui-menu: #20201f;
    --ui-raised: #3a3a37;
    --color-seal: #f0644a;
    --color-agent-bubble: rgba(255, 255, 255, 0.065);
    --color-user-block: rgba(255, 255, 255, 0.075);
    --settings-scrim: rgba(0, 0, 0, 0.5);
  }
}

:root[data-theme="dark"] {
    --color-bg: #0b0b0b;
    --color-surface-1: #151515;
    --color-side: color-mix(in srgb, var(--color-bg) 80%, #000000);
    --color-surface: #1a1a19;
    --color-field: #20201f;
    --color-text: #f0efec;
    --color-quiet: #c3c2b7;
    --color-accent: #e2a957;
    --color-accent-2: #86ad93;
    --color-divider: rgba(240, 239, 236, 0.1);

    --color-interactive: #4a90e2;
    --color-interactive-text: #7ab0ee;
    --color-interactive-soft: rgba(74, 144, 226, 0.2);
    --color-focus: #5c9ce6;

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
    --color-on-accent-fill: var(--qm-accent-ink, #0b0b0b);
    --qm-ink: #e6ebe7;

    --shadow-sm: 0 0 0 0.5px rgba(240, 239, 236, 0.1);
    --shadow-md: 0 0 0 0.5px rgba(240, 239, 236, 0.1), 0 6px 16px rgba(0, 0, 0, 0.24);
    --shadow-lg: 0 0 0 0.5px rgba(240, 239, 236, 0.1), 0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2);

    --ui-hover: rgba(240, 239, 236, 0.075);
    --ui-selected: rgba(240, 239, 236, 0.15);
    --ui-field: rgba(240, 239, 236, 0.05);
    --ui-line: rgba(240, 239, 236, 0.2);
    --ui-menu: #20201f;
    --ui-raised: #3a3a37;
    --color-seal: #f0644a;
    --color-agent-bubble: rgba(255, 255, 255, 0.065);
    --color-user-block: rgba(255, 255, 255, 0.075);
    --settings-scrim: rgba(0, 0, 0, 0.5);
  color-scheme: dark;
}
:root[data-theme="light"] { color-scheme: light; }

/* P18.17: nested detail panels are flat (touch targets: TOUCH_CSS, last). */
.card .audit-source { border-radius: 0; box-shadow: none; background: transparent; border-top: var(--hairline); }

/* ---- base ---- */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; height: 100%; }
body {
  margin: 0;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: var(--text-ui);
  line-height: calc(20 / 14);
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
  line-height: var(--lh-ui);
  letter-spacing: 0;
  margin: 0;
}
h1 { font-size: var(--text-title); line-height: var(--lh-title); }
h2 { font-size: var(--text-heading); line-height: var(--lh-heading); }
h3 { font-size: var(--text-ui); }
h4 { font-size: var(--text-ui); }
p { margin: 0; }
a { color: var(--color-text); text-decoration-color: color-mix(in srgb, var(--color-text) 28%, transparent); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
::selection { background: var(--color-interactive-soft); }

/* Off screen until a keyboard reaches it (F1). */
.skip-link {
  position: absolute; left: var(--space-4); top: -120px; z-index: var(--z-skip);
  padding: var(--space-2) var(--space-4); border-radius: var(--radius-control);
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
.note { font-size: var(--text-footnote); line-height: var(--lh-footnote); color: var(--color-muted); }
/* Labels are plain words in the muted ink: no capitals, no tracking. A Latin
   label in capitals reads as a shout in a Chinese interface. */
.kicker { font-size: var(--text-small); color: var(--color-muted); }
.flabel { font-size: var(--text-small); color: var(--color-quiet); }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.rowx { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.divider { height: 0; border-top: var(--hairline); }
.spacer { flex: 1 1 auto; }
.i { width: var(--icon-sm); height: var(--icon-sm); flex: none; }
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

/* ---- the area in the settings card (view/shell.ts) ---- */
.main {
  display: flex; flex-direction: column; gap: var(--space-8);
  padding: 0 0 var(--space-8);
  min-width: 0;
}

/* ---- the card's title row (view/shell.ts): where you are, then the page,
   its actions and the registry's health. The crumb for the page itself is
   not drawn: the title is it. */
.crumbs {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: 6px;
  font-size: var(--text-ui); color: var(--color-muted);
}
.crumbs li[aria-current="page"] { display: none; }
.crumbs li::after { content: "/"; margin-left: 6px; opacity: .6; }
.crumbs a { color: inherit; text-decoration: none; }
.crumbs a:hover { color: var(--color-text); }
.page-title { font-size: var(--text-title); line-height: var(--lh-title); overflow-wrap: anywhere; }
.main h2 { font-size: var(--text-ui); line-height: var(--lh-ui); font-weight: var(--weight-semibold); }
.main h3 { font-size: var(--text-ui); line-height: var(--lh-ui); font-weight: var(--weight-semibold); }
.top-tail { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.top-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.health { display: flex; align-items: center; gap: var(--space-3); font-size: var(--text-small); color: var(--color-muted); }
.health .state { font-size: var(--text-small); }

/* ---- brand: the logo (view/mark.ts), the wordmark beside it ---- */
.brand { display: flex; align-items: center; gap: 10px; }
.brand-cn {
  font-family: var(--font-heading); font-size: var(--text-prose); font-weight: 600;
  line-height: 1.15; letter-spacing: .06em;
  color: var(--color-text); text-decoration: none;
}
a.brand-cn:hover { color: var(--color-quiet); }
.qm-mark { display: block; flex: none; }
.qm-mark .qm-ink { fill: var(--qm-ink); }

/* ---- nav: the settings card's list of areas (view/shell.ts) ----
   The list scrolls inside the card's left column, so its foot stays where it
   is however many areas there are. */
.nav {
  display: flex; flex-direction: column; gap: var(--space-3);
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  margin: 0 calc(-1 * var(--space-1)); padding: 0 var(--space-1); scrollbar-width: thin;
}
.nav-item {
  display: flex; align-items: center; gap: 10px; min-height: var(--control-h);
  padding: 0 10px; border-radius: var(--radius-control);
  font-size: var(--text-ui); color: var(--color-text); text-decoration: none;
  transition: background-color var(--motion-snap) var(--ease-out), color var(--motion-snap) var(--ease-out);
}
.nav-item.nav-gap { margin-top: var(--space-3); }
.nav-item .i { width: var(--icon); height: var(--icon); color: var(--color-quiet); }
.nav-item:hover { background: var(--ui-hover); }
.nav-item[aria-current="page"] { background: var(--ui-selected); font-weight: var(--weight-medium); }
.nav-item[aria-current="page"] .i { color: var(--color-text); }
.nav-item .cnt { margin-left: auto; font-size: var(--text-small); color: var(--color-muted); }
.nav-tag {
  margin-left: auto; padding: 0 6px; border-radius: var(--radius-xs); font-size: var(--text-small);
  background: var(--ui-selected);
  color: var(--color-quiet);
}
.nav-item[aria-current="page"] .nav-tag { background: var(--ui-field); }
/* A state beside an area (the front's rows use the same three): 待你处理 is
   the warning fill with how many, 运行中 a grey dot, 未读 the interaction
   colour. A 5px dot in a fixed 16px column, so the labels never shift. */
.nav-state { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-small); color: var(--color-muted); }
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
  display: inline-grid; place-items: center; width: var(--control-h); height: var(--control-h); flex: none; padding: 0;
  border: 0; border-radius: var(--radius-control); background: none; color: var(--color-quiet);
  cursor: pointer; list-style: none; text-decoration: none;
  transition: background-color var(--motion-snap) var(--ease-out), color var(--motion-snap) var(--ease-out);
}
.fx-icon-btn::-webkit-details-marker { display: none; }
.fx-icon-btn:hover, details[open] > .fx-icon-btn { background: var(--ui-hover); color: var(--color-text); }
.fx-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; background: none; }
.fx-icon-btn .i-sm { width: var(--icon-sm); height: var(--icon-sm); }
.fx-icon-btn:focus-visible, .fx-menu-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.fx-more { position: relative; flex: none; }
.fx-more > summary { list-style: none; }
.fx-more > summary::-webkit-details-marker { display: none; }
.fx-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: var(--z-menu);
  display: flex; flex-direction: column; min-width: 176px; padding: 4px;
  background: var(--ui-menu); color: var(--color-text);
  border-radius: var(--radius-panel); box-shadow: var(--shadow-lg);
}
.fx-menu-up { top: auto; bottom: calc(100% + 6px); }
.fx-menu-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: var(--control-h); padding: 0 8px;
  border: 0; border-radius: var(--radius-control); background: none; color: inherit; cursor: pointer;
  font: inherit; font-size: var(--text-ui); text-align: left; text-decoration: none; white-space: nowrap;
}
.fx-menu-item .i-sm { color: var(--color-quiet); }
.fx-menu-item:hover { background: var(--ui-hover); }
.fx-menu-field { justify-content: space-between; cursor: default; }
.fx-menu-field select {
  border: 0; border-radius: var(--radius-sm); padding: 3px 6px; font: inherit; font-size: var(--text-small);
  background: var(--ui-field); color: inherit;
}
.fx-menu-form { margin: 0; }
.fx-menu-sep { height: 0; margin: 4px 6px; border-top: var(--hairline); }
.fx-side-foot { display: flex; align-items: center; gap: 2px; padding: 6px 2px 0; }
.fx-me { display: inline-flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 2px 4px; }
.fx-me .avatar { display: block; flex: none; }
.fx-me-text { display: flex; flex-direction: column; line-height: var(--lh-small); min-width: 0; }
.fx-me-text b { font-size: var(--text-ui); line-height: var(--lh-ui); font-weight: var(--weight-medium); }
.fx-me-text span { font-size: var(--text-small); color: var(--color-muted); }

/* ---- a page that is not there yet, and a page that failed ---- */
.stub {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-8) var(--space-6); max-width: 64ch;
}
.stub-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-ui); }

/* ---- the settings card's foot: the refresh switch, one quiet line ---- */
.refresh-row {
  display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
  padding: 4px 6px; font-size: var(--text-small); color: var(--color-muted);
}
.refresh-row .sw { font-size: inherit; }
.refresh-row .sw .trk { width: 28px; height: 16px; }
.refresh-row .sw .trk::after { width: 12px; height: 12px; }
.refresh-row .sw input:checked + .trk::after { transform: translateX(12px); }
.refresh-row .sel select { min-height: 0; padding: 2px 22px 2px 8px; font-size: var(--text-small); }
/* Two short lines that wrap, not one line that ellipses: at 430px the instance
   label used to run off the panel and take the controls with it. */
.inst { font-size: var(--text-small); line-height: var(--lh-small); color: var(--color-muted); }
.inst b {
  display: block; font-weight: var(--weight-semibold); font-size: var(--text-small);
  color: color-mix(in srgb, var(--color-text) 84%, transparent);
  overflow-wrap: anywhere;
}
.fblock {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-2); font-size: var(--text-ui); flex-wrap: wrap;
}
.fblock form { margin: 0; }

/* ---- the refresh switch: a pure-CSS pill ---- */
.sw { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: var(--text-ui); }
.sw input { position: absolute; opacity: 0; width: 0; height: 0; }
.sw .trk {
  width: 32px; height: 18px; border-radius: var(--radius-pill); flex: none; position: relative;
  background: var(--color-neutral-400); transition: background-color var(--motion-base) var(--ease-out);
}
.sw .trk::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--color-on-interactive); box-shadow: var(--shadow-sm); transition: transform var(--motion-base) var(--ease-out);
}
.sw input:checked + .trk { background: var(--color-interactive); }
.sw input:checked + .trk::after { transform: translateX(14px); }
.sw input:disabled + .trk { opacity: .45; }
.sw:has(input:disabled) { cursor: not-allowed; }
.sw input:focus-visible + .trk { outline: 2px solid var(--color-focus); outline-offset: 2px; }
#refresh-state, #token-state, #stream-state { font-size: var(--text-small); color: var(--color-muted); }

/* ---- sections ---- */
.sec { display: flex; flex-direction: column; gap: var(--space-3); scroll-margin-top: var(--space-4); }
.sec-head {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: var(--space-2) var(--space-4); flex-wrap: wrap;
}
.sec-head h2, .sec-head h3 { margin: 0; }
.sec-head .note { line-height: var(--lh-ui); }
/* A polled fragment draws its own head over a block, not a flex column. */
.sec-head + .pane { margin-top: var(--space-3); }
:not(.sec) > .pane + .sec-head { margin-top: var(--space-8); }
.pane > .bar + .bar, .pane > .bar + .card { margin-top: var(--space-2); }
/* A row of numbers at the top of an area: one strip, a hairline between the
   numbers, none of them boxed. */
.cards { display: grid; gap: 0; border-block: var(--hairline); }
.g4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.g3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }

/* ---- cards ----
   A card on a page is a group, not a box (qmo-local.md §3.4): no ground of
   its own, no corner, no shadow, its content on the page's left edge. What
   tells one group from the next is its heading and the hairline between
   rows; a page that lists several of one kind lays them out as rows. Only a
   panel that stands alone on an empty page (the sign-in door, a public
   sheet: .elev-lg) keeps a surface. */
.card {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-4) 0; background: none;
  border-radius: 0;
  min-width: 0;
}
.card.elev-sm, .card.elev-md { padding-inline: 0; background: none; border-radius: 0; box-shadow: none; }
.card.elev-lg { padding: var(--space-6); background: var(--color-surface); border-radius: var(--radius-panel); }
.card-kicker { font-size: var(--text-small); color: var(--color-muted); }
.card-meta { display: flex; align-items: center; gap: 6px; font-size: var(--text-small); color: var(--color-muted); }
.elev-sm { box-shadow: var(--shadow-sm); }
.elev-md { box-shadow: var(--shadow-md); }
.elev-lg { box-shadow: var(--shadow-lg); }

.stat { gap: 2px; padding: var(--space-3) var(--space-4); }
.cards > .card.stat { padding: var(--space-3) var(--space-4); }
.cards > .card.stat:first-child { padding-left: 0; }
.cards > .card + .card { border-left: var(--hairline); }
.stat-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.stat-num {
  font-family: var(--font-heading); font-weight: var(--weight-semibold);
  font-size: var(--text-title); line-height: var(--lh-title); letter-spacing: 0;
}
.stat-num .u { font-size: var(--text-ui); margin-left: 4px; color: var(--color-muted); }
/* The glyph beside a number is decoration: a strip of numbers reads without it. */
.stat .blob { display: none; }
.blob {
  width: 28px; height: 28px; border-radius: var(--radius-control); flex: none;
  display: grid; place-items: center;
  background: var(--ui-field); color: var(--color-quiet);
}
.blob-2 { background: var(--color-accent-2-100); color: var(--color-accent-2-800); }
.blob-n { background: var(--color-neutral-200); color: var(--color-neutral-700); }

/* ---- tags ---- */
.tag, .chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--text-small); line-height: var(--lh-small); padding: 0 6px;
  border-radius: var(--radius-xs); white-space: nowrap;
  background: var(--ui-field); color: var(--color-quiet);
}
.tag-accent { background: var(--color-warning-bg); color: var(--color-warning-text); }
.tag-accent-2 { background: var(--color-success-bg); color: var(--color-success-text); }
.tag-critical { background: var(--color-danger-bg); color: var(--color-danger-text); }
.tag-neutral { background: var(--ui-field); color: var(--color-quiet); }
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

/* ---- status: a dot and a word; four states, four shapes ----
   The dot carries the colour (and the shape); the word stays in the quiet
   ink unless it asks for attention — a warning or a failure keeps its
   colour on the word too. */
.state { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-ui); color: var(--color-quiet); white-space: nowrap; max-width: 100%; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--color-neutral-500); }
.state:has(.dot-ok) { color: var(--color-quiet); }
.dot-ok { background: var(--color-success-fill); }
.state:has(.dot-warn) { color: var(--color-warning-text); }
.dot-warn { background: transparent; border: 1.5px solid var(--color-warning-fill); }
.state:has(.dot-bad) { color: var(--color-quiet); }
.dot-bad { background: transparent; border: 1.5px solid var(--color-neutral-500); }
.state:has(.dot-critical) { color: var(--color-danger-text); }
.dot-critical { background: var(--color-danger-fill); }
.state:has(.dot-muted) { color: var(--color-muted); }
.dot-muted { width: 9px; height: 2px; border-radius: var(--radius-pill); background: var(--color-neutral-500); }

/* ---- the address, with its agent segment as a pill ---- */
.addr {
  font-family: var(--font-mono); font-size: var(--text-code);
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
  width: 88px; height: 6px; border-radius: var(--radius-pill); flex: none;
  background: var(--color-neutral-300); overflow: hidden;
}
/* display:block is load-bearing: the track is blockified by its flex parent,
   the fill is not, and without this the width is ignored outright. */
.lease-fill { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--color-accent-2-500); }
.lease-stale { background: var(--color-accent-500); }
.lease-dead { background: var(--color-neutral-400); }
.lease-left { font-family: var(--font-mono); font-size: var(--text-small); white-space: nowrap; color: var(--color-muted); }
.lease-left.gone { color: var(--color-accent-800); }

/* ---- roster: one group per node, one disclosure row per agent, a
   hairline between rows ---- */
.grp { gap: 0; padding: var(--space-2) var(--space-4); }
.grp-head {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: 0 0 var(--space-2);
  border-bottom: var(--hairline);
}
.grp-name { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-ui); }
.grp-tail { margin-left: auto; display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
/* ---- certificate line, under the node header (key-distribution.md §10.1) ---- */
.grp-cert {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-2) 0;
  border-bottom: var(--hairline);
}
.cert { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ct-w { font-weight: 600; }
.ct-left { font-family: var(--font-mono); font-size: var(--text-small); white-space: nowrap; color: var(--color-muted); }
/* The copyable "qm ca issue" line (§10.2: the command, never the button). It
   wraps rather than scrolls — an operator selects it with the mouse, and a
   horizontally scrolled command is one that gets copied half. */
.cmd {
  font-size: var(--text-small); color: var(--color-muted);
  overflow-wrap: anywhere; user-select: all;
  padding: 2px 6px; border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}
.row > summary {
  list-style: none; cursor: pointer;
  display: grid; grid-template-columns: minmax(0, 1fr) 116px 186px 82px 26px;
  align-items: center; gap: var(--space-3);
  min-height: 44px; padding: 6px var(--space-2); margin-inline: calc(-1 * var(--space-2));
  border-radius: var(--radius-control);
  transition: background-color var(--motion-snap) var(--ease-out);
}
.row + .row { border-top: var(--hairline); }
.row > summary::-webkit-details-marker { display: none; }
.row > summary::marker { content: ""; }
.row > summary:hover, .row[open] > summary { background: var(--ui-hover); }
.chev { color: var(--color-muted); transition: transform var(--motion-base) var(--ease-out); }
details[open] > summary .chev { transform: rotate(180deg); }
.row-panel {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4); padding: var(--space-3) 0 var(--space-4);
  margin: 0;
  background: transparent; border-radius: 0;
}
.kv { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.kv .k { font-size: var(--text-small); color: var(--color-muted); }
.kv .v { font-size: var(--text-ui); overflow-wrap: anywhere; }
.row-acts {
  grid-column: 1 / -1; display: flex; align-items: center; gap: var(--space-2);
  flex-wrap: wrap; padding-top: var(--space-3); border-top: var(--hairline);
}

/* ---- disclosure: the advanced half of three forms ---- */
.adv { margin-top: var(--space-1); }
.adv > summary {
  list-style: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; min-height: var(--control-h-sm);
  font-size: var(--text-ui); color: var(--color-quiet);
  padding: 0 8px; margin-left: -8px; border-radius: var(--radius-control);
  transition: background-color var(--motion-snap) var(--ease-out);
}
.adv > summary::-webkit-details-marker { display: none; }
.adv > summary::marker { content: ""; }
.adv > summary:hover { background: var(--ui-hover); }
.adv-body {
  margin-top: var(--space-2); padding: var(--space-3) 0 var(--space-2) var(--space-4);
  background: none; border-radius: 0; border-left: var(--hairline);
  display: grid; gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

/* ---- forms ---- */
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field > label, .field > span {
  display: block; font-size: var(--text-small); line-height: var(--lh-small); color: var(--color-quiet);
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
  width: 100%; min-height: var(--control-h); padding: 5px 10px;
  font: inherit; font-family: var(--font-body); font-size: var(--text-ui); line-height: var(--lh-ui);
  color: var(--color-text); caret-color: var(--color-text);
  background: var(--color-field);
  border: 1px solid var(--ui-line); border-radius: var(--radius-control);
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
textarea.input { border-radius: var(--radius-control); padding: 6px 10px; line-height: var(--lh-ui); resize: vertical; min-height: 72px; }

.sel { position: relative; display: block; }
.sel > select { appearance: none; -webkit-appearance: none; padding-right: 30px; }
.sel > .chev { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--color-muted); }

.hintline {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: var(--text-small); color: var(--color-muted);
  min-width: 0;
}
.hintline .mono { overflow: hidden; text-overflow: ellipsis; }

.chk {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer; min-height: var(--control-h-sm);
  font-size: var(--text-ui); padding: 0 10px; border-radius: var(--radius-control); position: relative;
  border: 1px solid var(--ui-line); background: var(--color-field);
  transition: background-color var(--motion-snap) var(--ease-out), border-color var(--motion-snap) var(--ease-out);
}
.chk input { position: absolute; opacity: 0; width: 0; height: 0; }
.chk .bx {
  width: 14px; height: 14px; border-radius: var(--radius-check); flex: none;
  display: grid; place-items: center; color: transparent;
  border: 1.5px solid var(--color-neutral-400);
  transition: background-color var(--motion-snap) var(--ease-out), border-color var(--motion-snap) var(--ease-out);
}
.chk:hover { background: var(--ui-hover); }
.chk:has(input:checked) { background: var(--color-interactive-soft); border-color: transparent; }
.chk:has(input:checked) .bx { background: var(--color-interactive); border-color: var(--color-interactive); color: var(--color-on-interactive); }
.chk:has(input:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 2px; }

/* A segmented choice, the platform's own: a sunken track, the chosen
   segment a raised plate on it. */
.seg {
  display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px;
  background: var(--ui-hover); border-radius: var(--radius-control);
}
.seg-opt {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 0 10px; min-height: var(--control-h-sm); font-size: var(--text-ui); cursor: pointer;
  border-radius: var(--radius-sm); color: var(--color-quiet);
  transition: background-color var(--motion-snap) var(--ease-out), color var(--motion-snap) var(--ease-out);
}
.seg-opt input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
.seg-opt:has(input:checked) { background: var(--ui-raised); color: var(--color-text); box-shadow: var(--shadow-sm); }
.seg-opt:not(:has(input:checked)):hover { color: var(--color-text); }
.seg-opt:has(input:disabled) { opacity: .5; cursor: not-allowed; }
.seg-opt:has(input:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: -2px; }

/* ---- buttons ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; text-decoration: none; white-space: nowrap;
  font: inherit; font-family: var(--font-body); font-size: var(--text-ui); font-weight: var(--weight-medium); line-height: var(--lh-ui);
  color: var(--color-text); background: transparent;
  border: 1px solid transparent; padding: 0 12px; min-height: var(--control-h);
  border-radius: var(--radius-control);
  transition: background-color var(--motion-snap) var(--ease-out), color var(--motion-snap) var(--ease-out), border-color var(--motion-snap) var(--ease-out);
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
.btn-small { font-size: var(--text-ui); padding: 0 10px; min-height: var(--control-h-sm); border-radius: var(--radius-control); }
.btn-block { width: 100%; }
.btn-icon { width: var(--control-h); height: var(--control-h); min-height: 0; padding: 0; flex: none; }
.btn-small.btn-icon { width: var(--control-h-sm); height: var(--control-h-sm); }
.linkish {
  font: inherit; font-family: var(--font-mono); font-size: var(--text-small);
  background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--color-text); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--color-text) 32%, transparent);
  text-underline-offset: 3px; transition: opacity var(--motion-snap) var(--ease-out);
}
.linkish:hover { opacity: .75; }

/* ---- strips: a fact and a number ---- */
.bar {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px;
  margin: 0; padding: 6px var(--space-3); border-radius: var(--radius-control);
  font-size: var(--text-ui); background: var(--ui-field); color: var(--color-quiet);
}
.bar > .i-sm { align-self: center; }
.bar-bad { background: var(--color-warning-bg); color: var(--color-warning-text); }
.bar-warn { background: var(--color-warning-bg); color: var(--color-warning-text); }
.bar-critical { background: var(--color-danger-bg); color: var(--color-danger-text); }
.bar-muted { background: var(--ui-field); color: var(--color-muted); }
.bar-code { font-family: var(--font-mono); font-size: var(--text-small); opacity: .75; }
/* The connection line and the stamp on a region whose refresh failed (C2). */
.conn[hidden] { display: none; }
.asof { margin: 0 0 var(--space-2); font-size: var(--text-small); color: var(--color-muted); }
/* The original of a failure (C5): folded, selectable, never the sentence. */
.raw-detail, .toast-detail { flex-basis: 100%; min-width: 0; font-size: var(--text-small); }
.raw-detail > summary, .toast-detail > summary { cursor: pointer; width: max-content; }
.raw {
  margin: var(--space-1) 0 0; padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono); font-size: var(--text-small); line-height: var(--lh-small);
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12em; overflow: auto;
  border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text); user-select: text;
}
.bar .n { font-variant-numeric: tabular-nums; }
.hint { font-size: var(--text-ui); color: var(--color-muted); padding: var(--space-3) 0; }
.status { font-size: var(--text-small); min-height: 1.25em; color: var(--color-muted); }
.status[data-tone='ok'] { color: var(--color-accent-2-800); }
.status[data-tone='bad'] { color: var(--color-accent-800); }
.status[data-tone='warn'] { color: var(--color-accent-800); }
/* A field that is wrong, and why, under it (D3). */
.field-error { margin: var(--space-1) 0 0; font-size: var(--text-small); color: var(--color-accent-800); }
/* The roster's filter (D6): a native GET form above the polled region. */
.roster-filter { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); margin: 0 0 var(--space-3); }
.roster-filter .roster-search { flex: 1 1 220px; }
.input[aria-invalid='true'] { border-color: var(--color-critical); }
.jump { color: var(--color-text); }

/* ---- the trail table ---- */
.scroll { overflow-x: auto; }
.trail { width: 100%; border-collapse: collapse; font-size: var(--text-ui); }
.trail th {
  text-align: left; font-size: var(--text-small);
  color: var(--color-muted);
  padding: 6px var(--space-2); border-bottom: var(--hairline);
  font-weight: 400; white-space: nowrap;
}
.trail td {
  padding: var(--space-2); vertical-align: middle;
  border-bottom: var(--hairline);
}
.trail th:first-child, .trail td:first-child { padding-left: 0; }
.trail th:last-child, .trail td:last-child { padding-right: 0; }
.trail tbody tr:last-child td { border-bottom: 0; }
.trail tbody tr:hover { background: var(--ui-hover); }
/* Row actions stay out of the way until the row is pointed at or focused,
   as Claude Desktop's lists do; a touch screen always shows them. */
@media (hover: hover) and (pointer: fine) {
  .trail tbody td.acts > * { opacity: 0; transition: opacity var(--motion-snap) var(--ease-out); }
  .trail tbody tr:hover td.acts > *, .trail tbody tr:focus-within td.acts > *,
  .trail tbody td.acts:has(:popover-open) > * { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .trail tbody td.acts > * { transition: none; } }
/* A row's 更多 menu (view/kit.ts): a popover in the top layer, placed under
   its button by the runtime. */
.row-more-btn, .row-icon-btn { width: var(--control-h-sm); height: var(--control-h-sm); }
.row-more-menu[popover] { position: fixed; inset: auto; margin: 0; border: 0; min-width: 132px; }
.row-more-menu[popover]:not(:popover-open) { display: none; }
.fx-menu-danger { color: var(--color-danger-text); }
.trail td.when { white-space: nowrap; font-family: var(--font-mono); font-size: var(--text-small); }
.trail td.src, .trail td.result { white-space: nowrap; }
/* break-word, not anywhere: wake_dispatch split as wake_dispat / ch reads as
   two events. A long kind widens the column instead. */
.trail td.kind { overflow-wrap: break-word; }
.detail { margin-top: 2px; font-size: var(--text-small); color: var(--color-muted); }
.detail .dv { color: var(--color-text); }
.arrow { color: var(--color-muted); padding: 0 4px; }
.fp { color: var(--color-muted); }

/* ---- limits ---- */
.limits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.col-name { font-size: var(--text-small); color: var(--color-muted); margin: 0; }
.col-src { font-size: var(--text-small); color: var(--color-muted); margin: 0 0 var(--space-3); font-family: var(--font-mono); }
.dl { margin: 0; }
.lim-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-3); padding: 10px 0; font-size: var(--text-ui);
  border-bottom: var(--hairline);
}
.lim-row:last-child { border-bottom: 0; }
.lim-row dt { color: var(--color-quiet); }
.lim-row dd { margin: 0; font-family: var(--font-mono); font-size: var(--text-code); }
.lim-row dd.plain { font-family: inherit; overflow-wrap: anywhere; }
.about-health, .about-paths { margin-top: var(--space-3); padding-top: var(--space-3); border-top: var(--hairline); }
.strip {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  margin-top: var(--space-4); padding-top: var(--space-3);
  border-top: var(--hairline); font-size: var(--text-ui);
}
.strip .k { color: var(--color-muted); font-size: var(--text-small); }
.strip .num { font-family: var(--font-mono); }

/* ---- the reconstructed chain, as a path rather than a second table ---- */
.chain-panel {
  padding: var(--space-4) 0;
  background: none; border-radius: 0;
  border-block: var(--hairline);
}
.chain-panel[hidden] { display: none; }
.chain-head { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; }
.chain-title { font-size: var(--text-small); color: var(--color-muted); margin: 0; }
.chain-count { font-size: var(--text-small); color: var(--color-muted); display: flex; gap: 8px; }
.hops {
  list-style: none; margin: var(--space-4) 0 0; padding: 0;
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-1) 0;
}
.hop { display: flex; align-items: center; gap: 8px; }
.hop-node {
  font-size: var(--text-small); padding: 2px 10px; border-radius: var(--radius-pill); white-space: nowrap;
  background: var(--color-neutral-100); color: var(--color-neutral-800);
  max-width: 176px; overflow: hidden; text-overflow: ellipsis;
}
.hop-link { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.hop-kind { font-size: var(--text-small); color: var(--color-muted); white-space: nowrap; }
.hop-line { display: block; width: 56px; border-top: 2px solid var(--color-accent-2-400); border-radius: var(--radius-pill); }
.hop[data-outcome='dropped'] .hop-line { border-top-style: dashed; border-top-color: var(--color-neutral-400); }
.hop[data-outcome='refused'] .hop-line { border-top-color: var(--color-accent-500); }
.hop-mark { display: block; flex: 0 0 auto; }
.mark-ok { width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent-2-600); }
.mark-refused { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--color-accent-600); }
.mark-dropped { width: 12px; height: 0; border-top: 2px dashed var(--color-neutral-500); }
.mark-muted { width: 8px; height: 8px; border-radius: 50%; background: var(--color-neutral-500); }
.hop-code { font-size: var(--text-small); color: var(--color-accent-800); white-space: nowrap; }
.hop[data-outcome='dropped'] .hop-code { color: var(--color-muted); }
.chain-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin-top: var(--space-3); font-size: var(--text-small); color: var(--color-muted); }
.chain-meta .k { min-width: 32px; }
.chain-foot { margin-top: var(--space-3); font-size: var(--text-small); color: var(--color-muted); }

/* ---- empty states: one line of what will appear here, and a way on ---- */
.empty {
  display: grid; grid-template-columns: minmax(0, 1fr);
  align-items: center; gap: var(--space-3);
  padding: var(--space-6) 0;
}
.empty-title { font-family: var(--font-heading); font-weight: var(--weight-medium); font-size: var(--text-ui); line-height: var(--lh-ui); margin: 0; }
.empty-note { font-size: var(--text-ui); color: var(--color-muted); max-width: 60ch; margin: 0; }
.empty-art { justify-self: end; }
.empty .stack > .btn { align-self: flex-start; }
.legend { display: flex; gap: var(--space-4); flex-wrap: wrap; font-size: var(--text-small); color: var(--color-muted); }

/* ---- toasts: one line per result, bottom right, never over a dialog ---- */
.toasts {
  position: fixed; right: var(--space-4); bottom: var(--space-4); z-index: var(--z-skip);
  display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2);
  width: min(380px, calc(100vw - var(--space-8))); pointer-events: none;
}
.toast {
  pointer-events: auto; cursor: pointer; max-width: 100%;
  padding: 8px 12px; border-radius: var(--radius-panel);
  background: var(--ui-menu); color: var(--color-text); box-shadow: var(--shadow-lg);
  border-left: 3px solid var(--color-success-fill); font-size: var(--text-ui); overflow-wrap: anywhere;
}
.toast[data-tone='bad'] { border-left-color: var(--color-danger-fill); }
.toast-text { display: block; }
.toast-detail { margin-top: var(--space-1); }
.toast[data-tone='muted'] { border-left-color: var(--color-neutral-400); }
.toast[data-tone='warn'] { border-left-color: var(--color-warning-fill); }
/* Work in flight (C4): how long it has been, and a way to stop waiting. */
.progress {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-3);
  font-size: var(--text-small); font-variant-numeric: tabular-nums;
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
  padding: var(--space-6); border: 0; border-radius: var(--radius-panel);
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
.dialog-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-prose); line-height: var(--lh-prose); }
.dialog-body { font-size: var(--text-ui); display: flex; flex-direction: column; gap: var(--space-3); color: var(--color-quiet); }
.recap {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--ui-field); border-radius: var(--radius-control); font-size: var(--text-ui); color: var(--color-text);
}
.recap-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.recap-row .k { font-size: var(--text-small); color: var(--color-muted); flex: none; }
.quote {
  font-size: var(--text-ui); line-height: var(--lh-ui); margin: 0;
  color: color-mix(in srgb, var(--color-text) 78%, transparent);
  max-height: 4.5em; overflow: hidden; white-space: pre-wrap;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-1); }

/* ---- /chat ---- */
.chat-head {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-2) var(--space-3) var(--space-3);
  border-bottom: var(--hairline);
}
.chat-name { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-title); line-height: var(--lh-title); }
.chat-tail { margin-left: auto; display: flex; align-items: center; gap: var(--space-3); }
.thread-mount { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.thread { display: flex; flex-direction: column; gap: var(--space-6); padding: var(--space-4) var(--space-3); }
.chat-none { font-size: var(--text-ui); color: var(--color-muted); padding: var(--space-2); }

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
.chat-group-name { display: flex; align-items: center; gap: 7px; font-size: var(--text-small); padding: 0 var(--space-2); }
.chat-group-node { font-size: var(--text-small); padding: 0 var(--space-2); color: var(--color-muted); margin: 0; }
.chat-item {
  display: block; width: 100%; text-align: left; border: 0; background: none;
  cursor: pointer; padding: 6px var(--space-3); border-radius: var(--radius-control);
  color: inherit; font: inherit; font-family: var(--font-body);
  transition: background-color var(--motion-snap) var(--ease-out);
}
.chat-item:hover { background: var(--ui-hover); }
.chat-item-active { background: var(--ui-selected); }
.chat-item-line {
  font-size: var(--text-ui); line-height: var(--lh-ui); overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.chat-item-meta { display: block; font-size: var(--text-small); margin-top: 2px; color: var(--color-muted); }

/* A turn: a round avatar in a 34px track, then the head, bubble and marks. */
.turn { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: var(--space-3); max-width: 800px; }
.turn-av {
  width: 34px; height: 34px; border-radius: 50%; flex: none;
  display: grid; place-items: center; font-size: var(--text-small); font-weight: 600;
  background: var(--color-accent-2-200); color: var(--color-accent-2-800);
}
.turn-operator .turn-av { background: var(--color-accent-200); color: var(--color-accent-800); }
.turn-head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-2); }
.turn-who { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-ui); }
.turn-when { font-size: var(--text-small); font-family: var(--font-mono); color: var(--color-muted); }
.bubble {
  background: var(--ui-field); border-radius: var(--radius-panel);
  padding: var(--space-3) var(--space-4); font-size: var(--text-prose); line-height: var(--lh-prose);
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
  border-radius: var(--radius-control); overflow-x: auto;
  font-family: var(--font-mono); font-size: var(--text-code); line-height: var(--lh-code);
}
.turn-code > code { white-space: pre; }
.bubble code.mono {
  padding: 1px 5px; border-radius: var(--radius-xs); font-size: 0.9em;
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
.notice-text { font-size: var(--text-ui); color: var(--color-muted); }
.notice-detail { margin-top: 2px; }
.notice-detail > summary { font-size: var(--text-small); color: var(--color-muted); cursor: pointer; list-style: none; display: flex; align-items: center; gap: 4px; }
.notice-detail > summary::-webkit-details-marker { display: none; }
/* 还在跑：一个静止的陶土色点。**刻意不做脉动** —— 这份样式表的动效纪律是
   「只有 ≤200ms 的 transition，一个关键帧动画都没有」（view.test.ts 钉着，
   而它是按整份样式表做字面查找的——连这行注释也不能写出那个 at-rule 的名字），
   而一个会呼吸的点是装饰，不是这条尾巴要说的那件事：说话的是「还在跑」四个字
   和旁边那个一直在涨的秒数。 */
.tail-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent-500); }
.turn-tail .notice-text { color: var(--color-muted); }
.notice-detail-body { margin: var(--space-2) 0 0; font-size: var(--text-ui); line-height: var(--lh-ui); white-space: pre-wrap; color: color-mix(in srgb, var(--color-text) 72%, transparent); }

/* The delivery chain: three facts and the links between them. */
/* It wraps: at 375px the third fact used to run off the right edge (E1). */
.chain { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 0; max-width: 100%; }
.chain .lnk { width: 14px; height: 3px; border-radius: var(--radius-pill); background: var(--color-neutral-300); flex: none; }
.chain .lnk.done { background: var(--color-accent-2-400); }

/* The composer never scrolls and is never replaced — it holds half-typed text. */
.composer {
  flex: 0 0 auto;
  background: var(--ui-menu); border-radius: var(--radius-composer);
  padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-3);
  box-shadow: var(--shadow-sm);
}
.composer:focus-within { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.composer textarea {
  background: transparent; border: 0; padding: 0; width: 100%;
  min-height: 54px; max-height: 220px;
  font: inherit; font-family: var(--font-body); font-size: var(--text-prose); line-height: var(--lh-prose);
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
.panel, .card.panel {
  position: relative; width: min(420px, 100%); margin: auto;
  padding: var(--space-8); border-radius: var(--radius-panel);
  display: flex; flex-direction: column; gap: var(--space-4);
}
.panel .brand { gap: 10px; }
.panel .brand-cn { font-size: var(--text-title); letter-spacing: .06em; }
.panel .brand .qm-mark path { stroke: var(--color-surface); stroke-width: 18px; stroke-linejoin: round; }
.panel .page-title { font-size: var(--text-title); }
.tokline {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--ui-field); border-radius: var(--radius-control);
}
.tokrow { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-small); color: var(--color-quiet); }
.tokrow .tag { flex: none; }
.foot { font-size: var(--text-small); color: var(--color-muted); }

/* ---- narrow ---- */
@media (max-width: 1000px) {
  .g4, .g3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cards > .card.stat:nth-child(odd) { border-left: 0; padding-left: 0; }
  .cards > .card.stat:nth-child(n + 3) { border-top: var(--hairline); }
  .row > summary { grid-template-columns: minmax(0, 1fr) auto; row-gap: var(--space-2); }
  .row-panel, .form-grid, .limits, .adv-body { grid-template-columns: minmax(0, 1fr); }
  .empty { grid-template-columns: minmax(0, 1fr); }
  .empty-art { justify-self: start; }
}
@media (max-width: 620px) {
  .main { padding: var(--space-1); }
  .g4, .g3 { grid-template-columns: minmax(0, 1fr); }
  .cards > .card.stat { border-left: 0; padding-left: 0; }
  .cards > .card.stat + .card.stat { border-top: var(--hairline); }
  .turn { grid-template-columns: minmax(0, 1fr); }
  .turn-av { display: none; }
  .empty { padding: var(--space-6) 0; }
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

/* ---- P37.13 nav: moving between areas in place (assets/nav.ts) ----
   While the next area is on its way the card's page dims (view/frontStyle.ts,
   .set[data-busy]); an area swapped in fades in over 120ms where the browser
   has View Transitions. A data-write control says 保存中 or why it went back
   on the line beside it. */
.refresh-row[hidden] { display: none; }
.nav-note[hidden] { display: none; }
html.nav-fade::view-transition-old(root),
html.nav-fade::view-transition-new(root) { animation-duration: var(--motion-snap); animation-timing-function: var(--ease-out); }
.write-note { margin-left: var(--space-2); font-size: var(--text-small); line-height: var(--lh-small); color: var(--color-muted); }
.write-note:empty { display: none; }
.write-note[data-tone="bad"], .write-note[data-tone="warn"] { color: var(--color-danger-text); }
.fx-retry {
  border: 0; background: none; padding: 0 2px; font: inherit; color: var(--color-interactive-text);
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
`

/** The shared sheet every document inlines, without the notes (G1). */
export const CONSOLE_CSS =
  stripCssComments(SOURCE_CSS + TOUCH_CSS) + accentCss()
