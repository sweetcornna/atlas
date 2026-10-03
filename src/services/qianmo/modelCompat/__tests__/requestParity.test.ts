// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-vendor request-body parity table (design `providers-console-m1.md`
 * §5.9 item 2; hermes-research §11.6 recommendation 2).
 *
 * Each row is (vendor, model, base URL, explicit wire, effort inputs, thinking
 * switch, side query) → what the OpenAI-compatible lane puts on the wire:
 * which endpoint, which keys with which values, which keys are absent. It is
 * the executable form of AC-P4 ("display = node computation = request
 * body") for the OpenAI lane and of the mapping tables in §5.6.
 *
 * P18.5 lays down the header (the `ParityRow` columns) and the rows for its
 * own items; P18.8 and P18.12 append rows for theirs. A row never encodes a
 * vendor claim as fact: `source` says where the expectation comes from, and
 * no row has been checked against a real endpoint (design §11 item 5).
 *
 * Every row runs the real `queryModelOpenAI` through a recording stub
 * (`support/requestCapture.ts`): no network, a canary key.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  type CaptureParams,
  captureOpenAIRequest,
} from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

// ─── header ──────────────────────────────────────────────────────────────────

type ParityRow = {
  /** Stable id; later batches reference rows by it. */
  id: string
  /** 厂商 — free text, for the reader. */
  vendor: string
  /** 模型 — the session model (options.model). */
  model: string
  /** base URL — OPENAI_BASE_URL; `undefined` = unset (SDK default). */
  baseURL: string | undefined
  /** 显式线路 — OPENAI_WIRE_API; `undefined` = not set. */
  wire: 'chat' | 'responses' | undefined
  /** effort 输入 — what the session asked for, and the explicit switches. */
  effort: {
    /** In-session `/effort` (options.effortValue). */
    session?: CaptureParams['effortValue']
    /** CLAUDE_CODE_EFFORT_LEVEL. */
    env?: string
    /** CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1. */
    alwaysEnable?: boolean
    /** Tier pin + capability list for this model (OPENAI_DEFAULT_OPUS_*). */
    capabilities?: string
  }
  /** 思考开关 — OPENAI_ENABLE_THINKING; `auto` = unset. */
  thinking: 'auto' | 'on' | 'off'
  /** 是否副查询 — a side query passes temperatureOverride: 0. */
  sideQuery: boolean
  /** Anything else the row needs in env (e.g. the DeepSeek wire switch). */
  extraEnv?: Record<string, string>
  /** options.maxOutputTokensOverride. */
  maxOutputTokensOverride?: number
  /** P18.8: history the request replays (default none). */
  history?: Message[]
  expect: {
    /** Path the request went to. */
    path: '/chat/completions' | '/responses'
    /** Keys that must be present, with their exact (deep-equal) value. */
    present?: Record<string, unknown>
    /** Keys that must be absent. */
    absent?: string[]
    /**
     * P18.8: per assistant message in `messages`, in order — keys with their
     * exact value, or {@link ABSENT}.
     */
    assistants?: Record<string, unknown>[]
  }
  /** Where the expectation comes from (design § / hermes file:line / baseline). */
  source: string
}

function captureParams(row: ParityRow): CaptureParams {
  const env: Record<string, string | undefined> = { ...row.extraEnv }
  if (row.wire) env.OPENAI_WIRE_API = row.wire
  if (row.effort.env) env.CLAUDE_CODE_EFFORT_LEVEL = row.effort.env
  if (row.effort.alwaysEnable) env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  if (row.effort.capabilities !== undefined) {
    env.OPENAI_DEFAULT_OPUS_MODEL = row.model
    env.OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES =
      row.effort.capabilities
  }
  if (row.thinking === 'on') env.OPENAI_ENABLE_THINKING = '1'
  if (row.thinking === 'off') env.OPENAI_ENABLE_THINKING = '0'
  return {
    model: row.model,
    baseURL: row.baseURL,
    env,
    effortValue: row.effort.session,
    temperatureOverride: row.sideQuery ? 0 : undefined,
    maxOutputTokensOverride: row.maxOutputTokensOverride,
    messages: row.history,
  }
}

/** `expect.assistants` value for "this key is not on the message". */
const ABSENT = Symbol('absent')

// ─── rows ────────────────────────────────────────────────────────────────────

const GATEWAY = 'https://gateway.example/v1'
const OFFICIAL = 'https://api.openai.com/v1'
const DEEPSEEK = 'https://api.deepseek.com'
const AZURE = 'https://myres.openai.azure.com/openai/v1'
/** DeepSeek's default is the Anthropic wire; these rows pin the chat lane. */
const DEEPSEEK_CHAT_LANE = { CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE: '0' }

/**
 * P18.8 replay rows: a constructed conversation (not recorded) with one
 * assistant turn of each shape hermes `message_sanitization.py:714-802`
 * distinguishes — reasoning text, a tool call with no reasoning, and the
 * empty reasoning DeepSeek returns when it answers directly.
 */
