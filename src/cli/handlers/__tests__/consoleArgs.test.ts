// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `occ console` 的参数面与四个端口的生产实现。
 *
 * **零 `mock.module`**：注册中心那一半跑的是真的 `startRegistryServer(0)`
 * （绑随机端口，测完 stop），审计那一半写的是真的审计链文件。仓库对内联
 * `mock.module` 是零容忍棘轮，而这里也确实不需要——两个依赖都能便宜地起真的，
 * 假的那一份反倒测不出「地址有没有正确地百分号编码进单个 path segment」这类
 * 只有真服务端才会计较的事。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import { LIMITS } from '@qianmo/protocol'
import {
  DEFAULT_TTL_MS,
  startRegistryServer,
  type RegistryServerHandle,
} from '@qianmo/registry'
import { RUNTIME_RATE } from '@qianmo/router'
import { auditTrailPath } from '../../../services/qianmo/auditTrail.js'
import {
  DEFAULT_CONSOLE_CHAT_FROM,
  DEFAULT_CONSOLE_HOSTNAME,
  DEFAULT_CONSOLE_PORT,
  DEFAULT_CONSOLE_REGISTRY_URL,
  MAX_CONSOLE_LABEL_LENGTH,
  assertConsoleRuntime,
  consoleChatStorePath,
  parseConsoleArgs,
} from '../consoleArgs.js'
import {
  DEFAULT_AUDIT_LIMIT,
  consoleLimits,
  createAuditPort,
  createRegistryPort,
} from '../consolePorts.js'

