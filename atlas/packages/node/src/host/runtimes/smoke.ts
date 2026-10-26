// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The compatibility check a new runtime version passes before a node
 * switches to it (P31 with P32, `runtimes-channels.md` §5, §9; P36
 * `harness-backends.md` §2).
 *
 * The candidate binary starts exactly as a resident child would — the same
 * arguments, the same environment rules, the real `qm runtime-mcp` bridge —
 * against a loopback stand-in for the model and a tool host with one tool:
 *
 * - Claude Code: its `init` lists the `qianmo` server as connected with the
 *   host's tools, and a turn completes in which the stand-in model calls the
 *   host tool, then the same tool on a server the rules leave open, which
 *   Claude Code must ask the host about (`qianmo_permission`) first;
 * - Codex: `app-server` starts with the node's overrides and lists the
 *   `qianmo` server with the host's tools;
 * - an ACP harness: it starts from its catalog launch (patch, environment,
 *   launch directory), takes `initialize` and `session/new` with the bridge,
 *   and runs one turn through the node's ACP channel against a stand-in for
 *   its first model lane, whose request must list the host's tool and whose
 *   call of it must reach the host.
 *
 * Nothing reaches a real model, and nothing of the user's own Claude Code or
 * Codex configuration is read: both get a scratch home under the qianmo root.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { qianmoConfigPath } from '@qianmo/paths'
import { AcpChannel } from '@qianmo/harness/acpClient.ts'
import { RUNTIME_MCP_SERVER } from '@qianmo/harness/claudeStream.ts'
import type { OmpRpcFrame } from '@qianmo/resident'
import { qmArgv } from '../../omp/launch.js'
import type { RuntimeLane } from './acpSpec.js'
import { acpVerdictCalls } from './acpTools.js'
import { type RuntimeSpec, runtimeSpec } from './catalog.js'
import type { ExternalRuntimeKind } from './channel.js'
import {
  CLAUDE_CODE_ENV,
  claudeCodeArgv,
  PERMISSION_TOOL,
  RUNTIME_MCP_TIMEOUT_MS,
} from './claudeCode.js'
import { CODEX_KEY_ENV, codexArgv } from './codex.js'
import { inheritedEnv } from './inheritedEnv.js'
import { freeLoopbackPort } from './runtimeEnv.js'
import { RuntimeToolHost } from './toolHost.js'

/** The host tool the check calls. */
export const SMOKE_TOOL = 'qianmo_smoke'
const SMOKE_MODEL = 'qianmo-smoke'
/** The same bridge again under a name no rule allows: every call is asked. */
const ASKED_SERVER = 'qianmo-check'
const DEFAULT_TIMEOUT_MS = 90_000

export interface RuntimeSmokeOptions {
  /** How the runtime starts `qm runtime-mcp`; tests point it elsewhere. */
  readonly mcpArgv?: (args: readonly string[]) => string[]
  /** Scratch space; removed afterwards. */
  readonly root?: string
  readonly timeoutMs?: number
}

