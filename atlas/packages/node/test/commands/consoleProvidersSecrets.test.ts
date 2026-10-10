// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 中枢密文库与主密钥（P18.6，`providers-console-m1.md` §3.7、§3.8）：真文件、真
 * 权限位、真 AES-GCM。零 `mock.module`。
 *
 * 钉的是 §9.2 P18.6 那一格里的五条：密文库 0600、目录 0700；主密钥权限过宽时拒绝；
 * 轮换之后旧密文从文件里消失（字节扫描）；主密钥缺失而密文存在时 fail-closed、
 * 不重新生成。每条都带正向对照。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderSecretStore } from '../../src/commands/consoleProvidersSecrets.js'

const CANARY = 'sk-test-canary-secrets-Zq81LmN0pW4xR7tY'
const ROTATED = 'sk-test-canary-rotated-Hd02KsP9vQ3mZ6uE'
const REF = { profileId: 'vendor-paygo', keyId: 'k1' }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function layout() {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-provider-secrets-'))
  roots.push(root)
  const consoleDir = join(root, 'config', 'qianmo', 'console')
  const keyDir = join(root, 'secrets')
  return {
    root,
    consoleDir,
    keyDir,
    paths: {
      secretsPath: join(consoleDir, 'provider-secrets.json'),
      keyPath: join(keyDir, 'provider-master.key'),
    },
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('the secret store on disk', () => {
  test('the store is 0600 in a 0700 directory, and so is the generated master key', () => {
    const { paths, consoleDir, keyDir } = layout()
    const store = new ProviderSecretStore(paths)
    expect(store.problem).toBeNull()
    store.commit(REF.profileId, 1, ['k1'], { k1: CANARY })
    expect(mode(paths.secretsPath)).toBe(0o600)
    expect(mode(consoleDir)).toBe(0o700)
    expect(mode(paths.keyPath)).toBe(0o600)
    expect(mode(keyDir)).toBe(0o700)
    expect(readFileSync(paths.keyPath, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
    // No tmp file left next to it.
    expect(readdirSync(consoleDir)).toEqual(['provider-secrets.json'])
  })

  test('the plain value is never in the store file, and reveal gives it back', () => {
    const { paths } = layout()
    const store = new ProviderSecretStore(paths)
    const fp = store.commit(REF.profileId, 1, ['k1'], { k1: CANARY }).k1
    expect(readFileSync(paths.secretsPath, 'utf8')).not.toContain(CANARY)
    expect(readFileSync(paths.secretsPath).includes(Buffer.from(CANARY))).toBe(
      false,
    )
    const reopened = new ProviderSecretStore(paths)
    expect(reopened.problem).toBeNull()
    expect(reopened.reveal(REF)).toBe(CANARY)
    expect(reopened.fingerprint(REF)).toBe(fp ?? '')
  })

  test('after a rotation the old ciphertext is gone from the file, byte for byte', () => {
    const { paths, consoleDir } = layout()
    const store = new ProviderSecretStore(paths)
    store.commit(REF.profileId, 1, ['k1'], { k1: CANARY })
    const before = JSON.parse(readFileSync(paths.secretsPath, 'utf8')) as {
      entries: Record<string, Record<string, string>>
    }
    const old = before.entries['vendor-paygo:k1']
    expect(old).toBeDefined()
    const oldPieces = [old?.ct, old?.iv, old?.tag, old?.wrappedKey].filter(
      (piece): piece is string => typeof piece === 'string',
    )
    expect(oldPieces).toHaveLength(4)
    // Positive control: the scan finds them while they are there.
    const bytesBefore = readFileSync(paths.secretsPath)
    for (const piece of oldPieces) {
      expect(bytesBefore.includes(Buffer.from(piece))).toBe(true)
    }

    store.commit(REF.profileId, 2, ['k1'], { k1: ROTATED })
    const bytesAfter = readFileSync(paths.secretsPath)
    for (const piece of oldPieces) {
      expect(bytesAfter.includes(Buffer.from(piece))).toBe(false)
    }
    expect(bytesAfter.includes(Buffer.from(CANARY))).toBe(false)
    expect(bytesAfter.includes(Buffer.from(ROTATED))).toBe(false)
    expect(new ProviderSecretStore(paths).reveal(REF)).toBe(ROTATED)
    expect(readdirSync(consoleDir)).toEqual(['provider-secrets.json'])
  })

  test('a re-bind for a new revision re-seals too: nothing of the old entry survives', () => {
    const { paths } = layout()
    const store = new ProviderSecretStore(paths)
    store.commit(REF.profileId, 1, ['k1'], { k1: CANARY })
    const old = readFileSync(paths.secretsPath, 'utf8')
    const oldCt = (
      JSON.parse(old) as { entries: Record<string, { ct: string }> }
    ).entries['vendor-paygo:k1']?.ct
    store.commit(REF.profileId, 2, ['k1'])
    expect(readFileSync(paths.secretsPath, 'utf8')).not.toContain(oldCt ?? '?')
    expect(new ProviderSecretStore(paths).reveal(REF)).toBe(CANARY)
  })

  test('removing a key or forgetting a profile drops its entry from the file', () => {
    const { paths } = layout()
    const store = new ProviderSecretStore(paths)
    store.commit(REF.profileId, 1, ['k1', 'k2'], { k1: CANARY, k2: ROTATED })
    store.commit(REF.profileId, 2, ['k1'])
    let text = readFileSync(paths.secretsPath, 'utf8')
    expect(text).toContain('vendor-paygo:k1')
    expect(text).not.toContain('vendor-paygo:k2')
    store.forget(REF.profileId)
    text = readFileSync(paths.secretsPath, 'utf8')
    expect(JSON.parse(text)).toEqual({ v: 1, entries: {} })
  })
})

describe('the master key', () => {
  test('too open a master key closes the face; 0600 is accepted', () => {
    const { paths } = layout()
    new ProviderSecretStore(paths).commit(REF.profileId, 1, ['k1'], {
      k1: CANARY,
    })
    // Positive control.
    expect(new ProviderSecretStore(paths).problem).toBeNull()
    chmodSync(paths.keyPath, 0o644)
    const loose = new ProviderSecretStore(paths)
    expect(loose.problem).toContain('权限过宽')
    expect(() => loose.reveal(REF)).toThrow()
    expect(() => loose.commit(REF.profileId, 2, ['k1'])).toThrow()
  })

  test('too open a directory around the master key closes the face', () => {
    const { paths, keyDir } = layout()
    new ProviderSecretStore(paths).commit(REF.profileId, 1, ['k1'], {
      k1: CANARY,
    })
    chmodSync(keyDir, 0o755)
    expect(new ProviderSecretStore(paths).problem).toContain('目录权限过宽')
  })

  test('a master key that is a symlink is refused', () => {
    const { paths, root } = layout()
    new ProviderSecretStore(paths).commit(REF.profileId, 1, ['k1'], {
      k1: CANARY,
    })
    const real = join(root, 'elsewhere.key')
    writeFileSync(real, readFileSync(paths.keyPath), { mode: 0o600 })
    rmSync(paths.keyPath)
    symlinkSync(real, paths.keyPath)
    expect(new ProviderSecretStore(paths).problem).toContain('不是普通文件')
  })

  test('a missing master key with ciphertext present fails closed and is NOT regenerated', () => {
    const { paths } = layout()
    new ProviderSecretStore(paths).commit(REF.profileId, 1, ['k1'], {
      k1: CANARY,
    })
    rmSync(paths.keyPath)
    const store = new ProviderSecretStore(paths)
    expect(store.problem).toContain('主密钥缺失')
    expect(() => store.reveal(REF)).toThrow()
    expect(() => store.commit('other', 1, ['k1'], { k1: ROTATED })).toThrow()
    expect(existsSync(paths.keyPath)).toBe(false)
    // Opening again does not regenerate it either.
    expect(new ProviderSecretStore(paths).problem).toContain('主密钥缺失')
    expect(existsSync(paths.keyPath)).toBe(false)
  })

  test('with no ciphertext the key is created on the first write, not at open', () => {
    const { paths } = layout()
    const store = new ProviderSecretStore(paths)
    expect(store.problem).toBeNull()
    expect(existsSync(paths.keyPath)).toBe(false)
    store.commit(REF.profileId, 1, ['k1'], { k1: CANARY })
    expect(existsSync(paths.keyPath)).toBe(true)
  })

  test('a different master key than the one that sealed the store closes the face', () => {
    const { paths } = layout()
    new ProviderSecretStore(paths).commit(REF.profileId, 1, ['k1'], {
      k1: CANARY,
    })
    writeFileSync(paths.keyPath, `${'ab'.repeat(32)}\n`, { mode: 0o600 })
    chmodSync(paths.keyPath, 0o600)
    expect(new ProviderSecretStore(paths).problem).toContain('不符')
  })

  test('a ciphertext moved to another slot does not decrypt (the binding holds)', () => {
    const { paths } = layout()
    new ProviderSecretStore(paths).commit(REF.profileId, 1, ['k1'], {
      k1: CANARY,
    })
    const doc = JSON.parse(readFileSync(paths.secretsPath, 'utf8')) as {
      v: 1
      entries: Record<string, unknown>
    }
    doc.entries['other-profile:k1'] = doc.entries['vendor-paygo:k1']
    writeFileSync(paths.secretsPath, JSON.stringify(doc), { mode: 0o600 })
    chmodSync(paths.secretsPath, 0o600)
    expect(new ProviderSecretStore(paths).problem).toContain('不符')
  })
})

describe('the store file itself', () => {
  test('a store that is not 0600 closes the face', () => {
    const { paths } = layout()
    new ProviderSecretStore(paths).commit(REF.profileId, 1, ['k1'], {
      k1: CANARY,
    })
    chmodSync(paths.secretsPath, 0o640)
    expect(new ProviderSecretStore(paths).problem).toContain('密文库权限过宽')
  })

  test('a store that does not parse closes the face', () => {
    const { paths, consoleDir } = layout()
    mkdirSync(consoleDir, { recursive: true, mode: 0o700 })
    writeFileSync(paths.secretsPath, '{"v":1,"entries":{"x":1}}', {
      mode: 0o600,
    })
    expect(new ProviderSecretStore(paths).problem).toBe('密文库无法解析')
  })
})
