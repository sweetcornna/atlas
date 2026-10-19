// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm mcp-exec` — starts one operator-configured stdio MCP server (P32) with
 * the node's inherited baseline environment and the variables the server was
 * configured with, and nothing else of the environment it was started in.
 *
 * qianmopi starts MCP servers with its whole environment, which on a node can
 * hold transport keys and model credentials; the node writes this wrapper as
 * the server's command, and probes the server through it too. The process is
 * replaced in place (`execve`), so the server is what its runtime talks to;
 * where that is unavailable or fails, the server runs as its child.
 */

import { readFileSync } from 'node:fs'
import type { Subprocess } from 'bun'
import { inheritedEnv } from '../host/runtimes/inheritedEnv.js'

const USAGE = `Usage: qm mcp-exec [--keep NAME,NAME] [--env-file FILE] -- <command> [args...]

Started by a resident node's agent runtime for an MCP server; not for direct use.
`
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export interface McpExecPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

/**
 * The server's own variables from a file the node wrote for one process
 * (a JSON object of strings; P36.7: a Codex connector's secrets stay off
 * the command line and out of the agent's `config.toml`).
 */
function envFile(path: string): Record<string, string> | string {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return `--env-file ${path} is not readable JSON`
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return '--env-file holds a JSON object'
  const env: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!ENV_NAME.test(name) || typeof entry !== 'string')
      return '--env-file holds variable names and string values'
    env[name] = entry
  }
  return env
}

/** What `argv` would start, from `source`; a string is the usage error. */
export function mcpExecPlan(
  argv: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): McpExecPlan | string {
  const keep: string[] = []
  const extra: Record<string, string> = {}
  let at = 0
  for (; at < argv.length && argv[at] !== '--'; at++) {
    if (argv[at] === '--keep' && argv[at + 1] !== undefined) {
      const names = argv[++at]!.split(',').filter(name => name !== '')
      if (!names.every(name => ENV_NAME.test(name)))
        return '--keep takes variable names'
      keep.push(...names)
    } else if (argv[at] === '--env-file' && argv[at + 1] !== undefined) {
      const loaded = envFile(argv[++at]!)
      if (typeof loaded === 'string') return loaded
      Object.assign(extra, loaded)
    } else return `unknown argument: ${argv[at]}`
  }
  const command = argv[at + 1]
  if (argv[at] !== '--' || command === undefined || command === '')
    return 'missing -- <command>'
  return {
    command,
    args: argv.slice(at + 2),
    env: { ...inheritedEnv(source, keep), ...extra },
  }
}

export async function run(argv: string[]): Promise<number> {
  const plan = mcpExecPlan(argv)
  if (typeof plan === 'string') {
    process.stderr.write(`qm mcp-exec: ${plan}\n${USAGE}`)
    return 2
  }
  const file = plan.command.includes('/')
    ? plan.command
    : Bun.which(plan.command, { PATH: plan.env.PATH ?? '' })
  if (file === null) {
    process.stderr.write(`Executable not found in $PATH: "${plan.command}"\n`)
    return 127
  }
  const execve = (
    process as {
      execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never
    }
  ).execve
  if (typeof execve === 'function') {
    try {
      execve(file, [plan.command, ...plan.args], plan.env)
    } catch {
      // It can exist and still fail (a compiled binary on some Linux hosts).
    }
  }
  // No execve, or one that failed: run it as a child and pass its exit on.
  // Forwarding is in place before the child starts: a signal that came
  // between the two would end this wrapper and leave the server running.
  let child: Subprocess | undefined
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => child?.kill(signal))
  child = Bun.spawn([file, ...plan.args], {
    env: plan.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await child.exited
}
