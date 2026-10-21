// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An agent changing a console setting (P40 `agent-settings.md` §§3, 5, 8),
 * the hub's half, against the real pieces: the console's router in-process,
 * the hash-chained action ledger, the account book, a node's
 * `FileGrantStore` behind a signed transport and `ConsoleApprovals`
 * relaying and spending the approval. The node is driven the way its two host
 * tools drive it: every call carries the running turn (`contextId`,
 * `taskId`) and an approval's input is exactly the bound the preview gave.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signAuthzRequest,
  StaticPublicKeyDirectory,
  type AuthzRequest,
} from '@qianmo/capability'
import {
  ActionLedger,
  type ChatPort,
  type ChatSession,
  type ChatTranscript,
  type ChatTurn,
  type ConsolePrincipal,
  type ConsoleResult,
  type ServerNote,
  type ServerNotesPort,
} from '@qianmo/console'
import { createMessage, MessageType } from '@qianmo/protocol'
import {
  FileGrantStore,
  ResidentEstop,
  ResidentHardline,
} from '@qianmo/resident'
import { startTransportServer, type TransportChannel } from '@qianmo/transport'
import {
  type AccountsHarness,
  ManualClock,
  type Person,
  accountsHarness,
  person,
} from '../../../console/test/accountsHarness.js'
import { MemoryActionStore } from '../../../console/test/actionStore.js'
import { FileLedger } from '../../src/commands/consoleAccountsStore.js'
import { ConsoleApprovals } from '../../src/commands/consoleApprovals.js'
import {
  ConsoleSettings,
  settingsUnwired,
} from '../../src/commands/consoleSettings.js'

const NODE = 'tokyo-1'
const AGENT = 'main'
const ADDRESS = `qianmo://${NODE}/${AGENT}`
const HUB = 'qianmo://hub/console'
const TOOL = 'qianmo_settings_change'
const CHAT = 'chat-ops'
const TASK = 'task-1'
const PSK = 'settings-integration-psk-0000000000000'

type User = Extract<ConsolePrincipal, { kind: 'user' }>

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 3_000
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

class Notes implements ServerNotesPort {
  readonly stored = new Map<string, ServerNote>()
  broken = false
  list(): Promise<ConsoleResult<readonly ServerNote[]>> {
    return Promise.resolve({ ok: true, value: [...this.stored.values()] })
  }
  set(server: string, note: string): Promise<ConsoleResult<ServerNote>> {
    if (this.broken) throw new Error('disk went away')
    const record: ServerNote = { server, note, updatedAt: Date.now() }
    this.stored.set(server, record)
    return Promise.resolve({ ok: true, value: record })
  }
}

/** Transcripts by id; a conversation is a session and its turns. */
class Conversations implements Pick<ChatPort, 'transcript'> {
  readonly byId = new Map<string, ChatTranscript>()

  open(
    id: string,
    options: {
      readonly session?: Partial<ChatSession>
      readonly turns?: readonly ChatTurn[]
    } = {},
  ): void {
    const session: ChatSession = {
      id,
      target: ADDRESS,
      node: NODE,
      agent: AGENT,
      createdAt: 1,
      updatedAt: 1,
      turnCount: 1,
      preview: '',
      ...options.session,
    }
    this.byId.set(id, {
      session,
      turns: options.turns ?? [asked(id, TASK)],
    })
  }

  transcript(id: string): Promise<ConsoleResult<ChatTranscript>> {
    const found = this.byId.get(id)
    return Promise.resolve(
      found === undefined
        ? { ok: false, failure: { code: 'not_found', message: '没有' } }
        : { ok: true, value: found },
    )
  }
}

function asked(sessionId: string, taskId: string): ChatTurn {
  return {
    id: `${taskId}-ask`,
    sessionId,
    author: 'operator',
    at: 1,
    text: '把 p11 的备注改一下',
    state: 'delivered',
    taskId,
  }
}

