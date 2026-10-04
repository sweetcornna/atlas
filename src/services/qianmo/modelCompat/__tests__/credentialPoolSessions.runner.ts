// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.18 X-1 across sessions (design §5.11.6): sessions switched for real
 * (`switchSession`), each request through the REAL `queryModelOpenAI` with a
 * recording stub, the pool written the way the node's commit writes it.
 *
 * - `round_robin` and `least_used` choose at a session's FIRST request:
 *   different sessions may get different keys, and a session keeps its key
 *   however its requests interleave with other sessions'.
 * - `fill_first` gives every session the first key in rotation.
 * - A session whose key went out moves to the next; a session started after
 *   that skips the cooling key.
 *
 * Named `.runner.ts` so `bun test` does not pick it up in a shared process:
 * `credentialPoolSessions.isolated.test.ts` runs it in its own, for the
 * reason given in `promptCache/__tests__/sessionSwitching.isolated.test.ts`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type KeySelection, secretFingerprint } from '@qianmo/providers'
import type { SessionId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  getSessionId,
  resetStateForTests,
  switchSession,
} from '../../../../bootstrap/state.js'
import { resetCredentialPoolMemoryForTesting } from '../credentialPool.js'
import { type KeyPoolFile, writeKeyPool } from '../credentialPoolStore.js'
import {
  type CapturedRequest,
  type CaptureParams,
  captureOpenAIRequests,
} from './support/requestCapture.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => {
  settingsMock.reset()
  resetStateForTests()
})

const K1 = 'sk-test-canary-sessions-one-Ma57Lq'
const K2 = 'sk-test-canary-sessions-two-Ty80Wd'
const K3 = 'sk-test-canary-sessions-three-Cs13Ph'
const VALUES = [K1, K2, K3]

const session = (letter: string) =>
  `${letter.repeat(8)}-1818-4000-8000-00000000000${letter}` as SessionId
const A = session('a')
const B = session('b')
const C = session('c')
const D = session('d')

const HISTORY: Message[] = [
  {
    type: 'user',
    uuid: 'u-pool-sessions-1',
    message: { role: 'user', content: 'say ok' },
  } as unknown as Message,
]

let root: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-key-pool-sessions-'))
  const config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetCredentialPoolMemoryForTesting()
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

function install(selection: KeySelection): void {
  const file: KeyPoolFile = {
    v: 1,
    profile: { id: 'luna', revision: 4 },
    requestId: 'req-pool-sessions-0001',
    selection,
    envKey: 'OPENAI_API_KEY',
    keys: VALUES.map((value, index) => ({ id: `k${index + 1}`, value })),
  }
  writeKeyPool(
    file,
    Object.fromEntries(
      file.keys.map(key => [key.id, secretFingerprint(key.value)]),
    ),
  )
}

function keyOf(request: CapturedRequest): string {
  const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
  const index = VALUES.indexOf(token)
  return index >= 0 ? `k${index + 1}` : `?${token.length}`
}

/** One request of session `id`; the keys it went out with. */
async function turn(
  id: SessionId,
  respond?: CaptureParams['respond'],
): Promise<string[]> {
  switchSession(id)
  expect(getSessionId()).toBe(id)
  const requests = await captureOpenAIRequests({
    model: 'gpt-6-luna',
    baseURL: 'https://gateway.example/v1',
    env: { OPENAI_WIRE_API: 'responses', OPENAI_API_KEY: K1 },
    messages: HISTORY,
    ...(respond ? { respond } : {}),
  })
  return requests.map(keyOf)
}

/** Interleave sessions; every session's keys over all its requests. */
async function interleave(
  order: readonly SessionId[],
): Promise<Map<SessionId, string[]>> {
  const seen = new Map<SessionId, string[]>()
  for (const id of order) {
    seen.set(id, [...(seen.get(id) ?? []), ...(await turn(id))])
  }
  return seen
}

const ORDER = [A, B, A, C, B, A, D, C, A, B, D, A] as const

describe('X-1 across sessions', () => {
  test('round_robin: chosen at each session’s first request, kept after', async () => {
    install('round_robin')
    const seen = await interleave(ORDER)
    expect(seen.get(A)).toEqual(['k1', 'k1', 'k1', 'k1', 'k1'])
    expect(seen.get(B)).toEqual(['k2', 'k2', 'k2'])
    expect(seen.get(C)).toEqual(['k3', 'k3'])
    expect(seen.get(D)).toEqual(['k1', 'k1'])
  }, 60_000)

  test('least_used: counts sessions, not requests', async () => {
    install('least_used')
    const seen = await interleave(ORDER)
    // A's five requests count once: D, the fourth session, ties back to k1.
    expect(seen.get(A)).toEqual(['k1', 'k1', 'k1', 'k1', 'k1'])
    expect(seen.get(B)).toEqual(['k2', 'k2', 'k2'])
    expect(seen.get(C)).toEqual(['k3', 'k3'])
    expect(seen.get(D)).toEqual(['k1', 'k1'])
  }, 60_000)

  test('fill_first: every session the first key', async () => {
    install('fill_first')
    const seen = await interleave([A, B, C, A, B, C])
    for (const id of [A, B, C]) expect(seen.get(id)).toEqual(['k1', 'k1'])
  }, 60_000)

  test('a session whose key went out moves on; the others keep theirs; a new one skips the cooling key', async () => {
    install('round_robin')
    expect(await turn(A)).toEqual(['k1'])
    expect(await turn(B)).toEqual(['k2'])
    const payment: CaptureParams['respond'] = request =>
      keyOf(request) === 'k1'
        ? new Response(
            JSON.stringify({
              error: { message: 'Payment required', type: 'payment_required' },
            }),
            { status: 402, headers: { 'content-type': 'application/json' } },
          )
        : undefined
    // A's key refuses: A moves to the next key in rotation.
    expect(await turn(A, payment)).toEqual(['k1', 'k3'])
    expect(await turn(A)).toEqual(['k3'])
    expect(await turn(B)).toEqual(['k2'])
    // The cursor is back at k1, which is cooling: C skips it.
    expect(await turn(C)).toEqual(['k2'])
  }, 60_000)
})
