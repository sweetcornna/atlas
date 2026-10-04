// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff node` (P17.5): the bridge between a hub's signed
 * `task.request` and the qmcode app-server, against a fake app-server
 * (`support/fakeAppServer.ts`) and a real transport, git and ledger.
 *
 * The hub here is a bare `TransportClient` that pushes the refs with git and
 * sends what `consoleHandoffDispatch.ts` sends; the dispatcher has its own
 * tests.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateNodeKeyPair } from '@qianmo/capability'
import {
  decodeResultContent,
  type HandoffManifest,
  sessionRef,
  taskBranch,
} from '@qianmo/handoff'
import {
  createMessage,
  LEGACY_MESSAGE_TYPES,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import { TransportClient } from '@qianmo/transport'
import { createConsoleWakeIssuer } from '../consoleWakeIdentity.js'
import {
  APP_SERVER_ANON_LIMIT_KB,
  appServerMemory,
  checkBwrap,
  HandoffNodeRefusal,
  handoffBrief,
  handoffNodeAddress,
  importableClaudeCodeTranscript,
  NODE_REFERENCE_HOOK,
  parseHandoffNodeArgs,
  recentClaudeCodeRounds,
  startHandoffNode,
} from '../handoffNode.js'
import { HandoffUserError } from '../handoffStore.js'
import {
  bwrapStub,
  CLAUDE_SESSION,
  git,
  type Laptop,
  laptop,
  MODEL_KEY_CANARY,
  QMCODE_SESSION,
  repositoryShape,
  startTestNode,
  type TestNode,
} from './support/handoffNodeFixtures.js'
import { claudeCodeTranscript } from './support/handoffSamples.js'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-node-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(
  what: string,
  check: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

const HUB = 'qianmo://hub/console'
/** End-to-end cases start git, a transport and a fake app-server. */
const SLOW = 30_000

/** The hub's end of the wire: a dialer that signs like the console. */
class Hub {
  readonly inbox: QianmoMessage[] = []
  readonly #router = new NodeRouter({ node: 'hub' })
  #client: TransportClient | null = null

  constructor(
    private readonly node: TestNode,
    private readonly issue: TestNode['issue'] | null = node.issue,
    /** The console's chat face declares the floor plus `notify`. */
    private readonly supportedTypes: readonly string[] | null = [
      ...LEGACY_MESSAGE_TYPES,
      MessageType.Notify,
    ],
  ) {}

  async connect(): Promise<this> {
    this.#client = new TransportClient({
      endpoint: { url: this.node.handle.url },
      node: 'hub',
      psk: this.node.psk,
      keepAliveIntervalMs: 0,
      ...(this.supportedTypes === null
        ? {}
        : { supportedTypes: this.supportedTypes }),
      onMessage: message => {
        this.inbox.push(message)
      },
    })
    await this.#client.connect(5_000)
    cleanups.push(() => this.#client?.close())
    return this
  }

  async close(): Promise<void> {
    await this.#client?.close()
  }

  async request(
    taskId: string,
    payload: unknown,
    extra: { readonly taskTtlMs?: number; readonly deliverTtlMs?: number } = {},
  ): Promise<QianmoMessage> {
    const to = handoffNodeAddress(this.node.node)
    const createdAt = Date.now()
    const cap = this.issue?.({
      aud: this.node.node,
      sub: to,
      taskId,
      createdAt,
    })
    const routed = this.#router.outbound(
      createMessage({
        from: HUB,
        to,
        type: MessageType.TaskRequest,
        taskId,
        createdAt,
        payload,
        ...(extra.taskTtlMs === undefined
          ? {}
          : { taskTtlMs: extra.taskTtlMs }),
        ...(extra.deliverTtlMs === undefined
          ? {}
          : { deliverTtlMs: extra.deliverTtlMs }),
        ...(cap === undefined ? {} : { cap }),
      }),
    )
    if (!routed.ok) throw new Error(routed.reason)
    const receipt = await this.#client?.sendAndWait(routed.message, 5_000)
    // A swallowed duplicate would look like silence from the node.
    if (receipt !== 'accepted') throw new Error(`receipt ${receipt}`)
    return routed.message
  }

  async ping(): Promise<void> {
    const routed = this.#router.outbound(
      createMessage({
        from: HUB,
        to: handoffNodeAddress(this.node.node),
        type: MessageType.Ping,
        payload: {},
      }),
    )
    if (!routed.ok) throw new Error(routed.reason)
    await this.#client?.sendAndWait(routed.message, 5_000)
  }

  replies(taskId: string, type?: MessageType): QianmoMessage[] {
    return this.inbox.filter(
      message =>
        message.taskId === taskId &&
        (type === undefined || message.type === type),
    )
  }

  async reply(taskId: string, type: MessageType): Promise<QianmoMessage> {
    await until(
      `${type} for ${taskId}`,
      () => this.replies(taskId, type).length > 0,
    )
    return this.replies(taskId, type)[0] as QianmoMessage
  }
}