function answered(sessionId: string, taskId: string): ChatTurn {
  return {
    id: `${taskId}-answer`,
    sessionId,
    author: 'agent',
    at: 2,
    text: '好了',
    state: 'done',
    taskId,
  }
}

function principalOf(h: AccountsHarness, who: Person): User {
  const found = h.book.bearerPrincipal(who.credential)
  if (!found.ok || found.value.kind !== 'user') throw new Error('not a person')
  // As freshly signed in as the approvals' own clock sees it.
  return { ...found.value, authenticatedAt: Date.now() }
}

interface Fixture {
  readonly h: AccountsHarness
  readonly notes: Notes
  readonly store: MemoryActionStore
  readonly chats: Conversations
  readonly grants: FileGrantStore
  readonly hub: ConsoleApprovals
  readonly settings: ConsoleSettings
  readonly ops: User
  readonly member: User
  readonly ledgerPath: string
  readonly hubOptions: ConstructorParameters<typeof ConsoleApprovals>[0]
  /** Moves the approvals' clock, not the node's. */
  readonly skew: { ms: number }
  readonly scheduled: Set<string>
  readonly workers: Set<string>
  readonly channels: Set<string>
  call(
    op: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<Outcome>
  /** What the node's tool does once it has a bound: ask and forward. */
  approvalFor(
    bound: Readonly<Record<string, unknown>>,
    contextId?: string,
  ): Promise<AuthzRequest>
  decide(
    principal: User,
    request: AuthzRequest,
    decision?: 'allow-once' | 'allow-window' | 'deny',
  ): Promise<ConsoleResult<{ readonly delivered: boolean }>>
}

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string }

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'qm-console-settings-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = new ManualClock(Date.now())
  const store = new MemoryActionStore()
  const notes = new Notes()
  const h = accountsHarness({
    clock,
    deps: {
      actions: new ActionLedger({ store, now: clock.now }),
      nodeServers: [{ node: NODE, server: 'p11' }],
      serverNotes: notes,
    },
  })
  const ops = principalOf(h, await person(h.handle, 'ops'))
  const member = principalOf(h, await person(h.handle, 'member'))
  const chats = new Conversations()
  chats.open(CHAT)
  expect(h.book.recordOwner(CHAT, ops.subject).ok).toBe(true)

  const nodeKeys = generateNodeKeyPair()
  const commander = generateNodeKeyPair()
  const approvalKeys = generateNodeKeyPair()
  const grants = new FileGrantStore({
    path: join(root, 'protected', 'node-authz.ndjson'),
    node: NODE,
    approvers: new Map([['hub', approvalKeys.publicKey]]),
    commanderKeys: () => [commander.publicKey],
    hardline: new ResidentHardline({ stateRoots: [join(root, 'protected')] }),
    estop: new ResidentEstop({ path: join(root, 'ESTOP') }),
  })
  let channel: TransportChannel | undefined
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: PSK,
    signing: {
      node: NODE,
      keys: nodeKeys,
      directory: new StaticPublicKeyDirectory([['hub', commander.publicKey]]),
      required: true,
    },
    supportedTypes: [
      MessageType.AuthzRequest,
      MessageType.AuthzDecision,
      MessageType.AuthzRevoke,
    ],
    onMessage: (message, context) => {
      const payload = message.payload as Record<string, unknown>
      if (message.type === MessageType.AuthzRequest) channel = context.channel
      else if (message.type === MessageType.AuthzDecision) {
        if (!grants.applyDecision(payload['decision']).ok)
          throw new Error('refused decision')
      } else if (message.type === MessageType.AuthzRevoke) {
        if (!grants.applyRevoke(payload['revoke']).ok)
          throw new Error('refused revoke')
      }
    },
  })
  cleanups.push(() => server.stop())
  const skew = { ms: 0 }
  const ledgerPath = join(root, 'console-authz.ndjson')
  const hubOptions = {
    from: HUB,
    accounts: h.book,
    commandKeys: commander,
    approvalKeys,
    targets: [
      {
        node: NODE,
        url: server.url ?? '',
        psk: PSK,
        publicKey: nodeKeys.publicKey,
      },
    ],
    ledger: new FileLedger(ledgerPath),
    now: () => Date.now() + skew.ms,
  }
  const hub = new ConsoleApprovals(hubOptions)
  hub.start()
  cleanups.push(() => hub.close())
  await until(() => channel !== undefined)

  const scheduled = new Set<string>()
  const workers = new Set<string>()
  const channels = new Set<string>()
  const settings = new ConsoleSettings({
    chat: chats,
    accounts: { book: h.book },
    approvals: hub,
    console: () => h.handle.as,
    scheduled: id => scheduled.has(id),
    foreground: id => !channels.has(id),
    worker: id => workers.has(id),
  })

  return {
    h,
    notes,
    store,
    chats,
    grants,
    hub,
    settings,
    ops,
    member,
    ledgerPath,
    hubOptions,
    skew,
    scheduled,
    workers,
    channels,
    call: (op, args, callId = 'call-1') =>
      settings.handle(
        op,
        { contextId: CHAT, taskId: TASK, ...args },
        { node: NODE, agent: AGENT, callId },
      ) as Promise<Outcome>,
    approvalFor: async (bound, contextId = CHAT) => {
      const asked = grants.ask({
        agent: AGENT,
        contextId,
        toolName: TOOL,
        input: bound,
        origin: { from: HUB, taskId: null, traceId: null, trust: 'untrusted' },
      })
      if (asked.kind !== 'pending')
        throw new Error(`not pending: ${asked.kind}`)
      await channel?.sendAndWait(
        createMessage({
          from: ADDRESS,
          to: HUB,
          type: MessageType.AuthzRequest,
          payload: { request: signAuthzRequest(nodeKeys, asked.request) },
          hops: [NODE],
        }),
      )
      await until(async () => {
        const listed = await hub.list(ops)
        return (
          listed.ok &&
          listed.value.some(item => item.requestId === asked.request.requestId)
        )
      })
      return asked.request
    },
    decide: (principal, request, decision = 'allow-once') =>
      hub.decide(principal, {
        requestId: request.requestId,
        digest: request.digest,
        decision,
        ...(decision === 'allow-window' ? { windowMs: 60_000 } : {}),
      }),
  }
}

