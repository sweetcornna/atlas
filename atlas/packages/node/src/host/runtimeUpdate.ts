// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Claude Code and Codex versions on this node (P31, `runtimes-channels.md`
 * §5): `runtime.versions` reports what the node would start, and
 * `runtime.update` installs an exact version of the official npm package
 * (`@anthropic-ai/claude-code`, `@openai/codex`) into a qianmo-owned prefix.
 * New runtime children start from there; running ones finish on the old
 * binary and are recycled when idle. npm's cache and config live under the
 * qianmo config root too: nothing here reads or writes the user's own
 * `~/.npm`, `~/.claude` or `~/.codex`.
 */

import { existsSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlOutcome } from '@qianmo/protocol'
import type { ControlHandler } from './control.js'
import type { ExternalRuntimeKind } from './runtimes/channel.js'

export const RUNTIME_PACKAGES: Readonly<Record<ExternalRuntimeKind, string>> = {
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
}

const COMMANDS: Readonly<Record<ExternalRuntimeKind, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
}

/** Exact versions only: no ranges, tags or URLs reach npm. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The npm prefix runtime updates install into. */
export function managedRuntimePrefix(): string {
  return qianmoConfigPath('runtimes', 'npm')
}

/** The installed binary of a managed runtime, when an update put one there. */
export function managedRuntimeBin(
  kind: ExternalRuntimeKind,
): string | undefined {
  const bin = path.join(
    managedRuntimePrefix(),
    'node_modules',
    '.bin',
    COMMANDS[kind],
  )
  return existsSync(bin) ? bin : undefined
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  /** The output went past `maxOutput` and was cut. */
  readonly truncated?: boolean
}

export type RunCommand = (
  argv: readonly string[],
  options: {
    readonly env: Record<string, string>
    readonly timeoutMs: number
    /** Default 4000 characters. */
    readonly maxOutput?: number
  },
) => Promise<RunResult>

/** Runs a command without a shell; output is capped. */
export const runCommand: RunCommand = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), options.timeoutMs)
  try {
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ])
    const max = options.maxOutput ?? 4_000
    return {
      code,
      stdout: stdout.slice(0, max),
      truncated: stdout.length > max,
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface RuntimeUpdateOptions {
  /** Binaries configured with `--claude-code-bin` / `--codex-bin`; those are not managed here. */
  readonly bins?: Partial<Record<ExternalRuntimeKind, string>>
  readonly run?: RunCommand
  readonly npm?: string
  /** A new binary is in place; idle children of this runtime may be recycled. */
  readonly onInstalled?: (kind: ExternalRuntimeKind) => void
}

function isKind(value: unknown): value is ExternalRuntimeKind {
  return value === 'claude-code' || value === 'codex'
}

/** The binary a new child of this runtime starts with. */
export function runtimeBin(
  kind: ExternalRuntimeKind,
  bins?: Partial<Record<ExternalRuntimeKind, string>>,
): string {
  return bins?.[kind] ?? managedRuntimeBin(kind) ?? COMMANDS[kind]
}

function env(): Record<string, string> {
  const prefix = managedRuntimePrefix()
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: qianmoConfigPath('runtimes', 'npm-home'),
    npm_config_cache: path.join(prefix, '.cache'),
    npm_config_userconfig: path.join(prefix, '.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    DISABLE_AUTOUPDATER: '1',
  }
}

export function runtimeControl(
  options: RuntimeUpdateOptions = {},
): ControlHandler {
  const run = options.run ?? runCommand
  const version = async (kind: ExternalRuntimeKind) => {
    try {
      const result = await run([runtimeBin(kind, options.bins), '--version'], {
        env: env(),
        timeoutMs: 15_000,
      })
      return result.code === 0
        ? (/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(result.stdout)?.[0] ?? null)
        : null
    } catch {
      return null
    }
  }
  return async (op, args): Promise<ControlOutcome> => {
    if (op === 'runtime.versions') {
      const out: Record<
        string,
        { version: string | null; managed: boolean; pinned: boolean }
      > = {}
      for (const kind of ['claude-code', 'codex'] as const)
        out[kind] = {
          version: await version(kind),
          managed:
            options.bins?.[kind] === undefined &&
            managedRuntimeBin(kind) !== undefined,
          pinned: options.bins?.[kind] !== undefined,
        }
      return { ok: true, value: out }
    }
    if (op !== 'runtime.update')
      return { ok: false, code: 'unsupported', message: '不支持此底层操作' }
    const kind = args['runtime']
    const wanted = args['version']
    if (!isKind(kind) || typeof wanted !== 'string' || !VERSION.test(wanted))
      return {
        ok: false,
        code: 'invalid',
        message: '需要 runtime（claude-code 或 codex）与确切的版本号',
      }
    if (options.bins?.[kind] !== undefined)
      return {
        ok: false,
        code: 'refused',
        message: '这个节点用启动参数指定了该底层的路径，不由阡陌更新',
      }
    const prefix = managedRuntimePrefix()
    mkdirSync(prefix, { recursive: true, mode: 0o700 })
    mkdirSync(qianmoConfigPath('runtimes', 'npm-home'), {
      recursive: true,
      mode: 0o700,
    })
    const installed = await run(
      [
        options.npm ?? 'npm',
        'install',
        '--prefix',
        prefix,
        '--save-exact',
        '--no-audit',
        '--no-fund',
        `${RUNTIME_PACKAGES[kind]}@${wanted}`,
      ],
      { env: env(), timeoutMs: 10 * 60_000 },
    ).catch(() => ({ code: -1, stdout: '' }))
    if (installed.code !== 0)
      return {
        ok: false,
        code: 'unreachable',
        message: `npm 安装 ${RUNTIME_PACKAGES[kind]}@${wanted} 失败`,
      }
    const now = await version(kind)
    if (now !== wanted)
      return {
        ok: false,
        code: 'unreachable',
        message: `安装后版本是 ${now ?? '未知'}，不是 ${wanted}`,
      }
    options.onInstalled?.(kind)
    return { ok: true, value: { runtime: kind, version: now } }
  }
}
