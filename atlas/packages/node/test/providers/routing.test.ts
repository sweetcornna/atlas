// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as path from 'node:path'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import {
  AuthStorage,
  SqliteAuthCredentialStore,
} from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { LANE_KINDS } from '@qianmo/providers'
import {
  compileProfile,
  compileRoutingProfiles,
  LANE_API,
} from '../../src/providers/compile.js'
import {
  stageProviderApply,
  commitPendingProviderConfig,
  readYaml,
  currentManagedHash,
  nodeModelSelection,
} from '../../src/providers/node.js'
import { providerPaths, writePrivateJson } from '../../src/providers/store.js'
import { isolatedRoot } from './fake.js'
import { applyRequest, CANARY_KEY, wireProfile } from './helpers.js'
import {
  capabilities,
  routingFixture,
  mediaProfile,
} from './routingFixtures.js'

test('complete direction routing compiles all providers, runner APIs, roles and tool switches', async () => {
  const fixture = routingFixture()
  const result = compileRoutingProfiles(fixture.primary, fixture.options)
  if (!result.ok) throw new Error(result.error.message)
  const { compiled } = result
  const snapshot = JSON.stringify(compiled, null, 2) + '\n'
  expect(snapshot).toBe(
    JSON.stringify(
      await Bun.file(
        path.join(import.meta.dir, 'fixtures/routing-all.json'),
      ).json(),
      null,
      2,
    ) + '\n',
  )
  const missing = compileRoutingProfiles(fixture.primary, {
    ...fixture.options,
    profiles: [],
  })
  expect(missing.ok).toBe(false)
})
test('without routing the complete serialized result matches the pre-P22 compiler bytes', async () => {
  const result = compileRoutingProfiles(wireProfile(), {
    secret: CANARY_KEY,
    capabilities,
  })
  expect(JSON.stringify(result, null, 2) + '\n').toBe(
    JSON.stringify(
      await Bun.file(
        path.join(import.meta.dir, 'fixtures/routing-legacy.json'),
      ).json(),
      null,
      2,
    ) + '\n',
  )
})
for (const lane of (Object.keys(LANE_API) as (keyof typeof LANE_API)[]).filter(
  l => LANE_KINDS[l] !== 'chat',
))
  test(`omp loader accepts compiled ${lane} kind/API`, async () => {
    const root = isolatedRoot()
    const store = new SqliteAuthCredentialStore(new Database(':memory:'))
    try {
      const result = compileProfile(mediaProfile(lane), {
        secret: CANARY_KEY,
        capabilities,
        auxiliary: true,
      })
      if (!result.ok) throw new Error(result.error.message)
      writePrivateJson(
        path.join(root.root, 'models.yml'),
        result.compiled.models,
      )
      const registry = new ModelRegistry(
        new AuthStorage(store),
        path.join(root.root, 'models.yml'),
      )
      expect(registry.getError()).toBeUndefined()
      const m = registry.find(
        result.compiled.providerId,
        mediaProfile(lane).models[0]!.id,
      )
      expect(m?.kind).toBe(
        LANE_KINDS[lane] === 'speech' ? 'tts' : LANE_KINDS[lane],
      )
      expect(m?.api).toBe(LANE_API[lane])
    } finally {
      store.close()
      root.dispose()
    }
  })
test('multi-profile commit writes all models/roles/credentials, preserves unrelated sections and removes media routes on legacy apply', async () => {
  const root = isolatedRoot()
  try {
    const f = routingFixture()
    writePrivateJson(providerPaths.config(), {
      generate_image: { custom: 'preserve' },
      speechgen: { voice: 'preserve' },
      other: 42,
    })
    const staged = stageProviderApply(
      applyRequest({
        profile: f.primary,
        profiles: f.profiles,
        routing: f.routing,
      }),
    )
    expect(staged.ok).toBe(true)
    const committed = await commitPendingProviderConfig()
    expect(committed.status).toBe('committed')
    const config = readYaml(providerPaths.config())
    expect(config.generate_image).toEqual({ custom: 'preserve', enabled: true })
    expect(config.speechgen).toEqual({ voice: 'preserve', enabled: true })
    expect(config.other).toBe(42)
    const providers = readYaml(providerPaths.models()).providers as Record<
      string,
      unknown
    >
    expect(Object.keys(providers)).toHaveLength(5)
    expect(nodeModelSelection('chat')?.provider).toStartWith('qm-chat-')
    const store = await SqliteAuthCredentialStore.open(providerPaths.auth())
    try {
      expect(new Set(store.listAuthCredentials().map(c => c.provider))).toEqual(
        new Set(Object.keys(providers)),
      )
    } finally {
      store.close()
    }
    const again = stageProviderApply(
      applyRequest({
        profile: f.primary,
        expect: { ownedHash: currentManagedHash() },
      }),
    )
    expect(again.ok).toBe(true)
    expect((await commitPendingProviderConfig()).status).toBe('committed')
    expect(
      Object.keys(readYaml(providerPaths.models()).providers as object),
    ).toHaveLength(1)
    expect(readYaml(providerPaths.config()).qianmoRouting).toBeUndefined()
    expect(readYaml(providerPaths.config()).generate_image).toEqual({
      custom: 'preserve',
    })
  } finally {
    root.dispose()
  }
})

test('a routed thinking extra obeys the shared lock even when the profile main is nonreasoning', () => {
  const profile = wireProfile({
    effortLock: 'max',
    models: [
      {
        id: 'plain-main',
        role: 'main',
        tiers: ['sonnet'],
        capabilities: {
          mode: 'explicit',
          thinking: false,
          adaptive_thinking: false,
          interleaved_thinking: false,
        },
        effort: { send: 'never' },
      },
      {
        id: 'thinking-extra',
        role: 'extra',
        tiers: [],
        capabilities: {
          mode: 'explicit',
          thinking: true,
          adaptive_thinking: false,
          interleaved_thinking: false,
        },
        effort: { send: 'always', levels: ['low', 'high'], level: 'low' },
      },
    ],
  })
  const result = compileRoutingProfiles(profile, {
    secret: CANARY_KEY,
    capabilities,
    routing: {
      auto: true,
      routes: { chat: { profileId: profile.id, modelId: 'thinking-extra' } },
    },
  })
  if (!result.ok) throw new Error(result.error.message)
  expect(result.compiled.config.modelRoles.chat).toEndWith(
    '/thinking-extra:high',
  )
  expect(result.compiled.config.modelRoles.default).toEndWith('/plain-main:off')
})
