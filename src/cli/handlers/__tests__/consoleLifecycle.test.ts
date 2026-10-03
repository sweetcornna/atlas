// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.2 生命周期（`tenancy-m1.md` §3.6、§6 P15.2 行）：登记簿的状态与操作主体、
 * 托管清单、退役不再分配、读不出来时 fail-closed，以及三个出口——对话、唤醒、
 * `qm watch`——对暂停地址的发起次数。
 *
 * **零 `mock.module`**：注册中心是真的 `InMemoryRegistry` 套真的 HTTP v0 处理
 * 函数，控制台一侧是真的 `createRegistryPort`，只把 `fetch` 接到处理函数上并
 * 数一数；登记簿写真的临时文件；三个出口是真的 chat hub、真的唤醒闸、真的
 * `qm watch` 派发函数，只有最底下拨号的那一层换成手写的计数端口——「发起次数为
 * 零」数的就是它们。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AuditInput, AuditRecord } from '@qianmo/audit'
import type {
  ConsoleAgent,
  ConsoleResult,
  LifecycleOutcome,
  RegisterAgentInput,
  RegistryPort,
  WakeInput,
  WakeOutcome,
  WakePort,
} from '@qianmo/console'
import type { QianmoMessage } from '@qianmo/protocol'
import {
  InMemoryRegistry,
  ManualClock,
  createRegistryHandler,
  startRegistryServer,
} from '@qianmo/registry'
import { assertJob, type FireDispatch } from '@qianmo/scheduler'
import { ReceiptStatus } from '@qianmo/transport'
import {
  createConsoleChatPort,
  type ChatDialer,
  type ChatLink,
} from '../consoleChat.js'
import { parseConsoleArgs, transportPskEnvVarForNode } from '../consoleArgs.js'
import { createRegistryPort } from '../consolePorts.js'
import { readExitRefusal } from '../consoleRegistrationLedger.js'
import {
  ConsoleRegistrations,
  REGISTRATION_LEDGER_VERSION,
  gateWakePort,
} from '../consoleRegistrations.js'
import { createWatchDispatch } from '../watch.js'

const PLANNER = 'qianmo://node-a/planner'
const PLANNER_EP = 'ws://127.0.0.1:38611'
const REVIEWER = 'qianmo://node-b/reviewer'
const REVIEWER_EP = 'ws://127.0.0.1:38612'
const STRANGER = 'qianmo://node-z/stranger'
const STRANGER_EP = 'ws://10.0.0.9:38611'
const OPS = 'u:0123456789abcdef'
const FROM = 'qianmo://console/operator'
const PSK = 'demo-psk-that-is-long-enough-000'
const START = 1_000_000

/** 中枢 peers.conf 的两条地址行。 */
const MANAGED = [
  { address: PLANNER, endpoint: PLANNER_EP },
  { address: REVIEWER, endpoint: REVIEWER_EP },
] as const

/** 按 Unix 权限造读写失败；root 无视权限位、Windows 没有这套位。 */
const PERMISSIONS_BITE =
  process.platform !== 'win32' && process.getuid?.() !== 0

const roots: string[] = []

