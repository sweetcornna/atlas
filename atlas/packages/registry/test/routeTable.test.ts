// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The registry HTTP v0 route table, pinned (`tenancy-m1.md` §3.6, P15.2).
 *
 * The agent lifecycle — pause, resume, retire — is the console's: a ledger in
 * the console's config root and three exits that check it before they dial.
 * The design says the registry's routes do **not** change for it, and this is
 * where that is held. The handler has no declarative route table to compare,
 * so the snapshot is behavioural: every method against every path a lifecycle
 * change might plausibly have grown, on an empty registry, as
 * `method path status allow error-code`.
 *
 * A legitimate change to the registry's routes edits this table in the same
 * commit, where a reviewer sees it. The lifecycle rows (`pause`, `resume`,
 * `retire`, `/v0/registrations`) are the ones that must stay 404.
 */

import { describe, expect, test } from 'bun:test'
import { createRegistryHandler } from '../src/http.js'
import { InMemoryRegistry, ManualClock } from '../src/index.js'

const ADDRESS = encodeURIComponent('qianmo://node-a/planner')

const PATHS = [
  '/',
  '/v0',
  '/v0/health',
  '/v0/revocation-list',
  '/v0/agents',
  `/v0/agents/${ADDRESS}`,
  `/v0/agents/${ADDRESS}/heartbeat`,
  `/v0/agents/${ADDRESS}/pause`,
  `/v0/agents/${ADDRESS}/resume`,
  `/v0/agents/${ADDRESS}/retire`,
  `/v0/agents/${ADDRESS}/heartbeat/x`,
  '/v0/registrations',
  '/v1/agents',
] as const

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Taken from the handler at `b95eaff1`, before P15.2's lifecycle. */
const ROUTE_TABLE = [
  'GET / 404 - E_NOT_FOUND',
  'POST / 404 - E_NOT_FOUND',
  'PUT / 404 - E_NOT_FOUND',
  'PATCH / 404 - E_NOT_FOUND',
  'DELETE / 404 - E_NOT_FOUND',
  'GET /v0 404 - E_NOT_FOUND',
  'POST /v0 404 - E_NOT_FOUND',
  'PUT /v0 404 - E_NOT_FOUND',
  'PATCH /v0 404 - E_NOT_FOUND',
  'DELETE /v0 404 - E_NOT_FOUND',
  'GET /v0/health 200 - -',
  'POST /v0/health 405 GET E_BAD_REQUEST',
  'PUT /v0/health 405 GET E_BAD_REQUEST',
  'PATCH /v0/health 405 GET E_BAD_REQUEST',
  'DELETE /v0/health 405 GET E_BAD_REQUEST',
  'GET /v0/revocation-list 404 - E_NOT_FOUND',
  'POST /v0/revocation-list 405 GET, PUT E_BAD_REQUEST',
  'PUT /v0/revocation-list 400 - E_BAD_REQUEST',
  'PATCH /v0/revocation-list 405 GET, PUT E_BAD_REQUEST',
  'DELETE /v0/revocation-list 405 GET, PUT E_BAD_REQUEST',
  'GET /v0/agents 200 - -',
  'POST /v0/agents 400 - E_BAD_REQUEST',
  'PUT /v0/agents 405 GET, POST E_BAD_REQUEST',
  'PATCH /v0/agents 405 GET, POST E_BAD_REQUEST',
  'DELETE /v0/agents 405 GET, POST E_BAD_REQUEST',
  'GET /v0/agents/<a> 404 - E_NOT_FOUND',
  'POST /v0/agents/<a> 405 GET, DELETE E_BAD_REQUEST',
  'PUT /v0/agents/<a> 405 GET, DELETE E_BAD_REQUEST',
  'PATCH /v0/agents/<a> 405 GET, DELETE E_BAD_REQUEST',
  'DELETE /v0/agents/<a> 404 - E_NOT_FOUND',
  'GET /v0/agents/<a>/heartbeat 405 POST E_BAD_REQUEST',
  'POST /v0/agents/<a>/heartbeat 404 - E_NOT_FOUND',
  'PUT /v0/agents/<a>/heartbeat 405 POST E_BAD_REQUEST',
  'PATCH /v0/agents/<a>/heartbeat 405 POST E_BAD_REQUEST',
  'DELETE /v0/agents/<a>/heartbeat 405 POST E_BAD_REQUEST',
  'GET /v0/agents/<a>/pause 404 - E_NOT_FOUND',
  'POST /v0/agents/<a>/pause 404 - E_NOT_FOUND',
  'PUT /v0/agents/<a>/pause 404 - E_NOT_FOUND',
  'PATCH /v0/agents/<a>/pause 404 - E_NOT_FOUND',
  'DELETE /v0/agents/<a>/pause 404 - E_NOT_FOUND',
  'GET /v0/agents/<a>/resume 404 - E_NOT_FOUND',
  'POST /v0/agents/<a>/resume 404 - E_NOT_FOUND',
  'PUT /v0/agents/<a>/resume 404 - E_NOT_FOUND',
  'PATCH /v0/agents/<a>/resume 404 - E_NOT_FOUND',
  'DELETE /v0/agents/<a>/resume 404 - E_NOT_FOUND',
  'GET /v0/agents/<a>/retire 404 - E_NOT_FOUND',
  'POST /v0/agents/<a>/retire 404 - E_NOT_FOUND',
  'PUT /v0/agents/<a>/retire 404 - E_NOT_FOUND',
  'PATCH /v0/agents/<a>/retire 404 - E_NOT_FOUND',
  'DELETE /v0/agents/<a>/retire 404 - E_NOT_FOUND',
  'GET /v0/agents/<a>/heartbeat/x 404 - E_NOT_FOUND',
  'POST /v0/agents/<a>/heartbeat/x 404 - E_NOT_FOUND',
  'PUT /v0/agents/<a>/heartbeat/x 404 - E_NOT_FOUND',
  'PATCH /v0/agents/<a>/heartbeat/x 404 - E_NOT_FOUND',
  'DELETE /v0/agents/<a>/heartbeat/x 404 - E_NOT_FOUND',
  'GET /v0/registrations 404 - E_NOT_FOUND',
  'POST /v0/registrations 404 - E_NOT_FOUND',
  'PUT /v0/registrations 404 - E_NOT_FOUND',
  'PATCH /v0/registrations 404 - E_NOT_FOUND',
  'DELETE /v0/registrations 404 - E_NOT_FOUND',
  'GET /v1/agents 404 - E_NOT_FOUND',
  'POST /v1/agents 404 - E_NOT_FOUND',
  'PUT /v1/agents 404 - E_NOT_FOUND',
  'PATCH /v1/agents 404 - E_NOT_FOUND',
  'DELETE /v1/agents 404 - E_NOT_FOUND',
]

async function probe(): Promise<string[]> {
  const handle = createRegistryHandler(
    new InMemoryRegistry({ clock: new ManualClock(1_000_000) }),
  )
  const rows: string[] = []
  for (const path of PATHS) {
    for (const method of METHODS) {
      const response = await handle(
        new Request(`http://registry.test${path}`, { method }),
      )
      let code = '-'
      try {
        const body = (await response.json()) as {
          error?: { code?: string }
        }
        code = body.error?.code ?? '-'
      } catch {
        // No JSON body: the row says so with `-`.
      }
      rows.push(
        `${method} ${path.replace(ADDRESS, '<a>')} ${String(response.status)} ` +
          `${response.headers.get('allow') ?? '-'} ${code}`,
      )
    }
  }
  return rows
}

describe('the registry HTTP v0 route table', () => {
  test('is exactly what it was before the console grew an agent lifecycle', async () => {
    expect(await probe()).toEqual(ROUTE_TABLE)
  })
})
