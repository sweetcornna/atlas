// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A real `--acp` child, driven the way a resident node drives it, against a
 * scripted model double. For `qianmo-resident-permission-bypass.test.ts`.
 *
 * ## What is real
 *
 * The ACP child is `src/entrypoints/cli.tsx --acp` from source, with the
 * shipped defines and feature list, started with the environment
 * `residentAcpEnvironment()` builds for production. It is initialized and handed
 * sessions with the same `_meta` that `ResidentAcpConnection`
 * (`packages/resident/src/acp-client.ts`) sends. Tools, the permission
 * pipeline, hooks, agent and skill loading are all the real ones. No
 * `mock.module`.
 *
 * ## What is not
 *
 * The model. A loopback `Bun.serve` speaks just enough streaming Chat
 * Completions to emit a fixed list of tool calls per scenario, and records the
 * tool result it gets back for each. It proves nothing about what a real model
 * would choose; it proves what the node lets happen once a model has chosen.
 *
 * The host is scripted rather than `ResidentAcpConnection` itself: that class
 * answers every permission request `cancelled` and has no observer, and the
 * properties under test need a host that can *approve* one request and see
 * whether a second one arrived.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import {
  getMacroDefines,
  resolveBuildFeatures,
} from '../../../scripts/defines.js'
import { residentAcpEnvironment } from '../../../src/services/qianmo/residentAcpEnv.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../../..')
const CLI_ENTRYPOINT = join(PROJECT_ROOT, 'src/entrypoints/cli.tsx')

/** Marker a sub-agent prompt carries so the double can tell the two apart. */
export const SUBAGENT_MARKER = 'RESIDENT-PERMISSION-SUBAGENT'

/** One scripted tool call. */
export interface ScriptedCall {
  readonly name: string
  readonly input: Record<string, unknown>
}

/** Which requests the scripted host approves; everything else is cancelled. */
export type HostPolicy = (request: RequestPermissionRequest) => boolean

/** A permission request as the host saw it. */
export interface HostRequest {
  readonly title: string
  readonly kind: string
  readonly rawInput: string
  readonly answered: 'allow' | 'cancelled'
}

/** What one scenario run produced. */
export interface ScenarioResult {
  /** Permission requests the host received, in order. */
  readonly hostRequests: HostRequest[]
  /** Text of each tool result the main turn's model double received. */
  readonly toolResults: string[]
  /** Text of each tool result a sub-agent's model double received. */
  readonly subToolResults: string[]
}

