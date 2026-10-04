// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff attach` with stand-ins for `ssh` and `qmcode`
 * (`support/attachShims.ts`) and the fake app-server, everything between them
 * real: the tunnel is a TCP forward, the WebSocket and the token check are
 * real, the hub is a small HTTP stand-in that answers like
 * `/v0/handoff/<task>/attach` (the real route and port are tested in
 * `packages/console/test/handoff.test.ts` and `consoleHandoff.test.ts`; the
 * whole chain with the real hub and node bridge in
 * `tests/integration/qianmo-handoff-return.test.ts`).
 *
 * What is checked: the token goes to `qmcode`'s environment and nowhere else
 * (no argv, no output, nothing sent to the hub); the turn typed in the
 * terminal reaches the node's thread, whose working directory stays the
 * node's; the tunnel is gone when attach returns, whichever way; and every
 * failure says what happened in words that keep the copy rule.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerClient } from '@qianmo/handoff'
import {
  ATTACH_TOKEN_ENV,
  type AttachCommands,
  type AttachOptions,
  runAttach,
} from '../handoffAttach.js'
import type { Output } from '../handoffNow.js'
import { HandoffUserError } from '../handoffStore.js'
import {
  type AttachShims,
  alive,
  readShimLog,
  writeAttachShims,
} from './support/attachShims.js'
import {
  type FakeAppServer,
  startFakeAppServer,
} from './support/fakeAppServer.js'

const COPY_RULE = /[。，、！!]|\p{Extended_Pictographic}/u
const NODE = 'cloud-1'
const TOKEN = `app-${randomBytes(24).toString('hex')}`
const CONSOLE_TOKEN = `qm-attach-test-${randomBytes(8).toString('hex')}`

const saved: Record<string, string | undefined> = {}
const roots: string[] = []
let base = ''
let consoleTokenFile = ''
let shims: AttachShims
let commands: AttachCommands
let logPath = ''
let fake: FakeAppServer
let appPort = 0
let hub: ReturnType<typeof Bun.serve> | undefined
const hubRequests: {
  method: string
  path: string
  body: string
  auth: string | null
}[] = []
const locators = new Map<string, { status: number; body: unknown }>()
let listed: Record<string, unknown>[] = []
let qmThread = ''
let ccThread = ''
let bridge: AppServerClient | undefined

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-attach-'))
  roots.push(dir)
  return dir
}

function collector(): Output & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: line => lines.push(line), err: line => lines.push(line) }
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function locator(taskId: string, threadId: string | null, state = 'running') {
  return {
    status: 200,
    body: {
      attach: {
        taskId,
        state,
        node: NODE,
        threadId,
        project: 'atlas',
        tool: threadId === null ? 'claude-code' : 'qmcode',
      },
    },
  }
}

function access(
  port = hub?.port,
): Pick<AttachOptions, 'console' | 'tokenFile'> {
  return { console: `http://127.0.0.1:${port}`, tokenFile: consoleTokenFile }
}

/** Run attach and hand back what it said, its code or its refusal. */
async function attach(
  options: AttachOptions,
  using: AttachCommands = commands,
): Promise<{
  code: number | null
  error: HandoffUserError | null
  lines: string[]
}> {
  const out = collector()
  try {
    const code = await runAttach(base, options, out, using, {
      readyTimeoutMs: 1_500,
    })
    return { code, error: null, lines: out.lines }
  } catch (error) {
    if (!(error instanceof HandoffUserError)) throw error
    return { code: null, error, lines: out.lines }
  }
}