async function node(
  base: string,
  options: Parameters<typeof startTestNode>[1] = {},
): Promise<TestNode> {
  const started = await startTestNode(base, options)
  cleanups.push(async () => {
    started.fake.stop()
    await started.handle.stop()
  })
  return started
}

/** What the hub does before the request: push the two refs into the node repo. */
function pushToNode(from: Laptop, target: TestNode): void {
  git(
    from.work,
    'push',
    '-q',
    target.repo(from.manifest.project),
    ...from.refs.map(ref => `${ref}:${ref}`),
  )
}

function resultOf(message: QianmoMessage) {
  const payload = message.payload as {
    outcome: string
    content?: string
    reason?: string
    code?: string
  }
  if (payload.outcome !== 'completed' || payload.content === undefined) {
    throw new Error(`task.result failed: ${payload.code} ${payload.reason}`)
  }
  const decoded = decodeResultContent(payload.content)
  if (!decoded.ok) throw new Error(decoded.errors.join('; '))
  return decoded.value
}

/** Criterion 3, after every run: only `qianmo/` branches, no remote. */
function expectOnlyQianmoBranches(target: TestNode): void {
  const shape = repositoryShape(target.repo())
  for (const ref of shape.refs) expect(ref).toStartWith('refs/heads/qianmo/')
  expect(shape.remotes).toBe('')
  for (const task of readdirSync(join(target.root, 'work'))) {
    expect(git(join(target.root, 'work', task), 'remote')).toBe('')
  }
}

const TASK = 'h-20261003-a1'

// ─── Arguments ───────────────────────────────────────────────────────

describe('parseHandoffNodeArgs', () => {
  const keys = generateNodeKeyPair()
  const required = [
    '--node',
    'cloud-a',
    '--root',
    '/srv/qianmo-handoff',
    '--trust',
    `hub=${keys.publicKey}`,
    '--app-server',
    'ws://127.0.0.1:38631',
    '--app-server-token-file',
    '/srv/qianmo-handoff/state/app-server.token',
    '--app-server-home',
    '/srv/qianmo-handoff/home',
  ]

  test('the required set parses; defaults for port, bind and the qmcode home', () => {
    const config = parseHandoffNodeArgs(
      [...required, '--project', 'atlas', '--project', 'atlas'],
      { qmcodeHome: '/x/qmcode' },
    )
    expect(config).toMatchObject({
      node: 'cloud-a',
      root: '/srv/qianmo-handoff',
      port: 38_630,
      bind: '127.0.0.1',
      trusted: [['hub', keys.publicKey]],
      projects: ['atlas'],
      appServerUrl: 'ws://127.0.0.1:38631',
      qmcodeHome: '/x/qmcode',
      appServerHome: '/srv/qianmo-handoff/home',
    })
  })

  test('refusals exit 2: a missing flag, no --trust, a non-loopback app-server, a relative path', () => {
    const fails = (args: string[]) => {
      try {
        parseHandoffNodeArgs(args)
      } catch (error) {
        expect(error).toBeInstanceOf(HandoffUserError)
        expect((error as HandoffUserError).exitCode).toBe(2)
        return (error as Error).message
      }
      throw new Error('parsed')
    }
    expect(fails(required.slice(2))).toContain('--node')
    const withoutTrust = required.filter((_, i) => i !== 4 && i !== 5)
    expect(fails(withoutTrust)).toContain('--trust')
    expect(
      fails(
        required.map(arg =>
          arg === 'ws://127.0.0.1:38631' ? 'ws://10.0.0.5:38631' : arg,
        ),
      ),
    ).toContain('回环')
    expect(
      fails(
        required.map(arg =>
          arg === '/srv/qianmo-handoff/home' ? 'home' : arg,
        ),
      ),
    ).toContain('绝对路径')
    expect(fails([...required, '--project', '../x'])).toContain('--project')
  })
})

// ─── bwrap (criterion 4) ─────────────────────────────────────────────

