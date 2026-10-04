// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Processes for the `qm handoff` end-to-end suites (`qianmo-handoff.test.ts`,
 * `qianmo-handoff-mcp.test.ts`, `qianmo-handoff-node.test.ts`): `qm` from
 * source with the shipped defines and feature list, and the hub —
 * `qm console --handoff-root` — on loopback.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import {
  getMacroDefines,
  resolveBuildFeatures,
} from '../../../scripts/defines.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../../..')
const CLI_ENTRYPOINT = join(PROJECT_ROOT, 'src/entrypoints/cli.tsx')

/** The same list the other end-to-end tests drop. */
export const INHERITED_KEYS_TO_DROP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OCC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'QMCODE_HOME',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
]

/** `bun run -d… --feature… src/entrypoints/cli.tsx`, as `scripts/dev.ts` does. */
export function cliPrefix(): readonly string[] {
  const defines = {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  }
  return [
    'run',
    ...Object.entries(defines).flatMap(([key, value]) => [
      '-d',
      `${key}:${String(value)}`,
    ]),
    ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
    CLI_ENTRYPOINT,
  ]
}

export interface RunningConsole {
  readonly child: ChildProcess
  readonly exited: Promise<void>
  stderr(): string
  stdout(): string
}

interface ConsoleOptions {
  readonly port: number
  /** `--handoff-root`: the directory of the bare repositories. */
  readonly handoffRoot: string
  readonly adminTokenFile: string
  readonly viewTokenFile: string
  readonly cwd: string
  readonly env: Record<string, string>
  /** More `qm console` flags after `--handoff-root` (the P17.5 dispatch ones). */
  readonly extraArgs?: readonly string[]
}

/** `qm console --handoff-root …` on `127.0.0.1:<port>`. */
export function startHandoffConsole(options: ConsoleOptions): RunningConsole {
  const child = spawn(
    process.execPath,
    [
      ...cliPrefix(),
      'console',
      '--port',
      String(options.port),
      '--admin-token-file',
      options.adminTokenFile,
      '--view-token-file',
      options.viewTokenFile,
      '--handoff-root',
      options.handoffRoot,
      ...(options.extraArgs ?? []),
    ],
    { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', chunk => {
    stderr += String(chunk)
  })
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  return { child, exited, stdout: () => stdout, stderr: () => stderr }
}

async function accepts(listen: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: listen,
      socket: { data() {} },
    })
    socket.end()
    return true
  } catch {
    return false
  }
}

/** Wait until the console listens; throws with its stderr if it exits or takes too long. */
export async function waitForConsole(
  running: RunningConsole,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await accepts(port))) {
    if (running.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`console did not come up\n${running.stderr()}`)
    }
    await Bun.sleep(100)
  }
}

/** SIGTERM, then SIGKILL after 5 s; resolves once it has exited. */
export async function stopConsole(running: RunningConsole): Promise<void> {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill('SIGTERM')
    const killer = setTimeout(() => running.child.kill('SIGKILL'), 5_000)
    await running.exited
    clearTimeout(killer)
  }
}

export async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const value =
        typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => done(value))
    })
  })
}
