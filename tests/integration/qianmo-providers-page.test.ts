// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务页 end to end (P18.9, `providers-console-m1.md` §9.2: AC-P1, AC-P3,
 * export, import).
 *
 * ## What is real
 *
 * - The console: `createConsoleHandler` with personal accounts, an `ops`
 *   person on a session cookie, the real `ActionLedger`, and the area's
 *   routes — every step goes through the URLs the page script calls.
 * - The hub: `openConsoleProviders`, its ledger, sealed secret store and local
 *   executor.
 * - The node: the executor's command runs the real `qm provider serve-stdin`
 *   from source on a temporary 0700 config root, the way
 *   `consoleProvidersServeStdin.test.ts` does.
 * - The resident: an in-process {@link QianmoResident} on that root, with the
 *   real `--acp` child from source; its lifecycle file is what tells
 *   `qm provider` a resident is running, so an apply is staged and the
 *   resident commits it at idle and recycles its child (P18.3).
 *
 * ## What is not
 *
 * The models: loopback Chat Completions doubles that record the model id and
 * the `Authorization` header of every request. The key is a
 * `sk-test-canary-…` string; nothing leaves the machine. The child's process
 * environment names a model too (the fleet's way), pointed at a double that
 * must never see a turn after the switch.
 *
 * ## The cases, in order (each builds on the one before)
 *
 * 1. AC-P1: the node refreshed from its matrix row; a profile made from the
 *    custom OpenAI preset through `POST /v0/providers/profiles`, assigned,
 *    applied; the node stages it, the resident switches, the next turn
 *    reaches the new model with the new key, and the matrix and the chat
 *    label show the model the node reports. On the way, the editor offers
 *    总是发送 on the OpenAI Chat line exactly when the real node reported it
 *    can send it (`capabilities.chatEffortHonorsOverride`, follow-up 4).
 * 2. AC-P3: a managed key edited on the node shows as 本地改动 on the next
 *    refresh, and an apply without 覆盖 is refused `conflict`.
 * 3. The export has neither the key nor a fingerprint.
 * 4. An import with a key the catalog does not know is refused whole.
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
import { ActionLedger } from '@qianmo/console'
import {
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { ResidentTimingEvent } from '@qianmo/resident'
import { TransportClient } from '@qianmo/transport'
import {
  ManualClock,
  accountsHarness,
  asSession,
  person,
  type Person,
} from '../../packages/console/test/accountsHarness.js'
import { MemoryActionStore } from '../../packages/console/test/actionStore.js'
import { macroDefineArgs, resolveBuildFeatures } from '../../scripts/defines.js'
import {
  type ConsoleProviders,
  openConsoleProviders,
  type ProviderScheduler,
} from '../../src/cli/handlers/consoleProviders.js'
import {
  childEnv,
  sourceLaunch,
} from '../../src/cli/handlers/__tests__/providerSource.js'
import * as providerNode from '../../src/services/qianmo/providers/node.js'
import {
  QianmoResident,
  type ResidentProviderSwitchEvent,
} from '../../src/services/qianmo/resident.js'
import { getModelCompatCapabilities } from '../../src/services/qianmo/modelCompat/capabilities.js'
import { residentAcpEnvironment } from '../../src/services/qianmo/residentAcpEnv.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'

const NODE = 'node-b'
const TARGET = `qianmo://${NODE}/reviewer`
const PSK = 'providers-page-integration-not-a-secret'
const CANARY = 'sk-test-canary-providers-page-Vb7Qm2Lx'
const KEY_PROCESS = 'sk-test-canary-process-env-page-4Hd9'
const CLI_ENTRYPOINT = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'entrypoints',
  'cli.tsx',
)
/** A cold boot of the entrypoint from source on a loaded machine. */
const BOOT_MS = 120_000
/** One model turn against a loopback double, with its result reply. */
const TURN_MS = 90_000
const STEP_MS = 300_000

const STILL: ProviderScheduler = { set: () => null, clear: () => {} }

/** The page's clock is the wall clock: the chat label compares it with the node's. */
class WallClock extends ManualClock {
  override now = (): number => Date.now()
}

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs: number,
  diagnose: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `timed out waiting for ${what} (${timeoutMs}ms)\n${diagnose()}`,
  )
}

interface ModelCall {
  readonly model: string
  readonly authorization: string
  readonly text: string
  readonly turn: boolean
}

/** A loopback Chat Completions endpoint that records what it was asked. */
class ModelDouble {
  readonly calls: ModelCall[] = []
  readonly #server: ReturnType<typeof Bun.serve>

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

