// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's dispatch (P17.5): `openConsoleHandoff` with node bridges, against
 * a real node bridge on a fake app-server (`support/handoffNodeFixtures.ts`),
 * or a bare transport listener that records what the hub sends. Git, the
 * transport, the ledger and the audit chain are all real.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTrail } from '@qianmo/audit'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { handoffNodeAddress, sessionRef, taskBranch } from '@qianmo/handoff'
import {
  errorReply,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { startTransportServer } from '@qianmo/transport'
import {
  parseConsoleArgs,
  transportPskEnvVarForNode,
} from '../../src/commands/consoleArgs.js'
import { openConsoleHandoff } from '../../src/commands/consoleHandoff.js'
import {
  type HandoffDispatchConfig,
  type HandoffNodeTarget,
  wireHandoffDispatch,
} from '../../src/commands/consoleHandoffDispatch.js'
import { createConsoleWakeIssuer } from '../../src/commands/consoleWakeIdentity.js'
import { initHubRepository } from '../../src/commands/handoffHub.js'
import { ensureNodeRepository } from '../../src/commands/handoffNode.js'
import {
  git,
  type Laptop,
  laptop,
  MODEL_KEY_CANARY,
  QMCODE_SESSION,
  startTestNode,
  type TestNode,
} from './support/handoffNodeFixtures.js'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-dispatch-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(
  what: string,
  check: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

const SLOW = 40_000
const HUB_FROM = 'qianmo://hub/console'

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

function targetOf(started: TestNode): HandoffNodeTarget {
  return {
    node: started.node,
    url: started.handle.url,
    psk: started.psk,
    git: { kind: 'local', root: join(started.root, 'repos') },
  }
}

/** A webhook receiver on loopback; the path stands in for a Bark/ntfy secret. */
function webhook(): { readonly url: string; readonly bodies: unknown[] } {
  const bodies: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      bodies.push(await request.json())
      return new Response('ok')
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}/hook/secret-topic-0123`,
    bodies,
  }
}

interface Hub {
  readonly handoff: ReturnType<typeof openConsoleHandoff>
  readonly repo: string
  readonly ledgerPath: string
  readonly auditPath: string
  readonly logs: string[]
  state(taskId: string): string | undefined
  /** States the ledger file went through for `taskId`, in order. */
  history(taskId: string): string[]
}

/** The hub's bare repository with the laptop's refs pushed in, as after `qm handoff now`. */
async function hubRepository(base: string, from: Laptop): Promise<string> {
  const root = join(base, 'hub')
  const repo = await initHubRepository({ kind: 'local', root }, 'atlas')
  git(from.work, 'push', '-q', repo, ...from.refs.map(ref => `${ref}:${ref}`))
  return root
}

function openHub(
  base: string,
  root: string,
  config: HandoffDispatchConfig,
): Hub {
  const ledgerPath = join(base, 'hub-state', 'ledger.ndjson')
  const auditPath = join(base, 'hub-state', 'audit.ndjson')
  const logs: string[] = []
  const handoff = openConsoleHandoff({
    root,
    ledgerPath,
    auditPath,
    onError: line => logs.push(line),
    dispatch: { config, status: 'test' },
  })
  cleanups.push(() => handoff.close())
  return {
    handoff,
    repo: join(root, 'atlas.git'),
    ledgerPath,
    auditPath,
    logs,
    state(taskId) {
      return this.history(taskId).at(-1)
    },
    history(taskId) {
      return readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { taskId: string; state?: string })
        .filter(
          record => record.taskId === taskId && record.state !== undefined,
        )
        .map(record => record.state as string)
    },
  }
}

function dispatchConfig(
  nodes: readonly HandoffNodeTarget[],
  issue: HandoffDispatchConfig['issueCapability'],
  extra: Partial<HandoffDispatchConfig> = {},
): HandoffDispatchConfig {
  return {
    nodes,
    from: HUB_FROM,
    issueCapability: issue,
    pingIntervalMs: 150,
    deliverTtlMs: 300,
    receiptTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    keepAliveIntervalMs: 0,
    ...extra,
  }
}

async function accept(hub: Hub, from: Laptop): Promise<string> {
  const accepted = await hub.handoff.port.accept(from.manifest)
  if (!accepted.ok) throw new Error(accepted.failure.message)
  return accepted.value.task.taskId
}

function auditKinds(hub: Hub, taskId: string): string[] {
  return readTrail(hub.auditPath)
    .records.filter(record => record.taskId === taskId)
    .map(record => record.kind)
}

// ─── Criterion 6: end to end ─────────────────────────────────────────

describe('dispatch to a node bridge', () => {
  test(
    'push the objects, signed task.request, ack → running, result, fetch back, done, audit, webhook',
    async () => {
      const base = tempDir()
      const hook = webhook()
      const target = await node(base, {
        node: 'cloud-a',
        fake: {
          work: turn => writeFileSync(join(turn.cwd, 'b.txt'), 'cloud\n'),
          // The model echoes a key; the node redacts the summary before it leaves.
          reply: () => `写好了 b.txt，调试时看到 ${MODEL_KEY_CANARY}`,
        },
      })
      const from = await laptop(base)
      const hub = openHub(
        base,
        await hubRepository(base, from),
        dispatchConfig([targetOf(target)], target.issue, {
          notifyUrl: hook.url,
        }),
      )
      hub.handoff.start()
      const taskId = await accept(hub, from)

      await until('done', () => hub.state(taskId) === 'done')
      expect(hub.history(taskId)).toEqual([
        'accepted',
        'dispatched',
        'running',
        'done',
      ])

      // The three objects went to the node, under the laptop's refs.
      const nodeRepo = target.repo()
      for (const object of [
        `${from.manifest.wip}^{commit}`,
        `${from.manifest.tree}^{tree}`,
        `${from.manifest.sessionCommit}^{commit}`,
      ]) {
        expect(() => git(nodeRepo, 'cat-file', '-e', object)).not.toThrow()
      }
      expect(git(nodeRepo, 'rev-parse', from.refs[0])).toBe(from.manifest.wip)

      // The node ran it on the session it was given.
      expect(target.fake.calls('thread/resume')[0]?.threadId).toBe(
        QMCODE_SESSION,
      )

      // The result in the ledger, and what it names is in the hub's repository.
      const task = hub.handoff.port.get(taskId)
      const view = await task
      if (!view.ok) throw new Error(view.failure.message)
      const result = view.value.result
      expect(result?.status).toBe('completed')
      expect(result?.branch).toBe(taskBranch(taskId))
      expect(result?.threadId).toBe(QMCODE_SESSION)
      expect(git(hub.repo, 'rev-parse', taskBranch(taskId))).toBe(
        result?.head ?? '',
      )
      expect(git(hub.repo, 'show', `${result?.head}:b.txt`)).toBe('cloud')
      expect(git(hub.repo, 'rev-parse', `${result?.head}^`)).toBe(
        from.manifest.wip,
      )
      expect(
        git(hub.repo, 'rev-parse', sessionRef('cloud', QMCODE_SESSION)),
      ).toBe(git(nodeRepo, 'rev-parse', sessionRef('cloud', QMCODE_SESSION)))

      expect(auditKinds(hub, taskId)).toEqual([
        'handoff.accepted',
        'handoff.dispatched',
        'handoff.completed',
      ])

      await until('the webhook', () => hook.bodies.length === 1)
      expect(hook.bodies[0]).toMatchObject({
        title: `接力任务 ${taskId} 完成`,
        msgtype: 'text',
        qianmo: {
          taskId,
          state: 'done',
          node: 'cloud-a',
          status: 'completed',
          branch: taskBranch(taskId),
          threadId: QMCODE_SESSION,
        },
      })

      // Criterion 9 on the hub: the key the model echoed is nowhere here.
      expect(result?.summary).toContain('***')
      for (const text of [
        readFileSync(hub.ledgerPath, 'utf8'),
        readFileSync(hub.auditPath, 'utf8'),
        JSON.stringify(hook.bodies),
        hub.logs.join('\n'),
        target.logs.join('\n'),
      ]) {
        expect(text).not.toContain(MODEL_KEY_CANARY)
      }
      // The webhook URL's secret path is not logged.
      expect(hub.logs.join('\n')).not.toContain('secret-topic')
    },
    SLOW,
  )

  test(
    'the request: bridge address, manifest payload, task deadline from the manifest, signed for that node; a refusal fails the task',
    async () => {
      const base = tempDir()
      const hook = webhook()
      const from = await laptop(base)
      const keys = generateNodeKeyPair()
      const nodeRoot = join(base, 'recording')
      await ensureNodeRepository(nodeRoot, 'atlas')
      const seen: QianmoMessage[] = []
      const psk = 'p'.repeat(64)
      const server = startTransportServer({
        psk,
        port: 0,
        hostname: '127.0.0.1',
        onMessage: (message, context) => {
          seen.push(message)
          context.channel.send(
            errorReply(
              message,
              ProtocolErrorCode.E_CAP_INVALID,
              'signature does not verify',
            ),
          )
        },
      })
      cleanups.push(() => server.stop())
      const hub = openHub(
        base,
        await hubRepository(base, from),
        dispatchConfig(
          [
            {
              node: 'cloud-r',
              url: server.url ?? '',
              psk,
              git: { kind: 'local', root: join(nodeRoot, 'repos') },
            },
          ],
          createConsoleWakeIssuer('hub', keys),
          { notifyUrl: hook.url },
        ),
      )
      hub.handoff.start()
      const taskId = await accept(hub, from)
      await until('failed', () => hub.state(taskId) === 'failed')

      const [request] = seen
      if (request === undefined) throw new Error('no request')
      expect(request.type).toBe(MessageType.TaskRequest)
      expect(request.from).toBe(HUB_FROM)
      expect(request.to).toBe(handoffNodeAddress('cloud-r'))
      expect(request.taskId).toBe(taskId)
      expect(request.payload).toEqual(from.manifest)
      expect(request.createdAt + request.taskTtlMs).toBe(
        Date.parse(from.manifest.deadline),
      )
      // Signed the way the bridge checks it: SIGNED_TASK_POLICY, issuer trusted.
      const verdict = new NodeCapabilities({
        node: 'cloud-r',
        directory: new StaticPublicKeyDirectory([['hub', keys.publicKey]]),
        policy: SIGNED_TASK_POLICY,
        trustedIssuers: ['hub'],
      }).check(request, Date.now())
      expect(verdict.ok).toBe(true)

      expect(hub.history(taskId)).toEqual(['accepted', 'dispatched', 'failed'])
      const view = await hub.handoff.port.get(taskId)
      if (!view.ok) throw new Error(view.failure.message)
      expect(view.value.reason).toContain('E_CAP_INVALID')
      expect(view.value.node).toBe('cloud-r')
      expect(auditKinds(hub, taskId)).toEqual([
        'handoff.accepted',
        'handoff.dispatched',
        'handoff.failed',
      ])
      await until('the webhook', () => hook.bodies.length === 1)
      expect(hook.bodies[0]).toMatchObject({
        title: `接力任务 ${taskId} 失败`,
        qianmo: { taskId, state: 'failed', node: 'cloud-r' },
      })
      // The objects went before the request.
      expect(() =>
        git(
          join(nodeRoot, 'repos', 'atlas.git'),
          'cat-file',
          '-e',
          `${from.manifest.sessionCommit}^{commit}`,
        ),
      ).not.toThrow()
    },
    SLOW,
  )

  test(
    'E_BUSY is not final: the task stays dispatched and the request goes again after the loop window',
    async () => {
      const base = tempDir()
      const from = await laptop(base)
      const nodeRoot = join(base, 'busy')
      await ensureNodeRepository(nodeRoot, 'atlas')
      const seen: QianmoMessage[] = []
      const psk = 'q'.repeat(64)
      const server = startTransportServer({
        psk,
        port: 0,
        hostname: '127.0.0.1',
        onMessage: (message, context) => {
          seen.push(message)
          if (message.type !== MessageType.TaskRequest) return
          const requests = seen.filter(
            one => one.type === MessageType.TaskRequest,
          )
          context.channel.send(
            requests.length === 1
              ? errorReply(message, ProtocolErrorCode.E_BUSY, 'busy')
              : errorReply(
                  message,
                  ProtocolErrorCode.E_TASK_FAILED,
                  'second answer',
                ),
          )
        },
      })
      cleanups.push(() => server.stop())
      const hub = openHub(
        base,
        await hubRepository(base, from),
        dispatchConfig(
          [
            {
              node: 'cloud-b',
              url: server.url ?? '',
              psk,
              git: { kind: 'local', root: join(nodeRoot, 'repos') },
            },
          ],
          createConsoleWakeIssuer('hub', generateNodeKeyPair()),
        ),
      )
      hub.handoff.start()
      const taskId = await accept(hub, from)
      await until('the first answer', () => seen.length >= 1)
      await Bun.sleep(100)
      expect(hub.state(taskId)).toBe('dispatched')
      await until('failed', () => hub.state(taskId) === 'failed')
      // Pings go to a node holding a task too; the requests are what count.
      const requests = seen.filter(
        message => message.type === MessageType.TaskRequest,
      )
      expect(requests).toHaveLength(2)
      expect(
        (requests[1]?.createdAt ?? 0) - (requests[0]?.createdAt ?? 0),
      ).toBeGreaterThanOrEqual(300)
      expect(hub.logs.join('\n')).toContain('暂时不收（E_BUSY）')
    },
    SLOW,
  )

  test(
    'a node that cannot be pushed to sits out a tick; the next idle node takes the task',
    async () => {
      const base = tempDir()
      const from = await laptop(base)
      const target = await node(base, { node: 'cloud-b' })
      const hub = openHub(
        base,
        await hubRepository(base, from),
        dispatchConfig(
          [
            {
              node: 'cloud-a',
              url: target.handle.url,
              psk: target.psk,
              git: { kind: 'local', root: join(base, 'no-such-root') },
            },
            targetOf(target),
          ],
          target.issue,
        ),
      )
      hub.handoff.start()
      const taskId = await accept(hub, from)
      await until('done', () => hub.state(taskId) === 'done')
      const view = await hub.handoff.port.get(taskId)
      if (!view.ok) throw new Error(view.failure.message)
      expect(view.value.node).toBe('cloud-b')
      expect(hub.logs.join('\n')).toContain('推不到 cloud-a')
    },
    SLOW,
  )
})

// ─── Criterion 7: send ───────────────────────────────────────────────

describe('send', () => {
  test(
    'queued before the node took the task, and while it runs: both reach the thread as turn/start, in order',
    async () => {
      const base = tempDir()
      const target = await node(base, { node: 'cloud-a', fake: { hold: true } })
      const from = await laptop(base)
      const hub = openHub(
        base,
        await hubRepository(base, from),
        dispatchConfig([targetOf(target)], target.issue),
      )
      const taskId = await accept(hub, from)
      // Accepted, not dispatched yet: kept in the ledger, nothing sent.
      const early = await hub.handoff.port.send(taskId, '先说一句：用中文注释')
      expect(early.ok).toBe(true)
      hub.handoff.start()
      await until('running', () => hub.state(taskId) === 'running')
      await until(
        'the early sentence',
        () => target.fake.calls('turn/start').length === 2,
      )
      const late = await hub.handoff.port.send(taskId, '顺便把 c.txt 也写了')
      expect(late.ok).toBe(true)
      await until(
        'the late sentence',
        () => target.fake.calls('turn/start').length === 3,
      )
      const texts = target.fake
        .calls('turn/start')
        .map(call => (call.input as { text: string }[])[0]?.text ?? '')
      expect(texts[1]).toBe('先说一句：用中文注释')
      expect(texts[2]).toBe('顺便把 c.txt 也写了')
      for (const call of target.fake.calls('turn/start')) {
        expect(call.threadId).toBe(QMCODE_SESSION)
      }
      // Both went into the turn that was running (steered, same turn id).
      const turnId = target.fake.turns[0] ?? ''
      expect(target.fake.turns).toHaveLength(1)
      expect(target.fake.inputs(turnId)).toContain('顺便把 c.txt 也写了')
      await until(
        'both answered',
        () => hub.logs.filter(line => line.includes('进了线程')).length === 2,
      )

      target.fake.release()
      await until('done', () => hub.state(taskId) === 'done')
      // Over: the ledger takes no more.
      expect((await hub.handoff.port.send(taskId, '还有一句')).ok).toBe(false)
    },
    SLOW,
  )
})

// ─── Restart and time ────────────────────────────────────────────────

describe('restart and deadlines', () => {
  test(
    'a hub that restarts mid-task asks again and gets the stored result; done',
    async () => {
      const base = tempDir()
      const target = await node(base, { node: 'cloud-a', fake: { hold: true } })
      const from = await laptop(base)
      const root = await hubRepository(base, from)
      const config = dispatchConfig([targetOf(target)], target.issue)
      const first = openHub(base, root, config)
      first.handoff.start()
      const taskId = await accept(first, from)
      await until('running', () => first.state(taskId) === 'running')
      await until('the turn', () => target.fake.turns.length === 1)
      first.handoff.close()
      // The turn ends while no hub is there: the result has nowhere to land.
      target.fake.release()
      await until('the lost receipt', () =>
        target.logs.some(line => line.includes('留在投递台账')),
      )

      const second = openHub(base, root, config)
      expect(second.state(taskId)).toBe('running')
      second.handoff.start()
      await until('done', () => second.state(taskId) === 'done')
      expect(git(second.repo, 'rev-parse', taskBranch(taskId))).toBe(
        git(target.repo(), 'rev-parse', taskBranch(taskId)),
      )
      expect(target.fake.calls('thread/resume')).toHaveLength(1)
    },
    SLOW,
  )

  test(
    'deadlines: a task nobody took fails at its deadline, one that went out fails after the grace',
    async () => {
      const base = tempDir()
      const target = await node(base, { node: 'cloud-a' })
      // The first task must be dispatched before this passes, after two laptops
      // and the hub repository are built with real git and the deadline is cut
      // to the second. 2 s was not enough on a loaded machine (the task failed
      // as never taken before the hub's first push landed).
      const soon = new Date(Date.now() + 6_000)
        .toISOString()
        .replace(/\.\d+Z$/, 'Z')
      const from = await laptop(base, { deadline: soon })
      const other = await laptop(join(base, 'second'), {
        deadline: soon,
        device: 'other-mbp',
      })
      const root = await hubRepository(base, from)
      git(
        other.work,
        'push',
        '-q',
        join(root, 'atlas.git'),
        ...other.refs.map(ref => `${ref}:${ref}`),
      )
      const hub = openHub(
        base,
        root,
        dispatchConfig(
          [
            {
              // Pushes land; the bridge endpoint answers nothing.
              ...targetOf(target),
              url: 'ws://127.0.0.1:9/qianmo',
            },
          ],
          target.issue,
          { deadlineGraceMs: 500 },
        ),
      )
      hub.handoff.start()
      const went = await accept(hub, from)
      await until('dispatched', () => hub.state(went) === 'dispatched')
      const waiting = await accept(hub, other)
      await until(
        'both failed',
        () => hub.state(went) === 'failed' && hub.state(waiting) === 'failed',
      )
      const [a, b] = await Promise.all([
        hub.handoff.port.get(went),
        hub.handoff.port.get(waiting),
      ])
      if (!a.ok || !b.ok) throw new Error('missing task')
      expect(a.value.reason).toContain('还没有回结果')
      expect(b.value.reason).toContain('到截止时间还没有空闲节点接手')
      expect(hub.history(waiting)).toEqual(['accepted', 'failed'])
    },
    SLOW,
  )
})

// ─── Wiring and arguments ────────────────────────────────────────────

describe('wireHandoffDispatch', () => {
  const nodes = parseConsoleArgs([
    '--handoff-root',
    '/srv/qianmo/handoff/repos',
    '--handoff-node',
    'cloud-a=wss://cloud-a.example:38630/',
    '--handoff-node-git',
    'cloud-a=qianmo@cloud-a.example:/srv/qianmo/handoff/repos',
    '--handoff-node',
    'cloud-b=ws://10.0.0.2:38630',
    '--handoff-node-git',
    'cloud-b=/srv/local/repos',
    '--handoff-node-key',
    '/etc/qianmo/handoff-node-key',
    '--handoff-notify-url',
    'https://api.day.app/SECRETDEVICEKEY/',
  ])

  test('PSK per node from its derived variable; a node without one is left out; signed as the console', () => {
    let loaded = 0
    const wiring = wireHandoffDispatch(nodes, {
      pskFromEnv: variable => {
        if (
          variable === transportPskEnvVarForNode('cloud-a', '--handoff-node')
        ) {
          return 'a'.repeat(64)
        }
        throw new Error(`${String(variable)} unset`)
      },
      loadIdentity: from => {
        loaded += 1
        return {
          node: from.slice('qianmo://'.length).split('/')[0] ?? '',
          publicKey: 'PUBLICKEY',
          issue: () => 'cap',
        }
      },
    })
    expect(loaded).toBe(1)
    expect(wiring.config?.nodes.map(target => target.node)).toEqual(['cloud-a'])
    expect(wiring.config?.nodes[0]?.psk).toBe('a'.repeat(64))
    expect(wiring.config?.sshKey).toBe('/etc/qianmo/handoff-node-key')
    expect(wiring.config?.from).toBe(nodes.chatFrom)
    expect(wiring.status).toContain('signed as console=PUBLICKEY')
    expect(wiring.status).toContain('cloud-b disabled (PSK unavailable)')
    expect(wiring.status).toContain('notify https://api.day.app')
    expect(wiring.status).not.toContain('SECRETDEVICEKEY')
    expect(wiring.status).not.toContain('a'.repeat(64))
  })

  test('no node with a key: disabled, and no identity is created', () => {
    let loaded = 0
    const wiring = wireHandoffDispatch(nodes, {
      pskFromEnv: () => {
        throw new Error('unset')
      },
      loadIdentity: () => {
        loaded += 1
        throw new Error('must not be called')
      },
    })
    expect(loaded).toBe(0)
    expect(wiring.config).toBeUndefined()
    expect(wiring.status).toStartWith('disabled (')
    expect(wireHandoffDispatch(parseConsoleArgs([])).status).toBe(
      'disabled (no --handoff-node)',
    )
  })
})

describe('--handoff-node and friends', () => {
  const root = ['--handoff-root', '/srv/qianmo/handoff/repos']

  test('parsed in pairs per node; the git root as the SSH gate reads it', () => {
    const config = parseConsoleArgs([
      ...root,
      '--handoff-node=cloud-a=ws://127.0.0.1:38630',
      '--handoff-node-git=cloud-a=qianmo@cloud-a:~/handoff/repos',
      '--handoff-node-key=/k/gate',
      '--handoff-notify-url=http://127.0.0.1:9000/hook',
    ])
    expect(config.handoffNodes).toEqual([
      {
        node: 'cloud-a',
        url: 'ws://127.0.0.1:38630/',
        git: { kind: 'ssh', target: 'qianmo@cloud-a', root: '~/handoff/repos' },
      },
    ])
    expect(config.handoffNodeKey).toBe('/k/gate')
    expect(config.handoffNotifyUrl).toBe('http://127.0.0.1:9000/hook')
    const plain = parseConsoleArgs(root)
    expect(plain.handoffNodes).toBeUndefined()
    expect(plain.handoffNodeKey).toBeUndefined()
    expect(plain.handoffNotifyUrl).toBeUndefined()
  })

  test('refusals', () => {
    const cases: [readonly string[], string][] = [
      [['--handoff-node', 'cloud-a=ws://h:1'], 'needs --handoff-root'],
      [
        [...root, '--handoff-node', 'cloud-a=ws://h:1'],
        'needs --handoff-node-git',
      ],
      [
        [...root, '--handoff-node-git', 'cloud-a=/srv/repos'],
        'which has no --handoff-node',
      ],
      [[...root, '--handoff-node', 'cloud-a=http://h:1'], 'ws or wss'],
      [
        [
          ...root,
          '--handoff-node',
          'cloud-a=ws://h:1',
          '--handoff-node',
          'cloud-a=ws://h:2',
        ],
        'repeats node cloud-a',
      ],
      [
        [
          ...root,
          '--handoff-node',
          'cloud-a=ws://h:1',
          '--handoff-node-git',
          'cloud-a=me@h:/srv/../etc',
        ],
        'SSH gate rules',
      ],
      [
        [
          ...root,
          '--handoff-node',
          'cloud-a=ws://h:1',
          '--handoff-node-git',
          'cloud-a=me@h:/srv/repos',
        ],
        'needs --handoff-node-key',
      ],
      [
        [
          ...root,
          '--handoff-node',
          'cloud-a=ws://h:1',
          '--handoff-node-git',
          'cloud-a=/srv/repos',
          '--handoff-node-key',
          '/k',
        ],
        'needs an ssh --handoff-node-git',
      ],
      [[...root, '--handoff-node-key', 'relative/key'], 'absolute'],
      [[...root, '--handoff-notify-url', 'http://ntfy.example/topic'], 'https'],
      [
        ['--handoff-notify-url', 'https://ntfy.example/t'],
        'needs --handoff-root',
      ],
      [[...root, '--handoff-node', 'Cloud A=ws://h:1'], 'protocol segment'],
    ]
    for (const [args, message] of cases) {
      expect(() => parseConsoleArgs(args)).toThrow(message)
    }
  })
})
