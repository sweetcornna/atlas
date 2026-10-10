// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Opt-in reproducible local interop; independent official SDK process, real qm CLI and signed v0 transport. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  NodeCapabilities,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
} from '@qianmo/capability'
import {
  createAck,
  createTaskResult,
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { startTransportServer } from '@qianmo/transport'
import { AuditTrail, readTrail } from '@qianmo/audit'
import { transportTrailSink } from '../packages/node/src/host/auditTrail.js'
import { loadConsoleWakeIdentity } from '../packages/node/src/commands/consoleWakeIdentity.js'

const sdkRoot = process.argv[2]
const out = process.argv[3]
if (!sdkRoot || !out)
  throw new Error(
    'Usage: bun atlas/scripts/a2a-interop.ts <tools dir with @a2a-js/sdk@1.3.0 + express> <evidence dir>',
  )
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'qm-a2a-interop-'))
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: join(root, 'home'),
  TMPDIR: root,
  QIANMO_CONFIG_DIR: join(root, 'config'),
  QIANMO_A2A_SDK_ROOT: resolve(sdkRoot),
  QIANMO_A2A_TEST_TOKEN: randomBytes(24).toString('hex'),
  QIANMO_A2A_TEST_PSK: randomBytes(24).toString('hex'),
}
mkdirSync(env.HOME!, { recursive: true })
process.env.QIANMO_CONFIG_DIR = env.QIANMO_CONFIG_DIR
const repo = resolve(import.meta.dir, '../..')
const cli = process.env.QIANMO_TEST_COMPILED_QM
  ? [process.env.QIANMO_TEST_COMPILED_QM]
  : [process.execPath, join(repo, 'atlas/packages/node/src/cli.ts')]
