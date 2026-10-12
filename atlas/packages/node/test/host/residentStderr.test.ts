// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, spyOn, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { OmpResidentTurnPort } from '@qianmo/resident'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { ompSpawnEnv } from '../../src/omp/launch.js'
import { QianmoResident } from '../../src/host/resident.js'
import { OmpRpcProcess, ResidentOmpPool } from '../../src/host/residentOmp.js'
import { isolatedRoot } from '../providers/fake.js'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('stderr condition timed out')
    await Bun.sleep(5)
  }
}

const fieldSecrets = [
  'gateway-secret-42',
  'assignment-value-42',
  'dash-value-42',
  'token-value-42',
  'password-value-42',
  'secret-value-42',
  'authorization-value-42',
  'double-quoted-value-42',
  'single-quoted-value-42',
  'ansi-field-value-42',
]
const fieldLog =
  [
    `apiKey: ${fieldSecrets[0]}`,
    `API_KEY=${fieldSecrets[1]}`,
    `Api-Key: ${fieldSecrets[2]}`,
    `ToKeN: ${fieldSecrets[3]}`,
    `PASSWORD=${fieldSecrets[4]}`,
    `secret: ${fieldSecrets[5]}`,
    `AUTHORIZATION: ${fieldSecrets[6]}`,
    `Authorization: Bearer "${fieldSecrets[7]}"`,
    `Authorization: Bearer '${fieldSecrets[8]}'`,
    `Bearer "${fieldSecrets[7]}"`,
    `Bearer '${fieldSecrets[8]}'`,
    `api\u001b[31m_key\u001b[0m: ${fieldSecrets[9]}`,
  ].join('\n') + '\n'
const pemTail = 'c2hvcnQtcGVtLXRhaWw='
const pemLog = `-----BEGIN PRIVATE KEY-----\n${('QUJD'.repeat(16) + '\n').repeat(55)}${pemTail}\n-----END PRIVATE KEY-----\n`
const startupLog = `${pemLog}${fieldLog}missing models.yml: configure a provider\n`
const failScript =
  'process.stderr.write(process.env.FAKE_STARTUP_LOG, () => process.exit(1))'

