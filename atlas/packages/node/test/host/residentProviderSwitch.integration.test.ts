// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Provider hot switch (design `providers-console-m1.md` §2.7, P18.3) with the
 * real `--acp` child: `src/entrypoints/cli.tsx --acp` from source, with the
 * shipped defines and feature list and the environment
 * `residentOmpEnvironment()` builds, driven by an in-process
 * {@link QianmoResident} through its own transport.
 *
 * ## What is real
 *
 * The resident, its supervisor, the ACP child and everything in it, the P18.2
 * write path (`providers/node.ts`) on a temporary 0700 config root, and the
 * child reading its provider out of that root's `settings.json`.
 *
 * ## What is not
 *
 * The models. Three loopback `Bun.serve` doubles speak just enough streaming
 * Chat Completions to end a turn, and record what each request carried: model
 * id, `Authorization` header, and the conversation text. The keys are
 * `sk-test-canary-…` strings; nothing leaves the machine.
 *
 * ## The process environment is a provider too
 *
 * The fleet's nodes are started with their model in the process environment
 * (`CLAUDE_CODE_USE_OPENAI`, `OPENAI_BASE_URL`, `OPENAI_MODEL`). The child here
 * gets the same — pointed at the `process-env` double — so every assertion
 * that a turn reached the managed endpoint is also an assertion that
 * `settings.json` won over the environment, and the `process-env` double must
 * never see a turn.
 *
 * ## Cost
 *
 * Four boots of the real child in the first describe (startup, keep, reset)
 * and two in the second; tests in a describe share one node and run in order.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  createMessage,
  isTaskResultPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { ResidentTimingEvent } from '@qianmo/resident'
import { TransportClient } from '@qianmo/transport'
import * as providerNode from '../../src/providers/node.js'
import { applyRequest } from '../providers/helpers.js'
import {
  QianmoResident,
  type ResidentProviderSwitchEvent,
} from '../../src/host/resident.js'
import { residentOmpEnvironment } from '../../src/host/residentOmpEnv.js'

const PSK = 'resident-provider-switch-integration-not-a-secret'
const TEAM = 'nest'
const AGENT = 'reviewer'
/** A cold boot of the entrypoint from source on a loaded machine. */
const BOOT_MS = 90_000
/** One model turn against a loopback double, including its result reply. */
const TURN_MS = 60_000
const TEST_TIMEOUT_MS = 240_000

const KEY_PROCESS = 'sk-test-canary-process-env-0Qm4'
const KEY_A = 'sk-test-canary-hot-switch-a-7Rw2'
const KEY_B = 'sk-test-canary-hot-switch-b-3Ld8'
const KEY_C = 'sk-test-canary-hot-switch-c-9Xe5'
const KEY_D = 'sk-test-canary-hot-switch-d-5Np1'

/** The one skill the child may list: planted in the test's own HOME. */
const HOME_PROBE_SKILL = 'hs-home-probe'
const HOME_PROBE_DESCRIPTION = 'Planted in this test’s own HOME.'

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs: number,
  diagnose: () => string = () => '',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(
    `timed out waiting for ${what} (${timeoutMs}ms)\n${diagnose()}`,
  )
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as Record<string, unknown>).text === 'string'
        ? ((part as Record<string, unknown>).text as string)
        : '',
    )
    .join('\n')
}

/** One request a model double received. */
interface ModelCall {
  readonly model: string
  readonly authorization: string
  /** Every message's text, joined: the conversation the request carried. */
  readonly text: string
  /** A streamed request offering tools: a main agent turn. */
  readonly turn: boolean
}

/**
 * A loopback Chat Completions endpoint. Answers every main-turn request with
 * `reply-from-<name>`, any other streamed request (omp's own auxiliary calls,
 * such as compressing a skill description into the system prompt) with
 * `aux-from-<name>`, and every other one with the trivial non-streamed shape;
 * can hold the request whose text carries a given token until released.
 */
class ModelDouble {
  readonly calls: ModelCall[] = []
  readonly #server: ReturnType<typeof Bun.serve>
  #held: { token: string; release: Promise<void> } | undefined