afterAll(() => {
  for (const root of roots) {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-console-lifecycle-'))
  roots.push(dir)
  return dir
}

/** 一个还不存在的登记簿路径，父目录也还不存在。 */
function freshLedgerPath(): string {
  return join(scratch(), 'qianmo', 'console', 'registrations.json')
}

function writeLedger(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(document))
}

function onDisk(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 真注册中心 + 真 HTTP 端口 + 登记簿。`calls` 数的是到达注册中心的发布（`POST
 * /v0/agents`）与撤销（`DELETE`）——本地拒绝的用例要证明它们是零。
 */
function harness(
  options: { readonly path?: string; readonly managed?: boolean } = {},
) {
  const clock = new ManualClock(START)
  const registry = new InMemoryRegistry({ clock })
  const handle = createRegistryHandler(registry)
  const calls = { post: 0, delete: 0 }
  const port = createRegistryPort({
    baseUrl: 'http://registry.test',
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (request.method === 'POST' && path === '/v0/agents') calls.post += 1
      if (request.method === 'DELETE') calls.delete += 1
      return await handle(request)
    },
  })
  const path = options.path ?? freshLedgerPath()
  const lines: string[] = []
  const build = () =>
    new ConsoleRegistrations({
      path,
      registry: port,
      ...(options.managed === false ? {} : { managed: MANAGED }),
      log: line => lines.push(line),
      now: () => clock.now(),
    })
  return { clock, registry, calls, path, lines, build, ledger: build() }
}

function listed(registry: InMemoryRegistry): string[] {
  return registry.list().map(entry => entry.address)
}

/** 结局的码：做成了是 `ok`，这一侧拒的是拒绝码，注册中心没收是 `registry:<码>`。 */
function codeOf(outcome: LifecycleOutcome<unknown>): string {
  if (outcome.ok) return 'ok'
  return 'refusal' in outcome
    ? outcome.refusal.code
    : `registry:${outcome.failure.code}`
}

describe('the ledger records state and who changed it (DoD ①)', () => {
  test('publish, pause, resume and retire each write the state and the subject, and a rebuild reads them back', async () => {
    const h = harness()
    expect(
      codeOf(await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)),
    ).toBe('ok')
    // 端点从托管清单来，表单不必给。
    expect(h.registry.resolve(PLANNER)?.endpoint).toBe(PLANNER_EP)
    // active 不写 state：缺省即 active，与旧文件同一个形状。
    expect(onDisk(h.path)).toEqual({
      version: REGISTRATION_LEDGER_VERSION,
      registrations: [
        { address: PLANNER, endpoint: PLANNER_EP, by: OPS, at: START },
      ],
    })

    h.clock.advance(5_000)
    const paused = await h.ledger.lifecycle.pause(PLANNER, 'legacy:admin')
    expect(paused).toEqual({
      ok: true,
      value: {
        registration: {
          address: PLANNER,
          state: 'paused',
          by: 'legacy:admin',
          at: START + 5_000,
          managed: true,
        },
      },
    })
    // 注册中心那条立即撤掉，续租者不再碰它。
    expect(listed(h.registry)).toEqual([])
    expect(h.ledger.addresses).toEqual([])
    expect(onDisk(h.path)).toEqual({
      version: REGISTRATION_LEDGER_VERSION,
      registrations: [
        {
          address: PLANNER,
          endpoint: PLANNER_EP,
          state: 'paused',
          by: 'legacy:admin',
          at: START + 5_000,
        },
      ],
    })

    // 重建 = 重启：除了那个文件，什么都不共享。
    const rebuilt = h.build()
    expect(await rebuilt.lifecycle.read()).toEqual({
      problem: null,
      managed: [PLANNER, REVIEWER],
      registrations: [
        {
          address: PLANNER,
          state: 'paused',
          by: 'legacy:admin',
          at: START + 5_000,
          managed: true,
        },
      ],
    })

    h.clock.advance(5_000)
    const resumed = await rebuilt.lifecycle.resume(PLANNER, OPS)
    expect(codeOf(resumed)).toBe('ok')
    if (resumed.ok) {
      expect(resumed.value.registration).toEqual({
        address: PLANNER,
        state: 'active',
        by: OPS,
        at: START + 10_000,
        managed: true,
      })
      expect(resumed.value.agent?.address).toBe(PLANNER)
    }
    expect(listed(h.registry)).toEqual([PLANNER])
    expect(rebuilt.addresses).toEqual([PLANNER])

    const retired = await rebuilt.lifecycle.retire(PLANNER, OPS)
    expect(codeOf(retired)).toBe('ok')
    expect(listed(h.registry)).toEqual([])
    expect(
      (await h.build().lifecycle.read()).registrations.map(r => r.state),
    ).toEqual(['retired'])
  })

  test('a ledger written before the lifecycle reads as active, keeps being renewed, and is rewritten as version 2', async () => {
    const h0 = harness({ managed: false })
    // P15.2 生命周期之前的文件：版本 1，没有 state、by、at。
    writeLedger(h0.path, {
      version: 1,
      registrations: [
        {
          address: PLANNER,
          endpoint: PLANNER_EP,
          capabilities: ['task.request'],
        },
      ],
    })
    const h = harness({ path: h0.path, managed: false })
    expect(h.lines).toEqual([])
    expect(h.ledger.problem).toBeNull()
    expect(h.ledger.addresses).toEqual([PLANNER])
    expect((await h.ledger.lifecycle.read()).registrations).toEqual([
      { address: PLANNER, state: 'active' },
    ])
    expect(await h.ledger.renewNow()).toEqual([
      { kind: 'renewed', address: PLANNER },
    ])
    expect(h.registry.resolve(PLANNER)?.capabilities).toEqual(['task.request'])

    await h.ledger.lifecycle.pause(PLANNER, OPS)
    expect(onDisk(h.path)).toEqual({
      version: 2,
      registrations: [
        {
          address: PLANNER,
          endpoint: PLANNER_EP,
          capabilities: ['task.request'],
          state: 'paused',
          by: OPS,
          at: START,
        },
      ],
    })
  })

  test('paused entries are not renewed, and a round in flight when one is paused takes back what it re-created', async () => {
    const h = harness()
    await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)
    const round = h.ledger.renewNow()
    await h.ledger.lifecycle.pause(PLANNER, OPS)
    expect(await round).toEqual([{ kind: 'withdrawn', address: PLANNER }])
    expect(listed(h.registry)).toEqual([])
    expect(await h.ledger.renewNow()).toEqual([])
  })

  test('publishing a paused address is refused: resuming is its own verb', async () => {
    const h = harness()
    await h.ledger.lifecycle.pause(PLANNER, OPS)
    const posts = h.calls.post
    expect(
      codeOf(await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)),
    ).toBe('paused')
    expect(h.calls.post).toBe(posts)
  })

  test('deregistering cannot wipe a pause: the entry stays paused', async () => {
    const h = harness()
    await h.ledger.lifecycle.pause(PLANNER, OPS)
    expect(await h.ledger.port.deregister(PLANNER)).toEqual({
      ok: true,
      value: undefined,
    })
    expect((await h.ledger.lifecycle.read()).registrations[0]?.state).toBe(
      'paused',
    )
    // 心跳也不替它续。
    const beat = await h.ledger.port.heartbeat(PLANNER)
    expect(beat.ok).toBe(false)
  })
})