  turns(): ModelCall[] {
    return this.calls.filter(call => call.turn)
  }

  async stop(): Promise<void> {
    await this.#server.stop(true)
  }

  async #answer(request: Request): Promise<Response> {
    let body: {
      model?: unknown
      messages?: unknown
      tools?: unknown
      stream?: unknown
    } = {}
    try {
      body = (await request.json()) as typeof body
    } catch {
      // Not a model call (a model list, a probe): the trivial answer below.
    }
    const messages = Array.isArray(body.messages)
      ? (body.messages as { content?: unknown }[])
      : []
    const text = messages
      .map(message =>
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? ''),
      )
      .join('\n')
    this.calls.push({
      model: typeof body.model === 'string' ? body.model : '',
      authorization: request.headers.get('authorization') ?? '',
      text,
      turn:
        body.stream === true &&
        Array.isArray(body.tools) &&
        body.tools.length > 0,
    })
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
        data: [{ id: 'stub-model-b' }],
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
      `${frame({ role: 'assistant', content: `reply-from-${this.name}` }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
}

let root: string
let config: string
let workspace: string
let previousConfig: string | undefined
let processModel: ModelDouble
let modelB: ModelDouble
let port: ConsoleProviders
let ledger: ActionLedger
let handle: (request: Request) => Promise<Response>
let ops: Person
let resident: QianmoResident
let running: Promise<void>
let client: TransportClient
let skew = 0
const replies: QianmoMessage[] = []
const spawned: ChildProcess[] = []
const switches: ResidentProviderSwitchEvent[] = []
const timings: ResidentTimingEvent[] = []
const errors: unknown[] = []
const childLog = { text: '' }

const ready = () => timings.filter(event => event.stage === 'acp_ready').length
const diagnose = () =>
  [
    `spawned=${spawned.length} ready=${ready()}`,
    `switches=${JSON.stringify(switches)}`,
    `errors=${errors.map(String).join(' | ')}`,
    `child stderr (tail):\n${childLog.text.slice(-4_000)}`,
  ].join('\n')

/** The hub's clock moves past its 5 s status throttle instead of sleeping. */
function later(): void {
  skew += 10_000
}

/** The command the local executor runs as `<command> <node>`: `qm provider serve-stdin`. */
function writeNodeCommand(): string {
  const launch = sourceLaunch(
    ['provider', 'serve-stdin', '--node'],
    childEnv({ OCC_IDENTITY: 'qianmo', OCC_CONFIG_DIR: config, HOME: root }),
  )
  writeFileSync(
    join(root, 'launch.json'),
    JSON.stringify({
      execPath: launch.execPath,
      args: launch.args,
      env: launch.env,
    }),
  )
  writeFileSync(
    join(root, 'launch.mjs'),
    `import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const spec = JSON.parse(readFileSync(${JSON.stringify(join(root, 'launch.json'))}, 'utf8'))
const run = spawnSync(spec.execPath, [...spec.args, process.argv[2]], { stdio: 'inherit', env: spec.env, cwd: ${JSON.stringify(root)} })
process.exit(run.status ?? 2)
`,
  )
  const command = join(root, 'node.sh')
  writeFileSync(
    command,
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'launch.mjs')}' "$@"\n`,
  )
  chmodSync(command, 0o755)
  return command
}

