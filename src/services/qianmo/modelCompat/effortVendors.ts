// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which reasoning-control keys a Chat Completions request carries, chosen by
 * the TARGET endpoint (P18.8, hermes #14; design `providers-console-m1.md`
 * §5.2, §5.4 「剥」, §5.6 row 14).
 *
 * Before: one shape for every OpenAI-compatible endpoint. Thinking on
 * (`OPENAI_ENABLE_THINKING=1`, or a deepseek / mimo name) sent three dialects
 * at once — `thinking`, `enable_thinking`, `chat_template_kwargs` — and the
 * effort gate (`chatEffort.ts`) added `reasoning_effort` on top. Thinking off
 * sent nothing. Against the vendors below that is wrong in both directions:
 * Kimi rejects `thinking` together with `reasoning_effort` (HTTP 400), GLM and
 * Ollama default to thinking ON so "off" has to be said, and MiniMax M3 keeps
 * its reasoning inline unless asked to split it.
 *
 * Now, for a target in the table, every reasoning key of the generic body is
 * removed and the vendor's own keys are written instead
 * ({@link applyChatVendorReasoning}, called once on the body in
 * `requestBody.ts`). Every other target keeps the generic body byte for byte,
 * except that a Kimi model behind any other host never gets `thinking`
 * dialects next to `reasoning_effort`.
 *
 * Inputs, as Qianmo has them:
 *   - thinking preference: `OPENAI_ENABLE_THINKING` — truthy `on`, explicitly
 *     falsy `off`, unset none. hermes's `reasoning_config.enabled`;
 *   - effort: the level the chat effort gate let through for this request
 *     (`chatLaneSendsReasoningEffort`, i.e. `modelSupportsEffort` — for these
 *     vendors only an explicit capability or `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`
 *     opts in), resolved unfolded (`getResponsesReasoningEffort`: low … max).
 *     hermes's `reasoning_config.effort`; an effort also counts as a
 *     preference for thinking on, as a hermes `reasoning_config` with an
 *     effort does.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `plugins/model-providers/kimi-coding/__init__.py:61-112` — `thinking`
 *     and `reasoning_effort` are mutually exclusive; off sends
 *     `thinking: disabled`; an effort is sent alone, mapped onto K3's
 *     low / high / max; otherwise `thinking: enabled`. Hosts `:115-135`;
 *   - `plugins/model-providers/zai/__init__.py:35-108` — GLM-4.5 and later
 *     (and GLM-5.2 spellings) get `thinking` only when the user stated a
 *     preference; GLM-5.2 also gets `reasoning_effort`, xhigh / max → `max`,
 *     every other enabled level → `high`;
 *   - `plugins/model-providers/minimax/__init__.py:16-59` — MiniMax-M3 at
 *     `api.minimax.io/v1` always gets `reasoning_split: true`; off →
 *     `thinking: disabled`, a preference → `thinking: adaptive`;
 *   - `plugins/model-providers/ollama-cloud/__init__.py:29-78` — top-level
 *     `reasoning_effort`; off must be sent as `"none"` (omitting it leaves
 *     thinking on, `thinking: disabled` is ignored — "verified live");
 *     xhigh / max → `max`; low / medium / high pass through;
 *   - `plugins/model-providers/custom/__init__.py:40-67` — local Ollama: off
 *     sends both `reasoning_effort: "none"` and `think: false`
 *     (ollama#14820, hermes #25758);
 *   - `agent/auxiliary_client.py:8334-8345` — the keys that can carry a
 *     reasoning control, which a table row clears before writing its own;
 *   - Grok lane (hermes #13, end of file): `agent/model_metadata.py:582-632`
 *     — the allowlist of models that accept an effort, by prefix after any
 *     `vendor/` prefix; `agent/transports/codex.py:439-451` — the clamp,
 *     grok-4.6 tops out at `xhigh`, the others at `high`.
 * Only the rules are taken; the code is ours.
 *
 * Qianmo differences, on purpose:
 *   - Kimi with no preference sends nothing (hermes sends
 *     `thinking: enabled`): the generic body sent nothing there either, and
 *     the server default is left to apply, as for GLM;
 *   - hermes binds these rules to its provider id; Qianmo has only the base
 *     URL, so the host (and, for MiniMax, path and model) stands in for it;
 *   - hermes gates Ollama Cloud on the model's `/api/show` thinking
 *     capability, which a request here cannot ask. Sending `"none"` to a
 *     model without thinking is, per the same hermes comment, ignored;
 *   - hermes's `custom` profile is any user-configured endpoint. Here only
 *     Ollama's default port (11434) is treated as one: `"none"` is not a
 *     value vLLM / llama.cpp document, and the generic body keeps serving
 *     them as before. Thinking on stays generic for local Ollama too;
 *   - DeepSeek keeps its own fields (`deepseekTuning.ts`) wherever it runs:
 *     a DeepSeek target is never a table row;
 *   - MiMo is not a row: hermes sends it no reasoning control at all, and
 *     which single dialect MiMo's API wants has not been checked against a
 *     real endpoint, so the three-dialect body stays.
 *   - Grok: only grok-3-mini is sent by default, with Qianmo's existing
 *     two-rung ladder; hermes's four newer rows need an explicit opt-in until
 *     a real-endpoint check (design §5.10) — hermes verified them on xAI's
 *     Responses API, and Qianmo's Grok lane speaks Chat Completions.
 * None of the vendor rows has been checked against a real endpoint here.
 */
import { getResponsesReasoningEffort } from 'src/services/api/openai/reasoning.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/utils/config/envUtils.js'
import { isDeepSeekTuningActiveForModel } from 'src/utils/model/deepseekTuning.js'
import { modelSupportsEffort } from 'src/utils/model/effort.js'
import { isKimiModel } from './samplingParams.js'
import { bareModelId, targetHostIs } from './targetMatch.js'

export type ChatEffortVendor =
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'ollama-cloud'
  | 'ollama-local'

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Preference = 'on' | 'off' | undefined

export type ChatVendorReasoningContext = {
  /** Wire model id. */
  model: string
  /** The request's endpoint (`OPENAI_BASE_URL`). */
  baseURL: string | undefined
  /** What the chat effort gate let through (`reasoningEffort`), if anything. */
  gatedEffort: string | undefined
  /** occ's applied effort for the request (`effortValue`). */
  effortValue: unknown
}

/**
 * Keys that can carry a reasoning control (hermes `_PROFILE_REASONING_KEYS`),
 * plus `chat_template_kwargs`, which Qianmo's generic body fills with nothing
 * but thinking switches.
 */
const REASONING_CONTROL_KEYS = [
  'reasoning',
  'reasoning_effort',
  'thinking',
  'thinking_config',
  'thinking_budget',
  'enable_thinking',
  'think',
  'verbosity',
  'chat_template_kwargs',
] as const

/** The generic body's thinking dialects (`requestBody.ts`). */
const THINKING_DIALECT_KEYS = [
  'thinking',
  'enable_thinking',
  'chat_template_kwargs',
] as const

/** hermes `kimi-coding/__init__.py:115-135`; same set as `reasoningEcho.ts`. */
const KIMI_HOSTS = ['api.kimi.com', 'moonshot.ai', 'moonshot.cn']
/** hermes `zai/__init__.py:123` and Zhipu's mainland endpoint. */
const GLM_HOSTS = ['api.z.ai', 'bigmodel.cn']
/** hermes `minimax/__init__.py:16-21`: the global host, path `/v1`. */
const MINIMAX_OPENAI_HOST = 'api.minimax.io'
/** hermes `minimax/__init__.py:24-26`. */
const MINIMAX_M3_IDS = ['minimax-m3', 'minimax/minimax-m3']
/** hermes `ollama-cloud/__init__.py:86`. */
const OLLAMA_CLOUD_HOSTS = ['ollama.com']
/** Ollama's default listen port. */
const OLLAMA_LOCAL_PORT = '11434'

/** hermes `kimi-coding/__init__.py:96-104`, on Qianmo's levels. */
const KIMI_K3_EFFORT: Record<Level, string> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}
/** hermes `ollama-cloud/__init__.py:67-70`. */
const OLLAMA_EFFORT: Record<Level, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_VERSION = /^glm-(\d+)(?:\.(\d+))?/

function glmThinkingCapable(model: string): boolean {
  const match = GLM_VERSION.exec(bareModelId(model))
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 4 || (major === 4 && minor >= 5)
}

function isGlm52(model: string): boolean {
  const lower = model.trim().toLowerCase()
  return ['glm-5.2', 'glm-5-2', 'glm-5p2'].some(token => lower.includes(token))
}

function urlPath(baseURL: string | undefined): string | undefined {
  try {
    return new URL(baseURL ?? '').pathname.replace(/\/+$/, '').toLowerCase()
  } catch {
    return undefined
  }
}

function urlPort(baseURL: string | undefined): string | undefined {
  try {
    return new URL(baseURL ?? '').port
  } catch {
    return undefined
  }
}

/** The table row the request target falls in, if any. */
export function chatEffortVendor(
  model: string,
  baseURL: string | undefined,
): ChatEffortVendor | undefined {
  if (isDeepSeekTuningActiveForModel(model, baseURL)) return undefined
  if (targetHostIs(baseURL, KIMI_HOSTS)) return 'kimi'
  if (
    targetHostIs(baseURL, GLM_HOSTS) &&
    (glmThinkingCapable(model) || isGlm52(model))
  ) {
    return 'glm'
  }
  if (
    targetHostIs(baseURL, [MINIMAX_OPENAI_HOST]) &&
    urlPath(baseURL) === '/v1' &&
    MINIMAX_M3_IDS.includes(model.trim().toLowerCase())
  ) {
    return 'minimax'
  }
  if (targetHostIs(baseURL, OLLAMA_CLOUD_HOSTS)) return 'ollama-cloud'
  if (urlPort(baseURL) === OLLAMA_LOCAL_PORT) return 'ollama-local'
  return undefined
}

function thinkingPreference(): Preference {
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return 'off'
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return 'on'
  return undefined
}

function requestedLevel(ctx: ChatVendorReasoningContext): Level | undefined {
  if (ctx.gatedEffort === undefined) return undefined
  return getResponsesReasoningEffort(ctx.model, ctx.effortValue)
}

/**
 * The reasoning keys a table row sends for this request — possibly none —
 * or `undefined` when the target is not a row (or the row leaves this case
 * to the generic body).
 */
export function resolveChatVendorReasoning(
  ctx: ChatVendorReasoningContext,
): Record<string, unknown> | undefined {
  const vendor = chatEffortVendor(ctx.model, ctx.baseURL)
  if (vendor === undefined) return undefined
  const stated = thinkingPreference()
  const level = stated === 'off' ? undefined : requestedLevel(ctx)
  const preference: Preference = stated ?? (level ? 'on' : undefined)

  switch (vendor) {
    case 'kimi':
      if (preference === 'off') return { thinking: { type: 'disabled' } }
      if (level) return { reasoning_effort: KIMI_K3_EFFORT[level] }
      if (preference === 'on') return { thinking: { type: 'enabled' } }
      return {}
    case 'glm': {
      if (preference === undefined) return {}
      const fields: Record<string, unknown> = {
        thinking: { type: preference === 'on' ? 'enabled' : 'disabled' },
      }
      if (level && isGlm52(ctx.model)) {
        fields.reasoning_effort =
          level === 'xhigh' || level === 'max' ? 'max' : 'high'
      }
      return fields
    }
    case 'minimax':
      return {
        reasoning_split: true,
        ...(preference !== undefined && {
          thinking: { type: preference === 'on' ? 'adaptive' : 'disabled' },
        }),
      }
    case 'ollama-cloud':
      if (preference === 'off') return { reasoning_effort: 'none' }
      return level ? { reasoning_effort: OLLAMA_EFFORT[level] } : {}
    case 'ollama-local':
      return preference === 'off'
        ? { reasoning_effort: 'none', think: false }
        : undefined
  }
}

/**
 * `body` with its reasoning keys chosen for the target: a table row's keys in
 * place of the generic ones, the generic body (the same object) otherwise.
 */
export function applyChatVendorReasoning<T extends object>(
  body: T,
  ctx: ChatVendorReasoningContext,
): T {
  const vendorFields = resolveChatVendorReasoning(ctx)
  const drop: readonly string[] | undefined = vendorFields
    ? REASONING_CONTROL_KEYS
    : isKimiModel(ctx.model) && 'reasoning_effort' in body
      ? THINKING_DIALECT_KEYS
      : undefined
  if (drop === undefined || !drop.some(key => key in body)) {
    return vendorFields && Object.keys(vendorFields).length > 0
      ? { ...body, ...vendorFields }
      : body
  }
  const out = { ...body } as Record<string, unknown>
  for (const key of drop) delete out[key]
  return { ...out, ...vendorFields } as T
}

// ── Grok lane (P18.8, hermes #13; design §5.6 row 13, §5.10) ──────────────

/** A `reasoning_effort` value the Grok lane sends. */
export type GrokWireEffort = 'low' | 'medium' | 'high' | 'xhigh'

type GrokEffortRow = {
  /** Prefix of the model id after any `vendor/` prefix. */
  prefix: string
  /**
   * Sent without an explicit opt-in. Only the row Qianmo already sent
   * (grok-3-mini); hermes's newer rows wait for a real-endpoint check
   * (design §5.10) and need `modelSupportsEffort` — which for them only an
   * explicit capability or `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` makes true.
   */
  defaultOn: boolean
  clamp: Record<Level, GrokWireEffort>
}

/**
 * Qianmo's own two-rung grok-3-mini ladder, unchanged (`grok/reasoning.ts`
 * before P18.8): the middle rounds up.
 */
const GROK_3_MINI_CLAMP: Record<Level, GrokWireEffort> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}
/** hermes `codex.py:449-451`: above high clamps to high. */
const GROK_HIGH_CEILING: Record<Level, GrokWireEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}
/** hermes `codex.py:442-448`: grok-4.6 tops out at xhigh. */
const GROK_46_CLAMP: Record<Level, GrokWireEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
}

