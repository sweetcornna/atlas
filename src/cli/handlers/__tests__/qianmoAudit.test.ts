// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import { RouterEventType, type RouterAuditEvent } from '@qianmo/router'
import { parseQianmoAuditArgs } from '../qianmoAudit.js'
import {
  auditTrailPath,
  routerTrailSink,
} from '../../../services/qianmo/auditTrail.js'

let root: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-audit-cli-'))
  // `CLAUDE_CONFIG_DIR`, not `OCC_CONFIG_DIR`: tests/preload.ts deletes the
  // latter, and occConfigDir() memoizes on both.
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

describe('audit CLI arguments', () => {
  test('the trail path comes from the config root, not from $HOME', () => {
    // CLAUDE.md §1.1②: every path is derived, and the audit trail in
    // particular must land under the Qianmo identity's own root.
    expect(auditTrailPath().startsWith(join(root, 'config'))).toBe(true)
    expect(parseQianmoAuditArgs(['--verify']).path).toBe(auditTrailPath())
  })

  test('a query with no criteria is refused rather than dumping the file', () => {
    // The trail grows forever; printing all of it by default is the least
    // useful thing this command could do.
    expect(() => parseQianmoAuditArgs([])).toThrow('at least one of')
  })

  test('--verify alone is a valid query', () => {
    expect(parseQianmoAuditArgs(['--verify']).verify).toBe(true)
  })

  test('timestamps accept both ISO and epoch milliseconds', () => {
    const iso = parseQianmoAuditArgs(['--from', '2026-08-14T00:00:00.000Z'])
    expect(iso.from).toBe(Date.parse('2026-08-14T00:00:00.000Z'))
    expect(parseQianmoAuditArgs(['--from', '1800000000000']).from).toBe(
      1_800_000_000_000,
    )
    expect(() => parseQianmoAuditArgs(['--from', 'yesterday'])).toThrow(
      'ISO timestamp',
    )
  })

  test('an unknown flag is refused, not ignored', () => {
    expect(() => parseQianmoAuditArgs(['--trace', 'x', '--all'])).toThrow(
      'unknown audit option',
    )
  })

  test('--limit must be a positive integer', () => {
    expect(parseQianmoAuditArgs(['--verify', '--limit', '5']).limit).toBe(5)
    expect(() => parseQianmoAuditArgs(['--verify', '--limit', '0'])).toThrow(
      'positive integer',
    )
  })
})

describe('the router sink', () => {
  test('a refusal reaches the trail with its chain keys intact', () => {
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    const sink = routerTrailSink(trail, 'node-b')
    const event: RouterAuditEvent = {
      type: RouterEventType.LoopDetected,
      at: 1_800_000_000_000,
      detail: {
        traceId: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        taskId: 'task-1',
        msgId: 'msg-1',
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        code: 'E_LOOP',
        hops: 'node-a -> node-b',
      },
    }
    sink(event)
    trail.close()

    const { records, intact } = readTrail(path)
    expect(intact).toBe(true)
    const record = records[0]
    expect(record?.source).toBe(AuditSource.Router)
    // The layer's own event name goes through unchanged — an operator holding a
    // log line should not have to translate it.
    expect(record?.kind).toBe('loop_detected')
    expect(record?.outcome).toBe('refused')
    expect(record?.taskId).toBe('task-1')
    expect(record?.peer).toBe('qianmo://node-a/planner')
    expect(record?.code).toBe('E_LOOP')
    expect(record?.node).toBe('node-b')
  })

  test('a capability denial is filed under the capability layer', () => {
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    routerTrailSink(
      trail,
      'node-b',
    )({
      type: RouterEventType.CapabilityDenied,
      at: 1,
      detail: { code: 'E_CAP_INSUFFICIENT', taskId: 't' },
    })
    trail.close()
    expect(readTrail(path).records[0]?.source).toBe(AuditSource.Capability)
  })

  test('a trail that cannot be written does not take the node down', () => {
    // Losing the node because its logbook is full would be strictly worse than
    // losing the line.
    const trail = new AuditTrail(join(root, 'nested', 'trail.ndjson'))
    trail.close()
    const sink = routerTrailSink(trail, 'node-b')
    rmSync(root, { recursive: true, force: true })
    expect(() =>
      sink({
        type: RouterEventType.RateLimited,
        at: 1,
        detail: { code: 'E_RATE_LIMITED' },
      }),
    ).not.toThrow()
  })
})
