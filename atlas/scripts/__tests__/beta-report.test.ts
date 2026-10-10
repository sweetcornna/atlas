// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AuditSource, AuditTrail, type AuditRecord } from '@qianmo/audit'
import { betaReport, type Window, type Probe } from '../beta-report/core.js'

const window: Window = {
  from: 0,
  to: 180000,
  bucketMs: 60000,
  workerNodes: ['a', 'b'],
  lanes: [{ node: 'a', probe: 'endpoint', intervalMs: 60000 }],
}
const wakeWindow: Window = {
  ...window,
  lanes: [{ node: 'a', probe: 'wake', intervalMs: 60000 }],
}
const probe = (at: number, ok = true, extra: Partial<Probe> = {}): Probe => ({
  t: new Date(at).toISOString(),
  node: 'a',
  probe: 'endpoint',
  ok,
  ms: 100,
  detail: '',
  ...extra,
})
const message = (
  msgId: string,
  at: number,
  type = 'task.request',
  from = 'qianmo://a/dev',
  to = 'qianmo://b/dev',
): AuditRecord => ({
  seq: 1,
  prev: '0'.repeat(64),
  at,
  source: AuditSource.Transport,
  kind: 'message_accepted',
  outcome: 'ok',
  node: 'b',
  msgId,
  taskId: `task-${msgId}`,
  detail: { messageType: type, from, to },
})

test('missing sampling periods reduce availability; conflicting retries cannot hide failure', () => {
  const r = betaReport(
    window,
    [probe(1000), probe(2000, false), probe(61000)],
    [],
    [],
  )
  expect(r.availability[0]).toMatchObject({
    expected: 3,
    observed: 2,
    success: 1,
    failed: 1,
    missing: 1,
    duplicates: 1,
    availability: 1 / 3,
  })
  expect(r.wake.p95UpperMs).toBeNull()
  expect(r.collaboration.continuouslyRising).toBeNull()
})

test('empty, skipped and out-of-window samples cannot establish SLA', () => {
  const r = betaReport(
    window,
    [probe(1000, true, { detail: 'skipped:low-mem' }), probe(180000)],
    [],
    [],
  )
  expect(r.availability[0]).toMatchObject({
    success: 0,
    failed: 1,
    missing: 2,
    availability: 0,
  })
  expect(r.wake.evaluable).toBe(false)
  expect(r.collaboration.trend.every(b => !b.evaluable)).toBe(true)
})

test('latency joins exact node+msgId, preserves failures as infinite and second precision bounds', () => {
  const r = betaReport(
    wakeWindow,
    [
      probe(5000, true, { probe: 'wake', ms: 200, detail: 'msgId=w' }),
      probe(7000, false, { probe: 'wake' }),
    ],
    [
      { node: 'wrong', stage: 'first_content', at: 5100, networkMsgId: 'w' },
      { node: 'a', stage: 'first_content', at: 6400, networkMsgId: 'w' },
    ],
    [],
  )
  expect(r.wake.samples[0]).toMatchObject({
    status: 'observed',
    latencyLowerMs: 601,
    latencyUpperMs: 1600,
  })
  expect(r.wake.p95UpperMs).toBe('infinite')
  expect(r.wake.evaluable).toBe(false)
})

test('missing first content and reversed clocks are explicit, never HTTP-ACK latency', () => {
  const probes = [
    probe(5000, true, { probe: 'wake', ms: 100, detail: 'msgId=x' }),
    probe(6000, true, { probe: 'wake', detail: 'msgId=y' }),
  ]
  const r = betaReport(
    wakeWindow,
    probes,
    [{ node: 'a', stage: 'first_content', at: 2, networkMsgId: 'x' }],
    [],
  )
  expect(r.wake.samples.map(p => p.status)).toEqual([
    'clock-invalid',
    'missing-content',
  ])
  expect(r.wake.p95UpperMs).toBe('infinite')
})

