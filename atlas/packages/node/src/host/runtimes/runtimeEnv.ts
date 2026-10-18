// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One agent's harness environment, built in one place (P36.7,
 * `harness-backends.md` §7.2): the resident process the pool starts, the
 * official frontend `qm runtime open` starts and the harness's own commands
 * the console's native operations run all see the same state directory,
 * launch directory, credentials and switches, so what the operator installs
 * or tries in one is what the others load.
 *
 * | runtime | state | `HOME` |
 * |---|---|---|
 * | Claude Code | `CLAUDE_CONFIG_DIR` | the node's |
 * | Codex | `CODEX_HOME` | the node's |
 * | dsh | `DSH_HOME`, `DSH_AGENTS_HOME` | the node's |
 * | Gemini CLI | `GEMINI_CLI_HOME` | the agent's home |
 * | Qwen Code | `QWEN_HOME` | the agent's home |
 * | opencode | `XDG_*_HOME` | the agent's home |
 *
 * The state directory is `qianmoConfigPath('runtimes', <runtime>, <agent>)`;
 * the launch directory, an empty one of its own, is `launch/` inside it.
 * Everything else of the node's environment stays with the node
 * (`inheritedEnv`).
 */

import { createServer } from 'node:net'
import { join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type { RuntimeRoute } from './acpSpec.js'
import { claudeCodeEnv } from './claudeCode.js'
import { codexEnv } from './codex.js'
import { dshEnv } from './dsh.js'
import { geminiEnv } from './gemini.js'
import { inheritedEnv } from './inheritedEnv.js'
import { opencodeEnv } from './opencode.js'
import { qwenEnv } from './qwen.js'

export type { RuntimeRoute } from './acpSpec.js'

/** Where one agent's harness keeps its state, and starts from. */
export interface RuntimeDirs {
  readonly home: string
  /** Empty: a harness reads `.env` and project config from where it starts. */
  readonly launchDir: string
}

export function runtimeDirs(runtime: string, agent: string): RuntimeDirs {
  const home = qianmoConfigPath('runtimes', runtime, agent)
  return { home, launchDir: join(home, 'launch') }
}

/** The harness's own variables: its state, its switches, the route if any. */
export function runtimeOwnEnv(
  runtime: string,
  home: string,
  route?: RuntimeRoute,
): Record<string, string> {
  switch (runtime) {
    case 'claude-code':
      return claudeCodeEnv(home, route)
    case 'codex':
      return codexEnv(home, route)
    case 'dsh':
      return dshEnv(home, route)
    case 'gemini':
      return geminiEnv(home, route)
    case 'qwen':
      return qwenEnv(home, route)
    case 'opencode':
      return opencodeEnv(home, route)
    default:
      throw new Error(`${runtime} has no environment on this node`)
  }
}

/**
 * The environment `agent`'s `runtime` runs in: the node's inherited
 * baseline and the harness's own variables. Without `route` (the native
 * operations) no key is set: installing an extension needs none.
 */
export function runtimeEnv(
  runtime: string,
  agent: string,
  route?: RuntimeRoute,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return {
    ...inheritedEnv(source),
    ...runtimeOwnEnv(runtime, runtimeDirs(runtime, agent).home, route),
  }
}

/**
 * A loopback port free right now, for harnesses that listen on one (opencode
 * binds 4096 when given `--port 0`) and for the web frontends.
 */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      server.close(() =>
        port > 0 ? resolve(port) : reject(new Error('no free loopback port')),
      )
    })
  })
}
