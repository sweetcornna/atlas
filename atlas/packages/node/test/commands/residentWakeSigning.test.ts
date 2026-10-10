// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { PSK_ENV_VAR, startTransportServer } from '@qianmo/transport'
import { parseResidentWakeArgs } from '../../src/commands/residentWake.js'

const PSK = 'wake-cli-signed-fixture-not-production'
const from = 'qianmo://probe/operator'
const to = 'qianmo://worker/dev'
const command = process.env.QIANMO_TEST_COMPILED_QM
  ? [process.env.QIANMO_TEST_COMPILED_QM]
  : [process.execPath, resolve('atlas/packages/node/src/cli.ts')]

test('signed wake CLI requires an explicit unique target key before dialing', () => {
  const base = [
    '--url',
    'ws://127.0.0.1:1',
    '--from',
    from,
    '--to',
    to,
    '--prompt',
    'test',
  ]
  const key = generateNodeKeyPair().publicKey
  expect(() => parseResidentWakeArgs([...base, '--sign'])).toThrow(
    'target node',
  )
  expect(() =>
    parseResidentWakeArgs([...base, '--trust', `worker=${key}`]),
  ).toThrow('--sign')
  expect(() =>
    parseResidentWakeArgs([...base, '--sign', '--trust', `other=${key}`]),
  ).toThrow('target node')
  expect(() =>
    parseResidentWakeArgs([
      ...base,
      '--sign',
      '--trust',
      `worker=${key}`,
      '--trust',
      `worker=${key}`,
    ]),
  ).toThrow('duplicate')
  expect(() =>
    parseResidentWakeArgs([...base, '--sign', '--trust', 'worker=bad']),
  ).toThrow()
})

test('actual CLI signs capability and both handshake directions; wrong keys and unsigned peers dispatch nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wake-signed-cli-'))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    QIANMO_CONFIG_DIR: join(home, 'config'),
    [PSK_ENV_VAR]: PSK,
  }
  async function run(...args: string[]) {
    const child = Bun.spawn([...command, 'resident-wake', ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, out, err }
  }
  const identity = await run('--print-identity', '--from', from)
  expect(identity.code).toBe(0)
  expect(identity.err).toBe('')
  expect(identity.out.trim()).toMatch(/^probe=[A-Za-z0-9_-]{43}$/)
  const publicKey = identity.out.trim().split('=')[1]!
  const directory = new StaticPublicKeyDirectory([['probe', publicKey]])
  const worker = generateNodeKeyPair()
  const capabilities = new NodeCapabilities({
    node: 'worker',
    directory,
    trustedIssuers: ['probe'],
  })
  let dispatched = 0
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: PSK,
    signing: { node: 'worker', keys: worker, directory, required: true },
    onMessage(message, context) {
      expect(context.channel.authenticatedPeerNode).toBe('probe')
      expect(capabilities.check(message, Date.now()).ok).toBe(true)
      expect(message.hops).toEqual(['probe'])
      dispatched++
    },
  })
  const unsigned = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: PSK,
    onMessage: () => {
      dispatched++
    },
  })
  const base = [
    '--from',
    from,
    '--to',
    to,
    '--prompt',
    'signed CLI check',
    '--timeout-ms',
    '500',
  ]
  try {
    const valid = await run(
      ...base,
      '--url',
      server.url!,
      '--sign',
      '--trust',
      `worker=${worker.publicKey}`,
    )
    expect(valid.err).toBe('')
    expect(valid.code).toBe(0)
    expect(JSON.parse(valid.out).receipt).toBe('accepted')
    expect(dispatched).toBe(1)
    for (const args of [
      [
        '--url',
        server.url!,
        '--sign',
        '--trust',
        `worker=${generateNodeKeyPair().publicKey}`,
      ],
      [
        '--url',
        unsigned.url!,
        '--sign',
        '--trust',
        `worker=${worker.publicKey}`,
      ],
      ['--url', server.url!],
    ]) {
      expect((await run(...base, ...args)).code).not.toBe(0)
      expect(dispatched).toBe(1)
    }
  } finally {
    await server.stop()
    await unsigned.stop()
  }
}, 15000)
