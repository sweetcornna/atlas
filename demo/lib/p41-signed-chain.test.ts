// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { createAck, createTaskResult } from '@qianmo/protocol'
import { startTransportServer } from '@qianmo/transport'
import {
  startStubDaemon,
  STUB_TOKEN,
} from '../../atlas/packages/activator/test/stub-daemon.js'

// Real independent host entry + sender entry. The HTTP supervisor is explicitly
// a fixture: this proves protocol/CLI integration, never a real freeze or AC-2.
test('AC2 signed host and sender require both correlated ack and completed result; delivery alone fails', async () => {
  const demo = (name: string) =>
    process.env.QIANMO_TEST_DEMO_DIR
      ? join(process.env.QIANMO_TEST_DEMO_DIR, `${name}.mjs`)
      : resolve(`demo/lib/${name}.ts`)
  const home = mkdtempSync(join(tmpdir(), 'p41-signed-')),
    config = join(home, 'config')
  const sender = generateNodeKeyPair(),
    host = generateNodeKeyPair(),
    worker = generateNodeKeyPair()
  mkdirSync(join(config, 'qianmo', 'identity'), { recursive: true })
  for (const [node, keys] of [
    ['node-a', sender],
    ['node-b-host', host],
  ] as const)
    writeFileSync(
      join(config, 'qianmo', 'identity', `${node}.json`),
      JSON.stringify({ version: 1, node, ...keys, createdAt: Date.now() }),
      { mode: 0o600 },
    )
  const psk = 'p41-signed-fixture-not-production'
  const directory = new StaticPublicKeyDirectory([
    ['node-a', sender.publicKey],
    ['node-b-host', host.publicKey],
  ])
  const capabilities = new NodeCapabilities({
    node: 'node-b',
    directory,
    trustedIssuers: ['node-a'],
  })
  let mode = 'complete',
    messages = 0
  const target = startTransportServer({
    port: 0,
    hostname: '127.0.0.1',
    psk,
    signing: { node: 'node-b', keys: worker, directory, required: true },
    onMessage(message, context) {
      expect(context.channel.authenticatedPeerNode).toBe('node-b-host')
      expect(capabilities.check(message, Date.now()).ok).toBe(true)
      messages++
      if (mode === 'delivery') return
      const ack = createAck(message, message.to)
      const result = createTaskResult(message, message.to, {
        outcome: 'completed',
        content: 'OK from independent worker',
      })
      if (mode === 'forged') {
        context.channel.send({ ...ack, contextId: crypto.randomUUID() })
        context.channel.send({ ...result, traceId: crypto.randomUUID() })
        return
      }
      context.channel.send(ack)
      if (mode === 'complete') context.channel.send(result)
    },
  })
  const daemon = startStubDaemon({
    sandboxes: ['test-box'],
    initialState: 'frozen',
  })
  const ready = join(home, 'ready.json')
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    QIANMO_CONFIG_DIR: config,
    QIANMO_TRANSPORT_PSK: psk,
    QIANMO_SANDBOX_DAEMON_URL: daemon.url,
    QIANMO_SANDBOX_DAEMON_TOKEN: STUB_TOKEN,
    QIANMO_AC2_SANDBOX: 'test-box',
    QIANMO_AC2_TARGET_URL: target.url,
  }
  const activator = Bun.spawn(
    [
      process.execPath,
      demo('ac2-activator'),
      '--sign',
      '--trust',
      `node-a=${sender.publicKey}`,
      '--target-key',
      worker.publicKey,
      '--ready',
      ready,
      '--timings',
      join(home, 'timings.jsonl'),
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const hostOut = new Response(activator.stdout).text(),
    hostErr = new Response(activator.stderr).text()
  let endpoint = ''
  const registry = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json({ endpoint }),
  })
  async function run(key = host.publicKey) {
    const child = Bun.spawn(
      [
        process.execPath,
        demo('p41-send'),
        '--sign',
        '--host-key',
        key,
        '--registry',
        registry.url.toString(),
        '--ack-timeout-ms',
        '500',
        '--result-timeout-ms',
        '700',
        '--forward-timeout-ms',
        '500',
        '--connect-timeout-ms',
        '150',
      ],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, out, err }
  }
  try {
    const deadline = Date.now() + 5000
    while (
      !existsSync(ready) &&
      Date.now() < deadline &&
      activator.exitCode === null
    )
      await Bun.sleep(10)
    expect(existsSync(ready)).toBe(true)
    endpoint = JSON.parse(readFileSync(ready, 'utf8')).url
    const complete = await run()
    expect(complete.code).toBe(0)
    const record = JSON.parse(complete.out)
    expect(record.verdict).toBe('complete')
    expect(record.signedChannel).toBe(true)
    expect(record.resolvedByRegistry).toBe(true)
    expect(record.ackClosed).toBe(true)
    expect(record.resultClosed).toBe(true)
    expect(messages).toBe(1)
    const wrong = await run(generateNodeKeyPair().publicKey)
    expect(wrong.code).not.toBe(0)
    expect(messages).toBe(1)
    expect(daemon.hits.acquireSandbox).toBe(1)
    for (const negative of ['delivery', 'ack-only', 'forged']) {
      mode = negative
      const result = await run()
      expect(result.code).toBe(1)
      const row = JSON.parse(result.out)
      expect(row.verdict).not.toBe('complete')
      expect(row.receipt).toBe('accepted')
    }
    expect(messages).toBe(4)
  } finally {
    activator.kill('SIGTERM')
    await activator.exited
    await Promise.all([hostOut, hostErr])
    await registry.stop(true)
    await target.stop()
    await daemon.stop()
  }
}, 10000)
