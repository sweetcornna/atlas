// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A local preview of the conversation front, with a fleet that answers.
 *
 * Not a test: `bun atlas/packages/console/test/frontPreview.ts [port]` serves
 * the console on loopback with three servers, five agents and a chat port
 * that replies after a few process steps, so the front can be looked at and
 * clicked through without a registry or a node. The admin token is printed.
 */

import type { ConsoleDeps, ConsoleResult } from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import {
  agentAt,
  LIMITS,
  PageAudit,
  PageRegistry,
  TOKENS,
} from './pageHarness.js'
import { PreviewChat, TARGETS } from './preview/chat.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

const registry = new PageRegistry()
registry.listResult = ok(TARGETS.map(target => agentAt(target.address)))
const deps: ConsoleDeps = {
  registry,
  audit: new PageAudit(),
  limits: LIMITS,
  label: 'preview-hub',
  identity: 'qianmo://hub/console',
  chat: new PreviewChat(),
  chatDefault: 'qianmo://hub/ops',
}
const handle = createConsoleHandler(deps, TOKENS)
const port = Number(process.argv[2] ?? 38690)
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: request => handle(request),
  idleTimeout: 0,
})
process.stdout.write(
  `front preview on http://127.0.0.1:${port}/?token=${TOKENS.admin}\n`,
)