const NOTE = { id: 'servers.note', target: { server: 'p11' } }

function valueOf(outcome: Outcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`)
  return outcome.value as Record<string, unknown>
}

/** The bound a preview answered. */
function boundOf(outcome: Outcome): Record<string, unknown> {
  const bound = valueOf(outcome)['bound']
  if (typeof bound !== 'object' || bound === null) throw new Error('no bound')
  return bound as Record<string, unknown>
}

function refusal(outcome: Outcome): string {
  return outcome.ok ? 'ok' : outcome.message
}

/** Preview, ask, approve as `approver`: the approval apply will name. */
async function approved(
  f: Fixture,
  input: Record<string, unknown>,
  approver: User = f.ops,
): Promise<AuthzRequest> {
  const bound = boundOf(await f.call('settings.preview', { ...NOTE, input }))
  const request = await f.approvalFor(bound)
  expect(await f.decide(approver, request)).toEqual({
    ok: true,
    value: { delivered: true },
  })
  return request
}

function actionLines(f: Fixture): Record<string, unknown>[] {
  return f.store
    .lines()
    .slice(1)
    .map(line => ({ kind: line.kind, ...(line.data as object) }))
}

describe('a change from preview to the ledger (P40 §§3, 5)', () => {
  test('preview, one approval, apply: the change is made as the approver and says by whom', async () => {
    const f = await fixture()
    const bound = boundOf(
      await f.call('settings.preview', {
        ...NOTE,
        input: { note: '换过硬盘' },
      }),
    )
    expect(bound).toEqual({
      id: 'servers.note',
      target: { server: 'p11' },
      input: { note: '换过硬盘' },
      card: {
        area: '服务器',
        label: '服务器备注',
        title: '把服务器备注改成 换过硬盘 · p11',
        current: 'note 空',
        next: 'note 换过硬盘',
        role: 'ops',
        page: '/admin/servers',
      },
    })
    const request = await f.approvalFor(bound)
    expect(request.toolName).toBe(TOOL)
    expect(request.input).toEqual(bound)
    expect((await f.decide(f.ops, request)).ok).toBe(true)
    // The node's own half of the same approval: the once-grant is there.
    await until(
      () =>
        f.grants.use({
          agent: AGENT,
          contextId: CHAT,
          toolName: TOOL,
          input: bound,
        }).kind === 'hit',
    )
    expect(f.notes.stored.size).toBe(0)

    const applied = valueOf(
      await f.call('settings.apply', {
        ...NOTE,
        input: { note: '换过硬盘' },
        approvalId: request.requestId,
      }),
    )
    expect(applied['summary']).toBe('已更改 服务器 · 服务器备注')
    expect(applied['result']).toMatchObject({ server: 'p11', note: '换过硬盘' })
    expect(f.notes.stored.get('p11')?.note).toBe('换过硬盘')

    const written = actionLines(f).filter(
      line => line['kind'] === 'server.note.set',
    )
    expect(written).toEqual([
      expect.objectContaining({
        subject: f.ops.subject,
        target: 'p11',
        outcome: 'ok',
        agent: ADDRESS,
        approval: request.requestId,
      }),
    ])
    // The reads made to bind the change are the owner's, with no agent on them.
    for (const line of actionLines(f))
      if (line['kind'] !== 'server.note.set')
        expect(line['agent']).toBeUndefined()

    // Spent: not again, not after a restart either.
    expect(
      refusal(
        await f.call(
          'settings.apply',
          {
            ...NOTE,
            input: { note: '换过硬盘' },
            approvalId: request.requestId,
          },
          'call-2',
        ),
      ),
    ).toContain('单次批准不存在')
    await f.hub.close()
    const again = new ConsoleApprovals({
      ...f.hubOptions,
      ledger: new FileLedger(f.ledgerPath),
    })
    cleanups.push(() => again.close())
    expect(
      again.consumeSettings({
        requestId: request.requestId,
        node: NODE,
        agent: AGENT,
        contextId: CHAT,
        bound: bound,
        callId: 'call-3',
      }),
    ).toBeNull()
  })

  test('list reads the catalog and, as the owner, the value', async () => {
    const f = await fixture()
    f.notes.stored.set('p11', { server: 'p11', note: '旧', updatedAt: 1 })
    const areas = valueOf(await f.call('settings.list', {}))['areas'] as {
      area: string
      settings: { id: string; human?: string }[]
    }[]
    expect(areas.map(area => area.area)).toContain('servers')
    const servers = areas.find(area => area.area === 'servers')
    expect(servers?.settings.map(item => item.id)).toContain('servers.note')
    expect(
      servers?.settings.find(item => item.id === 'servers.replicate.start')
        ?.human,
    ).toContain('/admin/servers')

    const one = valueOf(
      await f.call('settings.list', {
        id: 'servers.note',
        target: NOTE.target,
      }),
    )['settings'] as Record<string, unknown>[]
    expect(one[0]).toMatchObject({
      id: 'servers.note',
      current: { note: '旧' },
      page: '/admin/servers',
    })
    const untargeted = valueOf(
      await f.call('settings.list', { area: 'servers' }),
    )['settings'] as Record<string, unknown>[]
    expect(
      untargeted.find(item => item['id'] === 'servers.note'),
    ).toMatchObject({ current: null, currentNeeds: ['server'] })
    expect(refusal(await f.call('settings.list', { area: 'weather' }))).toBe(
      '没有这个区域 weather',
    )
  })
})

describe('who may ask (P40 §8)', () => {
  test('only a live turn a person started, in the agent’s own foreground conversation', async () => {
    const f = await fixture()
    const own = (id: string, subject = f.ops.subject) =>
      expect(f.h.book.recordOwner(id, subject).ok).toBe(true)
    f.chats.open('chat-other', {
      session: { target: `qianmo://${NODE}/other` },
    })
    own('chat-other')
    f.chats.open('chat-bg', { session: { background: true } })
    own('chat-bg')
    f.chats.open('chat-worker')
    own('chat-worker')
    f.workers.add('chat-worker')
    f.chats.open('chat-sched')
    own('chat-sched')
    f.scheduled.add('chat-sched')
    f.chats.open('chat-group')
    own('chat-group')
    f.channels.add('chat-group')
    f.chats.open('chat-done', {
      turns: [asked('chat-done', TASK), answered('chat-done', TASK)],
    })
    own('chat-done')
    f.chats.open('chat-orphan')
    f.chats.open('chat-gone')
    const gone = principalOf(f.h, await person(f.h.handle, 'ops'))
    own('chat-gone', gone.subject)
    expect(f.h.book.revoke(gone.subject, 'legacy:admin').ok).toBe(true)

    const cases: [Record<string, unknown>, string][] = [
      [{ taskId: undefined }, '缺少会话信息'],
      [{ contextId: 7 }, '缺少会话信息'],
      [{ contextId: 'chat-none' }, '会话不存在'],
      [{ contextId: 'chat-other' }, '会话不属于这个智能体'],
      [{ contextId: 'chat-bg' }, '后台子任务不能改设置 · 交回发起它的对话去做'],
      [
        { contextId: 'chat-worker' },
        '后台子任务不能改设置 · 交回发起它的对话去做',
      ],
      [
        { contextId: 'chat-sched' },
        '定时任务的会话不能改设置 · 没有人在看这一轮',
      ],
      [{ contextId: 'chat-group' }, '只有主人的私聊和控制台对话能改设置'],
      [
        { contextId: 'chat-done' },
        '这一轮不在进行中 · 只有人发起的一轮能改设置',
      ],
      [{ taskId: 'task-9' }, '这一轮不在进行中 · 只有人发起的一轮能改设置'],
      [{ contextId: 'chat-orphan' }, '这个对话没有个人账号主人'],
      [{ contextId: 'chat-gone' }, '对话主人的账号已不可用'],
    ]
    const change = { ...NOTE, input: { note: 'x' } }
    const ops: [string, Record<string, unknown>][] = [
      ['settings.list', {}],
      ['settings.preview', change],
      ['settings.apply', { ...change, approvalId: '0'.repeat(32) }],
    ]
    for (const [op, base] of ops)
      for (const [args, message] of cases)
        expect(
          `${op} ${JSON.stringify(args)} ${refusal(
            await f.call(op, { ...base, ...args }),
          )}`,
        ).toBe(`${op} ${JSON.stringify(args)} ${message}`)

    // The call must come from an agent at all.
    expect(
      refusal(
        await f.settings.handle(
          'settings.list',
          { contextId: CHAT, taskId: TASK },
          { node: NODE, callId: 'c' },
        ),
      ),
    ).toBe('缺少会话信息')
    expect(f.notes.stored.size).toBe(0)
  })

  test('exactly the arguments the node sends, and nothing on a hub without approvals', async () => {
    const f = await fixture()
    expect(await f.call('settings.delete', {})).toMatchObject({
      ok: false,
      code: 'unsupported',
    })
    expect(
      refusal(await f.call('settings.preview', { ...NOTE, operationId: 'x' })),
    ).toBe('不认识的参数 operationId')
    expect(
      refusal(await f.call('settings.list', { approvalId: '0'.repeat(32) })),
    ).toBe('不认识的参数 approvalId')
    expect(
      await settingsUnwired('settings.list', {}, { node: NODE, callId: 'c' }),
    ).toEqual({
      ok: false,
      code: 'refused',
      message:
        '这台中枢不能让智能体改设置 · 需要 --accounts 与 --approvals 接上审批',
    })
  })
})

