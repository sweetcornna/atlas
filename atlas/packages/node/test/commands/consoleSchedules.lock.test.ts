// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ConsoleResult, ScheduleDraft } from '@qianmo/console'
import { ADDRESS, CountingChat } from '../../../console/test/accountsHarness.js'
import { ConsoleSchedules } from '../../src/commands/consoleSchedules.js'

const roots: string[] = [],
  books: ConsoleSchedules[] = []
afterEach(async () => {
  for (const book of books.splice(0)) {
    await book.idle()
    book.close()
  }
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}
const actor = {
  subject: 'legacy:admin',
  role: null,
  requestId: 'lock-fixture',
} as const
const draft: ScheduleDraft = {
  title: 'one send',
  prompt: 'fixture',
  target: ADDRESS,
  template: 'custom',
  when: { kind: 'interval', everyMinutes: 15 },
  timezone: 'UTC',
  direction: 'medium',
  channels: [],
  enabled: true,
  notifyOnlyAgent: false,
  timeoutMs: 600_000,
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-lock-'))
  roots.push(root)
  const directory = path.join(root, 'schedules'),
    chat = new CountingChat(),
    errors: string[] = []
  let now = 1_700_000_000_000
  const open = () => {
    const book = new ConsoleSchedules({
      directory,
      estopPath: path.join(root, 'ESTOP'),
      chat,
      now: () => now,
      onError: message => errors.push(message),
    })
    books.push(book)
    return book
  }
  return {
    root,
    directory,
    chat,
    errors,
    open,
    advance: () => {
      now += 15 * 60_000
    },
  }
}

test('two books tick the same directory concurrently: one send and a live read-only follower', async () => {
  const f = fixture(),
    owner = f.open()
  const schedule = value(await owner.save(draft, actor))
  const lock = JSON.parse(
    await Bun.file(path.join(f.directory, 'instance.lock')).text(),
  ) as { pid: number; at: string; nonce: string }
  expect(lock.pid).toBe(process.pid)
  expect(Number.isFinite(Date.parse(lock.at))).toBe(true)
  expect(lock.nonce).toMatch(/^[a-f0-9]{16}$/)
  const follower = f.open()
  f.advance()
  await Promise.all([owner.tick(), follower.tick(), follower.tick()])
  await owner.idle()
  await follower.idle()
  expect(f.chat.sends).toBe(1)
  const read = value(await follower.snapshot(actor))
  expect(read.schedules[0]!.id).toBe(schedule.id)
  expect(read.runs[0]!.outcome).toBe('running')
  expect(read.tickAt).toBeNull()
  expect(await follower.runNow(schedule.id, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  expect(f.chat.sends).toBe(1)
  expect(f.errors).toEqual([
    '定时任务目录已由另一实例持有；本实例只读，调度器未启动',
  ])
  follower.close()
  expect(
    JSON.parse(await Bun.file(path.join(f.directory, 'instance.lock')).text())
      .nonce,
  ).toBe(lock.nonce)
})

test('a dead PID lock is reclaimed and the next instance runs normally', async () => {
  const f = fixture()
  const first = f.open()
  value(await first.save(draft, actor))
  first.close()
  await Bun.write(
    path.join(f.directory, 'instance.lock'),
    JSON.stringify({
      pid: 2_147_483_647,
      at: new Date().toISOString(),
      nonce: 'a'.repeat(16),
    }),
  )
  const replacement = f.open()
  f.advance()
  await replacement.tick()
  await replacement.idle()
  expect(f.chat.sends).toBe(1)
  expect(
    JSON.parse(await Bun.file(path.join(f.directory, 'instance.lock')).text())
      .pid,
  ).toBe(process.pid)
  expect(f.errors).toEqual([])
})

test('an expired malformed token is reclaimed, but a fresh partial lock stays closed', async () => {
  const f = fixture()
  fs.mkdirSync(f.directory)
  const lockPath = path.join(f.directory, 'instance.lock')
  await Bun.write(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
      nonce: 'invalid',
    }),
  )
  const fresh = f.open()
  expect(await fresh.save(draft, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  fresh.close()
  fs.utimesSync(lockPath, new Date(0), new Date(0))
  const recovered = f.open()
  value(await recovered.save(draft, actor))
  f.advance()
  await recovered.tick()
  await recovered.idle()
  expect(f.chat.sends).toBe(1)
})

test('exclusive claim markers prevent resends even when the schedule checkpoint is rolled back', async () => {
  const f = fixture(),
    first = f.open()
  const schedule = value(await first.save(draft, actor))
  const bookPath = path.join(f.directory, 'schedules.json'),
    before = await Bun.file(bookPath).text()
  f.advance()
  await first.tick()
  await first.idle()
  first.close()
  expect(f.chat.sends).toBe(1)
  await Bun.write(bookPath, before)
  const recovered = f.open()
  await recovered.tick()
  await recovered.idle()
  expect(f.chat.sends).toBe(1)
  expect(value(await recovered.snapshot(actor)).runs[0]).toMatchObject({
    scheduleId: schedule.id,
    outcome: 'skipped',
    reason: '计划时刻已被认领',
  })
  expect(fs.readdirSync(path.join(f.directory, 'claims'))).toHaveLength(1)
})
