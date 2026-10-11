// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  githubHandoffRef,
  githubResultRef,
  HandoffLedger,
  encodeResultContent,
  type HandoffManifest,
  type HandoffResult,
} from '@qianmo/handoff'
import { generateNodeKeyPair } from '@qianmo/capability'
import {
  createAck,
  errorReply,
  ProtocolErrorCode,
  createTaskResult,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { startTransportServer } from '@qianmo/transport'
import { qianmoConfigPath } from '@qianmo/paths'
import { readTrail } from '@qianmo/audit'
import {
  accountsHarness,
  person,
} from '../../../console/test/accountsHarness.js'
import { openConsoleHandoff } from '../../src/commands/consoleHandoff.js'
import { openConsoleHandoffDevices } from '../../src/commands/consoleHandoffDevices.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { createConsoleWakeIssuer } from '../../src/commands/consoleWakeIdentity.js'
import {
  githubRepoFromOrigin,
  syncGithub,
  probeGithubVisibility,
} from '../../src/commands/handoffGithub.js'
import { tokenLinkAllowed } from '../../src/commands/handoffGithubGit.js'
import { cliHandoffRepoCredentials } from '../../src/commands/handoffRepoCli.js'
import { runClean } from '../../src/commands/handoffClean.js'
import { loginDevice } from '../../src/commands/handoffDevice.js'
import { recordSession } from '../../src/commands/handoffStore.js'
import { callHandoffTool } from '../../src/commands/handoffMcp.js'
import { runNow } from '../../src/commands/handoffNow.js'
import { qmcodeRolloutPath } from './support/handoffSamples.js'
import { git, laptop, startTestNode } from './support/handoffNodeFixtures.js'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})
const DEVICE = 'd-aaaaaaaaaaaa'
const ACTOR = { deviceId: DEVICE, owner: 'legacy:admin' }
const TOKEN = 'p26-token-never-persist-123456789'
const output = { out(_line: string) {}, err(_line: string) {} }

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p26-test-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function env(key: string, value: string): void {
  const old = process.env[key]
  process.env[key] = value
  cleanups.push(() => {
    if (old === undefined) delete process.env[key]
    else process.env[key] = old
  })
}
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

async function fixture(id = 'github-task') {
  const root = temp()
  const from = await laptop(root, { device: DEVICE })
  const remote = path.join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', remote)
  git(from.work, 'remote', 'add', 'origin', remote)
  const manifest: HandoffManifest = {
    ...from.manifest,
    code: {
      repo: 'test/demo',
      wip: {
        ref: githubHandoffRef('wip', DEVICE, id),
        commit: from.manifest.wip,
      },
      sessions: {
        ref: githubHandoffRef('sessions', DEVICE, id),
        commit: from.manifest.sessionCommit,
      },
    },
  }
  git(
    from.work,
    'push',
    '-q',
    remote,
    `${manifest.wip}:${manifest.code!.wip.ref}`,
    `${manifest.sessionCommit}:${manifest.code!.sessions!.ref}`,
  )
  let revoked = false
  const calls: string[] = []
  const credentials = {
    async resolve(repo: string) {
      calls.push(repo)
      return !revoked && repo === 'test/demo'
        ? { remoteUrl: `file://${remote}`, token: TOKEN }
        : null
    },
  }
  const ledgerPath = path.join(root, 'hub', 'ledger.ndjson')
  const auditPath = path.join(root, 'hub', 'audit.ndjson')
  const logs: string[] = []
  return {
    root,
    from,
    remote,
    manifest,
    credentials,
    calls,
    ledgerPath,
    auditPath,
    logs,
    revoke() {
      revoked = true
    },
  }
}

