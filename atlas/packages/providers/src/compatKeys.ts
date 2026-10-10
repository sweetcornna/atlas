// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The closed compat key set (§3.6) and the env keys no profile may ever name.
 *
 * Since the switch to oh-my-pi (docs/dev/base-switch-omp.md §5) a profile no
 * longer writes process environment: the node compiles it into omp's
 * `models.yml` / `config.yml`. The set is therefore two groups, every key
 * spelled exactly as omp spells it:
 *
 *   - omp model `compat` fields (`docs/models.md` "Compatibility and routing
 *     fields"), the scalar ones only. Object-valued fields (`extraBody`,
 *     `reasoningEffortMap`, the gateway routing blocks, `whenThinking`) are
 *     left out: `extraBody` would let a profile put anything into a request
 *     body. `statefulResponses` is left out too — the compiler pins it.
 *   - four settings a profile may carry: `disableStrictTools` (provider
 *     field), `headers.anthropic-workspace-id` (the one header allowed),
 *     `maxTokens` (output cap for models without their own), `cacheRetention`
 *     (`config.yml` `providers.cacheRetention`).
 *
 * Values travel as strings (the stored and wire shape is unchanged); the
 * compiler converts them to the YAML types omp expects. Anything outside the
 * set is `unknown-key`. Old occ env keys in stored hub profiles are migrated
 * by {@link migrateLegacyCompat}.
 */

type ValueCheck = (value: string) => string | null

const BOOLEAN: ValueCheck = value =>
  value === 'true' || value === 'false' ? null : '只能是 true 或 false'

const oneOf =
  (...allowed: string[]): ValueCheck =>
  value =>
    allowed.includes(value) ? null : `只能是 ${allowed.join(' / ')} 之一`

const integer =
  (min: number, max: number): ValueCheck =>
  value => {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return '必须是非负整数'
    const n = Number(value)
    return n >= min && n <= max ? null : `必须在 ${min} 到 ${max} 之间`
  }

/** omp `compat` booleans a profile may set (scalar, request-shaping only). */
const COMPAT_BOOLEANS = [
  'supportsStore',
  'supportsDeveloperRole',
  'supportsMultipleSystemMessages',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'requiresToolResultName',
  'requiresMistralToolIds',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentForToolCalls',
  'allowsSyntheticReasoningContentForToolCalls',
  'requiresAssistantContentForToolCalls',
  'supportsToolChoice',
  'supportsForcedToolChoice',
  'disableReasoningOnForcedToolChoice',
  'disableReasoningOnToolChoice',
  'disableReasoningWithTools',
  'qwenTemplateReasoningEffort',
  'supportsStrictMode',
  'supportsLongPromptCacheRetention',
  'supportsReasoningParams',
  'supportsReasoningSummary',
  'alwaysSendMaxTokens',
  'strictResponsesPairing',
  'supportsImageDetailOriginal',
  'supportsConfigurationUpdate',
  'supportsSteering',
  'stripImageInput',
  'supportsContextManagement',
  'supportsEagerToolInputStreaming',
  'requiresToolResultId',
  'replayUnsignedThinking',
] as const

const COMPAT_RULES: Record<string, ValueCheck> = {
  ...Object.fromEntries(COMPAT_BOOLEANS.map(key => [key, BOOLEAN])),
  maxTokensField: oneOf('max_completion_tokens', 'max_tokens'),
  reasoningContentField: oneOf(
    'reasoning_content',
    'reasoning',
    'reasoning_text',
  ),
  thinkingFormat: oneOf(
    'openai',
    'openrouter',
    'zai',
    'qwen',
    'qwen-chat-template',
  ),
  cacheControlFormat: oneOf('anthropic'),
  toolStrictMode: oneOf('all_strict', 'none'),
  streamMarkupHealingPattern: oneOf('kimi', 'dsml', 'qwen', 'thinking'),
  streamIdleTimeoutMs: integer(0, 1_800_000),
}

/**
 * Settings outside omp's `compat` block a profile may carry. Each names where
 * the compiler writes it.
 */
const SETTING_RULES: Record<string, ValueCheck> = {
  /** `models.yml` provider `disableStrictTools`. */
  disableStrictTools: BOOLEAN,
  /**
   * `models.yml` provider `headers`. Multi-workspace Anthropic keys need it on
   * every request (§4.2); no other header may be set, so nothing can smuggle
   * a credential or a routing header past the closed set.
   */
  'headers.anthropic-workspace-id': value =>
    /^[A-Za-z0-9_-]{1,128}$/.test(value)
      ? null
      : '只能是 1 到 128 个字母、数字、下划线或连字符',
  /** `maxTokens` of every model without its own `maxOutputTokens`. */
  maxTokens: integer(1, 10_000_000),
  /** `config.yml` `providers.cacheRetention`. */
  cacheRetention: oneOf('auto', 'short', 'long', 'none'),
}

/** Keys that only mean something on the Anthropic lane. */
export const ANTHROPIC_ONLY_COMPAT_KEYS: readonly string[] = [
  'disableStrictTools',
  'headers.anthropic-workspace-id',
]