/** `null` when `bin` works under the node's arguments, else why not. */
export async function runtimeSmoke(
  kind: ExternalRuntimeKind,
  bin: string,
  options: RuntimeSmokeOptions = {},
): Promise<string | null> {
  const root = options.root ?? qianmoConfigPath('runtimes', 'smoke')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const scratch = mkdtempSync(join(root, `${kind}-`))
  const calls: string[] = []
  const host = new RuntimeToolHost({
    list: () => [
      {
        name: PERMISSION_TOOL,
        description: 'Answers a permission request.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: SMOKE_TOOL,
        description: 'Answers ok. Call it when asked to.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    call: async (_session, name) => {
      calls.push(name)
      return name === PERMISSION_TOOL
        ? { ok: true, text: JSON.stringify({ behavior: 'allow' }) }
        : { ok: true, text: 'ok' }
    },
  })
  const model = fakeModel()
  try {
    await host.start()
    const tokenFile = join(scratch, 'runtime-mcp.token')
    writeFileSync(
      tokenFile,
      host.issue({ agent: 'smoke', sessionId: 'smoke' }),
      {
        mode: 0o600,
      },
    )
    const mcp = (options.mcpArgv ?? qmArgv)([
      'runtime-mcp',
      '--port',
      String(host.port),
      '--token-file',
      tokenFile,
    ])
    const workspace = join(scratch, 'workspace')
    const home = join(scratch, 'home')
    mkdirSync(workspace, { mode: 0o700 })
    mkdirSync(home, { mode: 0o700 })
    const spec = runtimeSpec(kind)
    const check =
      spec?.protocol === 'claude-stream'
        ? claudeSmoke
        : spec?.protocol === 'codex-app-server'
          ? codexSmoke
          : spec?.protocol === 'acp'
            ? (run: SmokeRun) => acpSmoke(run, spec)
            : undefined
    if (check === undefined) return `${kind} 不是可检查的外部底层`
    return await check({
      bin,
      mcp,
      scratch,
      workspace,
      home,
      baseUrl: `http://127.0.0.1:${model.port}`,
      calls,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    await model.stop()
    await host.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
}

interface SmokeRun {
  readonly bin: string
  readonly mcp: readonly string[]
  readonly scratch: string
  readonly workspace: string
  readonly home: string
  readonly baseUrl: string
  readonly calls: readonly string[]
  readonly timeoutMs: number
}

/**
 * A loopback stand-in for the Anthropic Messages API: a turn's first request
 * gets a call of the host tool, the second the same tool on the asked server,
 * the third "ok". Anything else (Codex never sends a turn here) gets an empty
 * answer.
 */
function fakeModel(): { port: number; stop: () => Promise<void> } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (!url.pathname.endsWith('/messages'))
        return Response.json({ input_tokens: 1, object: 'list', data: [] })
      const body = (await request.json().catch(() => ({}))) as {
        messages?: { content?: unknown }[]
      }
      const answered =
        JSON.stringify(body.messages ?? []).split('"tool_result"').length - 1
      const server = [RUNTIME_MCP_SERVER, ASKED_SERVER][answered]
      return messageStream(
        server === undefined
          ? { type: 'text', text: 'ok' }
          : {
              type: 'tool_use',
              id: `toolu_smoke_${answered}`,
              name: `mcp__${server}__${SMOKE_TOOL}`,
              input: {},
            },
      )
    },
  })
  return {
    port: server.port ?? 0,
    stop: async () => {
      await server.stop(true)
    },
  }
}

function messageStream(
  block:
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: object },
): Response {
  const start =
    block.type === 'text'
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: block.id, name: block.name, input: {} }
  const delta =
    block.type === 'text'
      ? { type: 'text_delta', text: block.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: SMOKE_MODEL,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: start },
    ],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: {
          stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use',
        },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  return new Response(
    events
      .map(
        ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

/**
 * Runs `bin` until `settle` returns a verdict, a timeout or an exit, and
 * answers once the process is gone (its scratch home is removed next).
 */
function converse(
  run: SmokeRun,
  argv: readonly string[],
  env: Record<string, string>,
  start: (write: (message: unknown) => void) => void,
  settle: (
    message: Record<string, unknown>,
    write: (message: unknown) => void,
  ) => string | null | undefined,
): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: run.workspace,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let verdict: string | null | undefined
    const finish = (value: string | null) => {
      if (verdict !== undefined) return
      verdict = value
      clearTimeout(timer)
      child.stdin?.end()
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }
    const timer = setTimeout(
      () => finish(`${run.timeoutMs / 1000} 秒内没有完成检查`),
      run.timeoutMs,
    )
    const write = (message: unknown) => {
      if (verdict === undefined)
        child.stdin?.write(`${JSON.stringify(message)}\n`)
    }
    child.once('error', error => {
      finish(`起不来：${error.message}`)
      resolve(verdict ?? null)
    })
    child.once('exit', code => {
      finish(`检查结束前退出（退出码 ${code ?? '无'}）`)
      resolve(verdict ?? null)
    })
    child.stdin?.on('error', () => {})
    createInterface({ input: child.stdout! }).on('line', line => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message === null || typeof message !== 'object') return
      const value = settle(message as Record<string, unknown>, write)
      if (value !== undefined) finish(value)
    })
    start(write)
  })
}