describe('occ console argument parsing', () => {
  test('runs on the loopback demo ports with no arguments at all', () => {
    expect(parseConsoleArgs([], 'qianmo')).toEqual({
      port: DEFAULT_CONSOLE_PORT,
      hostname: DEFAULT_CONSOLE_HOSTNAME,
      registryUrl: DEFAULT_CONSOLE_REGISTRY_URL,
      auditPath: auditTrailPath(),
      label: `${DEFAULT_CONSOLE_HOSTNAME}:${DEFAULT_CONSOLE_PORT}`,
      // 聊天面默认关着：没有 --chat-url 就没有可拨的端点，`/chat` 整页不存在。
      chatUrls: [],
      chatFrom: DEFAULT_CONSOLE_CHAT_FROM,
      chatStorePath: consoleChatStorePath(),
    })
  })

  test('derives the transcript path from the config root, never from $HOME', () => {
    // CLAUDE.md §1.1②：身份相关路径只能从 `paths.ts` 派生，否则 OCC_CONFIG_DIR
    // 对它无效——演示拓扑给每个进程一个配置根，转录也必须跟着分家。
    const path = consoleChatStorePath()
    expect(path.endsWith('/qianmo/console/chat.ndjson')).toBe(true)
    expect(parseConsoleArgs([], 'qianmo').chatStorePath).toBe(path)
  })

  test('keeps 38613 clear of the three ports demo-env.md §2.4 assigns', () => {
    // 38610 注册中心 / 38611 节点 A / 38612 节点 B —— 控制台要能和整套演示
    // 拓扑同时起在一台机器上。
    expect([38_610, 38_611, 38_612]).not.toContain(DEFAULT_CONSOLE_PORT)
  })

  test('accepts every option in both --x value and --x=value form', () => {
    const split = parseConsoleArgs(
      [
        '--port',
        '39000',
        '--hostname',
        '0.0.0.0',
        '--registry',
        'http://10.0.0.2:38610',
        '--audit',
        '/tmp/qianmo/trail.ndjson',
        '--wake-url',
        'ws://10.0.0.3:38611',
        '--label',
        'node-a 控制台',
        '--view-token',
        'view-token-long-enough',
        '--admin-token',
        'admin-token-long-enough',
        '--chat-url',
        'ws://10.0.0.3:38611',
        '--chat-url',
        'ws://10.0.0.4:38612',
        '--chat-from',
        'qianmo://ops/alice',
        '--chat-store',
        '/tmp/qianmo/chat.ndjson',
      ],
      'qianmo',
    )
    const joined = parseConsoleArgs(
      [
        '--port=39000',
        '--hostname=0.0.0.0',
        '--registry=http://10.0.0.2:38610',
        '--audit=/tmp/qianmo/trail.ndjson',
        '--wake-url=ws://10.0.0.3:38611',
        '--label=node-a 控制台',
        '--view-token=view-token-long-enough',
        '--admin-token=admin-token-long-enough',
        '--chat-url=ws://10.0.0.3:38611',
        '--chat-url=ws://10.0.0.4:38612',
        '--chat-from=qianmo://ops/alice',
        '--chat-store=/tmp/qianmo/chat.ndjson',
      ],
      'qianmo',
    )

    expect(split).toEqual(joined)
    expect(split).toEqual({
      port: 39_000,
      hostname: '0.0.0.0',
      registryUrl: 'http://10.0.0.2:38610',
      auditPath: '/tmp/qianmo/trail.ndjson',
      wakeUrl: 'ws://10.0.0.3:38611/',
      label: 'node-a 控制台',
      viewToken: 'view-token-long-enough',
      adminToken: 'admin-token-long-enough',
      chatUrls: ['ws://10.0.0.3:38611/', 'ws://10.0.0.4:38612/'],
      chatFrom: 'qianmo://ops/alice',
      chatStorePath: '/tmp/qianmo/chat.ndjson',
    })
  })

  test('takes --chat-url more than once and folds a repeat', () => {
    // 同一个端点给两次是复制粘贴，不是「建两条链路」。
    expect(
      parseConsoleArgs(
        [
          '--chat-url=ws://127.0.0.1:38611',
          '--chat-url=ws://127.0.0.1:38611/',
          '--chat-url=ws://127.0.0.1:38612',
        ],
        'qianmo',
      ).chatUrls,
    ).toEqual(['ws://127.0.0.1:38611/', 'ws://127.0.0.1:38612/'])
  })

  test('rejects a chat endpoint that is not ws or wss', () => {
    expect(() =>
      parseConsoleArgs(['--chat-url=http://127.0.0.1:38611'], 'qianmo'),
    ).toThrow('--chat-url must use ws or wss')
    expect(() =>
      parseConsoleArgs(['--chat-store=relative/chat.ndjson'], 'qianmo'),
    ).toThrow('--chat-store must be an absolute path')
    expect(() => parseConsoleArgs(['--chat-from=  '], 'qianmo')).toThrow(
      '--chat-from must not be empty',
    )
  })

  test('strips the trailing slash so /v0/agents never doubles up', () => {
    expect(
      parseConsoleArgs(['--registry=http://127.0.0.1:38610/'], 'qianmo')
        .registryUrl,
    ).toBe('http://127.0.0.1:38610')
  })

  test('defaults the header label to the address it is bound to', () => {
    expect(
      parseConsoleArgs(['--port=39001', '--hostname=127.0.0.5'], 'qianmo')
        .label,
    ).toBe('127.0.0.5:39001')
  })

  test('requires the Qianmo identity', () => {
    expect(() => parseConsoleArgs([], 'occ')).toThrow('OCC_IDENTITY=qianmo')
  })

  test('takes the whole legal port range and nothing outside it', () => {
    expect(parseConsoleArgs(['--port=0'], 'qianmo').port).toBe(0)
    expect(parseConsoleArgs(['--port=65535'], 'qianmo').port).toBe(65_535)
    for (const bad of ['-1', '65536', '1.5', 'abc', '']) {
      expect(() => parseConsoleArgs([`--port=${bad}`], 'qianmo')).toThrow(
        '--port',
      )
    }
  })

  test('rejects protocols that the two URL options cannot mean', () => {
    expect(() =>
      parseConsoleArgs(['--registry=ws://127.0.0.1:38610'], 'qianmo'),
    ).toThrow('--registry must use http or https')
    expect(() =>
      parseConsoleArgs(['--wake-url=http://127.0.0.1:38611'], 'qianmo'),
    ).toThrow('--wake-url must use ws or wss')
    expect(() => parseConsoleArgs(['--registry=not-a-url'], 'qianmo')).toThrow()
  })

  test('insists the trail path is absolute', () => {
    expect(() =>
      parseConsoleArgs(['--audit=relative/trail.ndjson'], 'qianmo'),
    ).toThrow('--audit must be an absolute path')
  })

  test('rejects blank and oversized labels and blank tokens', () => {
    expect(() => parseConsoleArgs(['--label=   '], 'qianmo')).toThrow(
      '--label must not be empty',
    )
    expect(() =>
      parseConsoleArgs(
        [`--label=${'x'.repeat(MAX_CONSOLE_LABEL_LENGTH + 1)}`],
        'qianmo',
      ),
    ).toThrow('--label must be at most')
    expect(() => parseConsoleArgs(['--view-token=  '], 'qianmo')).toThrow(
      '--view-token must not be empty',
    )
  })

  test('names an unknown option rather than ignoring it', () => {
    expect(() => parseConsoleArgs(['--registy=x'], 'qianmo')).toThrow(
      'unknown console option --registy=x',
    )
    expect(() => parseConsoleArgs(['--port'], 'qianmo')).toThrow(
      '--port requires a value',
    )
  })

  test('refuses to run off Bun', () => {
    expect(() => assertConsoleRuntime(false)).toThrow('Bun runtime')
    expect(() => assertConsoleRuntime(true)).not.toThrow()
  })
})

