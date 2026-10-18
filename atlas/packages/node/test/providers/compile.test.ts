// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { parseModelPattern } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import {
  AuthStorage,
  SqliteAuthCredentialStore,
} from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { LANE_KINDS, PRESETS } from '@qianmo/providers'
import { compileProfile, LANE_API } from '../../src/providers/compile.js'
import { getModelCompatCapabilities } from '../../src/providers/capabilities.js'
import {
  nodeMainModelSpec,
  runtimeModelCredential,
} from '../../src/providers/node.js'
import {
  ensurePrivateDir,
  providerPaths,
  writePrivateJson,
} from '../../src/providers/store.js'
import { wireProfile, presetProfile, CANARY_KEY } from './helpers.js'
import { isolatedRoot } from './fake.js'
const capabilities = { protocol: 1 as const, ...getModelCompatCapabilities() }
describe('omp compiler', () => {
  for (const lane of (
    Object.keys(LANE_API) as (keyof typeof LANE_API)[]
  ).filter(lane => LANE_KINDS[lane] === 'chat'))
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
  // P33: a magpie gateway names models `provider/model` (with more slashes
  // for a relay's) and routing groups `group/<id>`; omp must load them as
  // literal ids and resolve `<provider>/<id>:<level>` selectors to them.
  for (const [lane, baseUrl] of [
    ['anthropic', 'https://gateway.example.test'],
    ['openai-chat', 'https://gateway.example.test/v1'],
    ['openai-responses', 'https://gateway.example.test/v1'],
  ] as const)
    test(`magpie ids with slashes load and resolve on ${lane}`, async () => {
      const fixture = isolatedRoot()
      const store = new SqliteAuthCredentialStore(new Database(':memory:'))
      try {
        const ids = ['openrouter/anthropic/claude-sonnet-5', 'group/fast']
        const profile = wireProfile(
          {
            id: 'magpie-node-n1',
            lane,
            baseUrl,
            auth: { scheme: 'bearer', keys: [{ id: 'gw', value: CANARY_KEY }] },
            compat: lane === 'anthropic' ? { disableStrictTools: 'true' } : {},
            models: [
              {
                id: ids[0] as string,
                role: 'main',
                tiers: ['opus', 'sonnet', 'fable'],
                capabilities: { mode: 'family' },
                effort: { send: 'auto' },
              },
              {
                id: ids[1] as string,
                role: 'fast',
                tiers: ['haiku'],
                capabilities: { mode: 'family' },
                effort: { send: 'auto' },
              },
            ],
          },
          capabilities,
        )
        const result = compileProfile(profile, {
          secret: CANARY_KEY,
          capabilities,
        })
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
        for (const id of ids) {
          expect(registry.find(compiled.providerId, id)?.id).toBe(id)
          const resolved = parseModelPattern(
            `${compiled.providerId}/${id}:high`,
            registry.getAll(),
          )
          expect(resolved.model?.id).toBe(id)
          expect(resolved.model?.provider).toBe(compiled.providerId)
        }
        const selector = settings.getModelRole('default')
        expect(selector).toBe(`${compiled.providerId}/${ids[0]}:medium`)
        expect(
          parseModelPattern(selector as string, registry.getAll()).model?.id,
        ).toBe(ids[0])
      } finally {
        store.close()
        fixture.dispose()
      }
    })
  // P33: magpie answers every lane on one port; the profile's other lanes
  // become sibling providers with the same key, so Claude Code and Codex find
  // the protocol they speak while omp keeps the main lane.
  test('lane addresses compile to sibling providers each runtime picks', async () => {
    const fixture = isolatedRoot()
    const store = new SqliteAuthCredentialStore(new Database(':memory:'))
    try {
      const lanes = {
        anthropic: 'https://gateway.example.test',
        'openai-responses': 'https://gateway.example.test/v1',
      }
      const profile = wireProfile(
        {
          id: 'magpie-node-n1',
          lane: 'openai-chat',
          baseUrl: 'https://gateway.example.test/v1',
          laneAddresses: lanes,
          auth: { scheme: 'bearer', keys: [{ id: 'gw', value: CANARY_KEY }] },
          compat: {},
          models: [
            {
              id: 'api2/gpt-6-luna',
              role: 'main',
              tiers: ['opus', 'sonnet', 'haiku', 'fable'],
              capabilities: { mode: 'family' },
              effort: { send: 'auto' },
            },
          ],
        },
        capabilities,
      )
      const result = compileProfile(profile, {
        secret: CANARY_KEY,
        capabilities,
      })
      if (!result.ok) throw new Error(result.error.message)
      const { compiled } = result
      const ids = Object.keys(compiled.models.providers)
      expect(ids[0]).toBe(compiled.providerId)
      expect(ids).toHaveLength(3)
      expect(new Set(ids).size).toBe(3)
      for (const id of ids)
        expect(id).toMatch(/^qm-magpie-node-n1-[0-9a-f]{8}$/)
      const byApi = Object.fromEntries(
        Object.entries(compiled.models.providers).map(([id, p]) => [p.api, id]),
      )
      expect(Object.keys(byApi).sort()).toEqual([
        'anthropic-messages',
        'openai-completions',
        'openai-responses',
      ])
      for (const p of Object.values(compiled.models.providers)) {
        expect(p.apiKey).toBe(CANARY_KEY)
        expect(p.models.map(m => m.id)).toEqual(['api2/gpt-6-luna'])
      }
      expect(
        compiled.models.providers[byApi['anthropic-messages']!]?.baseUrl,
      ).toBe(lanes.anthropic)
      expect(compiled.config.modelRoles.default).toStartWith(
        `${compiled.providerId}/`,
      )
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
      for (const [api, id] of Object.entries(byApi))
        expect(registry.find(id, 'api2/gpt-6-luna')?.api).toBe(api as never)
      ensurePrivateDir(join(providerPaths.models(), '..'))
      writePrivateJson(providerPaths.models(), compiled.models)
      const claude = runtimeModelCredential(
        'magpie-node-n1/api2/gpt-6-luna',
        'claude-code',
      )
      expect(claude).toMatchObject({
        model: 'api2/gpt-6-luna',
        baseUrl: lanes.anthropic,
        apiKey: CANARY_KEY,
      })
      expect(
        runtimeModelCredential('magpie-node-n1/api2/gpt-6-luna', 'codex')
          .baseUrl,
      ).toBe(lanes['openai-responses'])
      // An agent with no model of its own takes the node's main one (P36
      // §3.2), on the first lane its runtime speaks: Chat for dsh.
      writePrivateJson(providerPaths.config(), compiled.config)
      expect(nodeMainModelSpec()).toBe('magpie-node-n1/api2/gpt-6-luna')
      expect(runtimeModelCredential(nodeMainModelSpec()!, 'dsh')).toMatchObject(
        { lane: 'openai-chat', model: 'api2/gpt-6-luna' },
      )
    } finally {
      store.close()
      fixture.dispose()
    }
  })
  // P36.5: a Gemini runtime in the catalog adds magpie's Gemini lane, at
  // `/v1beta` as Google's API base, to the same key.
  test('a Gemini lane address compiles to a Gemini sibling on the same key', () => {
    const result = compileProfile(
      wireProfile(
        {
          id: 'magpie-node-n1',
          lane: 'anthropic',
          baseUrl: 'https://gateway.example.test',
          laneAddresses: {
            'openai-chat': 'https://gateway.example.test/v1',
            gemini: 'https://gateway.example.test/v1beta',
          },
          auth: { scheme: 'bearer', keys: [{ id: 'gw', value: CANARY_KEY }] },
          compat: {},
          // What the hub writes into every magpie profile (`consoleMagpie.ts`).
          models: [
            {
              id: 'google/gemini-3.1-pro',
              role: 'main',
              tiers: ['opus', 'sonnet', 'haiku', 'fable'],
              capabilities: { mode: 'family' },
              effort: { send: 'auto' },
            },
          ],
        },
        capabilities,
      ),
      { secret: CANARY_KEY, capabilities },
    )
    if (!result.ok) throw new Error(result.error.message)
    const gemini = Object.values(result.compiled.models.providers).find(
      provider => provider.api === 'google-generative-ai',
    )
    expect(gemini?.baseUrl).toBe('https://gateway.example.test/v1beta')
    expect(gemini?.apiKey).toBe(CANARY_KEY)
    expect(Object.keys(result.compiled.models.providers)).toHaveLength(3)
  })

  test('lane addresses ride a single key only; without them a runtime is told the lane', () => {
    const several = compileProfile(
      wireProfile(
        {
          lane: 'openai-chat',
          baseUrl: 'https://gateway.example.test/v1',
          compat: {},
          laneAddresses: { anthropic: 'https://gateway.example.test' },
          auth: {
            scheme: 'bearer',
            keys: [
              { id: 'a', value: CANARY_KEY },
              { id: 'b', value: `${CANARY_KEY}-2` },
            ],
          },
        },
        capabilities,
      ),
      { secret: CANARY_KEY, capabilities },
    )
    expect(several.ok ? 'ok' : several.error.path).toBe('profile.laneAddresses')
    const fixture = isolatedRoot()
    try {
      const single = compileProfile(
        wireProfile(
          {
            id: 'plain',
            lane: 'openai-chat',
            baseUrl: 'https://gateway.example.test/v1',
            compat: {},
          },
          capabilities,
        ),
        { secret: CANARY_KEY, capabilities },
      )
      if (!single.ok) throw new Error(single.error.message)
      expect(Object.keys(single.compiled.models.providers)).toHaveLength(1)
      ensurePrivateDir(join(providerPaths.models(), '..'))
      writePrivateJson(providerPaths.models(), single.compiled.models)
      expect(() =>
        runtimeModelCredential('plain/vendor-model-pro', 'claude-code'),
      ).toThrow('claude-code needs a anthropic-messages profile')
    } finally {
      fixture.dispose()
    }
  })
  test('a profile whose id begins with qm- is still found by its id, and by its provider id', () => {
    const fixture = isolatedRoot()
    try {
      const result = compileProfile(
        wireProfile(
          {
            id: 'qm-prod',
            lane: 'openai-chat',
            baseUrl: 'https://gateway.example.test/v1',
            compat: {},
          },
          capabilities,
        ),
        { secret: CANARY_KEY, capabilities },
      )
      if (!result.ok) throw new Error(result.error.message)
      const provider = result.compiled.providerId
      expect(provider).toMatch(/^qm-qm-prod-[0-9a-f]{8}$/)
      ensurePrivateDir(join(providerPaths.models(), '..'))
      writePrivateJson(providerPaths.models(), result.compiled.models)
      writePrivateJson(providerPaths.config(), result.compiled.config)
      const main = nodeMainModelSpec()!
      expect(main.startsWith('qm-prod/')).toBe(true)
      expect(runtimeModelCredential(main, 'dsh')).toMatchObject({
        lane: 'openai-chat',
        baseUrl: 'https://gateway.example.test/v1',
      })
      expect(
        runtimeModelCredential(`${provider}/vendor-model-pro`, 'dsh').lane,
      ).toBe('openai-chat')
    } finally {
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
        auxiliary: LANE_KINDS[preset.lane] !== 'chat',
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
