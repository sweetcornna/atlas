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
  readPrivateFile,
  runProgram,
  writePrivateFile,
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

const posix = process.platform !== 'win32'

describe('file store', () => {
  test.skipIf(!posix)(
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

  test.skipIf(!posix)(
    'a link planted at the old temporary name is not written through',
    () => {
      const root = tempDir()
      const dir = path.join(root, 'qmo')
      fs.mkdirSync(dir, { mode: 0o700 })
      const elsewhere = path.join(root, 'elsewhere')
      fs.writeFileSync(elsewhere, '')
      const file = path.join(dir, 'device.token')
      fs.symlinkSync(elsewhere, `${file}.${process.pid}.tmp`)
      writePrivateFile(file, `${TOKEN}\n`)
      expect(fs.readFileSync(elsewhere, 'utf8')).toBe('')
      expect(fs.lstatSync(file).isFile()).toBe(true)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(readPrivateFile(file)).toBe(`${TOKEN}\n`)
      // Nothing of the write is left behind but the file.
      expect(fs.readdirSync(dir).sort()).toEqual(
        ['device.token', `device.token.${process.pid}.tmp`].sort(),
      )
    },
  )

  test.skipIf(!posix)(
    'a directory others can enter, or a link, is refused before anything is written',
    () => {
      const root = tempDir()
      const open = path.join(root, 'open')
      fs.mkdirSync(open, { mode: 0o700 })
      fs.chmodSync(open, 0o777)
      expect(() =>
        writePrivateFile(path.join(open, 'device.token'), TOKEN),
      ).toThrow(/权限过宽（只能本人进入，chmod 700）/)
      expect(fs.readdirSync(open)).toEqual([])
      const real = path.join(root, 'real')
      fs.mkdirSync(real, { mode: 0o700 })
      const linked = path.join(root, 'linked')
      fs.symlinkSync(real, linked)
      expect(() =>
        writePrivateFile(path.join(linked, 'device.token'), TOKEN),
      ).toThrow(/不是目录（不能是链接）/)
      expect(fs.readdirSync(real)).toEqual([])
      // A missing one is made, 0700.
      const fresh = path.join(root, 'a', 'b')
      writePrivateFile(path.join(fresh, 'device.token'), TOKEN)
      expect(fs.statSync(fresh).mode & 0o777).toBe(0o700)
    },
  )

  test.skipIf(!posix)(
    'a device.token that is a link is refused on read and replaced on write',
    async () => {
      const root = tempDir()
      const dir = path.join(root, 'qmo')
      fs.mkdirSync(dir, { mode: 0o700 })
      const target = path.join(root, 'other.token')
      const other = `qmd_${'x'.repeat(43)}`
      fs.writeFileSync(target, `${other}\n`, { mode: 0o600 })
      const file = path.join(dir, 'device.token')
      fs.symlinkSync(target, file)
      const store = fileSecret(file)
      await expect(store.read()).rejects.toThrow(/不是普通文件（不能是链接）/)
      await store.write(TOKEN)
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(target, 'utf8')).toBe(`${other}\n`)
      expect(await store.read()).toBe(TOKEN)
    },
  )

  test.skipIf(!posix)(
    'a FIFO or a directory in its place is refused without waiting',
    async () => {
      const dir = tempDir()
      const fifo = path.join(dir, 'device.token')
      expect(Bun.spawnSync(['mkfifo', '-m', '600', fifo]).exitCode).toBe(0)
      await expect(fileSecret(fifo).read()).rejects.toThrow(/不是普通文件/)
      const folder = path.join(dir, 'client.json')
      fs.mkdirSync(folder, { mode: 0o700 })
      expect(() => readPrivateFile(folder)).toThrow(/不是普通文件/)
      expect(readPrivateFile(path.join(dir, 'missing'))).toBeUndefined()
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
