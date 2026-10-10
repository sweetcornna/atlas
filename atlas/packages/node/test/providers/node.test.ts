// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import {
  AuthStorage,
  SqliteAuthCredentialStore,
} from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { secretFingerprint } from '@qianmo/providers'
import {
  stageProviderApply,
  commitPendingProviderConfig,
  readProviderState,
  nodeModelSelection,
  readYaml,
  currentManagedHash,
  recordProviderGeneration,
} from '../../src/providers/node.js'
import {
  providerPaths,
  writePrivateJson,
  acquireApplyLock,
} from '../../src/providers/store.js'
import { applyRequest, CANARY_KEY, CANARY_KEY_2 } from './helpers.js'
import { isolatedRoot } from './fake.js'
let fixture: ReturnType<typeof isolatedRoot>
beforeEach(() => {
  fixture = isolatedRoot()
})
afterEach(() => fixture.dispose())
async function apply(overrides: Parameters<typeof applyRequest>[0] = {}) {
  const request = applyRequest(overrides)
  expect(stageProviderApply(request).ok).toBe(true)
  expect((await commitPendingProviderConfig()).status).toBe('committed')
  return request
}
describe('two-phase omp configuration', () => {
  test('stage changes no active files; commit writes private YAML and selection; idempotent request', async () => {
    const req = applyRequest()
    const staged = stageProviderApply(req)
    expect(staged.ok).toBe(true)
    expect(existsSync(providerPaths.models())).toBe(false)
    expect(readProviderState().pending?.requestId).toBe(req.requestId)
    expect(stageProviderApply(req)).toMatchObject({
      ok: true,
      duplicate: 'pending',
    })
    expect((await commitPendingProviderConfig()).status).toBe('committed')
    expect(stageProviderApply(req)).toMatchObject({
      ok: true,
      duplicate: 'applied',
    })
    expect(nodeModelSelection()).toMatchObject({
      modelId: 'vendor-model-pro',
      thinkingLevel: 'max',
    })
    for (const path of [
      providerPaths.models(),
      providerPaths.config(),
      providerPaths.auth(),
      providerPaths.state(),
    ])
      expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(readProviderState())).not.toContain(CANARY_KEY)
    expect(readProviderState().onDiskHash).toBe(
      readProviderState().appliedHash!,
    )
  })
  test('dry run writes nothing', () => {
    expect(stageProviderApply(applyRequest({ dryRun: true }))).toMatchObject({
      ok: true,
      pending: false,
      dryRun: true,
    })
    expect(existsSync(providerPaths.pending())).toBe(false)
    expect(existsSync(providerPaths.firstWrite())).toBe(false)
  })
  test('conflicts compare owned keys while unrelated settings survive', async () => {
    writePrivateJson(providerPaths.config(), {
      theme: 'dark',
      compaction: { thresholdTokens: 120000 },
    })
    const req = await apply()
    const hash = currentManagedHash()
    const settings = readYaml(providerPaths.config())
    settings.theme = 'light'
    writePrivateJson(providerPaths.config(), settings)
    expect(currentManagedHash()).toBe(hash)
    expect(
      stageProviderApply(applyRequest({ expect: { ownedHash: hash } })).ok,
    ).toBe(true)
    settings.defaultThinkingLevel = 'low'
    writePrivateJson(providerPaths.config(), settings)
    expect((await commitPendingProviderConfig()).status).toBe('conflict')
    expect(readProviderState().applied?.requestId).toBe(req.requestId)
    expect(readYaml(providerPaths.config()).compaction).toEqual({
      thresholdTokens: 120000,
    })
  })
  test('first backup is immutable; keep resolves fingerprint without leaking it', async () => {
    await apply()
    const backup = readFileSync(providerPaths.firstWrite(), 'utf8')
    await apply({
      expect: { ownedHash: currentManagedHash() },
      profile: {
        auth: {
          scheme: 'bearer',
          keys: [{ id: 'k1', keep: secretFingerprint(CANARY_KEY) }],
        },
      },
    })
    expect(readFileSync(providerPaths.firstWrite(), 'utf8')).toBe(backup)
    expect(
      stageProviderApply(
        applyRequest({
          force: true,
          profile: {
            auth: {
              scheme: 'bearer',
              keys: [{ id: 'k1', keep: secretFingerprint('unknown-key') }],
            },
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: 'secret-mismatch' })
  })
  test('recovers interrupted two-file commit and records generation', async () => {
    const req = applyRequest()
    expect(stageProviderApply(req).ok).toBe(true)
    const pending = JSON.parse(readFileSync(providerPaths.pending(), 'utf8'))
    writePrivateJson(providerPaths.models(), pending.compiled.models)
    expect(await commitPendingProviderConfig()).toMatchObject({
      status: 'committed',
      recovered: true,
    })
    recordProviderGeneration({
      generation: 7,
      env: { OPENAI_API_KEY: 'ambient' },
    })
    expect(readProviderState()).toMatchObject({
      loadedHash: currentManagedHash(),
      inheritedProviderKeys: ['OPENAI_API_KEY'],
    })
  })
  test('lock, nonprivate root, corrupt journal fail closed', async () => {
    const lock = acquireApplyLock()
    expect(lock).not.toBeNull()
    try {
      expect(stageProviderApply(applyRequest())).toMatchObject({
        ok: false,
        code: 'busy',
      })
    } finally {
      lock?.release()
    }
    expect(stageProviderApply(applyRequest()).ok).toBe(true)
    chmodSync(fixture.root, 0o755)
    expect((await commitPendingProviderConfig()).status).toBe('refused')
    chmodSync(fixture.root, 0o700)
    writePrivateJson(providerPaths.pending(), { v: 2, bad: true })
    expect((await commitPendingProviderConfig()).status).toBe('bad-pending')
  })
  test('rejects a journal whose compiled content differs from its validated request', async () => {
    await apply()
    const activeModels = readFileSync(providerPaths.models(), 'utf8')
    const activeConfig = readFileSync(providerPaths.config(), 'utf8')
    expect(stageProviderApply(applyRequest({ force: true })).ok).toBe(true)
    const pending = JSON.parse(readFileSync(providerPaths.pending(), 'utf8'))
    pending.compiled.config.shellPath = '/unexpected-executable'
    writePrivateJson(providerPaths.pending(), pending)
    const result = await commitPendingProviderConfig()
    expect(result.status).toBe('bad-pending')
    expect(readFileSync(providerPaths.models(), 'utf8')).toBe(activeModels)
    expect(readFileSync(providerPaths.config(), 'utf8')).toBe(activeConfig)
    if (result.status !== 'bad-pending') throw new Error('expected bad-pending')
    expect(readFileSync(result.movedTo, 'utf8')).toContain(
      '/unexpected-executable',
    )
    expect(statSync(result.movedTo).mode & 0o777).toBe(0o600)
  })
  test('native credential pool survives reopen, keep, health and switching to one key', async () => {
    await apply({
      profile: {
        lane: 'openai-chat',
        compat: {},
        auth: {
          scheme: 'bearer',
          keys: [
            { id: 'a', value: CANARY_KEY },
            { id: 'b', value: CANARY_KEY_2 },
          ],
        },
      },
    })
    const selected = nodeModelSelection()!
    const store = await SqliteAuthCredentialStore.open(providerPaths.auth())
    try {
      const auth = new AuthStorage(store)
      await auth.credentials.reload()
      expect(auth.credentials.list(selected.provider)).toHaveLength(2)
      const row = store.listAuthCredentials(selected.provider)[0]!
      store.upsertCredentialBlock({
        credentialId: row.id,
        providerKey: `${selected.provider}:api_key`,
        blockScope: '',
        blockedUntilMs: Date.now() + 60000,
      })
      expect(readProviderState().keys?.[0]?.state).toBe('cooling')
      expect(readFileSync(providerPaths.models(), 'utf8')).not.toContain(
        CANARY_KEY,
      )
      expect(readFileSync(providerPaths.pool(), 'utf8')).not.toContain(
        CANARY_KEY,
      )
    } finally {
      store.close()
    }
    await apply({ force: true })
    expect(readProviderState().keys).toBeUndefined()
    const reopened = new SqliteAuthCredentialStore(
      new Database(providerPaths.auth()),
    )
    try {
      expect(reopened.listAuthCredentials(selected.provider)).toHaveLength(0)
    } finally {
      reopened.close()
    }
  })
})
