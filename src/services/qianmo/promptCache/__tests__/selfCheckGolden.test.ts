// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.21 (CH-8), design `providers-console-m1.md` §5.11.7: the prompt-cache
 * self-check only reads.
 *
 * With `OPENAI_PROMPT_CACHE_SELFCHECK` unset, every request the OpenAI lane
 * puts on the wire (the body text exactly as sent) and every assistant message
 * it yields (what the transcript writer records) is what it was at `cf57a8da`,
 * before CH-8.
 *
 * The golden (`fixtures/selfcheck-golden.cf57a8da.json`) was written by this
 * file running against `cf57a8da`'s production code, before any CH-8 change,
 * with `P18_21_WRITE_GOLDEN=1`; later runs only compare. A message's `uuid`,
 * `timestamp` and `message.id` are random per run and are replaced by
 * placeholders (`messageShape`); nothing else is touched.
 *
 * Drives the REAL `queryModelOpenAI` through the P18.5 recording stub
 * (`modelCompat/__tests__/support/requestCapture.ts`). Nothing leaves the
 * process; the key is a canary.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionId } from 'src/bootstrap/state.js'
import { _resetPromptCacheKeySupportForTesting } from 'src/services/api/openai/openaiShared.js'
import { _resetReasoningSummarySupportForTesting } from 'src/services/api/openai/responsesAdapter.js'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  type CaptureParams,
  captureOpenAIRequests,
} from '../../modelCompat/__tests__/support/requestCapture.js'
import { resetPromptCacheExtrasForTesting } from '../requestExtras.js'
import { resetPinnedPromptCacheKeysForTesting } from '../sessionCacheKey.js'
import {
  FLEET_ENV,
  fleetReply,
  GATEWAY,
  messageShape,
  SYSTEM,
  toolResult,
  userText,
} from './support/fleetTurns.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

function resetLatches(): void {
  resetPinnedPromptCacheKeysForTesting()
  _resetPromptCacheKeySupportForTesting()
  _resetReasoningSummarySupportForTesting()
  resetPromptCacheExtrasForTesting()
}

beforeEach(resetLatches)

const GOLDEN = join(
  import.meta.dir,
  'fixtures',
  'selfcheck-golden.cf57a8da.json',
)
const WRITE = process.env.P18_21_WRITE_GOLDEN === '1'

type Turn = {
  /** What follows the previous turn's reply in the history. */
  readonly append: readonly Message[]
  readonly reply: 'text' | 'tool'
  readonly failFirst?: CaptureParams['failFirst']
}

type Scenario = {
  readonly name: string
  readonly params: Omit<CaptureParams, 'messages' | 'outputs'>
  readonly turns: readonly Turn[]
}

/** Three turns of one conversation; the second is a tool round trip. */
const CONVERSATION: readonly Turn[] = [
  { append: [userText('u-1', 'say ok')], reply: 'text' },
  { append: [userText('u-2', 'list the markdown files')], reply: 'tool' },
  { append: [toolResult('u-3', 'call_2')], reply: 'text' },
]