test('origin parsing rejects other hosts, traversal, URL credentials and .git residues; CLI port cannot redirect GitHub', async () => {
  expect(githubRepoFromOrigin('https://github.com/test/demo.git')).toBe(
    'test/demo',
  )
  expect(githubRepoFromOrigin('git@github.com:test/demo')).toBe('test/demo')
  for (const origin of [
    'file:///tmp/repo',
    'https://github.com.evil/test/demo',
    'https://token@github.com/test/demo',
    'https://github.com/test/../demo',
    'git@github.com:test/demo.git.git',
  ])
    expect(githubRepoFromOrigin(origin)).toBeNull()
  const root = temp()
  const file = path.join(root, 'token')
  fs.writeFileSync(file, TOKEN, { mode: 0o600 })
  const port = cliHandoffRepoCredentials([['test/demo', file]])
  expect(await port.resolve('test/demo')).toEqual({
    remoteUrl: 'https://github.com/test/demo.git',
    token: TOKEN,
  })
  expect(await port.resolve('test/no-connection')).toBeNull()
  expect(
    parseConsoleArgs([
      '--handoff-repo',
      `test/demo=${file}`,
      '--handoff-node',
      'cloud=ws://localhost:1234',
    ]).handoffNodes,
  ).toEqual([{ node: 'cloud', url: 'ws://localhost:1234/' }])
  for (const value of [
    `test/demo.git=${file}`,
    `test/..=${file}`,
    `file:///tmp/repo=${file}`,
  ])
    expect(() => parseConsoleArgs(['--handoff-repo', value])).toThrow()
  const link = path.join(root, 'link')
  fs.symlinkSync(file, link)
  expect(() => cliHandoffRepoCredentials([['test/demo', link]])).toThrow()
  fs.chmodSync(file, 0o644)
  expect(await port.resolve('test/demo')).toBeNull()
  expect(() => cliHandoffRepoCredentials([['test/demo', file]])).toThrow()
  for (const url of [
    'wss://node.example/x',
    'ws://localhost/x',
    'ws://127.0.0.1/x',
    'ws://[::1]/x',
  ])
    expect(tokenLinkAllowed(url)).toBe(true)
  expect(tokenLinkAllowed('ws://192.0.2.1/x')).toBe(false)
})

