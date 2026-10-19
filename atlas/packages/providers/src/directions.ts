// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sortEffortLevels } from './effort.js'
import type {
  Lane,
  ModelKind,
  NodeCapabilities,
  ProfileCore,
  ProviderModel,
} from './types.js'

/**
 * P38: three difficulty tiers for the work itself, and the three media a tool
 * generates. Pictures in (`vision`) follow the main model; the eight P22
 * directions survive only as {@link LEGACY_DIRECTIONS}, read and mapped.
 */
export const MODEL_DIRECTIONS = [
  'complex',
  'medium',
  'simple',
  'image',
  'speech',
  'video',
] as const
export type ModelDirection = (typeof MODEL_DIRECTIONS)[number]
/** The difficulty of a task; a sub-session is started at one of these. */
export const TASK_TIERS = ['complex', 'medium', 'simple'] as const
export type TaskTier = (typeof TASK_TIERS)[number]
/** omp roles each direction writes. External runtimes read plan / default / smol. */
export const DIRECTION_ROLES: Record<ModelDirection, readonly string[]> = {
  complex: ['plan', 'slow'],
  medium: ['default', 'task', 'chat'],
  simple: ['smol', 'commit', 'tiny'],
  image: ['image'],
  speech: ['speech'],
  video: ['video'],
}
export const DIRECTION_KINDS: Record<ModelDirection, readonly ModelKind[]> = {
  complex: ['chat'],
  medium: ['chat'],
  simple: ['chat'],
  image: ['image'],
  speech: ['speech'],
  video: ['video'],
}
export const LANE_KINDS: Record<Lane, ModelKind> = {
  anthropic: 'chat',
  'openai-chat': 'chat',
  'openai-responses': 'chat',
  gemini: 'chat',
  grok: 'chat',
  'openai-images': 'image',
  'openrouter-images': 'image',
  'gemini-images': 'image',
  'openai-speech': 'speech',
  'openrouter-video': 'video',
}

/**
 * A tier's reasoning effort as the console offers it. `none` switches
 * reasoning off (omp `off`); the rest are omp's own thinking levels.
 */
export const TIER_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type TierEffort = (typeof TIER_EFFORTS)[number]
export function isTierEffort(value: unknown): value is TierEffort {
  return (
    typeof value === 'string' &&
    (TIER_EFFORTS as readonly string[]).includes(value)
  )
}
/**
 * The efforts a tier may pin for this model, narrowed by what the model says
 * it takes. Empty: no effort choice at all (a media model, one that never
 * sends effort, or a profile whose effort is locked).
 */
