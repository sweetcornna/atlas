// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { A2aOutbound, A2aTaskStore, createA2aGateway } from '@qianmo/a2a'
import { AuditTrail } from '@qianmo/audit'
import { StaticPublicKeyDirectory } from '@qianmo/capability'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  assertAddress,
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { loadConsoleWakeIdentity } from './consoleWakeIdentity.js'
import { loadOrCreateNodeKeys, parseTrustedKey } from '../host/nodeIdentity.js'

const configSchema = z
  .object({
    identity: z.string().min(1),
    node: z.string().min(1),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(8088),
    publicUrl: z.string().url(),
    name: z.string().default('Qianmo A2A gateway'),
    target: z.string(),
    targetPublicKey: z.string().min(1),
    endpoint: z.string().url(),
    pskEnv: z.string(),
    timeoutMs: z.number().int().min(1).max(3600000).default(300000),
    principals: z.array(
      z.object({
        id: z.string().min(1),
        tokenEnv: z.string(),
        from: z.string(),
        targets: z.array(z.string()),
      }),
    ),
    skills: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          tags: z.array(z.string()),
        }),
      )
      .min(1),
    peers: z
      .array(
        z.object({
          id: z.string(),
          url: z.string().url(),
          addresses: z.array(z.string()).min(1),
          tokenEnv: z.string(),
          tenant: z.string().optional(),
          allowLoopbackHttp: z.boolean().optional(),
        }),
      )
      .default([]),
  })
  .strict()

function secret(name: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !process.env[name])
    throw new Error(`required credential environment variable: ${name}`)
  return process.env[name]!
}

/** A real v0 transport adapter; HTTP identity cannot replace the capability gate. */
export async function dispatchA2aTask(
  config: {
    node: string
    target: string
    targetPublicKey: string
    endpoint: string
    psk: string
  },
  message: QianmoMessage,
  signal: AbortSignal,
): Promise<QianmoMessage> {
  const identity = loadConsoleWakeIdentity(`qianmo://${config.node}/a2a`)
  const peerNode = assertAddress(config.target, 'target').node
  const trusted = parseTrustedKey(`${peerNode}=${config.targetPublicKey}`)
  const endpoint = new URL(config.endpoint)
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error(
      'internal endpoint must be ws or wss without URL credentials',
    )
  let finish: (message: QianmoMessage) => void = () => {}
  let fail: (reason: Error) => void = () => {}
  const reply = new Promise<QianmoMessage>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  // Register rejection handling before connection can fail or abort.
  void reply.catch(() => {})
  const client = new TransportClient({
    endpoint: { url: config.endpoint },
    node: config.node,
    peerNode,
    psk: config.psk,
    signing: {
      keys: loadOrCreateNodeKeys(config.node),
      directory: new StaticPublicKeyDirectory([trusted]),
      required: true,
    },
    onMessage: (incoming, context) => {
      if (
        context.channel.authenticatedPeerNode !== peerNode ||
        incoming.taskId !== message.taskId ||
        incoming.from !== config.target ||
        incoming.to !== message.from ||
        incoming.contextId !== message.contextId ||
        incoming.traceId !== message.traceId
      )
        return
      if (
        incoming.type === MessageType.TaskResult ||
        incoming.type === MessageType.Error
      )
        finish(incoming)
    },
  })
  const abort = () => {
    fail(new Error('A2A dispatch aborted'))
    void client.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await client.connect(15_000)
    signal.throwIfAborted()
    await client.sendAndWait(
      {
        ...message,
        cap: identity.issue({
          aud: peerNode,
          sub: config.target,
          taskId: message.taskId,
          createdAt: message.createdAt,
        }),
      },
      20_000,
    )
    return await reply
  } finally {
    signal.removeEventListener('abort', abort)
    await client.close()
  }
}