describe('what may be asked for (P40 §§2, 8)', () => {
  test('unknown, person-only, malformed, beyond the owner, or no change at all', async () => {
    const f = await fixture()
    f.notes.stored.set('p11', { server: 'p11', note: '同样', updatedAt: 1 })
    f.chats.open('chat-member')
    expect(f.h.book.recordOwner('chat-member', f.member.subject).ok).toBe(true)
    const preview = (args: Record<string, unknown>) =>
      f.call('settings.preview', args).then(refusal)

    expect(await preview({ id: 'servers.nope' })).toBe(
      '没有这个设置项 servers.nope',
    )
    for (const id of [
      'approvals.decide',
      'elevation.set',
      'accounts.invite',
      'files.decide',
      'im.create',
      'im.login',
    ]) {
      const said = await preview({ id })
      expect(said.startsWith('只能本人操作 · ')).toBe(true)
      expect(said).toContain('/admin/')
    }
    expect(await preview({ ...NOTE, target: {} })).toBe('target.server 缺失')
    expect(await preview({ ...NOTE, target: { server: 'p11', x: 1 } })).toBe(
      'target.x 不认识',
    )
    expect(await preview({ ...NOTE, input: { note: 5 } })).toBe(
      'input.note 应为 string',
    )
    expect(await preview({ ...NOTE, input: 'note' })).toBe('input 应为对象')
    expect(
      await preview({
        id: 'providers.default',
        target: { node: NODE },
        input: { profileId: 'a' },
      }),
    ).toBe('这个设置项不收 target')
    expect(
      await f
        .call('settings.preview', {
          ...NOTE,
          input: { note: 'x' },
          contextId: 'chat-member',
        })
        .then(refusal),
    ).toBe('这项更改需要运维 · 这个对话的主人不是运维')
    expect(await preview({ ...NOTE, input: { note: '同样' } })).toBe(
      '值没变 · 不用改',
    )

    const early = new ConsoleSettings({
      chat: f.chats,
      accounts: { book: f.h.book },
      approvals: f.hub,
      console: () => undefined,
    })
    expect(
      refusal(
        (await early.handle(
          'settings.preview',
          { ...NOTE, input: { note: 'x' }, contextId: CHAT, taskId: TASK },
          { node: NODE, agent: AGENT, callId: 'c' },
        )) as Outcome,
      ),
    ).toBe('控制台还没有起来')
    expect(
      f.store.lines().filter(line => line.kind === 'server.note.set'),
    ).toEqual([])
  })
})

