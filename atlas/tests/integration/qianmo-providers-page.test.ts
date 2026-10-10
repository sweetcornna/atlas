// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { providerConsole, draft, NODE } from './fixtures/provider-console.js'
import { fakeOpenAI } from '../../packages/node/test/providers/fake.js'
const KEY = 'sk-test-page-canary-private'
test('authenticated page → hub executor → real node CLI → omp request, drift refusal and export redaction', async () => {
  const f = await providerConsole()
  const fake = fakeOpenAI()
  try {
    const created = await f.call<{ profile: { id: string; revision: number } }>(
      'POST',
      '/v0/providers/profiles',
      {
        presetId: 'custom-openai',
        profile: draft(fake.baseUrl),
        secrets: { k1: KEY },
      },
    )
    expect(created.profile).toMatchObject({ id: 'local-chat', revision: 1 })
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
    expect((await f.turn('PAGE-MARKER')).outcome).toBe('completed')
    expect(fake.requests[0]?.body.model).toBe('page-test-model')
    expect(fake.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    f.later()
    const refreshed = await f.call<{
      node: { actual: { effective: { model: string; wire: string } } }
    }>('POST', `/v0/providers/nodes/${NODE}/refresh`)
    expect(refreshed.node.actual.effective).toMatchObject({
      model: 'page-test-model',
      wire: 'openai-completions',
    })
    const board = await f.call<string>('GET', '/fragments/providers/board')
    expect(board).toContain('page-test-model')
    expect(board).not.toContain(KEY)
    const path = join(f.root, 'omp', 'agent', 'models.yml')
    const models = JSON.parse(readFileSync(path, 'utf8')) as {
      providers: Record<string, { baseUrl: string }>
    }
    Object.values(models.providers)[0]!.baseUrl =
      'https://local-edit.invalid/v1'
    writeFileSync(path, JSON.stringify(models), { mode: 0o600 })
    f.later()
    await f.call('POST', `/v0/providers/nodes/${NODE}/refresh`)
    expect(await f.call<string>('GET', '/fragments/providers/board')).toContain(
      '本地改动',
    )
    const conflict = await f.call<{
      results: { outcome: string; code: string; diffKeys: string[] }[]
    }>('POST', '/v0/providers/apply', { nodes: [NODE] })
    expect(conflict.results[0]).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
    })
    expect(
      conflict.results[0]?.diffKeys.some(k => k.endsWith('.baseUrl')),
    ).toBe(true)
    const exported = await f.handle(f.req('GET', '/v0/providers/export'))
    const text = await exported.text()
    expect(text).toContain('local-chat')
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('fingerprint')
    const doc = JSON.parse(text)
    doc.profiles[0].apiKey = 'never-import-plaintext'
    expect(
      (
        await f.handle(
          f.req('POST', '/v0/providers/import/preview', {
            text: JSON.stringify(doc),
          }),
        )
      ).status,
    ).toBe(400)
    expect(JSON.stringify(await f.ledger.list({ limit: 100 }))).not.toContain(
      KEY,
    )
  } finally {
    fake.stop()
    await f.dispose()
  }
}, 45000)
