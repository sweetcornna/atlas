// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm desktop-exec` — runs one external-runtime session's desktop tools.
 *
 * A resident Claude Code or Codex agent reaches `qianmo_browser_*` and
 * `qianmo_computer_*` through `qm runtime-mcp`; the resident host hands each
 * call to this child, which drives the agent's private browser and display
 * with the same executor the qianmopi extension uses (runtimes-channels.md
 * §6.1). The base's computer backend picks its display from the process
 * environment, so every session gets its own process with that agent's
 * `DISPLAY`. Every gate phase is a question back to the host over stdout;
 * the host answers from `NodeDesktop.decide`. Started only by the host.
 *
 * Wire (one JSON object per line):
 * - host → child: `{type: 'call', id, name, invocationId, args}`,
 *   `{type: 'gate', id, answer}`;
 * - child → host: `{type: 'ready'}`, `{type: 'gate', id, kind, request,
 *   timeoutMs?}` (`kind` is `reserve`, `confirm` or `query`),
 *   `{type: 'result', id, result}`, `{type: 'error', id, message}`.
 */

import { createInterface } from 'node:readline'
import { declareWorkerHostEntry } from '@oh-my-pi/pi-utils/worker-host'
import {
  DesktopExecutor,
  type DesktopGateRequest,
  type DesktopGateway,
} from '@qianmo/extension/desktopExec'
import {
  isDesktopInvocationId,
  isDesktopTool,
  type DesktopDecision,
} from '@qianmo/extension/desktopPolicy'

const USAGE = `Usage: qm desktop-exec --resource <abs path> --cwd <abs path>

Started by a resident node for one Claude Code or Codex session; not for direct use.
`

type GateKind = 'reserve' | 'confirm' | 'query'

function parse(
  argv: readonly string[],
): { resource: string; cwd: string } | string {
  let resource: string | undefined
  let cwd: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--resource' && value !== undefined) {
      resource = value
      index++
    } else if (arg === '--cwd' && value !== undefined) {
      cwd = value
      index++
    } else return `unknown argument: ${arg}`
  }
  if (resource === undefined || !resource.startsWith('/'))
    return '--resource must be an absolute path'
  if (cwd === undefined || !cwd.startsWith('/'))
    return '--cwd must be an absolute path'
  return { resource, cwd }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Read the host's answer to a reservation or query; anything unclear refuses. */
function decision(answer: unknown): DesktopDecision {
  if (answer && typeof answer === 'object') {
    const value = answer as { ok?: unknown; reason?: unknown; value?: unknown }
    if (value.ok === true)
      return typeof value.value === 'string'
        ? { ok: true, value: value.value }
        : { ok: true }
    if (typeof value.reason === 'string' && value.reason.length > 0)
      return { ok: false, reason: value.reason.slice(0, 500) }
  }
  return { ok: false, reason: '宿主拒绝了这次请求' }
}

export async function run(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const options = parse(argv)
  if (typeof options === 'string') {
    process.stderr.write(`qm desktop-exec: ${options}\n${USAGE}`)
    return 2
  }
  // The compiled binary routes worker selectors to omp's CLI
  // (`bin/compiled.ts`); from source the base loads its worker modules
  // directly, and qm's own entry must not be handed to them.
  if (process.env.QIANMO_OMP_ENTRY === 'self') declareWorkerHostEntry()
  const executor = new DesktopExecutor(options.resource, options.cwd)
  const pending = new Map<number, (answer: unknown) => void>()
  let sequence = 0
  const ask = (
    kind: GateKind,
    request: DesktopGateRequest,
    timeoutMs: number,
  ): Promise<unknown> =>
    new Promise(resolve => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(undefined)
      }, timeoutMs)
      pending.set(id, answer => {
        clearTimeout(timer)
        resolve(answer)
      })
      send({ type: 'gate', id, kind, request, timeoutMs })
    })
  const gateway: DesktopGateway = {
    reserve: async request => decision(await ask('reserve', request, 60_000)),
    confirm: async (request, timeoutMs) =>
      (await ask('confirm', request, timeoutMs)) === true,
    query: async request => decision(await ask('query', request, 60_000)),
  }
  const calls = new Set<Promise<void>>()
  const handle = (message: Record<string, unknown>) => {
    if (message.type === 'gate' && typeof message.id === 'number') {
      const settle = pending.get(message.id)
      pending.delete(message.id)
      settle?.(message.answer)
      return
    }
    if (message.type !== 'call' || typeof message.id !== 'number') return
    const { id, name, invocationId } = message
    if (
      typeof name !== 'string' ||
      !isDesktopTool(name) ||
      !isDesktopInvocationId(invocationId)
    ) {
      send({ type: 'error', id, message: 'Malformed desktop call' })
      return
    }
    // MCP carries no provider repair step: what the model sent is what runs.
    const call = executor
      .run(
        {
          name,
          invocationId,
          original: message.args,
          args: message.args,
          agentKind: 'main',
        },
        gateway,
      )
      .then(
        result => send({ type: 'result', id, result }),
        (error: unknown) =>
          send({
            type: 'error',
            id,
            message: error instanceof Error ? error.message : String(error),
          }),
      )
    calls.add(call)
    void call.finally(() => calls.delete(call))
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', line => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message && typeof message === 'object' && !Array.isArray(message))
      handle(message as Record<string, unknown>)
  })
  // The host closes stdin when the session ends: refuse what is still
  // waiting on a gate, let running calls settle, then release the tab and
  // the display session.
  lines.on('close', () => {
    for (const settle of pending.values()) settle(undefined)
    pending.clear()
    void Promise.allSettled([...calls])
      .then(() => executor.close())
      .finally(() => process.exit(0))
  })
  send({ type: 'ready' })
  return 0
}
