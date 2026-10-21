// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings tools on every runtime's own tool channel (P40,
 * `agent-settings.md` §3, §4.1, §8 「节点」): qianmopi gets them through
 * `set_host_tools`, the external runtimes through the `qianmo` MCP bridge, and
 * each runtime's own permission layer lets them through without asking, so
 * a change shows one card — the one the handler asks for — and never a
 * second one from the runtime.
 */

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  readResidentExtensionConfig,
  residentToolVerdict,
} from '@qianmo/extension/policy'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { TransportClient } from '@qianmo/transport'
import { QianmoResident } from '../../src/host/resident.js'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import {
  ExternalRuntimePool,
  type ExternalAgent,
  type ExternalRuntimeSpawn,
} from '../../src/host/runtimes/pool.js'
import { DSH_GATE_PLUGIN } from '../../src/host/runtimes/dsh.js'
import { geminiToolCall } from '../../src/host/runtimes/gemini.js'
import {
  opencodePermission,
  opencodeToolCall,
} from '../../src/host/runtimes/opencode.js'
import { qwenToolCall } from '../../src/host/runtimes/qwen.js'
import { settingsTools } from '../../src/host/settingsTools.js'
import { isolatedRoot } from '../providers/fake.js'

const NAMES = ['qianmo_settings_change', 'qianmo_settings_list']
const BRIDGED = 'mcp__qianmo__qianmo_settings_change'

const fixtures = join(import.meta.dir, 'fixtures')
const FAKE: Record<string, string> = {
  'claude-code': join(fixtures, 'fake-claude-code.runner.ts'),
  codex: join(fixtures, 'fake-codex.runner.ts'),
  dsh: join(fixtures, 'fake-acp.runner.ts'),
}

let root: ReturnType<typeof isolatedRoot> | undefined
const pools: { stop(): Promise<void> }[] = []
const children: ChildProcess[] = []
const launches: ExternalRuntimeSpawn[] = []
const scratch: string[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stop()
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  launches.length = 0
  if (root) rmSync(`${root.root}-workspace`, { recursive: true, force: true })
  root?.dispose()
  root = undefined
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

/** The settings tools on a hub that lists one area and approves nothing. */
function hostTools(listed: string[]) {
  return settingsTools({
    call: async op => {
      listed.push(op)
      return { ok: true, value: { areas: [] } }
    },
    origin: () => ({ contextId: 'console-session', taskId: 'turn-1' }),
    unavailable: () => 'no-approver',
    approve: async () => ({ kind: 'refused' }),
  })
}

function external(agentOptions: Pick<ExternalAgent, 'runtime'>) {
  root ??= isolatedRoot()
  const cwd = `${root.root}-workspace`
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), 'hello\n')
  const agent: ExternalAgent = { agent: 'coder', cwd, ...agentOptions }
  const asked: { toolName: string; input: unknown }[] = []
  const listed: string[] = []
  const pool = new ExternalRuntimePool({
    agents: [agent],
    resolveLaunch: () => ({
      model: 'fake-model',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-runtime',
    }),
    bins: { dsh: '/opt/fake/dsh' },
    memoryRoot: join(root.root, 'memory'),
    allowWorkspaceEdits: false,
    hostTools: {
      extraHostTools: hostTools(listed),
      announce: async () => ({ status: 'sent' }),
    },
    requestPermission: async (_sessionId, call) => {
      asked.push(call)
      return false
    },
    spawn: input => {
      launches.push(input)
      const child = spawn(
        process.execPath,
        [FAKE[input.kind]!, ...input.argv.slice(1)],
        { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      children.push(child)
      return child
    },
  })
  pools.push(pool)
  return { pool, agent, asked, listed }
}

async function turn(
  pool: ExternalRuntimePool,
  sessionId: string,
  prompt: string,
) {
  return new OmpResidentTurnPort(pool).execute(
    { sessionId, messageId: prompt, prompt, networkMsgId: `net-${prompt}` },
    async () => {},
  )
}

/** The `qm runtime-mcp` command a runtime was told to start. */
function bridgeOf(launch: ExternalRuntimeSpawn): {
  command: string
  args: string[]
} {
  if (launch.kind === 'claude-code') {
    const config = JSON.parse(
      readFileSync(join(launch.sessionDir, 'runtime-mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> }
    return config.mcpServers.qianmo!
  }
  if (launch.kind === 'codex') {
    const value = launch.argv.find(arg =>
      arg.startsWith('mcp_servers.qianmo='),
    )!
    return {
      command: JSON.parse(/"command" = ("(?:[^"\\]|\\.)*")/.exec(value)![1]!),
      args: JSON.parse(/"args" = (\[.*\])/.exec(value)![1]!),
    }
  }
  const rows = Bun.YAML.parse(
    readFileSync(
      join(launch.sessionDir, 'runtime-launch', 'qianmo-dsh.patch.yml'),
      'utf8',
    ),
  ) as { insert?: { id: string; config?: Record<string, unknown> }[] }[]
  return rows
    .flatMap(row => row.insert ?? [])
    .find(row => row.id === 'qm-bridge')!.config as {
    command: string
    args: string[]
  }
}

/** Speaks MCP to the bridge the way the runtime would. */
async function mcpClient(server: { command: string; args: string[] }) {
  const child = spawn(server.command, server.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>()
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const reply = JSON.parse(buffer.slice(0, index)) as Record<
        string,
        unknown
      >
      buffer = buffer.slice(index + 1)
      waiting.get(reply.id as number)?.(reply)
    }
  })
  let sequence = 0
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>(resolve => {
      const id = ++sequence
      waiting.set(id, resolve)
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      )
    })
  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'settings-test', version: '0' },
  })
  child.stdin!.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  )
  const names = async () =>
    (
      (await request('tools/list')).result as { tools: { name: string }[] }
    ).tools.map(tool => tool.name)
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await request('tools/call', { name, arguments: args })
    const result = reply.result as {
      content: { text: string }[]
      isError?: boolean
    }
    return { text: result.content[0]!.text, isError: result.isError === true }
  }
  return { names, call }
}

