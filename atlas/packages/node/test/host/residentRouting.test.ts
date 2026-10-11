// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  applyResidentModelRoute,
  decideResidentRoute,
  residentRouteSelection,
  residentMediaRoutes,
} from '../../src/host/residentRouting.js'
import { isolatedRoot } from '../providers/fake.js'
import { writePrivateJson, providerPaths } from '../../src/providers/store.js'

test('explicit direction overrides automatic text; auto off selects default, not chat', () => {
  expect(
    decideResidentRoute({ text: '视频代码', hint: 'chat', auto: true }),
  ).toEqual({ direction: 'chat', source: 'hint', rule: 'explicit-hint' })
  expect(decideResidentRoute({ text: '修复代码', auto: true })).toMatchObject({
    direction: 'code',
    source: 'auto',
  })
  expect(decideResidentRoute({ text: '你好', auto: false })).toMatchObject({
    direction: 'code',
    source: 'default',
  })
})
test('chat selectors and effort suffixes resolve from config; media keeps a chat main and routes its runner separately', () => {
  const f = isolatedRoot()
  try {
    writePrivateJson(providerPaths.config(), {
      modelRoles: {
        default: 'qm-code-12345678/main:high',
        chat: 'qm-chat-12345678/model:low',
        video: 'qm-video-12345678/google/veo-3.1:off',
        image: 'qm-image-12345678/gpt-image-2:off',
      },
      qianmoRouting: { auto: true },
      generate_image: { enabled: true },
    })
    expect(residentRouteSelection({ text: 'hello' })).toMatchObject({
      direction: 'chat',
      source: 'auto',
      selection: {
        provider: 'qm-chat-12345678',
        modelId: 'model',
        thinkingLevel: 'low',
      },
    })
    expect(residentRouteSelection({ text: 'video' })).toMatchObject({
      direction: 'video',
      selection: { provider: 'qm-code-12345678', thinkingLevel: 'high' },
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
    expect(residentRouteSelection({ text: 'hello' })).toMatchObject({
      source: 'default',
      selection: { provider: 'qm-code' },
    })
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
