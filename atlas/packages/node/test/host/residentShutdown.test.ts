// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createMessage, MessageType } from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { QianmoResident } from '../../src/host/resident.js'
import { isolatedRoot } from '../providers/fake.js'

function isAlive(child: ChildProcess): boolean {
  try {
    process.kill(child.pid!, 0)
    return true
  } catch {
    return false
  }
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('resident shutdown condition did not settle')
}

for (const fault of ['audit', 'activity'] as const) {
  test(`real resident reaps before its next generation when ${fault} cleanup throws`, async () => {
    const root = isolatedRoot()
    const children: ChildProcess[] = []
    const errors: string[] = []
    const generationsAfterReap: boolean[] = []
    let ready = 0,
      active = false,
      faults = 0
    const socket = join(root.root, 'r.sock')
    const fixture = join(
      import.meta.dir,
      'fixtures/resident-omp-agent.runner.ts',
    )
    const failure = new Error(`synthetic ${fault} IO failure`)
    const resident = new QianmoResident({
      node: 'node-b',
      team: 'nest',
      agents: [{ agent: 'reviewer', cwd: join(root.root, 'workspace') }],
      memoryRoot: join(root.root, 'memory'),
      psk: 'shutdown-test-local-psk',
      listen: { unix: socket },
      inactivityMs: 0,
      pollIntervalMs: 20,
      ompRestart: { initialBackoffMs: 10 },
      beforeModelGeneration: async () => {
        if (children.length > 0)
          generationsAfterReap.push(!isAlive(children.at(-1)!))
      },
      usageEndAudit: () => {
        if (fault === 'audit') {
          faults++
          throw failure
        }
      },
      onActivity: value => {
        if (value) active = true
        if (!value && fault === 'activity') {
          faults++
          throw failure
        }
      },
      spawnOmp: () => {
        const child = spawn(
          process.execPath,
          [
            '-e',
            `process.on('SIGTERM',()=>{}); await import(${JSON.stringify(fixture)}); setInterval(()=>{},1000)`,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' },
          },
        )
        children.push(child)
        return child
      },
      onTiming: event => {
        if (event.stage === 'runtime_ready') ready++
      },
      onError: error => errors.push(String(error)),
    })
    const running = resident.run()
    void running.catch(() => {})
    let client: TransportClient | undefined
    try {
      await until(() => ready === 1)
      client = new TransportClient({
        endpoint: { unix: socket },
        node: 'node-a',
        psk: 'shutdown-test-local-psk',
        keepAliveIntervalMs: 0,
        onMessage: () => {},
      })
      await client.connect()
      await client.sendAndWait(
        createMessage({
          from: 'qianmo://node-a/planner',
          to: 'qianmo://node-b/reviewer',
          type: MessageType.TaskRequest,
          payload: { round: 'hold' },
        }),
        3_000,
      )
      await until(() => active)
      // Inject the broken wire at the real child stream boundary. The process
      // stays alive and ignores TERM; only the host's eventual KILL reaps it.
      children[0]!.stdout!.emit('data', Buffer.from('malformed-json\n'))
      await until(() => ready === 2)
      expect(faults).toBeGreaterThan(0)
      expect(errors.some(error => error.includes(failure.message))).toBe(true)
      expect(generationsAfterReap).toEqual([true])
      expect(children).toHaveLength(2)
      expect(children.map(isAlive)).toEqual([false, true])
      expect(children[0]!.signalCode).toBe('SIGKILL')
    } finally {
      resident.stop()
      for (const child of children) child.kill('SIGKILL')
      await client?.close()
      await running
      root.dispose()
    }
    expect(children.every(child => !isAlive(child))).toBe(true)
  }, 12_000)
}