function replayHistory(): Message[] {
  const user = (uuid: string, content: unknown): Message =>
    ({
      type: 'user',
      uuid,
      message: { role: 'user', content },
    }) as unknown as Message
  const assistant = (id: string, content: unknown[]): Message =>
    ({
      type: 'assistant',
      uuid: `a-${id}`,
      message: { id, role: 'assistant', content },
    }) as unknown as Message
  return [
    user('u1', 'q1'),
    assistant('m1', [
      { type: 'thinking', thinking: 'chain', signature: '' },
      { type: 'text', text: 'a1' },
    ]),
    user('u2', 'q2'),
    assistant('m2', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    user('u3', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    assistant('m3', [
      { type: 'thinking', thinking: '', signature: '' },
      { type: 'text', text: 'a2' },
    ]),
    user('u4', 'q3'),
  ]
}
/** `reasoning_content` on the three replayed assistant turns, per side. */
const STRICT_REPLAY = [ABSENT, ABSENT, ABSENT].map(v => ({
  reasoning_content: v,
}))
const PADDED_REPLAY = ['chain', ' ', ' '].map(v => ({ reasoning_content: v }))
const DEEPSEEK_REPLAY = ['chain', '', ''].map(v => ({ reasoning_content: v }))

/**
 * P18.8 #10 rows: one tool call whose block captured a Gemini thought
 * signature on an earlier turn (constructed; the field is the one the stream
 * adapter writes, `GEMINI_THOUGHT_SIGNATURE_FIELD`).
 */
function signedToolHistory(): Message[] {
  return [
    {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'q1' },
    },
    {
      type: 'assistant',
      uuid: 'a-m1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: {},
            _geminiThoughtSignature: 'SIG-P188',
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    },
  ] as unknown as Message[]
}
const SIGNED_CALL = {
  id: 't1',
  type: 'function',
  function: { name: 'Read', arguments: '{}' },
}

const ROWS: ParityRow[] = [
  // ── Q-1: chat lane effort gate = modelSupportsEffort (design §5.2) ──
  {
    id: 'q1-unknown-no-override',
    vendor: 'OpenAI-compatible gateway',
    model: 'vendor-model-x',
    baseURL: GATEWAY,
    wire: 'chat',
    effort: { session: 'high' },
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/chat/completions', absent: ['reasoning_effort'] },
    source: 'design §5.2: modelSupportsEffort false ⇒ not sent',
  },
  {
    id: 'q1-unknown-always-enable',
    vendor: 'OpenAI-compatible gateway',
    model: 'vendor-model-x',
    baseURL: GATEWAY,
    wire: 'chat',
    effort: { session: 'max', alwaysEnable: true },
    thinking: 'auto',
    sideQuery: false,
    expect: {
      path: '/chat/completions',
      present: { reasoning_effort: 'high' },
    },
    source:
      'design §5.2: explicit override reaches chat; chat folds max → high (reasoning.ts getChatReasoningEffort)',
  },
  {
    id: 'q1-unknown-capability-effort',
    vendor: 'OpenAI-compatible gateway',
    model: 'vendor-model-x',
    baseURL: GATEWAY,
    wire: 'chat',
    effort: { session: 'low', capabilities: 'effort' },
    thinking: 'auto',
    sideQuery: false,
    expect: {
      path: '/chat/completions',
      present: { reasoning_effort: 'low' },
    },
    source: 'design §3.4 send=always compiles to an explicit capability list',
  },
  {
    id: 'q1-codex-model-unchanged',
    vendor: 'OpenAI-compatible gateway',
    model: 'gpt-5.4',
    baseURL: GATEWAY,
    wire: 'chat',
    effort: { session: 'medium' },
    thinking: 'auto',
    sideQuery: false,
    expect: {
      path: '/chat/completions',
      present: { reasoning_effort: 'medium' },
    },
    source: 'baseline 1b477a37: Codex reasoning models already sent it',
  },
  {
    id: 'q1-codex-model-capability-off',
    vendor: 'OpenAI-compatible gateway',
    model: 'gpt-5.4',
    baseURL: GATEWAY,
    wire: 'chat',
    effort: { session: 'medium', capabilities: 'thinking' },
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/chat/completions', absent: ['reasoning_effort'] },
    source: 'design §3.4 send=never: explicit list without effort',
  },
  {
    id: 'q1-deepseek-thinking-off-unchanged',
    vendor: 'DeepSeek (chat lane)',
    model: 'deepseek-v4-pro',
    baseURL: DEEPSEEK,
    wire: undefined,
    effort: { session: 'high' },
    thinking: 'off',
    sideQuery: false,
    extraEnv: DEEPSEEK_CHAT_LANE,
    expect: {
      path: '/chat/completions',
      present: { thinking: { type: 'disabled' } },
      absent: ['reasoning_effort'],
    },
    source:
      'baseline 1b477a37 (requestBody.ts DeepSeek ladder: thinking off sends no effort)',
  },
  {
    id: 'q1-deepseek-thinking-on-unchanged',
    vendor: 'DeepSeek (chat lane)',
    model: 'deepseek-v4-pro',
    baseURL: DEEPSEEK,
    wire: undefined,
    effort: { session: 'medium' },
    thinking: 'on',
    sideQuery: false,
    extraEnv: DEEPSEEK_CHAT_LANE,
    expect: {
      path: '/chat/completions',
      present: { reasoning_effort: 'high', thinking: { type: 'enabled' } },
    },
    source: 'baseline 1b477a37 (deepseekTuning.ts: medium → high)',
  },

  // ── #22: hosts that mandate a lane, after an explicit OPENAI_WIRE_API ──
  {
    id: '22-official-default-responses',
    vendor: 'OpenAI (official)',
    model: 'gpt-4o',
    baseURL: OFFICIAL,
    wire: undefined,
    effort: {},
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/responses', absent: ['messages', 'reasoning'] },
    source: 'hermes hermes_cli/providers.py:644-649; design §5.6 row 22',
  },
  {
    id: '22-official-explicit-chat',
    vendor: 'OpenAI (official)',
    model: 'gpt-4o',
    baseURL: OFFICIAL,
    wire: 'chat',
    effort: {},
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/chat/completions' },
    source: 'design §5.6 row 22: explicit OPENAI_WIRE_API wins',
  },
  {
    id: '22-azure-o-series-responses',
    vendor: 'Azure OpenAI',
    model: 'o3-mini',
    baseURL: AZURE,
    wire: undefined,
    effort: {},
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/responses' },
    source: 'hermes hermes_cli/models.py:4436-4479 (Foundry families)',
  },
  {
    id: '22-azure-gpt-4o-chat',
    vendor: 'Azure OpenAI',
    model: 'gpt-4o',
    baseURL: AZURE,
    wire: undefined,
    effort: {},
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/chat/completions' },
    source:
      'hermes hermes_cli/models.py:4458-4460: other families stay on chat',
  },
  {
    id: '22-meta-responses',
    vendor: 'Meta Model API',
    model: 'muse-spark',
    baseURL: 'https://api.meta.ai/v1',
    wire: undefined,
    effort: {},
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/responses' },
    source: 'hermes hermes_cli/providers.py:650-654',
  },

  // ── #11: max_tokens or max_completion_tokens on the chat lane ──
  // maxOutputTokensOverride makes the cap explicit, so these rows keep a cap
  // to name whatever #3 decides for an unknown model.
  ...(
    [
      [
        'o3-mini',
        GATEWAY,
        true,
        'hermes utils.py:871-903 (o-series, any host)',
      ],
      [
        'openai/o4-mini',
        'https://openrouter.ai/api/v1',
        true,
        'hermes utils.py:893-894 (vendor prefix)',
      ],
      [
        'gpt-5.4',
        OFFICIAL,
        true,
        'baseline 1b477a37 (Codex lineage, official)',
      ],
      [
        'gpt-6-luna',
        OFFICIAL,
        true,
        'hermes run_agent.py:1631-1636 (official host)',
      ],
      ['gpt-5.4', AZURE, true, 'hermes run_agent.py:1631-1636 (Azure host)'],
      [
        'gpt-4o',
        OFFICIAL,
        false,
        'pinned by thinking.test.ts (narrowed, see outputTokenParam.ts)',
      ],
      [
        'gpt-5.4',
        GATEWAY,
        false,
        'pinned by thinking.test.ts (narrowed, see outputTokenParam.ts)',
      ],
      ['glm-5.2', GATEWAY, false, 'baseline 1b477a37'],
    ] as const
  ).map(
    ([model, baseURL, newName, source]): ParityRow => ({
      id: `11-${model.replace('/', '_')}-${new URL(baseURL).hostname}`,
      vendor: 'chat lane output-cap name',
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'auto',
      sideQuery: false,
      maxOutputTokensOverride: 4096,
      expect: {
        path: '/chat/completions',
        present: newName
          ? { max_completion_tokens: 4096 }
          : { max_tokens: 4096 },
        absent: [newName ? 'max_tokens' : 'max_completion_tokens'],
      },
      source,
    }),
  ),

  // ── #3: whether the chat request carries an output cap at all ──
  ...(
    [
      [
        'glm-5.2',
        'https://open.bigmodel.cn/api/paas/v4',
        undefined,
        'hermes chat_completions.py:733-763 (zai profile, no default)',
      ],
      ['o3', OFFICIAL, undefined, 'hermes (openai, no default)'],
      [
        'meta-llama/llama-4',
        'https://openrouter.ai/api/v1',
        undefined,
        'hermes (openrouter, no default)',
      ],
      [
        'kimi-k3',
        'https://api.moonshot.cn/v1',
        32_000,
        'hermes kimi-coding/__init__.py:134-136',
      ],
      [
        'anthropic/claude-opus-5',
        'https://openrouter.ai/api/v1',
        64_000,
        'hermes chat_completion_helpers.py:1993-2013 (claude name)',
      ],
      [
        'minimax/minimax-m3',
        'https://openrouter.ai/api/v1',
        64_000,
        'hermes chat_completion_helpers.py:1993-2013 (minimax name)',
      ],
      [
        'qwen3-coder',
        'http://localhost:8000/v1',
        64_000,
        'hermes custom/__init__.py:96-100 + qwen3 name',
      ],
      [
        'vendor-model-x',
        GATEWAY,
        64_000,
        'hermes custom/__init__.py:96-100 (unrecognised host)',
      ],
      [
        'ep-20261003-abcde',
        'https://ark.cn-beijing.volces.com/api/v3',
        64_000,
        'vendors-research 方舟: 4k default when omitted',
      ],
    ] as const
  ).map(
    ([model, baseURL, cap, source]): ParityRow => ({
      id: `3-${model.replace('/', '_')}-${new URL(baseURL).hostname}`,
      vendor: 'chat lane output cap',
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'auto',
      sideQuery: false,
      // A name with a tier word (opus/sonnet/…) is a tier alias on this lane
      // (modelMapping.ts) and would reach the wire as gpt-5.6-*; pin it.
      extraEnv: model.includes('opus')
        ? { OPENAI_DEFAULT_OPUS_MODEL: model }
        : undefined,
      expect:
        cap === undefined
          ? {
              path: '/chat/completions',
              absent: ['max_tokens', 'max_completion_tokens'],
            }
          : { path: '/chat/completions', present: { max_tokens: cap } },
      source,
    }),
  ),
  {
    id: '3-deepseek-chat-lane-omitted',
    vendor: 'DeepSeek (chat lane)',
    model: 'deepseek-v4-pro',
    baseURL: DEEPSEEK,
    wire: undefined,
    effort: {},
    thinking: 'on',
    sideQuery: false,
    extraEnv: DEEPSEEK_CHAT_LANE,
    expect: {
      path: '/chat/completions',
      absent: ['max_tokens', 'max_completion_tokens'],
    },
    source:
      'hermes deepseek profile (no default); hermes-research §11.9-② row 6 flips',
  },
  {
    id: '3-openai-max-tokens-env',
    vendor: 'Zhipu (catalog maxOutputTokens → OPENAI_MAX_TOKENS)',
    model: 'glm-5.2',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    wire: 'chat',
    effort: {},
    thinking: 'auto',
    sideQuery: false,
    extraEnv: { OPENAI_MAX_TOKENS: '8192' },
    expect: { path: '/chat/completions', present: { max_tokens: 8192 } },
    source: 'design §3.2 maxOutputTokens / §5.6 row 3 (OPENAI_MAX_TOKENS kept)',
  },
  {
    id: '3-responses-unchanged',
    vendor: 'Zhipu (Responses)',
    model: 'glm-5.2',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    wire: 'responses',
    effort: {},
    thinking: 'auto',
    sideQuery: false,
    expect: { path: '/responses', present: { max_output_tokens: 64_000 } },
    source: 'design §5.6 row 3 is chat-only; baseline 1b477a37',
  },

  // ── #12: side queries (temperatureOverride 0) to reasoning models / Kimi ──
  ...(
    [
      [
        'o3',
        OFFICIAL,
        false,
        'design §5.6 row 12 (o-series); hermes-research §11.9-② row 1 flips',
      ],
      ['gpt-5.4', GATEWAY, false, 'design §5.6 row 12 (gpt-5)'],
      ['gpt-6-luna', OFFICIAL, false, 'design §5.6 row 12 (gpt-6)'],
      [
        'kimi-k3',
        'https://api.moonshot.cn/v1',
        false,
        'hermes auxiliary_client.py:604-616; §11.9-② row 3 flips',
      ],
      [
        'moonshot-v1-8k',
        'https://api.moonshot.ai/v1',
        false,
        'hermes kimi-coding/__init__.py:120 (host)',
      ],
      [
        'glm-5.2',
        'https://open.bigmodel.cn/api/paas/v4',
        true,
        'baseline 1b477a37 (not a reasoning name)',
      ],
      ['qwen3-coder', 'http://localhost:8000/v1', true, 'baseline 1b477a37'],
    ] as const
  ).map(
    ([model, baseURL, sendsTemperature, source]): ParityRow => ({
      id: `12-side-${model}-${new URL(baseURL).hostname}`,
      vendor: 'chat lane side query',
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'off',
      sideQuery: true,
      expect: sendsTemperature
        ? { path: '/chat/completions', present: { temperature: 0 } }
        : { path: '/chat/completions', absent: ['temperature'] },
      source,
    }),
  ),
  {
    id: '12-side-deepseek-own-temperature',
    vendor: 'DeepSeek (chat lane)',
    model: 'deepseek-v4-pro',
    baseURL: DEEPSEEK,
    wire: undefined,
    effort: {},
    thinking: 'off',
    sideQuery: true,
    extraEnv: DEEPSEEK_CHAT_LANE,
    expect: { path: '/chat/completions', present: { temperature: 0 } },
    source: 'baseline 1b477a37 (DeepSeek coding temperature, #30 kept)',
  },
  {
    id: '12-side-responses-unchanged',
    vendor: 'OpenAI Responses',
    model: 'gpt-6-luna',
    baseURL: GATEWAY,
    wire: 'responses',
    effort: {},
    thinking: 'auto',
    sideQuery: true,
    expect: { path: '/responses', absent: ['temperature'] },
    source: 'baseline 1b477a37 (Responses never sent it)',
  },

  // ── #4 (P18.8): reasoning replay by target endpoint (design §5.4) ──
  // hermes message_sanitization.py:655-664 family table, row by row.
  ...(
    [
      ['mistral', 'mistral-large-latest', 'https://api.mistral.ai/v1'],
      ['cerebras', 'llama-4-scout', 'https://api.cerebras.ai/v1'],
      ['groq', 'llama-3.3-70b', 'https://api.groq.com/openai/v1'],
      ['sambanova', 'Meta-Llama-3.3-70B', 'https://api.sambanova.ai/v1'],
      ['openrouter-kimi', 'moonshotai/kimi-k3', 'https://openrouter.ai/api/v1'],
      ['gateway', 'vendor-model-x', GATEWAY],
      ['official', 'gpt-4.1', OFFICIAL],
    ] as const
  ).map(
    ([label, model, baseURL]): ParityRow => ({
      id: `4-strict-${label}`,
      vendor: `strict side (${label})`,
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'auto',
      sideQuery: false,
      history: replayHistory(),
      expect: { path: '/chat/completions', assistants: STRICT_REPLAY },
      source:
        'hermes message_sanitization.py:630-653 (strict side: strip, even " ")',
    }),
  ),
  ...(
    [
      ['moonshot-cn', 'kimi-k3', 'https://api.moonshot.cn/v1'],
      ['moonshot-ai', 'kimi-k2.6', 'https://api.moonshot.ai/v1'],
      ['kimi-code', 'k3', 'https://api.kimi.com/coding/v1'],
    ] as const
  ).map(
    ([label, model, baseURL]): ParityRow => ({
      id: `4-kimi-${label}`,
      vendor: 'Kimi / Moonshot',
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'auto',
      sideQuery: false,
      history: replayHistory(),
      expect: { path: '/chat/completions', assistants: PADDED_REPLAY },
      source:
        'hermes message_sanitization.py:655-664 kimi row (host-driven) + :788-798 pad',
    }),
  ),
  ...(
    [
      ['official', 'mimo-v2.6-pro', 'https://api.xiaomimimo.com/v1'],
      ['by-name', 'mimo-v2.6-flash', GATEWAY],
    ] as const
  ).map(
    ([label, model, baseURL]): ParityRow => ({
      id: `4-mimo-${label}`,
      vendor: 'Xiaomi MiMo',
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'auto',
      sideQuery: false,
      history: replayHistory(),
      expect: { path: '/chat/completions', assistants: PADDED_REPLAY },
      source: 'hermes message_sanitization.py:655-664 mimo row + :726-753',
    }),
  ),
  ...(
    [
      ['official', 'deepseek-v4-pro', DEEPSEEK],
      ['by-name', 'deepseek-v4-flash', GATEWAY],
    ] as const
  ).map(
    ([label, model, baseURL]): ParityRow => ({
      id: `4-deepseek-${label}`,
      vendor: 'DeepSeek',
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'auto',
      sideQuery: false,
      extraEnv: DEEPSEEK_CHAT_LANE,
      history: replayHistory(),
      expect: { path: '/chat/completions', assistants: DEEPSEEK_REPLAY },
      source:
        'hermes deepseek row; value kept at Qianmo "" (design §5.4, §5.10) — baseline 2799eac7',
    }),
  ),

  // ── #10 (P18.8): Gemini tool-call signature, by target model ──
  // hermes transports/chat_completions.py:218-231, :280-282, :399-416.
  ...(
    [
      [
        'gemini-google',
        'gemini-3-pro-preview',
        'https://generativelanguage.googleapis.com/v1beta/openai',
        true,
      ],
      [
        'gemini-openrouter',
        'google/gemini-3-flash-preview',
        'https://openrouter.ai/api/v1',
        true,
      ],
      ['gemma-local', 'gemma-4-27b-it', 'http://localhost:11434/v1', true],
      [
        'strict-mistral',
        'mistral-large-latest',
        'https://api.mistral.ai/v1',
        false,
      ],
      ['strict-kimi', 'kimi-k3', 'https://api.moonshot.cn/v1', false],
      ['strict-gateway', 'vendor-model-x', GATEWAY, false],
    ] as const
  ).map(
    ([label, model, baseURL, keeps]): ParityRow => ({
      id: `10-${label}`,
      vendor: keeps ? 'Gemini family' : `strict side (${label})`,
      model,
      baseURL,
      wire: 'chat',
      effort: {},
      thinking: 'auto',
      sideQuery: false,
      history: signedToolHistory(),
      expect: {
        path: '/chat/completions',
        assistants: [
          {
            tool_calls: [
              keeps
                ? {
                    ...SIGNED_CALL,
                    extra_content: {
                      google: { thought_signature: 'SIG-P188' },
                    },
                  }
                : SIGNED_CALL,
            ],
          },
        ],
      },
      source: keeps
        ? 'hermes chat_completions.py:218-231 (gemini/gemma model keeps it)'
        : 'hermes chat_completions.py:254-261 (every other target: stripped)',
    }),
  ),

  // ── #14 (P18.8): reasoning keys chosen by the target endpoint ──
  // effortVendors.ts; hermes paths are under plugins/model-providers/.
  ...(
    [
      // Kimi: thinking XOR reasoning_effort (kimi-coding/__init__.py:61-112).
      [
        'kimi-effort-and-thinking',
        'kimi-k3',
        'https://api.moonshot.cn/v1',
        'on',
        { env: 'max', alwaysEnable: true },
        { reasoning_effort: 'max' },
        ['thinking', 'enable_thinking', 'chat_template_kwargs'],
        'hermes kimi-coding/__init__.py:61-112 (xor; effort wins; K3 map :96-104)',
      ],
      [
        'kimi-medium-maps-high',
        'kimi-k3',
        'https://api.moonshot.ai/v1',
        'auto',
        { env: 'medium', alwaysEnable: true },
        { reasoning_effort: 'high' },
        ['thinking', 'enable_thinking', 'chat_template_kwargs'],
        'hermes kimi-coding/__init__.py:96-104',
      ],
      [
        'kimi-thinking-on',
        'kimi-k3',
        'https://api.moonshot.cn/v1',
        'on',
        {},
        { thinking: { type: 'enabled' } },
        ['reasoning_effort', 'enable_thinking', 'chat_template_kwargs'],
        'hermes kimi-coding/__init__.py:109-110',
      ],
      [
        'kimi-thinking-off',
        'k3',
        'https://api.kimi.com/coding/v1',
        'off',
        { env: 'high', alwaysEnable: true },
        { thinking: { type: 'disabled' } },
        ['reasoning_effort'],
        'hermes kimi-coding/__init__.py:83-86 (off wins over effort)',
      ],
      [
        'kimi-no-preference',
        'kimi-k3',
        'https://api.moonshot.cn/v1',
        'auto',
        {},
        {},
        ['thinking', 'reasoning_effort', 'enable_thinking'],
        'Qianmo: server default (hermes sends enabled, :76-81)',
      ],
      [
        'kimi-relay-xor',
        'kimi-k3',
        GATEWAY,
        'on',
        { env: 'high', alwaysEnable: true },
        { reasoning_effort: 'high' },
        ['thinking', 'enable_thinking', 'chat_template_kwargs'],
        'Qianmo guard: a Kimi model behind any host never sends both',
      ],
      // GLM: only on a stated preference (zai/__init__.py:94-108).
      [
        'glm-no-preference',
        'glm-5.1',
        'https://open.bigmodel.cn/api/paas/v4',
        'auto',
        {},
        {},
        ['thinking', 'reasoning_effort', 'enable_thinking'],
        'hermes zai/__init__.py:97-98',
      ],
      [
        'glm-off',
        'glm-4.6',
        'https://open.bigmodel.cn/api/paas/v4',
        'off',
        {},
        { thinking: { type: 'disabled' } },
        ['reasoning_effort', 'enable_thinking', 'chat_template_kwargs'],
        'hermes zai/__init__.py:99-101',
      ],
      [
        'glm-on-one-dialect',
        'glm-4.6',
        'https://api.z.ai/api/paas/v4',
        'on',
        {},
        { thinking: { type: 'enabled' } },
        ['enable_thinking', 'chat_template_kwargs', 'reasoning_effort'],
        'hermes zai/__init__.py:99-101 (one key, not three dialects)',
      ],
      [
        'glm-4.6-effort-not-sent',
        'glm-4.6',
        'https://api.z.ai/api/paas/v4',
        'auto',
        { env: 'high', alwaysEnable: true },
        { thinking: { type: 'enabled' } },
        ['reasoning_effort'],
        'hermes zai/__init__.py:103-106 (reasoning_effort is GLM-5.2 only)',
      ],
      [
        'glm-5.2-effort-max',
        'glm-5.2',
        'https://api.z.ai/api/paas/v4',
        'auto',
        { env: 'max', alwaysEnable: true },
        { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
        ['enable_thinking'],
        'hermes zai/__init__.py:62-82',
      ],
      [
        'glm-5.2-effort-low-maps-high',
        'glm-5.2',
        'https://open.bigmodel.cn/api/paas/v4',
        'auto',
        { env: 'low', alwaysEnable: true },
        { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        [],
        'hermes zai/__init__.py:81-82',
      ],
      [
        'glm-pre-4.5-unchanged',
        'glm-4-9b',
        'https://open.bigmodel.cn/api/paas/v4',
        'on',
        {},
        {
          thinking: { type: 'enabled' },
          enable_thinking: true,
          chat_template_kwargs: { thinking: true, enable_thinking: true },
        },
        [],
        'not a table row (zai/__init__.py:94-95): generic body, baseline 2799eac7',
      ],
      // MiniMax-M3 on api.minimax.io/v1 (minimax/__init__.py:16-59).
      [
        'minimax-m3-default',
        'MiniMax-M3',
        'https://api.minimax.io/v1',
        'auto',
        {},
        { reasoning_split: true },
        ['thinking', 'reasoning_effort'],
        'hermes minimax/__init__.py:50',
      ],
      [
        'minimax-m3-off',
        'MiniMax-M3',
        'https://api.minimax.io/v1',
        'off',
        {},
        { reasoning_split: true, thinking: { type: 'disabled' } },
        ['reasoning_effort'],
        'hermes minimax/__init__.py:52-54',
      ],
      [
        'minimax-m3-on',
        'MiniMax-M3',
        'https://api.minimax.io/v1',
        'on',
        {},
        { reasoning_split: true, thinking: { type: 'adaptive' } },
        ['enable_thinking', 'chat_template_kwargs', 'reasoning_effort'],
        'hermes minimax/__init__.py:56-57',
      ],
      // Ollama Cloud (ollama-cloud/__init__.py:29-78).
      [
        'ollama-cloud-off',
        'gpt-oss:120b',
        'https://ollama.com/v1',
        'off',
        {},
        { reasoning_effort: 'none' },
        ['thinking', 'think'],
        'hermes ollama-cloud/__init__.py:51-58 (off must be "none")',
      ],
      [
        'ollama-cloud-xhigh-maps-max',
        'gpt-oss:120b',
        'https://ollama.com/v1',
        'auto',
        { env: 'xhigh', alwaysEnable: true },
        { reasoning_effort: 'max' },
        ['thinking'],
        'hermes ollama-cloud/__init__.py:67-68',
      ],
      [
        'ollama-cloud-no-preference',
        'gpt-oss:120b',
        'https://ollama.com/v1',
        'auto',
        {},
        {},
        ['reasoning_effort', 'thinking'],
        'hermes ollama-cloud/__init__.py:60-64',
      ],
      // Local Ollama, default port (custom/__init__.py:54-65).
      [
        'ollama-local-off',
        'qwen3:8b',
        'http://localhost:11434/v1',
        'off',
        {},
        { reasoning_effort: 'none', think: false },
        ['thinking'],
        'hermes custom/__init__.py:57-65',
      ],
      [
        'ollama-local-on-unchanged',
        'qwen3:8b',
        'http://localhost:11434/v1',
        'on',
        {},
        {
          thinking: { type: 'enabled' },
          enable_thinking: true,
          chat_template_kwargs: { thinking: true, enable_thinking: true },
        },
        ['think', 'reasoning_effort'],
        'Qianmo: thinking on stays generic, baseline 2799eac7',
      ],
      [
        'vllm-local-off-unchanged',
        'qwen3-coder',
        'http://localhost:8000/v1',
        'off',
        {},
        {},
        ['reasoning_effort', 'think', 'thinking'],
        'not a table row (only Ollama port 11434): baseline 2799eac7',
      ],
    ] as const
  ).map(
    ([
      label,
      model,
      baseURL,
      thinking,
      effort,
      present,
      absent,
      source,
    ]): ParityRow => ({
      id: `14-${label}`,
      vendor: 'chat reasoning keys by target',
      model,
      baseURL,
      wire: 'chat',
      effort,
      thinking,
      sideQuery: false,
      expect: { path: '/chat/completions', present, absent: [...absent] },
      source,
    }),
  ),

  // ── Fleet lock (design §0.2): gpt-6-luna on Responses must not change ──
  // Baseline captured from 1b477a37 through this same stub:
  // ~/atlas-evidence/m1-work/p185/fleet-baseline-1b477a37.txt
  ...[OFFICIAL, GATEWAY, undefined].map(
    (baseURL): ParityRow => ({
      id: `fleet-gpt-6-luna-${baseURL ?? 'unset'}`,
      vendor: 'OpenAI Responses (fleet, 2026-10-03)',
      model: 'gpt-6-luna',
      baseURL,
      wire: 'responses',
      effort: { env: 'max', alwaysEnable: true },
      thinking: 'auto',
      sideQuery: false,
      expect: {
        path: '/responses',
        present: {
          model: 'gpt-6-luna',
          stream: true,
          store: false,
          reasoning: { effort: 'max', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          parallel_tool_calls: true,
          max_output_tokens: 64000,
        },
        absent: ['temperature', 'max_tokens', 'max_completion_tokens'],
      },
      source:
        'baseline 1b477a37 + design §0.2 (effort still sent, lane unchanged)',
    }),
  ),
]

// ─── runner ──────────────────────────────────────────────────────────────────

describe('request parity (OpenAI-compatible lane)', () => {
  test('row ids are unique', () => {
    const ids = ROWS.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const row of ROWS) {
    test(`${row.id} — ${row.vendor} · ${row.model}`, async () => {
      const { url, body } = await captureOpenAIRequest(captureParams(row))
      expect(new URL(url).pathname.endsWith(row.expect.path)).toBe(true)
      for (const [key, value] of Object.entries(row.expect.present ?? {})) {
        expect({ key, value: body[key] }).toEqual({ key, value })
      }
      for (const key of row.expect.absent ?? []) {
        expect({ key, present: key in body }).toEqual({ key, present: false })
      }
      if (row.expect.assistants) {
        const assistants = (body.messages as Record<string, unknown>[]).filter(
          m => m.role === 'assistant',
        )
        expect(assistants.length).toBe(row.expect.assistants.length)
        row.expect.assistants.forEach((expected, i) => {
          for (const [key, value] of Object.entries(expected)) {
            const actual = assistants[i]!
            expect({
              turn: i,
              key,
              value: key in actual ? actual[key] : ABSENT,
            }).toEqual({ turn: i, key, value })
          }
        })
      }
    })
  }
})

describe('fleet lock: full key set is the baseline key set', () => {
  // Same capture, compared as a whole key list so an added or dropped field
  // on the live path fails loudly, not only the fields named above.
  const BASELINE_KEYS = {
    official: [
      'include',
      'input',
      'instructions',
      'max_output_tokens',
      'model',
      'parallel_tool_calls',
      'prompt_cache_key',
      'reasoning',
      'store',
      'stream',
      'text',
    ],
    gateway: [
      'include',
      'input',
      'instructions',
      'max_output_tokens',
      'model',
      'parallel_tool_calls',
      'prompt_cache_key',
      'reasoning',
      'store',
      'stream',
    ],
  }
  for (const [label, baseURL, keys] of [
    ['official', OFFICIAL, BASELINE_KEYS.official],
    ['gateway', GATEWAY, BASELINE_KEYS.gateway],
    ['unset', undefined, BASELINE_KEYS.official],
  ] as const) {
    test(`gpt-6-luna @ ${label}`, async () => {
      const { url, body } = await captureOpenAIRequest({
        model: 'gpt-6-luna',
        baseURL,
        env: {
          OPENAI_WIRE_API: 'responses',
          CLAUDE_CODE_EFFORT_LEVEL: 'max',
          CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
        },
      })
      expect(url).toBe(`${baseURL ?? OFFICIAL}/responses`)
      expect(Object.keys(body).sort()).toEqual([...keys])
      expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto' })
    })
  }
})

describe('fleet lock: encrypted_content replay on the same endpoint (P18.8 #23)', () => {
  // The fleet path minting a reasoning item and replaying it next turn,
  // end to end through queryModelOpenAI. Constructed SSE (not recorded): the
  // item shape `extractReasoningItem` keeps. Same endpoint must keep sending
  // the payload exactly as before P18.8; another endpoint must not get it.
  const FLEET_ENV = {
    OPENAI_WIRE_API: 'responses',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
  }
  const MINTING_SSE =
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_fleet","encrypted_content":"ENC-FLEET","summary":[]}}\n\n' +
    'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'

  async function firstTurn(baseURL: string | undefined): Promise<Message> {
    const outputs: unknown[] = []
    await captureOpenAIRequest({
      model: 'gpt-6-luna',
      baseURL,
      env: FLEET_ENV,
      messages: [replayHistory()[0]!],
      responsesSSE: MINTING_SSE,
      outputs,
    })
    const reply = outputs.find(
      o => (o as { type?: string }).type === 'assistant',
    ) as Message | undefined
    if (!reply) throw new Error('first turn produced no assistant message')
    return reply
  }

  function replayed(body: Record<string, unknown>): unknown[] {
    return (body.input as Record<string, unknown>[])
      .filter(item => item.type === 'reasoning')
      .map(item => item.encrypted_content)
  }

  for (const [label, baseURL] of [
    ['gateway', GATEWAY],
    ['official', OFFICIAL],
    ['unset', undefined],
  ] as const) {
    test(`gpt-6-luna @ ${label}: same endpoint replays ENC`, async () => {
      const reply = await firstTurn(baseURL)
      const { body } = await captureOpenAIRequest({
        model: 'gpt-6-luna',
        baseURL,
        env: FLEET_ENV,
        messages: [replayHistory()[0]!, reply, replayHistory()[2]!],
      })
      expect(replayed(body)).toEqual(['ENC-FLEET'])
    })
  }

  test('gpt-6-luna: switching to another endpoint drops ENC', async () => {
    const reply = await firstTurn(GATEWAY)
    const { body } = await captureOpenAIRequest({
      model: 'gpt-6-luna',
      baseURL: 'https://other-relay.example/v1',
      env: FLEET_ENV,
      messages: [replayHistory()[0]!, reply, replayHistory()[2]!],
    })
    expect(replayed(body)).toEqual([])
  })
})

describe('Gemini tool-call signature, two turns end to end (P18.8 #10)', () => {
  // Turn 1 streams a signed tool call from a Gemini OpenAI-compatible
  // endpoint; turn 2 replays the assembled assistant message. Constructed SSE
  // (not recorded): the `extra_content` shape hermes documents in
  // agent/transports/types.py:27-32. Covers the hand-offs this batch does not
  // own — index.ts block assembly, normalizeContentFromAPI, the API
  // normaliser — keeping the block field.
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai'
  const SIGNED_SSE =
    'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_g1","type":"function","function":{"name":"Read","arguments":"{}"},"extra_content":{"google":{"thought_signature":"SIG-E2E"}}}]},"finish_reason":null}]}\n\n' +
    'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'
  const user = (uuid: string, content: unknown): Message =>
    ({ type: 'user', uuid, message: { role: 'user', content } }) as Message

  async function signedTurn(): Promise<Message> {
    const outputs: unknown[] = []
    await captureOpenAIRequest({
      model: 'gemini-3-pro-preview',
      baseURL: GEMINI,
      env: { OPENAI_WIRE_API: 'chat' },
      messages: [user('u1', 'q1')],
      chatSSE: SIGNED_SSE,
      outputs,
    })
    const reply = outputs.find(
      o => (o as { type?: string }).type === 'assistant',
    ) as Message | undefined
    if (!reply) throw new Error('first turn produced no assistant message')
    return reply
  }

  async function replayedCalls(model: string, baseURL: string) {
    const reply = await signedTurn()
    const { body } = await captureOpenAIRequest({
      model,
      baseURL,
      env: { OPENAI_WIRE_API: 'chat' },
      messages: [
        user('u1', 'q1'),
        reply,
        user('u2', [
          { type: 'tool_result', tool_use_id: 'call_g1', content: 'ok' },
        ]),
      ],
    })
    return (body.messages as Record<string, unknown>[]).find(
      m => m.role === 'assistant',
    )?.tool_calls
  }

  test('the stored tool_use block keeps the signature', async () => {
    const reply = await signedTurn()
    const content = (reply as { message: { content: unknown[] } }).message
      .content as Record<string, unknown>[]
    expect(content.find(b => b.type === 'tool_use')).toMatchObject({
      id: 'call_g1',
      _geminiThoughtSignature: 'SIG-E2E',
    })
  })

  test('the next Gemini request sends it as extra_content', async () => {
    expect(await replayedCalls('gemini-3-pro-preview', GEMINI)).toEqual([
      {
        id: 'call_g1',
        type: 'function',
        function: { name: 'Read', arguments: '{}' },
        extra_content: { google: { thought_signature: 'SIG-E2E' } },
      },
    ])
  })

  test('switching to a strict endpoint sends the call without it', async () => {
    expect(
      await replayedCalls('mistral-large-latest', 'https://api.mistral.ai/v1'),
    ).toEqual([
      {
        id: 'call_g1',
        type: 'function',
        function: { name: 'Read', arguments: '{}' },
      },
    ])
  })
})
