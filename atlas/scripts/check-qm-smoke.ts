#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Smoke test for the compiled `dist/qm-<platform>-<arch>` binary.
 *
 * Runs the binary the way a fleet node would meet it, in a closed environment:
 * an empty `HOME` and `QIANMO_CONFIG_DIR` under a fresh temp directory, a
 * minimal `PATH`, no credentials, no stdin. Four invocations must succeed:
 *
 *   qm --version        qm's own entry: `qm <version> (omp <version>) <commit>`
 *   qm agent --version  the in-process route into the oh-my-pi CLI
 *   qm resident --help  a lazily loaded command module bundled into the binary
 *   qm agent --smoke-test  omp's worker round trip (re-entry into compiled.ts)
 *
 * A failure prints the invocation, exit code and both streams; a bundling
 * regression (a command that cannot load, a native addon that cannot be
 * extracted) shows up here and not on the first node that runs it.
 *
 * Usage:
 *   bun atlas/scripts/check-qm-smoke.ts [<binary>]   default: dist/qm-<host>
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkResidentCompiled } from './check-resident-compiled.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')

interface Probe {
  args: string[]
  stdout: RegExp
}

const PROBES: Probe[] = [
  { args: ['--version'], stdout: /^qm \S+ \(omp \d+\.\d+\.\d+\S*\) \S+$/m },
  { args: ['agent', '--version'], stdout: /\d+\.\d+\.\d+/ },
  { args: ['resident', '--help'], stdout: /resident/i },
  // omp's own worker/broker round trip: proves worker re-entry reaches omp's
  // CLI from inside this binary (they re-enter Bun.main, which is compiled.ts).
  { args: ['agent', '--smoke-test'], stdout: /smoke-test: ok/ },
]

async function main(): Promise<number> {
  // Absolute before anything runs: the probes run with the sandbox as cwd, so a
  // relative argument (the fleet recipe passes `dist/qm-linux-x64`) would not
  // resolve there.
  const binary = resolve(
    process.argv[2] ??
      join(REPO_ROOT, 'dist', `qm-${process.platform}-${process.arch}`),
  )
  if (!existsSync(binary)) {
    console.error(
      `[qm-smoke] FAIL: ${binary} does not exist (run atlas:build:qm)`,
    )
    return 1
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'qm-smoke-'))
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: join(sandbox, 'home'),
    TMPDIR: sandbox,
    QIANMO_CONFIG_DIR: join(sandbox, 'config'),
    NO_COLOR: '1',
  }
  let failed = 0
  try {
    for (const probe of PROBES) {
      const label = `qm ${probe.args.join(' ')}`
      const result = Bun.spawnSync([binary, ...probe.args], {
        cwd: sandbox,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
      })
      const stdout = result.stdout.toString()
      const stderr = result.stderr.toString()
      if (result.exitCode === 0 && probe.stdout.test(stdout)) {
        console.log(
          `[qm-smoke] ok    ${label}: ${stdout.trim().split('\n')[0]}`,
        )
        continue
      }
      failed++
      console.error(`[qm-smoke] FAIL  ${label} (exit ${result.exitCode})`)
      console.error(`  stdout: ${stdout.trim().slice(0, 800)}`)
      console.error(`  stderr: ${stderr.trim().slice(0, 800)}`)
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
  if (failed > 0) return 1
  const resident = await checkResidentCompiled(binary)
  console.log(`[qm-smoke] ok    real resident extension: ${resident.root}`)
  console.log(`[qm-smoke] OK ${PROBES.length + 1} probes on ${binary}`)
  return 0
}

if (import.meta.main) process.exit(await main())