describe('a retired address is never published again (DoD ③)', () => {
  test('publish, resume, pause and the bare registry port all refuse it without a registry call — also after a restart', async () => {
    const h = harness()
    await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)
    await h.ledger.lifecycle.retire(PLANNER, OPS)
    const posts = h.calls.post

    expect(
      codeOf(await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)),
    ).toBe('retired')
    expect(codeOf(await h.ledger.lifecycle.resume(PLANNER, OPS))).toBe(
      'retired',
    )
    expect(codeOf(await h.ledger.lifecycle.pause(PLANNER, OPS))).toBe('retired')
    const bare = await h.ledger.port.register({
      address: PLANNER,
      endpoint: PLANNER_EP,
    })
    expect(bare.ok ? 'ok' : bare.failure.code).toBe('rejected')

    const restarted = h.build()
    expect(
      codeOf(await restarted.lifecycle.publish({ address: PLANNER }, OPS)),
    ).toBe('retired')
    expect(h.calls.post).toBe(posts)
    expect(listed(h.registry)).toEqual([])

    // 再退役一次是原样回答，不改主体与时刻。
    h.clock.advance(1_000)
    const again = await restarted.lifecycle.retire(PLANNER, 'legacy:admin')
    expect(again.ok && again.value.registration.by).toBe(OPS)
  })
})

describe('the managed list (DoD ⑤)', () => {
  test('an address outside the managed list is refused before the registry hears of it', async () => {
    const h = harness()
    const refused = await h.ledger.lifecycle.publish(
      { address: STRANGER, endpoint: STRANGER_EP },
      OPS,
    )
    expect(codeOf(refused)).toBe('unmanaged')
    const bare = await h.ledger.port.register({
      address: STRANGER,
      endpoint: STRANGER_EP,
    })
    expect(bare.ok ? 'ok' : bare.failure.code).toBe('rejected')
    expect(h.calls.post).toBe(0)
    expect(listed(h.registry)).toEqual([])
    expect(existsSync(h.path)).toBe(false)
    expect(codeOf(await h.ledger.lifecycle.pause(STRANGER, OPS))).toBe(
      'not_found',
    )
  })

  test('the endpoint comes from the managed list: a different one is refused, the same one spelled differently is not', async () => {
    const h = harness()
    expect(
      codeOf(
        await h.ledger.lifecycle.publish(
          { address: PLANNER, endpoint: STRANGER_EP },
          OPS,
        ),
      ),
    ).toBe('invalid')
    expect(h.calls.post).toBe(0)
    expect(
      codeOf(
        await h.ledger.lifecycle.publish(
          { address: PLANNER, endpoint: `${PLANNER_EP}/` },
          OPS,
        ),
      ),
    ).toBe('ok')
    expect(h.registry.resolve(PLANNER)?.endpoint).toBe(PLANNER_EP)
  })

  test('pause reaches a managed address the ledger never held; resume of an address that left the list is refused', async () => {
    const h = harness()
    const paused = await h.ledger.lifecycle.pause(REVIEWER, OPS)
    expect(paused.ok && paused.value.registration).toEqual({
      address: REVIEWER,
      state: 'paused',
      by: OPS,
      at: START,
      managed: true,
    })

    // 同一本登记簿，换一张没有 REVIEWER 的托管清单（peers.conf 删了那一行）。
    const narrowed = new ConsoleRegistrations({
      path: h.path,
      registry: createRegistryPort({
        baseUrl: 'http://registry.test',
        fetch: async () => {
          throw new Error('nothing may reach the registry here')
        },
      }),
      managed: [MANAGED[0]],
    })
    expect(codeOf(await narrowed.lifecycle.resume(REVIEWER, OPS))).toBe(
      'unmanaged',
    )
  })

  test('without a managed list nothing is checked, and the endpoint is required', async () => {
    const h = harness({ managed: false })
    expect(
      codeOf(
        await h.ledger.lifecycle.publish(
          { address: STRANGER, endpoint: STRANGER_EP },
          OPS,
        ),
      ),
    ).toBe('ok')
    expect(
      codeOf(await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)),
    ).toBe('invalid')
    expect((await h.ledger.lifecycle.read()).managed).toBeNull()
    expect(h.ledger.summary).toContain('managed list off')
  })
})