/** Every key a profile may set, omp compat fields first. */
export const COMPAT_KEYS: readonly string[] = [
  ...Object.keys(COMPAT_RULES),
  ...Object.keys(SETTING_RULES),
]

export type CompatKey = (typeof COMPAT_KEYS)[number]

/** Keys that land in omp's model `compat` block (the rest are settings). */
export function isOmpCompatField(key: string): boolean {
  return Object.hasOwn(COMPAT_RULES, key)
}

export function isCompatKey(key: string): boolean {
  return Object.hasOwn(COMPAT_RULES, key) || Object.hasOwn(SETTING_RULES, key)
}

/** `null` when `value` is acceptable for `key`, else a reason in Chinese. */
export function checkCompatValue(key: string, value: string): string | null {
  const rule = COMPAT_RULES[key] ?? SETTING_RULES[key]
  return rule === undefined ? '不在闭合兼容键集里' : rule(value)
}

/**
 * Compat keys a profile may set directly: all of them. Kept as its own name
 * because the effort keys of the occ era were derived, never set, and a
 * future derived key would go here.
 */
export const PROFILE_SETTABLE_COMPAT_KEYS: readonly string[] = COMPAT_KEYS

/**
 * occ-era env keys → their omp replacement (`null` = dropped). Stored hub
 * profiles written before the switch carry these; the hub's store reader runs
 * {@link migrateLegacyCompat} before the strict parser sees them.
 *
 *   - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` kept third-party Anthropic
 *     hosts away from Claude-only request fields; omp's knob for the same
 *     hosts is `disableStrictTools`.
 *   - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` → `maxTokens`.
 *   - `API_TIMEOUT_MS` → `streamIdleTimeoutMs` (omp has no whole-request
 *     timeout; the idle floor is what slow hosts needed).
 *   - `ANTHROPIC_CUSTOM_HEADERS: anthropic-workspace-id: X` →
 *     `headers.anthropic-workspace-id: X`.
 *   - `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE`, `CLAUDE_CODE_EFFORT_LEVEL`,
 *     `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`: dropped (the DeepSeek mirror is
 *     gone; effort is compiled from the models and `effortLock`).
 */
const LEGACY_COMPAT: Record<
  string,
  ((value: string) => [string, string] | null) | null
> = {
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: value =>
    value === '1'
      ? ['disableStrictTools', 'true']
      : value === '0'
        ? ['disableStrictTools', 'false']
        : ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', value],
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: value => ['maxTokens', value],
  API_TIMEOUT_MS: value => ['streamIdleTimeoutMs', value],
  ANTHROPIC_CUSTOM_HEADERS: value => {
    const match = /^anthropic-workspace-id:\s*(\S+)$/.exec(value)
    return match?.[1] === undefined
      ? ['ANTHROPIC_CUSTOM_HEADERS', value]
      : ['headers.anthropic-workspace-id', match[1]]
  },
  CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE: null,
  CLAUDE_CODE_EFFORT_LEVEL: null,
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: null,
}

/**
 * A stored compat block with occ-era keys rewritten (see {@link LEGACY_COMPAT}).
 * Anything that is not a legacy key passes through untouched, so the strict
 * parser still refuses what neither era knows. Returns the input itself when
 * nothing changed. Non-string values are left for the parser to refuse.
 */
export function migrateLegacyCompat(
  compat: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!Object.keys(compat).some(key => Object.hasOwn(LEGACY_COMPAT, key))) {
    return compat as Record<string, unknown>
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(compat)) {
    if (!Object.hasOwn(LEGACY_COMPAT, key)) {
      out[key] = value
      continue
    }
    const rule = LEGACY_COMPAT[key]
    if (typeof value !== 'string') {
      out[key] = value
      continue
    }
    if (rule === null || rule === undefined) continue
    const mapped = rule(value)
    if (mapped !== null && !Object.hasOwn(out, mapped[0])) {
      out[mapped[0]] = mapped[1]
    }
  }
  return out
}

/**
 * Env keys refused outright, whatever list they appear in. A profile writes
 * no environment any more, but these names must never be accepted as a
 * compat key either, so a future widening of the set cannot let them in.
 */
const FORBIDDEN_EXACT: Readonly<Record<string, true>> = {
  PATH: true,
  LD_PRELOAD: true,
  LD_LIBRARY_PATH: true,
  DYLD_INSERT_LIBRARIES: true,
  DYLD_LIBRARY_PATH: true,
  NODE_OPTIONS: true,
  BUN_OPTIONS: true,
  HOME: true,
  SHELL: true,
  QIANMO_CONFIG_DIR: true,
  PI_CONFIG_DIR: true,
  PI_CODING_AGENT_DIR: true,
  CLAUDE_CONFIG_DIR: true,
}

const FORBIDDEN_PREFIXES: readonly string[] = ['CLAUDE_CODE_USE_', 'OMP_']

export function isForbiddenEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    FORBIDDEN_EXACT[upper] === true ||
    FORBIDDEN_PREFIXES.some(prefix => upper.startsWith(prefix))
  )
}