test('registration refuses forged device refs, wrong hashes, missing credentials and another account over device HTTP', async () => {
  const f = await fixture()
  const hub = openConsoleHandoff({
    ...f,
    root: undefined,
    onError: line => f.logs.push(line),
  })
  cleanups.push(() => hub.close())
  const code = f.manifest.code!
  expect(
    await hub.port.accept(
      {
        ...f.manifest,
        code: {
          ...code,
          wip: {
            ...code.wip,
            ref: githubHandoffRef('wip', 'd-bbbbbbbbbbbb', 'github-task'),
          },
        },
      },
      ACTOR,
    ),
  ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
  expect(
    await hub.port.accept(
      {
        ...f.manifest,
        device: 'd-bbbbbbbbbbbb',
        sessionRef: f.manifest.sessionRef.replace(DEVICE, 'd-bbbbbbbbbbbb'),
      },
      ACTOR,
    ),
  ).toMatchObject({ ok: false })
  const bad = 'a'.repeat(40)
  expect(
    await hub.port.accept(
      {
        ...f.manifest,
        wip: bad,
        code: { ...code, wip: { ...code.wip, commit: bad } },
      },
      ACTOR,
    ),
  ).toMatchObject({
    ok: false,
    failure: { message: '仓库引用与声明的提交不一致' },
  })
  expect(
    await hub.port.accept(
      { ...f.manifest, code: { ...code, repo: 'test/missing' } },
      ACTOR,
    ),
  ).toMatchObject({ ok: false, failure: { message: '中枢没有这个仓库的连接' } })
  expect(
    await hub.port.accept(
      {
        ...f.manifest,
        wip: 'deadbeef',
        code: { ...code, wip: { ...code.wip, commit: 'deadbeef' } },
      },
      ACTOR,
    ),
  ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
  expect(await hub.port.accept(f.manifest, ACTOR)).toMatchObject({ ok: true })
  const accounts = accountsHarness()
  await person(accounts.handle, 'member')
  const listed = accounts.book.list()
  if (!listed.ok || !listed.value.accounts[0])
    throw new Error('account missing')
  const owner = listed.value.accounts[0].subject
  const devices = openConsoleHandoffDevices({
    path: path.join(f.root, 'devices.ndjson'),
    accounts: accounts.book,
  })
  cleanups.push(() => devices.close())
  const issued = await devices.issuePairing(
    { subject: owner, role: 'member', requestId: 'test' },
    'http://127.0.0.1',
  )
  if (!issued.ok) throw new Error('pair failed')
  const paired = await devices.pair!(
    { code: issued.value.code, name: 'other', platform: null },
    'local',
  )
  if (!paired.ok) throw new Error('pair failed')
  const harness = accountsHarness({
    ledger: accounts.ledger,
    sessions: accounts.sessions,
    clock: accounts.clock,
    deps: { handoff: hub.port, handoffDevices: devices },
  })
  const request = (url: string, method = 'GET', body?: unknown) =>
    new Request(`http://127.0.0.1${url}`, {
      method,
      headers: {
        authorization: `Bearer ${paired.value.token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  expect(
    (await harness.handle(request('/v0/handoff/github-task'))).status,
  ).toBe(404)
  expect(
    (await harness.handle(request('/v0/handoff', 'POST', f.manifest))).status,
  ).toBe(400)
  expect(
    (
      await harness.handle(
        request('/v0/handoff/github-task/return', 'POST', {}),
      )
    ).status,
  ).toBe(404)
  expect(
    await hub.port.list({
      deviceId: paired.value.deviceId,
      owner,
    }),
  ).toMatchObject({ ok: true, value: [] })
})

for (const failure of ['unsafe', 'revoked', 'wrong-result'] as const) {
  test(`dispatch ${failure} fails without leaking a token or fetching objects`, async () => {
    const f = await fixture()
    const seen: QianmoMessage[] = []
    const server = startTransportServer({
      port: 0,
      hostname: '127.0.0.1',
      psk: 'ab'.repeat(32),
      onMessage(message, context) {
        seen.push(message)
        if (message.type !== MessageType.TaskRequest) return
        context.channel.send(createAck(message, 'qianmo://cloud/handoff'))
        const result: HandoffResult = {
          status: 'completed',
          branch: `qianmo/${message.taskId}`,
          head: 'b'.repeat(40),
          threadId: 'thread',
          summary: 'done',
          result: {
            ref: githubResultRef(message.taskId),
            commit: 'b'.repeat(40),
          },
        }
        context.channel.send(
          createTaskResult(message, 'qianmo://cloud/handoff', {
            outcome: 'completed',
            content: encodeResultContent(result),
          }),
        )
      },
    })
    cleanups.push(() => server.stop())
    const issue = createConsoleWakeIssuer('hub', generateNodeKeyPair())
    const hub = openConsoleHandoff({
      ...f,
      root: undefined,
      onError: line => f.logs.push(line),
      dispatch: {
        status: 'test',
        config: {
          nodes: [
            {
              node: 'cloud',
              url: `ws://${failure === 'unsafe' ? '192.0.2.1' : '127.0.0.1'}:${server.port}`,
              psk: 'ab'.repeat(32),
            },
          ],
          from: 'qianmo://hub/console',
          issueCapability: issue,
          pingIntervalMs: 25,
          deliverTtlMs: 40,
          receiptTimeoutMs: 1000,
        },
      },
    })
    cleanups.push(() => hub.close())
    expect(await hub.port.accept(f.manifest, ACTOR)).toMatchObject({ ok: true })
    if (failure === 'revoked') f.revoke()
    if (failure === 'wrong-result')
      git(
        f.from.work,
        'push',
        '-q',
        f.remote,
        `${f.manifest.wip}:${githubResultRef('github-task')}`,
      )
    hub.start()
    await until(async () => {
      const t = await hub.port.get('github-task')
      return t.ok && t.value.state === 'failed'
    })
    expect(await hub.port.get('github-task')).toMatchObject({
      ok: true,
      value: {
        reason:
          failure === 'unsafe'
            ? '令牌只经加密链路下发'
            : failure === 'revoked'
              ? '仓库连接已撤销'
              : '结果引用与声明的提交不一致',
      },
    })
    if (failure !== 'wrong-result') expect(seen).toEqual([])
    expect(fs.readFileSync(f.ledgerPath, 'utf8')).not.toContain(TOKEN)
    expect(f.logs.join('\n')).not.toContain(TOKEN)
  }, 20_000)
}

