// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * With the real pools (stand-in processes for omp and Claude Code): an agent
 * moves from qianmopi to an external runtime and back in the middle of one
 * conversation (P36.4); each move starts a native session on the new runtime
 * whose first turn carries the 「前情」 block (§6.3).
 */

import { afterEach, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  FileResidentSessionStore,
  OmpResidentTurnPort,
  ResidentSessionManager,
} from '@qianmo/resident'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import { ResidentRuntimePool } from '../../src/host/runtimes/composite.js'
import { ExternalRuntimePool } from '../../src/host/runtimes/pool.js'
import {
  readPortableTurns,
  portableLogPath,
} from '../../src/host/runtimes/portableLog.js'
import { isolatedRoot } from '../providers/fake.js'

const fixtures = join(import.meta.dir, 'fixtures')
const OMP = join(fixtures, 'resident-omp-agent.runner.ts')
const CLAUDE = join(fixtures, 'fake-claude-code.runner.ts')

let root: ReturnType<typeof isolatedRoot> | undefined
const children: ChildProcess[] = []
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill()
  if (root) rmSync(`${root.root}-workspace`, { recursive: true, force: true })
  root?.dispose()
  root = undefined
})

test('an agent moves from qianmopi to Claude Code and back mid-conversation', async () => {
  root = isolatedRoot()
  const cwd = `${root.root}-workspace`
  mkdirSync(cwd, { recursive: true })
  const ompPrompts = join(root.root, 'omp-prompts.ndjson')
  const agent = { agent: 'coder', cwd }
  let where = 'omp'
  const omp = new ResidentOmpPool({
    agents: [agent],
    memoryRoot: join(root.root, 'memory'),
    announce: async () => ({ status: 'queued' }),
    spawn: input => {
      const child = spawn(process.execPath, [OMP], {
        cwd: input.cwd,
        env: { ...input.env, QIANMO_FIXTURE_PROMPT_LOG: ompPrompts },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    },
  })
  const external = new ExternalRuntimePool({
    agents: [{ ...agent, runtime: 'claude-code' }],
    resolveLaunch: () => ({
      model: 'fake-model',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-runtime',
    }),
    memoryRoot: join(root.root, 'memory'),
    hostTools: { announce: async () => ({ status: 'sent' }) },
    spawn: input => {
      const child = spawn(process.execPath, [CLAUDE, ...input.argv.slice(1)], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    },
  })
  const pool = new ResidentRuntimePool(omp, external, {
    runtimeOf: () => where,
  })
  stops.push(() => pool.stop())
  const sessions = new ResidentSessionManager({
    connection: pool,
    store: new FileResidentSessionStore(
      join(root.root, 'resident', 'sessions.json'),
    ),
    agents: [agent],
  })
  await sessions.start()
  const id = sessions.sessionOf('coder')
  const port = new OmpResidentTurnPort(pool)
  const turn = (messageId: string, prompt: string) =>
    port.execute({ sessionId: id, messageId, prompt }, async () => {})

  expect(await turn('one', 'hello')).toMatchObject({ outcome: 'completed' })

  where = 'claude-code'
  await pool.invalidateAgent('coder')
  const moved = await turn('two', 'next')
  expect(moved.outcome).toBe('completed')
  const echoed = moved.outcome === 'completed' ? moved.content : ''
  expect(echoed).toStartWith(
    'echo(1): 「前情」这段对话之前在 qianmopi 上进行，现在换到了 Claude Code',
  )
  expect(echoed).toContain('[qianmopi] 用户：hello')
  expect(echoed).toContain('[qianmopi] 回答：fixture response')
  expect(echoed).toEndWith('next')
  expect(await turn('three', 'again')).toMatchObject({
    outcome: 'completed',
    content: 'echo(2): again',
  })

  where = 'omp'
  await pool.invalidateAgent('coder')
  expect(await turn('four', 'back')).toMatchObject({ outcome: 'completed' })
  const seen = readFileSync(ompPrompts, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as string)
  expect(seen[0]).toBe('hello')
  expect(seen.at(-1)).toContain('[Claude Code] 用户：again')
  expect(seen.at(-1)).toContain('[Claude Code] 回答：echo(2): again')
  expect(seen.at(-1)).toEndWith('back')

  // Crash recovery finds each input in the transcript it went to.
  for (const messageId of ['one', 'two', 'three', 'four'])
    expect(await pool.isAccepted(id, messageId)).toBe(true)
  expect(
    readPortableTurns(portableLogPath('coder', id)).map(one => one.runtime),
  ).toEqual(['omp', 'claude-code', 'claude-code', 'omp'])
})