const peerEntry = join(import.meta.dir, 'fixtures/a2a-sdk-peer.mjs')
const children: ReturnType<typeof Bun.spawn>[] = []
async function start(argv: string[], name: string) {
  const child = Bun.spawn(argv, {
    env,
    stdout: 'pipe',
    stderr: Bun.file(join(out, `${name}.stderr`)),
  })
  children.push(child)
  if (!(child.stdout instanceof ReadableStream)) throw new Error('pipe missing')
  const reader = child.stdout.getReader()
  let buffer = ''
  const ready = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`${name} exited before ready`)
      buffer += new TextDecoder().decode(value)
      const line = buffer.split('\n')[0]
      if (buffer.includes('\n'))
        return JSON.parse(line!) as Record<string, string>
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} readiness timeout`)),
          20000,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock()
  }
}
async function sdkSend(url: string, id: string, prompt: string) {
  const child = Bun.spawn([process.execPath, peerEntry, 'client', url], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  child.stdin.write(
    JSON.stringify({
      message: { messageId: id, role: 'ROLE_USER', parts: [{ text: prompt }] },
    }),
  )
  child.stdin.end()
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`SDK client: ${stderr}`)
  return JSON.parse(stdout) as {
    id: string
    status: { state: string }
    artifacts?: { parts: { text: string }[] }[]
  }
}
const events: { type: string; taskId: string; direction: string }[] = []
const transportTrail = new AuditTrail(join(out, 'worker-transport.ndjson'))
transportTrail.ensure()
let node: ReturnType<typeof startTransportServer> | undefined
try {
  const identity = loadConsoleWakeIdentity('qianmo://bridge/a2a')
  const workerKeys = generateNodeKeyPair()
  const capability = new NodeCapabilities({
    node: 'worker',
    directory: new StaticPublicKeyDirectory([['bridge', identity.publicKey]]),
    trustedIssuers: ['bridge'],
  })
  const source =
    "export function slugify(value) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }\n"
  const workload = join(root, 'work')
  mkdirSync(workload)
  node = startTransportServer({
    port: 0,
    hostname: '127.0.0.1',
    psk: env.QIANMO_A2A_TEST_PSK!,
    events: transportTrailSink(transportTrail, 'worker'),
    signing: {
      node: 'worker',
      keys: workerKeys,
      directory: new StaticPublicKeyDirectory([['bridge', identity.publicKey]]),
      required: true,
    },
    async onMessage(message, context) {
      events.push({
        type: message.type,
        taskId: message.taskId,
        direction: 'inbound',
      })
      const gate = capability.check(message, Date.now())
      if (!gate.ok || gate.trust !== NOTICE_TRUST_VERIFIED_CAPABILITY)
        throw new Error('signed capability verification failed')
      const ack = createAck(message, message.to)
      context.channel.send(ack)
      events.push({ type: ack.type, taskId: ack.taskId, direction: 'outbound' })
      const prompt = (message.payload as { prompt: string }).prompt
      let result: QianmoMessage
      if (prompt === 'implement slugify') {
        writeFileSync(join(workload, 'slugify.mjs'), source)
        writeFileSync(
          join(workload, 'verify.mjs'),
          "import {slugify} from './slugify.mjs';\nconst cases=[['Hello World','hello-world'],['  A___B  ','a-b'],['!!!',''],['A--B','a-b'],['already-good','already-good']];\nfor(const [input,expected] of cases) if(slugify(input)!==expected) throw new Error('case failed');\nconsole.log(JSON.stringify({testsPassed:cases.length}));\n",
        )
        const child = Bun.spawn(
          [process.execPath, join(workload, 'verify.mjs')],
          {
            env: { PATH: env.PATH!, HOME: env.HOME! },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        const [code, output] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
        ])
        if (code !== 0) throw new Error('coding workload tests failed')
        result = createTaskResult(message, message.to, {
          outcome: 'completed',
          content: JSON.stringify({
            operation: 'review',
            source,
            sha256: createHash('sha256').update(source).digest('hex'),
            ...JSON.parse(output),
          }),
        })
      } else
        result = createTaskResult(message, message.to, {
          outcome: 'failed',
          code: ProtocolErrorCode.E_TASK_FAILED,
          reason: 'deliberate negative workload',
        })
      context.channel.send(result)
      events.push({
        type: result.type,
        taskId: result.taskId,
        direction: 'outbound',
      })
    },
  })
  const peer = await start([process.execPath, peerEntry, 'server'], 'sdk-peer')
  const base = {
    identity: 'interop-gateway',
    node: 'bridge',
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'https://localhost.invalid',
    target: 'qianmo://worker/dev',
    targetPublicKey: workerKeys.publicKey,
    endpoint: `ws://127.0.0.1:${node.port}`,
    pskEnv: 'QIANMO_A2A_TEST_PSK',
    timeoutMs: 10000,
    principals: [
      {
        id: 'sdk',
        tokenEnv: 'QIANMO_A2A_TEST_TOKEN',
        from: 'qianmo://bridge/sdk',
        targets: ['qianmo://worker/dev'],
      },
    ],
    skills: [
      {
        id: 'coding',
        name: 'Coding',
        description: 'Deterministic coding workload',
        tags: ['code'],
      },
    ],
    peers: [
      {
        id: 'reviewer',
        url: peer.url,
        addresses: ['127.0.0.1'],
        tokenEnv: 'QIANMO_A2A_TEST_TOKEN',
        allowLoopbackHttp: true,
      },
    ],
  }
  // Bind a known ephemeral port so the advertised URL is the actual gateway.
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  base.port = reservation.port!
  base.publicUrl = `http://127.0.0.1:${base.port}`
  await reservation.stop(true)
  const config = join(root, 'gateway.json')
  writeFileSync(config, JSON.stringify(base))
  const gateway = await start(
    [...cli, 'a2a', 'serve', '--config', config],
    'gateway',
  )
  const implemented = await sdkSend(
    gateway.url!,
    'implement-1',
    'implement slugify',
  )
  if (implemented.status.state !== 'TASK_STATE_COMPLETED')
    throw new Error('inbound workload failed')
  const duplicate = await sdkSend(
    gateway.url!,
    'implement-1',
    'implement slugify',
  )
  if (duplicate.id !== implemented.id) throw new Error('inbound dedup failed')
  const failed = await sdkSend(gateway.url!, 'fail-1', 'deliberate failure')
  if (failed.status.state !== 'TASK_STATE_FAILED')
    throw new Error('negative workload was not failed')
  const send = Bun.spawn(
    [
      ...cli,
      'a2a',
      'send',
      '--config',
      config,
      '--peer',
      'reviewer',
      '--prompt',
      implemented.artifacts![0]!.parts[0]!.text,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stdout, stderr] = await Promise.all([
    send.exited,
    new Response(send.stdout).text(),
    new Response(send.stderr).text(),
  ])
  if (code !== 0) throw new Error(`outbound failed: ${stderr}\n${stdout}`)
  const reviewEnvelope = JSON.parse(stdout)
  const review = JSON.parse(reviewEnvelope.payload.content)
  if (review.passed !== true) throw new Error('independent review failed')
  const taskMessages = events.filter(
    event => event.type === 'task.request' || event.type === 'task.result',
  ).length
  const report = {
    transportAudit: transportTrail.path,
    qmCommand: cli,
    scope:
      'local independent official SDK process ↔ real qm CLI ↔ signed v0 transport worker; deterministic coding workload, no live model/vendor deployment claim',
    sdk: '@a2a-js/sdk@1.3.0',
    protocol: '1.0',
    inbound: {
      completed: implemented.id,
      failed: failed.id,
      deduplicated: duplicate.id === implemented.id,
    },
    outbound: { outcome: reviewEnvelope.payload.outcome, review },
    messages: {
      observed: events.length,
      taskMessages,
      taskMessageRatio: taskMessages / events.length,
      byType: Object.fromEntries(
        [...new Set(events.map(event => event.type))].map(type => [
          type,
          events.filter(event => event.type === type).length,
        ]),
      ),
    },
    events,
  }
  const observed = readTrail(transportTrail.path)
  if (
    !observed.intact ||
    !observed.records.some(
      row =>
        row.kind === 'message_accepted' &&
        row.detail?.messageType === MessageType.TaskRequest,
    )
  )
    throw new Error('real worker accepted-message audit missing or invalid')
  writeFileSync(
    join(out, 'a2a-interop-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const child of children) {
    child.kill('SIGTERM')
    await child.exited
  }
  await node?.stop()
  transportTrail.close()
  // Keep only this isolated run's files for examination; no user state is read.
  writeFileSync(join(out, 'workspace.txt'), root + '\n')
}