test('hub restart mid-run resends with a newly resolved token; node replays its stored result and removes work', async () => {
  const f = await fixture('restart-task')
  env('QIANMO_CONFIG_DIR', path.join(f.root, 'node-config'))
  const node = await startTestNode(f.root, {
    bridge: { projects: [], githubRemote: () => `file://${f.remote}` },
    fake: {
      hold: true,
      work: turn =>
        fs.writeFileSync(path.join(turn.cwd, 'result.txt'), 'result\n'),
    },
  })
  cleanups.push(async () => {
    node.fake.stop()
    await node.handle.stop()
  })
  const config = {
    nodes: [{ node: node.node, url: node.handle.url, psk: node.psk }],
    from: 'qianmo://hub/console',
    issueCapability: node.issue,
    pingIntervalMs: 25,
    deliverTtlMs: 60,
    receiptTimeoutMs: 1000,
  }
  let hub = openConsoleHandoff({
    ...f,
    root: undefined,
    onError: line => f.logs.push(line),
    dispatch: { config, status: 'test' },
  })
  cleanups.push(() => hub.close())
  expect(await hub.port.accept(f.manifest, ACTOR)).toMatchObject({ ok: true })
  hub.start()
  await until(async () => node.fake.turns.length === 1)
  hub.close()
  node.fake.release()
  await node.handle.idle()
  const before = f.calls.length
  hub = openConsoleHandoff({
    ...f,
    root: undefined,
    onError: line => f.logs.push(line),
    dispatch: { config, status: 'test' },
  })
  hub.start()
  await until(async () => {
    const t = await hub.port.get('restart-task')
    return t.ok && t.value.state === 'done'
  })
  await node.handle.idle()
  expect(f.calls.length).toBeGreaterThan(before)
  expect(node.fake.turns).toHaveLength(1)
  expect(node.logs.join('\n')).toContain('已收尾，重发结果')
  expect(
    fs.existsSync(
      qianmoConfigPath('qianmo', 'handoff', 'work', 'restart-task'),
    ),
  ).toBe(false)
  expect(
    fs.readFileSync(
      path.join(node.root, 'state', 'results', 'restart-task.json'),
      'utf8',
    ),
  ).not.toContain(TOKEN)
}, 25_000)

test('janitor deletes only refs of failures outside retention, audits each cleanup, and replays cleaned hashes', async () => {
  const f = await fixture('old-task')
  const recent: HandoffManifest = {
    ...f.manifest,
    code: {
      ...f.manifest.code!,
      wip: {
        ...f.manifest.code!.wip,
        ref: githubHandoffRef('wip', DEVICE, 'recent-task'),
      },
      sessions: {
        ...f.manifest.code!.sessions!,
        ref: githubHandoffRef('sessions', DEVICE, 'recent-task'),
      },
    },
  }
  git(
    f.from.work,
    'push',
    '-q',
    f.remote,
    `${recent.wip}:${recent.code!.wip.ref}`,
    `${recent.sessionCommit}:${recent.code!.sessions!.ref}`,
    `${f.manifest.wip}:${githubResultRef('old-task')}`,
  )
  let at = Date.now()
  const ledger = HandoffLedger.open(f.ledgerPath, { now: () => at })
  ledger.accept('old-task', f.manifest, ACTOR)
  ledger.fail('old-task', 'deadline expired')
  at += 8 * 86400_000
  ledger.accept('recent-task', recent, ACTOR)
  ledger.fail('recent-task', 'failed recently')
  ledger.close()
  const hub = openConsoleHandoff({
    ...f,
    root: undefined,
    now: () => at,
    onError: line => f.logs.push(line),
  })
  cleanups.push(() => hub.close())
  await hub.janitor()
  const refs = git(f.from.work, 'ls-remote', f.remote)
  expect(refs).not.toContain('/old-task')
  expect(refs).toContain('/recent-task')
  expect(
    readTrail(f.auditPath)
      .records.filter(row => row.kind === 'handoff.cleaned')
      .map(row => row.taskId),
  ).toEqual(['old-task'])
  hub.close()
  const replay = HandoffLedger.open(f.ledgerPath)
  cleanups.push(() => replay.close())
  expect(replay.get('old-task')).toMatchObject({
    code: { cleaned: true, wip: { commit: f.manifest.wip } },
  })
  expect(replay.get('recent-task')?.code?.cleaned).toBeUndefined()
})

test('visibility failure pushes no session; non-GitHub origin is rejected before push', async () => {
  const f = await fixture('visibility-task')
  const project = {
    root: f.from.work,
    project: 'atlas',
    device: DEVICE,
    hub: { kind: 'local' as const, root: f.root },
    console: 'http://127.0.0.1',
  }
  await expect(syncGithub(project, [])).rejects.toThrow('origin 不是 GitHub')
  const file = qmcodeRolloutPath(
    path.join(f.root, 'laptop-qmcode'),
    f.manifest.sessionId,
  )
  const synced = await syncGithub(
    project,
    [
      {
        tool: f.manifest.tool,
        sessionId: f.manifest.sessionId,
        file,
        content: fs.readFileSync(file),
      },
    ],
    {
      repo: 'test/demo',
      taskId: 'unknown-task',
      probe: async () => {
        throw new Error('rate limited')
      },
    },
  )
  expect(synced.code).toMatchObject({
    sessions: null,
    reason: '仓库可见性未知，不推送会话记录',
  })
  expect(git(f.from.work, 'ls-remote', f.remote)).not.toContain(
    `/sessions/${DEVICE}/unknown-task`,
  )
  // Invalid names never reach the network, even through the production probe.
  expect(await probeGithubVisibility('test/../demo')).toBe('unknown')
})

