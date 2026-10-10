#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm`: the Qianmo node CLI. An explicit dispatch table — each command module
 * is loaded only when its command runs and exports
 * `run(argv): Promise<number>`; `agent` hands the rest of the argv to the
 * oh-my-pi CLI as a child process.
 */

import { constants } from 'node:os'
import {
  exitOnStartupFailure,
  startupFailureMessage,
} from './host/startupFailure.js'
import { ompArgv, ompSpawnEnv } from './omp/launch.js'
import { versionLine } from './provenance.js'

type CommandModule = { run(argv: string[]): Promise<number> }

/** omp utility imports install standalone-CLI signal defaults. The resident owns
 * those three signals: HUP commits configuration and TERM/INT drain durable state.
 * Preserve pre-existing listeners and remove only listeners added by this import.
 * The child omp process retains its own default handlers. */
async function loadResidentCommand(): Promise<CommandModule> {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const prior = new Map(
    signals.map(signal => [signal, new Set(process.listeners(signal))]),
  )
  try {
    return await import('./commands/resident.js')
  } finally {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!prior.get(signal)?.has(listener)) process.off(signal, listener)
      }
    }
  }
}

const COMMANDS: Record<
  string,
  { summary: string; load: () => Promise<CommandModule> }
> = {
  resident: {
    summary: 'run the resident node host (omp agents behind a Qianmo address)',
    load: () => loadResidentCommand(),
  },
  'resident-wake': {
    summary: 'send one signed wake message to a resident node',
    load: () => import('./commands/residentWake.js'),
  },
  console: {
    summary: 'serve the Qianmo web console (hub)',
    load: () => import('./commands/console.js'),
  },
  registry: {
    summary: 'serve agent discovery with local or shared PostgreSQL storage',
    load: () => import('./commands/registry.js'),
  },
  audit: {
    summary: 'read and verify the local audit trail',
    load: () => import('./commands/qianmoAudit.js'),
  },
  ca: {
    summary: 'operate the node certificate authority',
    load: () => import('./commands/ca.js'),
  },
  cert: {
    summary: "request this node's TLS certificate",
    load: () => import('./commands/cert.js'),
  },
  watch: {
    summary: 'run scheduled watch jobs that wake nodes',
    load: () => import('./commands/watch.js'),
  },
  memory: {
    summary: 'inspect and edit node project memory',
    load: () => import('./commands/memory.js'),
  },
  provider: {
    summary: 'manage the node model service',
    load: () => import('./commands/provider.js'),
  },
  elastic: {
    summary: 'plan and review allocation from an existing resource pool',
    load: () => import('./commands/elastic.js'),
  },
  a2a: {
    summary: 'serve or call an A2A 1.0 HTTP+JSON gateway',
    load: () => import('./commands/a2a.js'),
  },
  handoff: {
    summary: 'hand a coding session between laptop and node',
    load: () => import('./commands/handoff.js'),
  },
}

const HELP_TEXT = `Usage: qm <command> [options]

Commands:
${Object.entries(COMMANDS)
  .map(([name, { summary }]) => `  ${name.padEnd(15)}${summary}`)
  .join('\n')}
  ${'agent'.padEnd(15)}run the oh-my-pi agent CLI (arguments pass through)

Options:
  -v, --version  print qm, omp and source versions
  -h, --help     show this help

Run \`qm <command> --help\` for a command's options.

Environment:
  QIANMO_CONFIG_DIR  config root (default ~/.qianmo); omp state lives in
                     <root>/omp
`

async function runAgent(argv: string[]): Promise<number> {
  const child = Bun.spawn(ompArgv(argv), {
    env: ompSpawnEnv(),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const forward = (signal: NodeJS.Signals) => child.kill(signal)
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  try {
    const code = await child.exited
    return child.signalCode === null
      ? code
      : 128 + (constants.signals[child.signalCode] ?? 1)
  } finally {
    process.off('SIGINT', forward)
    process.off('SIGTERM', forward)
  }
}

/** Run one qm invocation; resolves to the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === '--version' || command === '-v' || command === '-V') {
    process.stdout.write(`${versionLine()}\n`)
    return 0
  }
  if (
    command === undefined ||
    command === '--help' ||
    command === '-h' ||
    command === 'help'
  ) {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (command === 'agent') return runAgent(rest)
  const entry = COMMANDS[command]
  if (entry === undefined) {
    process.stderr.write(
      `${startupFailureMessage(`unknown command: ${command}`)} (run \`qm --help\` for the list)\n`,
    )
    return 2
  }
  try {
    const module = await entry.load()
    return await module.run(rest)
  } catch (error) {
    process.stderr.write(`${startupFailureMessage(error)}\n`)
    return 1
  }
}

/**
 * Long-running commands (resident, console, watch, handoff hub/node) resolve
 * `run` once they are serving, so the exit code is set, never forced: the
 * process ends when the event loop drains.
 */
if (import.meta.main) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code
  }, exitOnStartupFailure)
}
