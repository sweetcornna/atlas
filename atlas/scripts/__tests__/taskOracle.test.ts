// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { verifyTaskOracle } from '../taskOracle'
const roots: string[] = []
function workspace(path: string, content: string) {
  const root = mkdtempSync(join(tmpdir(), 'qm-task-oracle-'))
  roots.push(root)
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return { root, file }
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
test('trusted address oracle compares randomized valid and malformed inputs', () => {
  const { root, file } = workspace(
    'atlas/packages/protocol/src/index.ts',
    String.raw`export function agentOf(raw) {
    if (typeof raw !== 'string') return null;
    const m = /^qianmo:\/\/([a-z0-9][a-z0-9_-]*[a-z0-9]|[a-z0-9])\/([a-z0-9][a-z0-9_-]*[a-z0-9]|[a-z0-9])$/.exec(raw);
    return m?.[2] ?? null;
  }`,
  )
  expect(verifyTaskOracle('protocol-agent-of', root).passed).toBe(true)
  writeFileSync(file, 'export function agentOf() { return null }')
  expect(verifyTaskOracle('protocol-agent-of', root).passed).toBe(false)
})
test('trusted retry oracle distinguishes scheduled maximum jitter from a real thaw', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../packages/transport/src/backoff.ts'),
    'utf8',
  )
  const { root, file } = workspace(
    'atlas/packages/transport/src/backoff.ts',
    source,
  )
  expect(verifyTaskOracle('transport-jitter-freeze', root).passed).toBe(true)
  writeFileSync(
    file,
    source.replace(
      'this.expectedRetryAt = now + delayMs',
      'this.expectedRetryAt = now',
    ),
  )
  expect(verifyTaskOracle('transport-jitter-freeze', root).passed).toBe(false)
})
test('protected receipt runtime exports must still load and match independently of printed summaries', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../packages/transport/src/frames.ts'),
    'utf8',
  ).replace(
    "import { ProtocolErrorCode } from '@qianmo/protocol'",
    'const ProtocolErrorCode = {}',
  )
  const { root, file } = workspace(
    'atlas/packages/transport/src/frames.ts',
    source,
  )
  expect(verifyTaskOracle('transport-success-receipt-type', root).passed).toBe(
    true,
  )
  writeFileSync(
    file,
    String.raw`console.error('\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 tests across 1 file.'); process.exit(0)`,
  )
  expect(verifyTaskOracle('transport-success-receipt-type', root).passed).toBe(
    false,
  )
})
