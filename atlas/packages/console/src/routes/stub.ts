// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A placeholder area: a real address that says, in one line, that the page is
 * not there yet.
 *
 * Every area of §6.1 has a route file from the start, so the page package that
 * builds one replaces its own file's `stubRoute(...)` call and touches nothing
 * else. Until then the URL answers 200 with the shell, the sidebar marks the
 * item 未提供, and the page states what will be here — never an empty frame
 * an operator would read as "something failed to load".
 */

import { escapeHtml } from '../view/escape.js'
import { underPath } from './shared.js'
import type { Area, RouteModule } from './types.js'

/** The one sentence every placeholder opens with. */
export const STUB_LINE = '此页尚未提供'

/**
 * A module for an area that is not built yet. `plan` is the one line saying
 * what the page will hold, in the console's register (`·`, no full stop).
 */
export function stubRoute(
  area: Omit<Area, 'pending' | 'href'>,
  plan: string,
): RouteModule {
  return {
    area: { ...area, href: `/${area.id}`, pending: true },
    page: {
      match: underPath(area.id),
      guard: 'view',
      async render() {
        return {
          title: area.label,
          body:
            `<section class="card elev-sm stub" aria-labelledby="stub-title">` +
            `<p class="stub-title" id="stub-title">${escapeHtml(STUB_LINE)}</p>` +
            `<p class="note">${escapeHtml(plan)}</p>` +
            `</section>`,
        }
      },
    },
  }
}
