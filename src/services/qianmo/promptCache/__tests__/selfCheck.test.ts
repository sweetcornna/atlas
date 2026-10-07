// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.21 (CH-8), design `providers-console-m1.md` §5.11.7: what the
 * prompt-cache self-check records.
 *
 * The first half drives the REAL `queryModelOpenAI` through the P18.5
 * recording stub, so every record is computed from a body the lane really put
 * on the wire; each "changed" case has an unchanged twin. The second half
 * calls the module directly for the parts the lane cannot be made to vary
 * (key, tier, format, verbosity) and for its edges.
 *
 * Nothing is written to disk here: under NODE_ENV=test the transcript rule
 * keeps nothing, and the self-check follows it. The sidecar is covered in
 * `selfCheck.runner.ts`, in a process of its own.
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
import { _resetPromptCacheKeySupportForTesting } from 'src/services/api/openai/openaiShared.js'
import { _resetReasoningSummarySupportForTesting } from 'src/services/api/openai/responsesAdapter.js'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  type CaptureParams,
  captureOpenAIRequests,
} from '../../modelCompat/__tests__/support/requestCapture.js'
import { resetPromptCacheExtrasForTesting } from '../requestExtras.js'
import {
  beginPromptCacheSelfCheck,
  PROMPT_CACHE_SELFCHECK_FIELD,
  type PromptCacheSelfCheckRecord,
  resetPromptCacheSelfCheckForTesting,
} from '../selfCheck.js'
import { resetPinnedPromptCacheKeysForTesting } from '../sessionCacheKey.js'
import {
  FLEET_ENV,
  fleetReply,
  GATEWAY,
  SYSTEM,
  toolResult,
  userText,
} from './support/fleetTurns.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

let savedSwitch: string | undefined
beforeEach(() => {
  resetPinnedPromptCacheKeysForTesting()
  _resetPromptCacheKeySupportForTesting()
  _resetReasoningSummarySupportForTesting()
  resetPromptCacheExtrasForTesting()
  resetPromptCacheSelfCheckForTesting()
  savedSwitch = process.env.OPENAI_PROMPT_CACHE_SELFCHECK
  process.env.OPENAI_PROMPT_CACHE_SELFCHECK = '1'
})
afterEach(() => {
  if (savedSwitch === undefined)
    delete process.env.OPENAI_PROMPT_CACHE_SELFCHECK
  else process.env.OPENAI_PROMPT_CACHE_SELFCHECK = savedSwitch
  resetPromptCacheSelfCheckForTesting()
})

const ON = { ...FLEET_ENV, OPENAI_PROMPT_CACHE_SELFCHECK: '1' }

type Step = {
  readonly append?: readonly Message[]
  /** Replace the whole history instead (compaction). */
  readonly history?: readonly Message[]
  /** Rewrite the history in place before appending. */
  readonly edit?: (history: Message[]) => Message[]
  readonly reply?: 'text' | 'tool'
  readonly params?: Partial<CaptureParams>
}

type StepResult = {
  record: PromptCacheSelfCheckRecord | undefined
  /** Every body put on the wire for this step, parsed. */
  bodies: Record<string, unknown>[]
}

/** Run a conversation; each step is one model request with its own reply. */
async function converse(
  steps: readonly Step[],
  base: Partial<CaptureParams> = {},
): Promise<StepResult[]> {
  let history: Message[] = []
  const results: StepResult[] = []
  for (const [i, step] of steps.entries()) {
    if (step.history !== undefined) history = [...step.history]
    if (step.edit !== undefined) history = step.edit(history)
    history.push(...(step.append ?? []))
    const outputs: unknown[] = []
    const params = { ...base, ...step.params }
    const requests = await captureOpenAIRequests({
      model: 'gpt-6-luna',
      baseURL: GATEWAY,
      systemPrompt: SYSTEM,
      querySource: 'sdk',
      ...params,
      env: { ...ON, ...params.env },
      messages: [...history],
      responsesSSE: fleetReply(i + 1, step.reply ?? 'text'),
      outputs,
    })
    const assistants = outputs.filter(
      o => (o as { type?: string }).type === 'assistant',
    ) as Message[]
    const inner = (assistants[0] as { message?: Record<string, unknown> })
      ?.message
    results.push({
      record: inner?.[PROMPT_CACHE_SELFCHECK_FIELD] as
        | PromptCacheSelfCheckRecord
        | undefined,
      bodies: requests.map(r => r.body),
    })
    for (const m of assistants) {
      history.push({ ...m, uuid: `a-${i + 1}` } as Message)
    }
  }
  return results
}

function inputOf(body: Record<string, unknown> | undefined): unknown[] {
  return (body?.input as unknown[] | undefined) ?? []
}

/** Where two bodies' `input` arrays first differ, by plain JSON. */
function firstDifference(a: unknown[], b: unknown[]): number | undefined {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i
  }
  return b.length < a.length ? b.length : undefined
}

