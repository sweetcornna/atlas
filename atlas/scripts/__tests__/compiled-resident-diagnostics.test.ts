// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Opt in with an already-built host binary. Each invocation keeps its own
// synthetic evidence; no real model, home, credential or remote node is used.
const binary = process.env.QIANMO_TEST_COMPILED_QM
const suite = binary ? describe : describe.skip
const checker = resolve(import.meta.dir, '..', 'check-resident-compiled.ts')

async function probe(status: 200 | 401, failAfterTurn = false) {
  const root = mkdtempSync(join(tmpdir(), 'compiled-diagnostics-test-'))
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { checkResidentCompiled } from ${JSON.stringify(checker)}; await checkResidentCompiled(${JSON.stringify(binary)}, ${failAfterTurn ? "async () => { throw new Error('private-canary-test-error-must-not-be-recorded') }" : 'undefined'}, { probeStatus: ${status} });`,
    ],
    {
      cwd: resolve(import.meta.dir, '..', '..', '..'),
      env: { PATH: '/usr/bin:/bin', TMPDIR: root },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const runs = readdirSync(root).filter(name =>
    name.startsWith('qm-compiled-resident-'),
  )
  expect(runs).toHaveLength(1)
  const evidence = join(root, runs[0] as string)
  const raw = readFileSync(join(evidence, 'diagnostics.json'), 'utf8')
  return { exitCode, stdout, stderr, evidence, raw, data: JSON.parse(raw) }
}

suite('compiled resident diagnostic evidence', () => {
  test('successful real native turn records each unchanged acceptance condition', async () => {
    const result = await probe(200)
    expect(result.exitCode).toBe(0)
    expect(result.data.status).toBe('passed')
    expect(result.data.conditions).toEqual({
      acked: true,
      probeStatusMatched: true,
      isTaskResultPayload: true,
      outcomeCompleted: true,
      contentMatched: true,
    })
    expect(
      result.data.probeResponses.some(
        (r: { status: number }) => r.status === 200,
      ),
    ).toBe(true)
    expect(result.data.tools).toMatchObject({
      resultCount: 3,
      protectedReadDenied: true,
      protectedWriteDenied: true,
      canaryObserved: false,
    })
    const report = JSON.parse(
      readFileSync(join(result.evidence, 'report.json'), 'utf8'),
    )
    expect(report.diagnostics.conditions).toEqual(result.data.conditions)
    expect(result.raw).not.toMatch(
      /private-canary-|fake-not-secret|compiled-resident-fixture-not-production|"cap"|privateKey/,
    )
  }, 120_000)

  test('401 probe fixture records the expected refusal and the real fallback turn', async () => {
    const result = await probe(401)
    expect(result.exitCode).toBe(0)
    expect(result.data.status).toBe('passed')
    expect(result.data.conditions.acked).toBe(true)
    expect(result.data.conditions.isTaskResultPayload).toBe(true)
    expect(result.data.conditions.probeStatusMatched).toBe(true)
    expect(
      result.data.probeResponses.some(
        (r: { status: number }) => r.status === 401,
      ),
    ).toBe(true)
    expect(result.data.tools.resultCount).toBe(3)
    expect(result.raw).not.toMatch(
      /private-canary-|fake-not-secret|compiled-resident-fixture-not-production|"cap"|privateKey/,
    )
  }, 120_000)

  test('failure after a real turn retains evidence without copying error contents', async () => {
    const result = await probe(200, true)
    expect(result.exitCode).not.toBe(0)
    expect(result.data.status).toBe('failed')
    expect(result.data.phase).toBe('after-turn')
    expect(existsSync(join(result.evidence, 'report.json'))).toBe(false)
    expect(result.data.conditions).toEqual({
      acked: true,
      probeStatusMatched: true,
      isTaskResultPayload: true,
      outcomeCompleted: true,
      contentMatched: true,
    })
    expect(result.data.tools.resultCount).toBe(3)
    expect(result.raw).not.toMatch(
      /private-canary-|fake-not-secret|compiled-resident-fixture-not-production|"cap"|privateKey/,
    )
  }, 120_000)
})