  constructor(readonly name: string) {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request => this.#answer(request),
    })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.#server.port)}/v1`
  }

  /** Main-turn requests whose conversation contains `token`. */
  turnsWith(token: string): ModelCall[] {
    return this.calls.filter(call => call.turn && call.text.includes(token))
  }

  turns(): ModelCall[] {
    return this.calls.filter(call => call.turn)
  }

  /** Hold the turn that carries `token`; the returned function lets it go. */
  hold(token: string): () => void {
    let release = (): void => {}
    this.#held = {
      token,
      release: new Promise<void>(resolve => {
        release = resolve
      }),
    }
    return () => {
      this.#held = undefined
      release()
    }
  }

  async stop(): Promise<void> {
    await this.#server.stop(true)
  }

  async #answer(request: Request): Promise<Response> {
    let body: { model?: unknown; messages?: unknown; tools?: unknown } & {
      stream?: unknown
    } = {}
    try {
      body = (await request.json()) as typeof body
    } catch {
      // Not a model call; answered with the trivial shape below.
    }
    const messages = Array.isArray(body.messages)
      ? (body.messages as { content?: unknown }[])
      : []
    const text = messages.map(message => textOf(message.content)).join('\n')
    const turn =
      body.stream === true && Array.isArray(body.tools) && body.tools.length > 0
    this.calls.push({
      model: typeof body.model === 'string' ? body.model : '',
      authorization: request.headers.get('authorization') ?? '',
      text,
      turn,
    })
    const held = this.#held
    if (turn && held !== undefined && text.includes(held.token)) {
      await held.release
    }
    if (body.stream !== true) {
      return Response.json({
        id: `double-${this.name}`,
        object: 'chat.completion',
        created: 1,
        model: 'double',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    const frame = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: `double-${this.name}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'double',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    return new Response(
      `${frame({ role: 'assistant', content: `${turn ? 'reply' : 'aux'}-from-${this.name}` }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
}

/** An `openai-chat` profile with one model on every tier. */
function chatProfile(input: {
  readonly baseUrl: string
  readonly model: string
  readonly key: string
  readonly revision: number
}): Record<string, unknown> {
  return {
    id: 'hot-switch',
    revision: input.revision,
    lane: 'openai-chat',
    baseUrl: input.baseUrl,
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: input.key }] },
    models: [
      {
        id: input.model,
        role: 'main',
        tiers: ['opus', 'sonnet', 'haiku', 'fable'],
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
      },
    ],
    compat: {},
  }
}

/** Stage an apply the way `qm provider serve-stdin` will (P18.7). */
function stage(
  profile: Record<string, unknown>,
  sessions: 'keep' | 'reset',
): string {
  const managed = providerNode.readProviderState().managed
  const result = providerNode.stageProviderApply(
    applyRequest({
      expect: { ownedHash: managed ? providerNode.currentManagedHash() : null },
      recycle: { sessions },
      profile,
    }),
  )
  if (!result.ok) throw new Error(JSON.stringify(result))
  expect(result.pending).toBe(true)
  return result.requestId
}

/** A config root the write path accepts (0700), and this process pointed at it. */
interface NodeRoot {
  readonly root: string
  readonly config: string
  readonly workspace: string
  readonly home: string
  readonly memory: string
  restore(): void
}

function setUpRoot(prefix: string): NodeRoot {
  // Resolved, because the base writes a session's transcript under the cwd it
  // was given but looks it up on resume under the canonical one: on macOS,
  // where `tmpdir()` sits behind the `/var` symlink, an unresolved workspace
  // resumes every session empty. A fleet workspace has no symlink in it; that
  // base behaviour is reported with P18.3, not worked around here.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const config = join(root, 'config')
  const workspace = join(root, 'ws')
  const home = join(root, 'home')
  const memory = join(root, 'memory')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  mkdirSync(workspace)
  mkdirSync(home)
  // A user-level skill in the root's own HOME: the child must list it, and
  // nothing from the real home directory (see `spawnRealOmp`).
  mkdirSync(join(home, '.agents', 'skills', HOME_PROBE_SKILL), {
    recursive: true,
  })
  writeFileSync(
    join(home, '.agents', 'skills', HOME_PROBE_SKILL, 'SKILL.md'),
    `---\nname: ${HOME_PROBE_SKILL}\ndescription: ${HOME_PROBE_DESCRIPTION}\n---\n\nNothing to do.\n`,
  )
  const previous = {
    QIANMO_CONFIG_DIR: process.env.QIANMO_CONFIG_DIR,
  }
  process.env.QIANMO_CONFIG_DIR = config

  return {
    root,
    config,
    workspace,
    home,
    memory,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }

      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * The real child, started the way the resident starts it but from source,
 * on the environment the resident built for it (`residentOmpEnvironment`
 * strips a managed node's provider keys) with two changes. The process
 * environment names the `process-env` double. `HOME` is the root's own, so
 * nothing under the real home directory is read: omp discovers user-level
 * skills, rules and agents there, and rewrites each skill's description with
 * a model call that one of the doubles would answer.
 */
function spawnRealOmp(
  input: import('../../src/host/residentOmp.js').ResidentOmpSpawn,
  node: NodeRoot,
  processEnvModel: ModelDouble,
  log: { text: string },
): ChildProcess {
  const env = residentOmpEnvironment({
    ...input.env,
    HOME: node.home,
    OPENAI_BASE_URL: processEnvModel.baseUrl,
    OPENAI_API_KEY: KEY_PROCESS,
  })
  const child = spawn(input.argv[0]!, input.argv.slice(1), {
    cwd: input.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', chunk => {
    log.text = `${log.text}${String(chunk)}`.slice(-20_000)
  })
  return child
}

function alive(child: ChildProcess | undefined): boolean {
  return (
    child !== undefined && child.exitCode === null && child.signalCode === null
  )
}

async function settle(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || !alive(child)) return
  child.kill('SIGKILL')
  await once(child, 'exit')
}

describe('resident hot switch against real omp RPC', () => {
  let node: NodeRoot
  let processEnvModel: ModelDouble
  let modelA: ModelDouble
  let modelB: ModelDouble
  let resident: QianmoResident
  let running: Promise<void>
  let client: TransportClient
  const replies: QianmoMessage[] = []
  const spawned: ChildProcess[] = []
  const switches: ResidentProviderSwitchEvent[] = []
  const alerts: string[] = []
  const errors: unknown[] = []
  const timings: ResidentTimingEvent[] = []
  const childLog = { text: '' }
  let firstIntent = ''
  let sessionAfterFirstTurn = ''

  const ready = () =>
    timings.filter(event => event.stage === 'runtime_ready').length
  const diagnose = () =>
    [
      `spawned=${spawned.length} ready=${ready()}`,
      `switches=${JSON.stringify(switches)}`,
      `alerts=${JSON.stringify(alerts)}`,
      `errors=${errors.map(String).join(' | ')}`,
      `child stderr (tail):\n${childLog.text.slice(-4_000)}`,
    ].join('\n')

  const sessionsPath = () => join(node.config, 'resident', 'sessions.json')
  const storedSessionId = (): string => {
    const stored = JSON.parse(readFileSync(sessionsPath(), 'utf8')) as Record<
      string,
      { sessionId: string }
    >
    const entries = Object.values(stored)
    expect(entries).toHaveLength(1)
    return (entries[0] as { sessionId: string }).sessionId
  }

  function task(token: string): QianmoMessage {
    return createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { instruction: `Reply briefly. Marker ${token}.` },
    })
  }

  async function resultOf(request: QianmoMessage): Promise<unknown> {
    const find = () =>
      replies.find(
        reply =>
          reply.type === MessageType.TaskResult &&
          reply.taskId === request.taskId,
      )
    await waitUntil(
      () => find() !== undefined,
      `task.result for ${request.taskId}`,
      TURN_MS,
      diagnose,
    )
    const payload = find()?.payload
    expect(isTaskResultPayload(payload)).toBe(true)
    return payload
  }

  beforeAll(async () => {
    node = setUpRoot('qm-hs-')
    processEnvModel = new ModelDouble('process-env')
    modelA = new ModelDouble('a')
    modelB = new ModelDouble('b')
    // Staged before the node starts: what a crash between stage and commit
    // leaves behind, and what the first life must roll forward.
    firstIntent = stage(
      chatProfile({
        baseUrl: modelA.baseUrl,
        model: 'hs-model-a',
        key: KEY_A,
        revision: 1,
      }),
      'reset',
    )
    resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: node.workspace }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: join(node.root, 'r.sock') },
      memoryRoot: node.memory,
      spawnOmp: input => {
        const child = spawnRealOmp(input, node, processEnvModel, childLog)
        spawned.push(child)
        return child
      },
      providerNode,
      providerSwitch: { pollIntervalMs: 100 },
      onProviderAlert: message => alerts.push(message),
      onProviderSwitched: event => switches.push(event),
      onError: error => errors.push(error),
      onTiming: event => timings.push(event),
    })
    running = resident.run()
    await waitUntil(
      () => ready() === 1,
      'first ACP generation',
      BOOT_MS,
      diagnose,
    )
    client = new TransportClient({
      endpoint: { unix: join(node.root, 'r.sock') },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    await client.connect()
  }, BOOT_MS + 30_000)

  afterAll(async () => {
    resident?.stop()
    await running
    await client?.close()
    for (const child of spawned) await settle(child)
    await Promise.all(
      [processEnvModel, modelA, modelB].map(model => model?.stop()),
    )
    node?.restore()
  }, 30_000)

  test(
    'an intent staged before start is committed before the first child, which runs on it',
    async () => {
      expect(switches).toEqual([
        {
          requestId: firstIntent,
          sessions: 'reset',
          recovered: false,
          via: 'startup',
        },
      ])
      expect(spawned).toHaveLength(0)
      expect(providerNode.hasPendingProviderConfig()).toBe(false)

      const first = task('HS-ONE')
      await client.sendAndWait(first)
      expect(await resultOf(first)).toMatchObject({
        outcome: 'completed',
        content: expect.stringContaining('reply-from-a'),
      })
      const [turn] = modelA.turnsWith('HS-ONE')
      expect(turn?.model).toBe('hs-model-a')
      expect(turn?.authorization).toBe(`Bearer ${KEY_A}`)
      expect(processEnvModel.turns()).toEqual([])
      sessionAfterFirstTurn = storedSessionId()
      // The child's HOME is the root's own: it lists the skill planted there
      // and nothing a developer installed under the real home directory. (The
      // description may already be omp's model-compressed one.)
      const listed = turn?.text
        .match(/<skills>\n([\s\S]*?)\n<\/skills>/)?.[1]
        ?.split('\n')
        .map(line => line.match(/^- ([^:]+):/)?.[1])
      expect(listed).toEqual([HOME_PROBE_SKILL])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a turn in flight holds the commit; when it ends the node commits and recycles its child',
    async () => {
      const release = modelA.hold('HS-TWO')
      const second = task('HS-TWO')
      await client.sendAndWait(second)
      await waitUntil(
        () => modelA.turnsWith('HS-TWO').length === 1,
        'the held turn to reach model a',
        TURN_MS,
        diagnose,
      )

      const keep = stage(
        chatProfile({
          baseUrl: modelA.baseUrl,
          model: 'hs-model-b',
          key: KEY_B,
          revision: 2,
        }),
        'keep',
      )
      // Fifteen 100 ms polls, and what a SIGHUP does, while the turn runs.
      await new Promise(resolve => setTimeout(resolve, 1_500))
      for (let i = 0; i < 3; i++) resident.checkProviderConfig()
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(providerNode.hasPendingProviderConfig()).toBe(true)
      expect(providerNode.readProviderState().applied?.requestId).toBe(
        firstIntent,
      )
      expect(spawned).toHaveLength(1)
      expect(alive(spawned[0])).toBe(true)
      expect(switches).toHaveLength(1)
      const waiting = JSON.parse(
        readFileSync(
          join(node.config, 'resident', 'provider-switch.json'),
          'utf8',
        ),
      ) as {
        pid: number
        waiting: { requestId: string; inFlight: { turns: number } } | null
      }
      expect(waiting.pid).toBe(process.pid)
      expect(waiting.waiting?.requestId).toBe(keep)
      expect(waiting.waiting?.inFlight.turns).toBe(1)

      release()
      expect(await resultOf(second)).toMatchObject({ outcome: 'completed' })
      await waitUntil(
        () => switches.length === 2 && ready() === 2,
        'the switch and the second generation',
        BOOT_MS,
        diagnose,
      )
      expect(switches[1]).toEqual({
        requestId: keep,
        sessions: 'keep',
        recovered: false,
        via: 'switch',
      })
      expect(spawned).toHaveLength(1)
      await waitUntil(
        () => !alive(spawned[0]),
        'the old child to exit',
        10_000,
        diagnose,
      )
      expect(providerNode.hasPendingProviderConfig()).toBe(false)
      expect(providerNode.readProviderState().applied?.requestId).toBe(keep)
      const generation = JSON.parse(
        readFileSync(
          join(node.config, 'qianmo', 'provider', 'generation.json'),
          'utf8',
        ),
      ) as { generation: number; loadedHash: string }
      expect(generation.generation).toBe(2)
      expect(generation.loadedHash).toBe(providerNode.currentManagedHash())
      expect(alerts).toEqual([])
      expect(errors.map(String)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'keep: the next delivery resumes the same session, and runs on the new profile’s model',
    async () => {
      const third = task('HS-THREE')
      await client.sendAndWait(third)
      expect(await resultOf(third)).toMatchObject({ outcome: 'completed' })

      expect(storedSessionId()).toBe(sessionAfterFirstTurn)
      const [turn] = modelA.turnsWith('HS-THREE')
      // The resumed session carries its history, including the answer to the
      // turn the switch waited for — the child was retired right after it…
      expect(turn?.text).toContain('HS-ONE')
      expect(turn?.text).toContain('HS-TWO')
      expect(turn?.text.split('reply-from-a').length).toBe(3)
      // …and is not pinned to the model it was created on: the child resolves
      // the main-loop model afresh when it resumes (§2.7).
      expect(turn?.model).toBe('hs-model-b')
      expect(turn?.authorization).toBe(`Bearer ${KEY_B}`)
      expect(
        modelA
          .turnsWith('HS-THREE')
          .filter(call => call.model !== 'hs-model-b'),
      ).toEqual([])
      expect(processEnvModel.turns()).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'reset: an idle node commits on the next poll, and the next delivery opens a new session',
    async () => {
      const turnsOnA = modelA.turns().length
      const reset = stage(
        chatProfile({
          baseUrl: modelB.baseUrl,
          model: 'hs-model-c',
          key: KEY_C,
          revision: 3,
        }),
        'reset',
      )
      await waitUntil(
        () => switches.length === 3 && ready() === 3,
        'the reset switch and the third generation',
        BOOT_MS,
        diagnose,
      )
      expect(switches[2]).toEqual({
        requestId: reset,
        sessions: 'reset',
        recovered: false,
        via: 'switch',
      })
      expect(spawned).toHaveLength(2)
      expect(alive(spawned[1])).toBe(false)

      const fourth = task('HS-FOUR')
      await client.sendAndWait(fourth)
      expect(await resultOf(fourth)).toMatchObject({
        outcome: 'completed',
        content: expect.stringContaining('reply-from-b'),
      })
      expect(spawned).toHaveLength(3)
      expect(spawned[2]?.pid).not.toBe(spawned[1]?.pid)
      expect(storedSessionId()).not.toBe(sessionAfterFirstTurn)
      const [turn] = modelB.turnsWith('HS-FOUR')
      expect(turn?.model).toBe('hs-model-c')
      expect(turn?.authorization).toBe(`Bearer ${KEY_C}`)
      // A new session: none of the old conversation came with it.
      expect(turn?.text).not.toContain('HS-ONE')
      expect(turn?.text).not.toContain('HS-THREE')
      expect(modelA.turns()).toHaveLength(turnsOnA)
      expect(processEnvModel.turns()).toEqual([])
      expect(alerts).toEqual([])
      expect(errors.map(String)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})

test('manual pins survive default changes, clear with model auto, and refuse a retired model', async () => {
  const node = setUpRoot('ResidentRuntime-pin-')
  const model = new ModelDouble('pinned')
  const { ResidentOmpPool } = await import('../../src/host/residentOmp.js')
  const { OmpResidentTurnPort } = await import('@qianmo/resident')
  const makePool = () =>
    new ResidentOmpPool({
      agents: [{ agent: AGENT, cwd: node.workspace }],
      memoryRoot: node.memory,
      announce: async () => ({ status: 'queued' }),
    })
  const pools: InstanceType<typeof ResidentOmpPool>[] = []
  try {
    stage(
      chatProfile({
        baseUrl: model.baseUrl,
        model: 'hs-model-d',
        key: KEY_D,
        revision: 1,
      }),
      'keep',
    )
    expect((await providerNode.commitPendingProviderConfig()).status).toBe(
      'committed',
    )
    const first = makePool()
    pools.push(first)
    const sessionId = await first.newSession({
      agent: AGENT,
      cwd: node.workspace,
    })
    const channel = await first.channelFor(sessionId)
    await channel.request('set_model', providerNode.nodeModelSelection()!)
    const one = await new OmpResidentTurnPort(first).execute(
      { sessionId, messageId: 'pin-one', prompt: 'Marker HSM-ONE' },
      async () => {},
    )
    expect(one.outcome).toBe('completed')
    await first.stop()
    const changed = chatProfile({
      baseUrl: model.baseUrl,
      model: 'hs-model-e',
      key: KEY_D,
      revision: 2,
    })
    // The default changed, but the manually chosen model remains available.
    // Removing it is a separate provider retirement, not permission to erase
    // the session's choice by changing the default.
    changed.models = [
      ...(changed.models as readonly Record<string, unknown>[]),
      {
        id: 'hs-model-d',
        role: 'extra',
        tiers: [],
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
      },
    ]
    stage(changed, 'keep')
    expect((await providerNode.commitPendingProviderConfig()).status).toBe(
      'committed',
    )
    const next = makePool()
    pools.push(next)
    const two = await new OmpResidentTurnPort(next).execute(
      { sessionId, messageId: 'pin-two', prompt: 'Marker HSM-TWO' },
      async () => {},
    )
    expect(two.outcome).toBe('completed')
    const [turn] = model.turnsWith('HSM-TWO')
    expect(turn?.text).toContain('HSM-ONE')
    expect(turn?.model).toBe('hs-model-d')
    await (await next.channelFor(sessionId)).prompt({
      messageId: 'pin-auto',
      text: '/model auto',
    })
    await next.stop()
    const automatic = makePool()
    pools.push(automatic)
    const three = await new OmpResidentTurnPort(automatic).execute(
      { sessionId, messageId: 'pin-three', prompt: 'Marker HSM-THREE' },
      async () => {},
    )
    expect(three.outcome).toBe('completed')
    const [automaticTurn] = model.turnsWith('HSM-THREE')
    expect(automaticTurn?.model).toBe('hs-model-e')
    expect(automaticTurn?.text).toContain('HSM-ONE')
    expect(automaticTurn?.text).toContain('HSM-TWO')
    await (await automatic.channelFor(sessionId)).request('set_model', {
      provider: providerNode.nodeModelSelection()!.provider,
      modelId: 'hs-model-d',
    })
    await automatic.stop()
    stage(
      chatProfile({
        baseUrl: model.baseUrl,
        model: 'hs-model-e',
        key: KEY_D,
        revision: 3,
      }),
      'keep',
    )
    expect((await providerNode.commitPendingProviderConfig()).status).toBe(
      'committed',
    )
    const retired = makePool()
    pools.push(retired)
    // Keep the old repro (the pin disappears from the provider directory),
    // but enforce the new contract: surface unavailability, never switch it
    // to a different model without the user's explicit clearance. omp
    // v18.14 words it `Model "<id>" not found. Did you mean …?` and, like
    // before, starts nothing.
    await expect(retired.channelFor(sessionId)).rejects.toThrow(
      /Model "[^"]*" not found/,
    )
  } finally {
    await Promise.all(pools.map(pool => pool.stop()))
    await model.stop()
    node.restore()
  }
}, 30_000)