/** The real `--acp` child, as `residentProviderSwitch.integration.test.ts` starts it. */
function spawnRealAcp(): ChildProcess {
  const env = residentAcpEnvironment(
    {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      TMPDIR: tmpdir(),
      NODE_ENV: 'production',
      NO_COLOR: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: config,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: processModel.baseUrl,
      OPENAI_API_KEY: KEY_PROCESS,
      OPENAI_MODEL: 'process-env-model',
      OPENAI_WIRE_API: 'chat',
    },
    { memoryRoot: join(root, 'memory') },
  )
  const child = spawn(
    process.execPath,
    [
      'run',
      ...macroDefineArgs(),
      '-d',
      `process.env.NODE_ENV:${JSON.stringify('production')}`,
      ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
      CLI_ENTRYPOINT,
      '--acp',
    ],
    { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stderr?.on('data', chunk => {
    childLog.text = `${childLog.text}${String(chunk)}`.slice(-20_000)
  })
  return child
}

/** A script's request, as the ops person. */
function call(method: string, path: string, body?: unknown): Request {
  return asSession(method, path, ops.sid, body === undefined ? {} : { body })
}

async function ok<T>(request: Request): Promise<T> {
  const response = await handle(request)
  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(
      `${request.method} ${request.url} ${response.status} ${text}`,
    )
  }
  return (response.headers.get('content-type') ?? '').includes('json')
    ? (JSON.parse(text) as T)
    : (text as T)
}

/** `[action, outcome, code]` of the ledger's `provider.` lines, oldest first. */
async function recorded(): Promise<string[]> {
  const page = await ledger.list({ actionPrefix: 'provider.', limit: 100 })
  if (!page.ok) throw new Error(page.failure.message)
  return [...page.value.entries]
    .reverse()
    .map(entry =>
      [entry.action, entry.outcome, entry.code ?? ''].join(' ').trim(),
    )
}

function settingsFile(): Record<string, unknown> & {
  env?: Record<string, string>
} {
  return JSON.parse(
    readFileSync(join(config, 'settings.json'), 'utf8'),
  ) as Record<string, unknown> & { env?: Record<string, string> }
}

function rowOf(html: string): string {
  const match = new RegExp(
    `<details class="row prov-row" data-key="node:${NODE}"[\\s\\S]*?</details>`,
  ).exec(html)
  if (match === null) throw new Error(`no row for ${NODE}`)
  return match[0]
}

function modelCell(row: string): string {
  return /data-cell="model"[^>]*>([^<]*)</.exec(row)?.[1]?.trim() ?? ''
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qm-providers-page-')))
  config = join(root, 'config')
  workspace = join(root, 'ws')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  mkdirSync(workspace)
  mkdirSync(join(root, 'home'))
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  // The in-process resident reads and writes this root, as `qm resident`
  // would on the node.
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()

  processModel = new ModelDouble('process-env')
  modelB = new ModelDouble('b')

  port = openConsoleProviders({
    storePath: join(root, 'hub', 'providers.ndjson'),
    secretsPath: join(root, 'hub', 'provider-secrets.json'),
    keyPath: join(root, 'hub-keys', 'provider-master.key'),
    knownHostsFile: join(root, 'hub-keys', 'known_hosts'),
    nodes: [{ node: NODE, kind: 'local', command: writeNodeCommand() }],
    onAlarm: () => {},
    now: () => Date.now() + skew,
    scheduler: STILL,
  })
  ledger = new ActionLedger({ store: new MemoryActionStore() })
  const h = accountsHarness({
    clock: new WallClock(),
    deps: { actions: ledger, providers: port },
  })
  handle = h.handle
  ops = await person(handle, 'ops')

  resident = new QianmoResident({
    node: NODE,
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: workspace }],
    pollIntervalMs: 20,
    psk: PSK,
    listen: { unix: join(root, 'r.sock') },
    memoryRoot: join(root, 'memory'),
    spawnAcp: () => {
      const child = spawnRealAcp()
      spawned.push(child)
      return child
    },
    providerNode,
    providerSwitch: { pollIntervalMs: 100 },
    onProviderAlert: () => {},
    onProviderSwitched: event => switches.push(event),
    onError: error => errors.push(error),
    onTiming: event => timings.push(event),
  })
  running = resident.run()
  await waitUntil(
    () => ready() === 1,
    'the first ACP generation',
    BOOT_MS,
    diagnose,
  )
  client = new TransportClient({
    endpoint: { unix: join(root, 'r.sock') },
    node: 'node-a',
    psk: PSK,
    backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  await client.connect()
}, BOOT_MS + 60_000)

afterAll(async () => {
  resident?.stop()
  await running
  await client?.close()
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  port?.stop()
  await Promise.all([processModel?.stop(), modelB?.stop()])
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  resetSettingsCache()
  rmSync(root, { recursive: true, force: true })
}, 60_000)

