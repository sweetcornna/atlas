// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EffectiveState } from '@qianmo/providers'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ompChildEnv } from '@qianmo/paths'
export type CliLaunchSpec = {
  execPath: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsHide?: boolean
}
function buildCliLaunch(
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): CliLaunchSpec {
  return {
    execPath: process.execPath,
    args:
      process.env.QIANMO_OMP_ENTRY === 'self'
        ? args
        : [join(import.meta.dir, '..', 'cli.ts'), ...args],
    env: options.env,
  }
}
function spawnCli(spec: CliLaunchSpec, options: Parameters<typeof spawn>[2]) {
  return spawn(spec.execPath, spec.args, {
    ...options,
    env: spec.env,
    windowsHide: spec.windowsHide,
  })
}
import { withoutProviderKeys } from '../host/residentOmpEnv.js'
import { computeEffectiveProviderState } from './effective.js'
import { ensurePrivateDir, providerDir } from './store.js'

/** The hidden `qm provider` subcommand the child runs. */
export const EFFECTIVE_CHILD_SUBCOMMAND = '__effective'

const MARKER = 'QIANMO_EFFECTIVE '

/** More than one marked line ever needs; output past it is not read. */
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024

/** Child side: compute against this process and print one marked line. */
export async function printEffectiveProviderState(
  write: (text: string) => void = text => {
    process.stdout.write(text)
  },
): Promise<void> {
  write(`${MARKER}${JSON.stringify(await computeEffectiveProviderState())}\n`)
}

type Launch = (cliArgs: string[], env: NodeJS.ProcessEnv) => CliLaunchSpec

export type EffectiveOutcome =
  | { ok: true; effective: EffectiveState }
  | { ok: false; reason: 'timeout' | 'spawn-failed' | 'no-result' }

function isEffectiveState(value: unknown): value is EffectiveState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.apiProvider === 'string' &&
    typeof state.wire === 'string' &&
    typeof state.model === 'string' &&
    typeof state.wireModel === 'string' &&
    (state.modelSettingsSlot === null ||
      typeof state.modelSettingsSlot === 'string') &&
    typeof state.effortOnWire === 'boolean' &&
    (state.effortLevel === null || typeof state.effortLevel === 'string') &&
    typeof state.contextTokens === 'number' &&
    typeof state.autoCompactWindow === 'number' &&
    (state.autoCompactSource === 'env' ||
      state.autoCompactSource === 'settings' ||
      state.autoCompactSource === 'auto')
  )
}

function parseOutput(stdout: string): EffectiveState | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find(text => text.startsWith(MARKER))
  if (line === undefined) return null
  try {
    const parsed: unknown = JSON.parse(line.slice(MARKER.length))
    return isEffectiveState(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** How a child of this CLI ended, as far as its parent can tell. */
type OwnCliChildRun =
  | { kind: 'exited'; stdout: string }
  | { kind: 'timeout' }
  | { kind: 'spawn-failed' }

/**
 * Run `qm <cliArgs>` as a child: the environment stripped of every provider
 * key (see the module header), the node's private provider directory as cwd,
 * stdout collected up to a cap, stderr drained and dropped, SIGKILL at
 * `timeoutMs`. Never throws. Shared by `effective` and `autocompact` (D-9),
 * whose computations both have to happen in a process of their own.
 */
export function runOwnCliChild(
  cliArgs: readonly string[],
  options: {
    readonly timeoutMs: number
    /** The environment to strip and hand on; defaults to this process's. */
    readonly env?: NodeJS.ProcessEnv
    /** How to re-execute this CLI; tests run it from source. */
    readonly launch?: Launch
  },
): Promise<OwnCliChildRun> {
  const env = ompChildEnv(withoutProviderKeys(options.env ?? process.env))
  const launch: Launch =
    options.launch ??
    ((args, childEnv) => buildCliLaunch(args, { env: childEnv }))
  return new Promise(resolve => {
    let settled = false
    const finish = (run: OwnCliChildRun) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(run)
    }
    let child: ReturnType<typeof spawnCli>
    try {
      const cwd = providerDir()
      ensurePrivateDir(cwd)
      child = spawnCli(launch([...cliArgs], env), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ kind: 'spawn-failed' })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ kind: 'timeout' })
    }, options.timeoutMs)
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CHILD_OUTPUT_BYTES) stdout += chunk.toString()
    })
    child.stderr?.on('data', () => {
      // Read so the pipe never fills; never relayed (see the module header).
    })
    child.on('error', () => finish({ kind: 'spawn-failed' }))
    child.on('close', () => finish({ kind: 'exited', stdout }))
  })
}

/**
 * Parent side: run the computation in a child and return what it printed.
 * Never throws; a child that cannot be started, fails or overruns `timeoutMs`
 * is an outcome, and the caller reports `effective` as missing.
 */
export async function computeEffectiveInChild(options: {
  readonly timeoutMs: number
  /** The environment to strip and hand on; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv
  /** How to re-execute this CLI; tests run it from source. */
  readonly launch?: Launch
}): Promise<EffectiveOutcome> {
  const run = await runOwnCliChild(
    ['provider', EFFECTIVE_CHILD_SUBCOMMAND],
    options,
  )
  if (run.kind !== 'exited') return { ok: false, reason: run.kind }
  const effective = parseOutput(run.stdout)
  return effective === null
    ? { ok: false, reason: 'no-result' }
    : { ok: true, effective }
}