/**
 * 读不出来的那本登记簿：四个写动作全拒、注册中心一次都没被叫到、三个出口对
 * 任何地址都不放行、进程告警，被拒的请求每分钟最多再提醒一次。
 */
async function expectClosed(h: ReturnType<typeof harness>): Promise<void> {
  expect(h.ledger.problem).not.toBeNull()
  expect(h.lines).toHaveLength(1)
  expect(h.lines[0]).toContain('console registrations:')
  expect(h.lines[0]).toContain('publishing and resuming are refused')

  expect(
    codeOf(await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)),
  ).toBe('unavailable')
  expect(codeOf(await h.ledger.lifecycle.resume(PLANNER, OPS))).toBe(
    'unavailable',
  )
  expect(codeOf(await h.ledger.lifecycle.pause(PLANNER, OPS))).toBe(
    'unavailable',
  )
  expect(codeOf(await h.ledger.lifecycle.retire(PLANNER, OPS))).toBe(
    'unavailable',
  )
  const bare = await h.ledger.port.register({
    address: PLANNER,
    endpoint: PLANNER_EP,
  })
  expect(bare.ok ? 'ok' : bare.failure.code).toBe('rejected')
  expect(h.calls).toEqual({ post: 0, delete: 0 })

  // 出口：簿里有没有这个地址都一样，读不出来就谁都不拨。`qm watch` 读同一个文件。
  for (const address of [PLANNER, STRANGER]) {
    expect(h.ledger.exitRefusal(address)?.code).toBe('rejected')
    expect(readExitRefusal(h.path, address)?.reason).toBe('unreadable')
  }

  // 一分钟内不重复告警；过了一分钟，被拒的请求再提醒一次。
  expect(h.lines).toHaveLength(1)
  h.clock.advance(60_001)
  await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)
  expect(h.lines).toHaveLength(2)
  expect(h.lines[1]).toContain('a request was refused')
  expect(h.ledger.summary).toContain('UNAVAILABLE')
}

