// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * State isolation between qm and the oh-my-pi agent it runs as a child.
 *
 * qm keeps everything under one config root (`QIANMO_CONFIG_DIR`, default
 * `~/.qianmo`) and puts omp's own state at `<root>/omp`, so a node, the user's
 * own omp installation and the official Claude Code can share a machine
 * without touching each other's config, credentials or sessions. Path
 * resolution reads HOME and the environment, so every observation is a fresh
 * process (identityProbe.runner.ts) with a throwaway HOME.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const PROBE = join(import.meta.dir, 'identityProbe.runner.ts')
const QM = join(import.meta.dir, '..', '..', 'src', 'cli.ts')

type QmReport = {
  configDir: string
  ompConfigRoot: string
  ompAgentDir: string
  caDir: string
  memoryBaseDir: string
  protectedRoots: string[]
}

type OmpReport = { configRoot: string; agentDir: string }

let home: string
let elsewhere: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qm-isolation-home-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'qm-isolation-root-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

/** A clean environment: the inherited one minus every state-moving variable, with HOME thrown away. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^(QIANMO_|QMCODE_|PI_|OMP_|XDG_)/.test(key)) continue
    if (key === 'CLAUDE_CONFIG_DIR') continue
    env[key] = value
  }
  env.HOME = home
  env.USERPROFILE = home
  return { ...env, ...extra }
}

function spawn(cmd: string[], env: Record<string, string>) {
  const result = Bun.spawnSync(cmd, {
    env,
    cwd: home,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `${cmd.join(' ')} exited ${result.exitCode}: ${result.stderr.toString()}`,
    )
  }
  return result.stdout.toString()
}

function probe(command: 'qm', env: Record<string, string>): QmReport
function probe(command: 'omp', env: Record<string, string>): OmpReport
function probe(command: 'qm' | 'omp', env: Record<string, string>) {
  return JSON.parse(spawn([process.execPath, 'run', PROBE, command], env))
}

describe('qm paths', () => {
  test('default root is ~/.qianmo with omp nested at <root>/omp', () => {
    const report = probe('qm', cleanEnv())

    expect(report.configDir).toBe(join(home, '.qianmo'))
    expect(report.ompConfigRoot).toBe(join(home, '.qianmo', 'omp'))
    expect(report.ompAgentDir).toBe(join(home, '.qianmo', 'omp', 'agent'))
    expect(report.memoryBaseDir).toBe(join(home, '.qianmo'))
  })

  test('QIANMO_CONFIG_DIR moves the root and omp with it', () => {
    const report = probe('qm', cleanEnv({ QIANMO_CONFIG_DIR: elsewhere }))

    expect(report.configDir).toBe(elsewhere)
    expect(report.ompAgentDir).toBe(join(elsewhere, 'omp', 'agent'))
  })

  test('CLAUDE_CONFIG_DIR does not relocate anything (no fallback)', () => {
    const report = probe('qm', cleanEnv({ CLAUDE_CONFIG_DIR: elsewhere }))

    expect(report.configDir).toBe(join(home, '.qianmo'))
  })

  test('the CA directory stays outside every config root', () => {
    const report = probe('qm', cleanEnv())

    expect(report.caDir).toBe(join(home, '.qianmo-ca'))
    for (const root of report.protectedRoots) {
      expect(report.caDir === root || report.caDir.startsWith(`${root}/`)).toBe(
        false,
      )
    }
  })

  test('every product that may share the machine is protected', () => {
    const report = probe('qm', cleanEnv({ QIANMO_CONFIG_DIR: elsewhere }))

    for (const dir of ['.qianmo', '.omp', '.claude', '.codex', '.qmcode']) {
      expect(report.protectedRoots).toContain(join(home, dir))
    }
    expect(report.protectedRoots).toContain(elsewhere)
  })
})

describe('omp child confinement', () => {
  test('a hostile environment cannot move omp out of the qm root', () => {
    const report = probe(
      'omp',
      cleanEnv({
        QIANMO_CONFIG_DIR: elsewhere,
        // Everything the guard has to scrub: profile, agent dir, XDG, Claude.
        // The cleanEnv filter drops these, so set them on top of it.
        OMP_PROFILE: 'work',
        PI_CODING_AGENT_DIR: join(home, 'agent-elsewhere'),
        XDG_DATA_HOME: join(home, 'xdg'),
        XDG_STATE_HOME: join(home, 'xdg'),
        XDG_CACHE_HOME: join(home, 'xdg'),
        XDG_CONFIG_HOME: join(home, 'xdg'),
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
      }),
    )

    expect(report.configRoot).toBe(join(elsewhere, 'omp'))
    expect(report.agentDir).toBe(join(elsewhere, 'omp', 'agent'))
  })

  test('the default root puts omp state under ~/.qianmo/omp', () => {
    const report = probe('omp', cleanEnv())

    expect(relative(home, report.agentDir)).toBe(
      join('.qianmo', 'omp', 'agent'),
    )
  })

  test('`qm agent` writes only under the root; ~/.omp and ~/.claude stay absent', () => {
    spawn(
      [process.execPath, QM, 'agent', 'config', 'list'],
      cleanEnv({ QIANMO_CONFIG_DIR: elsewhere }),
    )

    expect(existsSync(join(elsewhere, 'omp', 'agent', 'agent.db'))).toBe(true)
    expect(existsSync(join(home, '.omp'))).toBe(false)
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect(existsSync(join(home, '.qianmo'))).toBe(false)
  })
})