test.each([
  [
    'combined truncated PEM and credential fields',
    startupLog,
    [...fieldSecrets, pemTail],
  ],
  [
    'unquoted fields and quoted Bearer',
    `${fieldLog}missing models.yml: configure a provider\n`,
    fieldSecrets,
  ],
  [
    'truncated PEM short final line',
    `${pemLog}missing models.yml: configure a provider\n`,
    [pemTail],
  ],
])('real startup failure redacts %s in turn and parking errors', async (_name, log, secrets) => {
  const root = isolatedRoot()
  const agent = { agent: 'reviewer', cwd: root.root }
  const pool = new ResidentOmpPool({
    agents: [agent],
    memoryRoot: join(root.root, 'memory'),
    announce: async () => ({}),
    maxStartFailures: 1,
    spawn: input =>
      spawn(process.execPath, ['-e', failScript], {
        cwd: input.cwd,
        env: { ...input.env, FAKE_STARTUP_LOG: log },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  })
  try {
    const sessionId = await pool.newSession(agent)
    const failure = await new OmpResidentTurnPort(pool)
      .execute(
        { sessionId, messageId: 'startup-stderr', prompt: 'hello' },
        async () => {},
      )
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    for (const reason of [(failure as Error).message, pool.parkedReason!]) {
      expect(reason).toContain('missing models.yml: configure a provider')
      expect(reason).toContain('[REDACTED]')
      for (const secret of secrets) expect(reason).not.toContain(secret)
    }
  } finally {
    await pool.stop()
    root.dispose()
  }
})

test('production task.result.reason and parked refusals cannot leak startup stderr secrets', async () => {
  const root = isolatedRoot()
  const socket = join(root.root, 'stderr.sock')
  const errors: string[] = []
  const replies: QianmoMessage[] = []
  const children: ChildProcess[] = []
  let ready = false
  const psk = 'stderr-production-test-local-psk'
  const resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: root.root }],
    memoryRoot: join(root.root, 'memory'),
    psk,
    listen: { unix: socket },
    inactivityMs: 0,
    pollIntervalMs: 10,
    onTiming: event => {
      if (event.stage === 'runtime_ready') ready = true
    },
    onError: error => errors.push(String(error)),
    spawnOmp: input => {
      const child = spawn(process.execPath, ['-e', failScript], {
        cwd: input.cwd,
        env: { ...input.env, FAKE_STARTUP_LOG: startupLog },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    },
  })
  const running = resident.run()
  void running.catch(() => {})
  const client = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-a',
    psk,
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  try {
    await until(() => ready)
    await client.connect()
    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'stderr' },
    })
    await client.sendAndWait(request)
    await until(() =>
      replies.some(
        reply =>
          reply.type === MessageType.TaskResult &&
          reply.taskId === request.taskId,
      ),
    )
    const result = replies.find(
      reply =>
        reply.type === MessageType.TaskResult &&
        reply.taskId === request.taskId,
    )!.payload as { outcome: string; reason: string }
    expect(result.outcome).toBe('failed')
    expect(result.reason).toContain('missing models.yml')
    for (const secret of [...fieldSecrets, pemTail])
      expect(result.reason).not.toContain(secret)
    // Unadmitted mailbox entries retry automatically. The same real startup
    // failure reaches the default five-failure breaker without more deliveries.
    await until(() =>
      errors.some(error =>
        error.includes('parked after 5 consecutive startup failures'),
      ),
    )
    const parked = errors.find(error =>
      error.includes('parked after 5 consecutive startup failures'),
    )!
    expect(parked).toContain('missing models.yml')
    for (const secret of [...fieldSecrets, pemTail])
      expect(parked).not.toContain(secret)
    expect(children).toHaveLength(5)
    const refused = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'parked' },
    })
    await expect(client.sendAndWait(refused)).rejects.toThrow()
    await until(() => replies.some(reply => reply.type === MessageType.Error))
    const refusal = replies.find(reply => reply.type === MessageType.Error)!
      .payload as { reason: string }
    expect(refusal.reason).toContain('parked after 5')
    for (const secret of [...fieldSecrets, pemTail])
      expect(refusal.reason).not.toContain(secret)
  } finally {
    resident.stop()
    await client.close()
    await running
    root.dispose()
  }
}, 15_000)