beforeAll(async () => {
  base = tempDir()
  setEnv('OCC_CONFIG_DIR', join(base, 'config'))
  consoleTokenFile = join(base, 'console.token')
  writeFileSync(consoleTokenFile, `${CONSOLE_TOKEN}\n`, { mode: 0o600 })
  shims = writeAttachShims(join(base, 'bin'))
  commands = { ssh: shims.ssh, qmcode: shims.qmcode, sh: '/bin/sh' }
  logPath = join(base, 'shim.log')
  setEnv('QIANMO_SHIM_LOG', logPath)

  // The node: its home holds the token where handoff-node.sh puts it.
  const nodeHome = join(base, 'node-home')
  mkdirSync(join(nodeHome, 'qianmo-beta', 'secrets'), { recursive: true })
  writeFileSync(
    join(nodeHome, 'qianmo-beta', 'secrets', 'handoff-app-server-token'),
    `${TOKEN}\n`,
    { mode: 0o600 },
  )
  setEnv('QIANMO_SHIM_NODE_HOME', nodeHome)

  // The app-server with two running tasks: a resumed qmcode thread and a
  // Claude Code import (a thread the hub does not know yet).
  fake = startFakeAppServer({
    token: TOKEN,
    qmcodeHome: join(base, 'node-qmcode'),
    hold: true,
  })
  appPort = Number(new URL(fake.url).port)
  bridge = await AppServerClient.connect({ url: fake.url, token: TOKEN })
  const settings = {
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
  } as const
  qmThread = (
    await bridge.threadStart({
      cwd: '/srv/qianmo/handoff/node/work/t-run',
      ...settings,
    })
  ).id
  ccThread = (
    await bridge.threadStart({
      cwd: '/srv/qianmo/handoff/node/work/t-cc',
      ...settings,
    })
  ).id
  await bridge.turnStart(qmThread, 'the node bridge brief')
  await bridge.turnStart(ccThread, 'the node bridge brief')

  locators.set('t-run', locator('t-run', qmThread))
  locators.set('t-cc', locator('t-cc', null))
  locators.set('t-done', {
    status: 400,
    body: {
      error: {
        code: 'rejected',
        message:
          '任务 t-done 在云端已经结束（done）· 用 qm handoff pull t-done 接回本机',
      },
    },
  })
  hub = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.text()
      hubRequests.push({
        method: request.method,
        path,
        body,
        auth: request.headers.get('authorization'),
      })
      if (request.headers.get('authorization') !== `Bearer ${CONSOLE_TOKEN}`) {
        return Response.json({ error: { message: 'no' } }, { status: 401 })
      }
      if (path === '/v0/handoff') return Response.json({ tasks: listed })
      const id = /^\/v0\/handoff\/([^/]+)\/attach$/.exec(path)?.[1] ?? ''
      const answer = locators.get(id)
      return answer === undefined
        ? Response.json(
            { error: { code: 'not_found', message: `台账里没有任务 ${id}` } },
            { status: 404 },
          )
        : Response.json(answer.body, { status: answer.status })
    },
  })
})

