// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  classifyDirection,
  directionOf,
  legacyDirectionOf,
  legacyModelRouting,
  MODEL_DIRECTIONS,
  migrateLegacyRoutes,
  parseModelRouting,
  parseWireProfile,
  presetById,
  parseProviderRequest,
  routingForNode,
  routingProblem,
  tierEffortChoices,
  type ModelDirection,
  type ModelRouting,
  type ProfileCore,
} from '../src/index.js'
import {
  applyRequestJson,
  wireProfileJson,
  anthropicModel,
  CANARY_KEY,
  V1_CAPABILITIES,
} from './fixtures.js'
const cases: readonly [string, ModelDirection, string][] = [
  ['画一只猫', 'image', 'image-keyword'],
  ['绘制风景', 'image', 'image-keyword'],
  ['海报设计', 'image', 'image-keyword'],
  ['插图', 'image', 'image-keyword'],
  ['配图', 'image', 'image-keyword'],
  ['设计 LOGO', 'image', 'image-keyword'],
  ['create an image', 'image', 'image-keyword'],
  ['DRAW a cat', 'image', 'image-keyword'],
  ['视频', 'video', 'video-keyword'],
  ['短片', 'video', 'video-keyword'],
  ['动画', 'video', 'video-keyword'],
  ['make VIDEO', 'video', 'video-keyword'],
  ['clip', 'video', 'video-keyword'],
  ['朗读文字', 'speech', 'speech-keyword'],
  ['配音', 'speech', 'speech-keyword'],
  ['语音', 'speech', 'speech-keyword'],
  ['TTS', 'speech', 'speech-keyword'],
  ['read aloud', 'speech', 'speech-keyword'],
  // Reading a picture is not making one: the medium tier, the main model.
  ['截图的问题', 'medium', 'vision-keyword'],
  ['这张图', 'medium', 'vision-keyword'],
  ['图片里有什么', 'medium', 'vision-keyword'],
  ['this image contains a cat', 'medium', 'vision-keyword'],
  ['截图 screenshot image bug', 'medium', 'vision-keyword'],
  ['规划下个季度的迭代', 'complex', 'complex-keyword'],
  ['给这个服务定架构', 'complex', 'complex-keyword'],
  ['重构整个模块', 'complex', 'complex-keyword'],
  ['调研三家竞品', 'complex', 'complex-keyword'],
  ['多步骤迁移数据', 'complex', 'complex-keyword'],
  ['跨文件大改接口', 'complex', 'complex-keyword'],
  ['拆解这个需求', 'complex', 'complex-keyword'],
  ['make a PLAN', 'complex', 'complex-keyword'],
  ['refactor the parser', 'complex', 'complex-keyword'],
  ['research vector stores', 'complex', 'complex-keyword'],
  ['提取这段话里的日期', 'simple', 'simple-keyword'],
  ['改写成正式语气', 'simple', 'simple-keyword'],
  ['把这些反馈归类', 'simple', 'simple-keyword'],
  ['翻译成英文', 'simple', 'simple-keyword'],
  ['格式化这份 JSON', 'simple', 'simple-keyword'],
  ['Translate this to French', 'simple', 'simple-keyword'],
  ['extract the emails', 'simple', 'simple-keyword'],
  ['现在几点了？', 'simple', 'short-question'],
  ['北京的区号是多少', 'simple', 'short-question'],
  ['what time is it?', 'simple', 'short-question'],
  ['```ts\nx()\n```', 'medium', 'fallback-medium'],
  ['fix app.ts', 'medium', 'fallback-medium'],
  ['app.ts 为什么报错？', 'medium', 'fallback-medium'],
  ['TypeError: x', 'medium', 'fallback-medium'],
  ['修复登录页的报错', 'medium', 'fallback-medium'],
  ['实现一个分页接口', 'medium', 'fallback-medium'],
  ['你好', 'medium', 'fallback-medium'],
  ['display microprocessor', 'medium', 'fallback-medium'],
  ['', 'medium', 'fallback-medium'],
  [`${'这是一段很长的问题'.repeat(6)}？`, 'medium', 'fallback-medium'],
  ['第一行？\n第二行？', 'medium', 'fallback-medium'],
  // First match wins: media, then complex before simple.
  ['为视频画海报并实现代码', 'video', 'video-keyword'],
  ['给海报配音分析', 'speech', 'speech-keyword'],
  ['分析这张图的代码', 'medium', 'vision-keyword'],
  ['用 draw 实现 image logo', 'image', 'image-keyword'],
  ['把重构方案翻译成英文', 'complex', 'complex-keyword'],
  ['翻译这个问题吗？', 'simple', 'simple-keyword'],
]
for (const [text, direction, rule] of cases)
  test(`classification: ${text}`, () =>
    expect(classifyDirection(text)).toEqual({ direction, rule }))