describe('what an approval is good for (P40 §§5, 8)', () => {
  const SPENT_OR_WRONG =
    '单次批准不存在 已用过 已过期或参数与当前值已变化 · 重新申请批准'

  test('only the change approved, only while the value is the one shown', async () => {
    const f = await fixture()
    const apply = (input: Record<string, unknown>, approvalId: string) =>
      f.call('settings.apply', { ...NOTE, input, approvalId }).then(refusal)

    expect(await apply({ note: 'a' }, 'not-an-id')).toBe('缺少单次批准编号')
    expect(await apply({ note: 'a' }, 'f'.repeat(32))).toBe(SPENT_OR_WRONG)

    const first = await approved(f, { note: 'a' })
    // Different arguments: refused, and the approval is not spent by it.
    expect(await apply({ note: 'b' }, first.requestId)).toBe(SPENT_OR_WRONG)
    expect(await apply({ note: 'a' }, first.requestId)).toBe('ok')
    expect(f.notes.stored.get('p11')?.note).toBe('a')

    // The value moved between approval and apply.
    const second = await approved(f, { note: 'b' })
    f.notes.stored.set('p11', {
      server: 'p11',
      note: '有人先改了',
      updatedAt: 2,
    })
    expect(await apply({ note: 'b' }, second.requestId)).toBe(SPENT_OR_WRONG)
    expect(f.notes.stored.get('p11')?.note).toBe('有人先改了')

    // Asked, never decided; and decided no.
    const bound = boundOf(
      await f.call('settings.preview', { ...NOTE, input: { note: 'c' } }),
    )
    const pending = await f.approvalFor(bound)
    expect(await apply({ note: 'c' }, pending.requestId)).toBe(SPENT_OR_WRONG)
    expect((await f.decide(f.ops, pending, 'deny')).ok).toBe(true)
    expect(await apply({ note: 'c' }, pending.requestId)).toBe(SPENT_OR_WRONG)
    expect(f.notes.stored.get('p11')?.note).toBe('有人先改了')
  })

  test('not after its minute, and not once the approver is gone', async () => {
    const f = await fixture()
    const late = await approved(f, { note: 'late' })
    f.skew.ms = 61_000
    expect(
      refusal(
        await f.call('settings.apply', {
          ...NOTE,
          input: { note: 'late' },
          approvalId: late.requestId,
        }),
      ),
    ).toBe(SPENT_OR_WRONG)
    f.skew.ms = 0

    const approver = principalOf(f.h, await person(f.h.handle, 'ops'))
    const request = await approved(f, { note: 'gone' }, approver)
    expect(f.h.book.revoke(approver.subject, 'legacy:admin').ok).toBe(true)
    expect(
      refusal(
        await f.call('settings.apply', {
          ...NOTE,
          input: { note: 'gone' },
          approvalId: request.requestId,
        }),
      ),
    ).toBe(SPENT_OR_WRONG)
    expect(f.notes.stored.size).toBe(0)
  })

  test('one approval at a time, by somebody who could make the change', async () => {
    const f = await fixture()
    const bound = boundOf(
      await f.call('settings.preview', { ...NOTE, input: { note: 'w' } }),
    )
    const request = await f.approvalFor(bound)
    expect(await f.decide(f.ops, request, 'allow-window')).toEqual({
      ok: false,
      failure: {
        code: 'invalid',
        message: '设置更改只能逐次批准 不支持授权窗口',
      },
    })

    // A member's own conversation, and a bound that says it needs ops: the
    // member may answer approvals there, but not this one.
    f.chats.open('chat-member')
    expect(f.h.book.recordOwner('chat-member', f.member.subject).ok).toBe(true)
    const forOps = await f.approvalFor(bound, 'chat-member')
    expect(await f.decide(f.member, forOps)).toEqual({
      ok: false,
      failure: { code: 'refused', message: '这项更改需要运维批准' },
    })
    const unreadable = await f.approvalFor(
      { ...bound, card: { role: 'root' } },
      'chat-member',
    )
    expect(await f.decide(f.member, unreadable)).toEqual({
      ok: false,
      failure: { code: 'refused', message: '这项更改需要成员或运维批准' },
    })
  })

  test('a refusal by the route, or no answer at all, still spends the approval', async () => {
    const f = await fixture()
    const elsewhere = { id: 'servers.note', target: { server: 'p99' } }
    const bound = boundOf(
      await f.call('settings.preview', { ...elsewhere, input: { note: 'x' } }),
    )
    const request = await f.approvalFor(bound)
    expect((await f.decide(f.ops, request)).ok).toBe(true)
    const args = {
      ...elsewhere,
      input: { note: 'x' },
      approvalId: request.requestId,
    }
    expect(await f.call('settings.apply', args)).toEqual({
      ok: false,
      code: 'refused',
      message: '该服务器不在启动时配置的白名单中',
    })
    expect(refusal(await f.call('settings.apply', args))).toBe(SPENT_OR_WRONG)
    expect(actionLines(f).find(line => line['target'] === 'p99')).toMatchObject(
      {
        outcome: 'refused',
        agent: ADDRESS,
        approval: request.requestId,
      },
    )

    const broken = await approved(f, { note: 'y' })
    f.notes.broken = true
    const outcome = await f.call('settings.apply', {
      ...NOTE,
      input: { note: 'y' },
      approvalId: broken.requestId,
    })
    expect(outcome.ok ? '' : outcome.code).toBe('unknown')
    expect(refusal(outcome)).toContain('不要自动重试')
  })
})
