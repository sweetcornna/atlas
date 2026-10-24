// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The skeleton's shapes (qmo-local.md §3.5), drawn from the shell's plan of
 * the hub page's last layout: the side panel's width, or closed; the face lit
 * in the Work | Code control; the rows and group headings of its list; the
 * page and side panel colours of each appearance. The shell decided all of it
 * (`layout.rs`, `plan`); this only paints.
 *
 * The plan is `window.__QMO_BOOT__`: the main window's initialization script
 * defines it on the shell's own pages, and the shell sets it itself when it
 * writes the skeleton into `about:blank`. It is JSON the shell made from
 * values it checked; it is checked again here, and anything off leaves the
 * style sheet's defaults. The window keeps the plan it was made with, so on
 * the shell's own pages the current one is asked for too and drawn when it
 * differs (a skeleton shown again later in a run).
 *
 * A classic script, not a module: the shell also runs it as it is in
 * `about:blank`. It sits at the end of the body, so it draws before the
 * first paint.
 */
;(() => {
  const HEX = /^#[0-9a-f]{6}$/
  const WIDTH_MAX = 1000
  const ITEMS_MAX = 80
  // A map, not an object: no inherited names, and no `Object.hasOwn`, which
  // older system WebKit lacks.
  const ITEMS = new Map([
    ['label', 'skeleton-row label'],
    ['row', 'skeleton-row'],
    ['short', 'skeleton-row short'],
  ])
  const dark = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

  /** `{page, sidebar}`, both `#rrggbb`; `null` otherwise. */
  function palette(colours) {
    return colours !== null &&
      typeof colours === 'object' &&
      HEX.test(colours.page) &&
      HEX.test(colours.sidebar)
      ? colours
      : null
  }

  function draw(plan) {
    if (plan === null || typeof plan !== 'object') return
    const root = document.documentElement
    // The appearance the style sheet follows is the system's.
    const colours = palette(dark?.matches ? plan.dark : plan.light)
    if (colours !== null) {
      root.style.setProperty('--color-bg', colours.page)
      root.style.setProperty('--color-side', colours.sidebar)
    } else {
      root.style.removeProperty('--color-bg')
      root.style.removeProperty('--color-side')
    }
    const width = plan.sideWidth
    if (Number.isInteger(width) && width >= 0 && width <= WIDTH_MAX)
      root.style.setProperty('--skeleton-side-w', `${width}px`)
    root.dataset.side = plan.side === 'closed' ? 'closed' : 'open'
    root.dataset.mode = plan.mode === 'code' ? 'code' : 'work'
    const list = document.querySelector('.skeleton-list')
    if (
      list === null ||
      !Array.isArray(plan.items) ||
      plan.items.length > ITEMS_MAX
    )
      return
    const rows = []
    for (const item of plan.items) {
      const className = ITEMS.get(item)
      if (className === undefined) continue
      const row = document.createElement('div')
      row.className = className
      rows.push(row)
    }
    list.replaceChildren(...rows)
  }

  let plan = window.__QMO_BOOT__ ?? null
  draw(plan)
  dark?.addEventListener('change', () => draw(plan))

  const local =
    location.protocol === 'tauri:' || location.hostname === 'tauri.localhost'
  const invoke = window.__TAURI__?.core?.invoke
  if (!local || typeof invoke !== 'function') return
  invoke('local_boot').then(
    next => {
      if (JSON.stringify(next) === JSON.stringify(plan)) return
      plan = next
      draw(plan)
    },
    () => {},
  )
})()
