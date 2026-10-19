// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConsoleMainAgent } from '../../src/commands/consoleMainAgent.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function fileIn(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-agent-'))
  roots.push(root)
  return path.join(root, 'console', 'main-agent.json')
}

test('a choice survives a restart, and null clears it', async () => {
  const file = fileIn()
  const first = new ConsoleMainAgent({ path: file, now: () => 1 })
  expect(first.get()).toBeNull()
  expect(await first.set('qianmo://tokyo-1/planner', 'u:abc')).toEqual({
    ok: true,
    value: null,
  })
  expect(first.get()).toBe('qianmo://tokyo-1/planner')
  expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    v: 1,
    address: 'qianmo://tokyo-1/planner',
    updatedAt: 1,
    updatedBy: 'u:abc',
  })
  const again = new ConsoleMainAgent({ path: file })
  expect(again.get()).toBe('qianmo://tokyo-1/planner')
  await again.set(null, 'legacy:admin')
  expect(new ConsoleMainAgent({ path: file }).get()).toBeNull()
})

test('a bad address is refused and nothing is written', async () => {
  const file = fileIn()
  const port = new ConsoleMainAgent({ path: file })
  const result = await port.set('https://evil.example/x', 'u:abc')
  expect(result.ok).toBe(false)
  expect(fs.existsSync(file)).toBe(false)
})

test('a broken file reads as unset and says so', () => {
  const file = fileIn()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"v":1,"address":"not an address"')
  const warnings: string[] = []
  const port = new ConsoleMainAgent({
    path: file,
    warn: line => warnings.push(line),
  })
  expect(port.get()).toBeNull()
  expect(warnings).toHaveLength(1)
})
