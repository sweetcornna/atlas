// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { ResidentSupervisor } from '@qianmo/resident'
import { OmpRpcProcess, ResidentOmpPool } from '../../src/host/residentOmp.js'
import { isolatedRoot } from '../providers/fake.js'

test('stop can escalate a graceful shutdown immediately while sharing the promise until real close', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {});
      setInterval(() => {}, 1000);
      process.stdout.write(JSON.stringify({type:'ready'}) + '\\n');
      `,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const signals: (NodeJS.Signals | number | undefined)[] = []
  const kill = child.kill.bind(child)
  child.kill = signal => {
    signals.push(signal)
    return kill(signal)
  }
  let actualClose = false
  child.once('close', () => {
    actualClose = true
  })
  const channel = new OmpRpcProcess(child)
  try {
    await channel.initialize()
    const graceful = channel.stop(false)
    expect(signals).toEqual([])
    const immediate = channel.stop(true)
    expect(signals).toEqual(['SIGTERM'])
    expect(immediate).toBe(graceful)
    expect(actualClose).toBe(false)
    await Promise.all([graceful, immediate])

    expect(actualClose).toBe(true)
    expect(child.signalCode).toBe('SIGTERM')
    expect(() => process.kill(child.pid!, 0)).toThrow()
  } finally {
    kill('SIGKILL')
    await channel.stop()
  }
}, 5_000)

test('never-ready children time out, are reaped and park after every slow startup is counted', async () => {
  const root = isolatedRoot()
  const children: ChildProcess[] = []
  const waits: number[] = []
  const errors: string[] = []
  const parked: number[] = []
  let clock = 0
  const supervisor = new ResidentSupervisor({
    start: async () => {
      // Keep the old infinite-restart regression bounded.
      if (children.length === 3) supervisor.stop()
      const pool = new ResidentOmpPool({
        agents: [{ agent: 'reviewer', cwd: root.root }],
        memoryRoot: join(root.root, 'memory'),
        announce: async () => ({ status: 'queued' }),
        readyTimeoutMs: 20,
        spawn: input => {
          expect(children.every(child => child.signalCode !== null)).toBe(true)
          const child = spawn(
            process.execPath,
            ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'],
            { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
          )
          children.push(child)
          return child
        },
      })
      try {
        await pool.newSession({ agent: 'reviewer', cwd: root.root })
        return pool
      } catch (error) {
        await pool.stop()
        // Model the production 30 s ready budget without spending it in the test.
        clock += 30_000
        throw error
      }
    },
    stableAfterMs: 10_000,
    maxRapidFailures: 3,
    initialBackoffMs: 2_000,
    now: () => clock,
    wait: async delay => {
      waits.push(delay)
    },
    onError: error => errors.push(String(error)),
    onParked: failures => parked.push(failures),
  })
  try {
    await supervisor.run()
    expect(children).toHaveLength(3)
    expect(errors).toEqual(Array(3).fill('Error: omp RPC ready timed out'))
    expect(waits).toEqual([2_000, 4_000])
    expect(parked).toEqual([3])
    expect(supervisor.parked).toBe(true)
    for (const child of children) {
      expect(child.signalCode).toBe('SIGTERM')
      expect(() => process.kill(child.pid!, 0)).toThrow()
    }
  } finally {
    supervisor.stop()
    for (const child of children) child.kill('SIGKILL')
    root.dispose()
  }
}, 5_000)

for (const phase of ['ready', 'open_session'] as const) {
  test(`pool stop terminates a child waiting for ${phase} immediately and waits for real close`, async () => {
    const root = isolatedRoot()
    const reached = Promise.withResolvers<void>()
    const children: ChildProcess[] = []
    const signals: (NodeJS.Signals | number | undefined)[] = []
    let closed = false
    const pool = new ResidentOmpPool({
      agents: [{ agent: 'reviewer', cwd: root.root }],
      memoryRoot: join(root.root, 'memory'),
      announce: async () => ({ status: 'queued' }),
      spawn: input => {
        const child = spawn(
          process.execPath,
          [
            '-e',
            `
            process.stdin.on('data', () => process.stderr.write('request\\n'));
            process.stdin.on('end', () => {});
            setInterval(() => {}, 1000);
            ${phase === 'open_session' ? 'process.stdout.write(\'{"type":"ready"}\\n\');' : ''}
          `,
          ],
          { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        const kill = child.kill.bind(child)
        child.kill = signal => {
          signals.push(signal)
          return kill(signal)
        }
        child.once('close', () => {
          closed = true
        })
        children.push(child)
        if (phase === 'ready') reached.resolve()
        else child.stderr!.once('data', () => reached.resolve())
        return child
      },
    })
    const opening = pool.newSession({ agent: 'reviewer', cwd: root.root })
    void opening.catch(() => {})
    let deadline: Timer | undefined
    try {
      await reached.promise
      const stopped = pool.stop()
      expect(signals).toContain('SIGTERM')
      expect(closed).toBe(false)
      await Promise.race([
        stopped,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('stop waited for startup timeout')),
            1_000,
          )
        }),
      ])
      await expect(opening).rejects.toThrow('child exited')
      expect(closed).toBe(true)
      expect(pool.alive).toBe(false)
      expect(children[0]!.signalCode).toBe('SIGTERM')
      expect(() => process.kill(children[0]!.pid!, 0)).toThrow()
      await expect(pool.channelFor('late')).rejects.toThrow('pool is closed')
      expect(children).toHaveLength(1)
    } finally {
      clearTimeout(deadline)
      for (const child of children) child.kill('SIGKILL')
      await pool.stop()
      await opening.catch(() => {})
      root.dispose()
    }
  }, 5_000)
}

test('a child that becomes ready but never responds cannot strand startup', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => process.exit(0));
  `,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const channel = new OmpRpcProcess(child)
  try {
    await channel.initialize()
    await expect(channel.request('open_session', {}, 20)).rejects.toThrow(
      'open_session timed out',
    )
  } finally {
    await channel.stop()
  }
  expect(channel.alive).toBe(false)
}, 5_000)

