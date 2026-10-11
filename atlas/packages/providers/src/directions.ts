// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Lane, ModelKind, ProfileCore } from './types.js'

export const MODEL_DIRECTIONS = [
  'code',
  'chat',
  'plan',
  'fast',
  'vision',
  'image',
  'speech',
  'video',
] as const
export type ModelDirection = (typeof MODEL_DIRECTIONS)[number]
export const DIRECTION_ROLES: Record<ModelDirection, readonly string[]> = {
  code: ['default', 'task'],
  chat: ['chat'],
  plan: ['plan', 'slow'],
  fast: ['smol', 'commit', 'tiny'],
  vision: ['vision'],
  image: ['image'],
  speech: ['speech'],
  video: ['video'],
}
export const DIRECTION_KINDS: Record<ModelDirection, readonly ModelKind[]> = {
  code: ['chat'],
  chat: ['chat'],
  plan: ['chat'],
  fast: ['chat'],
  vision: ['chat'],
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
export type ModelRouteRef = { profileId: string; modelId: string }
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
/** Closed wire schema, shared by the hub and node; never silently drops a direction. */
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
  const routes: ModelRouting['routes'] = {}
  for (const [direction, value] of Object.entries(raw.routes)) {
    if (
      !isModelDirection(direction) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return null
    const ref = value as Record<string, unknown>
    if (
      Object.keys(ref).some(k => k !== 'profileId' && k !== 'modelId') ||
      typeof ref.profileId !== 'string' ||
      !/^[a-z0-9-]{1,48}$/.test(ref.profileId) ||
      typeof ref.modelId !== 'string'
    )
      return null
    routes[direction] = { profileId: ref.profileId, modelId: ref.modelId }
  }
  return { auto: raw.auto, routes }
}
export function routingProblem(
  routing: ModelRouting,
  profiles: readonly ProfileCore[],
): string | null {
  for (const [direction, ref] of Object.entries(routing.routes)) {
    const profile = profiles.find(p => p.id === ref.profileId)
    const model = profile?.models.find(m => m.id === ref.modelId)
    if (!model) return `${direction}: 档案或模型不存在`
    if (
      !DIRECTION_KINDS[direction as ModelDirection].includes(
        model.kind ?? 'chat',
      )
    )
      return `${direction}: 模型 kind 不适合此方向`
  }
  return null
}
// Media intent precedes planning, then code: “实现视频生成” is a video task by
// the task-book contract. English tokens have boundaries (“display” is not plan).
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
    direction: 'vision',
    rule: 'vision-keyword',
    pattern: /截图|这张图|图片里|\bscreenshot\b|\bthis (?:image|picture)\b/i,
  },
  {
    direction: 'image',
    rule: 'image-keyword',
    pattern: /画|绘|海报|插图|配图|\b(?:logo|image|draw)\b/i,
  },
  {
    direction: 'plan',
    rule: 'plan-keyword',
    pattern: /计划|方案|规划|拆解|分析|评估|\bplan\b/i,
  },
  { direction: 'code', rule: 'code-block', pattern: /```/ },
  {
    direction: 'code',
    rule: 'code-file',
    pattern:
      /\b[\w-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|h|rb|sh|sql|vue|svelte|json|ya?ml)\b/i,
  },
  {
    direction: 'code',
    rule: 'code-stack',
    pattern:
      /(?:\b(?:TypeError|ReferenceError|SyntaxError|Traceback)\b|\bat\s+[^\n]+:\d+:\d+)/,
  },
  {
    direction: 'code',
    rule: 'code-keyword',
    pattern:
      /代码|修复|实现|重构|测试|编译|\b(?:code|coding|fix|implement|refactor|test|compile|bug|pr|commit)\b/i,
  },
]
export function classifyDirection(text: string): {
  direction: ModelDirection
  rule: string
} {
  const match = RULES.find(rule => rule.pattern.test(text))
  return match
    ? { direction: match.direction, rule: match.rule }
    : { direction: 'chat', rule: 'fallback-chat' }
}
