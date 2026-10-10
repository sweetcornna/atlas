// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 第六类动作的中枢执行器（P18.6，`providers-console-m1.md` §2.5）：真子进程跑一个
 * 假的 `serve-stdin`，ssh 换成一个记录 argv 与 stdin、再扮演 sshd 的假 ssh。零
 * `mock.module`。
 *
 * 钉 §9.2 P18.6 一格里属于执行器的四条：ssh 命令行不含密钥（argv 断言）；客户端
 * 命令是哨兵、强制命令缺失时操作失败；`StrictHostKeyChecking=yes` 且 known_hosts 缺
 * 条目时拒绝；同一节点的操作串行。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SENTINEL_COMMAND } from '@qianmo/providers'
import {
  DIAL_WINDOW_MS,
  DIALS_PER_WINDOW,
  isProtocolNodeName,
  knownHostsHasEntry,
  ProviderExecutor,
  type ProviderNodeTarget,
} from '../../src/commands/consoleProvidersExec.js'
import { fakeNode, fakeSsh } from './consoleProvidersFakeNode.js'

const CANARY = 'sk-test-canary-exec-Pq27WmX0vB5nL8cR'
const HOST_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-provider-exec-'))
  roots.push(root)
  return root
}

function applyRequest(node: string, requestId = 'req-0000000001') {
  return {
    v: 1,
    op: 'apply',
    requestId,
    node,
    expect: { ownedHash: null },
    profile: {
      id: 'vendor-paygo',
      revision: 1,
      lane: 'openai-responses',
      baseUrl: 'https://api.vendor.example/v1',
      models: [
        {
          id: 'vendor-model-pro',
          role: 'main',
          tiers: ['opus', 'sonnet', 'fable'],
          capabilities: { mode: 'family' },
          effort: { send: 'auto' },
        },
      ],
      auth: { scheme: 'bearer', keys: [{ id: 'k1', value: CANARY }] },
    },
    recycle: { sessions: 'reset' },
    dryRun: false,
    force: false,
  }
}

function sshTarget(
  root: string,
  overrides: Partial<Extract<ProviderNodeTarget, { kind: 'ssh' }>> = {},
): Extract<ProviderNodeTarget, { kind: 'ssh' }> {
  return {
    node: 'beta-1',
    kind: 'ssh',
    user: 'qianmo',
    host: 'node-1.example.test',
    port: 22,
    keyFile: join(root, 'keys', 'beta-1'),
    ...overrides,
  }
}

describe('node names', () => {
  test('the executor asks the protocol parser, not a copy of its rule', () => {
    expect(isProtocolNodeName('beta-1')).toBe(true)
    expect(isProtocolNodeName('beta_1')).toBe(false)
    expect(isProtocolNodeName('Beta-1')).toBe(false)
    expect(isProtocolNodeName('a'.repeat(33))).toBe(false)
  })
})