test('protocol failure cannot start the next generation before the actual child closes', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      process.on('SIGTERM', () => {});
      process.stdin.on('data', () => process.stdout.write('not-json\\n'));
      process.stdin.on('end', () => {});
      setInterval(() => {}, 1000);
      process.stdout.write(JSON.stringify({type:'ready'}) + '\\n');
      `,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let actualClose = false
  child.once('close', () => {
    actualClose = true
  })
  const channel = new OmpRpcProcess(child)
  await channel.initialize()
  child.stdin!.write('break\n')
  await expect(channel.closed).rejects.toThrow()
  expect(actualClose).toBe(false)
  expect(() => process.kill(child.pid!, 0)).not.toThrow()
  let starts = 0
  const supervisor = new ResidentSupervisor({
    initialBackoffMs: 1,
    start: async () => {
      if (++starts === 1) return channel
      expect(actualClose).toBe(true)
      expect(() => process.kill(child.pid!, 0)).toThrow()
      supervisor.stop()
      return { closed: Promise.resolve(), stop() {} }
    },
  })
  try {
    await supervisor.run()
    expect(starts).toBe(2)
    expect(child.signalCode).toBe('SIGKILL')
  } finally {
    child.kill('SIGKILL')
    supervisor.stop()
    await channel.stop()
  }
}, 6_000)

test('pool shutdown tracks a retired session, joins concurrent stops and blocks late reopening', async () => {
  const root = isolatedRoot()
  const children: ReturnType<typeof spawn>[] = []
  let closed = 0
  const pool = new ResidentOmpPool({
    agents: [{ agent: 'reviewer', cwd: root.root }],
    memoryRoot: join(root.root, 'memory'),
    announce: async () => ({ status: 'queued' }),
    spawn: () => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
          const {createInterface} = require('node:readline');
          process.on('SIGTERM', () => {});
          process.stdin.on('end', () => {});
          setInterval(() => {}, 1000);
          createInterface({input:process.stdin}).on('line', line => {
            const request = JSON.parse(line);
            process.stdout.write(JSON.stringify({type:'response',id:request.id,success:true})+'\\n');
          });
          process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
          `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      child.once('close', () => closed++)
      children.push(child)
      return child
    },
  })
  try {
    const session = await pool.newSession({ agent: 'reviewer', cwd: root.root })
    pool.closeSession(session)
    const reopening = pool.channelFor(session)
    void reopening.catch(() => {})
    const one = pool.stop()
    const two = pool.stop()
    expect(one).toBe(two)
    expect(closed).toBe(0)
    expect(children).toHaveLength(1)
    await Promise.all([one, two])
    await expect(reopening).rejects.toThrow('pool is closed')
    expect(children).toHaveLength(1)
    expect(closed).toBe(1)
    expect(children[0]!.signalCode).toBe('SIGKILL')
    expect(() => process.kill(children[0]!.pid!, 0)).toThrow()
  } finally {
    for (const child of children) child.kill('SIGKILL')
    await pool.stop()
    root.dispose()
  }
}, 6_000)

test('failed signals are not exit evidence, even after protocol liveness has failed', async () => {
  const child = spawn(
    process.execPath,
    ['-e', `process.stdin.resume(); setInterval(() => {}, 1000);`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const channel = new OmpRpcProcess(child)
  const originalKill = child.kill.bind(child)
  let killAttempt!: () => void
  const attempted = new Promise<void>(resolve => {
    killAttempt = resolve
  })
  child.kill = signal => {
    if (signal === 'SIGKILL') killAttempt()
    return false
  }
  child.stdin!.emit('error', new Error('broken RPC input stream'))
  await expect(channel.closed).rejects.toThrow('broken RPC input stream')
  let stopped = false
  const stopping = channel.stop().then(() => {
    stopped = true
  })
  try {
    await attempted
    expect(stopped).toBe(false)
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  } finally {
    originalKill('SIGKILL')
    await stopping
  }
  expect(stopped).toBe(true)
  expect(() => process.kill(child.pid!, 0)).toThrow()
}, 6_000)
