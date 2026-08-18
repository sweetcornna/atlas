// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

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
 * enough to say so. Inter is reached for by *name* in `--ui` below, never
 * `@import`ed or linked; if the machine does not have it, the stack falls
 * through to the system sans face and nothing was fetched either way.
 *
 * ## Where the token set comes from
 *
 * The palette is oklch, copied verbatim from the shadcn reference this
 * redesign follows: neutral greys, a blue `--primary`
 * (`oklch(0.488 0.243 264.376)`, `oklch(0.424 0.199 265.638)` in dark), a
 * `--radius` of `0.625rem` with `--radius-sm`/`--radius-md` derived from it,
 * and a dark scheme that is designed rather than inverted — its border is
 * `oklch(1 0 0 / 10%)` (10% white), not a darkened grey, and its card surface
 * (`oklch(0.205 0 0)`) sits one step lighter than the page background
 * (`oklch(0.145 0 0)`) rather than matching it. `--warning` (amber) is the one
 * addition beyond the reference: shadcn's base palette ships no success/warning
 * pair, and this page needs a middle tone between `--primary` and
 * `--destructive` for the "past halfway, not yet expired" state. It follows the
 * same Tailwind amber-600/amber-400 convention the reference's own usage-meter
 * component uses for its severity steps.
 *
 * `--accent`/`--accent-foreground`/`--popover`/`--popover-foreground` are
 * carried across for palette fidelity even though nothing on this page reaches
 * for them yet — there is no menu or popover here, only tables, forms and
 * cards.
 *
 * ## The three rules this file is holding to
 *
 * **① Colour states a fact; it never marks an action, with one exception.**
 * Every coloured pixel that is not a control is asserting something about the
 * network — 在线 / 滞后 / 过期, 通过 / 拒绝 / 丢弃, the lease meter, a broken
 * chain. `--primary` is reused for the one thing that is *not* a fact: links
 * and primary buttons, because a page with no accent colour at all reads as
 * unfinished rather than as disciplined. The focus ring follows the same
 * token — `--ring` normally, `--primary` on the primary action — rather than a
 * hardcoded brand hex, so a screenshot of this page never doubles as a brand
 * mark.
 *
 * **② Sans is the display face; monospace is earned.** The CLI-ledger version
 * of this page ran entirely in monospace, on the theory that an operator who
 * reads `qianmo://node-a/planner` all day wants that face everywhere. This
 * version narrows that to where it is actually load-bearing: addresses,
 * endpoints, key fingerprints, trace/task/msg ids, protocol codes and package
 * names — the `.mono`/`code` elements the view layer already tags for exactly
 * this reason (see `escape.ts`'s note on why nothing is interpolated without
 * going through it). Everything else — labels, headings, hints, form fields,
 * button text — is Inter first, falling back to the platform sans stack.
 *
 * **③ A left ledger rail, inside a left sidebar shell.** Below the overview,
 * every row is still `[rail][pane]`: the rail holds the section noun and one
 * dense line of digits, the pane holds the table or the form — unchanged from
 * the CLI-ledger version, because a redesign of the *skin* is not a reason to
 * re-litigate a layout decision that was already right. What is new is the
 * shell around it: a fixed 15rem sidebar carries the wordmark, the section
 * anchors and the instance/clock/token controls that used to live in a top
 * bar, and the shell locks the viewport height so only the sidebar and the
 * content pane scroll — never the page as a whole.
 *
 * No shadow, no gradient, no icon, no decorative fill. The one graphic element
 * is the lease meter — a rounded track with a coloured fill, the same shape a
 * usage meter takes in the reference design — and it earns its place because it
 * carries a ratio that cannot be read anywhere else on the page.
 */