describe('a ledger that cannot be read is fail-closed (DoD ④)', () => {
  test('a corrupt file: set aside, everything refused, and still refused after a restart until the set-aside file is dealt with', async () => {
    const path = freshLedgerPath()
    const corrupt = '{"version": 2, "registrations": ['
    writeLedger(path, {})
    writeFileSync(path, corrupt)
    const h = harness({ path })
    await expectClosed(h)
    // 留证：原样挪开，没被覆盖。
    expect(existsSync(path)).toBe(false)
    const aside = readdirSync(dirname(path)).filter(name =>
      name.startsWith('registrations.json.unreadable-'),
    )
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dirname(path), aside[0] ?? ''), 'utf8')).toBe(
      corrupt,
    )
    expect(h.lines[0]).toContain(aside[0] ?? '<none>')

    // 重启：文件不在，但挪开的那份还在——不是空登记簿。
    const restarted = harness({ path })
    await expectClosed(restarted)
    expect(restarted.lines[0]).toContain('is still beside it')

    // 运维确认从空登记簿起：把挪开的那份移出目录，再重启。
    renameSync(
      join(dirname(path), aside[0] ?? ''),
      join(dirname(dirname(path)), 'kept-for-the-record.json'),
    )
    const recovered = harness({ path })
    expect(recovered.ledger.problem).toBeNull()
    expect(
      codeOf(
        await recovered.ledger.lifecycle.publish({ address: PLANNER }, OPS),
      ),
    ).toBe('ok')
  })

  test('a file this process may not read: left in place, everything refused', async () => {
    if (!PERMISSIONS_BITE) return
    const path = freshLedgerPath()
    writeLedger(path, {
      version: 2,
      registrations: [
        { address: PLANNER, endpoint: PLANNER_EP, state: 'retired', by: OPS },
      ],
    })
    chmodSync(path, 0o000)
    try {
      const h = harness({ path })
      await expectClosed(h)
      expect(h.lines[0]).toContain('cannot be read')
    } finally {
      chmodSync(path, 0o600)
    }
    // 原地、原样：没挪、没写。
    expect(
      (onDisk(path) as { registrations: unknown[] }).registrations,
    ).toEqual([
      { address: PLANNER, endpoint: PLANNER_EP, state: 'retired', by: OPS },
    ])
  })

  test('an IO error (the ledger path is a directory): left in place, everything refused', async () => {
    const path = freshLedgerPath()
    mkdirSync(path, { recursive: true })
    const h = harness({ path })
    await expectClosed(h)
    expect(h.lines[0]).toContain('cannot be read')
  })

  test('one malformed entry closes the ledger, while the entries it could read keep their leases', async () => {
    const path = freshLedgerPath()
    writeLedger(path, {
      version: 2,
      registrations: [
        { address: PLANNER, endpoint: PLANNER_EP },
        { address: REVIEWER, endpoint: REVIEWER_EP, state: 'parked' },
      ],
    })
    const h = harness({ path })
    expect(h.lines[0]).toContain('skipped 1 malformed entries')
    // 续租不是新发布：读得出的 active 照续。
    expect(await h.ledger.renewNow()).toEqual([
      { kind: 'renewed', address: PLANNER },
    ])
    h.calls.post = 0
    await expectClosed(h)
    // 文件没被改写：坏的那条还在，等人来看。
    expect(
      (onDisk(path) as { registrations: unknown[] }).registrations,
    ).toHaveLength(2)
  })

  test('two entries for one address are not a guess about which one counts', async () => {
    const path = freshLedgerPath()
    writeLedger(path, {
      version: 2,
      registrations: [
        { address: PLANNER, endpoint: PLANNER_EP, state: 'retired' },
        { address: PLANNER, endpoint: PLANNER_EP },
      ],
    })
    const h = harness({ path })
    expect(h.ledger.problem).toContain('skipped 1 malformed entries')
    expect(h.ledger.exitRefusal(PLANNER)?.code).toBe('rejected')
  })

  test('a write that fails keeps the change in this process and refuses widening changes after it', async () => {
    if (!PERMISSIONS_BITE) return
    const h = harness()
    await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)
    chmodSync(dirname(h.path), 0o500)
    try {
      // 暂停在本进程里生效，出口照样关上……
      expect(codeOf(await h.ledger.lifecycle.pause(PLANNER, OPS))).toBe('ok')
      expect(h.ledger.exitRefusal(PLANNER)?.code).toBe('rejected')
      expect(h.lines.some(line => line.includes('could not write'))).toBe(true)
      // ……但写不进去的簿不再接受会放宽的变更。
      expect(
        codeOf(await h.ledger.lifecycle.publish({ address: REVIEWER }, OPS)),
      ).toBe('unavailable')
      expect(codeOf(await h.ledger.lifecycle.resume(PLANNER, OPS))).toBe(
        'unavailable',
      )
      // 内存里的簿是完整的：没被暂停的地址照常放行。
      expect(h.ledger.exitRefusal(REVIEWER)).toBeNull()
    } finally {
      chmodSync(dirname(h.path), 0o700)
    }
  })
})

// --- the three exits --------------------------------------------------------

function agent(address: string, endpoint: string): ConsoleAgent {
  return {
    address,
    endpoint,
    capabilities: [],
    status: 'online',
    registeredAt: 1,
    lastHeartbeatAt: 2,
    expiresAt: 3,
  }
}

/** 名册：对话面靠它找端点。只读，其余方法不该被叫到。 */
class StaticRoster implements RegistryPort {
  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
    return Promise.resolve({
      ok: true,
      value: [agent(PLANNER, PLANNER_EP), agent(REVIEWER, REVIEWER_EP)],
    })
  }
  register(_input: RegisterAgentInput): Promise<ConsoleResult<ConsoleAgent>> {
    throw new Error('the chat face never registers')
  }
  deregister(): Promise<ConsoleResult<void>> {
    throw new Error('the chat face never deregisters')
  }
  heartbeat(): Promise<ConsoleResult<ConsoleAgent>> {
    throw new Error('the chat face never heartbeats')
  }
}

/** 对话面最底下那一层：建了几条链路、交出去几条消息。 */
class CountingDialer {
  dials = 0
  sends = 0
  readonly dial: ChatDialer = () => {
    this.dials += 1
    const link: ChatLink = {
      connect: async () => {},
      sendAndWait: async (_message: QianmoMessage) => {
        this.sends += 1
        return 'accepted'
      },
      isClosed: () => false,
      close: async () => {},
    }
    return link
  }
}

class CountingWake implements WakePort {
  sent = 0
  send(_input: WakeInput): Promise<ConsoleResult<WakeOutcome>> {
    this.sent += 1
    return Promise.resolve({
      ok: true,
      value: { msgId: 'm', taskId: 't', receipt: 'accepted' },
    })
  }
}

/**
 * 三个出口接在同一本登记簿上。`gated: false` 是去掉出口检查的那个变体——红绿
 * 对照用：同一组动作在它上面必须数出非零。
 */