test('closed directions are the three tiers and the three media', () =>
  expect(MODEL_DIRECTIONS).toEqual([
    'complex',
    'medium',
    'simple',
    'image',
    'speech',
    'video',
  ]))
test('one direction from anywhere: P38 names as they are, P22 names mapped, the rest null', () => {
  for (const direction of MODEL_DIRECTIONS)
    expect(directionOf(direction)).toBe(direction)
  expect(directionOf('plan')).toBe('complex')
  expect(directionOf('code')).toBe('medium')
  expect(directionOf('chat')).toBe('medium')
  expect(directionOf('vision')).toBe('medium')
  expect(directionOf('fast')).toBe('simple')
  for (const other of ['dance', '', null, undefined, 3, 'Complex'])
    expect(directionOf(other)).toBeNull()
})
test('a turn hint travels under the P22 name and maps back to the same tier', () => {
  expect(MODEL_DIRECTIONS.map(legacyDirectionOf)).toEqual([
    'plan',
    'code',
    'fast',
    'image',
    'speech',
    'video',
  ])
  for (const direction of MODEL_DIRECTIONS)
    expect(directionOf(legacyDirectionOf(direction))).toBe(direction)
})
test('a P22 split migrates: plan, code else chat, fast, media; vision is dropped', () => {
  const ref = (modelId: string) => ({ profileId: 'svc', modelId })
  expect(
    migrateLegacyRoutes({
      code: ref('coder'),
      chat: ref('talker'),
      plan: ref('planner'),
      fast: ref('quick'),
      vision: ref('eyes'),
      image: ref('painter'),
      speech: ref('voice'),
      video: ref('film'),
    }),
  ).toEqual({
    complex: ref('planner'),
    medium: ref('coder'),
    simple: ref('quick'),
    image: ref('painter'),
    speech: ref('voice'),
    video: ref('film'),
  })
  expect(migrateLegacyRoutes({ chat: ref('talker') })).toEqual({
    medium: ref('talker'),
  })
  expect(migrateLegacyRoutes({ vision: ref('eyes') })).toEqual({})
})
test('the wire takes a P38 split with effort, or a whole P22 split mapped; mixed or unknown is refused', () => {
  const ref = { profileId: 'svc', modelId: 'm' }
  expect(
    parseModelRouting({
      auto: true,
      routes: { complex: { ...ref, effort: 'xhigh' }, simple: ref },
    }),
  ).toEqual({
    auto: true,
    routes: { complex: { ...ref, effort: 'xhigh' }, simple: ref },
  })
  expect(
    parseModelRouting({
      auto: false,
      routes: { chat: ref, plan: ref, vision: ref, image: ref },
    }),
  ).toEqual({
    auto: false,
    routes: { medium: ref, complex: ref, image: ref },
  })
  for (const bad of [
    { auto: true, routes: { code: ref, medium: ref } },
    { auto: true, routes: { plan: { ...ref, effort: 'high' } } },
    { auto: true, routes: { medium: { ...ref, effort: 'turbo' } } },
    { auto: true, routes: { medium: { ...ref, extra: 1 } } },
    { auto: true, routes: { dance: ref } },
  ])
    expect(parseModelRouting(bad)).toBeNull()
})
test('a node without tierRouting gets the P22 names back, medium on code and chat, no effort', () => {
  const routing: ModelRouting = {
    auto: true,
    routes: {
      complex: { profileId: 'svc', modelId: 'big', effort: 'max' },
      medium: { profileId: 'svc', modelId: 'mid', effort: 'none' },
      simple: { profileId: 'svc', modelId: 'small' },
      video: { profileId: 'film', modelId: 'veo' },
    },
  }
  const legacy = {
    auto: true,
    routes: {
      plan: { profileId: 'svc', modelId: 'big' },
      code: { profileId: 'svc', modelId: 'mid' },
      chat: { profileId: 'svc', modelId: 'mid' },
      fast: { profileId: 'svc', modelId: 'small' },
      video: { profileId: 'film', modelId: 'veo' },
    },
  }
  expect(legacyModelRouting(routing)).toEqual(legacy)
  expect(routingForNode(routing, V1_CAPABILITIES)).toEqual(legacy)
  expect(
    routingForNode(routing, { ...V1_CAPABILITIES, tierRouting: true }),
  ).toBe(routing)
  // What an old node's closed schema reads, and a new node maps back.
  expect(parseModelRouting(legacy)?.routes).toEqual({
    complex: { profileId: 'svc', modelId: 'big' },
    medium: { profileId: 'svc', modelId: 'mid' },
    simple: { profileId: 'svc', modelId: 'small' },
    video: { profileId: 'film', modelId: 'veo' },
  })
})
test('effort choices narrow to what the model takes', () => {
  // always, levels low/high/max: no off switch.
  expect(tierEffortChoices(anthropicModel())).toEqual(['low', 'high', 'max'])
  expect(
    tierEffortChoices(
      anthropicModel({ effort: { send: 'auto', levels: ['high', 'low'] } }),
    ),
  ).toEqual(['none', 'low', 'high'])
  expect(
    tierEffortChoices(
      anthropicModel({
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
      }),
    ),
  ).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  for (const none of [
    anthropicModel({ effort: { send: 'never' } }),
    anthropicModel({ kind: 'image', effort: { send: 'never' } }),
  ])
    expect(tierEffortChoices(none)).toEqual([])
  expect(tierEffortChoices(anthropicModel(), { effortLock: 'high' })).toEqual(
    [],
  )
})
test('routingProblem refuses an effort the model does not take', () => {
  const profile = wireProfileJson() as unknown as ProfileCore
  const at = (effort: 'max' | 'medium' | 'none') => ({
    auto: false,
    routes: {
      complex: {
        profileId: 'vendor-paygo',
        modelId: 'vendor-model-pro',
        effort,
      },
    },
  })
  expect(routingProblem(at('max'), [profile])).toBeNull()
  expect(routingProblem(at('medium'), [profile])).toContain('推理强度')
  expect(routingProblem(at('none'), [profile])).toContain('推理强度')
})
for (const id of [
  'openai-images',
  'gemini-images',
  'openrouter-images',
  'openai-speech',
  'openrouter-video',
])
  test(`media preset ${id} parses and rejects a chat role or lane`, () => {
    const preset = presetById(id)!
    const raw = wireProfileJson({
      lane: preset.lane,
      models: preset.models,
      compat: {},
      baseUrl: preset.baseUrl,
    })
    expect(parseWireProfile(raw).ok).toBe(true)
    expect(preset.evaluated).toBe(false)
    expect(preset.source.verifiedAt).toBe('2026-10-11')
    expect(
      parseWireProfile({
        ...raw,
        models: [{ ...preset.models[0], role: 'main' }],
      }).ok,
    ).toBe(false)
    expect(
      parseWireProfile({
        ...raw,
        models: [{ ...preset.models[0], role: 'fast' }],
      }).ok,
    ).toBe(false)
    expect(parseWireProfile({ ...raw, lane: 'openai-chat' }).ok).toBe(false)
  })