describe('bwrap check', () => {
  test(
    'red: no bwrap on PATH — refused, and the reason says what to install',
    async () => {
      const empty = join(tempDir(), 'empty-bin')
      mkdirSync(empty)
      const check = await checkBwrap({ PATH: empty })
      expect(check.ok).toBe(false)
      if (check.ok) return
      expect(check.reason).toContain('PATH 上没有 bwrap')
      expect(check.reason).toContain('bubblewrap')
      expect(check.reason).toContain('不退到 danger-full-access')
    },
    SLOW,
  )

  test(
    'red: bwrap present but no user namespace — refused with its stderr',
    async () => {
      const bin = bwrapStub(
        tempDir(),
        1,
        'bwrap: setting up uid map: Permission denied',
      )
      const check = await checkBwrap({ PATH: bin })
      expect(check.ok).toBe(false)
      if (check.ok) return
      expect(check.reason).toContain('建不了沙箱')
      expect(check.reason).toContain('Permission denied')
      expect(check.reason).toContain('kernel.unprivileged_userns_clone')
    },
    SLOW,
  )

  test(
    'green: a bwrap that builds the namespace',
    async () => {
      const bin = bwrapStub(tempDir(), 0)
      expect(await checkBwrap({ PATH: bin })).toEqual({
        ok: true,
        path: join(bin, 'bwrap'),
      })
    },
    SLOW,
  )

  test(
    'the bridge does not start without it: nothing listens, nothing is created',
    async () => {
      const base = tempDir()
      const empty = join(base, 'empty-bin')
      mkdirSync(empty)
      const refused = await startTestNode(base, {
        bridge: { env: { PATH: empty } },
      }).then(
        () => null,
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(HandoffNodeRefusal)
      expect(String(refused)).toContain('bubblewrap')
      expect(existsSync(join(base, 'node'))).toBe(false)
    },
    SLOW,
  )
})

// ─── Memory ──────────────────────────────────────────────────────────

function fakeProc(
  base: string,
  processes: readonly [number, number, number, number][],
): string {
  const proc = join(base, 'proc')
  for (const [pid, ppid, vmRss, rssAnon] of processes) {
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(
      join(proc, String(pid), 'stat'),
      `${pid} (qm code (x)) S ${ppid} 1 1 0\n`,
    )
    writeFileSync(
      join(proc, String(pid), 'status'),
      `Name:\tqmcode\nVmRSS:\t  ${vmRss} kB\nRssAnon:\t  ${rssAnon} kB\nRssFile:\t  ${vmRss - rssAnon} kB\n`,
    )
  }
  return proc
}

describe('app-server memory', () => {
  test('RssAnon and VmRSS summed over the app-server and its descendants only', () => {
    const proc = fakeProc(tempDir(), [
      [100, 1, 150_000, 22_000],
      [101, 100, 9_000, 4_000],
      [102, 101, 3_000, 1_000],
      [200, 1, 500_000, 400_000],
    ])
    expect(appServerMemory(100, proc)).toEqual({
      pids: [100, 101, 102],
      vmRssKb: 162_000,
      rssAnonKb: 27_000,
    })
    expect(appServerMemory(999, proc)).toBeNull()
    expect(appServerMemory(100, join(tempDir(), 'no-proc'))).toBeNull()
  })

  test(
    'over 150 MiB of RssAnon a new task is refused E_BUSY; a large VmRSS alone is not',
    async () => {
      const base = tempDir()
      const pidFile = join(base, 'app-server.pid')
      writeFileSync(pidFile, '100\n')
      const proc = fakeProc(base, [[100, 1, 900_000, 22_000]])
      const target = await node(base, {
        bridge: { appServerPidFile: pidFile, procRoot: proc },
      })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      // VmRSS 900 MB, RssAnon 22 MB: taken.
      await hub.request(TASK, from.manifest)
      await hub.reply(TASK, MessageType.TaskResult)
      // RssAnon over the line: refused.
      writeFileSync(
        join(proc, '100', 'status'),
        `VmRSS:\t ${APP_SERVER_ANON_LIMIT_KB + 10} kB\nRssAnon:\t ${APP_SERVER_ANON_LIMIT_KB + 1} kB\n`,
      )
      const from2 = await laptop(join(base, 'second'), { device: 'other-mbp' })
      pushToNode(from2, target)
      await hub.request('h-20261003-a2', from2.manifest)
      const error = await hub.reply('h-20261003-a2', MessageType.Error)
      expect(error.payload).toMatchObject({ code: ProtocolErrorCode.E_BUSY })
      expect(String((error.payload as { reason: string }).reason)).toContain(
        '150 MiB',
      )
      expect(hub.replies('h-20261003-a2', MessageType.Ack)).toEqual([])
      expect(target.logs.join('\n')).toContain('VmRSS 900000 kB')
    },
    SLOW,
  )
})

// ─── Steps ①–⑥ ───────────────────────────────────────────────────────

describe('the node bridge, steps ①–⑥', () => {
  test(
    'qmcode session: ack, work tree, rollout placed, resume, brief, commit, session ref, result',
    async () => {
      const base = tempDir()
      const target = await node(base, {
        fake: {
          work: turn =>
            writeFileSync(join(turn.cwd, 'b.txt'), 'written in the cloud\n'),
          reply: () => '写好了 b.txt',
        },
      })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest)

      // ① ack before the result.
      const ack = await hub.reply(TASK, MessageType.Ack)
      const done = await hub.reply(TASK, MessageType.TaskResult)
      expect(hub.inbox.indexOf(ack)).toBeLessThan(hub.inbox.indexOf(done))

      const worktree = join(target.root, 'work', TASK)
      // ③ the rollout went where qmcode keeps it.
      const placed = join(
        target.qmcodeHome,
        'sessions/2026/10/03',
        `rollout-2026-10-03T09-00-00-${QMCODE_SESSION}.jsonl`,
      )
      expect(existsSync(placed)).toBe(true)
      // ④ resume on the work tree, then the brief.
      expect(target.fake.upgrades[0]).toEqual({
        authorization: 'Bearer fake-app-server-capability-token-0123456789',
        origin: null,
      })
      expect(target.fake.calls('thread/resume')).toEqual([
        {
          threadId: QMCODE_SESSION,
          cwd: worktree,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          excludeTurns: true,
        },
      ])
      const [start] = target.fake.calls('turn/start')
      const brief = (start?.input as { text: string }[])[0]?.text ?? ''
      expect(brief).toBe(handoffBrief(from.manifest, TASK, worktree))
      expect(brief).toContain('只在当前分支提交，不推送、不发布、不付款')
      expect(brief).toContain('把 b.txt 写好')
      expect(brief).toContain(from.work)

      // ⑤ the result and what it points at.
      const result = resultOf(done)
      const repo = target.repo()
      expect(result).toEqual({
        status: 'completed',
        branch: taskBranch(TASK),
        head: git(repo, 'rev-parse', taskBranch(TASK)),
        threadId: QMCODE_SESSION,
        summary: '写好了 b.txt',
      })
      expect(git(repo, 'show', `${result.head}:b.txt`)).toBe(
        'written in the cloud',
      )
      expect(git(repo, 'show', `${result.head}:a.txt`)).toBe('one\ntwo')
      expect(git(repo, 'rev-parse', `${result.head}^`)).toBe(from.manifest.wip)
      const cloud = git(repo, 'rev-parse', sessionRef('cloud', QMCODE_SESSION))
      const stored = git(
        repo,
        'show',
        `${cloud}:rollout-2026-10-03T09-00-00-${QMCODE_SESSION}.jsonl`,
      )
      const turnId = target.fake.turns[0] ?? ''
      expect(stored).toContain(`"turn_id":"${turnId}"`)
      expect(stored.trimEnd().split('\n').at(-1)).toContain('task_complete')
      // The work tree is clean against its branch afterwards.
      expect(git(worktree, 'status', '--porcelain')).toBe('')
      expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(
        taskBranch(TASK),
      )
      expectOnlyQianmoBranches(target)
    },
    SLOW,
  )

  test(
    '⑥ a result whose receipt is lost stays in the ledger and leaves again on the next message',
    async () => {
      const base = tempDir()
      const target = await node(base, { fake: { hold: true } })
      const from = await laptop(base)
      pushToNode(from, target)
      const first = await new Hub(target).connect()
      await first.request(TASK, from.manifest)
      await first.reply(TASK, MessageType.Ack)
      await until('the turn', () => target.fake.turns.length === 1)
      // The hub goes away while the turn runs; the result has nowhere to land.
      await first.close()
      target.fake.release()
      await until('the lost receipt', () =>
        target.logs.some(line => line.includes('留在投递台账')),
      )
      await target.handle.idle()
      const ledger = readFileSync(
        join(target.root, 'state', 'deliveries.ndjson'),
        'utf8',
      )
      expect(ledger).toContain(TASK)
      expect(first.replies(TASK, MessageType.TaskResult)).toEqual([])

      // The hub is back (a restart, a new channel): its ping is the cue.
      const again = await new Hub(target).connect()
      await again.ping()
      const redelivered = await again.reply(TASK, MessageType.TaskResult)
      expect(redelivered.payload).toMatchObject({
        outcome: 'completed',
        redelivered: true,
      })
      expect(resultOf(redelivered).status).toBe('completed')
      await target.handle.idle()
      const settled = readFileSync(
        join(target.root, 'state', 'deliveries.ndjson'),
        'utf8',
      )
      expect(settled).toContain('"delivered"')
      expectOnlyQianmoBranches(target)
    },
    SLOW,
  )

  test(
    'the same request again: still running → ack again; finished → the stored result again',
    async () => {
      const base = tempDir()
      const target = await node(base, { fake: { hold: true } })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest, { deliverTtlMs: 400 })
      await until('the turn', () => target.fake.turns.length === 1)
      // Past the loop guard's window for the first envelope (its delivery TTL).
      await Bun.sleep(500)
      await hub.request(TASK, from.manifest, { deliverTtlMs: 400 })
      await until(
        'two acks',
        () => hub.replies(TASK, MessageType.Ack).length === 2,
      )
      expect(target.fake.calls('thread/resume')).toHaveLength(1)
      target.fake.release()
      await hub.reply(TASK, MessageType.TaskResult)
      await target.handle.idle()
      const repeat = await new Hub(target).connect()
      // The transport remembers the second envelope's fingerprint for its
      // delivery TTL; the hub's restart takes longer than that.
      await Bun.sleep(450)
      await repeat.request(TASK, from.manifest)
      const again = await repeat.reply(TASK, MessageType.TaskResult)
      expect(resultOf(again).status).toBe('completed')
      expect(again.payload).toMatchObject({ redelivered: true })
      expect(target.fake.calls('thread/resume')).toHaveLength(1)
    },
    SLOW,
  )
})

