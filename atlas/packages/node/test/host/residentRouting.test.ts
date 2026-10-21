// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  applyResidentModelRoute,
  ResidentModelRouter,
  decideResidentRoute,
  residentRouteSelection,
  residentMediaRoutes,
} from '../../src/host/residentRouting.js'
import { isolatedRoot } from '../providers/fake.js'
import { writePrivateJson, providerPaths } from '../../src/providers/store.js'

test('explicit direction overrides automatic text; auto off preserves the current model', () => {
  expect(
    decideResidentRoute({ text: '视频代码', hint: 'complex', auto: true }),
  ).toEqual({ direction: 'complex', source: 'hint', rule: 'explicit-hint' })
  expect(decideResidentRoute({ text: '修复代码', auto: true })).toMatchObject({
    direction: 'medium',
    source: 'auto',
  })
  expect(decideResidentRoute({ text: '你好', auto: false })).toBeNull()
})
test('a hint under its P22 name (what a hub sends, what an older hub sent) names the same tier', () => {
  for (const [hint, direction] of [
    ['plan', 'complex'],
    ['code', 'medium'],
    ['chat', 'medium'],
    ['vision', 'medium'],
    ['fast', 'simple'],
    ['image', 'image'],
  ] as const)
    expect(decideResidentRoute({ text: '视频', hint, auto: false })).toEqual({
      direction,
      source: 'hint',
      rule: 'explicit-hint',
    })
  // Not a direction at all: no hint, the text decides when auto is on.
  expect(
    decideResidentRoute({ text: '翻译成英文', hint: 'dance', auto: true }),
  ).toMatchObject({ direction: 'simple', source: 'auto' })
})
test('chat selectors and effort suffixes resolve from config; media keeps a chat main and routes its runner separately', () => {
  const f = isolatedRoot()
  try {
    writePrivateJson(providerPaths.config(), {
      modelRoles: {
        default: 'qm-code-12345678/main:high',
        chat: 'qm-code-12345678/main:high',
        smol: 'qm-fast-12345678/model:low',
        video: 'qm-video-12345678/google/veo-3.1:off',
        image: 'qm-image-12345678/gpt-image-2:off',
      },
      qianmoRouting: { auto: true },
      generate_image: { enabled: true },
    })
    expect(residentRouteSelection({ text: 'hello' })).toMatchObject({
      direction: 'medium',
      source: 'auto',
      selection: {
        provider: 'qm-code-12345678',
        modelId: 'main',
        thinkingLevel: 'high',
      },
    })
    expect(residentRouteSelection({ text: '翻译成英文' })).toMatchObject({
      direction: 'simple',
      selection: {
        provider: 'qm-fast-12345678',
        modelId: 'model',
        thinkingLevel: 'low',
      },
    })
    // No plan role written: the complex tier follows the main model.
    expect(residentRouteSelection({ text: '重构整个模块' })).toMatchObject({
      direction: 'complex',
      selection: { provider: 'qm-code-12345678', modelId: 'main' },
    })
    expect(residentRouteSelection({ text: 'video' })).toMatchObject({
      direction: 'video',
      selection: undefined,
      mediaModel: { provider: 'qm-video-12345678', modelId: 'google/veo-3.1' },
    })
    expect(residentMediaRoutes()).toEqual({
      image: true,
      speech: false,
      video: true,
    })
    writePrivateJson(providerPaths.config(), {
      modelRoles: { default: 'qm-code/main:high' },
      qianmoRouting: { auto: false },
    })
    expect(residentRouteSelection({ text: 'hello' })).toBeNull()
    expect(residentMediaRoutes()).toEqual({
      image: false,
      speech: false,
      video: false,
    })
  } finally {
    f.dispose()
  }
})

test('switch applies model before effort and audit returns actual clamped state, with no redundant set_model', async () => {
  const calls: string[] = []
  let model = { provider: 'old', id: 'main' }
  let level = 'high'
  const rpc = {
    async request(type: string, input?: Record<string, unknown>) {
      calls.push(type)
      if (type === 'set_model') {
        model = {
          provider: String(input?.provider),
          id: String(input?.modelId),
        }
        level = 'off'
      }
      if (type === 'set_thinking_level')
        level = input?.level === 'max' ? 'high' : String(input?.level)
      return { type: 'response', data: { model, thinkingLevel: level } }
    },
  }
  expect(
    await applyResidentModelRoute(rpc, {
      provider: 'new',
      modelId: 'chat',
      thinkingLevel: 'max',
    }),
  ).toEqual({ model: 'new/chat', thinkingLevel: 'high' })
  expect(calls).toEqual([
    'get_state',
    'set_model',
    'get_state',
    'set_thinking_level',
    'get_state',
  ])
  calls.length = 0
  await applyResidentModelRoute(rpc, {
    provider: 'new',
    modelId: 'chat',
    thinkingLevel: 'high',
  })
  expect(calls).toEqual(['get_state'])
})
test('a failed model switch cannot proceed under a different actual model', async () => {
  const rpc = {
    async request() {
      return {
        type: 'response',
        data: { model: { provider: 'old', id: 'old' }, thinkingLevel: 'high' },
      }
    },
  }
  await expect(
    applyResidentModelRoute(rpc, { provider: 'new', modelId: 'new' }),
  ).rejects.toThrow('did not select')
})

