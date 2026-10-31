#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Build the desktop app (qmo-app.md §8): `qmo` for this machine first, the
 * way `atlas:build:client` builds it, copied to
 * `atlas/apps/qmo/src-tauri/binaries/qmo-<target triple>` where the bundle
 * takes its sidecar from; the console's `CODE_RENDER_JS` written to
 * `atlas/apps/qmo/ui/code-render.js`, which the shell's own Code page draws
 * local sessions with when the hub is out of reach (P37.16, qmo-local.md
 * §8); then `cargo tauri build`.
 *
 * Usage:
 *   bun atlas/scripts/build-app.ts            release build; Qmo.app on macOS
 *   bun atlas/scripts/build-app.ts --debug    debug build (devtools on)
 *   bun atlas/scripts/build-app.ts --sidecar  only the `qmo` sidecar and
 *                                             `code-render.js` (before
 *                                             `cargo test`)
 *   bun atlas/scripts/build-app.ts --dev      those two, then `cargo tauri dev`
 *
 * Each system's app is built on that system, as with `qmo` and `qm`; there is
 * no cross build here. Needs Rust and the Tauri CLI (`cargo install
 * tauri-cli`); on Linux also the WebKitGTK development packages.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { CODE_RENDER_JS } from '../packages/console/src/assets/codeRender.ts'
import { clientOutfile, hostTarget } from './build-client.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const APP_DIR = join(REPO_ROOT, 'atlas', 'apps', 'qmo', 'src-tauri')

/** Where the shell's Code page loads the console's drawing from. */
export const CODE_RENDER_PATH = join(
  REPO_ROOT,
  'atlas',
  'apps',
  'qmo',
  'ui',
  'code-render.js',
)

/**
 * `code-render.js`: the console's `CODE_RENDER_JS` as it is, under a header
 * saying where it came from. Not in git; every build writes it afresh, so the
 * shell's Code page draws records exactly as the hub's `/code` of the same
 * commit does.
 */
export function codeRenderFile(): string {
  return (
    '// Copyright 2026 Qianmo AgentNest Team\n' +
    '// SPDX-License-Identifier: AGPL-3.0-or-later\n' +
    '//\n' +
    '// Written by atlas/scripts/build-app.ts from CODE_RENDER_JS\n' +
    '// (atlas/packages/console/src/assets/codeRender.ts). Do not edit.\n' +
    CODE_RENDER_JS
  )
}

/** Write `code-render.js` when it is missing or differs. */
export function writeCodeRender(path: string = CODE_RENDER_PATH): void {
  const text = codeRenderFile()
  const now = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (now !== text) writeFileSync(path, text)
  console.log(`[build-app] ${path}`)
}

/** Rust's name for this machine, from `rustc -vV`. */
export function hostTriple(rustcVersion: string): string | null {
  const host = /^host: (\S+)$/m.exec(rustcVersion)
  return host?.[1] ?? null
}

/** `binaries/qmo-<triple>`, `.exe` on Windows: the name `externalBin` looks for. */
export function sidecarPath(triple: string): string {
  return join(
    APP_DIR,
    'binaries',
    `qmo-${triple}${triple.includes('-windows-') ? '.exe' : ''}`,
  )
}

/** The bundles to make: just the `.app` on macOS (a DMG is P37.12), the defaults elsewhere. */
export function tauriBuildArgs(
  platform: NodeJS.Platform,
  debug: boolean,
): string[] {
  return [
    'tauri',
    'build',
    ...(debug ? ['--debug'] : []),
    ...(platform === 'darwin' ? ['--bundles', 'app'] : []),
  ]
}

function run(command: string, args: readonly string[], cwd: string): number {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) {
    console.error(`[build-app] ${command}: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

function buildSidecar(): number {
  const rustc = spawnSync('rustc', ['-vV'], { cwd: APP_DIR, encoding: 'utf8' })
  const triple = rustc.status === 0 ? hostTriple(rustc.stdout) : null
  if (triple === null) {
    console.error(
      '[build-app] rustc -vV gave no host triple; is Rust installed?',
    )
    return 1
  }
  const built = run(
    process.execPath,
    [join(REPO_ROOT, 'atlas', 'scripts', 'build-client.ts')],
    REPO_ROOT,
  )
  if (built !== 0) return built
  const from = clientOutfile(hostTarget())
  if (!existsSync(from)) {
    console.error(`[build-app] ${from} is missing after the client build`)
    return 1
  }
  const to = sidecarPath(triple)
  mkdirSync(join(APP_DIR, 'binaries'), { recursive: true })
  copyFileSync(from, to)
  chmodSync(to, 0o755)
  console.log(`[build-app] sidecar ${to}`)
  return 0
}

function main(argv: readonly string[]): number {
  const known = new Set(['--debug', '--sidecar', '--dev'])
  const unknown = argv.find(arg => !known.has(arg))
  if (unknown !== undefined) {
    console.error(`[build-app] unknown option ${unknown}`)
    return 2
  }
  const sidecar = buildSidecar()
  if (sidecar !== 0) return sidecar
  writeCodeRender()
  if (argv.includes('--sidecar')) return 0
  if (argv.includes('--dev')) return run('cargo', ['tauri', 'dev'], APP_DIR)
  const status = run(
    'cargo',
    tauriBuildArgs(process.platform, argv.includes('--debug')),
    APP_DIR,
  )
  if (status === 0) {
    const profile = argv.includes('--debug') ? 'debug' : 'release'
    console.log(
      `[build-app] bundles in ${join(APP_DIR, 'target', profile, 'bundle')}`,
    )
  }
  return status
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