// ─── Claude Code (criterion 2) ───────────────────────────────────────

describe('a Claude Code session', () => {
  test('cut to user/assistant records, cwd rewritten', () => {
    const text = claudeCodeTranscript(
      CLAUDE_SESSION,
      '/Users/x/atlas',
      'complete',
    )
    const out = importableClaudeCodeTranscript(text, '/srv/node/work/t1')
    const records = out
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(['user', 'assistant']).toContain(record.type)
      expect(record.isSidechain).toBe(false)
      expect(record.cwd).toBe('/srv/node/work/t1')
    }
    expect(out).not.toContain('"attachment"')
    expect(out).not.toContain('"summary"')
  })

  test(
    'imported: the file under the app-server HOME, externalAgentConfig/import, resume on the target',
    async () => {
      const base = tempDir()
      const target = await node(base)
      const from = await laptop(base, { tool: 'claude-code' })
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest)
      const result = resultOf(await hub.reply(TASK, MessageType.TaskResult))

      const worktree = join(target.root, 'work', TASK)
      const imported = join(
        target.appServerHome,
        '.claude',
        'projects',
        'qianmo-import',
        `${CLAUDE_SESSION}.jsonl`,
      )
      expect(readFileSync(imported, 'utf8')).toContain(`"cwd":"${worktree}"`)
      const [call] = target.fake.calls('externalAgentConfig/import')
      expect(call).toEqual({
        migrationItems: [
          {
            itemType: 'SESSIONS',
            description: `qianmo handoff ${TASK}`,
            cwd: null,
            details: {
              sessions: [{ path: imported, cwd: worktree, title: null }],
            },
          },
        ],
      })
      expect(target.fake.calls('thread/start')).toEqual([])
      const [resume] = target.fake.calls('thread/resume')
      expect(resume?.threadId).toBe(result.threadId)
      expect(result.threadId).not.toBe(CLAUDE_SESSION)
      const [start] = target.fake.calls('turn/start')
      expect((start?.input as { text: string }[])[0]?.text).toBe(
        handoffBrief(from.manifest, TASK, worktree),
      )
      expect(result.status).toBe('completed')
      expect(
        git(
          target.repo(),
          'rev-parse',
          '--verify',
          sessionRef('cloud', result.threadId),
        ),
      ).toMatch(/^[0-9a-f]{40}$/)
      expectOnlyQianmoBranches(target)
    },
    SLOW,
  )

  test(
    'import fails: a fresh thread given the brief and the last rounds verbatim, and the summary says so',
    async () => {
      const base = tempDir()
      const target = await node(base, {
        fake: { importFailure: 'unsupported record shape' },
      })
      const from = await laptop(base, { tool: 'claude-code' })
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest)
      const result = resultOf(await hub.reply(TASK, MessageType.TaskResult))

      expect(target.fake.calls('externalAgentConfig/import')).toHaveLength(1)
      expect(target.fake.calls('thread/resume')).toEqual([])
      expect(target.fake.calls('thread/start')).toHaveLength(1)
      const [start] = target.fake.calls('turn/start')
      const text = (start?.input as { text: string }[])[0]?.text ?? ''
      const worktree = join(target.root, 'work', TASK)
      expect(text.startsWith(handoffBrief(from.manifest, TASK, worktree))).toBe(
        true,
      )
      expect(text).toContain('最近 1 轮的原文')
      expect(text).toContain('【用户】把 a.txt 读出来')
      expect(text).toContain('【助手】a.txt 里是 one。')
      expect(result.status).toBe('completed')
      expect(result.summary).toContain(
        'Claude Code 会话导入失败（the import failed: unsupported record shape）',
      )
      expectOnlyQianmoBranches(target)
    },
    SLOW,
  )

  test('the last rounds: a round opens at a typed prompt, the oldest go first', () => {
    const one = claudeCodeTranscript(CLAUDE_SESSION, '/w', 'complete')
    const recent = recentClaudeCodeRounds(one + one + one, 2)
    expect(recent.rounds).toBe(2)
    expect(recent.text.split('【用户】把 a.txt 读出来')).toHaveLength(3)
    expect(recent.text).toContain('[工具调用 Read]')
    expect(recent.text).toContain('[工具结果] 1\tone')
  })
})