test('unauthenticated visibility probe distinguishes public, 404 and uncertainty; never sends authorization', async () => {
  const fetchSurface: {
    fetch: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>
  } = globalThis
  const fetcher = spyOn(fetchSurface, 'fetch')
  try {
    let headers: Headers | undefined
    for (const [status, body, expected] of [
      [200, { private: false }, 'public'],
      [404, {}, 'private'],
      [429, {}, 'unknown'],
      [200, {}, 'unknown'],
    ] as const) {
      fetcher.mockImplementation(async (_url, options) => {
        headers = new Headers(options?.headers)
        return Response.json(body, { status })
      })
      expect(await probeGithubVisibility('test/demo')).toBe(expected)
      expect(headers?.has('authorization')).toBe(false)
    }
    fetcher.mockImplementation(async () => {
      throw new Error('network failed')
    })
    expect(await probeGithubVisibility('test/demo')).toBe('unknown')
  } finally {
    fetcher.mockRestore()
  }
})

test('device clean removes only its own finished branches; MCP explains omitted sessions and still registers code-only handoff', async () => {
  const f = await fixture('cleanup-task')
  env('QIANMO_CONFIG_DIR', path.join(f.root, 'device-config'))
  env('CODEX_HOME', path.join(f.root, 'empty-codex'))
  env('QMCODE_HOME', path.join(f.root, 'empty-qmcode'))
  const devices = openConsoleHandoffDevices({
    path: path.join(f.root, 'devices.ndjson'),
  })
  cleanups.push(() => devices.close())
  let handle = accountsHarness({ deps: { handoffDevices: devices } }).handle
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => handle(request),
  })
  cleanups.push(() => server.stop(true))
  const url = `http://127.0.0.1:${server.port}`
  const pair = await devices.issuePairing(
    { subject: 'legacy:admin', role: null, requestId: 'test' },
    url,
  )
  if (!pair.ok) throw new Error('pair failed')
  const device = await loginDevice(url, pair.value.code, 'clean-client')
  const own: HandoffManifest = {
    ...f.manifest,
    device: device.deviceId,
    sessionRef: f.manifest.sessionRef.replace(DEVICE, device.deviceId),
    code: {
      ...f.manifest.code!,
      wip: {
        ...f.manifest.code!.wip,
        ref: githubHandoffRef('wip', device.deviceId, 'cleanup-task'),
      },
      sessions: {
        ...f.manifest.code!.sessions!,
        ref: githubHandoffRef('sessions', device.deviceId, 'cleanup-task'),
      },
    },
  }
  git(
    f.from.work,
    'push',
    '-q',
    f.remote,
    `${own.wip}:${own.code!.wip.ref}`,
    `${own.sessionCommit}:${own.code!.sessions!.ref}`,
  )
  const ledger = HandoffLedger.open(f.ledgerPath)
  ledger.accept('cleanup-task', own, {
    deviceId: device.deviceId,
    owner: 'legacy:admin',
  })
  ledger.fail('cleanup-task', 'failed')
  // The other device belongs to the same account: list access is allowed,
  // but clean must still not remove its refs.
  const other: HandoffManifest = {
    ...f.manifest,
    code: {
      ...f.manifest.code!,
      wip: {
        ...f.manifest.code!.wip,
        ref: githubHandoffRef('wip', DEVICE, 'other-task'),
      },
      sessions: {
        ...f.manifest.code!.sessions!,
        ref: githubHandoffRef('sessions', DEVICE, 'other-task'),
      },
    },
  }
  git(
    f.from.work,
    'push',
    '-q',
    f.remote,
    `${other.wip}:${other.code!.wip.ref}`,
    `${other.sessionCommit}:${other.code!.sessions!.ref}`,
  )
  ledger.accept('other-task', other, ACTOR)
  ledger.fail('other-task', 'failed')
  ledger.close()
  const hub = openConsoleHandoff({
    ...f,
    root: undefined,
    onError: line => f.logs.push(line),
  })
  cleanups.push(() => hub.close())
  handle = accountsHarness({
    deps: { handoffDevices: devices, handoff: hub.port },
  }).handle
  expect(
    await runClean(
      f.from.work,
      { taskId: 'other-task', repo: 'test/demo' },
      output,
    ),
  ).toBe(0)
  expect(git(f.from.work, 'ls-remote', f.remote)).toContain('/other-task')
  expect(
    await runClean(
      f.from.work,
      { taskId: 'cleanup-task', repo: 'test/demo' },
      output,
    ),
  ).toBe(0)
  expect(git(f.from.work, 'ls-remote', f.remote)).not.toContain(
    `${device.deviceId}/cleanup-task`,
  )
  expect(await hub.port.get('cleanup-task')).toMatchObject({
    ok: true,
    value: { state: 'failed', code: { cleaned: true } },
  })
  expect(git(f.from.work, 'ls-remote', f.remote)).toContain('/other-task')
  const result = await callHandoffTool(
    f.from.work,
    'qianmo_handoff',
    { goal: 'code only', done: '', remaining: '' },
    undefined,
    { repo: 'test/demo', probe: async () => 'public', taskId: 'mcp-task' },
  )
  expect(result.isError).toBeUndefined()
  expect(JSON.stringify(result)).toContain('公开仓库不推送会话记录')
  expect(await hub.port.get('mcp-task')).toMatchObject({
    ok: true,
    value: { code: { sessions: null }, state: 'accepted' },
  })
  expect(git(f.from.work, 'ls-remote', f.remote)).not.toContain(
    `/sessions/${device.deviceId}/mcp-task`,
  )
}, 20_000)

