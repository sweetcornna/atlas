// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Each agent's model, configured the way its runtime configures one
 * (`harness-backends.md` §11): the fields magpie gives every harness
 * (`model`, `effort`, Claude Code's tiers and their efforts, opencode's small
 * model), one table the node, the hub and the console share.
 *
 * | runtime | row | 分档 panel |
 * |---|---|---|
 * | Claude Code | `model`, `effort` | `fable` `opus` `sonnet` `haiku` and `<tier>_effort` |
 * | Codex, qianmopi, dsh | `model`, `effort` | — |
 * | Gemini CLI, Qwen Code | `model` | — |
 * | opencode | `model` | `small` |
 *
 * A model is `<profile>/<model>`, an effort one of {@link EFFORT_VALUES}; an
 * empty value follows (a tier the main model, the effort the runtime's own
 * default). A tier and the small model run over the main model's address and
 * key, so they must come from the main model's profile; one from another
 * profile is left out at launch (it follows).
 *
 * Following, as magpie's `follow` (`internal/agent/claude.go`): opus and sonnet
 * run on the main model; haiku on the newest Haiku the main model's profile
 * has next to a Claude main model, else on the main model; fable is set only
 * when the main model is a Fable itself (Claude Code takes the model its
 * fable variable names for a Fable). A tier effort without a model of its own
 * runs the model the tier follows at that effort.
 *
 * Efforts only ever move down: a level a model does not take runs as the
 * highest one below it it does, none below leaves the runtime's default.
 */

/** Claude Code's model aliases, each of which can have a model of its own. */
export const CLAUDE_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type ClaudeTier = (typeof CLAUDE_TIERS)[number]

/** Lowest first; `none` turns reasoning off. */
export const EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type EffortValue = (typeof EFFORT_VALUES)[number]

export interface AgentModelField {
  readonly key: string
  /** As the console shows it (magpie's labels in Chinese). */
  readonly label: string
  readonly kind: 'model' | 'effort'
  /** An effort field: the model field whose effort it sets. */
  readonly of?: string
  /** A field of Claude Code's 分档 panel. */
  readonly tier?: ClaudeTier
  /** Empty follows the main model (tiers, opencode's small model). */
  readonly follows?: 'model'
}

const MODEL: AgentModelField = { key: 'model', label: '模型', kind: 'model' }
const EFFORT: AgentModelField = {
  key: 'effort',
  label: '推理强度',
  kind: 'effort',
  of: 'model',
}

function tierFields(tier: ClaudeTier): AgentModelField[] {
  return [
    { key: tier, label: tier, kind: 'model', tier, follows: 'model' },
    {
      key: `${tier}_effort`,
      label: `${tier} 推理强度`,
      kind: 'effort',
      of: tier,
      tier,
    },
  ]
}

/** The fields of each runtime of the catalog, in the order the page draws them. */
export const AGENT_MODEL_FIELDS: Readonly<
  Record<string, readonly AgentModelField[]>
> = {
  'claude-code': [MODEL, EFFORT, ...CLAUDE_TIERS.flatMap(tierFields)],
  codex: [MODEL, EFFORT],
  omp: [MODEL, EFFORT],
  dsh: [MODEL, EFFORT],
  gemini: [MODEL],
  qwen: [MODEL],
  opencode: [
    MODEL,
    { key: 'small', label: '小模型', kind: 'model', follows: 'model' },
  ],
}

export function agentModelFields(runtime: string): readonly AgentModelField[] {
  return AGENT_MODEL_FIELDS[runtime] ?? [MODEL]
}

/**
 * Every field key some runtime has, but `model` (kept beside the runtime in
 * `runtimes.json` as before): what `runtime.configure {fields}` takes.
 */
export const EXTRA_FIELD_KEYS: readonly string[] = [
  ...new Set(
    Object.values(AGENT_MODEL_FIELDS).flatMap(fields =>
      fields.filter(field => field.key !== 'model').map(field => field.key),
    ),
  ),
]

function fieldByKey(key: string): AgentModelField | undefined {
  for (const fields of Object.values(AGENT_MODEL_FIELDS)) {
    const found = fields.find(field => field.key === key)
    if (found !== undefined) return found
  }
  return undefined
}

