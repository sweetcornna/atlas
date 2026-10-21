// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the device token is kept (clients.md §5.2–§5.3).
 *
 * Windows: DPAPI for the current user, through Windows PowerShell 5.1's
 * `ProtectedData`, so the file on disk opens only for this user on this
 * computer. The script goes in as `-EncodedCommand` and the token over stdin
 * and stdout, never on a command line. Linux and macOS: a 0600 file in a 0700
 * directory; the desktop keyrings are P37.4.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ClientError } from './hub.js'

export interface SecretStore {
  readonly kind: 'dpapi' | 'file'
  /** The file the secret lives in, plain or protected. */
  readonly file: string
  read(): Promise<string | undefined>
  write(secret: string): Promise<void>
  remove(): void
}

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Run a program with `stdin` as its whole input. */
export type Run = (argv: readonly string[], stdin: string) => Promise<RunResult>

export const runProgram: Run = async (argv, stdin) => {
  const proc = Bun.spawn([...argv], {
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** Write `content` so that no other user can read it at any moment. */
export function writePrivateFile(file: string, content: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'w' })
  try {
    fs.renameSync(temporary, file)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** A 0600 file. One that others can read is refused, not repaired. */
export function fileSecret(file: string): SecretStore {
  return {
    kind: 'file',
    file,
    async read() {
      const content = readIfPresent(file)
      if (content === undefined) return undefined
      if (process.platform !== 'win32') {
        const stat = fs.statSync(file)
        if (!stat.isFile() || (stat.mode & 0o077) !== 0)
          throw new ClientError(
            `${file} 的权限过宽（只能本人读写，chmod 600），或它不是普通文件`,
          )
      }
      return content.trim()
    },
    async write(secret) {
      writePrivateFile(file, `${secret}\n`)
    },
    remove() {
      fs.rmSync(file, { force: true })
    },
  }
}

/** Extra entropy, so another DPAPI user of this account cannot open the blob by accident. */
const DPAPI_ENTROPY = 'qmo.client.v1'

/** The PowerShell that protects or unprotects base64 on stdin into base64 on stdout. */
export function dpapiScript(direction: 'Protect' | 'Unprotect'): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [Security.Cryptography.ProtectedData]::${direction}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ')
}

/** Windows PowerShell 5.1 from the system directory, not whatever PATH finds first. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT
  return root
    ? path.win32.join(
        root,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : 'powershell.exe'
}

/** The full command line for one direction; the token is not on it. */
export function dpapiArgv(
  direction: 'Protect' | 'Unprotect',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const encoded = Buffer.from(dpapiScript(direction), 'utf16le').toString(
    'base64',
  )
  return [
    powershellPath(env),
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ]
}

export function dpapiSecret(
  file: string,
  run: Run = runProgram,
  env: NodeJS.ProcessEnv = process.env,
): SecretStore {
  const transform = async (
    direction: 'Protect' | 'Unprotect',
    input: string,
  ): Promise<string> => {
    const result = await run(dpapiArgv(direction, env), input)
    const output = result.stdout.trim()
    if (result.exitCode !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output))
      throw new ClientError(
        direction === 'Protect'
          ? '没能用 Windows 数据保护加密设备令牌'
          : '没能用 Windows 数据保护解开设备令牌（换了用户或电脑时要重新 qmo sign-in）',
      )
    return output
  }
  return {
    kind: 'dpapi',
    file,
    async read() {
      const blob = readIfPresent(file)
      if (blob === undefined) return undefined
      const plain = await transform('Unprotect', blob.trim())
      return Buffer.from(plain, 'base64').toString('utf8').trim()
    },
    async write(secret) {
      const blob = await transform(
        'Protect',
        Buffer.from(secret, 'utf8').toString('base64'),
      )
      writePrivateFile(file, `${blob}\n`)
    },
    remove() {
      fs.rmSync(file, { force: true })
    },
  }
}

/** The device-token store for `platform`, inside the client state directory. */
export function deviceTokenStore(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  run: Run = runProgram,
): SecretStore {
  return platform === 'win32'
    ? dpapiSecret(path.join(dir, 'device.token.dpapi'), run)
    : fileSecret(path.join(dir, 'device.token'))
}