// ─── send (criterion 7) ──────────────────────────────────────────────

describe('handoff.send', () => {
  test(
    'goes into the running turn on the task thread; a repeated seq is not sent twice',
    async () => {
      const base = tempDir()
      const target = await node(base, { fake: { hold: true } })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest)
      await until('the turn', () => target.fake.turns.length === 1)
      const turnId = target.fake.turns[0] ?? ''

      const send = {
        kind: 'handoff.send',
        task: TASK,
        seq: 1,
        text: '顺便把 c.txt 也写了',
      }
      await hub.request(`${TASK}-send-1`, send)
      const answered = await hub.reply(`${TASK}-send-1`, MessageType.TaskResult)
      expect(
        JSON.parse((answered.payload as { content: string }).content),
      ).toEqual({
        kind: 'handoff.send',
        task: TASK,
        seq: 1,
        turnId,
        duplicate: false,
      })
      const starts = target.fake.calls('turn/start')
      expect(starts).toHaveLength(2)
      expect(starts[1]).toEqual({
        threadId: QMCODE_SESSION,
        input: [
          { type: 'text', text: '顺便把 c.txt 也写了', text_elements: [] },
        ],
      })
      expect(target.fake.inputs(turnId)).toContain('顺便把 c.txt 也写了')

      // Redelivered by the hub (a new envelope, same seq): answered, not sent again.
      await hub.request(`${TASK}-send-1b`, send)
      const duplicate = await hub.reply(
        `${TASK}-send-1b`,
        MessageType.TaskResult,
      )
      expect(
        JSON.parse((duplicate.payload as { content: string }).content),
      ).toMatchObject({
        seq: 1,
        duplicate: true,
      })
      expect(target.fake.calls('turn/start')).toHaveLength(2)

      target.fake.release()
      expect(
        resultOf(await hub.reply(TASK, MessageType.TaskResult)).status,
      ).toBe('completed')
      // No task running: refused.
      await hub.request(`${TASK}-send-2`, { ...send, seq: 2 })
      expect(
        (await hub.reply(`${TASK}-send-2`, MessageType.Error)).payload,
      ).toMatchObject({
        code: ProtocolErrorCode.E_TASK_FAILED,
      })
    },
    SLOW,
  )
})

