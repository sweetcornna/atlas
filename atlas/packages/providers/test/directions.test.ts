// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  classifyDirection,
  MODEL_DIRECTIONS,
  parseWireProfile,
  presetById,
  parseProviderRequest,
  type ModelDirection,
} from '../src/index.js'
import {
  applyRequestJson,
  wireProfileJson,
  anthropicModel,
  CANARY_KEY,
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
  ['截图的问题', 'vision', 'vision-keyword'],
  ['这张图', 'vision', 'vision-keyword'],
  ['图片里有什么', 'vision', 'vision-keyword'],
  ['计划', 'plan', 'plan-keyword'],
  ['方案', 'plan', 'plan-keyword'],
  ['规划', 'plan', 'plan-keyword'],
  ['拆解', 'plan', 'plan-keyword'],
  ['分析', 'plan', 'plan-keyword'],
  ['评估', 'plan', 'plan-keyword'],
  ['make a PLAN', 'plan', 'plan-keyword'],
  ['```ts\nx()\n```', 'code', 'code-block'],
  ['fix app.ts', 'code', 'code-file'],
  ['main.py', 'code', 'code-file'],
  ['TypeError: x', 'code', 'code-stack'],
  ['at run (/app:1:2)', 'code', 'code-stack'],
  ['代码', 'code', 'code-keyword'],
  ['BUG', 'code', 'code-keyword'],
  ['修复', 'code', 'code-keyword'],
  ['实现', 'code', 'code-keyword'],
  ['重构', 'code', 'code-keyword'],
  ['测试', 'code', 'code-keyword'],
  ['编译', 'code', 'code-keyword'],
  ['PR', 'code', 'code-keyword'],
  ['commit', 'code', 'code-keyword'],
  ['write code', 'code', 'code-keyword'],
  ['fix a problem', 'code', 'code-keyword'],
  ['read aloud', 'speech', 'speech-keyword'],
  ['this image contains a cat', 'vision', 'vision-keyword'],
  ['截图 screenshot image bug', 'vision', 'vision-keyword'],
  ['你好', 'chat', 'fallback-chat'],
  ['display microprocessor', 'chat', 'fallback-chat'],
  ['', 'chat', 'fallback-chat'],
  ['为视频画海报并实现代码', 'video', 'video-keyword'],
  ['给海报配音分析', 'speech', 'speech-keyword'],
  ['分析这张图的代码', 'vision', 'vision-keyword'],
  ['用 draw 实现 image logo', 'image', 'image-keyword'],
  ['分析 app.ts bug', 'plan', 'plan-keyword'],
  ['```ts\n// bug\n```', 'code', 'code-block'],
]
for (const [text, direction, rule] of cases)
  test(`classification: ${text}`, () =>
    expect(classifyDirection(text)).toEqual({ direction, rule }))
test('closed directions include all eight consumer choices', () =>
  expect(MODEL_DIRECTIONS).toEqual([
    'code',
    'chat',
    'plan',
    'fast',
    'vision',
    'image',
    'speech',
    'video',
  ]))
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
      routes: { chat: { profileId: 'second', modelId: 'vendor-model-pro' } },
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
