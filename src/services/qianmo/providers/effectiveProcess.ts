// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The production entry for §2.4 `effective`: `computeEffectiveProviderState()`
 * in a process of its own.
 *
 * It has to be its own process because the computation replays the ACP
 * child's startup onto `process.env` (see `effective.ts`), and it has to start
 * from the environment a managed node's ACP child starts from — the parent's
 * minus every provider-shaped key (`withoutProviderKeys`, the same function
 * `residentAcpEnvironment()` uses) — or the answer would describe the shell
 * `qm provider` happened to be started from instead of the node.
 *
 * Two halves:
 *
 *   - {@link computeEffectiveInChild}, in `qm provider status`: re-executes
 *     this same CLI (`buildCliLaunch`, the way the resident starts `--acp`) as
 *     `provider __effective`, with the stripped env and the node's private
 *     provider directory as cwd, so no project settings are picked up from
 *     wherever the caller stood. Waits for one marked line, with a deadline.
 *   - {@link printEffectiveProviderState}, in that child: computes and prints.
 *
 * The child's stderr is read and dropped, never relayed: it is the runtime's
 * own diagnostics, and nothing here vouches that they hold no values.
 *
 * {@link runOwnCliChild} is the spawning part on its own; `qm provider`'s
 * `autocompact` op (D-9) runs `provider autocompact --json` through it for
 * the same reason (its computation replays the same start-up).
 */

import type { EffectiveState } from '@qianmo/providers'
import {
  buildCliLaunch,
  type CliLaunchSpec,
  spawnCli,
} from '../../../utils/process/cliLaunch.js'
import { withoutProviderKeys } from '../residentAcpEnv.js'
import { computeEffectiveProviderState } from './effective.js'
import { ensurePrivateDir, providerDir } from './store.js'

/** The hidden `qm provider` subcommand the child runs. */
export const EFFECTIVE_CHILD_SUBCOMMAND = '__effective'

const MARKER = 'QIANMO_EFFECTIVE '

/** More than one marked line ever needs; output past it is not read. */
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024

/** Child side: compute against this process and print one marked line. */
export function printEffectiveProviderState(
  write: (text: string) => void = text => {
    process.stdout.write(text)
  },
): void {
  write(`${MARKER}${JSON.stringify(computeEffectiveProviderState())}\n`)
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
  const env = withoutProviderKeys(options.env ?? process.env)
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