async function exitsOn(
  ledger: ConsoleRegistrations,
  path: string,
  gated: boolean,
) {
  const exitGate = (address: string) => ledger.exitRefusal(address)

  const dialer = new CountingDialer()
  const chat = createConsoleChatPort({
    from: FROM,
    endpoints: [
      { url: PLANNER_EP, psk: PSK, node: 'node-a' },
      { url: REVIEWER_EP, psk: PSK, node: 'node-b' },
    ],
    storePath: join(scratch(), 'chat.ndjson'),
    registry: new StaticRoster(),
    dial: dialer.dial,
    ...(gated ? { exitGate } : {}),
  })

  const wakePort = new CountingWake()
  const wake = gated ? gateWakePort(wakePort, exitGate) : wakePort

  const links = { dials: 0, sends: 0 }
  const trail: AuditInput[] = []
  const warnings: string[] = []
  const dispatch = createWatchDispatch({
    from: FROM,
    hubNode: 'console',
    urls: new Map([
      ['watch-planner', PLANNER_EP],
      ['watch-reviewer', REVIEWER_EP],
    ]),
    linkTo: async () => {
      links.dials += 1
      return {
        sendAndWait: async () => {
          links.sends += 1
          return ReceiptStatus.Accepted
        },
      }
    },
    trail: {
      append: (input: AuditInput): AuditRecord => {
        trail.push(input)
        return { ...input, seq: trail.length, prev: '0'.repeat(64) }
      },
    },
    ...(gated ? { gate: address => readExitRefusal(path, address) } : {}),
    warn: line => warnings.push(line),
  })

  const sessions = new Map<string, string>()
  for (const target of [PLANNER, REVIEWER]) {
    const opened = await chat.open(target)
    if (!opened.ok) throw new Error('could not open a session')
    sessions.set(target, opened.value.id)
  }
  let instant = 0

  return {
    chat,
    trail,
    warnings,
    /** 对一个地址，三个出口各发起一次；返回三个出口各自的结局。 */
    async fire(address: string) {
      const said = await chat.send({
        sessionId: sessions.get(address) ?? '',
        text: 'status?',
      })
      const woke = await wake.send({
        from: FROM,
        to: address,
        prompt: 'status?',
        url: '',
      })
      instant += 60_000
      const job = assertJob({
        id: address === PLANNER ? 'watch-planner' : 'watch-reviewer',
        title: 'status',
        target: address,
        prompt: 'status?',
        schedule: { everyMs: 60_000 },
        taskTtlMs: 60_000,
        notifyPolicy: 'agent-initiated',
      })
      const fire: FireDispatch = {
        job,
        fireAtMs: instant,
        dedupKey: `${job.id}:${String(instant)}`,
        attempt: 1,
      }
      const watched = await dispatch(fire)
      return {
        chat: said.ok ? 'sent' : said.failure.code,
        wake: woke.ok ? 'sent' : woke.failure.code,
        watch: watched === 'skipped' ? 'skipped' : 'sent',
      }
    },
    /** 三个出口最底下那一层，各数到几次发起。 */
    counts() {
      return {
        chat: dialer.sends,
        wake: wakePort.sent,
        watch: links.sends,
        watchDials: links.dials,
      }
    },
  }
}

const SENT = { chat: 'sent', wake: 'sent', watch: 'sent' }
const REFUSED = { chat: 'rejected', wake: 'rejected', watch: 'skipped' }