test.each([
  ['truncated', startupLog, true],
  [
    'complete PEM',
    `configuration warning\n-----BEGIN PRIVATE KEY-----\n${pemTail}\n-----END PRIVATE KEY-----\n${fieldLog}missing models.yml\n`,
    false,
  ],
  [
    'incomplete PEM',
    `missing models.yml\n-----BEGIN PRIVATE KEY-----\n${pemTail}`,
    false,
  ],
])('startup warnings (%s) are redacted and forwarded once at ready, followed by unchanged runtime stderr', async (_name, log, truncated) => {
  const root = isolatedRoot()
  const chunks: string[] = []
  const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => {
    chunks.push(String(chunk))
    return true
  })
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.stdin.once('data', () => {
      process.stdout.write('{"type":"ready"}\\n');
      process.stdin.once('data', () => process.stderr.write('runtime Bearer raw-runtime-token\\n', () => process.exit(1)));
    });
    process.stderr.write(process.env.FAKE_STARTUP_LOG);
  `,
    ],
    {
      cwd: root.root,
      env: ompSpawnEnv({ FAKE_STARTUP_LOG: log }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const channel = new OmpRpcProcess(child, undefined, 5_000, true)
  try {
    await new Promise<void>(resolve =>
      child.stderr!.once('data', () => resolve()),
    )
    expect(chunks).toHaveLength(0)
    child.stdin!.write('ready\n')
    await channel.initialize()
    const warnings = chunks.join('')
    expect(warnings).toContain('missing models.yml')
    if (truncated) expect(warnings).toContain('[startup output truncated]')
    for (const secret of [...fieldSecrets, pemTail])
      expect(warnings).not.toContain(secret)
    channel.send({ type: 'runtime' })
    await channel.closed.catch(() => {})
    await channel.stop()
    expect(chunks.join('')).toBe(
      warnings + 'runtime Bearer raw-runtime-token\n',
    )
  } finally {
    await channel.stop(true)
    stderr.mockRestore()
    root.dispose()
  }
})

test.each([
  [
    'UTF-8 multiline tail',
    `${('配置警告：请检查模型。\n').repeat(120)}tail warning\n`,
    false,
  ],
  ['oversized single line', '界'.repeat(2_000), true],
  ['oversized newline-terminated line', '界'.repeat(2_000) + '\n', true],
  ['redaction expansion at a multibyte boundary', '界sk-x '.repeat(180), false],
])('startup diagnostic has a direct 2048-byte cap and intact UTF-8: %s', async (_name, log, omitted) => {
  const root = isolatedRoot()
  const child = spawn(process.execPath, ['-e', failScript], {
    cwd: root.root,
    env: ompSpawnEnv({ FAKE_STARTUP_LOG: log }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const channel = new OmpRpcProcess(child)
  try {
    const failure = await channel.initialize().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const diagnostic = (failure as Error).message.split(
      '; startup stderr: ',
    )[1]!
    expect(diagnostic).toBeDefined()
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(2_048)
    expect(diagnostic).not.toContain('\ufffd')
    expect(diagnostic).toContain('[startup output truncated]')
    if (omitted) expect(diagnostic).toContain('[startup line omitted]')
    else if (log.includes('tail warning'))
      expect(diagnostic).toContain('tail warning')
  } finally {
    await channel.stop(true)
    root.dispose()
  }
})

test('an untruncated diagnostic preserves the exact 2048-byte boundary', async () => {
  const root = isolatedRoot()
  const log = 'warning: ' + '.'.repeat(2_039)
  const child = spawn(process.execPath, ['-e', failScript], {
    cwd: root.root,
    env: ompSpawnEnv({ FAKE_STARTUP_LOG: log }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const channel = new OmpRpcProcess(child)
  try {
    const failure = await channel.initialize().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const diagnostic = (failure as Error).message.split(
      '; startup stderr: ',
    )[1]!
    expect(Buffer.byteLength(diagnostic)).toBe(2_048)
    expect(diagnostic).toBe(log)
  } finally {
    await channel.stop(true)
    root.dispose()
  }
})

test('runtime stderr pauses for a slow writable, resumes on drain, and shutdown drains to real close while blocked', async () => {
  const root = isolatedRoot()
  const chunks: string[] = []
  const callbacks: (() => void)[] = []
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callbacks.push(callback)
    },
  })
  const drain = () => {
    process.stderr.emit('drain')
  }
  sink.on('drain', drain)
  const baseline = process.stderr.listenerCount('drain')
  const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk =>
    sink.write(chunk),
  )
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.stdin.on('data', () => process.stderr.write('runtime chunk\\n'));
    process.stdin.on('end', () => process.stderr.write('shutdown tail\\n', () => process.exit(0)));
    process.stdout.write('{"type":"ready"}\\n');
  `,
    ],
    { cwd: root.root, env: ompSpawnEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let closed = false
  child.once('close', () => {
    closed = true
  })
  const channel = new OmpRpcProcess(child, undefined, 5_000, true)
  try {
    await channel.initialize()
    channel.send({ type: 'first' })
    await until(() => chunks.length === 1)
    expect(child.stderr!.isPaused()).toBe(true)
    callbacks.shift()!()
    await until(() => !child.stderr!.isPaused())
    channel.send({ type: 'second' })
    await until(() => chunks.length === 2)
    expect(child.stderr!.isPaused()).toBe(true)
    await channel.stop()
    expect(closed).toBe(true)
    // Release the substitute writer to inspect every byte accepted at shutdown.
    while (callbacks.length) callbacks.shift()!()
    expect(chunks.join('')).toBe(
      'runtime chunk\nruntime chunk\nshutdown tail\n',
    )
    expect(process.stderr.listenerCount('drain')).toBe(baseline)
  } finally {
    await channel.stop(true)
    while (callbacks.length) callbacks.shift()!()
    stderr.mockRestore()
    sink.off('drain', drain)
    sink.destroy()
    root.dispose()
  }
})