const THREE_TURNS: readonly Step[] = [
  { append: [userText('u-1', 'say ok')] },
  { append: [userText('u-2', 'list the markdown files')], reply: 'tool' },
  { append: [toolResult('u-3', 'call_2')] },
]

describe('CH-8 through the real OpenAI lane', () => {
  test('a plain conversation: none, then memory with nothing changed', async () => {
    const r = await converse(THREE_TURNS)
    expect(r[0]!.record).toEqual({
      v: 1,
      prev: 'none',
      changed: [],
      inputPrev: 0,
      inputNow: inputOf(r[0]!.bodies[0]).length,
    })
    for (const i of [1, 2]) {
      expect(r[i]!.record).toEqual({
        v: 1,
        prev: 'memory',
        changed: [],
        inputPrev: inputOf(r[i - 1]!.bodies[0]).length,
        inputNow: inputOf(r[i]!.bodies[0]).length,
      })
      // The twin of every case below: the previous input really is a prefix.
      expect(
        firstDifference(inputOf(r[i - 1]!.bodies[0]), inputOf(r[i]!.bodies[0])),
      ).toBeUndefined()
    }
  }, 60_000)

  test('changed instructions (a workspace status that moved)', async () => {
    const r = await converse([
      THREE_TURNS[0]!,
      {
        ...THREE_TURNS[1]!,
        params: {
          systemPrompt: ['You are a node agent.', 'Workspace status: (dirty)'],
        },
      },
    ])
    expect(r[0]!.bodies[0]!.instructions).not.toEqual(
      r[1]!.bodies[0]!.instructions,
    )
    expect(r[1]!.record?.changed).toEqual(['instructions_changed'])
  }, 60_000)

  test('changed effort', async () => {
    const r = await converse([
      THREE_TURNS[0]!,
      {
        ...THREE_TURNS[1]!,
        params: { env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } },
      },
    ])
    expect(r[1]!.record?.changed).toEqual(['reasoning_effort_changed'])
  }, 60_000)

  test('a tool table that changed', async () => {
    const r = await converse([
      THREE_TURNS[0]!,
      {
        ...THREE_TURNS[1]!,
        params: {
          // Minimal tool: what toolToAPISchema reads (schemaRules.test.ts).
          tools: [
            {
              name: 'GlobP1821',
              inputJSONSchema: { type: 'object', properties: {} },
              prompt: async () => 'Find files.',
            } as never,
          ],
        },
      },
    ])
    expect(r[1]!.record?.changed).toContain('tools_changed')
  }, 60_000)

  test('an old input item rewritten: input_changed at that item', async () => {
    const r = await converse([
      THREE_TURNS[0]!,
      THREE_TURNS[1]!,
      {
        // Same conversation, but the first user message now reads differently.
        edit: h =>
          h.map(m => (m.uuid === 'u-1' ? userText('u-1', 'say OK please') : m)),
        append: [userText('u-4', 'and now?')],
      },
    ])
    const at = firstDifference(
      inputOf(r[1]!.bodies[0]),
      inputOf(r[2]!.bodies[0]),
    )
    expect(at).toBeDefined()
    expect(r[2]!.record?.changed).toEqual(['input_changed'])
    expect(r[2]!.record?.divergedAt).toBe(at as number)
  }, 60_000)

  test('compaction: the earliest assistant message is gone → context_compacted', async () => {
    const r = await converse([
      THREE_TURNS[0]!,
      THREE_TURNS[1]!,
      {
        history: [
          userText('c-1', 'Summary of the conversation so far.'),
          userText('u-9', 'carry on'),
        ],
      },
    ])
    expect(r[2]!.record?.changed).toEqual(['context_compacted'])
    expect(r[2]!.record?.divergedAt).toBe(0)
  }, 60_000)

  test('a subagent is its own lane; an untracked source records nothing', async () => {
    const main = await converse(THREE_TURNS.slice(0, 2))
    expect(main[1]!.record?.prev).toBe('memory')
    const sub = await converse(THREE_TURNS.slice(0, 2), {
      querySource: 'agent:builtin:general-purpose',
      agentId: 'a-sub',
    })
    expect(sub[0]!.record?.prev).toBe('none')
    expect(sub[1]!.record).toMatchObject({ prev: 'memory', changed: [] })
    const fork = await converse(THREE_TURNS.slice(0, 1), {
      querySource: 'compact',
    })
    expect(fork[0]!.record).toBeUndefined()
  }, 60_000)

  test('a retried request: the record compares the body that got the reply', async () => {
    const r = await converse([
      THREE_TURNS[0]!,
      {
        ...THREE_TURNS[1]!,
        params: {
          failFirst: [
            {
              status: 429,
              body: {
                error: { message: 'Rate limit', type: 'rate_limit_error' },
              },
            },
          ],
        },
      },
    ])
    expect(r[1]!.bodies.length).toBe(2)
    expect(r[1]!.record).toMatchObject({ prev: 'memory', changed: [] })
  }, 60_000)

  test('switch off: no field at all', async () => {
    const r = await converse(THREE_TURNS.slice(0, 2), {
      env: { OPENAI_PROMPT_CACHE_SELFCHECK: undefined },
    })
    expect(r.every(x => x.record === undefined)).toBe(true)
  }, 60_000)
})