describe('console limits snapshot', () => {
  test('quotes the three owning packages instead of copying numbers', () => {
    expect(consoleLimits()).toEqual({
      protocol: {
        maxMessageBytes: LIMITS.maxMessageBytes,
        maxHops: LIMITS.maxHops,
        defaultTtlMs: LIMITS.defaultTtlMs,
        defaultTaskTtlMs: LIMITS.defaultTaskTtlMs,
        ratePerMinute: LIMITS.ratePerMinute,
      },
      runtime: {
        capacity: RUNTIME_RATE.capacity,
        windowMs: RUNTIME_RATE.windowMs,
      },
      registryTtlMs: DEFAULT_TTL_MS,
    })
  })

  test('keeps the two rate limits in two columns (charter AC-3)', () => {
    const limits = consoleLimits()
    // 协议速率与运行时速率**不得混为一谈**（packages/router/src/rate.ts）。
    expect(limits.protocol.ratePerMinute).not.toBe(limits.runtime.capacity)
  })
})

describe('console audit port', () => {
  let directory: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'qianmo-console-audit-'))
  })
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test('reports an empty page when no trail has been written yet', async () => {
    const port = createAuditPort({ path: join(directory, 'absent.ndjson') })
    const page = await port.read({})

    // 还没产生审计不是错误，是一个刚起来的节点的正常状态。
    expect(page).toEqual({
      ok: true,
      value: { records: [], intact: true, issueCount: 0, total: 0 },
    })
  })

  test('answers a chain query on a missing trail with null, not a failure', async () => {
    const port = createAuditPort({ path: join(directory, 'absent.ndjson') })
    expect(await port.chain('0af7651916cd43dd8448eb211c80319c')).toEqual({
      ok: true,
      value: null,
    })
  })

  test('filters, tails and reports the pre-filter total', async () => {
    const path = join(directory, 'trail.ndjson')
    const trail = new AuditTrail(path)
    const traceId = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    for (let index = 0; index < 5; index++) {
      trail.append({
        at: 1_700_000_000_000 + index,
        source: AuditSource.Transport,
        kind: 'message_accepted',
        outcome: 'ok',
        node: 'node-a',
        traceId,
        msgId: `msg-${index}`,
      })
    }
    trail.append({
      at: 1_700_000_000_010,
      source: AuditSource.Router,
      kind: 'runtime_throttled',
      outcome: 'refused',
      node: 'node-a',
      traceId,
    })
    trail.close()

    const port = createAuditPort({ path })

    const all = await port.read({})
    expect(all.ok).toBe(true)
    if (!all.ok) throw new Error('unreachable')
    expect(all.value.total).toBe(6)
    expect(all.value.intact).toBe(true)
    expect(all.value.issueCount).toBe(0)
    expect(all.value.records).toHaveLength(6)

    // limit 取的是**尾部**，和 `occ audit --limit` 同一语义。
    const tail = await port.read({ limit: 2 })
    if (!tail.ok) throw new Error('unreachable')
    expect(tail.value.records.map(record => record.seq)).toEqual([5, 6])
    // total 是过滤前的总数，页面据此说「共 6 条中的 2 条」。
    expect(tail.value.total).toBe(6)

    const refused = await port.read({ outcome: 'refused' })
    if (!refused.ok) throw new Error('unreachable')
    expect(refused.value.records).toHaveLength(1)
    expect(refused.value.records[0]?.kind).toBe('runtime_throttled')
    expect(refused.value.total).toBe(6)

    const bySource = await port.read({ source: AuditSource.Transport })
    if (!bySource.ok) throw new Error('unreachable')
    expect(bySource.value.records).toHaveLength(5)
  })

  test('reconstructs a chain including what was refused', async () => {
    const port = createAuditPort({ path: join(directory, 'trail.ndjson') })
    const chain = await port.chain('0af7651916cd43dd8448eb211c80319c')
    if (!chain.ok) throw new Error('unreachable')
    expect(chain.value?.records).toHaveLength(6)
    expect(chain.value?.refused).toBe(1)
  })

  test('says so when a filter names something that does not exist', async () => {
    const port = createAuditPort({ path: join(directory, 'trail.ndjson') })
    // 拼错的 source 静默匹配到零条，会被读成「这段时间什么都没发生」。
    expect(await port.read({ source: 'transprot' })).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.read({ outcome: 'okay' })).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.read({ from: Number.NaN })).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.chain('   ')).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
  })

  test('surfaces a broken hash chain instead of swallowing it', async () => {
    const path = join(directory, 'tampered.ndjson')
    const trail = new AuditTrail(path)
    trail.append({
      at: 1_700_000_000_000,
      source: AuditSource.Registry,
      kind: 'registered',
      outcome: 'ok',
      node: 'node-a',
    })
    trail.close()
    writeFileSync(path, '{"seq":1,"at":1,"source":"registry"}\n')

    const page = await createAuditPort({ path }).read({})
    if (!page.ok) throw new Error('unreachable')
    expect(page.value.intact).toBe(false)
    expect(page.value.issueCount).toBeGreaterThan(0)
  })

  test('defaults the tail to the same 200 as occ audit', () => {
    expect(DEFAULT_AUDIT_LIMIT).toBe(200)
  })
})

