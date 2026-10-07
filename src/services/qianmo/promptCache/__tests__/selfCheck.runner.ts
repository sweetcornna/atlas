// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.21 CH-8: the main lane's last request survives a replaced process, in
 * the session's sidecar, under the transcript's persistence rules.
 *
 * A "replaced process" is the module's memory cleared
 * (`resetPromptCacheSelfCheckForTesting`) with the sidecar left on disk — what
 * a new ACP child sees. The session's project directory comes from the real
 * `activateAcpSessionWorkspace`, as in `sessionPromptContext.runner.ts`.
 *
 * Named `.runner.ts` and run by `sessionSwitching.isolated.test.ts` in a
 * process of its own, for the same reason as the CH-1 runner: it moves the
 * process-global session, which a shared `bun test` process may have mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { activateAcpSessionWorkspace, runInAcpWorkspaceTurn } = await import(
  '../../../acp/agent/sessionWorkspace.js'
)
const { resetStateForTests } = await import('../../../../bootstrap/state.js')
const {
  beginPromptCacheSelfCheck,
  PROMPT_CACHE_SELFCHECK_FIELD,
  PROMPT_CACHE_SELFCHECK_SIDECAR_NAME,
  resetPromptCacheSelfCheckForTesting,
} = await import('../selfCheck.js')

type Agent = { sessionId: string; cwd: string; projectDir: string }
type Record_ = { prev: string; changed: string[] } & Record<string, unknown>

let root: string
let A: Agent
const saved: Record<string, string | undefined> = {}

const BODY = {
  model: 'gpt-6-luna',
  prompt_cache_key: 'k1',
  instructions: 'SECRET-INSTRUCTIONS',
  input: [
    { role: 'user', content: 'SECRET-INPUT-1' },
    { role: 'assistant', content: 'b' },
  ],
}

function sidecarOf(a: Agent): string {
  return join(a.projectDir, a.sessionId, PROMPT_CACHE_SELFCHECK_SIDECAR_NAME)
}

/** One completed request of `a`'s main lane (or `agentId`'s), inside a workspace turn. */
async function request(
  a: Agent,
  body: unknown,
  agentId?: string,
): Promise<Record_ | undefined> {
  let record: Record_ | undefined
  await runInAcpWorkspaceTurn(async () => {
    activateAcpSessionWorkspace(a)
    const sc = beginPromptCacheSelfCheck({
      sessionId: a.sessionId,
      querySource: agentId ? 'agent:builtin:general-purpose' : 'sdk',
      agentId,
      messages: [],
    })
    sc?.onRequestBody(JSON.stringify(body))
    record = sc?.settle()[PROMPT_CACHE_SELFCHECK_FIELD] as Record_ | undefined
  })
  return record
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qm-selfcheck-')))
  A = {
    sessionId: 'aaaaaaaa-0000-4000-8000-0000000000a1',
    cwd: join(root, 'ws', 'agent-a'),
    projectDir: join(root, 'config', 'projects', 'agent-a'),
  }
  setEnv('OPENAI_PROMPT_CACHE_SELFCHECK', '1')
  // The transcript writer keeps nothing on disk under NODE_ENV=test without this.
  setEnv('TEST_ENABLE_SESSION_PERSISTENCE', '1')
  resetPromptCacheSelfCheckForTesting()
})

afterEach(() => {
  resetPromptCacheSelfCheckForTesting()
  resetStateForTests()
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete saved[name]
  }
  rmSync(root, { recursive: true, force: true })
})

describe('CH-8 sidecar', () => {
  test('a replaced process compares with the last request before it', async () => {
    expect((await request(A, BODY))?.prev).toBe('none')
    expect(existsSync(sidecarOf(A))).toBe(true)

    resetPromptCacheSelfCheckForTesting()
    const grown = {
      ...BODY,
      input: [...BODY.input, { role: 'user', content: 'c' }],
    }
    expect(await request(A, grown)).toMatchObject({
      prev: 'sidecar',
      changed: [],
      inputPrev: 2,
      inputNow: 3,
    })

    resetPromptCacheSelfCheckForTesting()
    expect(
      await request(A, { ...grown, instructions: 'other instructions' }),
    ).toMatchObject({ prev: 'sidecar', changed: ['instructions_changed'] })
  }, 60_000)

  test('0600 in a 0700 directory, and nothing of the request in it', async () => {
    await request(A, BODY)
    const path = sidecarOf(A)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('gpt-6-luna')
    expect(text).not.toContain('"k1"')
  }, 60_000)

  test('a subagent lane is not kept across processes', async () => {
    await request(A, BODY, 'a-sub')
    expect(existsSync(sidecarOf(A))).toBe(false)
    resetPromptCacheSelfCheckForTesting()
    expect((await request(A, BODY, 'a-sub'))?.prev).toBe('none')
  }, 60_000)

  test('another session’s sidecar is not read', async () => {
    await request(A, BODY)
    const B: Agent = { ...A, sessionId: 'bbbbbbbb-0000-4000-8000-0000000000b2' }
    resetPromptCacheSelfCheckForTesting()
    expect((await request(B, BODY))?.prev).toBe('none')
  }, 60_000)

  test('with persistence off nothing is written, and a new process starts from none', async () => {
    setEnv('TEST_ENABLE_SESSION_PERSISTENCE', undefined)
    expect((await request(A, BODY))?.prev).toBe('none')
    expect(existsSync(sidecarOf(A))).toBe(false)
    resetPromptCacheSelfCheckForTesting()
    expect((await request(A, BODY))?.prev).toBe('none')
  }, 60_000)
})
