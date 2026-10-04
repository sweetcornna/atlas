// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 设置与关于 says what the startup banner says (P18.14, A4): the build, the
 * registry, the trails and the signing state reach the page from
 * `runConsole`, not only stdout. Driven end to end, as a child process under
 * the qianmo identity with a config root of its own, because the identity is
 * fixed when the process starts.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function consoleChild(configRoot: string, args: readonly string[]) {
  return Bun.spawn(
    [
      'bun',
      '-e',
      "const { runConsole } = await import('./src/cli/handlers/console.ts');" +
        " await runConsole(JSON.parse(process.env.QM_TEST_ARGS ?? '[]'))",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OCC_IDENTITY: 'qianmo',
        OCC_CONFIG_DIR: configRoot,
        QM_TEST_ARGS: JSON.stringify(args),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
}

/** The banner as `name → value`, read up to its last line. */
async function bannerOf(
  child: ReturnType<typeof consoleChild>,
): Promise<Map<string, string>> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('sourceCommit')) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }
  while (!text.endsWith('\n')) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }
  reader.releaseLock()
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+(.*)$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields.set(match[1], match[2])
    }
  }
  return fields
}

describe('qm console: 设置与关于 carries the banner facts (A4)', () => {
  test('the build and the registry on the page match the banner, and no token is on it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qianmo-about-'))
    roots.push(root)
    const child = consoleChild(root, ['--port', '0'])
    try {
      const banner = await bannerOf(child)
      const origin = banner.get('console') ?? ''
      const admin = banner.get('admin-token') ?? ''
      const view = banner.get('view-token') ?? ''
      const commit = banner.get('sourceCommit') ?? ''
      const registry = banner.get('registry') ?? ''
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(commit.length).toBeGreaterThan(0)
      expect(admin.length).toBeGreaterThanOrEqual(16)

      const page = await fetch(`${origin}/settings`, {
        headers: { authorization: `Bearer ${admin}`, accept: 'text/html' },
      })
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain('>构建<')
      expect(html).toContain(commit)
      expect(html).toContain(registry)
      expect(html).toContain('>唤醒签名<')
      expect(html).toContain('>对话签名<')
      expect(html).toContain('告警确认')
      expect(html.includes(admin)).toBe(false)
      expect(html.includes(view)).toBe(false)
    } finally {
      child.kill()
      await child.exited
    }
  }, 60_000)
})
