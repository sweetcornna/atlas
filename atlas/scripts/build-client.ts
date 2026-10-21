#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Build the `qmo` client (clients.md §2): `dist/qmo-<os>-<arch>`, with `.exe`
 * on Windows — one Bun single-file executable with nothing to install beside
 * it.
 *
 * Usage:
 *   bun atlas/scripts/build-client.ts                       host target
 *   bun atlas/scripts/build-client.ts --target windows-x64  linux-x64, linux-arm64, darwin-arm64
 *
 * Ship each system's build from that system, as with `qm`; the cross targets
 * are for development checks. Unlike `build-qm.ts` this imports nothing from
 * the omp tree, so a checkout that installed only the client's workspace can
 * build it.
 *
 * The commit is stamped as `QMO_SOURCE_COMMIT`: `QIANMO_SOURCE_COMMIT` when
 * set, else `<sha>`, `<sha>-dirty` or `unknown`.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const ENTRY = join(REPO_ROOT, 'atlas', 'packages', 'client', 'src', 'cli.ts')

/** Our target names and Bun's; x64 builds use the baseline CPU level. */
export const CLIENT_TARGETS: Readonly<Record<string, string>> = {
  'windows-x64': 'bun-windows-x64-baseline',
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-arm64': 'bun-darwin-arm64',
}

/** This machine's target name. */
export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'win32' ? 'windows' : platform
  return `${os}-${arch}`
}

/** `dist/qmo-<target>`, `.exe` for Windows. */
export function clientOutfile(target: string): string {
  return join(
    REPO_ROOT,
    'dist',
    `qmo-${target}${target.startsWith('windows-') ? '.exe' : ''}`,
  )
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function sourceCommit(): string {
  const fromEnv = process.env.QIANMO_SOURCE_COMMIT
  if (fromEnv) return fromEnv
  const head = git('rev-parse', 'HEAD')
  if (!/^[0-9a-f]{40}$/.test(head)) return 'unknown'
  return git('status', '--porcelain', '--untracked-files=no') === ''
    ? head
    : `${head}-dirty`
}

function targetArg(argv: readonly string[]): string {
  const at = argv.indexOf('--target')
  const named = at < 0 ? undefined : argv[at + 1]
  if (named === undefined) return hostTarget()
  if (CLIENT_TARGETS[named] === undefined)
    throw new Error(
      `--target must be one of ${Object.keys(CLIENT_TARGETS).join(', ')}`,
    )
  return named
}

function main(): number {
  const target = targetArg(process.argv.slice(2))
  const outfile = clientOutfile(target)
  const cross = target !== hostTarget()
  mkdirSync(join(REPO_ROOT, 'dist'), { recursive: true })
  const args = [
    'build',
    '--compile',
    '--minify',
    ...(cross ? [`--target=${CLIENT_TARGETS[target]}`] : []),
    '--define',
    `QMO_SOURCE_COMMIT=${JSON.stringify(sourceCommit())}`,
    '--outfile',
    outfile,
    ENTRY,
  ]
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) return result.status ?? 1
  console.log(`[build-client] ${outfile}`)
  return 0
}

if (import.meta.main) process.exit(main())
