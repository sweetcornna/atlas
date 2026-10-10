// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Host verification of generated code. The workspace is read-only, network is
 * unavailable, and only a fresh HOME/TMPDIR is writable. Missing OS isolation
 * fails closed. These checks are separate from the agent's tool allowlist. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export type ValidationResult = {
  code: number
  stdout: string
  stderr: string
  isolation: 'seatbelt' | 'bubblewrap'
}
const quote = (value: string) => JSON.stringify(value)
export function runIsolatedCheck(
  command: readonly string[],
  cwd: string,
): ValidationResult {
  const workspace = realpathSync(cwd)
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'qm-task-check-')))
  const home = join(sandbox, 'home'),
    temp = join(sandbox, 'tmp')
  mkdirSync(home)
  mkdirSync(temp)
  const binary =
    command[0] === 'bun'
      ? realpathSync(process.execPath)
      : realpathSync(resolve(workspace, command[0]!))
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin`,
    CI: '1',
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(temp, 'bun-cache'),
  }
  let argv: string[], isolation: ValidationResult['isolation']
  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec'))
      throw new Error(
        'OS validation sandbox unavailable: sandbox-exec is required',
      )
    const readRoots = [
      '/System',
      '/usr',
      '/bin',
      '/sbin',
      '/Library/Apple',
      '/private/var/db/dyld',
      '/private/etc/ssl',
      workspace,
    ]
    const ancestors = new Set<string>()
    for (const path of [workspace, binary, home, temp]) {
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        ancestors.add(parent)
        if (parent === dirname(parent)) break
      }
    }
    const profile = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec process-fork sysctl-read mach-lookup)',
      '(allow signal (target self))',
      '(allow file-read-metadata)',
      `(allow file-read-data ${[...ancestors].map(path => `(literal ${quote(path)})`).join(' ')})`,
      `(allow file-read* file-map-executable ${readRoots.map(path => `(subpath ${quote(path)})`).join(' ')} (literal ${quote(binary)}) (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))`,
      `(allow file-read* file-write* (subpath ${quote(home)}) (subpath ${quote(temp)}) (literal "/dev/null"))`,
    ].join('\n')
    const profilePath = join(sandbox, 'profile.sb')
    writeFileSync(profilePath, profile, { mode: 0o600 })
    argv = [
      '/usr/bin/sandbox-exec',
      '-f',
      profilePath,
      binary,
      ...command.slice(1),
    ]
    isolation = 'seatbelt'
  } else if (process.platform === 'linux') {
    const bwrap = Bun.which('bwrap')
    if (!bwrap)
      throw new Error(
        'OS validation sandbox unavailable: bubblewrap (bwrap) is required',
      )
    argv = [
      bwrap,
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--clearenv',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
    ]
    for (const path of [
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/etc/ld.so.cache',
    ])
      if (existsSync(path)) argv.push('--ro-bind', path, path)
    argv.push('--ro-bind', workspace, workspace)
    if (
      !binary.startsWith(`${workspace}/`) &&
      !binary.startsWith('/usr/') &&
      !binary.startsWith('/bin/')
    )
      argv.push('--ro-bind', binary, binary)
    argv.push('--bind', home, home, '--bind', temp, temp, '--chdir', workspace)
    for (const [name, value] of Object.entries(env))
      argv.push('--setenv', name, value)
    argv.push('--', binary, ...command.slice(1))
    isolation = 'bubblewrap'
  } else
    throw new Error(`OS validation sandbox unavailable on ${process.platform}`)
  const proc = Bun.spawnSync(argv, {
    cwd: workspace,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  })
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    isolation,
  }
}

/** Require the runner's completed summary as well as exit zero. In particular,
 * process.exit(0) during a generated module import is not a successful suite. */
export function completedBunTests(
  result: Pick<ValidationResult, 'code' | 'stdout' | 'stderr'>,
  minimum: number,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`
  const passed = /(?:^|\n)\s*(\d+) pass\s*(?:\n|$)/.exec(output)
  const failed = /(?:^|\n)\s*(\d+) fail\s*(?:\n|$)/.exec(output)
  const assertions = /(?:^|\n)\s*(\d+) expect\(\) calls/.exec(output)
  const ran = /Ran (\d+) tests? across \d+ files?\./.exec(output)
  return (
    result.code === 0 &&
    Number(passed?.[1] ?? 0) >= minimum &&
    failed?.[1] === '0' &&
    Number(assertions?.[1] ?? 0) >= minimum &&
    Number(ran?.[1] ?? 0) === Number(passed?.[1] ?? 0)
  )
}