describe('CH-8 module edges', () => {
  const SESSION = 'cccccccc-0000-4000-8000-000000000003'
  const BASE = {
    model: 'gpt-6-luna',
    prompt_cache_key: 'k1',
    instructions: 'be brief',
    tools: [{ type: 'function', name: 'Glob' }],
    reasoning: { effort: 'max', summary: 'auto' },
    text: { verbosity: 'medium' },
    input: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
  }

  function check(
    body: unknown,
    messages: readonly unknown[] = [],
  ): PromptCacheSelfCheckRecord | undefined {
    const sc = beginPromptCacheSelfCheck({
      sessionId: SESSION,
      querySource: 'sdk',
      agentId: undefined,
      messages,
    })
    sc?.onRequestBody(typeof body === 'string' ? body : JSON.stringify(body))
    return sc?.settle()[PROMPT_CACHE_SELFCHECK_FIELD] as
      | PromptCacheSelfCheckRecord
      | undefined
  }

  test('each compared part names its own reason, in a fixed order', () => {
    check(BASE)
    expect(
      check({
        ...BASE,
        prompt_cache_key: 'k2',
        service_tier: 'flex',
        text: { verbosity: 'low', format: { type: 'json_object' } },
      })?.changed,
    ).toEqual([
      'prompt_cache_key_changed',
      'service_tier_changed',
      'text_format_changed',
      'verbosity_changed',
    ])
  })

  test('key order is not a change; fields outside the prefix are not compared', () => {
    check(BASE)
    const reordered = {
      input: BASE.input.map(i => ({ content: i.content, role: i.role })),
      text: BASE.text,
      reasoning: { summary: 'auto', effort: 'max' },
      tools: BASE.tools,
      instructions: BASE.instructions,
      prompt_cache_key: BASE.prompt_cache_key,
      model: BASE.model,
      // Not part of what decides reuse:
      max_output_tokens: 99,
      stream: true,
      store: false,
      tool_choice: 'none',
      prompt_cache_retention: '24h',
      prompt_cache_options: { comparison_response_id: 'resp_1' },
    }
    expect(check(reordered)?.changed).toEqual([])
  })

  test('input that grew is a continuation; input that shrank diverges where it ends', () => {
    check(BASE)
    const grown = {
      ...BASE,
      input: [...BASE.input, { role: 'user', content: 'c' }],
    }
    expect(check(grown)).toMatchObject({
      changed: [],
      inputPrev: 2,
      inputNow: 3,
    })
    expect(check(BASE)).toMatchObject({
      changed: ['input_changed'],
      inputPrev: 3,
      inputNow: 2,
      divergedAt: 2,
    })
  })

  test('nothing recorded without a body or with one that is not JSON; settle is idempotent', () => {
    const none = beginPromptCacheSelfCheck({
      sessionId: SESSION,
      querySource: 'sdk',
      agentId: undefined,
      messages: [],
    })
    expect(none?.settle()).toEqual({})
    expect(check('{not json')).toBeUndefined()
    const sc = beginPromptCacheSelfCheck({
      sessionId: SESSION,
      querySource: 'sdk',
      agentId: undefined,
      messages: [],
    })
    sc?.onRequestBody(JSON.stringify(BASE))
    const first = sc?.settle()
    expect(sc?.settle()).toBe(first as Record<string, unknown>)
  })

  test('off, or an untracked source: no self-check at all', () => {
    delete process.env.OPENAI_PROMPT_CACHE_SELFCHECK
    expect(
      beginPromptCacheSelfCheck({
        sessionId: SESSION,
        querySource: 'sdk',
        agentId: undefined,
        messages: [],
      }),
    ).toBeUndefined()
    process.env.OPENAI_PROMPT_CACHE_SELFCHECK = '1'
    for (const querySource of ['compact', 'session_memory', undefined]) {
      expect(
        beginPromptCacheSelfCheck({
          sessionId: SESSION,
          querySource,
          agentId: undefined,
          messages: [],
        }),
      ).toBeUndefined()
    }
  })

  test('nothing but counts, indices and reason words', () => {
    check(BASE)
    const record = check({ ...BASE, instructions: 'SECRET-INSTRUCTIONS' })
    const text = JSON.stringify(record)
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('gpt-6-luna')
    expect(text).not.toContain('k1')
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'changed',
      'inputNow',
      'inputPrev',
      'prev',
      'v',
    ])
  })
})