/** `<profile>/<model>`; the model id may itself contain slashes. */
export const MODEL_SPEC = /^[^/\s]+\/\S+$/

/** Why `value` cannot be field `key`'s, or null; `''` (follow) always can. */
export function fieldValueProblem(key: string, value: unknown): string | null {
  const field = fieldByKey(key)
  if (field === undefined) return `没有这个字段：${key.slice(0, 40)}`
  if (typeof value !== 'string') return `${field.label} 要是字符串`
  if (value === '') return null
  if (value.length > 256) return `${field.label} 太长`
  if (field.kind === 'model')
    return MODEL_SPEC.test(value)
      ? null
      : `${field.label} 要写成 <档案>/<模型号>`
  return (EFFORT_VALUES as readonly string[]).includes(value)
    ? null
    : `${field.label} 只能是 ${EFFORT_VALUES.join(' ')}`
}

/** The profile of a `<profile>/<model>`, or undefined. */
export function profileOf(spec: string): string | undefined {
  const slash = spec.indexOf('/')
  return slash > 0 ? spec.slice(0, slash) : undefined
}

/** The model of a `<profile>/<model>`, or the value itself. */
export function modelOf(spec: string): string {
  const slash = spec.indexOf('/')
  return slash > 0 ? spec.slice(slash + 1) : spec
}

// --- efforts ---------------------------------------------------------------

/**
 * The levels a runtime's effort field offers. Claude Code's main effort is
 * its `--effort` (low…xhigh, max through `CLAUDE_CODE_EFFORT_LEVEL`); a tier's
 * is the level the gateway holds that tier's model at (magpie's member
 * efforts). Codex has no `max`.
 */
export function effortVocabulary(
  runtime: string,
  key = 'effort',
): readonly EffortValue[] {
  if (runtime === 'claude-code')
    return key === 'effort'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : EFFORT_VALUES
  if (runtime === 'codex')
    return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  if (runtime === 'omp' || runtime === 'dsh') return EFFORT_VALUES
  return []
}

/** What the node knows of one model of a profile (`models.yml`). */
export interface ModelFacts {
  /** The model id, without its profile. */
  readonly id: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  /** The efforts it takes; absent: not known. */
  readonly efforts?: readonly string[]
  /** `false`: the model service says it does not reason. */
  readonly reasoning?: boolean
}

const CLAUDE_NAME =
  /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:[^0-9]|$)/

/** `claude-opus-4-6` for a model id naming one (dots read as dashes), else ''. */
export function claudeName(model: string): string {
  const id = model
    .replace(/\[1m\]$/, '')
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1-$2')
  const match = CLAUDE_NAME.exec(id)
  if (match === null) return ''
  return `claude-${match[1]}-${match[2]}${match[3] === undefined ? '' : `-${match[3]}`}`
}

/**
 * The levels Claude Code sends a Claude model at (2.1.285, as magpie reads
 * it): Opus 4.5 up to high, Opus and Sonnet 4.6 without xhigh, Haiku 4.5 and
 * older Claude models none; another vendor's, or a newer Claude, all of them.
 */
export function claudeEffortsFor(model: string): readonly EffortValue[] {
  const all: readonly EffortValue[] = ['low', 'medium', 'high', 'xhigh', 'max']
  switch (claudeName(model)) {
    case 'claude-opus-4-5':
      return ['low', 'medium', 'high']
    case 'claude-opus-4-6':
    case 'claude-sonnet-4-6':
      return ['low', 'medium', 'high', 'max']
    case 'claude-haiku-4-5':
    case 'claude-sonnet-4-5':
    case 'claude-opus-4':
    case 'claude-sonnet-4':
      return []
    case '':
      return model.toLowerCase().includes('claude-3') ? [] : all
    default:
      return all
  }
}

/**
 * The levels field `key` of `runtime` offers on `model`: the runtime's
 * vocabulary, narrowed to what the model takes (`none` stays while the model
 * reasons at all) and, on Claude Code, to what Claude Code sends it.
 */