afterAll(async () => {
  bridge?.close()
  fake?.stop()
  hub?.stop(true)
  // The held turns end on stop and write their last lines; let them.
  await Bun.sleep(100)
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function freshLog(): void {
  writeFileSync(logPath, '')
}

/** Every pid a tunnel stand-in had. */
function tunnelPids(): number[] {
  return readShimLog(logPath)
    .filter(
      event =>
        event.tool === 'ssh' &&
        event.event === 'start' &&
        event.mode === 'tunnel',
    )
    .map(event => event.pid)
}

describe('qm handoff attach', () => {
  test('AC-H4 here: through the tunnel to the node thread; the token only in qmcode’s environment; the tunnel gone after', async () => {
    freshLog()
    const before = fake.inputs(fake.turns[0] ?? '').length
    const ran = await attach({
      taskId: 't-run',
      appServerPort: appPort,
      ...access(),
    })
    expect(ran.error).toBeNull()
    expect(ran.code).toBe(0)

    const log = readShimLog(logPath)
    const read = log.find(e => e.tool === 'ssh' && e.mode === 'command')
    expect(read?.argv).toEqual([
      '-T',
      '-o',
      'ClearAllForwardings=yes',
      '--',
      NODE,
      `cat -- "$HOME"/'qianmo-beta/secrets/handoff-app-server-token'`,
    ])
    const tunnel = log.find(e => e.tool === 'ssh' && e.mode === 'tunnel')
    const argv = tunnel?.argv as string[]
    expect(argv.slice(0, 2)).toEqual(['-N', '-L'])
    const localPort = Number(
      /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(argv[2] ?? '')?.[1],
    )
    expect(argv[2]).toBe(`127.0.0.1:${localPort}:127.0.0.1:${appPort}`)
    expect(argv).toContain('ExitOnForwardFailure=yes')
    expect(argv.slice(-2)).toEqual(['--', NODE])
    const qm = log.find(e => e.tool === 'qmcode' && e.event === 'start')
    expect(qm?.argv).toEqual([
      'resume',
      '--remote',
      `ws://127.0.0.1:${localPort}`,
      '--remote-auth-token-env',
      ATTACH_TOKEN_ENV,
      qmThread,
    ])
    expect(qm?.cd).toBe(false)
    expect(qm?.tokenLength).toBe(TOKEN.length)
    // The node saw the terminal's input go into its running turn, and the
    // thread kept the node's working directory.
    expect(
      log.find(e => e.tool === 'qmcode' && e.event === 'resumed'),
    ).toMatchObject({
      ok: true,
      cwd: '/srv/qianmo/handoff/node/work/t-run',
    })
    expect(log.find(e => e.tool === 'qmcode' && e.event === 'turn')?.ok).toBe(
      true,
    )
    const inputs = fake.inputs(fake.turns[0] ?? '')
    expect(inputs.length).toBe(before + 1)
    expect(inputs.at(-1)).toBe('typed in the attached terminal')

    for (const pid of tunnelPids()) expect(alive(pid)).toBe(false)
    expect(log.some(e => e.tool === 'ssh' && e.event === 'stopped')).toBe(true)
    expect(ran.lines.at(-1)).toBe('  隧道已关')

    // The token is in no argv, no output line, nothing sent to the hub.
    const attachRequest = hubRequests.find(
      r => r.path === '/v0/handoff/t-run/attach',
    )
    expect(attachRequest?.method).toBe('POST')
    for (const text of [
      readFileSync(logPath, 'utf8'),
      ran.lines.join('\n'),
      JSON.stringify(hubRequests),
    ]) {
      expect(text.includes(TOKEN)).toBe(false)
    }
    for (const line of ran.lines) expect(line).not.toMatch(COPY_RULE)
  })

  test('a Claude Code task: the thread is looked up on the node through the tunnel', async () => {
    freshLog()
    const ran = await attach({
      taskId: 't-cc',
      appServerPort: appPort,
      ...access(),
    })
    expect(ran.code).toBe(0)
    expect(ran.lines.join('\n')).toContain(
      `线程  ${ccThread}（向节点 app-server 查到）`,
    )
    const qm = readShimLog(logPath).find(
      e => e.tool === 'qmcode' && e.event === 'start',
    )
    expect((qm?.argv as string[]).at(-1)).toBe(ccThread)
    for (const pid of tunnelPids()) expect(alive(pid)).toBe(false)
  })

  test('qmcode’s exit code is attach’s, and the tunnel still goes', async () => {
    freshLog()
    setEnv('QIANMO_SHIM_QMCODE_EXIT', '3')
    try {
      const ran = await attach({
        taskId: 't-run',
        appServerPort: appPort,
        ...access(),
      })
      expect(ran.code).toBe(3)
    } finally {
      setEnv('QIANMO_SHIM_QMCODE_EXIT', undefined)
    }
    expect(tunnelPids()).toHaveLength(1)
    for (const pid of tunnelPids()) expect(alive(pid)).toBe(false)
  })

  test('without a task id: the one running task; none or several is a question back', async () => {
    freshLog()
    listed = [
      {
        taskId: 't-run',
        state: 'running',
        acceptedAt: 2,
        manifest: { project: 'atlas', device: 'laptop', brief: { goal: '' } },
      },
      {
        taskId: 't-old',
        state: 'done',
        acceptedAt: 1,
        manifest: { project: 'atlas', device: 'laptop', brief: { goal: '' } },
      },
    ]
    const one = await attach({ appServerPort: appPort, ...access() })
    expect(one.code).toBe(0)
    expect(one.lines[0]).toContain('任务 t-run')

    listed = [listed[1] ?? {}]
    const none = await attach({ appServerPort: appPort, ...access() })
    expect(none.error?.message).toBe(
      '中枢上没有在云端运行的任务 · 最近的 t-old 是 done · 用 qm handoff pull 接回',
    )
    listed = [
      {
        taskId: 't-a',
        state: 'running',
        acceptedAt: 2,
        manifest: { project: 'atlas', device: 'laptop', brief: { goal: '' } },
      },
      {
        taskId: 't-b',
        state: 'running',
        acceptedAt: 1,
        manifest: { project: 'atlas', device: 'phone', brief: { goal: '' } },
      },
    ]
    const two = await attach({ appServerPort: appPort, ...access() })
    expect(two.error?.message).toBe(
      '中枢上有 2 个任务在云端运行（t-a · t-b）· 给出要接入的任务号',
    )
    for (const refusal of [none, two]) {
      expect(refusal.error?.message).not.toMatch(COPY_RULE)
    }
  })

  describe('failures: a clear sentence, a non-zero exit, no tunnel left behind', () => {
    async function refused(
      options: AttachOptions,
      using: AttachCommands = commands,
    ): Promise<HandoffUserError> {
      freshLog()
      const ran = await attach(options, using)
      expect(ran.code).toBeNull()
      const error = ran.error
      if (error === null) throw new Error('attach did not refuse')
      expect(error.exitCode).not.toBe(0)
      expect(error.message).not.toMatch(COPY_RULE)
      for (const pid of tunnelPids()) expect(alive(pid)).toBe(false)
      expect(JSON.stringify(error.message).includes(TOKEN)).toBe(false)
      return error
    }

    test('the hub cannot be reached', async () => {
      const error = await refused({ taskId: 't-run', ...access(9) })
      expect(error.message).toStartWith('连不上控制台 http://127.0.0.1:9')
      expect(readShimLog(logPath)).toEqual([])
    })

    test('the hub has no such task, or it is not running', async () => {
      const missing = await refused({ taskId: 't-missing', ...access() })
      expect(missing.message).toBe('中枢台账里没有任务 t-missing')
      const done = await refused({ taskId: 't-done', ...access() })
      expect(done.message).toContain('用 qm handoff pull t-done 接回本机')
      expect(readShimLog(logPath)).toEqual([])
    })

    test('the node cannot be reached over SSH', async () => {
      setEnv('QIANMO_SHIM_SSH_FAIL', 'connect')
      try {
        const error = await refused({
          taskId: 't-run',
          appServerPort: appPort,
          ...access(),
        })
        expect(error.message).toBe(
          `读不到节点 ${NODE} 上的 app-server 令牌（ssh ${NODE} 退出码 255）· 上面是 ssh 的输出 · 节点的 SSH 目标不是 ${NODE} 时用 --ssh 指定 · 令牌不在 qianmo-beta/secrets/handoff-app-server-token 时用 --node-token-file 指定`,
        )
        expect(tunnelPids()).toEqual([])
      } finally {
        setEnv('QIANMO_SHIM_SSH_FAIL', undefined)
      }
    })

    test('the local port is taken: before ssh, and when ssh finds it taken', async () => {
      const holder: Server = createServer()
      const port = await new Promise<number>(done =>
        holder.listen(0, '127.0.0.1', () => {
          const address = holder.address()
          done(
            typeof address === 'object' && address !== null ? address.port : 0,
          )
        }),
      )
      try {
        const before = await refused({
          taskId: 't-run',
          appServerPort: appPort,
          localPort: port,
          ...access(),
        })
        expect(before.message).toBe(
          `本地端口 ${port} 已被占用 · 换一个 --local-port 或不给它让 qm 自己挑`,
        )
        expect(readShimLog(logPath).filter(e => e.tool === 'ssh')).toEqual([])
      } finally {
        holder.close()
      }
      // Free when looked at, taken by the time ssh binds it (a race): ssh's
      // ExitOnForwardFailure answer is read the same way.
      setEnv('QIANMO_SHIM_SSH_FAIL', 'bind')
      try {
        const during = await refused({
          taskId: 't-run',
          appServerPort: appPort,
          ...access(),
        })
        expect(during.message).toMatch(/^本地端口 \d+ 已被占用 · /)
      } finally {
        setEnv('QIANMO_SHIM_SSH_FAIL', undefined)
      }
    })

    test('the app-server does not answer through the tunnel', async () => {
      const error = await refused({
        taskId: 't-run',
        appServerPort: 9,
        ...access(),
      })
      expect(error.message).toBe(
        `隧道开了但节点 ${NODE} 上的 app-server 没有回应（127.0.0.1:9）· 节点上 handoff-node.sh 起了吗 · 端口不是 9 时用 --app-server-port 指定`,
      )
      expect(tunnelPids()).toHaveLength(1)
    })

    test('no qmcode on this machine', async () => {
      const error = await refused(
        { taskId: 't-run', appServerPort: appPort, ...access() },
        { ...commands, qmcode: join(base, 'bin', 'no-qmcode-here') },
      )
      expect(error.message).toBe(
        `找不到 qmcode（${join(base, 'bin', 'no-qmcode-here')}）· 装上阡陌 Codex 并放进 PATH`,
      )
      expect(tunnelPids()).toHaveLength(1)
    })

    test('outside a registered repository without --console', async () => {
      const error = await refused({ taskId: 't-run' })
      expect(error.message).toContain(
        '在别的机器上接入要给 --console <控制台> --token-file <凭据文件>',
      )
    })
  })
})