describe('模型服务页 against the real hub, node and resident', () => {
  test(
    'AC-P1: made on the page, assigned, applied — the resident switches and the page shows the node’s model',
    async () => {
      // The matrix row's 刷新: the hub asks the node for its state.
      const first = await ok<{
        node: {
          lastStatus: { ok: boolean } | null
          actual: { capabilities: { chatEffortHonorsOverride: boolean } } | null
        }
      }>(call('POST', `/v0/providers/nodes/${NODE}/refresh`))
      expect(first.node.lastStatus?.ok).toBe(true)
      // What the node said is the call layer's own value (P18.12), not a copy.
      const honours = getModelCompatCapabilities().chatEffortHonorsOverride
      expect(first.node.actual?.capabilities.chatEffortHonorsOverride).toBe(
        honours,
      )

      // Made from the custom OpenAI preset, with nothing but what the form edits.
      const created = await ok<{ profile: { id: string; revision: number } }>(
        call('POST', '/v0/providers/profiles', {
          presetId: 'custom-openai',
          profile: {
            id: 'stub-chat',
            name: '录制桩',
            lane: 'openai-chat',
            baseUrl: modelB.baseUrl,
            auth: { scheme: 'bearer' },
            models: [
              {
                id: 'stub-model-b',
                role: 'main',
                tiers: ['opus', 'sonnet', 'haiku', 'fable'],
                capabilities: { mode: 'family' },
                effort: { send: 'auto' },
              },
            ],
          },
          secrets: { k1: CANARY },
        }),
      )
      expect(created.profile).toMatchObject({ id: 'stub-chat', revision: 1 })
      // Follow-up 4: 总是发送 on this OpenAI Chat profile is on offer exactly
      // when the node reported it can be sent. With P18.12 merged it can.
      expect(honours).toBe(true)
      const editor = await ok<string>(
        asSession('GET', '/providers/profiles/stub-chat', ops.sid, {
          header: false,
        }),
      )
      expect(editor).toContain(`data-chat-always="${honours ? '1' : '0'}"`)
      expect(editor).toMatch(
        /<option value="always" data-chat-gate data-explicit>/,
      )
      expect(editor).not.toContain('发不了显式 effort')
      await ok(
        call('PUT', `/v0/providers/nodes/${NODE}/assignment`, {
          mode: 'profile',
          profileId: 'stub-chat',
        }),
      )
      const applied = await ok<{
        results: {
          node: string
          outcome: string
          pending?: boolean
          code?: string
        }[]
      }>(call('POST', '/v0/providers/apply', { nodes: [NODE] }))
      expect(applied.results.map(r => [r.node, r.outcome, r.pending])).toEqual([
        [NODE, 'ok', true],
      ])

      // The resident commits at idle and starts a new child on it.
      await waitUntil(
        () => switches.length === 1 && ready() === 2,
        'the switch and the second generation',
        BOOT_MS,
        diagnose,
      )
      expect(switches[0]?.via).toBe('switch')
      expect(providerNode.hasPendingProviderConfig()).toBe(false)

      const request = createMessage({
        from: 'qianmo://node-a/planner',
        to: TARGET,
        type: MessageType.TaskRequest,
        payload: { instruction: 'Reply briefly. Marker PAGE-ONE.' },
      })
      await client.sendAndWait(request)
      await waitUntil(
        () =>
          replies.some(
            reply =>
              reply.type === MessageType.TaskResult &&
              reply.taskId === request.taskId,
          ),
        'the reply to the first turn',
        TURN_MS,
        diagnose,
      )
      const [turn] = modelB.turns()
      expect(turn?.model).toBe('stub-model-b')
      expect(turn?.authorization).toBe(`Bearer ${CANARY}`)
      expect(processModel.turns()).toEqual([])

      // The node's own answer, as the page reads it.
      later()
      const refreshed = await ok<{
        node: {
          actual: {
            applied: { profileId: string } | null
            pending: unknown
            effective?: { model: string; wire: string }
          }
        }
      }>(call('POST', `/v0/providers/nodes/${NODE}/refresh`))
      expect(refreshed.node.actual.applied?.profileId).toBe('stub-chat')
      expect(refreshed.node.actual.pending).toBeNull()
      expect(refreshed.node.actual.effective?.model).toBe('stub-model-b')
      expect(refreshed.node.actual.effective?.wire).toBe('chat')

      const board = await ok<string>(call('GET', '/fragments/providers/board'))
      expect(modelCell(rowOf(board))).toBe('stub-model-b')
      expect(rowOf(board)).toContain('OpenAI Chat')
      const label = await ok<string>(
        call(
          'GET',
          `/fragments/providers/chat?target=${encodeURIComponent(TARGET)}`,
        ),
      )
      expect(label).toContain('模型 · stub-model-b')
      expect(label).toContain('已切换到 录制桩 · stub-model-b')

      expect(await recorded()).toEqual([
        'provider.save ok',
        'provider.secret.set ok',
        'provider.assign ok',
        'provider.apply ok',
      ])
      // The key reached the model and nothing the page or the ledger shows.
      const page = await ok<string>(
        asSession('GET', '/providers/profiles/stub-chat', ops.sid, {
          header: false,
        }),
      )
      expect(page).not.toContain(CANARY)
      expect(board).not.toContain(CANARY)
      const lines = await ledger.list({ limit: 100 })
      expect(JSON.stringify(lines)).not.toContain(CANARY)
    },
    STEP_MS,
  )

  test(
    'AC-P3: a key edited on the node is 本地改动 on the next refresh, and an apply without 覆盖 is refused conflict',
    async () => {
      const before = settingsFile()
      writeFileSync(
        join(config, 'settings.json'),
        JSON.stringify({
          ...before,
          env: {
            ...before.env,
            OPENAI_BASE_URL: 'https://elsewhere.example/v1',
          },
        }),
        { mode: 0o600 },
      )
      later()
      await ok(call('POST', `/v0/providers/nodes/${NODE}/refresh`))
      const view = await ok<{ drift: { kind: string; keys?: string[] }[] }>(
        call('GET', `/v0/providers/nodes/${NODE}`),
      )
      expect(view.drift.map(drift => drift.kind)).toContain('local-edit')
      const board = await ok<string>(call('GET', '/fragments/providers/board'))
      expect(rowOf(board)).toContain('本地改动')
      expect(rowOf(board)).toContain('data-action="prov-force"')

      const applied = await ok<{
        results: {
          node: string
          outcome: string
          code?: string
          diffKeys?: string[]
        }[]
      }>(call('POST', '/v0/providers/apply', { nodes: [NODE] }))
      expect(applied.results.map(r => [r.outcome, r.code])).toEqual([
        ['refused', 'conflict'],
      ])
      // The node names it `env.OPENAI_BASE_URL` on the wire; the hub shows
      // env keys bare (§2.5, `consoleProvidersNode.ts` `diffKeyNames`).
      expect(applied.results[0]?.diffKeys ?? []).toContain('OPENAI_BASE_URL')
      expect(settingsFile().env?.OPENAI_BASE_URL).toBe(
        'https://elsewhere.example/v1',
      )
      expect((await recorded()).at(-1)).toBe('provider.apply refused conflict')
    },
    STEP_MS,
  )

  test(
    'export: a file with the profile and neither its key nor a fingerprint',
    async () => {
      const response = await handle(
        asSession('GET', '/v0/providers/export', ops.sid, { header: false }),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition') ?? '').toContain(
        'attachment',
      )
      const text = await response.text()
      expect(text).toContain('"stub-chat"')
      expect(text).not.toContain(CANARY)
      expect(text).not.toContain('sk-test-canary')
      expect(text).not.toContain('fp1:')
      expect(text).not.toContain('fingerprint')
    },
    STEP_MS,
  )

  test(
    'import: a key the catalog does not know refuses the whole document',
    async () => {
      const exported = await (
        await handle(
          asSession('GET', '/v0/providers/export', ops.sid, { header: false }),
        )
      ).text()
      // The control: the same document, unchanged, previews.
      const preview = await ok<{ profiles: unknown[]; collisions: string[] }>(
        call('POST', '/v0/providers/import/preview', { text: exported }),
      )
      expect(preview.profiles).toHaveLength(1)
      expect(preview.collisions).toEqual(['stub-chat'])

      const doc = JSON.parse(exported) as {
        profiles: Record<string, unknown>[]
      }
      const first = doc.profiles[0]
      if (first === undefined) throw new Error('empty export')
      first.apiKey = 'sk-test-canary-import-should-not-land'
      const tampered = JSON.stringify(doc)
      for (const [path, body] of [
        ['/v0/providers/import/preview', { text: tampered }],
        [
          '/v0/providers/import',
          { text: tampered, renames: { 'stub-chat': 'stub-chat-2' } },
        ],
      ] as const) {
        const response = await handle(call('POST', path, body))
        expect(`${path} ${response.status}`).toBe(`${path} 400`)
        const error = (await response.json()) as {
          error: { code: string; message: string }
        }
        expect(error.error.code).toBe('invalid')
        expect(error.error.message).not.toContain('sk-test-canary')
      }
      const overview = await ok<{ profiles: { profile: { id: string } }[] }>(
        call('GET', '/v0/providers'),
      )
      expect(overview.profiles.map(entry => entry.profile.id)).toEqual([
        'stub-chat',
      ])
      expect(
        (await recorded()).filter(line => line.startsWith('provider.import')),
      ).toEqual(['provider.import refused invalid'])
    },
    STEP_MS,
  )
})
