#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qmo`, the 阡陌 client for Windows and Linux (clients.md). With no command
 * it opens the front when this computer is signed in, and prints the usage
 * otherwise.
 */

import pkg from '../package.json' with { type: 'json' }
import { formatAgents, scanAgents } from './agents.js'
import {
  type ClientDeps,
  type ClientIO,
  enterSession,
  forgetDevice,
  openFront,
  signIn,
  signOut,
  status,
  statusReport,
  systemDeps,
} from './commands.js'
import { serveStdio } from './code/serve.js'
import { ClientError, type ClientErrorKind } from './hub.js'

declare const QMO_SOURCE_COMMIT: string | undefined

export const USAGE = `qmo — 阡陌客户端

用法：
  qmo sign-in <中枢地址> [--name <设备名>] [--force] [--json]
  qmo open
  qmo status [--json]
  qmo sign-out [--json]
  qmo session --json
  qmo agents [--json] [--rescan]
  qmo code serve
  qmo --version

配对码在中枢「连接」页「添加设备」里拿。qmo sign-in 会提示输入；
不在终端里运行时，从标准输入读一行。
也可以用 --code <配对码>，但命令行对这台电脑上的其他用户可见。

--json 给桌面版读：标准输出只有一行 JSON，出错时是
{"error":{"kind":…,"message":…}}，退出码按 kind 区分。
qmo session --json 打开一个会话，输出它的 cookie，只给桌面版用。
qmo agents 列出这台电脑上装了的编程 agent；版本等结果会缓存，
--rescan 全部重新查。
qmo code serve 是本机会话的运行器，只给桌面版用。`

export function versionLine(): string {
  const commit =
    typeof QMO_SOURCE_COMMIT === 'string' && QMO_SOURCE_COMMIT !== ''
      ? QMO_SOURCE_COMMIT
      : (process.env.QIANMO_SOURCE_COMMIT ?? 'unknown')
  return `qmo ${pkg.version} ${commit}`
}

interface Parsed {
  readonly positional: string[]
  readonly flags: Map<string, string | true>
}

const VALUE_FLAGS = new Set(['--code', '--name'])
const BOOLEAN_FLAGS = new Set(['--force', '--json', '--rescan'])

/**
 * The exit code of a `--json` run, one per kind of error, for a caller that
 * reads only the code. Without `--json` the codes stay 0, 1 and 2.
 */
export const JSON_EXIT_CODES: Readonly<Record<ClientErrorKind, number>> = {
  refused: 1,
  usage: 2,
  signed_in: 2,
  signed_out: 3,
  revoked: 4,
  invalid: 4,
  device_kind: 4,
  owner_inactive: 5,
  unsupported: 6,
  network: 7,
  bad_code: 8,
  throttled: 9,
}

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    if (BOOLEAN_FLAGS.has(name) && eq < 0) flags.set(name, true)
    else if (VALUE_FLAGS.has(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1)
      if (value === undefined || value === '')
        throw new ClientError(`${name} 需要一个值`, 2)
      flags.set(name, value)
    } else throw new ClientError(`不认识的选项：${arg}`, 2)
  }
  return { positional, flags }
}

/** Longest line read from a pipe; a pairing code is 14 characters. */
const MAX_LINE = 1024

/** The first line of `input` without its line ending; `null` when it is empty. */
export async function firstLine(
  input: ReadableStream<Uint8Array>,
): Promise<string | null> {
  const reader = input.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      const end = text.indexOf('\n')
      if (end >= 0) return text.slice(0, end).replace(/\r$/, '')
      if (text.length > MAX_LINE) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  text += decoder.decode()
  return text === '' ? null : text.replace(/\r$/, '')
}

function value(parsed: Parsed, name: string): string | undefined {
  const found = parsed.flags.get(name)
  return typeof found === 'string' ? found : undefined
}

/** Only these commands answer in JSON. */
const JSON_COMMANDS = new Set([
  'sign-in',
  'status',
  'sign-out',
  'session',
  'agents',
])

/** The device a `--json` error was about, when this computer is signed in. */
function deviceOf(deps: ClientDeps | undefined): Record<string, string> {
  try {
    const state = deps?.home.load()
    return state === undefined
      ? {}
      : { hub: state.hub, deviceId: state.deviceId, name: state.name }
  } catch {
    return {}
  }
}

