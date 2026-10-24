#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Smoke test for the compiled `qmo` client (clients.md §2).
 *
 * Runs the binary in a closed environment — an empty home, a fresh
 * `QMO_CLIENT_DIR`, a minimal `PATH`, no stdin — the way a new computer meets
 * it, and checks that its commands load and answer: the version line, the
 * usage, `status` before any sign-in, `open` refusing without a pairing, a
 * plain-HTTP hub refused before anything is sent, a pairing code read from
 * standard input rather than the command line, a relative state
 * directory refused, and `agents --json` answering with one line (what it
 * lists depends on the computer; the catalog's built-in qianmopi never, since
 * the desktop app carries no `qm`).
 *
 * Usage:
 *   bun atlas/scripts/check-client-smoke.ts [<binary>]   default: dist/qmo-<host>
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { clientOutfile, hostTarget } from './build-client.ts'

interface Probe {
  readonly args: readonly string[]
  /** Fed to standard input; none when absent. */
  readonly stdin?: string
  readonly env?: Record<string, string>
  readonly exit: number
  readonly stdout?: RegExp
  readonly stderr?: RegExp
}

const PROBES: readonly Probe[] = [
  { args: ['--version'], exit: 0, stdout: /^qmo \d+\.\d+\.\d+ \S+$/m },
  { args: ['help'], exit: 0, stdout: /qmo sign-in <中枢地址>/ },
  { args: ['status'], exit: 0, stdout: /状态\s+还没登录/ },
  { args: ['open'], exit: 1, stderr: /还没登录/ },
  {
    args: ['sign-in', 'http://hub.example', '--code', 'X'],
    exit: 2,
    stderr: /https/,
  },
  // The code arrives on stdin and the hub (nothing listens there) is tried.
  {
    args: ['sign-in', 'http://127.0.0.1:9'],
    stdin: 'ABCD-EFGH-IJKL\n',
    exit: 1,
    stderr: /连不上中枢/,
  },
  {
    args: ['status'],
    env: { QMO_CLIENT_DIR: 'relative/qmo' },
    exit: 2,
    stderr: /绝对路径/,
  },
  {
    args: ['agents', '--json'],
    exit: 0,
    stdout: /^\{"agents":\[(?![^\n]*"id":"omp")[^\n]*\]\}\r?\n$/,
  },
]

function closedEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: join(root, 'home'),
    QMO_CLIENT_DIR: join(root, 'client'),
    PATH:
      process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin',
  }
  if (process.platform === 'win32') {
    for (const name of [
      'SystemRoot',
      'SYSTEMROOT',
      'USERPROFILE',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
    ]) {
      const value = process.env[name]
      if (value) env[name] = value
    }
  }
  return env
}

async function main(): Promise<number> {
  const binary = resolve(process.argv[2] ?? clientOutfile(hostTarget()))
  if (!existsSync(binary)) {
    console.error(
      `[client-smoke] no binary at ${binary} · run bun run atlas:build:client`,
    )
    return 1
  }
  const root = mkdtempSync(join(tmpdir(), 'qmo-smoke-'))
  let failed = 0
  try {
    for (const probe of PROBES) {
      const proc = Bun.spawn([binary, ...probe.args], {
        env: { ...closedEnv(root), ...probe.env },
        stdin: probe.stdin === undefined ? 'ignore' : Buffer.from(probe.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const ok =
        exit === probe.exit &&
        (probe.stdout === undefined || probe.stdout.test(stdout)) &&
        (probe.stderr === undefined || probe.stderr.test(stderr))
      if (ok) {
        console.log(`[client-smoke] ok   qmo ${probe.args.join(' ')}`)
        continue
      }
      failed += 1
      console.error(
        `[client-smoke] FAIL qmo ${probe.args.join(' ')} · exit ${exit} (want ${probe.exit})\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return failed === 0 ? 0 : 1
}

if (import.meta.main) process.exit(await main())