// ─── Signatures (criterion 8) ────────────────────────────────────────

describe('signatures', () => {
  test(
    'unsigned, or signed by a key the node does not trust: refused, nothing started',
    async () => {
      const base = tempDir()
      const target = await node(base)
      const from = await laptop(base)
      pushToNode(from, target)

      const unsigned = await new Hub(target, null).connect()
      await unsigned.request(TASK, from.manifest)
      const refusedUnsigned = await unsigned.reply(TASK, MessageType.Error)
      expect(
        String((refusedUnsigned.payload as { code: string }).code),
      ).toStartWith('E_CAP')

      const stranger = await new Hub(
        target,
        createConsoleWakeIssuer('hub', generateNodeKeyPair()),
      ).connect()
      await stranger.request('h-20261003-a3', from.manifest)
      const refusedStranger = await stranger.reply(
        'h-20261003-a3',
        MessageType.Error,
      )
      expect(
        String((refusedStranger.payload as { code: string }).code),
      ).toStartWith('E_CAP')

      const otherIssuer = await new Hub(
        target,
        createConsoleWakeIssuer('mallory', target.keys),
      ).connect()
      await otherIssuer.request('h-20261003-a4', from.manifest)
      const refusedIssuer = await otherIssuer.reply(
        'h-20261003-a4',
        MessageType.Error,
      )
      expect(
        String((refusedIssuer.payload as { code: string }).code),
      ).toStartWith('E_CAP')

      for (const hub of [unsigned, stranger, otherIssuer]) {
        expect(
          hub.inbox.filter(message => message.type === MessageType.Ack),
        ).toEqual([])
      }
      expect(target.fake.frames).toEqual([])
      expect(readdirSync(join(target.root, 'work'))).toEqual([])
      expectOnlyQianmoBranches(target)
    },
    SLOW,
  )
})

