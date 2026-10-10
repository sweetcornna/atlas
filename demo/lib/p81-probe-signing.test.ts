// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { createAck, createTaskResult } from '@qianmo/protocol'
import { startTransportServer } from '@qianmo/transport'

test('p81 real registry resolution uses pinned mutual signatures and capability; same PSK with wrong identity fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'p81-sign-'))
  const keys = generateNodeKeyPair(),
    target = generateNodeKeyPair()
  const config = join(home, 'config')
  mkdirSync(join(config, 'qianmo', 'identity'), { recursive: true })
  writeFileSync(
    join(config, 'qianmo', 'identity', 'probe.json'),
    JSON.stringify({
      version: 1,
      node: 'probe',
      ...keys,
      createdAt: Date.now(),
    }),
    { mode: 0o600 },
  )
  const directory = new StaticPublicKeyDirectory([['probe', keys.publicKey]])
  const cap = new NodeCapabilities({
    node: 'worker',
    directory,
    trustedIssuers: ['probe'],
  })
  const psk = 'p81-signed-fixture-psk-not-production'
  let messages = 0
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk,
    signing: { node: 'worker', keys: target, directory, required: true },
    onMessage(message, context) {
      expect(context.channel.authenticatedPeerNode).toBe('probe')
      expect(cap.check(message, Date.now()).ok).toBe(true)
      messages++
      context.channel.send(createAck(message, message.to))
      context.channel.send(
        createTaskResult(message, message.to, {
          outcome: 'completed',
          content: 'OK',
        }),
      )
    },
  })
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/v0/health'
        ? Response.json({ agents: 1 })
        : Response.json({ endpoint: server.url }),
  })
  async function run(key: string, task: boolean) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve('demo/lib/p81-probe.ts'),
        '--registry',
        registry.url.toString(),
        '--expect',
        'qianmo://worker/dev',
        '--sign',
        '--trust',
        `worker=${key}`,
        '--from-node',
        'probe',
        '--connect-timeout-ms',
        '400',
        ...(task
          ? ['--task', 'qianmo://worker/dev', '--result-grace-ms', '0']
          : []),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          QIANMO_CONFIG_DIR: config,
          QIANMO_TRANSPORT_PSK: psk,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, out, err }
  }
  try {
    const handshake = await run(target.publicKey, false)
    expect(handshake.code).toBe(0)
    expect(JSON.parse(handshake.out).pass).toBe(true)
    expect(messages).toBe(0)
    const task = await run(target.publicKey, true)
    expect(task.code).toBe(0)
    expect(JSON.parse(task.out).task.acked).toBe(true)
    expect(messages).toBe(1)
    const wrong = await run(generateNodeKeyPair().publicKey, false)
    expect(wrong.code).toBe(1)
    expect(JSON.parse(wrong.out).pass).toBe(false)
    expect(messages).toBe(1)
  } finally {
    await server.stop()
    await registry.stop(true)
  }
})