test('the resident offers both on every runtime, next to the task and peer tools', async () => {
  root = isolatedRoot()
  const socket = join(root.root, 'resident.sock')
  const psk = 'settings-tools-test-local-psk-0000'
  const envs: Record<string, string>[] = []
  const replies: QianmoMessage[] = []
  let ready = false
  const resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [{ agent: 'ops', cwd: root.root }],
    memoryRoot: join(root.root, 'memory'),
    controllers: new Set(['hub']),
    psk,
    listen: { unix: socket },
    pollIntervalMs: 10,
    onTiming: event => {
      if (event.stage === 'runtime_ready') ready = true
    },
    spawnOmp: input => {
      envs.push(input.env)
      const child = spawn(
        process.execPath,
        [join(fixtures, 'resident-omp-agent.runner.ts')],
        { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      children.push(child)
      return child
    },
  })
  const running = resident.run()
  const client = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-a',
    psk,
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  try {
    const deadline = Date.now() + 10_000
    while (!ready && Date.now() < deadline) await Bun.sleep(10)
    await client.connect()
    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/ops',
      type: MessageType.TaskRequest,
      payload: { prompt: 'hello' },
    })
    await client.sendAndWait(request)
    while (
      !replies.some(reply => reply.taskId === request.taskId) &&
      Date.now() < deadline
    )
      await Bun.sleep(10)
    expect(envs.length).toBeGreaterThan(0)
    const offered = readResidentExtensionConfig(envs[0]!).hostTools
    expect(offered).toEqual(
      expect.arrayContaining([
        'qianmo_task_start',
        'qianmo_ask',
        'qianmo_mail_send',
        ...NAMES,
      ]),
    )
  } finally {
    client.close()
    resident.stop()
    await running
  }
}, 20_000)

