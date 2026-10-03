// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The subprocess scrub list covers every model credential a Qianmo node can
 * hold in `settings.json` (design `providers-console-m1.md` §5.8, §7.5).
 *
 * The node's credential keys are `SECRET_ENV_KEYS` in the provider whitelist —
 * the keys whose values are only ever handled by fingerprint. Each of them must
 * disappear from the environment the Bash tool, hooks, MCP and LSP servers get
 * once `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is on, which is what a managed node
 * hands its ACP child (`residentAcpEnv.ts`). Pinned against that list, so a key
 * added there without a scrub entry here fails.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SECRET_ENV_KEYS } from '../../../services/qianmo/providers/whitelist.js'
import { subprocessEnv } from '../subprocessEnv.js'

const CANARY = 'sk-test-canary-subprocess-scrub-4Kd9'
const ADDED = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'OPENCODE_API_KEY',
]
const TOUCHED = [
  ...new Set([
    ...SECRET_ENV_KEYS,
    ...SECRET_ENV_KEYS.map(key => `INPUT_${key}`),
    'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
    'QM_SCRUB_TEST_UNRELATED',
  ]),
]

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map(key => [key, process.env[key]]))
  for (const key of SECRET_ENV_KEYS) {
    process.env[key] = CANARY
    process.env[`INPUT_${key}`] = CANARY
  }
  process.env.QM_SCRUB_TEST_UNRELATED = 'kept'
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('subprocessEnv scrub list', () => {
  test('the five added keys are among the node credential keys', () => {
    for (const key of ADDED) expect(SECRET_ENV_KEYS).toContain(key)
  })

  test('with the scrub on, no node credential key reaches a subprocess', () => {
    process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
    const env = subprocessEnv()
    for (const key of SECRET_ENV_KEYS) {
      expect(env[key]).toBeUndefined()
      expect(env[`INPUT_${key}`]).toBeUndefined()
    }
    expect(Object.values(env)).not.toContain(CANARY)
    // Only the listed keys go: everything else is passed through.
    expect(env.QM_SCRUB_TEST_UNRELATED).toBe('kept')
    // The parent keeps its own copy for its own requests.
    expect(process.env.OPENAI_API_KEY).toBe(CANARY)
  })

  test('with the scrub off, the environment passes through unchanged (today’s default)', () => {
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
    const env = subprocessEnv()
    for (const key of ADDED) expect(env[key]).toBe(CANARY)
  })
})
