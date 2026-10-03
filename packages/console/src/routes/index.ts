// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The route table: every area of the console, in sidebar order.
 *
 * `http.ts` dispatches `/v0/<head>` and `/fragments/<head>` to the one module
 * that claims the head, and every other path to the first module whose page
 * matches it. A head claimed twice is a bug the table refuses at load time
 * rather than a route that silently goes to whichever module came first.
 */

import { auditRoute } from './audit.js'
import { chatRoute } from './chat.js'
import { nodesRoute } from './nodes.js'
import { serversRoute } from './servers.js'
import { settingsRoute } from './settings.js'
import type { HeadRoute, RouteModule } from './types.js'

export const ROUTES: readonly RouteModule[] = [
  nodesRoute,
  chatRoute,
  auditRoute,
  serversRoute,
  settingsRoute,
]

/** Index the heads of one kind, refusing a head that two modules claim. */
export function headIndex(
  modules: readonly RouteModule[],
  pick: (module: RouteModule) => HeadRoute | undefined,
  reserved: readonly string[] = [],
): ReadonlyMap<string, HeadRoute> {
  const index = new Map<string, HeadRoute>()
  for (const module of modules) {
    const route = pick(module)
    if (route === undefined) continue
    for (const head of route.heads) {
      if (index.has(head) || reserved.includes(head)) {
        throw new Error(`route head claimed twice: ${head}`)
      }
      index.set(head, route)
    }
  }
  return index
}