test('qianmopi: set_host_tools carries both, the overlay allows them and the extension lets them run', async () => {
  root = isolatedRoot()
  const log = join(root.root, 'frames.ndjson')
  const launched: { argv: readonly string[]; env: Record<string, string> }[] =
    []
  const pool = new ResidentOmpPool({
    agents: [{ agent: 'ops', cwd: root.root }],
    memoryRoot: join(root.root, 'memory'),
    announce: async () => ({ status: 'queued' }),
    extraHostTools: hostTools([]),
    requestPermission: async () => false,
    spawn: input => {
      launched.push({ argv: input.argv, env: input.env })
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
          const {appendFileSync} = require('node:fs');
          const {createInterface} = require('node:readline');
          setInterval(() => {}, 1000);
          createInterface({input:process.stdin}).on('line', line => {
            appendFileSync(${JSON.stringify(log)}, line + '\\n');
            const frame = JSON.parse(line);
            if (frame.id !== undefined)
              process.stdout.write(JSON.stringify({type:'response',id:frame.id,success:true})+'\\n');
          });
          process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
          `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      children.push(child)
      return child
    },
  })
  pools.push(pool)
  const session = await pool.newSession({ agent: 'ops', cwd: root.root })
  await pool.channelFor(session)
  const frames = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const set = frames.find(frame => frame.type === 'set_host_tools')!
  const tools = set.tools as { name: string; loadMode: string }[]
  for (const name of NAMES)
    expect(tools.find(tool => tool.name === name)).toMatchObject({
      loadMode: 'essential',
    })
  const argv = launched[0]!.argv
  const overlay = readFileSync(argv[argv.indexOf('--config') + 1]!, 'utf8')
  for (const name of NAMES) expect(overlay).toContain(`    ${name}: allow\n`)
  const config = readResidentExtensionConfig(launched[0]!.env)
  expect(config.hostTools).toEqual(expect.arrayContaining(NAMES))
  expect(dirname(argv[argv.indexOf('--config') + 1]!)).toBe(
    dirname(launched[0]!.env.QIANMO_EXTENSION_CONFIG!),
  )
  for (const name of NAMES) {
    expect(
      residentToolVerdict(
        { toolName: name, input: { id: 'providers.default' } },
        config,
        { agentKind: 'main' },
      ),
    ).toBeUndefined()
    // A subagent has no turn of its own to attribute a change to.
    expect(
      residentToolVerdict({ toolName: name, input: {} }, config, {
        agentKind: 'sub',
      }),
    ).toBeDefined()
  }
}, 10_000)

test('Claude Code: the bridge lists both and its permission tool lets them through without asking', async () => {
  const { pool, agent, asked, listed } = external({ runtime: 'claude-code' })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'hello')).outcome).toBe('completed')
  const mcp = await mcpClient(bridgeOf(launches[0]!))
  expect(await mcp.names()).toEqual(expect.arrayContaining(NAMES))
  // `permissions.ask: mcp__*` sends every bridge tool to qianmo_permission.
  const verdict = JSON.parse(
    (
      await mcp.call('qianmo_permission', {
        tool_name: BRIDGED,
        input: { id: 'providers.default' },
      })
    ).text,
  ) as { behavior: string }
  expect(verdict.behavior).toBe('allow')
  expect(asked).toEqual([])
  // The bridge reaches the same handler.
  const read = await mcp.call('qianmo_settings_list', {})
  expect(read.isError).toBe(false)
  expect(listed).toEqual(['settings.list'])
  const change = await mcp.call('qianmo_settings_change', {
    id: 'providers.default',
  })
  expect(change.isError).toBe(true)
  expect(change.text).toContain('--approver')
}, 20_000)

test('Codex: the bridge lists both and approves its own tools; an elicitation for one is accepted unasked', async () => {
  const { pool, agent, asked } = external({ runtime: 'codex' })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'hello')).outcome).toBe('completed')
  const bridge = launches[0]!.argv.find(arg =>
    arg.startsWith('mcp_servers.qianmo='),
  )!
  expect(bridge).toContain('"default_tools_approval_mode" = "approve"')
  const mcp = await mcpClient(bridgeOf(launches[0]!))
  expect(await mcp.names()).toEqual(expect.arrayContaining(NAMES))
  // The fixture names `qianmo_notify`; the node accepts by the server name.
  expect(await turn(pool, session, 'mcp-host')).toMatchObject({
    outcome: 'completed',
    content: expect.stringContaining('mcp-host action=accept'),
  })
  expect(asked).toEqual([])
}, 20_000)

test('dsh: the bridge lists both, a permission request for one passes unasked, and the gate leaves them to the host', async () => {
  const { pool, agent, asked } = external({ runtime: 'dsh' })
  const session = await pool.newSession(agent)
  const asking = await turn(pool, session, `mcp ${BRIDGED}`)
  expect(asking).toMatchObject({
    outcome: 'completed',
    content: expect.stringContaining(`${BRIDGED} allow-once`),
  })
  expect(asked).toEqual([])
  const mcp = await mcpClient(bridgeOf(launches.at(-1)!))
  expect(await mcp.names()).toEqual(expect.arrayContaining(NAMES))
  const dir = mkdtempSync(join(tmpdir(), 'qm-settings-gate-'))
  scratch.push(dir)
  const file = join(dir, 'qm-approval-gate.mjs')
  writeFileSync(file, DSH_GATE_PLUGIN)
  const plugin = (await import(file)) as { apply: (ctx: unknown) => void }
  let gate:
    | ((
        exec: Record<string, unknown>,
        next: () => Promise<{ kind: string }>,
      ) => Promise<{ kind: string }>)
    | undefined
  plugin.apply({
    on: (_event: string, listener: typeof gate) => {
      gate = listener
    },
    tools: { guard: () => {} },
  })
  const decided = await gate!(
    {
      name: BRIDGED,
      arguments: {},
      agent: { session: { header: { cwd: dir } } },
    },
    async () => ({ kind: 'allow' }),
  )
  expect(decided.kind).toBe('allow')
}, 20_000)

test('opencode, Gemini and Qwen: the bridge tools are allowed natively and read as the host’s own', () => {
  const permission = opencodePermission()
  const opencodeName = `qianmo_${NAMES[0]}`
  // opencode's rules are wildcards over `<server>_<tool>`.
  const rule = Object.entries(permission).find(
    ([pattern]) =>
      pattern !== '*' &&
      new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(opencodeName),
  )
  expect(rule).toEqual(['qianmo_*', 'allow'])
  const call = { kind: 'other', rawInput: { id: 'x' }, paths: [] }
  expect(opencodeToolCall({ ...call, title: opencodeName })).toEqual([
    { toolName: BRIDGED, input: { id: 'x' } },
  ])
  expect(
    geminiToolCall({ ...call, title: `${NAMES[0]} (qianmo MCP Server)` }),
  ).toEqual([{ toolName: BRIDGED, input: { id: 'x' } }])
  expect(
    qwenToolCall({ ...call, title: 'x', meta: { toolName: BRIDGED } }),
  ).toEqual([{ toolName: BRIDGED, input: { id: 'x' } }])
})