function routingFake() {
  const calls: string[] = []
  let current = { provider: 'manual', id: 'X' }
  let level = 'high'
  return {
    calls,
    async request(type: string, input?: Record<string, unknown>) {
      calls.push(type)
      if (type === 'set_model')
        current = {
          provider: String(input?.provider),
          id: String(input?.modelId),
        }
      if (type === 'set_thinking_level') level = String(input?.level)
      return {
        type: 'response',
        data: { model: current, thinkingLevel: level },
      }
    },
  }
}
test('manual choice persists for two turns, wins over auto and survives a reopened router; an explicit hint only changes its own turn', async () => {
  const f = isolatedRoot()
  try {
    const file = `${f.root}/manual.json`
    const rpc = routingFake()
    const router = new ResidentModelRouter(file)
    await router.remember(rpc)
    for (const auto of [false, true]) {
      writePrivateJson(providerPaths.config(), {
        qianmoRouting: { auto },
        modelRoles: { default: 'auto/chat:low', plan: 'hint/plan:off' },
      })
      rpc.calls.length = 0
      for (let round = 0; round < 2; round++) {
        await router.prepare(rpc, { text: 'hello' })
        await router.finish(rpc)
      }
      expect(rpc.calls.filter(c => c.startsWith('set_'))).toEqual([])
      expect((await rpc.request('get_state')).data).toMatchObject({
        model: { provider: 'manual', id: 'X' },
        thinkingLevel: 'high',
      })
    }
    const route = await router.prepare(rpc, { text: 'hello', hint: 'plan' })
    expect(route?.actual).toEqual({ model: 'hint/plan', thinkingLevel: 'off' })
    await router.finish(rpc)
    await new ResidentModelRouter(file).prepare(rpc, { text: 'hello' })
    expect((await rpc.request('get_state')).data).toMatchObject({
      model: { provider: 'manual', id: 'X' },
      thinkingLevel: 'high',
    })
    await router.prepare(rpc, { text: 'hello', hint: 'plan' })
    await rpc.request('set_model', { provider: 'manual', modelId: 'Y' })
    await rpc.request('set_thinking_level', { level: 'low' })
    await router.remember(rpc)
    await router.finish(rpc)
    await new ResidentModelRouter(file).prepare(rpc, { text: 'hello' })
    expect((await rpc.request('get_state')).data).toMatchObject({
      model: { provider: 'manual', id: 'Y' },
      thinkingLevel: 'low',
    })
    router.clear()
    expect(
      (await new ResidentModelRouter(file).prepare(rpc, { text: 'hello' }))
        ?.actual.model,
    ).toBe('auto/chat')
  } finally {
    f.dispose()
  }
})
test('query and manual local commands perform zero routing mutations, even with explicit hints; media never replaces the main model', async () => {
  const f = isolatedRoot()
  try {
    writePrivateJson(providerPaths.config(), {
      qianmoRouting: { auto: true },
      modelRoles: { default: 'auto/chat:low', video: 'media/video:off' },
    })
    const rpc = routingFake()
    const router = new ResidentModelRouter()
    for (const localCommand of [
      '/model',
      '/thinking',
      '/effort',
      '/context',
      '/autocompact',
      '/model other/X',
      '/thinking low',
    ]) {
      await router.prepare(rpc, {
        text: localCommand,
        localCommand,
        hint: 'chat',
      })
      await router.finish(rpc)
    }
    expect(rpc.calls).toEqual([])
    const route = await router.prepare(rpc, { text: 'video' })
    expect(route?.actual.model).toBe('manual/X')
    expect(route?.mediaModel?.modelId).toBe('video')
    expect(rpc.calls.filter(c => c.startsWith('set_'))).toEqual([])
  } finally {
    f.dispose()
  }
})