describe('a paused agent is reached by none of the three exits (DoD ②)', () => {
  test('pause: zero starts on chat, wake and qm watch; resume: all three start again; retire: zero again', async () => {
    const h = harness()
    await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)
    const exits = await exitsOn(h.ledger, h.path, true)

    expect(await exits.fire(PLANNER)).toEqual(SENT)
    expect(exits.counts()).toEqual({
      chat: 1,
      wake: 1,
      watch: 1,
      watchDials: 1,
    })

    await h.ledger.lifecycle.pause(PLANNER, OPS)
    expect(await exits.fire(PLANNER)).toEqual(REFUSED)
    expect(await exits.fire(PLANNER)).toEqual(REFUSED)
    expect(exits.counts()).toEqual({
      chat: 1,
      wake: 1,
      watch: 1,
      watchDials: 1,
    })
    // 别的地址照常。
    expect(await exits.fire(REVIEWER)).toEqual(SENT)
    expect(exits.counts()).toEqual({
      chat: 2,
      wake: 2,
      watch: 2,
      watchDials: 2,
    })
    // 对话面的目标清单如实标成不可拨。
    const targets = await exits.chat.targets()
    expect(
      targets.ok &&
        targets.value.map(target => [target.address, target.dialable]),
    ).toEqual([
      [PLANNER, false],
      [REVIEWER, true],
    ])
    // qm watch 每次跳过都记审计；stderr 只在原因变了时出声。
    const skips = exits.trail.filter(record => record.outcome === 'refused')
    expect(skips).toHaveLength(2)
    expect(skips[0]).toMatchObject({
      kind: 'watch_fire',
      code: 'agent_paused',
      peer: PLANNER,
      detail: { jobId: 'watch-planner' },
    })
    expect(skips[0]?.msgId).toBeUndefined()
    expect(exits.warnings).toHaveLength(1)
    expect(exits.warnings[0]).toContain('skipped')

    await h.ledger.lifecycle.resume(PLANNER, OPS)
    expect(await exits.fire(PLANNER)).toEqual(SENT)
    expect(exits.counts()).toEqual({
      chat: 3,
      wake: 3,
      watch: 3,
      watchDials: 3,
    })
    expect(exits.warnings.at(-1)).toContain('resumed')

    await h.ledger.lifecycle.retire(PLANNER, OPS)
    expect(await exits.fire(PLANNER)).toEqual(REFUSED)
    expect(exits.counts()).toEqual({
      chat: 3,
      wake: 3,
      watch: 3,
      watchDials: 3,
    })
    expect(exits.trail.at(-1)?.code).toBe('agent_retired')
    await exits.chat.close()
  })

  test('red–green: the same pause with the exit check taken out is counted by every fake port', async () => {
    const h = harness()
    await h.ledger.lifecycle.publish({ address: PLANNER }, OPS)
    await h.ledger.lifecycle.pause(PLANNER, OPS)
    const exits = await exitsOn(h.ledger, h.path, false)
    expect(await exits.fire(PLANNER)).toEqual(SENT)
    expect(exits.counts()).toEqual({
      chat: 1,
      wake: 1,
      watch: 1,
      watchDials: 1,
    })
    await exits.chat.close()
  })

  test('a ledger that cannot be read: no exit starts, not even to an address it never held', async () => {
    const path = freshLedgerPath()
    writeLedger(path, {})
    writeFileSync(path, 'not json')
    const h = harness({ path })
    const exits = await exitsOn(h.ledger, h.path, true)
    expect(await exits.fire(REVIEWER)).toEqual(REFUSED)
    expect(exits.counts()).toEqual({
      chat: 0,
      wake: 0,
      watch: 0,
      watchDials: 0,
    })
    expect(exits.trail[0]?.code).toBe('registrations_unreadable')
    await exits.chat.close()
  })
})

describe('--managed', () => {
  test('one address per flag, its endpoint after the first =, and absent means no list at all', () => {
    const config = parseConsoleArgs(
      [
        '--managed',
        `${PLANNER}=${PLANNER_EP}`,
        `--managed=${REVIEWER}=${REVIEWER_EP}`,
      ],
      'qianmo',
    )
    expect(config.managed).toEqual([...MANAGED])
    // A console started without it keeps the shape it had before.
    expect('managed' in parseConsoleArgs([], 'qianmo')).toBe(false)
  })

  test('a malformed line, a bad address or a repeated address stops the console from starting', () => {
    expect(() => parseConsoleArgs(['--managed', PLANNER], 'qianmo')).toThrow(
      '--managed must be <address>=<endpoint>',
    )
    expect(() =>
      parseConsoleArgs(['--managed', `node-a/planner=${PLANNER_EP}`], 'qianmo'),
    ).toThrow()
    expect(() =>
      parseConsoleArgs(['--managed', `${PLANNER}=`], 'qianmo'),
    ).toThrow('--managed must not be empty')
    expect(() =>
      parseConsoleArgs(
        [
          '--managed',
          `${PLANNER}=${PLANNER_EP}`,
          '--managed',
          `${PLANNER}=${REVIEWER_EP}`,
        ],
        'qianmo',
      ),
    ).toThrow(`--managed repeats address ${PLANNER}`)
  })
})

// --- the real processes -------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/** A port nothing listens on: a dial that gets this far fails, it does not hang on a stranger. */
const DEAD_EP = 'ws://127.0.0.1:1'

/**
 * A child `bun` running one exported function under a config root of its own:
 * the config root is memoised per process (`paths.ts`), which is why this is a
 * child and not a call.
 */