/**
 * hermes `agent/model_metadata.py:582-624` `_GROK_EFFORT_CAPABLE_PREFIXES`
 * (grok-4.5 "verified live … 2026-07-08", the rest 2026-05-10, both against
 * `/v1/responses`; Qianmo's Grok lane is Chat Completions, which is one more
 * reason the new rows are opt-in). Every other Grok model — grok-4,
 * grok-4.20-*-reasoning, grok-code-fast-1 — rejects the parameter.
 */
const GROK_EFFORT_ROWS: readonly GrokEffortRow[] = [
  { prefix: 'grok-3-mini', defaultOn: true, clamp: GROK_3_MINI_CLAMP },
  {
    prefix: 'grok-4.20-multi-agent',
    defaultOn: false,
    clamp: GROK_HIGH_CEILING,
  },
  { prefix: 'grok-4.3', defaultOn: false, clamp: GROK_HIGH_CEILING },
  { prefix: 'grok-4.5', defaultOn: false, clamp: GROK_HIGH_CEILING },
  { prefix: 'grok-4.6', defaultOn: false, clamp: GROK_46_CLAMP },
]

function grokEffortRow(model: string): GrokEffortRow | undefined {
  const bare = bareModelId(model).replace(/_/g, '-')
  return GROK_EFFORT_ROWS.find(
    row =>
      bare.startsWith(row.prefix) ||
      // The base rule matched grok-3-mini anywhere in the id; kept.
      (row.defaultOn && model.toLowerCase().includes(row.prefix)),
  )
}

/** Whether the Grok lane sends `reasoning_effort` for `model` at all. */
export function grokAcceptsReasoningEffort(model: string): boolean {
  const row = grokEffortRow(model)
  return row !== undefined && (row.defaultOn || modelSupportsEffort(model))
}

/**
 * The rung for `effortValue` (occ's applied effort) on `model`, or
 * `undefined`: no row, a row not switched on, or no level chosen (unset, or an
 * ant-only number).
 */
export function resolveGrokEffort(
  model: string,
  effortValue: unknown,
): GrokWireEffort | undefined {
  if (!grokAcceptsReasoningEffort(model)) return undefined
  const row = grokEffortRow(model)
  return isLevel(effortValue) ? row?.clamp[effortValue] : undefined
}

function isLevel(value: unknown): value is Level {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}
