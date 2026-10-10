// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Two actual CLI hosts, two actual omp RPC children, one deterministic loopback
 * model. Covers transport → durable mailbox admission → model → return result.
 * It is a local process/isolation test, not cross-machine sandbox evidence. */
import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'

async function until(predicate: () => boolean, describe: () => string) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(describe())
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function exit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve()
  return new Promise(resolve => child.once('exit', () => resolve()))
}
test('two isolated qm resident CLI nodes complete real omp turns and cleanly stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-two-nodes-'))
  const children: ChildProcess[] = []
  const clients: TransportClient[] = []
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      if (request.method !== 'POST')
        return Response.json({ object: 'list', data: [] })
      const body = (await request.json()) as { model: string }
      requests.push(body.model)
      const base = {
        id: 'two-nodes',
        model: body.model,
        object: 'chat.completion.chunk',
        created: 0,
      }
      const chunks = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: `pong from ${body.model}` },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]
      return new Response(
        chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const psk = 'two-nodes-local-fixture-secret'
  try {
    const nodes = ['node-a', 'node-b'].map(name => {
      const config = join(root, name, 'config')
      const workspace = join(root, name, 'workspace')
      const agentDir = join(config, 'omp/agent')
      const socket = join(root, `${name}.sock`)
      mkdirSync(agentDir, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      writeFileSync(
        join(agentDir, 'models.yml'),
        `providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    api: openai-completions\n    apiKey: local-no-secret\n    models:\n      - id: ${name}\n        name: ${name}\n        contextWindow: 65536\n        maxTokens: 4096\n`,
      )
      writeFileSync(
        join(agentDir, 'config.yml'),
        `modelRoles:\n  default: fixture/${name}\ndefaultThinkingLevel: off\nproviders:\n  cacheWarming: off\nretry:\n  enabled: false\n  fallbackChains: {}\n`,
      )
      const child = spawn(
        process.execPath,
        [
          resolve(import.meta.dir, '../../src/cli.ts'),
          'resident',
          '--node',
          name,
          '--team',
          'nest',
          '--agent',
          `reviewer=${workspace}`,
          '--unix',
          socket,
          '--open-policy',
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            QIANMO_CONFIG_DIR: config,
            QIANMO_TRANSPORT_PSK: psk,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      children.push(child)
      let output = ''
      child.stdout?.on('data', data => {
        output += data
      })
      child.stderr?.on('data', data => {
        output += data
      })
      return {
        name,
        config,
        socket,
        child,
        output: () => output,
        messages: [] as QianmoMessage[],
      }
    })
    await Promise.all(
      nodes.map(node => until(() => existsSync(node.socket), node.output)),
    )
    // Send the first node's result to the second node, using fresh peer links.
    let prompt = 'say pong'
    for (const node of nodes) {
      const client = new TransportClient({
        endpoint: { unix: node.socket },
        node: 'operator',
        psk,
        onMessage: message => {
          node.messages.push(message)
        },
      })
      clients.push(client)
      await client.connect()
      const input = createMessage({
        type: MessageType.TaskRequest,
        from: 'qianmo://operator/test',
        to: `qianmo://${node.name}/reviewer`,
        payload: { taskId: node.name, prompt },
      })
      await client.sendAndWait(input)
      await until(
        () =>
          node.messages.some(
            message => message.type === MessageType.TaskResult,
          ),
        node.output,
      )
      expect(
        node.messages.some(message => message.type === MessageType.Ack),
      ).toBe(true)
      const result = node.messages.find(
        message => message.type === MessageType.TaskResult,
      )!
      expect(result.payload).toMatchObject({
        outcome: 'completed',
        content: `pong from ${node.name}`,
      })
      prompt = JSON.stringify(result.payload)
      const sessions = join(node.config, 'resident/sessions/reviewer')
      const transcripts = readdirSync(sessions)
        .flatMap(id =>
          readdirSync(join(sessions, id))
            .filter(file => file.endsWith('.jsonl'))
            .map(file => readFileSync(join(sessions, id, file), 'utf8')),
        )
        .join('\n')
      const entries = transcripts
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
      const identities = entries.filter(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'qianmo.resident.input-identity',
      )
      expect(identities).toHaveLength(1)
      expect(identities[0].data.messageId).toMatch(/^[0-9a-f-]{36}$/)
      expect(transcripts).toContain('qianmo.resident.input-identity')
      expect(transcripts).not.toContain(
        `"provider":"fixture","model":"${node.name === 'node-a' ? 'node-b' : 'node-a'}"`,
      )
    }
    expect(requests).toContain('node-a')
    expect(requests).toContain('node-b')
    for (const node of nodes) {
      node.child.kill('SIGHUP')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(node.child.exitCode).toBeNull()
      expect(node.child.signalCode).toBeNull()
      node.child.kill('SIGTERM')
      await exit(node.child)
      expect(node.child.exitCode).toBe(0)
      expect(
        JSON.parse(
          readFileSync(join(node.config, 'resident/lifecycle.json'), 'utf8'),
        ),
      ).toMatchObject({ phase: 'stopped', node: node.name })
    }
  } finally {
    await Promise.all(clients.map(client => client.close()))
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM')
    await Promise.all(children.map(child => exit(child)))
    await server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
