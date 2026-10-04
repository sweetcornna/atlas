// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The preload against a developer machine that holds a ChatGPT subscription
 * login (design `providers-console-m1.md` §9.2 P18.12: "preload 之后，开发机带
 * 订阅登录态时 codexPinnedSearch 不再红").
 *
 * The machine is constructed, not real: a temporary HOME whose
 * `.codex/auth.json` carries JWT-shaped placeholder tokens, plus the shell
 * variables such a machine exports. Each run is a separate `bun test`
 * process, because the preload acts once per process before any test file
 * loads.
 *
 * Positive control: the same probe under a bunfig without the preload goes
 * red — so the green above it is the preload's doing, not the probe's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const PROBE = 'tests/support/__tests__/codexLoginIsolation.test.ts'
const CODEX_PINNED_SEARCH =
  'packages/builtin-tools/src/tools/WebSearchTool/__tests__/codexPinnedSearch.test.ts'
const SPAWN_TIMEOUT_MS = 120_000

function jwtSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

let root: string
let subscriptionHome: string
let bunfigWithoutPreload: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'occ-preload-isolation-'))
  subscriptionHome = join(root, 'home')
  mkdirSync(join(subscriptionHome, '.codex'), { recursive: true })
  const token = `${jwtSegment({ alg: 'none' })}.${jwtSegment({
    exp: 4_102_444_800,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' },
  })}.sig`
  writeFileSync(
    join(subscriptionHome, '.codex', 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: token,
        access_token: token,
        refresh_token: 'rt-test-canary-not-real',
        account_id: 'acct-test',
      },
      last_refresh: '2026-10-03T00:00:00Z',
    }),
  )
  bunfigWithoutPreload = join(root, 'bunfig.toml')
  writeFileSync(
    bunfigWithoutPreload,
    `[test]\nroot = ${JSON.stringify(REPO_ROOT)}\ntimeout = 10000\n`,
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function runTests(
  files: string[],
  options: { preload: boolean },
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      ...(options.preload ? [] : [`--config=${bunfigWithoutPreload}`]),
      'test',
      ...files,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        TMPDIR: tmpdir(),
        HOME: subscriptionHome,
        // What a shell set up for the subscription carries.
        OPENAI_AUTH_MODE: 'chatgpt',
        OPENAI_API_KEY: 'sk-test-canary-developer-shell',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, output: `${stdout}\n${stderr}` }
}

describe('test preload on a machine with a ChatGPT subscription login', () => {
  test(
    'codexPinnedSearch and the pre-266ad4b8 assertion are green',
    async () => {
      const run = await runTests([CODEX_PINNED_SEARCH, PROBE], {
        preload: true,
      })
      expect({
        exitCode: run.exitCode,
        failed: /\(fail\)/.test(run.output),
      }).toEqual({ exitCode: 0, failed: false })
      expect(run.output).toMatch(/\b8 pass\b/)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'control: without the preload the same probe takes the ChatGPT route',
    async () => {
      const run = await runTests([PROBE], { preload: false })
      expect(run.exitCode).not.toBe(0)
      expect(run.output).toContain('chatgpt.com/backend-api/codex/responses')
    },
    SPAWN_TIMEOUT_MS,
  )
})