describe('known_hosts pre-check', () => {
  test('plain, hashed and [host]:port entries are found; others are not', () => {
    const salt = randomBytes(20)
    const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt)
      .update('hashed.example.test')
      .digest('base64')}`
    const text = [
      '# comment',
      `node-1.example.test,10.0.0.1 ${HOST_KEY}`,
      `${hashed} ${HOST_KEY}`,
      `[node-2.example.test]:2222 ${HOST_KEY}`,
      `@revoked revoked.example.test ${HOST_KEY}`,
    ].join('\n')
    expect(knownHostsHasEntry(text, 'node-1.example.test', 22)).toBe(true)
    expect(knownHostsHasEntry(text, '10.0.0.1', 22)).toBe(true)
    expect(knownHostsHasEntry(text, 'hashed.example.test', 22)).toBe(true)
    expect(knownHostsHasEntry(text, 'node-2.example.test', 2222)).toBe(true)
    expect(knownHostsHasEntry(text, 'node-2.example.test', 22)).toBe(false)
    expect(knownHostsHasEntry(text, 'node-1.example.test', 2222)).toBe(false)
    expect(knownHostsHasEntry(text, 'revoked.example.test', 22)).toBe(false)
    expect(knownHostsHasEntry(text, 'other.example.test', 22)).toBe(false)
  })

  test('a host missing from known_hosts is refused before ssh is started', async () => {
    const root = tempRoot()
    const ssh = fakeSsh(join(root, 'ssh'))
    const knownHosts = join(root, 'known_hosts')
    writeFileSync(knownHosts, `other.example.test ${HOST_KEY}\n`)
    const executor = new ProviderExecutor([sshTarget(root)], {
      knownHostsFile: knownHosts,
      sshBinary: ssh.binary,
    })
    const result = await executor.run('beta-1', applyRequest('beta-1'), 5_000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('known-hosts')
      expect(result.message).toContain('known_hosts')
    }
    expect(ssh.invocations()).toEqual([])

    // Positive control: with the entry, ssh is started.
    writeFileSync(knownHosts, `node-1.example.test ${HOST_KEY}\n`)
    await executor.run('beta-1', applyRequest('beta-1'), 5_000)
    expect(ssh.invocations()).toHaveLength(1)
  }, 30_000)

  test('a missing known_hosts file is refused the same way', async () => {
    const root = tempRoot()
    const ssh = fakeSsh(join(root, 'ssh'))
    const executor = new ProviderExecutor([sshTarget(root)], {
      knownHostsFile: join(root, 'absent'),
      sshBinary: ssh.binary,
    })
    const result = await executor.run('beta-1', applyRequest('beta-1'), 5_000)
    expect(result.ok ? 'ok' : result.reason).toBe('known-hosts')
    expect(ssh.invocations()).toEqual([])
  }, 30_000)
})

describe('the ssh path', () => {
  function setup() {
    const root = tempRoot()
    const ssh = fakeSsh(join(root, 'ssh'))
    const node = fakeNode(join(root, 'node'))
    const knownHosts = join(root, 'known_hosts')
    writeFileSync(knownHosts, `node-1.example.test ${HOST_KEY}\n`)
    const executor = new ProviderExecutor([sshTarget(root)], {
      knownHostsFile: knownHosts,
      sshBinary: ssh.binary,
    })
    return { root, ssh, node, knownHosts, executor }
  }

  test('the argv carries no key; the key travels on stdin only', async () => {
    const { ssh, node, knownHosts, executor, root } = setup()
    ssh.forcedCommand(`${node.command} beta-1`)
    const result = await executor.run('beta-1', applyRequest('beta-1'), 10_000)
    expect(result.ok).toBe(true)
    const [argv] = ssh.invocations()
    expect(argv).toBeDefined()
    const joined = (argv ?? []).join('\n')
    expect(joined).not.toContain(CANARY)
    expect(joined).not.toContain(CANARY.slice(-12))
    // The fixed parts of §2.5.
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain(`UserKnownHostsFile=${knownHosts}`)
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('IdentitiesOnly=yes')
    expect(argv).toContain('ControlPath=none')
    expect(argv?.[argv.indexOf('-i') + 1]).toBe(join(root, 'keys', 'beta-1'))
    expect(argv?.at(-2)).toBe('qianmo@node-1.example.test')
    expect(argv?.at(-1)).toBe(SENTINEL_COMMAND)
    // Positive control: the key did reach the node, through stdin.
    const [request] = node.requests()
    expect(JSON.stringify(request)).toContain(CANARY)
  }, 30_000)

  test('the forced command ignores the client command (it sees it only as SSH_ORIGINAL_COMMAND)', async () => {
    const { ssh, node, executor } = setup()
    ssh.forcedCommand(`${node.command} beta-1`)
    await executor.run('beta-1', applyRequest('beta-1'), 10_000)
    expect(node.argv()[0]?.node).toBe('beta-1')
  }, 30_000)

  test('sentinel: with the forced command gone, the operation fails instead of succeeding', async () => {
    const { ssh, node, executor } = setup()
    ssh.forcedCommand(null)
    const result = await executor.run('beta-1', applyRequest('beta-1'), 10_000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('forced-command')
      expect(result.message).toContain('强制命令')
    }
    expect(node.requests()).toEqual([])
    // Positive control: the same executor succeeds once the line is back.
    ssh.forcedCommand(`${node.command} beta-1`)
    expect(
      (await executor.run('beta-1', applyRequest('beta-1'), 10_000)).ok,
    ).toBe(true)
  }, 30_000)

  test('ssh gets a minimal environment: no PSK, no token, no agent socket', async () => {
    const { ssh, node } = setup()
    ssh.forcedCommand(`${node.command} beta-1`)
    const executorWithEnv = new ProviderExecutor([sshTarget(tempRoot())], {
      knownHostsFile: join(ssh.dir, '..', 'known_hosts'),
      sshBinary: ssh.binary,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        QIANMO_TRANSPORT_PSK: CANARY,
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        QIANMO_CONSOLE_ADMIN_TOKEN: CANARY,
      },
    })
    await executorWithEnv.run('beta-1', applyRequest('beta-1'), 10_000)
    const env = node.argv()[0]?.env ?? []
    expect(env).not.toContain('QIANMO_TRANSPORT_PSK')
    expect(env).not.toContain('SSH_AUTH_SOCK')
    expect(env).not.toContain('QIANMO_CONSOLE_ADMIN_TOKEN')
    expect(env).toContain('SSH_ORIGINAL_COMMAND')
  }, 30_000)
})

describe('the local path', () => {
  test('runs `<command> <node>` with the request on stdin and a minimal env', async () => {
    const root = tempRoot()
    const node = fakeNode(join(root, 'node'))
    const executor = new ProviderExecutor(
      [{ node: 'beta-4', kind: 'local', command: node.command }],
      {
        knownHostsFile: join(root, 'unused'),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          QIANMO_BETA_ROOT: '/srv/beta',
          QIANMO_TRANSPORT_PSK: CANARY,
        },
      },
    )
    const result = await executor.run('beta-4', applyRequest('beta-4'), 10_000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.reply.ok).toBe(true)
    const [started] = node.argv()
    expect(started?.node).toBe('beta-4')
    expect(started?.env).toContain('QIANMO_BETA_ROOT')
    expect(started?.env).not.toContain('QIANMO_TRANSPORT_PSK')
  }, 30_000)

  test('a node that answers garbage, the wrong request id, or nothing is a failure', async () => {
    const root = tempRoot()
    const node = fakeNode(join(root, 'node'))
    const executor = new ProviderExecutor(
      [{ node: 'beta-4', kind: 'local', command: node.command }],
      { knownHostsFile: join(root, 'unused') },
    )
    node.set('raw-apply', '0\nnot json\n')
    let result = await executor.run('beta-4', applyRequest('beta-4'), 10_000)
    expect(result.ok ? 'ok' : result.reason).toBe('no-response')

    node.set(
      'raw-apply',
      `0\n${JSON.stringify({ v: 1, requestId: 'someone-else', ok: true })}\n`,
    )
    result = await executor.run('beta-4', applyRequest('beta-4'), 10_000)
    expect(result.ok ? 'ok' : result.reason).toBe('no-response')

    node.set('raw-apply', '2\n')
    result = await executor.run('beta-4', applyRequest('beta-4'), 10_000)
    expect(result.ok ? 'ok' : result.reason).toBe('no-response')

    // An honest refusal is a reply, not a failure.
    rmSync(join(node.dir, 'raw-apply'))
    node.set(
      'reply-apply.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: false,
        code: 'busy',
        message: '另一次下发正在进行',
      }),
    )
    result = await executor.run('beta-4', applyRequest('beta-4'), 10_000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.reply.code).toBe('busy')
  }, 30_000)

  test('a node that does not answer in time is killed and reported', async () => {
    const root = tempRoot()
    const node = fakeNode(join(root, 'node'))
    node.set('delay-ms', '5000')
    const executor = new ProviderExecutor(
      [{ node: 'beta-4', kind: 'local', command: node.command }],
      { knownHostsFile: join(root, 'unused') },
    )
    const started = Date.now()
    const result = await executor.run('beta-4', applyRequest('beta-4'), 500)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(result.ok ? 'ok' : result.reason).toBe('timeout')
  }, 30_000)
})

describe('one operation per node at a time', () => {
  test('two operations on the same node do not overlap; two nodes do', async () => {
    const root = tempRoot()
    const one = fakeNode(join(root, 'one'))
    const two = fakeNode(join(root, 'two'))
    for (const node of [one, two]) node.set('delay-ms', '1500')
    const executor = new ProviderExecutor(
      [
        { node: 'beta-1', kind: 'local', command: one.command },
        { node: 'beta-2', kind: 'local', command: two.command },
      ],
      { knownHostsFile: join(root, 'unused') },
    )
    await Promise.all([
      executor.run('beta-1', applyRequest('beta-1', 'req-same-00001'), 10_000),
      executor.run('beta-1', applyRequest('beta-1', 'req-same-00002'), 10_000),
      executor.run('beta-2', applyRequest('beta-2', 'req-other-0001'), 10_000),
    ])
    const spans = one.spans().sort((a, b) => a.start - b.start)
    expect(spans).toHaveLength(2)
    const [first, second] = spans
    expect(second?.start ?? 0).toBeGreaterThanOrEqual(first?.end ?? Infinity)
    // Positive control: the other node did not queue behind beta-1 — it ran
    // while beta-1 was still busy (a single global queue would start it only
    // after beta-1's second operation ended).
    const [other] = two.spans()
    expect(other?.start ?? Infinity).toBeLessThan(second?.end ?? 0)
  }, 30_000)
})

describe('dial pacing (v2.47.2: nodes rate-limit new ssh connections)', () => {
  const WINDOW = 1_500
  const MARGIN = 1_000
  const REFUSED =
    'ssh: connect to host node-1.example.test port 22: Connection refused'

  function setup(dialsPerWindow = 2, windowMs = WINDOW) {
    const root = tempRoot()
    const ssh = fakeSsh(join(root, 'ssh'))
    const node = fakeNode(join(root, 'node'))
    const knownHosts = join(root, 'known_hosts')
    writeFileSync(knownHosts, `node-1.example.test ${HOST_KEY}\n`)
    ssh.forcedCommand(`${node.command} beta-1`)
    const executor = new ProviderExecutor([sshTarget(root)], {
      knownHostsFile: knownHosts,
      sshBinary: ssh.binary,
      dialWindowMs: windowMs,
      dialsPerWindow,
    })
    /** When each dial started (the fake ssh writes its argv first thing). */
    const dialTimes = () =>
      readdirSync(ssh.dir)
        .filter(name => name.startsWith('ssh-argv-'))
        .map(name => statSync(join(ssh.dir, name)).mtimeMs)
        .sort((a, b) => a - b)
    return { ssh, node, executor, dialTimes }
  }

  test('the defaults are what ufw limit allows: 3 new connections per 30 s', () => {
    expect(DIAL_WINDOW_MS).toBe(30_000)
    expect(DIALS_PER_WINDOW).toBe(3)
  })

  test('a dial past the window waits for the oldest to age out; the ones inside do not', async () => {
    const { executor, dialTimes } = setup()
    // Lower bounds are taken from before the first run: the fake ssh writes
    // its argv a variable few hundred ms after the executor booked the dial.
    const started = Date.now()
    for (const id of ['req-pace-00001', 'req-pace-00002', 'req-pace-00003']) {
      const result = await executor.run(
        'beta-1',
        applyRequest('beta-1', id),
        10_000,
      )
      expect(result.ok).toBe(true)
    }
    const [, second, third] = dialTimes()
    // Positive control: the first two went straight out.
    expect((second ?? Infinity) - started).toBeLessThan(WINDOW)
    // The third waited until the first had left the window (plus the margin).
    expect((third ?? 0) - started).toBeGreaterThanOrEqual(WINDOW + MARGIN - 20)
  }, 30_000)

  test('a background run with the window full dials nothing and answers deferred', async () => {
    // A wider window than the shared one: the first run alone can take longer
    // than 1.5 s on a loaded machine, and the window must still be full when
    // the background run asks.
    const window = 6_000
    const { ssh, executor } = setup(1, window)
    expect(
      (await executor.run('beta-1', applyRequest('beta-1'), 10_000)).ok,
    ).toBe(true)
    const status = {
      v: 1,
      op: 'status',
      requestId: 'req-bg-000001',
      node: 'beta-1',
    }
    const deferred = await executor.run('beta-1', status, 10_000, {
      background: true,
    })
    expect(deferred.ok ? 'ok' : deferred.reason).toBe('deferred')
    expect(ssh.invocations()).toHaveLength(1)
    // Positive control: once the window has room, the same run dials.
    await new Promise(resolve => setTimeout(resolve, window + MARGIN + 100))
    const later = await executor.run('beta-1', status, 10_000, {
      background: true,
    })
    expect(later.ok).toBe(true)
    expect(ssh.invocations()).toHaveLength(2)
  }, 30_000)

  test('refused before the handshake: one redial after the window, and it lands', async () => {
    const { ssh, node, executor, dialTimes } = setup()
    ssh.refuse(1, REFUSED)
    const started = Date.now()
    const result = await executor.run('beta-1', applyRequest('beta-1'), 10_000)
    expect(result.ok).toBe(true)
    const [, redial] = dialTimes()
    expect(dialTimes()).toHaveLength(2)
    expect((redial ?? 0) - started).toBeGreaterThanOrEqual(WINDOW + MARGIN - 20)
    expect(node.requests()).toHaveLength(1)
  }, 30_000)

  test('banner-exchange refusals count as before the handshake too; a second refusal is reported', async () => {
    const { ssh, node, executor } = setup()
    ssh.refuse(
      2,
      'kex_exchange_identification: Connection closed by remote host',
    )
    const result = await executor.run('beta-1', applyRequest('beta-1'), 10_000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('ssh')
      expect(result.preHandshake).toBe(true)
      expect(result.message).toContain('握手前就被拒')
    }
    expect(ssh.invocations()).toHaveLength(2)
    expect(node.requests()).toEqual([])
  }, 30_000)

  test('a connection dropped after the handshake is not redialed (the request may have landed)', async () => {
    const { ssh, executor } = setup()
    ssh.refuse(1, 'Connection to node-1.example.test closed by remote host.')
    const result = await executor.run('beta-1', applyRequest('beta-1'), 10_000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('ssh')
      expect(result.preHandshake).toBeUndefined()
      expect(result.message).toBe('ssh 失败：连不上节点')
    }
    expect(ssh.invocations()).toHaveLength(1)
  }, 30_000)

  test('a background run is never redialed', async () => {
    const { ssh, executor } = setup()
    ssh.refuse(1, REFUSED)
    const status = {
      v: 1,
      op: 'status',
      requestId: 'req-bg-000002',
      node: 'beta-1',
    }
    const result = await executor.run('beta-1', status, 10_000, {
      background: true,
    })
    expect(result.ok ? 'ok' : result.reason).toBe('ssh')
    expect(ssh.invocations()).toHaveLength(1)
  }, 30_000)
})
