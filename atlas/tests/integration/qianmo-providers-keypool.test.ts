// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteAuthCredentialStore } from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { providerConsole, draft, NODE } from './fixtures/provider-console.js'
import { chatStream } from './fixtures/provider-runtime.js'
const KEYS = ['sk-test-native-pool-first', 'sk-test-native-pool-second']
test('page delivers both native credentials; rate limit rotates the actual request and status names only ids', async () => {
  const f = await providerConsole()
  const seen: string[] = []
  let blocked: string | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return Response.json({ data: [] })
      const body = (await req.json()) as Record<string, unknown>
      const auth = req.headers.get('authorization') ?? ''
      seen.push(auth)
      blocked ??= auth
      if (auth === blocked)
        return Response.json(
          {
            error: {
              message: 'You exceeded your current quota',
              type: 'insufficient_quota',
              code: 'insufficient_quota',
            },
          },
          { status: 429, headers: { 'retry-after': '1' } },
        )
      return chatStream(body.model, { content: 'rotated OK' })
    },
  })
  try {
    await f.call('POST', '/v0/providers/profiles', {
      presetId: 'custom-openai',
      profile: draft(`http://127.0.0.1:${server.port}/v1`, 2),
      secrets: { k1: KEYS[0], k2: KEYS[1] },
    })
    await f.call('PUT', `/v0/providers/nodes/${NODE}/assignment`, {
      mode: 'profile',
      profileId: 'local-chat',
    })
    await f.call('POST', `/v0/providers/nodes/${NODE}/refresh`)
    const applied = await f.call<{ results: { outcome: string }[] }>(
      'POST',
      '/v0/providers/apply',
      { nodes: [NODE] },
    )
    expect(applied.results[0]?.outcome).toBe('ok')
    const db = join(f.root, 'omp', 'agent', 'agent.db')
    expect(statSync(db).mode & 0o777).toBe(0o600)
    const store = await SqliteAuthCredentialStore.open(db)
    try {
      expect(
        store
          .listAuthCredentials()
          .map(r => (r.credential.type === 'api_key' ? r.credential.key : ''))
          .sort(),
      ).toEqual([...KEYS].sort())
    } finally {
      store.close()
    }
    expect(
      readFileSync(join(f.root, 'omp', 'agent', 'models.yml'), 'utf8'),
    ).not.toContain(KEYS[0]!)
    const result = await f.turn('POOL-MARKER')
    expect(result.outcome).toBe('completed')
    expect(new Set(seen).size).toBe(2)
    expect(seen.at(-1)).not.toBe(blocked)
    f.later()
    const view = await f.call<{
      node: { actual: { keys: { id: string; state: string }[] } }
    }>('POST', `/v0/providers/nodes/${NODE}/refresh`)
    expect(view.node.actual.keys.map(k => k.id)).toEqual(['k1', 'k2'])
    const board = await f.call<string>('GET', '/fragments/providers/board')
    for (const key of KEYS) {
      expect(JSON.stringify(view)).not.toContain(key)
      expect(board).not.toContain(key)
      expect(JSON.stringify(await f.ledger.list({ limit: 100 }))).not.toContain(
        key,
      )
      expect(
        readFileSync(join(f.root, 'qianmo', 'provider', 'pool.json'), 'utf8'),
      ).not.toContain(key)
    }
  } finally {
    server.stop(true)
    await f.dispose()
  }
}, 45000)