function child(
  configRoot: string,
  script: string,
  env: Record<string, string>,
) {
  return Bun.spawn(['bun', '-e', script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: configRoot,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

describe('qm watch and qm console, end to end', () => {
  test('qm watch --once reads the console ledger and skips a paused target without dialling it', async () => {
    const root = scratch()
    writeLedger(join(root, 'qianmo', 'console', 'registrations.json'), {
      version: 2,
      registrations: [
        { address: PLANNER, endpoint: DEAD_EP, state: 'paused', by: OPS },
      ],
    })
    const jobsPath = join(root, 'jobs.json')
    writeFileSync(
      jobsPath,
      JSON.stringify([
        {
          id: 'watch-planner',
          title: 'status',
          target: PLANNER,
          url: DEAD_EP,
          prompt: 'status?',
          schedule: { everyMs: 600_000 },
          taskTtlMs: 60_000,
          notifyPolicy: 'agent-initiated',
        },
      ]),
    )
    const run = child(
      root,
      "const { runWatchJobs } = await import('./src/cli/handlers/watch.ts');" +
        ' await runWatchJobs(JSON.parse(process.env.QM_TEST_CONFIG))',
      {
        QIANMO_TRANSPORT_PSK: PSK,
        QM_TEST_CONFIG: JSON.stringify({
          mode: 'run',
          jobsPath,
          from: FROM,
          stateDir: join(root, 'qianmo', 'scheduler'),
          once: true,
          sign: false,
        }),
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) })
    expect(stdout).toContain(
      join(root, 'qianmo', 'console', 'registrations.json'),
    )
    expect(stderr).toContain(`job watch-planner skipped: ${PLANNER} 已暂停`)
    const trail = readFileSync(
      join(root, 'qianmo', 'audit', 'trail.ndjson'),
      'utf8',
    )
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as AuditRecord)
      .filter(record => record.kind === 'watch_fire')
    expect(trail.map(record => [record.outcome, record.code])).toEqual([
      ['refused', 'agent_paused'],
    ])
  }, 60_000)

  test('qm console with --managed: publish is held to the list, and a paused agent is refused by wake and chat before any dial', async () => {
    const root = scratch()
    const registry = startRegistryServer(0, {
      registry: new InMemoryRegistry(),
    })
    const target = 'qianmo://node-a/planner'
    const console_ = child(
      root,
      "const { runConsole } = await import('./src/cli/handlers/console.ts');" +
        ' await runConsole(JSON.parse(process.env.QM_TEST_ARGS))',
      {
        [transportPskEnvVarForNode('node-a')]: PSK,
        QM_TEST_ARGS: JSON.stringify([
          '--port',
          '0',
          '--registry',
          registry.url,
          '--managed',
          `${target}=${DEAD_EP}`,
          '--wake-url',
          `node-a=${DEAD_EP}`,
          '--chat-url',
          `node-a=${DEAD_EP}`,
        ]),
      },
    )
    try {
      const reader = console_.stdout.getReader()
      const decoder = new TextDecoder()
      let banner = ''
      while (!banner.includes('sourceCommit')) {
        const chunk = await reader.read()
        if (chunk.done) break
        banner += decoder.decode(chunk.value)
      }
      const field = (name: string): string =>
        new RegExp(`^${name}\\s+(\\S+)`, 'm').exec(banner)?.[1] ?? ''
      const origin = field('console')
      const admin = field('admin-token')
      expect(banner).toContain('managed list 1 addresses')
      const call = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${admin}`,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        }
      }
      const enc = encodeURIComponent(target)

      const outside = await call('POST', '/v0/agents', {
        address: STRANGER,
        endpoint: STRANGER_EP,
      })
      expect(outside.status).toBe(403)
      expect(registry.registry.list()).toEqual([])

      expect(
        (await call('POST', '/v0/agents', { address: target })).status,
      ).toBe(200)
      expect(registry.registry.resolve(target)?.endpoint).toBe(DEAD_EP)

      expect((await call('POST', `/v0/agents/${enc}/pause`)).status).toBe(200)
      expect(registry.registry.list()).toEqual([])
      expect((await call('GET', '/v0/registrations')).body).toMatchObject({
        problem: null,
        managed: [target],
        registrations: [
          {
            address: target,
            state: 'paused',
            by: 'legacy:admin',
            managed: true,
          },
        ],
      })

      const woke = await call('POST', '/v0/wake', {
        node: 'node-a',
        from: FROM,
        to: target,
        prompt: 'status?',
      })
      expect(woke.status).toBe(400)
      expect(woke.body).toMatchObject({ error: { code: 'rejected' } })
      expect(JSON.stringify(woke.body)).toContain('已暂停')

      const opened = await call('POST', '/v0/chat/sessions', { target })
      expect(opened.status).toBe(200)
      const said = await call(
        'POST',
        `/v0/chat/sessions/${String(opened.body['id'])}/messages`,
        { text: 'status?' },
      )
      expect(said.status).toBe(400)
      expect(JSON.stringify(said.body)).toContain('已暂停')

      expect((await call('POST', `/v0/agents/${enc}/resume`)).status).toBe(200)
      expect(registry.registry.resolve(target)?.endpoint).toBe(DEAD_EP)
      expect((await call('POST', `/v0/agents/${enc}/retire`)).status).toBe(200)
      expect(
        (await call('POST', '/v0/agents', { address: target })).status,
      ).toBe(409)
    } finally {
      console_.kill()
      await console_.exited
      await registry.stop()
    }
    expect(
      onDisk(join(root, 'qianmo', 'console', 'registrations.json')),
    ).toMatchObject({
      version: 2,
      registrations: [
        { address: target, state: 'retired', by: 'legacy:admin' },
      ],
    })
  }, 60_000)
})