// ─── Refusals and endings ────────────────────────────────────────────

describe('refusals and endings', () => {
  test(
    'busy, objects not pushed, a branch already there: answered with an error, no ack',
    async () => {
      const base = tempDir()
      const target = await node(base, { fake: { hold: true } })
      const from = await laptop(base)
      const hub = await new Hub(target).connect()

      await hub.request(TASK, from.manifest)
      const missing = await hub.reply(TASK, MessageType.Error)
      expect(String((missing.payload as { reason: string }).reason)).toContain(
        '中枢没有推过来',
      )

      pushToNode(from, target)
      await hub.request('h-20261003-b1', from.manifest)
      await hub.reply('h-20261003-b1', MessageType.Ack)
      await until('the turn', () => target.fake.turns.length === 1)
      await hub.request('h-20261003-b2', from.manifest)
      expect(
        (await hub.reply('h-20261003-b2', MessageType.Error)).payload,
      ).toMatchObject({
        code: ProtocolErrorCode.E_BUSY,
      })
      // A hub that declares only the floor hears the legacy code (rule N-1).
      const legacy = await new Hub(target, target.issue, null).connect()
      await legacy.request('h-20261003-b5', from.manifest)
      expect(
        (await legacy.reply('h-20261003-b5', MessageType.Error)).payload,
      ).toMatchObject({
        code: ProtocolErrorCode.E_RATE_LIMITED,
      })
      target.fake.release()
      await hub.reply('h-20261003-b1', MessageType.TaskResult)
      await target.handle.idle()

      git(
        target.repo(),
        'update-ref',
        'refs/heads/qianmo/h-20261003-b3',
        from.manifest.wip,
      )
      await hub.request('h-20261003-b3', from.manifest)
      expect(
        String(
          (
            (await hub.reply('h-20261003-b3', MessageType.Error)).payload as {
              reason: string
            }
          ).reason,
        ),
      ).toContain('跑过')

      const wrongTree: HandoffManifest = {
        ...from.manifest,
        tree: from.manifest.sessionCommit,
      }
      await hub.request('h-20261003-b4', wrongTree)
      expect(
        String(
          (
            (await hub.reply('h-20261003-b4', MessageType.Error)).payload as {
              reason: string
            }
          ).reason,
        ),
      ).toContain('不一致')
      for (const id of [
        TASK,
        'h-20261003-b2',
        'h-20261003-b3',
        'h-20261003-b4',
      ]) {
        expect(hub.replies(id, MessageType.Ack)).toEqual([])
      }
    },
    SLOW,
  )

  test(
    'the deadline interrupts the turn; the result is interrupted with what was done',
    async () => {
      const base = tempDir()
      const target = await node(base, {
        fake: {
          hold: true,
          work: turn => writeFileSync(join(turn.cwd, 'half.txt'), 'half\n'),
        },
      })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest, { taskTtlMs: 1_500 })
      const result = resultOf(await hub.reply(TASK, MessageType.TaskResult))
      expect(target.fake.calls('turn/interrupt')).toEqual([
        { threadId: QMCODE_SESSION, turnId: target.fake.turns[0] },
      ])
      expect(result.status).toBe('interrupted')
      expect(result.summary).toContain('到截止时间，回合被中断')
      expect(git(target.repo(), 'show', `${result.head}:half.txt`)).toBe('half')
    },
    SLOW,
  )

  test(
    'a secret in the cloud changes: failed, files and rule ids listed, the value nowhere',
    async () => {
      const base = tempDir()
      const pat = `ghp_${'a1B2'.repeat(9)}`
      const target = await node(base, {
        fake: {
          work: turn =>
            writeFileSync(
              join(turn.cwd, 'config.ts'),
              `export const t = '${pat}'\n`,
            ),
        },
      })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest)
      const failed = await hub.reply(TASK, MessageType.TaskResult)
      expect(failed.payload).toMatchObject({
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
      })
      const reason = (failed.payload as { reason: string }).reason
      expect(reason).toContain('config.ts')
      expect(reason).toContain('疑似密钥')
      expect(JSON.stringify(failed)).not.toContain(pat)
      expect(target.logs.join('\n')).not.toContain(pat)
      expect(existsSync(join(target.root, 'work', TASK, 'config.ts'))).toBe(
        true,
      )
      // The branch is still where the work tree started.
      expect(git(target.repo(), 'rev-parse', taskBranch(TASK))).toBe(
        from.manifest.wip,
      )
    },
    SLOW,
  )

  test(
    'the turn end never reaches the rollout: cut at the last line, said in the summary',
    async () => {
      const base = tempDir()
      const target = await node(base, {
        fake: { endLineDelayMs: null },
        bridge: { turnEndWaitMs: 200 },
      })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest)
      const result = resultOf(await hub.reply(TASK, MessageType.TaskResult))
      expect(result.summary).toContain('没有写到本回合的结束行')
      const stored = git(
        target.repo(),
        'show',
        `${sessionRef('cloud', QMCODE_SESSION)}:rollout-2026-10-03T09-00-00-${QMCODE_SESSION}.jsonl`,
      )
      expect(stored).not.toContain('"task_complete","turn_id":"turn-')
    },
    SLOW,
  )
})

