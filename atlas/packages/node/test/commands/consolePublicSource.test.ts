// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public edition's source link (AGPL §13, public-edition.md §0), end to
 * end through `qm console`: the pages link the configured repository at the
 * commit this build runs, and a build that cannot name one clean commit does
 * not start. Driven as a child process, like `consoleAbout.test.ts`, because
 * the edition and the commit are fixed when the process starts.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONSOLE_HELP_TEXT } from '../../src/commands/consoleArgs.js'

const CLI = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts')
const REPOSITORY = 'https://github.com/sweetcornna/atlas'
const SHA = 'e'.repeat(40)
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A config root with the smallest billing and tenancy configs that load. */
function publicRoot(): { root: string; args: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-public-source-'))
  roots.push(root)
  mkdirSync(join(root, 'config'), { recursive: true })
  const billing = join(root, 'billing.json')
  writeFileSync(
    billing,
    JSON.stringify({
      version: 1,
      currency: 'CNY',
      sourceUrl: REPOSITORY,
      plans: [
        {
          id: 'node-month',
          name: '单节点',
          priceCents: 100,
          periodDays: 30,
          nodes: 1,
        },
      ],
      channels: { redeem: { enabled: true } },
    }),
    { mode: 0o600 },
  )
  const tenancy = join(root, 'tenancy.json')
  writeFileSync(
    tenancy,
    JSON.stringify({
      version: 1,
      hubServer: 'hub',
      tenants: [],
      subjects: [],
      nodes: [],
      jobs: [],
      platformSubjects: [],
    }),
    { mode: 0o600 },
  )
  return {
    root,
    args: [
      '--port',
      '0',
      '--accounts',
      '--tenancy',
      tenancy,
      '--open-registration',
      '--registration-max-accounts',
      '10',
      '--providers',
      '--magpie',
      '--billing',
      billing,
    ],
  }
}

function publicConsole(root: string, args: readonly string[], commit: string) {
  return Bun.spawn(['bun', CLI, 'console', ...args], {
    env: {
      ...process.env,
      QIANMO_CONFIG_DIR: join(root, 'config'),
      QIANMO_EDITION: 'public',
      QIANMO_SOURCE_COMMIT: commit,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/** The banner's `console` origin, read until the banner's last line. */
async function originOf(
  child: ReturnType<typeof publicConsole>,
): Promise<string> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('sourceCommit')) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }
  reader.releaseLock()
  return /^console\s+(\S+)/m.exec(text)?.[1] ?? ''
}

describe('qm console, public edition: the source link names this build', () => {
  test('a -dirty build refuses to start and says why', async () => {
    const { root, args } = publicRoot()
    const child = publicConsole(root, args, `${SHA}-dirty`)
    const timer = setTimeout(() => child.kill(), 20_000)
    try {
      const code = await child.exited
      const stderr = await new Response(child.stderr).text()
      expect(code).toBe(1)
      expect(stderr).toContain('the public edition refuses to start')
      expect(stderr).toContain(`this build is ${SHA}-dirty`)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 30_000)

  test('a clean build links the repository at its commit', async () => {
    const { root, args } = publicRoot()
    const child = publicConsole(root, args, SHA)
    try {
      const origin = await originOf(child)
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const page = await fetch(`${origin}/plans`, {
        headers: { accept: 'text/html' },
      })
      const html = await page.text()
      expect(page.status).toBe(200)
      expect(html).toContain(`href="${REPOSITORY}/tree/${SHA}"`)
      expect(html).not.toContain(`href="${REPOSITORY}"`)
    } finally {
      child.kill()
      await child.exited
    }
  }, 30_000)
})

describe('qm console --help says what the public edition needs', () => {
  test('--billing names the clean build, the source link and live', () => {
    const start = CONSOLE_HELP_TEXT.indexOf('  --billing <abs path>')
    const end = CONSOLE_HELP_TEXT.indexOf('\n  --', start + 1)
    const billing = CONSOLE_HELP_TEXT.slice(start, end).replace(/\s+/g, ' ')
    expect(start).toBeGreaterThan(0)
    expect(billing).toContain('<sourceUrl>/tree/<build commit>')
    expect(billing).toContain('-dirty or unknown')
    expect(billing).toContain('"live": true')
    expect(billing).toContain('public-edition.md §0')
  })
})