export function effortChoices(
  runtime: string,
  key: string,
  model?: ModelFacts,
): readonly EffortValue[] {
  const vocabulary = effortVocabulary(runtime, key)
  if (model?.reasoning === false) return []
  const own = model?.efforts
  const claude =
    runtime === 'claude-code' && model !== undefined
      ? claudeEffortsFor(model.id)
      : undefined
  return vocabulary.filter(level => {
    if (level === 'none') return true
    if (own !== undefined && !own.includes(level)) return false
    if (claude !== undefined && !claude.includes(level)) return false
    return true
  })
}

/** `level` moved down into `allowed`; undefined when nothing is at or below it. */
export function narrowEffort(
  level: string | undefined,
  allowed: readonly EffortValue[],
): EffortValue | undefined {
  if (level === undefined || level === '') return undefined
  const rank = (EFFORT_VALUES as readonly string[]).indexOf(level)
  if (rank < 0) return undefined
  for (let i = rank; i >= 0; i--) {
    const candidate = EFFORT_VALUES[i]!
    if (allowed.includes(candidate)) return candidate
  }
  return undefined
}

// --- following ---------------------------------------------------------------

function undated(id: string): string {
  return /-\d{8}$/.test(id) ? id.slice(0, -9) : id
}

/**
 * The newest Haiku among `models` next to the Claude model `main`: the same
 * prefix before `claude-` (a gateway's `provider/`, a router's
 * `vendor/`), undated names first; undefined when `main` is no Claude model,
 * is a Haiku already, or there is none.
 */
export function claudeLight(
  main: string,
  models: readonly string[],
): string | undefined {
  const ref = main.replace(/\[1m\]$/, '')
  const found = /(^|[/-])claude-/.exec(ref)
  if (found === null) return undefined
  const at = found.index + (found[1]?.length ?? 0)
  if (ref.slice(at).includes('haiku')) return undefined
  const prefix = `${ref.slice(0, at)}claude-haiku-`
  let best: string | undefined
  for (const id of models) {
    if (!id.startsWith(prefix)) continue
    if (best === undefined) {
      best = id
      continue
    }
    const u = undated(id)
    const b = undated(best)
    if (u > b || (u === b && id.length < best.length)) best = id
  }
  return best
}

/**
 * The model a tier runs while it follows the main model `main` (model ids of
 * one profile): undefined for none (the tier's variable is left out).
 */
export function followTier(
  tier: ClaudeTier,
  main: string,
  models: readonly string[],
): string | undefined {
  if (tier === 'haiku') return claudeLight(main, models) ?? main
  if (tier === 'fable')
    return claudeName(main).startsWith('claude-fable-') ? main : undefined
  return main
}

// --- task tiers (P38, §11.3) -------------------------------------------------

/**
 * A worker session's difficulty (`direction` of its first turn) and the
 * model role it runs on (`config.yml` `modelRoles`): the first role P38's
 * `DIRECTION_ROLES` writes for each tier in `@qianmo/providers`.
 */
export const TASK_TIER_ROLES = {
  complex: 'plan',
  medium: 'default',
  simple: 'smol',
} as const
export type TaskTier = keyof typeof TASK_TIER_ROLES

/**
 * The P22 names a hub sends a tier under (P38 `legacyDirectionOf`, which a
 * node older than P38 still takes), mapped back as `directionOf` in
 * `@qianmo/providers` maps them; replace with it once P38 is on this base.
 */
const LEGACY_TASK_TIERS: Readonly<Record<string, TaskTier>> = {
  plan: 'complex',
  code: 'medium',
  chat: 'medium',
  vision: 'medium',
  fast: 'simple',
}

/** A turn's direction as a task tier: a P38 name, or the P22 one for it. */
export function taskTierOf(value: unknown): TaskTier | undefined {
  if (typeof value !== 'string') return undefined
  if (Object.hasOwn(TASK_TIER_ROLES, value)) return value as TaskTier
  return Object.hasOwn(LEGACY_TASK_TIERS, value)
    ? LEGACY_TASK_TIERS[value]
    : undefined
}

/**
 * Claude Code's own tiers for a task tier: a complex session runs as
 * `--model opus`, a simple one as `--model haiku`, a medium one on the main
 * model.
 */
export const TASK_TIER_ALIAS: Readonly<Record<TaskTier, ClaudeTier | null>> = {
  complex: 'opus',
  medium: null,
  simple: 'haiku',
}