export const CONSOLE_CSS = `
:root {
  color-scheme: light dark;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.488 0.243 264.376);
  --primary-foreground: oklch(0.97 0.014 254.604);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --warning: oklch(0.666 0.179 58.318);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --radius: 0.625rem;
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
  --rail: 140px;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ui: Inter, -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.424 0.199 265.638);
    --primary-foreground: oklch(0.97 0.014 254.604);
    --secondary: oklch(0.274 0.006 286.033);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --warning: oklch(0.828 0.189 84.429);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.269 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; height: 100%; }
body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--ui);
  font-size: 14px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
  /* The page defaults to unselectable, matching the reference product's
     desktop-app feel — but code/pre/kbd/input/textarea/.mono stay selectable.
     The reference only exempts literal <code> elements; this page widens that
     to the .mono class too, because most of its copyable values (addresses,
     trace ids) are tagged that way rather than wrapped in <code>. */
  user-select: none;
}
code, pre, kbd, samp, input, textarea, .mono { user-select: text; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.absent { color: var(--muted-foreground); }
.mono, code { font-family: var(--mono); }

/* ---- focus: the token ring, not a hardcoded brand hex ---- */
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.btn-primary:focus-visible {
  outline-color: var(--primary);
}

/* ---- shell: fixed sidebar, independently scrolling content ---- */
.shell { display: flex; height: 100%; }
.sidebar {
  width: 15rem; flex: 0 0 15rem; height: 100%; overflow-y: auto;
  display: flex; flex-direction: column;
  background: var(--sidebar); color: var(--sidebar-foreground);
  border-right: 1px solid var(--sidebar-border);
}
.sidebar-header { padding: 20px 16px 8px; }
.wordmark {
  font-size: 18px; font-weight: 600; letter-spacing: .01em;
  color: var(--sidebar-foreground); text-decoration: none;
}
.sidebar-nav {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 12px; flex: 1 1 auto;
}
.nav-item {
  display: block; padding: 8px 12px; border-radius: var(--radius-md);
  font-size: 13px; color: var(--sidebar-foreground); text-decoration: none;
  transition: background-color 120ms linear, color 120ms linear;
}
.nav-item:hover, .nav-item:focus-visible {
  background: var(--sidebar-accent); color: var(--sidebar-accent-foreground);
}
.sidebar-footer {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 16px 20px; border-top: 1px solid var(--sidebar-border);
}
.sidebar-inst {
  font-size: 12px; color: var(--sidebar-foreground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sidebar-clock { font-size: 12px; color: var(--muted-foreground); }
.sidebar-footer .group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sidebar-footer label { color: var(--muted-foreground); font-size: 12px; }
.sidebar-footer input, .sidebar-footer select, .sidebar-footer .btn {
  font-size: 12px; padding: 3px 8px;
}
.sidebar-footer #token { width: 100%; }
#refresh-state, #token-state {
  color: var(--muted-foreground); font-size: 11px; min-width: 64px;
}
.content { flex: 1 1 auto; min-width: 0; height: 100%; overflow-y: auto; }

/* ---- the ledger: [rail][pane], repeated ---- */
main {
  max-width: 1120px; margin: 0 auto; padding: 40px 24px 96px;
  display: flex; flex-direction: column; gap: 56px;
}
.block { display: flex; flex-direction: column; gap: 24px; }
.row {
  display: grid; grid-template-columns: var(--rail) minmax(0, 1fr);
  gap: 24px; align-items: start;
}
.rail { display: flex; flex-direction: column; gap: 4px; padding-top: 1px; }
/* A label, not a headline: the data is the thing worth looking at, so the
   noun that names it stays small and quiet. */
.rail-name, .section-label {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .04em;
  color: var(--muted-foreground);
}
/* The dense line the deleted prose used to occupy. */
.rail-num {
  margin: 0; font-size: 12px; color: var(--muted-foreground);
  display: flex; flex-wrap: wrap; gap: 0 6px; align-items: baseline;
}
.rail-num .sep { color: var(--border); }
.rail-num .total { color: var(--foreground); }
.rail-num .ttl { color: var(--muted-foreground); }
.pane { min-width: 0; }

/* ---- overview: four stat cards above the ledger ---- */
.overview { gap: 12px; }
.stat-grid {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px;
}
.stat-card {
  min-width: 0; display: flex; flex-direction: column; gap: 8px;
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 20px 24px;
}
.stat-label {
  margin: 0; font-size: 12px; color: var(--muted-foreground);
}
.stat-value {
  margin: 0; font-size: clamp(26px, 2.4vw, 32px); font-weight: 600;
  line-height: 1.2; font-variant-numeric: tabular-nums;
}
.stat-hint { margin: 0; font-size: 13px; color: var(--muted-foreground); }

/* ---- tone: the only place a colour states a network fact ---- */
.tone-ok { color: var(--primary); }
.tone-warn { color: var(--warning); }
.tone-bad { color: var(--destructive); }
.state {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  max-width: 100%; overflow: hidden;
}
.dot {
  width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto;
  background: var(--muted-foreground);
}
.dot-ok { background: var(--primary); }
.dot-warn { background: var(--warning); }
.dot-bad { background: var(--destructive); }

/* ---- alerts: a fact and a number, in a low-tint box ---- */
.bar {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px;
  margin: 0 0 16px; padding: 10px 14px; border-radius: var(--radius-md);
  border: 1px solid var(--border); font-size: 13px;
}
.bar-bad {
  color: var(--destructive);
  background: color-mix(in oklch, var(--destructive) 10%, transparent);
  border-color: color-mix(in oklch, var(--destructive) 30%, transparent);
}
.bar-warn {
  color: var(--warning);
  background: color-mix(in oklch, var(--warning) 12%, transparent);
  border-color: color-mix(in oklch, var(--warning) 35%, transparent);
}
.bar-muted { color: var(--muted-foreground); }
.bar-code { color: var(--muted-foreground); font-size: 11px; }
.bar .n { font-variant-numeric: tabular-nums; }
.hint { margin: 0; padding: 16px 0; color: var(--muted-foreground); font-size: 13px; }
.note { margin: 0 0 16px; color: var(--muted-foreground); font-size: 13px; }
.jump { color: var(--primary); text-underline-offset: 3px; }
.chip {
  display: inline-block; padding: 2px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: var(--secondary);
  color: var(--secondary-foreground);
  font-size: 11px; white-space: nowrap;
}
.tags, .chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }

/* ---- tables: a card surface, muted headers, hairline rows ---- */
.scroll {
  overflow-x: auto; background: var(--card);
  border: 1px solid var(--border); border-radius: var(--radius);
}
table.grid { border-collapse: collapse; width: 100%; font-size: 13px; }
table.grid th, table.grid td {
  padding: 10px 12px; text-align: left; vertical-align: top;
  border-bottom: 1px solid var(--border);
}
/* Not sticky. A sticky header inside a page that scrolls as one document ends
   up floating over the first row at every scroll position that is not the top,
   and the rail already says how many rows there are. */
table.grid thead th {
  background: var(--card);
  padding-top: 10px; font-weight: 500; letter-spacing: .02em;
  font-size: 12px; color: var(--muted-foreground); white-space: nowrap;
}
table.grid tbody tr:last-child td { border-bottom: 0; }
table.grid tbody tr:hover { background: var(--muted); }
td.when, td.num, td.lease { text-align: right; white-space: nowrap; }
td.parties, td.actions { white-space: nowrap; }
th:last-child, td.actions { text-align: right; }
/* Fixed layout with declared widths. Under the auto layout the content sets
   the widths, and one long endpoint from an untrusted peer is enough to squeeze
   a neighbouring column to one character per line — unreadable, and a thing any
   peer can do to this page on purpose. */
.grid.roster { table-layout: fixed; }
.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Tags wrap onto their own lines and any single over-long tag clips inside the
   cell. Without the overflow rule one hostile capability string spills across
   the status and lease columns and covers them. */
.grid.roster td.caps { white-space: normal; overflow: hidden; }
.grid.roster td.caps .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.grid.audit td.kind { overflow-wrap: break-word; }
.detail { margin-top: 4px; font-size: 11px; color: var(--muted-foreground); }
.detail .dv { color: var(--foreground); }
.arrow { color: var(--muted-foreground); padding: 0 4px; }
.fp { color: var(--muted-foreground); }

/* ---- the lease meter: the one graphic on the page ----
   A rounded track (--muted) with a rounded fill, the same shape the reference
   design's usage meter takes. Primary while the lease is in its first half,
   amber past the halfway mark, destructive and locked full once it has
   lapsed — it replaces a heartbeat column and an expiry column that were two
   spellings of the same fact; the absolute heartbeat clock stays beside it
   because a ratio cannot be put in a ticket. */
.lease { width: 100%; }
.lease-bar {
  display: block; width: 100%; height: 6px; border-radius: 999px;
  background: var(--muted); overflow: hidden;
}
.lease-fill { display: block; height: 6px; border-radius: 999px; background: var(--primary); }
.lease-stale { background: var(--warning); }
.lease-dead { background: var(--destructive); }
.lease-left { display: block; margin-top: 4px; font-size: 11px; color: var(--muted-foreground); }
.lease-dead + .lease-left, .lease-left.gone { color: var(--destructive); }

/* ---- forms: shadcn-shaped inputs and buttons ---- */
.filters, .form { display: flex; flex-wrap: wrap; gap: 16px; margin: 0; }
.req { font-style: normal; color: var(--muted-foreground); margin-left: 2px; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 176px; }
.field > span {
  font-size: 12px; font-weight: 500; letter-spacing: .01em; color: var(--muted-foreground);
}
.field-narrow { flex: 0 0 104px; }
.field-wide { flex: 1 1 100%; }
.field-actions { flex: 0 0 auto; flex-direction: row; align-items: flex-end; gap: 8px; }
input, select, textarea {
  font: inherit; font-family: var(--ui); font-size: 13px;
  color: var(--foreground); background: var(--background);
  border: 1px solid var(--input); border-radius: var(--radius-md); padding: 6px 10px;
  min-width: 0;
}
textarea { resize: vertical; min-height: 56px; }
fieldset { border: 0; margin: 0; padding: 0; }
fieldset[disabled] { opacity: .55; }
.btn {
  font: inherit; font-family: var(--ui); font-size: 13px; font-weight: 500; cursor: pointer;
  padding: 6px 14px; border-radius: var(--radius-md); border: 1px solid var(--border);
  background: var(--background); color: var(--foreground);
  text-decoration: none; display: inline-block; line-height: 1.4;
  transition: border-color 120ms linear, background-color 120ms linear, color 120ms linear;
}
.btn:hover { background: var(--muted); }
/* The primary action is filled with --primary; colour on this page otherwise
   states a fact, and a primary action is the one deliberate exception. */
.btn-primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn-primary:hover { background: color-mix(in oklch, var(--primary) 88%, black); }
/* The one dangerous action (注销) is a destructive outline, confirmed with a
   dialog before it fires — the colour marks the risk, the dialog stops the
   slip. */
.btn-destructive { background: transparent; border-color: var(--destructive); color: var(--destructive); }
.btn-destructive:hover { background: color-mix(in oklch, var(--destructive) 10%, transparent); }
.btn[disabled], .btn:disabled { opacity: .5; cursor: not-allowed; }
td.actions .btn { padding: 2px 8px; font-size: 11px; }
td.actions .btn + .btn { margin-left: 4px; }
.linkish {
  font: inherit; font-family: var(--ui); font-size: 13px;
  background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--primary); text-decoration: underline; text-underline-offset: 3px;
  transition: opacity 120ms linear;
}
.linkish:hover { opacity: .8; }
.status { margin: 16px 0 0; font-size: 12px; min-height: 1.25em; color: var(--muted-foreground); }
.status[data-tone='ok'] { color: var(--primary); }
.status[data-tone='bad'] { color: var(--destructive); }

/* ---- limits: two columns that never become one ---- */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
.col-name {
  margin: 0 0 4px; font-size: 12px; font-weight: 500;
  letter-spacing: .04em; color: var(--muted-foreground);
}
.col-src { margin: 0 0 8px; font-size: 11px; color: var(--muted-foreground); }
.dl { margin: 0; }
.dl-row {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 16px; padding: 6px 0; border-bottom: 1px solid var(--border);
}
.dl-row:last-child { border-bottom: 0; }
.dl dt { color: var(--muted-foreground); font-size: 12px; }
.dl dd { margin: 0; text-align: right; font-size: 12px; }
.strip {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--border);
  font-size: 12px;
}
.strip .k { color: var(--muted-foreground); font-size: 11px; }

/* ---- the chain, as a path rather than a second table ----
   node ──kind──● node ──kind──▫ : hops laid out with flex and hairlines, the
   outcome carried by the mark at the end of each segment. 通过 is primary,
   拒绝 is destructive, 丢弃 is muted-foreground — quieter than a warning,
   because a dropped hop is an absence rather than a fault. */
.chain {
  margin-top: 8px; padding: 16px;
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
}
.chain[hidden] { display: none; }
.chain-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.chain-title {
  margin: 0; font-size: 12px; font-weight: 500;
  letter-spacing: .04em; color: var(--muted-foreground);
}
.chain-head .spacer { flex: 1 1 auto; }
.chain-count { font-size: 12px; color: var(--muted-foreground); display: flex; gap: 8px; }
.hops {
  list-style: none; margin: 16px 0 0; padding: 0;
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 0;
}
.hop { display: flex; align-items: center; gap: 8px; }
.hop-node {
  font-size: 12px; color: var(--foreground); padding: 2px 6px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); white-space: nowrap;
  max-width: 176px; overflow: hidden; text-overflow: ellipsis;
}
.hop-link { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.hop-kind { font-size: 11px; color: var(--muted-foreground); white-space: nowrap; }
.hop-line { display: block; width: 56px; border-top: 1px solid var(--border); }
.hop[data-outcome='dropped'] .hop-line { border-top-style: dashed; border-top-color: var(--muted-foreground); }
.hop[data-outcome='refused'] .hop-line { border-top-color: var(--destructive); }
.hop-mark { display: block; flex: 0 0 auto; }
.mark-ok { width: 7px; height: 7px; border-radius: 50%; background: var(--primary); }
.mark-refused { width: 7px; height: 7px; border: 1px solid var(--destructive); }
.mark-dropped { width: 12px; height: 0; border-top: 1px dashed var(--muted-foreground); }
.mark-muted { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-foreground); }
.hop-code { font-size: 11px; color: var(--destructive); white-space: nowrap; }
.hop[data-outcome='dropped'] .hop-code { color: var(--muted-foreground); }
.chain-meta {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px;
  margin: 12px 0 0; font-size: 11px; color: var(--muted-foreground);
}
.chain-meta .k { min-width: 32px; }
.chain-foot { margin: 12px 0 0; font-size: 11px; color: var(--muted-foreground); }

/* ---- /chat: the same shell, a conversation instead of a ledger ----
   Three regions and one rule each. The rail scrolls on its own inside the
   sidebar. The transcript scrolls on its own inside the content pane. The
   composer never scrolls and is never replaced — it holds half-typed text, and
   a stream event that swapped it would eat the question being written. */
.chat-content { display: flex; flex-direction: column; overflow: hidden; }
.thread-mount { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.thread { max-width: 768px; margin: 0 auto; padding: 32px 24px 8px; }
.thread-empty { padding-top: 64px; }
.thread-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  padding-bottom: 14px; margin-bottom: 28px;
  border-bottom: 1px solid var(--border);
}
.thread-title { margin: 0; font-size: 15px; font-weight: 600; }
.thread-addr { font-size: 11px; color: var(--muted-foreground); }
.thread-head .spacer { flex: 1 1 auto; }
.thread-count { font-size: 12px; color: var(--muted-foreground); }

/* A turn is a hairline rule with text beside it — the ledger grammar the
   roster and the trail already use. Operator turns carry the rule in
   --primary, agent turns in --border, and that is the entire distinction:
   no fill, no alignment flip, no avatar. */
.turn { margin: 0 0 28px; padding-left: 16px; border-left: 2px solid var(--border); }
.turn:last-child { margin-bottom: 0; }
.turn-operator { border-left-color: var(--primary); }
.turn-failed { border-left-color: var(--destructive); }
.turn-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.turn-who {
  font-size: 12px; font-weight: 500; letter-spacing: .04em;
  color: var(--muted-foreground);
}
.turn-when { font-size: 11px; color: var(--muted-foreground); }
/* The body is the one large block of text on this page, and body copy that
   cannot be selected cannot be quoted into a ticket. */
.turn-body { user-select: text; }
.turn-p { margin: 0 0 10px; white-space: pre-wrap; }
.turn-p:last-child { margin-bottom: 0; }
.turn-empty { margin: 0; color: var(--muted-foreground); }
.turn-marks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }

/* A pill is an event with a tone; a chip is a value. Sharing the shape would
   make "已读 1.2s" and "plan" look like the same kind of thing. */
.pill {
  display: inline-block; padding: 1px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: transparent;
  font-size: 11px; color: var(--muted-foreground); white-space: nowrap;
}
.pill-ok {
  color: var(--primary);
  border-color: color-mix(in oklch, var(--primary) 35%, transparent);
}
.pill-warn {
  color: var(--warning);
  border-color: color-mix(in oklch, var(--warning) 35%, transparent);
}
.pill-bad {
  color: var(--destructive);
  border-color: color-mix(in oklch, var(--destructive) 35%, transparent);
}
.pill-id { user-select: text; }

.composer { flex: 0 0 auto; border-top: 1px solid var(--border); padding: 14px 24px 18px; }
.composer-bar {
  max-width: 768px; margin: 0 auto;
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px; background: var(--card);
  border: 1px solid var(--input); border-radius: var(--radius);
  transition: border-color 120ms linear;
}
.composer:focus-within .composer-bar { border-color: var(--ring); }
.composer-bar textarea {
  border: 0; background: transparent; padding: 2px 0; resize: none;
  /* The ledger forms give every textarea a 56px floor so a two-line note has
     room. This one is auto-sized by the client from its own content, so that
     floor would open a blank half-inch above the caret on an empty composer. */
  min-height: 0;
  max-height: 220px; font-size: 14px; line-height: 1.55;
}
.composer-bar textarea:focus-visible { outline: none; }
.composer-foot { display: flex; align-items: center; gap: 8px; }
.composer-foot .spacer { flex: 1 1 auto; }
.composer-chips {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  font-size: 11px; color: var(--muted-foreground);
}
.composer-chips .chip {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px;
}
.send {
  flex: 0 0 auto; width: 30px; height: 30px; border-radius: 999px;
  border: 1px solid var(--primary); background: var(--primary);
  color: var(--primary-foreground); font-size: 15px; line-height: 1;
  cursor: pointer; font-family: var(--ui);
}
.send:hover { background: color-mix(in oklch, var(--primary) 88%, black); }
.composer .status, .composer .note { max-width: 768px; margin: 8px auto 0; }
.composer .note { margin: 0 auto 8px; }

/* The session rail, inside the sidebar. */
.chat-rail-mount { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 12px; }
.chat-new { display: flex; gap: 6px; padding-bottom: 12px; }
.chat-new select { flex: 1 1 auto; min-width: 0; font-size: 12px; padding: 4px 8px; }
.chat-new .btn { font-size: 12px; padding: 4px 10px; }
.chat-none { margin: 8px 0; font-size: 12px; color: var(--muted-foreground); }
.chat-group { margin-bottom: 16px; }
.chat-group-name {
  margin: 0; font-size: 12px; font-weight: 500; color: var(--sidebar-foreground);
}
.chat-group-node { margin: 0 0 6px; font-size: 11px; color: var(--muted-foreground); }
.chat-item {
  display: block; width: 100%; text-align: left; border: 0; background: none;
  cursor: pointer; padding: 6px 8px; border-radius: var(--radius-md);
  color: var(--sidebar-foreground); font: inherit; font-family: var(--ui);
  transition: background-color 120ms linear;
}
.chat-item:hover { background: var(--sidebar-accent); }
.chat-item-active { background: var(--sidebar-accent); }
.chat-item-line {
  display: block; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat-item-meta { display: block; font-size: 11px; color: var(--muted-foreground); }
/* A link that leaves the page, kept visually apart from the jump list. */
.nav-route { margin-top: 6px; border-top: 1px solid var(--sidebar-border); padding-top: 10px; }

/* ---- who am I, and the way out ---- */
.identity { justify-content: space-between; }
.identity form { margin: 0; }

/* ---- /login: one centred card, and nothing behind it ----
   The reference console pairs this card with a shader-painted brand panel on
   md+ screens. That half is deliberately not here: this page is one string of
   hand-written CSS with no build step, and no decorative fill has earned a
   second pipeline. What is kept is the skeleton — a card, centred, at a width
   where a single field does not look lost. */
.login-shell {
  /* Both, and both are load-bearing: height:100% centres inside the locked
     viewport the desktop shell sets up, and min-height:100vh keeps the card
     centred under the narrow breakpoint below, where body height goes auto. */
  height: 100%; min-height: 100vh; overflow-y: auto;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.login-card {
  width: 100%; max-width: 24rem;
  /* margin:auto rather than relying on the parent's centring alone: a card
     taller than the viewport is clipped at the top under align-items:center
     and the clipped part cannot be scrolled to. */
  margin: auto;
  display: flex; flex-direction: column; gap: 20px;
  padding: 28px; border-radius: var(--radius);
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border);
}
.login-head { display: flex; flex-direction: column; gap: 4px; }
.login-mark { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: .01em; }
.login-inst { margin: 0; font-size: 12px; color: var(--muted-foreground); }
.login-card .bar { margin: 0; }
.login-form { display: flex; flex-direction: column; gap: 16px; }
.login-form .field { flex: 1 1 auto; }
.login-submit { width: 100%; }

@media (max-width: 900px) {
  html, body { height: auto; overflow: visible; }
  .shell { flex-direction: column; height: auto; }
  .sidebar {
    width: 100%; flex: 0 0 auto; height: auto; overflow: visible;
    flex-direction: row; flex-wrap: wrap; align-items: center;
    border-right: 0; border-bottom: 1px solid var(--sidebar-border);
    padding: 8px 12px; gap: 8px 16px;
    position: sticky; top: 0; z-index: 20;
  }
  .sidebar-header { padding: 4px 0; }
  .sidebar-nav { flex-direction: row; flex-wrap: wrap; padding: 0; gap: 2px; }
  .sidebar-footer {
    flex-direction: row; align-items: center; flex-wrap: wrap;
    margin-left: auto; padding: 4px 0; border-top: 0;
  }
  .sidebar-footer #token { width: 128px; }
  .content { height: auto; overflow: visible; }
  .row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .rail { flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .two-col { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  main { padding: 24px 16px 64px; gap: 40px; }
  /* The chat page gives up its two independent scroll areas here and becomes
     one ordinary scrolling document, with the composer stuck to the bottom of
     the viewport — a 320px-tall transcript pane on a phone is not a
     conversation, it is a keyhole. */
  .chat-content { overflow: visible; }
  .thread-mount { overflow: visible; }
  .chat-rail-mount {
    width: 100%; order: 3; max-height: 45vh; padding: 0;
  }
  .thread { padding: 20px 16px 8px; }
  .composer { position: sticky; bottom: 0; background: var(--background); padding: 10px 16px 14px; }
}
@media (max-width: 560px) {
  .stat-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`