export function tierEffortChoices(
  model: Pick<ProviderModel, 'kind' | 'effort'>,
  profile?: Pick<ProfileCore, 'effortLock'>,
): readonly TierEffort[] {
  if ((model.kind ?? 'chat') !== 'chat') return []
  if (model.effort.send === 'never' || profile?.effortLock) return []
  const off: TierEffort[] = model.effort.send === 'always' ? [] : ['none']
  return model.effort.levels === undefined
    ? [...off, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    : [...off, ...sortEffortLevels(model.effort.levels)]
}
/** The omp thinking level a tier effort compiles to. */
export function ompThinkingLevel(effort: TierEffort): string {
  return effort === 'none' ? 'off' : effort
}

export type ModelRouteRef = {
  profileId: string
  modelId: string
  /** Absent: the model's own default effort. */
  effort?: TierEffort
}
export type ModelRouting = {
  auto: boolean
  routes: Partial<Record<ModelDirection, ModelRouteRef>>
}
export function isModelDirection(value: unknown): value is ModelDirection {
  return (
    typeof value === 'string' &&
    (MODEL_DIRECTIONS as readonly string[]).includes(value)
  )
}

/** The P22 directions: what a v1 book, an older hub and an older node speak. */
export const LEGACY_DIRECTIONS = [
  'code',
  'chat',
  'plan',
  'fast',
  'vision',
  'image',
  'speech',
  'video',
] as const
export type LegacyDirection = (typeof LEGACY_DIRECTIONS)[number]
export type LegacyModelRouting = {
  auto: boolean
  routes: Partial<
    Record<LegacyDirection, { profileId: string; modelId: string }>
  >
}
function isLegacyDirection(value: unknown): value is LegacyDirection {
  return (
    typeof value === 'string' &&
    (LEGACY_DIRECTIONS as readonly string[]).includes(value)
  )
}
const LEGACY_TIER: Readonly<Record<LegacyDirection, ModelDirection>> = {
  code: 'medium',
  chat: 'medium',
  plan: 'complex',
  fast: 'simple',
  // One direction asked for (a hint, a schedule, a chat's /model): pictures
  // in follow the main model, which is the medium tier's `default` role.
  vision: 'medium',
  image: 'image',
  speech: 'speech',
  video: 'video',
}
/**
 * One direction from anywhere — a turn's hint, a stored schedule, a chat's
 * choice — in the P38 set: a P38 name as it is, a P22 name mapped
 * (`plan` → complex, `code` / `chat` / `vision` → medium, `fast` → simple),
 * anything else `null`.
 */
export function directionOf(value: unknown): ModelDirection | null {
  if (isModelDirection(value)) return value
  return isLegacyDirection(value) ? LEGACY_TIER[value] : null
}
const LEGACY_HINT: Readonly<Record<ModelDirection, LegacyDirection>> = {
  complex: 'plan',
  medium: 'code',
  simple: 'fast',
  image: 'image',
  speech: 'speech',
  video: 'video',
}
/**
 * A turn's direction as it travels in `task.request`. A node older than P38
 * refuses the whole envelope over a name it does not know, so the hint keeps
 * the P22 name that means the same there; {@link directionOf} maps it back.
 */
export function legacyDirectionOf(direction: ModelDirection): LegacyDirection {
  return LEGACY_HINT[direction]
}
/**
 * A whole P22 split in the P38 set: `plan` → complex, `code` (else `chat`) →
 * medium, `fast` → simple, media as they are; `vision` is dropped (pictures
 * in follow the main model).
 */
export function migrateLegacyRoutes<T>(
  routes: Partial<Record<LegacyDirection, T>>,
): Partial<Record<ModelDirection, T>> {
  const out: Partial<Record<ModelDirection, T>> = {}
  const medium = routes.code ?? routes.chat
  if (routes.plan !== undefined) out.complex = routes.plan
  if (medium !== undefined) out.medium = medium
  if (routes.fast !== undefined) out.simple = routes.fast
  for (const media of ['image', 'speech', 'video'] as const)
    if (routes[media] !== undefined) out[media] = routes[media]
  return out
}
/**
 * The split for a node that has not said `tierRouting`: P22 names, the
 * medium tier on both `code` and `chat`, no effort (the closed v1 schema
 * refuses the field).
 */
export function legacyModelRouting(routing: ModelRouting): LegacyModelRouting {
  const routes: LegacyModelRouting['routes'] = {}
  const ref = (one: ModelRouteRef | undefined) =>
    one === undefined
      ? undefined
      : { profileId: one.profileId, modelId: one.modelId }
  const pairs: readonly [LegacyDirection, ModelDirection][] = [
    ['plan', 'complex'],
    ['code', 'medium'],
    ['chat', 'medium'],
    ['fast', 'simple'],
    ['image', 'image'],
    ['speech', 'speech'],
    ['video', 'video'],
  ]
  for (const [legacy, direction] of pairs) {
    const one = ref(routing.routes[direction])
    if (one !== undefined) routes[legacy] = one
  }
  return { auto: routing.auto, routes }
}
/** What goes on the wire to a node with these capabilities. */
export function routingForNode(
  routing: ModelRouting,
  capabilities: Pick<NodeCapabilities, 'tierRouting'>,
): ModelRouting | LegacyModelRouting {
  return capabilities.tierRouting ? routing : legacyModelRouting(routing)
}

const TIER_ONLY: readonly string[] = ['complex', 'medium', 'simple']
const LEGACY_ONLY: readonly string[] = [
  'code',
  'chat',
  'plan',
  'fast',
  'vision',
]
/**
 * Closed wire schema, shared by the hub and node; never silently drops a
 * direction it does not know. A whole P22 split (an older hub) is accepted
 * and mapped; the two sets mixed in one split are refused.
 */
export function parseModelRouting(value: unknown): ModelRouting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    Object.keys(raw).some(k => k !== 'auto' && k !== 'routes') ||
    typeof raw.auto !== 'boolean' ||
    !raw.routes ||
    typeof raw.routes !== 'object' ||
    Array.isArray(raw.routes)
  )
    return null
  const names = Object.keys(raw.routes)
  const legacy = names.some(name => LEGACY_ONLY.includes(name))
  if (legacy && names.some(name => TIER_ONLY.includes(name))) return null
  const parsed: Partial<Record<string, ModelRouteRef>> = {}
  for (const [direction, value] of Object.entries(raw.routes)) {
    if (
      !(legacy ? isLegacyDirection(direction) : isModelDirection(direction)) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return null
    const ref = value as Record<string, unknown>
    if (
      Object.keys(ref).some(
        k => k !== 'profileId' && k !== 'modelId' && (legacy || k !== 'effort'),
      ) ||
      typeof ref.profileId !== 'string' ||
      !/^[a-z0-9-]{1,48}$/.test(ref.profileId) ||
      typeof ref.modelId !== 'string' ||
      (ref.effort !== undefined && !isTierEffort(ref.effort))
    )
      return null
    parsed[direction] = {
      profileId: ref.profileId,
      modelId: ref.modelId,
      ...(ref.effort === undefined ? {} : { effort: ref.effort }),
    }
  }
  return {
    auto: raw.auto,
    routes: legacy
      ? migrateLegacyRoutes(
          parsed as Partial<Record<LegacyDirection, ModelRouteRef>>,
        )
      : (parsed as ModelRouting['routes']),
  }
}
export function routingProblem(
  routing: ModelRouting,
  profiles: readonly ProfileCore[],
): string | null {
  for (const [direction, ref] of Object.entries(routing.routes)) {
    const profile = profiles.find(p => p.id === ref.profileId)
    const model = profile?.models.find(m => m.id === ref.modelId)
    if (!profile || !model) return `${direction}: 档案或模型不存在`
    if (
      !DIRECTION_KINDS[direction as ModelDirection].includes(
        model.kind ?? 'chat',
      )
    )
      return `${direction}: 模型 kind 不适合此方向`
    if (
      ref.effort !== undefined &&
      !tierEffortChoices(model, profile).includes(ref.effort)
    )
      return `${direction}: 这个模型不接受推理强度 ${ref.effort}`
  }
  return null
}

