// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The assertion `codexPinnedSearch.test.ts` made before 266ad4b8, kept as
 * written: with nothing pinned and a non-official `OPENAI_BASE_URL`, the
 * search lane goes to that endpoint with the session key.
 *
 * It went red on a developer machine holding a ChatGPT login: a stored login
 * deliberately wins for a non-official endpoint (`codexAdapter.ts`
 * `shouldUseChatGPTAuth`), and the login was read from the developer's own
 * `~/.codex/auth.json` and `OPENAI_AUTH_MODE`. 266ad4b8 moved the test onto
 * the official endpoint, which hides the leak instead of closing it. The
 * preload now closes it (`tests/support/credentialEnv.ts`); this file is
 * green only because of that — `preloadIsolation.test.ts` runs it with and
 * without the preload under a constructed subscription login.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { occConfigDir } from 'src/config/paths.js'
import { reloadPinnedSearchCredentials } from 'src/services/search/searchCredentialStore.js'
import { CodexSearchAdapter } from '../../../packages/builtin-tools/src/tools/WebSearchTool/adapters/codexAdapter.js'

const SEARCH_SSE =
  'data: {"type":"response.output_item.done","item":{"type":"web_search_call","action":{"type":"search","query":"q","sources":[]}}}\n\n' +
  'data: {"type":"response.completed","response":{"output":[]}}\n\n'

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_MODEL',
  'OCC_CONFIG_DIR',
] as const
const saved = new Map<string, string | undefined>()
let tempDir: string

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  tempDir = mkdtempSync(join(tmpdir(), 'occ-codex-login-isolation-'))
  process.env.OCC_CONFIG_DIR = tempDir
  // Keeps getMainLoopModel() out of the auth stack (same as the original).
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
})

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
  rmSync(tempDir, { recursive: true, force: true })
})

test('with nothing pinned, a non-official endpoint gets the session key', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-canary-session'
  process.env.OPENAI_BASE_URL = 'https://api.openai.test/v1'
  const calls: { url: string; auth: string | undefined }[] = []
  const fetchOverride = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), auth: headers.Authorization })
    return new Response(SEARCH_SSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  await new CodexSearchAdapter({ fetchOverride }).search('q', {})

  expect(calls).toEqual([
    {
      url: 'https://api.openai.test/v1/responses',
      auth: 'Bearer sk-test-canary-session',
    },
  ])
})