const FLEET = {
  model: 'gpt-6-luna',
  baseURL: GATEWAY,
  env: FLEET_ENV,
  systemPrompt: SYSTEM,
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'fleet-main-loop',
    params: { ...FLEET, querySource: 'sdk' },
    turns: CONVERSATION,
  },
  {
    name: 'fleet-subagent',
    params: {
      ...FLEET,
      querySource: 'agent:builtin:general-purpose',
      agentId: 'a-golden',
    },
    turns: CONVERSATION.slice(0, 2),
  },
  {
    name: 'fleet-429-then-ok',
    params: { ...FLEET, querySource: 'sdk' },
    turns: [
      CONVERSATION[0]!,
      {
        ...CONVERSATION[1]!,
        failFirst: [
          {
            status: 429,
            body: {
              error: { message: 'Rate limit', type: 'rate_limit_error' },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'chat-lane',
    params: {
      model: 'vendor-chat-model',
      baseURL: GATEWAY,
      env: { OPENAI_WIRE_API: 'chat' },
      querySource: 'sdk',
      systemPrompt: SYSTEM,
    },
    turns: [{ append: [userText('u-1', 'say ok')], reply: 'text' }],
  },
]

type TurnRecord = {
  /** Every body this turn put on the wire, as sent. */
  bodies: string[]
  /** Every assistant message it yielded, shaped. */
  messages: string[]
}

type Run = { turns: TurnRecord[] }

/** Run a scenario; `shape` decides what of each yielded message is kept. */
async function runScenario(
  scenario: Scenario,
  env: Record<string, string | undefined> = {},
  shape: (output: unknown) => Record<string, unknown> = messageShape,
): Promise<Run> {
  const history: Message[] = []
  const turns: TurnRecord[] = []
  for (const [i, turn] of scenario.turns.entries()) {
    history.push(...turn.append)
    const outputs: unknown[] = []
    const requests = await captureOpenAIRequests({
      ...scenario.params,
      env: { ...scenario.params.env, ...env },
      messages: [...history],
      responsesSSE: fleetReply(i + 1, turn.reply),
      failFirst: turn.failFirst,
      outputs,
    })
    const sessionId = getSessionId()
    const assistants = outputs.filter(
      o => (o as { type?: string }).type === 'assistant',
    ) as Message[]
    turns.push({
      // The session-scoped cache key (chat lane) carries the random session id.
      bodies: requests.map(r => r.bodyText.split(sessionId).join('<session>')),
      messages: assistants.map(m => JSON.stringify(shape(m))),
    })
    for (const m of assistants) {
      // A fixed uuid, so the next turn's history is the same on every run.
      history.push({ ...m, uuid: `a-${i + 1}` } as Message)
    }
  }
  return { turns }
}

type Golden = {
  generatedOn: string
  scenarios: Record<string, Run>
}

function readGolden(): Golden {
  return JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
}

describe('CH-8 off: requests and messages byte-identical to cf57a8da', () => {
  if (WRITE) {
    test('write the golden (P18_21_WRITE_GOLDEN=1, on cf57a8da production code only)', async () => {
      const golden: Golden = { generatedOn: 'cf57a8da', scenarios: {} }
      for (const scenario of SCENARIOS) {
        resetLatches()
        golden.scenarios[scenario.name] = await runScenario(scenario)
      }
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`)
    }, 60_000)
    return
  }

  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const expected = readGolden().scenarios[scenario.name]
      expect(expected).toBeDefined()
      const now = await runScenario(scenario)
      expect(now).toEqual(expected as Run)
    }, 30_000)
  }
})

describe('CH-8 on: requests unchanged, messages gain only the self-check field', () => {
  if (WRITE) return
  const FIELD = '_qmPromptCacheSelfCheck'
  /** The base shape, minus the one field CH-8 adds — and a note of whether it was there. */
  const seen: Record<string, boolean[]> = {}
  function shapeWithout(name: string) {
    return (output: unknown): Record<string, unknown> => {
      const shaped = messageShape(output)
      const inner = shaped.message as Record<string, unknown> | undefined
      ;(seen[name] ??= []).push(inner !== undefined && FIELD in inner)
      if (inner !== undefined) delete inner[FIELD]
      return shaped
    }
  }

  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const expected = readGolden().scenarios[scenario.name]
      expect(expected).toBeDefined()
      const now = await runScenario(
        scenario,
        { OPENAI_PROMPT_CACHE_SELFCHECK: '1' },
        shapeWithout(scenario.name),
      )
      expect(now).toEqual(expected as Run)
      // Recorded on every message of a tracked /responses lane, never on chat.
      const marks = seen[scenario.name] ?? []
      expect(marks.length).toBeGreaterThan(0)
      expect(marks.every(m => m === (scenario.name !== 'chat-lane'))).toBe(true)
    }, 30_000)
  }
})