export async function main(
  argv: readonly string[],
  io: ClientIO,
  agents: typeof scanAgents = scanAgents,
  code: typeof serveStdio = serveStdio,
): Promise<number> {
  const [command, ...rest] = argv
  if (command === '--version' || command === '-v' || command === 'version') {
    io.out(versionLine())
    return 0
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE)
    return 0
  }
  const json =
    command !== undefined &&
    JSON_COMMANDS.has(command) &&
    rest.includes('--json')
  let deps: ClientDeps | undefined
  try {
    // A relative QMO_CLIENT_DIR fails here, as a message rather than a trace.
    // With --json the person-facing lines stay off standard output, and the
    // pairing code is read from standard input without a prompt.
    deps = systemDeps(
      json
        ? {
            out: () => {},
            err: line => io.err(line),
            ask: question => (io.readLine ?? io.ask)(question),
          }
        : io,
    )
    if (command === undefined) {
      if (deps.home.load() === undefined) {
        io.out(USAGE)
        return 0
      }
      return await openFront(deps)
    }
    const parsed = parse(rest)
    switch (command) {
      case 'sign-in': {
        const [hub, ...extra] = parsed.positional
        if (hub === undefined || extra.length > 0)
          throw new ClientError(
            '用法：qmo sign-in <中枢地址>（配对码随后输入）',
            2,
          )
        const code = value(parsed, '--code')
        const name = value(parsed, '--name')
        const exit = await signIn(deps, {
          hub,
          ...(code === undefined ? {} : { code }),
          ...(name === undefined ? {} : { name }),
          force: parsed.flags.get('--force') === true,
        })
        if (json) io.out(JSON.stringify(deviceOf(deps)))
        return exit
      }
      case 'session':
        if (!json || parsed.positional.length > 0 || parsed.flags.size > 1)
          throw new ClientError(
            'qmo session 只给桌面版用：qmo session --json',
            2,
          )
        io.out(JSON.stringify(await enterSession(deps)))
        return 0
      case 'agents': {
        const rescan = parsed.flags.get('--rescan') === true
        const extra = parsed.flags.size - (json ? 1 : 0) - (rescan ? 1 : 0)
        if (parsed.positional.length > 0 || extra > 0)
          throw new ClientError('qmo agents 只接受 --json 与 --rescan', 2)
        const report = await agents({
          cacheFile: deps.home.agentsCache,
          rescan,
        })
        if (json) io.out(JSON.stringify(report))
        else for (const line of formatAgents(report)) io.out(line)
        return 0
      }
      case 'code': {
        // Standard output is the runner's protocol from here on.
        if (
          parsed.positional.length !== 1 ||
          parsed.positional[0] !== 'serve' ||
          parsed.flags.size > 0
        )
          throw new ClientError('用法：qmo code serve（只给桌面版用）', 2)
        return await code({
          codeDir: deps.home.codeDir,
          clientDir: deps.home.dir,
          agentsCache: deps.home.agentsCache,
        })
      }
      case 'open':
      case 'status':
      case 'sign-out': {
        const extra = parsed.flags.size - (json ? 1 : 0)
        if (
          parsed.positional.length > 0 ||
          extra > 0 ||
          (json && command === 'open')
        )
          throw new ClientError(
            command === 'open'
              ? 'qmo open 不带参数'
              : `qmo ${command} 只接受 --json`,
            2,
          )
        if (command === 'open') return await openFront(deps)
        if (command === 'status') {
          if (!json) return await status(deps)
          io.out(JSON.stringify(await statusReport(deps)))
          return 0
        }
        if (!json) return await signOut(deps)
        // Signed out here whatever the hub said; `result` says what it said.
        io.out(JSON.stringify({ result: await forgetDevice(deps) }))
        return 0
      }
      default:
        throw new ClientError(`不认识的命令：${command}\n\n${USAGE}`, 2)
    }
  } catch (error) {
    if (error instanceof ClientError) {
      if (json) {
        io.out(
          JSON.stringify({
            error: { kind: error.kind, message: error.message },
            ...deviceOf(deps),
          }),
        )
        return JSON_EXIT_CODES[error.kind]
      }
      io.err(error.message)
      return error.exitCode
    }
    throw error
  }
}

const consoleIO: ClientIO = {
  out: line => console.log(line),
  err: line => console.error(line),
  // Typed at a terminal, or piped in, so the pairing code is on no command line.
  ask: async question =>
    process.stdin.isTTY ? prompt(question) : firstLine(Bun.stdin.stream()),
  readLine: async () => firstLine(Bun.stdin.stream()),
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), consoleIO))