function claudeSmoke(run: SmokeRun): Promise<string | null> {
  const mcpConfig = join(run.scratch, 'runtime-mcp.json')
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: Object.fromEntries(
        [RUNTIME_MCP_SERVER, ASKED_SERVER].map(name => [
          name,
          { type: 'stdio', command: run.mcp[0], args: run.mcp.slice(1) },
        ]),
      ),
    }),
    { mode: 0o600 },
  )
  const argv = claudeCodeArgv({
    bin: run.bin,
    model: SMOKE_MODEL,
    baseUrl: run.baseUrl,
    sessionId: randomUUID(),
    resume: false,
    systemPrompt: 'Compatibility check.',
    mcpConfigPath: mcpConfig,
    allowWorkspaceEdits: false,
  })
  const env = {
    ...inheritedEnv(),
    ...CLAUDE_CODE_ENV,
    HOME: run.home,
    CLAUDE_CONFIG_DIR: run.home,
    ANTHROPIC_API_KEY: 'qianmo-smoke',
    ANTHROPIC_BASE_URL: run.baseUrl,
  }
  const tool = `mcp__${RUNTIME_MCP_SERVER}__${SMOKE_TOOL}`
  let initialized = false
  return converse(
    run,
    argv,
    env,
    write =>
      write({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Call ${tool}.` }],
        },
        parent_tool_use_id: null,
      }),
    message => {
      if (message.type === 'system' && message.subtype === 'init') {
        const servers = Array.isArray(message.mcp_servers)
          ? (message.mcp_servers as { name?: unknown; status?: unknown }[])
          : []
        const qianmo = servers.find(one => one.name === RUNTIME_MCP_SERVER)
        if (qianmo?.status !== 'connected')
          return `没有连上 qianmo 工具桥（${String(qianmo?.status ?? '未列出')}）`
        const tools = Array.isArray(message.tools) ? message.tools : []
        if (!tools.includes(tool)) return `qianmo 工具桥的工具没有出现：${tool}`
        initialized = true
        return undefined
      }
      if (message.type !== 'result') return undefined
      if (!initialized) return '没有报告启动状态'
      if (message.subtype !== 'success' || message.is_error === true)
        return `回合没有完成：${String(message.result ?? message.subtype)}`
      if (!run.calls.includes(SMOKE_TOOL)) return '调用 qianmo 工具没有到达节点'
      if (!run.calls.includes(PERMISSION_TOOL))
        return '规则没放行的调用没有经 qianmo_permission 问节点'
      if (run.calls.filter(name => name === SMOKE_TOOL).length < 2)
        return '问过节点之后调用没有执行'
      return null
    },
  )
}

function codexSmoke(run: SmokeRun): Promise<string | null> {
  const argv = codexArgv({
    bin: run.bin,
    model: SMOKE_MODEL,
    baseUrl: `${run.baseUrl}/v1`,
    keyEnv: CODEX_KEY_ENV,
    workspace: run.workspace,
    mcp: { command: run.mcp[0]!, args: run.mcp.slice(1) },
  })
  const env = {
    ...inheritedEnv(),
    HOME: run.home,
    CODEX_HOME: run.home,
    [CODEX_KEY_ENV]: 'qianmo-smoke',
  }
  return converse(
    run,
    argv,
    env,
    write =>
      write({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'qianmo', title: 'Qianmo check', version: '1' },
          capabilities: { experimentalApi: true },
        },
      }),
    (message, write) => {
      if (message.id === 1) {
        if (message.error !== undefined)
          return `app-server 拒绝握手：${JSON.stringify(message.error)}`
        write({ method: 'initialized' })
        write({ id: 2, method: 'mcpServerStatus/list', params: {} })
        return undefined
      }
      if (message.id !== 2) return undefined
      if (message.error !== undefined)
        return `列不出 MCP 服务：${JSON.stringify(message.error)}`
      const data = (message.result as { data?: unknown } | undefined)?.data
      const servers = Array.isArray(data)
        ? (data as { name?: unknown; tools?: unknown; toolsError?: unknown }[])
        : []
      const qianmo = servers.find(one => one.name === RUNTIME_MCP_SERVER)
      if (qianmo === undefined) return '没有列出 qianmo 工具桥'
      const tools =
        qianmo.tools !== null && typeof qianmo.tools === 'object'
          ? Object.keys(qianmo.tools)
          : []
      if (!tools.includes(SMOKE_TOOL))
        return `qianmo 工具桥没有给出工具${
          qianmo.toolsError ? `：${JSON.stringify(qianmo.toolsError)}` : ''
        }`
      return null
    },
  )
}

/** The ACP smoke's stand-in model, on any lane: call the tool, then answer. */
function laneModel(): {
  port: number
  requests: { lane: RuntimeLane; tools: string[] }[]
  stop: () => Promise<void>
} {
  const requests: { lane: RuntimeLane; tools: string[] }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >
      const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? (value as Record<string, unknown>[]) : []
      const sse = (events: unknown[]) =>
        new Response(
          events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      if (path.endsWith('/chat/completions')) {
        const tools = list(body.tools).map(tool =>
          String((tool.function as Record<string, unknown>)?.name),
        )
        requests.push({ lane: 'openai-chat', tools })
        const messages = list(body.messages)
        const lastUser = messages.findLastIndex(one => one.role === 'user')
        const answered = messages
          .slice(lastUser + 1)
          .some(one => one.role === 'tool')
        const name = tools.find(tool => tool.endsWith(SMOKE_TOOL))
        const base = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk' }
        const delta =
          answered || name === undefined
            ? { content: 'ok' }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_smoke',
                    type: 'function',
                    function: { name, arguments: '{}' },
                  },
                ],
              }
        return new Response(
          [
            { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'content' in delta ? 'stop' : 'tool_calls',
                },
              ],
            },
            {
              ...base,
              choices: [],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          ]
            .map(event => `data: ${JSON.stringify(event)}\n\n`)
            .concat('data: [DONE]\n\n')
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (path.endsWith('/messages')) {
        const tools = list(body.tools).map(tool => String(tool.name))
        requests.push({ lane: 'anthropic', tools })
        const answered = JSON.stringify(
          list(body.messages).at(-1) ?? {},
        ).includes('"tool_result"')
        const name = tools.find(tool => tool.endsWith(SMOKE_TOOL))
        return messageStream(
          answered || name === undefined
            ? { type: 'text', text: 'ok' }
            : { type: 'tool_use', id: 'toolu_smoke', name, input: {} },
        )
      }
      if (path.endsWith(':streamGenerateContent')) {
        const tools = list(body.tools).flatMap(tool =>
          list(tool.functionDeclarations).map(one => String(one.name)),
        )
        requests.push({ lane: 'gemini', tools })
        const answered = JSON.stringify(
          list(body.contents).at(-1) ?? {},
        ).includes('"functionResponse"')
        const name = tools.find(tool => tool.endsWith(SMOKE_TOOL))
        return sse([
          {
            candidates: [
              {
                index: 0,
                content: {
                  role: 'model',
                  parts: [
                    answered || name === undefined
                      ? { text: 'ok' }
                      : { functionCall: { name, args: {} } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          },
        ])
      }
      return Response.json({ object: 'list', data: [] })
    },
  })
  return {
    port: server.port ?? 0,
    requests,
    stop: async () => {
      await server.stop(true)
    },
  }
}

/** The lane's base URL as the hub hands it out (`AcpLaunchInput.baseUrl`). */
function laneBase(lane: RuntimeLane, root: string): string {
  return lane === 'openai-chat' || lane === 'openai-responses'
    ? `${root}/v1`
    : lane === 'gemini'
      ? `${root}/v1beta`
      : root
}

async function acpSmoke(
  run: SmokeRun,
  spec: RuntimeSpec,
): Promise<string | null> {
  const acp = spec.acp
  const lane = spec.lanes[0]
  if (acp === undefined || lane === undefined)
    return `${spec.label} 在目录里没有 ACP 启动方式`
  const model = laneModel()
  const runDir = join(run.scratch, 'launch')
  mkdirSync(runDir, { mode: 0o700 })
  const bridge = {
    name: RUNTIME_MCP_SERVER,
    command: isAbsolute(run.mcp[0]!)
      ? run.mcp[0]!
      : (Bun.which(run.mcp[0]!) ?? run.mcp[0]!),
    args: run.mcp.slice(1),
    timeoutMs: RUNTIME_MCP_TIMEOUT_MS,
  }
  let channel: AcpChannel | undefined
  try {
    const plan = acp.launch({
      bin: run.bin,
      model: SMOKE_MODEL,
      lane,
      baseUrl: laneBase(lane, `http://127.0.0.1:${model.port}`),
      apiKey: 'qianmo-smoke',
      home: run.home,
      runDir,
      cwd: run.workspace,
      bridge,
      ...(acp.needsPort === true ? { port: await freeLoopbackPort() } : {}),
      secret: randomUUID(),
    })
    for (const dir of [
      ...(plan.dirs ?? []),
      ...(plan.cwd === undefined ? [] : [plan.cwd]),
    ])
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const file of plan.files ?? []) {
      mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 })
      writeFileSync(file.path, file.content, { mode: 0o600 })
    }
    const child = spawn(plan.argv[0]!, plan.argv.slice(1), {
      cwd: plan.cwd ?? run.workspace,
      env: { ...inheritedEnv(), HOME: run.home, ...plan.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const opened = new AcpChannel(child, {
      label: spec.label,
      runtime: acp,
      cwd: run.workspace,
      mcpServers:
        plan.mountsBridge === true
          ? []
          : [
              {
                name: bridge.name,
                command: bridge.command,
                args: bridge.args,
                env: [],
              },
            ],
      onSession: () => {},
      // Only the host's tool is called; the host decides it when called.
      permission: async () => true,
      progress: call => acpVerdictCalls(acp, call)[0],
    })
    channel = opened
    const deadline = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), run.timeoutMs).unref(),
    )
    const started = await Promise.race([
      opened.initialize().then(
        () => null,
        (error: unknown) =>
          `会话没有建立（含 qianmo 工具桥）：${error instanceof Error ? error.message : String(error)}`,
      ),
      deadline,
    ])
    if (started === 'timeout') return `${run.timeoutMs / 1000} 秒内没有完成检查`
    if (started !== null) return started
    const result = new Promise<OmpRpcFrame>(resolve =>
      opened.onFrame(frame => {
        if (frame.type === 'prompt_result') resolve(frame)
      }),
    )
    await opened.prompt({
      messageId: 'smoke',
      text: `Call the ${SMOKE_TOOL} tool, then answer ok.`,
    })
    const ended = await Promise.race([result, deadline])
    if (ended === 'timeout') return `${run.timeoutMs / 1000} 秒内没有完成检查`
    if (model.requests.length === 0) return '底层没有请求模型'
    // Any request: a harness may first ask for a session title, toolless.
    if (
      !model.requests.some(request =>
        request.tools.some(tool => tool.endsWith(SMOKE_TOOL)),
      )
    )
      return `qianmo 工具桥的工具没有出现：${SMOKE_TOOL}`
    if (!run.calls.includes(SMOKE_TOOL)) return '调用 qianmo 工具没有到达节点'
    if (ended.status !== 'completed')
      return `回合没有完成：${JSON.stringify(ended.error ?? ended.status)}`
    return null
  } finally {
    await channel?.stop(true).catch(() => {})
    await model.stop()
  }
}