// ─── Nothing of the environment (criterion 9, the bridge's part) ─────

describe('environment', () => {
  test(
    'a model key in the bridge environment reaches no log, ledger, result file or reply; the summary is redacted',
    async () => {
      const previous = process.env.OPENAI_API_KEY
      process.env.OPENAI_API_KEY = MODEL_KEY_CANARY
      cleanups.push(() => {
        if (previous === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = previous
      })
      const base = tempDir()
      const target = await node(base, {
        // The model echoes a key into its last message.
        fake: { reply: () => `完成。调试时看到 ${MODEL_KEY_CANARY}` },
      })
      const from = await laptop(base)
      pushToNode(from, target)
      const hub = await new Hub(target).connect()
      await hub.request(TASK, from.manifest)
      const done = await hub.reply(TASK, MessageType.TaskResult)
      await target.handle.idle()
      expect(resultOf(done).summary).toBe('完成。调试时看到 ***')
      expect(JSON.stringify(hub.inbox)).not.toContain(MODEL_KEY_CANARY)
      expect(target.logs.join('\n')).not.toContain(MODEL_KEY_CANARY)
      for (const file of [
        join(target.root, 'state', 'deliveries.ndjson'),
        join(target.root, 'state', 'results', `${TASK}.json`),
      ]) {
        expect(readFileSync(file, 'utf8')).not.toContain(MODEL_KEY_CANARY)
      }
      // The session ref is redacted the way the laptop's is.
      expect(
        git(
          target.repo(),
          'show',
          `${sessionRef('cloud', QMCODE_SESSION)}:rollout-2026-10-03T09-00-00-${QMCODE_SESSION}.jsonl`,
        ),
      ).not.toContain(MODEL_KEY_CANARY)
    },
    SLOW,
  )
})

describe('node repository', () => {
  test(
    'created bare with no remote, the hub hook and the reference hook; a stray branch is refused',
    async () => {
      const base = tempDir()
      const target = await node(base)
      const repo = target.repo()
      expect(repositoryShape(repo)).toEqual({ refs: [], remotes: '' })
      expect(
        readFileSync(join(repo, 'hooks', 'reference-transaction'), 'utf8'),
      ).toBe(NODE_REFERENCE_HOOK)
      const from = await laptop(base)
      // The hub may push only wip and session refs of a device that is not cloud.
      expect(() =>
        git(from.work, 'push', '-q', repo, 'HEAD:refs/heads/main'),
      ).toThrow()
      expect(() =>
        git(
          from.work,
          'push',
          '-q',
          repo,
          `${from.manifest.wip}:${sessionRef('cloud', QMCODE_SESSION)}`,
        ),
      ).toThrow()
      pushToNode(from, target)
      // In a work tree, a branch outside qianmo/ cannot be made.
      git(
        repo,
        'worktree',
        'add',
        '-q',
        '-b',
        'qianmo/probe',
        join(base, 'probe'),
        from.manifest.wip,
      )
      expect(() =>
        git(join(base, 'probe'), 'checkout', '-q', '-b', 'feature'),
      ).toThrow()
      expect(() => git(join(base, 'probe'), 'tag', 'v1')).toThrow()
      expect(repositoryShape(repo).refs).toEqual(['refs/heads/qianmo/probe'])
    },
    SLOW,
  )
})