const HELP = `Usage: qm a2a serve --config <json>
       qm a2a send --config <json> --peer <name> --prompt <text>
       qm a2a task --id <gateway-task-id>

A2A 1.0 HTTP+JSON single-turn text gateway. Configuration fixes identities,
targets and outbound URL/IP allowlists; credentials are named environment
variables. Incoming tasks use signed Qianmo v0 transport. Streaming, push,
cancellation and interactive continuation are unsupported.
State and audit: <QIANMO_CONFIG_DIR>/qianmo/a2a/.
See docs/dev/a2a-gateway.md for configuration and deployment boundaries.
`

export async function run(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return 0
  }
  const [command, ...rest] = argv
  const options = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (
      !key ||
      !['--config', '--peer', '--prompt', '--id'].includes(key) ||
      value === undefined ||
      options.has(key)
    )
      throw new Error('invalid or duplicate a2a option')
    options.set(key, value)
  }
  if (!['serve', 'send', 'task'].includes(command!))
    throw new Error('unknown a2a command')
  if (command === 'task') {
    if (!options.get('--id') || options.size !== 1)
      throw new Error('task requires only --id')
    const store = new A2aTaskStore(
      qianmoConfigPath('qianmo', 'a2a', 'tasks.sqlite'),
    )
    try {
      const task = store.get(options.get('--id')!)
      if (!task) return 1
      console.log(JSON.stringify(task))
      return 0
    } finally {
      store.close()
    }
  }
  const path = options.get('--config')
  if (!path) throw new Error('--config is required')
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  assertAddress(`qianmo://${config.node}/a2a`, 'node')
  assertAddress(config.target, 'target')
  parseTrustedKey(
    `${assertAddress(config.target).node}=${config.targetPublicKey}`,
  )
  if (
    command === 'send' &&
    (!options.get('--peer') || !options.get('--prompt'))
  )
    throw new Error('send requires --peer and --prompt')
  if (command === 'serve' && options.size !== 1)
    throw new Error('serve accepts only --config')
  const store = new A2aTaskStore(
    qianmoConfigPath(
      'qianmo',
      'a2a',
      command === 'send' ? 'outbound.sqlite' : 'tasks.sqlite',
    ),
  )
  const trail = new AuditTrail(
    qianmoConfigPath(
      'qianmo',
      'a2a',
      command === 'send' ? 'outbound-audit.ndjson' : 'audit.ndjson',
    ),
  )
  const audit = (input: Parameters<AuditTrail['append']>[0]) => {
    trail.append(input)
  }
  if (command === 'send') {
    try {
      store.recover()
      const outbound = new A2aOutbound({
        store,
        node: config.node,
        identity: config.identity,
        audit,
        peers: config.peers.map(peer => ({
          ...peer,
          token: secret(peer.tokenEnv),
        })),
      })
      const message = createMessage({
        from: `qianmo://${config.node}/a2a`,
        to: `qianmo://${config.node}/a2a-egress`,
        type: MessageType.TaskRequest,
        payload: { prompt: options.get('--prompt')! },
        taskTtlMs: config.timeoutMs,
      })
      const result = await outbound.send(options.get('--peer')!, message)
      console.log(JSON.stringify(result))
      return (result.payload as { outcome?: string }).outcome === 'completed'
        ? 0
        : 1
    } finally {
      store.close()
      trail.close()
    }
  }
  const psk = secret(config.pskEnv)
  const principals = config.principals.map(principal => ({
    ...principal,
    token: secret(principal.tokenEnv),
  }))
  const gateway = createA2aGateway({
    store,
    identity: config.identity,
    node: config.node,
    target: config.target,
    publicUrl: config.publicUrl,
    name: config.name,
    skills: config.skills,
    principals,
    timeoutMs: config.timeoutMs,
    audit,
    dispatch: (message, signal) =>
      dispatchA2aTask({ ...config, psk }, message, signal),
  })
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 256 * 1024,
    idleTimeout: 255,
    fetch: gateway.fetch,
  })
  const identity = loadConsoleWakeIdentity(`qianmo://${config.node}/a2a`)
  console.log(
    JSON.stringify({
      event: 'a2a.ready',
      url: server.url.toString(),
      capabilityTrust: `${identity.node}=${identity.publicKey}`,
    }),
  )
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await server.stop()
    await gateway.drain()
    trail.close()
    store.close()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return 0
}