test('E_BUSY retries with a newly resolved token instead of persisting or reusing the first payload', async () => {
  const f = await fixture('busy-task')
  let token = TOKEN
  const sent: string[] = []
  const server = startTransportServer({
    port: 0,
    hostname: '127.0.0.1',
    psk: 'cd'.repeat(32),
    onMessage(message, context) {
      if (message.type !== MessageType.TaskRequest) return
      const payload = message.payload as { credential: { token: string } }
      sent.push(payload.credential.token)
      if (sent.length === 1) {
        token = 'p26-rotated-token-0123456789'
        context.channel.send(
          errorReply(message, ProtocolErrorCode.E_BUSY, 'busy'),
        )
        return
      }
      context.channel.send(createAck(message, 'qianmo://cloud/handoff'))
      const result: HandoffResult = {
        status: 'completed',
        branch: `qianmo/${message.taskId}`,
        head: f.manifest.wip,
        threadId: 'thread',
        summary: 'done',
        result: {
          ref: githubResultRef(message.taskId),
          commit: f.manifest.wip,
        },
      }
      context.channel.send(
        createTaskResult(message, 'qianmo://cloud/handoff', {
          outcome: 'completed',
          content: encodeResultContent(result),
        }),
      )
    },
  })
  cleanups.push(() => server.stop())
  git(
    f.from.work,
    'push',
    '-q',
    f.remote,
    `${f.manifest.wip}:${githubResultRef('busy-task')}`,
  )
  const hub = openConsoleHandoff({
    ...f,
    root: undefined,
    credentials: {
      async resolve() {
        return { remoteUrl: `file://${f.remote}`, token }
      },
    },
    onError: line => f.logs.push(line),
    dispatch: {
      status: 'test',
      config: {
        nodes: [
          {
            node: 'cloud',
            url: `ws://127.0.0.1:${server.port}`,
            psk: 'cd'.repeat(32),
          },
        ],
        from: 'qianmo://hub/console',
        issueCapability: createConsoleWakeIssuer('hub', generateNodeKeyPair()),
        pingIntervalMs: 20,
        deliverTtlMs: 50,
        receiptTimeoutMs: 1000,
      },
    },
  })
  cleanups.push(() => hub.close())
  expect(await hub.port.accept(f.manifest, ACTOR)).toMatchObject({ ok: true })
  hub.start()
  await until(async () => {
    const task = await hub.port.get('busy-task')
    return task.ok && task.value.state === 'done'
  })
  expect(sent).toEqual([TOKEN, token])
  expect(f.logs.join('\n')).toContain('E_BUSY')
  for (const secret of sent) {
    expect(fs.readFileSync(f.ledgerPath, 'utf8')).not.toContain(secret)
    expect(f.logs.join('\n')).not.toContain(secret)
  }
}, 20_000)