export interface Scenario {
  readonly id: string
  readonly mode: 'dontAsk' | 'acceptEdits' | 'default'
  readonly cwd: string
  readonly steps: readonly ScriptedCall[]
  /** Served to a sub-agent turn (recognised by {@link SUBAGENT_MARKER}). */
  readonly subSteps?: readonly ScriptedCall[]
  /** Defaults to deny-all. */
  readonly hostPolicy?: HostPolicy
  /** Extra time to let an async sub-agent finish after the turn ends. */
  readonly settleMs?: number
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

let frameCounter = 0
function frame(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'resident-permission-double',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'resident-permission-double',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}
function sse(body: string): Response {
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}
function toolReply(call: ScriptedCall): Response {
  frameCounter += 1
  return sse(
    frame(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call_resident_${frameCounter}`,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input),
            },
          },
        ],
      },
      null,
    ) + frame({}, 'tool_calls'),
  )
}
function textReply(text: string): Response {
  return sse(
    frame({ role: 'assistant', content: text }, null) + frame({}, 'stop'),
  )
}

/**
 * One resident node under a scripted model, plus a scripted host.
 *
 * `start()` boots the child and the model; `run(scenario)` drives one turn and
 * hands back what the host and both model turns saw; `stop()` tears it all down.
 */
export class ResidentAcpHarness {
  #child: ChildProcess | undefined
  #model: ReturnType<typeof Bun.serve> | undefined
  #conn: ClientSideConnection | undefined
  #scenarios = new Map<string, Scenario>()
  #mainResults = new Map<string, string[]>()
  #subResults = new Map<string, string[]>()
  #hostRequests = new Map<string, HostRequest[]>()
  #current = ''
  readonly #stderrPath: string
  readonly #safeMode: boolean

  /**
   * @param safeMode when `false`, the shipped `CLAUDE_CODE_SAFE_MODE` is removed
   * from the child env. The four bypasses must still be closed by the tool-face,
   * hardline and `canUseTool` ceiling alone — this is the regression guard for
   * `residentGuard.ts` that would not notice if safe mode did all the work.
   */
  constructor(
    private readonly configDir: string,
    options: { safeMode?: boolean } = {},
  ) {
    this.#stderrPath = join(configDir, 'acp-child.stderr')
    this.#safeMode = options.safeMode ?? true
  }

  get stderrPath(): string {
    return this.#stderrPath
  }

  #serve(): void {
    this.#model = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async req => {
        let body: { messages?: unknown; tools?: unknown; stream?: unknown } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          // A non-JSON body is not a model turn; answer the trivial shape.
        }
        if (body.stream !== true) {
          return Response.json({
            id: 'd',
            object: 'chat.completion',
            created: 1,
            model: 'd',
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
        const messages = Array.isArray(body.messages) ? body.messages : []
        const all = messages.map(m => textOf(m.content)).join('\n')
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0
        if (!hasTools) return textReply('ok')

        const last = messages.at(-1)
        const priorToolResults = messages.filter(m => m.role === 'tool')

        // A sub-agent turn: its prompt carries the marker, and its steps live on
        // the scenario named after the marker suffix `SUB:<id>`.
        const subMatch = /SUB:([\w-]+)/.exec(all)
        if (all.includes(SUBAGENT_MARKER) && subMatch) {
          const scenario = this.#scenarios.get(subMatch[1] as string)
          const subSteps = scenario?.subSteps ?? []
          if (last?.role === 'tool') {
            this.#push(this.#subResults, subMatch[1] as string, last.content)
          }
          const i = priorToolResults.length
          return i < subSteps.length
            ? toolReply(subSteps[i] as ScriptedCall)
            : textReply('sub done')
        }

        const scnMatch = /SCN:([\w-]+)/.exec(all)
        const scenario = scnMatch
          ? this.#scenarios.get(scnMatch[1] as string)
          : undefined
        if (!scenario) return textReply('no scenario')
        if (last?.role === 'tool') {
          this.#push(this.#mainResults, scenario.id, last.content)
        }
        const i = priorToolResults.length
        return i < scenario.steps.length
          ? toolReply(scenario.steps[i] as ScriptedCall)
          : textReply(`done ${scenario.id}`)
      },
    })
  }

  #push(map: Map<string, string[]>, id: string, content: unknown): void {
    const list = map.get(id) ?? []
    list.push(textOf(content).slice(0, 400))
    map.set(id, list)
  }

  #childEnv(): NodeJS.ProcessEnv {
    const parent: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) parent[k] = v
    }
    for (const k of INHERITED_KEYS_TO_DROP) delete parent[k]
    const modelPort = this.#model?.port
    const env = residentAcpEnvironment({
      ...parent,
      NODE_ENV: 'production',
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: this.configDir,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'sk-resident-permission-double',
      OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      OPENAI_MODEL: 'resident-permission-double',
      OPENAI_WIRE_API: 'chat',
      NO_COLOR: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
    })
    // The ceiling-only describe needs the child WITHOUT safe mode, so the hook,
    // agent and skill actually load and the tool-face/hardline/canUseTool
    // guards are the only thing standing between them and an escalation.
    if (!this.#safeMode) delete env.CLAUDE_CODE_SAFE_MODE
    return env
  }

  async start(): Promise<void> {
    this.#serve()
    const defines = {
      ...getMacroDefines(),
      'process.env.NODE_ENV': JSON.stringify('production'),
    }
    const args = [
      'run',
      ...Object.entries(defines).flatMap(([k, v]) => [
        '-d',
        `${k}:${String(v)}`,
      ]),
      ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
      CLI_ENTRYPOINT,
      '--acp',
    ]
    const stderr = Bun.file(this.#stderrPath).writer()
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: this.#childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr?.on('data', chunk => stderr.write(chunk))
    this.#child = child

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin as NonNullable<typeof child.stdin>) as never,
      Readable.toWeb(child.stdout as NonNullable<typeof child.stdout>) as never,
    )
    const harness = this
    const client = {
      async requestPermission(params: RequestPermissionRequest) {
        const policy = harness.#scenarios.get(harness.#current)?.hostPolicy
        const approve =
          policy?.(params) === true &&
          params.options.some(o => o.optionId === 'allow')
        harness.#record(params, approve ? 'allow' : 'cancelled')
        return approve
          ? { outcome: { outcome: 'selected' as const, optionId: 'allow' } }
          : { outcome: { outcome: 'cancelled' as const } }
      },
      async sessionUpdate() {},
      async extNotification() {},
      async extMethod(method: string) {
        // The notify tool reaches the host through this; answer "sent" so the
        // positive control for qianmo_notify sees the request arrive.
        return method === 'qianmo/notify'
          ? { status: 'sent' }
          : { ok: true, method }
      },
    }
    const conn = new ClientSideConnection(() => client, stream)
    this.#conn = conn
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'qianmo-resident', version: '0' },
      _meta: { qianmo: { resident: true } },
    })
  }

  #record(params: RequestPermissionRequest, answered: 'allow' | 'cancelled') {
    const call = (params as { toolCall?: Record<string, unknown> }).toolCall
    const list = this.#hostRequests.get(this.#current) ?? []
    list.push({
      title: String(call?.title ?? ''),
      kind: String(call?.kind ?? ''),
      rawInput: JSON.stringify(call?.rawInput ?? {}),
      answered,
    })
    this.#hostRequests.set(this.#current, list)
  }

  async run(scenario: Scenario): Promise<ScenarioResult> {
    if (!this.#conn) throw new Error('harness not started')
    this.#scenarios.set(scenario.id, scenario)
    this.#current = scenario.id
    const session = await this.#conn.newSession({
      cwd: scenario.cwd,
      mcpServers: [],
      _meta: {
        permissionMode: scenario.mode,
        qianmo: { resident: true, agent: 'main' },
      },
    })
    await Promise.race([
      this.#conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `SCN:${scenario.id}` }],
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`scenario ${scenario.id} timed out`)),
          60_000,
        ),
      ),
    ])
    if (scenario.settleMs) {
      await new Promise(r => setTimeout(r, scenario.settleMs))
    }
    return {
      hostRequests: this.#hostRequests.get(scenario.id) ?? [],
      toolResults: this.#mainResults.get(scenario.id) ?? [],
      subToolResults: this.#subResults.get(scenario.id) ?? [],
    }
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
    await this.#model?.stop(true)
  }
}

/** Credentials and endpoints a developer's shell must not leak into the child. */
const INHERITED_KEYS_TO_DROP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
  'CI',
  'GEMINI_API_KEY',
  'GROK_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
]
