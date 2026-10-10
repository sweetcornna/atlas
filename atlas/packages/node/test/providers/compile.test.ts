// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import {
  AuthStorage,
  SqliteAuthCredentialStore,
} from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { PRESETS } from '@qianmo/providers'
import { compileProfile, LANE_API } from '../../src/providers/compile.js'
import { getModelCompatCapabilities } from '../../src/providers/capabilities.js'
import { writePrivateJson } from '../../src/providers/store.js'
import { wireProfile, presetProfile, CANARY_KEY } from './helpers.js'
import { isolatedRoot } from './fake.js'
const capabilities = { protocol: 1 as const, ...getModelCompatCapabilities() }
describe('omp compiler', () => {
  for (const lane of Object.keys(LANE_API) as (keyof typeof LANE_API)[])
    test(`loads ${lane} with omp public loaders`, async () => {
      const fixture = isolatedRoot()
      const store = new SqliteAuthCredentialStore(new Database(':memory:'))
      try {
        const profile = wireProfile(
          {
            lane,
            auth: { scheme: 'bearer', keys: [{ id: 'k1', value: CANARY_KEY }] },
            compat: {},
            models: [
              {
                id: 'vendor-model-pro',
                role: 'main',
                tiers: ['sonnet'],
                capabilities: { mode: 'family' },
                effort: { send: 'auto' },
                contextTokens: 128000,
                maxOutputTokens: 4096,
              },
            ],
          },
          capabilities,
        )
        const result = compileProfile(profile, {
          secret: CANARY_KEY,
          capabilities,
        })
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error(result.error.message)
        const { compiled } = result
        writePrivateJson(join(fixture.root, 'models.yml'), compiled.models)
        writePrivateJson(join(fixture.root, 'config.yml'), compiled.config)
        const settings = await Settings.loadReadOnly({
          agentDir: fixture.root,
          cwd: fixture.root,
        })
        const registry = new ModelRegistry(
          new AuthStorage(store),
          join(fixture.root, 'models.yml'),
          { settings },
        )
        expect(registry.getError()).toBeUndefined()
        const model = registry.find(compiled.providerId, 'vendor-model-pro')
        expect(model?.api).toBe(LANE_API[lane])
        expect(model?.contextWindow).toBe(128000)
        expect(model?.maxTokens).toBe(4096)
        expect(
          compiled.models.providers[compiled.providerId]?.models[0]?.compat
            .statefulResponses,
        ).toBe(false)
        if (lane === 'openai-responses')
          expect(
            (model?.compat as Record<string, unknown>).statefulResponses,
          ).toBe(false)
        expect(settings.getModelRole('default')).toBe(
          `${compiled.providerId}/vendor-model-pro:medium`,
        )
        expect(compiled.config.providers.cacheWarming).toBe('off')
        expect(compiled.config.retry.fallbackChains).toEqual({})
      } finally {
        store.close()
        fixture.dispose()
      }
    })
  test('URL changes create a different provider identity; model ids stay literal', () => {
    const a = compileProfile(wireProfile(), {
      secret: CANARY_KEY,
      capabilities,
    })
    const b = compileProfile(
      wireProfile({ baseUrl: 'https://other.example/v1' }),
      { secret: CANARY_KEY, capabilities },
    )
    if (!a.ok || !b.ok) throw new Error('compile failed')
    expect(a.compiled.providerId).not.toBe(b.compiled.providerId)
    expect(
      a.compiled.models.providers[a.compiled.providerId]?.models[0]?.id,
    ).toBe('vendor-model-pro')
  })
  test('all presets compile and their old evaluation claims remain reset', () => {
    for (const preset of PRESETS) {
      const result = compileProfile(presetProfile(preset), {
        secret: CANARY_KEY,
        capabilities,
      })
      expect(result.ok).toBe(true)
      expect(preset.evaluated).toBe(false)
    }
  })
  test('effort never is explicit nonreasoning and off; hostile compat is refused', () => {
    const profile = wireProfile({
      models: [
        {
          id: 'plain',
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
      ],
    })
    const result = compileProfile(profile, { secret: CANARY_KEY, capabilities })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.compiled.selection.thinkingLevel).toBe('off')
    expect(
      result.compiled.models.providers[result.compiled.providerId]?.models[0]
        ?.reasoning,
    ).toBe(false)
    expect(
      compileProfile(
        { ...profile, compat: { PATH: '/evil' } },
        { secret: CANARY_KEY, capabilities },
      ).ok,
    ).toBe(false)
  })
})

test('family auto delegates reasoning to the native catalog, unknown models stay nonreasoning', async () => {
  const f = isolatedRoot()
  const store = new SqliteAuthCredentialStore(new Database(':memory:'))
  try {
    const p = wireProfile(
      {
        lane: 'openai-chat',
        compat: {},
        models: [
          {
            id: 'unknown-fake',
            role: 'main',
            tiers: ['sonnet'],
            capabilities: { mode: 'family' },
            effort: { send: 'auto' },
          },
        ],
      },
      capabilities,
    )
    const r = compileProfile(p, { secret: CANARY_KEY, capabilities })
    if (!r.ok) throw new Error(r.error.message)
    writePrivateJson(join(f.root, 'models.yml'), r.compiled.models)
    const registry = new ModelRegistry(
      new AuthStorage(store),
      join(f.root, 'models.yml'),
    )
    expect(registry.getError()).toBeUndefined()
    expect(
      registry.find(r.compiled.providerId, 'unknown-fake')?.reasoning,
    ).toBe(false)
  } finally {
    store.close()
    f.dispose()
  }
})
