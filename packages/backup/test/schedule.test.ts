// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  BackupScheduler,
  FileSnapshotStore,
  type CancelTimer,
  type Scheduler,
} from '../src/index.js'
import { cleanupTemporaries, tempDir } from './helpers.js'

afterEach(cleanupTemporaries)

/** A scheduler a test drives by hand: no sleeping, no wall clock. */
class ManualScheduler implements Scheduler {
  #pending: Array<{ delayMs: number; callback: () => void }> = []

  after(delayMs: number, callback: () => void): CancelTimer {
    const entry = { delayMs, callback }
    this.#pending.push(entry)
    return () => {
      this.#pending = this.#pending.filter(item => item !== entry)
    }
  }

  get pending(): number {
    return this.#pending.length
  }

  /** Fire everything armed right now, once. */
  async fire(): Promise<void> {
    const due = this.#pending
    this.#pending = []
    for (const entry of due) entry.callback()
    // Snapshots are async; let their promises settle before asserting.
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function newStore(): FileSnapshotStore {
  return new FileSnapshotStore({ root: join(tempDir(), 'backups') })
}

describe('the two triggers', () => {
  test('a pre-task snapshot is labelled with the task it precedes', async () => {
    const store = newStore()
    const scheduler = new BackupScheduler({
      workspace: '/workspace',
      writer: store.writer(),
      archive: async () => new Uint8Array([1, 2, 3]),
    })
    const meta = await scheduler.beforeTask('task-42')
    expect(meta?.reason).toBe('pre-task')
    expect(meta?.label).toBe('task-42')
  })

  test('the periodic one re-arms from the end of the previous snapshot', async () => {
    // `setInterval` does not replay missed ticks (E4), so a frozen node would
    // silently skip beats and keep its old phase. Re-arming after completion
    // bounds the gap instead, which is the property that matters.
    const store = newStore()
    const scheduler = new ManualScheduler()
    const backups = new BackupScheduler({
      workspace: '/workspace',
      writer: store.writer(),
      scheduler,
      intervalMs: 1_000,
      archive: async () => new Uint8Array([1]),
    })
    backups.start()
    expect(scheduler.pending).toBe(1)
    await scheduler.fire()
    expect(await store.list('/workspace')).toHaveLength(1)
    expect(scheduler.pending).toBe(1)
    await scheduler.fire()
    expect(await store.list('/workspace')).toHaveLength(2)
    backups.stop()
    expect(scheduler.pending).toBe(0)
  })

  test('start is idempotent and stop actually stops', async () => {
    const store = newStore()
    const scheduler = new ManualScheduler()
    const backups = new BackupScheduler({
      workspace: '/w',
      writer: store.writer(),
      scheduler,
      archive: async () => new Uint8Array([1]),
    })
    backups.start()
    backups.start()
    expect(scheduler.pending).toBe(1)
    backups.stop()
    await scheduler.fire()
    expect(await store.list('/w')).toHaveLength(0)
  })
})

describe('failures are loud, not fatal', () => {
  test('a failed snapshot reports and the schedule survives', async () => {
    const store = newStore()
    const scheduler = new ManualScheduler()
    const errors: unknown[] = []
    let attempt = 0
    const backups = new BackupScheduler({
      workspace: '/w',
      writer: store.writer(),
      scheduler,
      intervalMs: 10,
      archive: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('tar exploded')
        return new Uint8Array([1])
      },
      onError: error => errors.push(error),
    })
    backups.start()
    await scheduler.fire()
    expect(errors.map(String)).toEqual(['Error: tar exploded'])
    // Refusing to work because a backup failed would turn a recoverable outage
    // into an outright one.
    expect(scheduler.pending).toBe(1)
    await scheduler.fire()
    expect(await store.list('/w')).toHaveLength(1)
    backups.stop()
  })

  test('two snapshots of one workspace do not overlap', async () => {
    // Archiving a workspace while a previous archive of it is still running is
    // a good way to store two half-states.
    const store = newStore()
    let running = 0
    let overlapped = false
    const backups = new BackupScheduler({
      workspace: '/w',
      writer: store.writer(),
      archive: async () => {
        running += 1
        if (running > 1) overlapped = true
        await new Promise(resolve => setTimeout(resolve, 10))
        running -= 1
        return new Uint8Array([1])
      },
    })
    const [first, second] = await Promise.all([
      backups.beforeTask('a'),
      backups.once('b'),
    ])
    expect(overlapped).toBe(false)
    // The second caller joins the in-flight snapshot rather than starting one.
    expect(second?.id).toBe(first?.id as string)
    expect(await store.list('/w')).toHaveLength(1)
  })
})