describe('console registry port', () => {
  let server: RegistryServerHandle

  beforeAll(() => {
    server = startRegistryServer(0)
  })
  afterAll(async () => {
    await server.stop()
  })

  const address = 'qianmo://node-b/reviewer'

  test('drives the real HTTP v0 surface through all four calls', async () => {
    const port = createRegistryPort({ baseUrl: server.url })

    expect(await port.list()).toEqual({ ok: true, value: [] })

    const registered = await port.register({
      address,
      endpoint: 'ws://127.0.0.1:38612',
      capabilities: ['review'],
    })
    if (!registered.ok) throw new Error(registered.failure.message)
    expect(registered.value.address).toBe(address)
    expect(registered.value.capabilities).toEqual(['review'])
    expect(registered.value.expiresAt).toBeGreaterThan(0)
    // 私钥永远不出现在这条路径上；公钥没发布时字段就该缺席。
    expect(registered.value.publicKey).toBeUndefined()

    const listed = await port.list()
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.value.map(agent => agent.address)).toEqual([address])

    // 地址里的 `://` 与 `/` 必须百分号编码进**单个** path segment，否则服务端
    // split 出来的段数对不上，这一条会静默变成另一条路由。
    const beat = await port.heartbeat(address)
    if (!beat.ok) throw new Error(beat.failure.message)
    expect(beat.value.lastHeartbeatAt).toBeGreaterThanOrEqual(
      registered.value.registeredAt,
    )

    expect(await port.deregister(address)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await port.list()).toEqual({ ok: true, value: [] })
  })

  test('maps the registry own error codes onto port failures', async () => {
    const port = createRegistryPort({ baseUrl: server.url })

    expect(await port.heartbeat('qianmo://node-z/ghost')).toMatchObject({
      ok: false,
      failure: { code: 'not_found' },
    })
    expect(await port.deregister('qianmo://node-z/ghost')).toMatchObject({
      ok: false,
      failure: { code: 'not_found' },
    })
    expect(
      await port.register({ address: 'not-an-address', endpoint: 'nope' }),
    ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
  })

  test('refuses an empty address locally rather than hitting the collection route', async () => {
    const port = createRegistryPort({ baseUrl: server.url })
    // `DELETE /v0/agents/` 会退化成集合路由——删到的不是调用方想删的东西。
    expect(await port.deregister('   ')).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.heartbeat('')).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
  })

  test('turns an unreachable registry into a failure, never a throw', async () => {
    // 真的关掉一个真的服务端，拿到真的 ECONNREFUSED。
    const doomed = startRegistryServer(0)
    const baseUrl = doomed.url
    await doomed.stop()

    const port = createRegistryPort({ baseUrl, timeoutMs: 1_000 })
    const listed = await port.list()

    // 面板要在注册中心挂掉时照常打开——这是它存在的一半理由。
    expect(listed).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    if (listed.ok) throw new Error('unreachable')
    expect(listed.failure.message).toContain(baseUrl)

    expect(await port.register({ address, endpoint: 'ws://x' })).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(await port.heartbeat(address)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(await port.deregister(address)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
  })

  test('gives up on a registry that accepts and then never answers', async () => {
    // 不回包（而不是拒连）是 fetch 默认会永远等下去的那一种挂法。
    const stalled = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Promise<Response>(() => {}),
    })
    try {
      const port = createRegistryPort({
        baseUrl: `http://127.0.0.1:${stalled.port}`,
        timeoutMs: 150,
      })
      expect(await port.list()).toMatchObject({
        ok: false,
        failure: { code: 'unreachable' },
      })
    } finally {
      await stalled.stop(true)
    }
  })

  test('does not mistake a malformed body for a roster', async () => {
    const shaped = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ nope: true }),
    })
    try {
      const port = createRegistryPort({
        baseUrl: `http://127.0.0.1:${shaped.port}`,
      })
      expect(await port.list()).toMatchObject({
        ok: false,
        failure: { code: 'invalid' },
      })
    } finally {
      await shaped.stop(true)
    }
  })

  test('drops a roster row that has no address instead of showing a ghost', async () => {
    const partial = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        Response.json({
          agents: [
            { endpoint: 'ws://x', status: 'online' },
            {
              address,
              endpoint: 'ws://127.0.0.1:38612',
              status: 'online',
              capabilities: ['review', 7],
              registeredAt: 1,
              lastHeartbeatAt: 2,
              expiresAt: 3,
            },
          ],
        }),
    })
    try {
      const port = createRegistryPort({
        baseUrl: `http://127.0.0.1:${partial.port}`,
      })
      const listed = await port.list()
      if (!listed.ok) throw new Error('unreachable')
      expect(listed.value).toHaveLength(1)
      expect(listed.value[0]?.address).toBe(address)
      // 非字符串的能力项被丢掉，而不是把整行判废。
      expect(listed.value[0]?.capabilities).toEqual(['review'])
    } finally {
      await partial.stop(true)
    }
  })
})
