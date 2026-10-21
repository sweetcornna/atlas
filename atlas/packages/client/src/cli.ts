#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qmo`, the 阡陌 client for Windows and Linux (clients.md). With no command
 * it opens the front when this computer is signed in, and prints the usage
 * otherwise.
 */

import pkg from '../package.json' with { type: 'json' }
import {
  type ClientIO,
  openFront,
  signIn,
  signOut,
  status,
  systemDeps,
} from './commands.js'
import { ClientError } from './hub.js'

declare const QMO_SOURCE_COMMIT: string | undefined

export const USAGE = `qmo — 阡陌客户端

用法：
  qmo sign-in <中枢地址> [--code <配对码>] [--name <设备名>] [--force]
  qmo open
  qmo status
  qmo sign-out
  qmo --version

配对码在中枢「连接」页「添加设备」里拿；不带 --code 时会提示输入。`

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
const BOOLEAN_FLAGS = new Set(['--force'])

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

function value(parsed: Parsed, name: string): string | undefined {
  const found = parsed.flags.get(name)
  return typeof found === 'string' ? found : undefined
}

export async function main(
  argv: readonly string[],
  io: ClientIO,
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
  const deps = systemDeps(io)
  try {
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
            '用法：qmo sign-in <中枢地址> [--code <配对码>]',
            2,
          )
        const code = value(parsed, '--code')
        const name = value(parsed, '--name')
        return await signIn(deps, {
          hub,
          ...(code === undefined ? {} : { code }),
          ...(name === undefined ? {} : { name }),
          force: parsed.flags.get('--force') === true,
        })
      }
      case 'open':
      case 'status':
      case 'sign-out':
        if (parsed.positional.length > 0 || parsed.flags.size > 0)
          throw new ClientError(`qmo ${command} 不带参数`, 2)
        return command === 'open'
          ? await openFront(deps)
          : command === 'status'
            ? await status(deps)
            : await signOut(deps)
      default:
        throw new ClientError(`不认识的命令：${command}\n\n${USAGE}`, 2)
    }
  } catch (error) {
    if (error instanceof ClientError) {
      io.err(error.message)
      return error.exitCode
    }
    throw error
  }
}

const consoleIO: ClientIO = {
  out: line => console.log(line),
  err: line => console.error(line),
  ask: question => (process.stdin.isTTY ? prompt(question) : null),
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), consoleIO))
