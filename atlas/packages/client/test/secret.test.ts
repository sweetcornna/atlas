// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  deviceTokenStore,
  dpapiArgv,
  dpapiScript,
  dpapiSecret,
  fileSecret,
  powershellPath,
  type Run,
  runProgram,
} from '../src/secret.ts'

const TOKEN = `qmd_${'k'.repeat(43)}`
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-secret-'))
  dirs.push(dir)
  return dir
}

describe('file store', () => {
  test.skipIf(process.platform === 'win32')(
    'writes 0600 in a 0700 directory and refuses a file others can read',
    async () => {
      const dir = path.join(tempDir(), 'state')
      const store = fileSecret(path.join(dir, 'device.token'))
      expect(await store.read()).toBeUndefined()
      await store.write(TOKEN)
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(store.file).mode & 0o777).toBe(0o600)
      expect(await store.read()).toBe(TOKEN)
      fs.chmodSync(store.file, 0o644)
      await expect(store.read()).rejects.toThrow(/权限过宽/)
      store.remove()
      expect(fs.existsSync(store.file)).toBe(false)
    },
  )
})

describe('DPAPI store', () => {
  test('the script protects for the current user with the client entropy', () => {
    const protect = dpapiScript('Protect')
    expect(protect).toContain('[Security.Cryptography.ProtectedData]::Protect(')
    expect(protect).toContain('DataProtectionScope]::CurrentUser')
    expect(protect).toContain("GetBytes('qmo.client.v1')")
    expect(protect).toContain('[Console]::In.ReadToEnd()')
    expect(dpapiScript('Unprotect')).toContain('ProtectedData]::Unprotect(')
  })

  test('PowerShell comes from the system directory and the script is encoded', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(powershellPath({})).toBe('powershell.exe')
    const argv = dpapiArgv('Protect', { SystemRoot: 'C:\\Windows' })
    expect(argv.slice(1, 5)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ])
    expect(Buffer.from(argv[5]!, 'base64').toString('utf16le')).toBe(
      dpapiScript('Protect'),
    )
  })

  test('the token goes over stdin only, and the file holds the protected blob', async () => {
    const calls: { argv: readonly string[]; stdin: string }[] = []
    // A reversible stand-in for DPAPI: what matters is what crosses the boundary.
    const run: Run = async (argv, stdin) => {
      calls.push({ argv, stdin })
      const script = Buffer.from(argv[argv.length - 1]!, 'base64').toString(
        'utf16le',
      )
      const input = Buffer.from(stdin.trim(), 'base64')
      const output = script.includes('::Protect(')
        ? Buffer.concat([Buffer.from('BLOB:'), input])
        : input.subarray(5)
      return { exitCode: 0, stdout: output.toString('base64'), stderr: '' }
    }
    const dir = tempDir()
    const store = dpapiSecret(path.join(dir, 'device.token.dpapi'), run, {
      SystemRoot: 'C:\\Windows',
    })
    await store.write(TOKEN)
    expect(await store.read()).toBe(TOKEN)
    for (const call of calls) {
      expect(call.argv.join(' ')).not.toContain(TOKEN)
      expect(call.argv.join(' ')).not.toContain(
        Buffer.from(TOKEN).toString('base64'),
      )
    }
    expect(calls[0]!.stdin).toBe(Buffer.from(TOKEN).toString('base64'))
    const onDisk = fs.readFileSync(store.file, 'utf8')
    expect(onDisk).not.toContain(TOKEN)
    expect(Buffer.from(onDisk.trim(), 'base64').toString()).toStartWith('BLOB:')
  })

  test('a failed protect or unprotect is a clear error, not a garbled token', async () => {
    const dir = tempDir()
    const broken: Run = async () => ({ exitCode: 1, stdout: '', stderr: 'x' })
    const store = dpapiSecret(path.join(dir, 'device.token.dpapi'), broken)
    await expect(store.write(TOKEN)).rejects.toThrow(
      /没能用 Windows 数据保护加密/,
    )
    fs.writeFileSync(store.file, 'AAAA\n')
    await expect(store.read()).rejects.toThrow(/重新 qmo sign-in/)
  })
})

test.skipIf(process.platform !== 'win32')(
  'real DPAPI: the token round-trips and only the protected blob is on disk',
  async () => {
    const store = dpapiSecret(
      path.join(tempDir(), 'device.token.dpapi'),
      runProgram,
    )
    await store.write(TOKEN)
    const onDisk = fs.readFileSync(store.file, 'utf8')
    expect(onDisk).not.toContain(TOKEN)
    expect(
      Buffer.from(onDisk.trim(), 'base64').toString('latin1'),
    ).not.toContain(TOKEN)
    expect(await store.read()).toBe(TOKEN)
  },
  60_000,
)

test('Windows keeps the token under DPAPI, everything else in a 0600 file', () => {
  const dir = '/state'
  expect(deviceTokenStore(dir, 'win32').kind).toBe('dpapi')
  expect(deviceTokenStore(dir, 'win32').file).toBe(
    path.join(dir, 'device.token.dpapi'),
  )
  for (const platform of ['linux', 'darwin'] as const) {
    expect(deviceTokenStore(dir, platform).kind).toBe('file')
    expect(deviceTokenStore(dir, platform).file).toBe(
      path.join(dir, 'device.token'),
    )
  }
})