test('legacy missing kind remains chat, unknown kind and media effort are rejected', () => {
  expect(parseWireProfile(wireProfileJson()).ok).toBe(true)
  expect(
    parseWireProfile(
      wireProfileJson({ models: [anthropicModel({ kind: 'image' })] }),
    ).ok,
  ).toBe(false)
  expect(
    parseWireProfile(
      wireProfileJson({ models: [{ ...anthropicModel(), kind: 'music' }] }),
    ).ok,
  ).toBe(false)
  const preset = presetById('openai-images')!
  expect(
    parseWireProfile(
      wireProfileJson({
        lane: preset.lane,
        models: [{ ...preset.models[0], effort: { send: 'auto' } }],
        compat: {},
      }),
    ).ok,
  ).toBe(false)
})
test('multi-profile apply preserves both keys and routing; unknown route fields, illegal kinds, duplicate profiles and oversized objects fail', () => {
  const second = wireProfileJson({
    id: 'second',
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: CANARY_KEY }] },
  })
  const request = applyRequestJson({
    profiles: [second],
    routing: {
      auto: true,
      routes: { medium: { profileId: 'second', modelId: 'vendor-model-pro' } },
    },
  })
  const result = parseProviderRequest(request)
  expect(result.ok).toBe(true)
  if (result.ok && result.request.op === 'apply')
    expect(result.request.profiles?.[0]?.id).toBe('second')
  for (const patch of [
    { routing: { auto: true, unknown: 1, routes: {} } },
    {
      routing: {
        auto: true,
        routes: { image: { profileId: 'second', modelId: 'vendor-model-pro' } },
      },
    },
    { profiles: [second, second] },
    {
      profiles: [wireProfileJson({ id: 'second', baseUrl: 'x'.repeat(65536) })],
    },
  ])
    expect(parseProviderRequest({ ...request, ...patch }).ok).toBe(false)
  expect(parseProviderRequest(applyRequestJson()).ok).toBe(true)
})
