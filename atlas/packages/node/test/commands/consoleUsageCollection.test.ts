// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import { FileUsageStore } from '@qianmo/console'
import { createAuditPort } from '../../src/commands/consolePorts.js'
import { startUsageCollection } from '../../src/commands/consoleUsage.js'

test('concurrent collector ticks await the in-flight audit instead of returning a stale snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-collection-'))
  const trail = new AuditTrail(join(root, 'audit.ndjson'))
  trail.append({
    at: Date.now(),
    node: 'worker',
    source: AuditSource.Resident,
    kind: 'usage.tokens',
    outcome: 'ok',
    taskId: 'task',
    detail: { input: 3, output: 2, cacheWrite: 1, cacheRead: 4 },
  })
  const usage = new FileUsageStore({
    path: join(root, 'usage.ndjson'),
    policy: { mode: 'shadow', person: {}, job: {}, global: {} },
  })
  const admission = usage.reserve(
    { kind: 'job', subject: 'job' },
    { operation: 'wake' },
  )
  if (!admission.ok) throw new Error('fixture admission failed')
  usage.bindTask(admission.reservationId, 'task', 'worker')
  const audit = createAuditPort({ path: trail.path })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let reads = 0
  const errors: unknown[] = []
  const collector = startUsageCollection(
    usage,
    [
      {
        node: 'worker',
        kind: 'authoritative',
        audit: {
          ...audit,
          read: async filter => {
            reads++
            await gate
            return audit.read(filter)
          },
        },
      },
    ],
    error => errors.push(error),
  )
  try {
    const first = collector.tick(),
      second = collector.tick()
    expect(first).toBe(second)
    let completed = false
    void second.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(reads).toBe(1)
    release()
    await second
    expect(
      (await usage.read()).rows.find(row => row.bucket === 'job:job'),
    ).toMatchObject({
      input: 3,
      output: 2,
      cacheWrite: 1,
      cacheRead: 4,
      charged: 6,
    })
    expect(errors).toEqual([])
  } finally {
    release()
    await collector.tick()
    collector.stop()
    usage.close()
    trail.close()
  }
})