// Media intent comes first: “为视频画海报” is a video task. Reading a picture
// is not making one, so it is caught before 生图 and left to the medium tier
// (pictures in follow the main model). Complex precedes simple: a large job
// sent to a small model costs more than a small one sent to a large model.
// English tokens have boundaries (“display” is not plan).
const RULES: readonly {
  direction: ModelDirection
  rule: string
  pattern: RegExp
}[] = [
  {
    direction: 'video',
    rule: 'video-keyword',
    pattern: /视频|短片|动画|\b(?:video|clip)\b/i,
  },
  {
    direction: 'speech',
    rule: 'speech-keyword',
    pattern: /朗读|配音|语音|\b(?:tts|voice)\b|\bread aloud\b/i,
  },
  {
    direction: 'medium',
    rule: 'vision-keyword',
    pattern: /截图|这张图|图片里|\bscreenshot\b|\bthis (?:image|picture)\b/i,
  },
  {
    direction: 'image',
    rule: 'image-keyword',
    pattern: /画|绘|海报|插图|配图|\b(?:logo|image|draw)\b/i,
  },
  {
    direction: 'complex',
    rule: 'complex-keyword',
    pattern:
      /规划|计划|方案|架构|重构|调研|拆解|评估|多步|跨文件|大改|\b(?:plan|planning|architect|architecture|refactor|research|investigate|multi-step|redesign)\b/i,
  },
  {
    direction: 'simple',
    rule: 'simple-keyword',
    pattern:
      /提取|摘出|改写|润色|归类|分类|翻译|格式化|\b(?:extract|rewrite|rephrase|classify|categori[sz]e|translate|reformat|format)\b/i,
  },
]
/** Code-shaped text is never a short question, however short. */
const CODE_SHAPE =
  /```|\b[\w-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|h|rb|sh|sql|vue|svelte|json|ya?ml)\b|\b(?:TypeError|ReferenceError|SyntaxError|Traceback)\b|\bat\s+[^\n]+:\d+:\d+/
const QUESTION = /[?？]\s*$|吗|什么|多少|哪|谁|几/
/** 短问答: one line of at most 40 characters that asks something. */
function shortQuestion(text: string): boolean {
  const line = text.trim()
  return (
    line !== '' &&
    !line.includes('\n') &&
    [...line].length <= 40 &&
    QUESTION.test(line) &&
    !CODE_SHAPE.test(line)
  )
}
/** The fixed, testable rules: first match wins, otherwise the medium tier. */
export function classifyDirection(text: string): {
  direction: ModelDirection
  rule: string
} {
  const match = RULES.find(rule => rule.pattern.test(text))
  if (match) return { direction: match.direction, rule: match.rule }
  if (shortQuestion(text))
    return { direction: 'simple', rule: 'short-question' }
  return { direction: 'medium', rule: 'fallback-medium' }
}