test('unsampled planned wakes and duplicate successes cannot manufacture a good P95', () => {
  const p = probe(5000, true, { probe: 'wake', ms: 200, detail: 'msgId=w' })
  const times = [
    { node: 'a', stage: 'first_content', at: 6400, networkMsgId: 'w' },
  ]
  const r = betaReport(
    wakeWindow,
    [p, p, { ...p, t: new Date(65000).toISOString() }],
    times,
    [],
  )
  expect(r.wake).toMatchObject({
    count: 3,
    sampleCount: 3,
    missing: 2,
    duplicateWakeSamples: 2,
    p95UpperMs: 'infinite',
    evaluable: false,
  })
  expect(betaReport(window, [p], times, []).wake).toMatchObject({
    count: 0,
    p95UpperMs: null,
    evaluable: false,
  })
})

test('deduplicates msgId, excludes entire probe task and controls, isolates old unknown metadata', () => {
  const work = message('w', 1000),
    probeTask = message('p', 2000),
    reply = { ...message('r', 3000, 'task.result'), taskId: probeTask.taskId }
  const old = { ...message('old', 70000), detail: undefined }
  const r = betaReport(
    window,
    [probe(2000, true, { probe: 'wake', detail: 'msgId=p' })],
    [],
    [
      work,
      work,
      probeTask,
      reply,
      message('ack', 4000, 'ack'),
      message('ui', 5000, 'task.request', 'qianmo://hub/console'),
      old,
    ],
  )
  expect(r.collaboration.trend[0]).toMatchObject({
    total: 2,
    collaboration: 1,
    probes: 2,
    control: 1,
    ratio: 0.5,
    evaluable: true,
  })
  expect(r.collaboration.trend[1]).toMatchObject({
    total: 0,
    unknown: 1,
    ratio: null,
    evaluable: false,
  })
  expect(r.collaboration.duplicateMessages).toBe(1)
  expect(r.collaboration.continuouslyRising).toBeNull()
})

test('rising requires three populated complete windows; ties and declines fail', () => {
  const rows = [
    message('1', 1, 'task.request', 'qianmo://hub/console'),
    message('2', 60001),
    message('3', 60002, 'task.request', 'qianmo://hub/console'),
    message('4', 120001),
  ]
  expect(
    betaReport(window, [], [], rows).collaboration.continuouslyRising,
  ).toBe(true)
  expect(
    betaReport(
      window,
      [],
      [],
      [...rows, message('5', 120002, 'task.request', 'qianmo://hub/console')],
    ).collaboration.continuouslyRising,
  ).toBe(false)
})

test('conflicting message identity and malformed samples fail closed', () => {
  expect(() =>
    betaReport(window, [], [], [message('x', 1), message('x', 2, 'notify')]),
  ).toThrow('conflicting')
  expect(() =>
    betaReport(window, [probe(1, true, { ms: -1 })], [], []),
  ).toThrow('invalid probe')
  expect(() => betaReport({ ...window, to: 0 }, [], [], [])).toThrow('window')
  expect(() =>
    betaReport(
      { ...window, lanes: [window.lanes[0]!, window.lanes[0]!] },
      [],
      [],
      [],
    ),
  ).toThrow('duplicate')
})

test('actual read-only CLI emits provenance, rejects damaged chains and torn sample files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-beta-report-')),
    audit = join(root, 'audit.ndjson')
  const trail = new AuditTrail(audit)
  const { seq: _seq, prev: _prev, ...input } = message('cli', 1)
  trail.append(input)
  trail.close()
  writeFileSync(join(root, 'probe.ndjson'), JSON.stringify(probe(1)) + '\n')
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      ...window,
      probes: ['probe.ndjson'],
      timings: [],
      audits: ['audit.ndjson'],
    }),
  )
  const before = readFileSync(audit)
  const run = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve('atlas/scripts/beta-report.ts'),
        join(root, 'manifest.json'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    return {
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    }
  }
  const good = await run()
  expect(good.code).toBe(0)
  expect(JSON.parse(good.out).provenance).toHaveLength(2)
  expect(readFileSync(audit).equals(before)).toBe(true)
  writeFileSync(audit, before.toString().replace('task.request', 'task.result'))
  // With a single-record chain, integrity needs a successor to attest its prefix.
  writeFileSync(audit, 'broken\n')
  expect((await run()).code).not.toBe(0)
  writeFileSync(audit, before)
  writeFileSync(join(root, 'probe.ndjson'), JSON.stringify(probe(1)))
  expect((await run()).error).toContain('torn source tail')
})
