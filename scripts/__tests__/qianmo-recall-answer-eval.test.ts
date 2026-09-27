// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer-layer command line (P16.3): the live request is AC-4's, the
 * live mode skips without credentials and touches nothing, the dry run
 * works offline, and no flag can move the ledger or change a preregistered
 * value.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseCli } from '../qianmo-recall-answer-eval.js'
import {
  buildWireBody,
  liveCredentials,
  loadProviders,
  MAX_TOKENS,
  wireByteLength,
} from '../qianmo-recall-answer-live.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(REPO_ROOT, 'scripts/qianmo-recall-answer-eval.ts')

const directories: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-answer-cli-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** The environment minus the credentials and any config-dir override. */
function envWithout(...names: string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of names) delete env[name]
  return env
}

function runCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
) {
  const result = Bun.spawnSync([process.execPath, 'run', CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('the live request is the AC-4 request', () => {
  const system = ['instructions', '<qianmo-memory>block</qianmo-memory>']

  test('max_tokens 8192, one neutral tool, identical across providers, no seed', () => {
    const providers = loadProviders()
    expect(providers.map(p => p.id)).toEqual(['qianmo-deepseek', 'qianmo-alt'])
    const wires = providers.map(provider =>
      buildWireBody(
        provider,
        { system, turns: [{ role: 'user', text: '问题' }] },
        // Only the body's shape depends on it; no endpoint is written here.
        provider.baseUrl,
      ),
    )
    for (const wire of wires) {
      expect(wire['max_tokens'] ?? wire['max_completion_tokens']).toBe(
        MAX_TOKENS,
      )
      expect(wire['seed']).toBeUndefined()
      expect(wire['response_format']).toBeUndefined()
      expect(JSON.stringify(wire['tools'])).toContain('qianmo_memory_answer')
      expect(wireByteLength(wire)).toBeGreaterThan(
        JSON.stringify(system).length,
      )
    }
    expect(JSON.stringify(wires[0]?.['tools'])).toBe(
      JSON.stringify(wires[1]?.['tools']),
    )
  })

  test('the second round carries the model turn and the rejection as the tool result', () => {
    const [deepseek] = loadProviders()
    if (deepseek === undefined) throw new Error('fixture changed')
    const wire = buildWireBody(
      deepseek,
      {
        system,
        turns: [
          { role: 'user', text: '问题' },
          {
            role: 'assistant',
            thinking: '先查一下',
            text: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'qianmo_memory_answer',
                input: { answer: 'a', citations: ['qm-mem-deadbeef00000000'] },
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call-1',
            content: 'The answer was rejected',
          },
        ],
      },
      deepseek.baseUrl,
    )
    const messages = wire['messages'] as Record<string, unknown>[]
    const assistant = messages.find(m => m['role'] === 'assistant')
    const tool = messages.find(m => m['role'] === 'tool')
    expect(JSON.stringify(assistant?.['tool_calls'])).toContain('call-1')
    expect(tool?.['tool_call_id']).toBe('call-1')
    expect(String(tool?.['content'])).toContain('rejected')
  })

  test('credentials come from the environment only', () => {
    expect(liveCredentials({})).toEqual({ skip: 'OPENAI_API_KEY 未设置' })
    expect(liveCredentials({ OPENAI_API_KEY: 'k' })).toEqual({
      skip: 'OPENAI_BASE_URL 未设置',
    })
    expect(
      liveCredentials({
        OPENAI_API_KEY: 'k',
        OPENAI_BASE_URL: 'u',
        QIANMO_PROVIDER_LIVE: '0',
      }),
    ).toEqual({ skip: 'QIANMO_PROVIDER_LIVE=0 —— 显式关闭了真调用' })
    expect(
      liveCredentials({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'u' }),
    ).toEqual({ apiKey: 'k', baseURL: 'u' })
  })
})

describe('command line', () => {
  test('live without credentials: skipped, exit 0, no ledger and no output written', () => {
    const config = scratch()
    const out = join(config, 'out')
    const result = runCli(
      [
        '--live',
        '--phase',
        'trial',
        '--run-id',
        't1',
        '--out',
        out,
        '--cap-input',
        '1000',
        '--cap-output',
        '1000',
      ],
      {
        ...envWithout('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR'),
        OCC_CONFIG_DIR: config,
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('真调用已跳过')
    expect(existsSync(join(config, 'qianmo'))).toBe(false)
    expect(existsSync(out)).toBe(false)
  }, 60_000)

  test('dry run: offline estimate of a small plan', () => {
    const json = join(scratch(), 'estimate.json')
    const result = runCli(
      ['--dry-run', '--corpus', 'docs-dev-v1', '--tiers', '30', '--json', json],
      envWithout('OPENAI_API_KEY'),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('D-7 批准量级')
    const [only] = JSON.parse(readFileSync(json, 'utf8')) as {
      estimate: { total: { calls: number }; rows: { questions: number }[] }
    }[]
    // 20 questions × 2 providers × 1 repetition × M0 only (trial defaults).
    expect(only?.estimate.total.calls).toBe(40)
    expect(only?.estimate.rows.map(r => r.questions)).toEqual([20])
  }, 60_000)

  test('dry run without flags: the preregistered trial (202 calls) and comparison (1 460 calls)', () => {
    const json = join(scratch(), 'estimate.json')
    const result = runCli(
      ['--dry-run', '--json', json],
      envWithout('OPENAI_API_KEY'),
    )
    expect(result.exitCode).toBe(0)
    const [trial, comparison] = JSON.parse(readFileSync(json, 'utf8')) as {
      phase: string
      estimate: {
        total: {
          calls: number
          input: { high: number }
          output: { high: number }
        }
        rows: { corpus: string; tier: number; questions: number }[]
      }
    }[]
    expect(trial?.phase).toBe('trial')
    expect(trial?.estimate.total.calls).toBe(202)
    // Within P16.4's sub-cap of a tenth of 18.5 M / 4.8 M.
    expect(trial?.estimate.total.input.high).toBeLessThanOrEqual(1_850_000)
    expect(trial?.estimate.total.output.high).toBeLessThanOrEqual(480_000)
    expect(comparison?.phase).toBe('comparison')
    expect(comparison?.estimate.total.calls).toBe(1460)
    const perTier = new Map<string, number>()
    for (const row of comparison?.estimate.rows ?? []) {
      const key = `${row.corpus}/${row.tier}`
      perTier.set(key, (perTier.get(key) ?? 0) + row.questions)
    }
    expect(Object.fromEntries(perTier)).toEqual({
      'synthetic-v1/30': 101,
      'synthetic-v1/500': 101,
      'synthetic-v1/2000': 101,
      'docs-dev-v1/599': 62,
    })
  }, 120_000)

  test('the comparison takes no plan flag', () => {
    const result = runCli(
      ['--dry-run', '--phase', 'comparison', '--reps', '3'],
      envWithout('OPENAI_API_KEY'),
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('the comparison plan is prereg.toml [plan]')
  }, 60_000)

  test('no flag moves the ledger or sets a preregistered value', () => {
    for (const flag of ['--ledger', '--alpha', '--delta', '--bootstrap-seed']) {
      expect(() => parseCli([flag, 'x'])).toThrow(/unknown flag/)
    }
    expect(() =>
      parseCli(['--live', '--phase', 'trial', '--run-id', 'r', '--out', 'o']),
    ).toThrow(/--cap-input and --cap-output/)
    expect(() => parseCli(['--live', '--dry-run'])).toThrow(/choose one/)
    expect(parseCli([]).mode).toBe('dry-run')
  })
})
