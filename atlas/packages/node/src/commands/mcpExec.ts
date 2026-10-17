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
 * replaced in place (`execve`), so the server is what its runtime talks to.
 */

import { inheritedEnv } from '../host/runtimes/inheritedEnv.js'

const USAGE = `Usage: qm mcp-exec [--keep NAME,NAME] -- <command> [args...]

Started by a resident node's agent runtime for an MCP server; not for direct use.
`
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export interface McpExecPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

/** What `argv` would start, from `source`; a string is the usage error. */
export function mcpExecPlan(
  argv: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): McpExecPlan | string {
  const keep: string[] = []
  let at = 0
  for (; at < argv.length && argv[at] !== '--'; at++) {
    if (argv[at] === '--keep' && argv[at + 1] !== undefined) {
      const names = argv[++at]!.split(',').filter(name => name !== '')
      if (!names.every(name => ENV_NAME.test(name)))
        return '--keep takes variable names'
      keep.push(...names)
    } else return `unknown argument: ${argv[at]}`
  }
  const command = argv[at + 1]
  if (argv[at] !== '--' || command === undefined || command === '')
    return 'missing -- <command>'
  return {
    command,
    args: argv.slice(at + 2),
    env: inheritedEnv(source, keep),
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
  if (typeof execve === 'function')
    execve(file, [plan.command, ...plan.args], plan.env)
  // No execve: run it as a child and pass its exit on.
  const child = Bun.spawn([file, ...plan.args], {
    env: plan.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => child.kill(signal))
  return await child.exited
}
