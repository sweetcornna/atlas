// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 添加服务器（`node-provisioning.md` §14）在宿主这一侧的两半：执行器的请求解析与
 * 进度折叠（`replicate.ts`），以及控制台端口的票、指纹核对、请求文件与单作业锁
 * （`consoleReplicate.ts`）。端口的子进程换成假的：这里不拨任何 SSH。
 *
 * 真 SSH 的那一趟在容器里跑（PR 说明里的端到端记录），这里钉的是不靠网络也能判定
 * 的部分，尤其是凭据的去向：检查的回包里没有它，开始之后票作废，请求文件 0600。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPLICATE_STEPS } from '@qianmo/console'
import {
  foldJob,
  openConsoleReplicate,
  type ReplicateLauncher,
  suggestNode,
} from '../../src/commands/consoleReplicate.js'
import {
  parseInspectRequest,
  parseRunRequest,
  shellQuote,
  STEPS,
} from '../../src/commands/replicate.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-replicate-'))
  roots.push(root)
  return root
}

const FINGERPRINT = `SHA256:${'A'.repeat(43)}`

const REPORT = {
  ok: true,
  hostKeys: [{ type: 'ssh-ed25519', fingerprint: FINGERPRINT }],
  os: 'Linux',
  arch: 'x86_64',
  kernel: '6.1.0',
  memMb: 3900,
  availMb: 3000,
  diskMb: 40000,
  existing: false,
  supported: true,
}

function fakeLauncher(report: object = REPORT): ReplicateLauncher & {
  readonly inspected: string[]
  readonly launched: { job: string; file: string; body: string; mode: number }[]
} {
  const inspected: string[] = []
  const launched: { job: string; file: string; body: string; mode: number }[] =
    []
  return {
    inspected,
    launched,
    async inspect(request) {
      inspected.push(request)
      return `${JSON.stringify(report)}\n`
    },
    async launch(job, file) {
      launched.push({
        job,
        file,
        body: readFileSync(file, 'utf8'),
        mode: statSync(file).mode & 0o777,
      })
    },
  }
}

const TARGET = {
  host: '203.0.113.7',
  port: 22,
  user: 'root',
  auth: { kind: 'password' as const, secret: "pa ss'word" },
}

describe('requests', () => {
  test('inspect: a host, a user and one credential', () => {
    const ok = parseInspectRequest({
      v: 1,
      op: 'inspect',
      target: { host: '203.0.113.7', user: 'root' },
      auth: { kind: 'password', secret: 'x' },
      tree: '/home/u/atlas-beta',
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.target.port).toBe(22)
    for (const [target, auth] of [
      [
        { host: 'a b', user: 'root' },
        { kind: 'password', secret: 'x' },
      ],
      [
        { host: '-oProxyCommand=x', user: 'root' },
        { kind: 'password', secret: 'x' },
      ],
      [
        { host: 'h.example', user: '-l' },
        { kind: 'password', secret: 'x' },
      ],
      [
        { host: 'h.example', user: 'root', port: 0 },
        { kind: 'password', secret: 'x' },
      ],
      [
        { host: 'h.example', user: 'root' },
        { kind: 'password', secret: 'a\nb' },
      ],
      [
        { host: 'h.example', user: 'root' },
        { kind: 'key', secret: 'not a key' },
      ],
      [
        { host: 'h.example', user: 'root' },
        { kind: 'token', secret: 'x' },
      ],
    ] as const) {
      expect(
        parseInspectRequest({ v: 1, op: 'inspect', target, auth, tree: '/t' })
          .ok,
      ).toBe(false)
    }
  })

  test('run: names, a SHA256 fingerprint and a loopback console', () => {
    const base = {
      v: 1,
      op: 'run',
      job: 'abc123-0011',
      target: { host: 'h.example', port: 2222, user: 'ops' },
      auth: {
        kind: 'key',
        secret:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----',
      },
      hostKey: FINGERPRINT,
      node: 'n113-7',
      agent: 'main',
      server: '203.0.113.7',
      root: '/home/u/qianmo-beta',
      tree: '/home/u/atlas-beta',
      consoleUrl: 'http://127.0.0.1:38600',
    }
    expect(parseRunRequest(base).ok).toBe(true)
    expect(parseRunRequest({ ...base, node: 'N1' }).ok).toBe(false)
    expect(parseRunRequest({ ...base, node: '-x' }).ok).toBe(false)
    expect(parseRunRequest({ ...base, hostKey: 'MD5:aa' }).ok).toBe(false)
    expect(
      parseRunRequest({ ...base, consoleUrl: 'http://10.0.0.1:1' }).ok,
    ).toBe(false)
    expect(parseRunRequest({ ...base, root: '/a/../b' }).ok).toBe(false)
  })

  test('a word for the remote shell stays one word', () => {
    expect(shellQuote(`it's; rm -rf ~`)).toBe(`'it'\\''s; rm -rf ~'`)
  })

  test('the page names the same steps the job runs', () => {
    expect(REPLICATE_STEPS.map(([step]) => step)).toEqual([...STEPS])
  })
})

describe('suggested names', () => {
  test('from an address, never one already taken', () => {
    expect(suggestNode('203.0.113.7', new Set())).toBe('n113-7')
    expect(suggestNode('203.0.113.7', new Set(['n113-7']))).toBe('n113-7-2')
    expect(suggestNode('Box-1.example.com', new Set())).toBe('box-1')
  })
})

describe('job logs', () => {
  const at = (s: number) =>
    new Date(Date.UTC(2026, 9, 14, 0, 0, s)).toISOString()
  const line = (event: object) => JSON.stringify(event)

  test('running, then done with the address', () => {
    const text = [
      line({
        at: at(0),
        job: 'j',
        step: 'queued',
        state: 'info',
        node: 'n1',
        agent: 'main',
        host: 'h',
      }),
      line({ at: at(1), job: 'j', step: 'pin', state: 'start' }),
      line({ at: at(2), job: 'j', step: 'pin', state: 'ok' }),
      line({ at: at(3), job: 'j', step: 'login', state: 'start' }),
    ].join('\n')
    const running = foldJob('j', text, Date.parse(at(4)))
    expect(running).toMatchObject({
      state: 'running',
      step: 'login',
      node: 'n1',
      host: 'h',
    })
    const done = foldJob(
      'j',
      `${text}\n${line({ at: at(9), job: 'j', step: 'done', state: 'ok', address: 'qianmo://n1/main' })}`,
      Date.parse(at(10)),
    )
    expect(done).toMatchObject({ state: 'done', address: 'qianmo://n1/main' })
  })

  test('a failure keeps its step; rollback lines do not move it', () => {
    const text = [
      line({
        at: at(0),
        step: 'queued',
        state: 'info',
        node: 'n1',
        agent: 'a',
        host: 'h',
      }),
      line({ at: at(1), step: 'payload', state: 'start' }),
      line({
        at: at(2),
        step: 'payload',
        state: 'fail',
        detail: '复制部署树失败',
      }),
      line({
        at: at(3),
        step: 'rollback',
        state: 'info',
        detail: '已撤回：目标机上的部署树',
      }),
    ].join('\n')
    expect(foldJob('j', text, Date.parse(at(4)))).toMatchObject({
      state: 'failed',
      step: 'payload',
      error: '复制部署树失败',
    })
  })

  test('a running job silent for 40 minutes is reported dead', () => {
    const text = line({ at: at(0), step: 'pin', state: 'start' })
    expect(foldJob('j', text, Date.parse(at(0)) + 41 * 60_000)?.state).toBe(
      'failed',
    )
  })
})

describe('the console port', () => {
  test('inspect returns a ticket and no credential', async () => {
    const root = tempRoot()
    const launcher = fakeLauncher()
    const port = openConsoleReplicate(
      {
        root,
        tree: '/srv/atlas-beta',
        consoleUrl: 'http://127.0.0.1:38600',
        mainAgent: 'qianmo://hub/planner',
      },
      { launcher },
    )
    const found = await port.inspect(TARGET)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(JSON.stringify(found.value)).not.toContain(TARGET.auth.secret)
    expect(found.value.suggested).toEqual({
      node: 'n113-7',
      agent: 'planner',
      server: '203.0.113.7',
    })
    // The child got the credential on stdin, once.
    expect(launcher.inspected).toHaveLength(1)
    expect(JSON.parse(launcher.inspected[0] ?? '{}').auth.secret).toBe(
      TARGET.auth.secret,
    )
  })

  test('start: the confirmed fingerprint, a 0600 request, the ticket spent', async () => {
    const root = tempRoot()
    const launcher = fakeLauncher()
    const port = openConsoleReplicate(
      { root, tree: '/srv/atlas-beta', consoleUrl: 'http://127.0.0.1:38600' },
      { launcher },
    )
    const found = await port.inspect(TARGET)
    if (!found.ok) throw new Error('inspect')
    const wrong = await port.start({
      ticket: found.value.ticket,
      fingerprint: `SHA256:${'B'.repeat(43)}`,
      node: 'n1',
      agent: 'main',
      server: 's1',
    })
    expect(wrong.ok).toBe(false)
    const started = await port.start({
      ticket: found.value.ticket,
      fingerprint: FINGERPRINT,
      node: 'n1',
      agent: 'main',
      server: 's1',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.value).toMatchObject({
      state: 'running',
      node: 'n1',
      host: '203.0.113.7',
    })
    const [launched] = launcher.launched
    expect(launched?.mode).toBe(0o600)
    expect(JSON.parse(launched?.body ?? '{}')).toMatchObject({
      op: 'run',
      hostKey: FINGERPRINT,
      node: 'n1',
      root,
      auth: TARGET.auth,
    })
    // The progress log is the job's, and has no credential in it.
    const logs = readdirSync(join(root, 'state', 'replicate'))
    for (const name of logs.filter(name => name.endsWith('.ndjson'))) {
      expect(
        readFileSync(join(root, 'state', 'replicate', name), 'utf8'),
      ).not.toContain(TARGET.auth.secret)
    }
    const again = await port.start({
      ticket: found.value.ticket,
      fingerprint: FINGERPRINT,
      node: 'n2',
      agent: 'main',
      server: 's1',
    })
    expect(again.ok).toBe(false)
  })

  test('one job at a time, and a node name already in peers.conf is refused', async () => {
    const root = tempRoot()
    writeFileSync(
      join(root, 'peers.conf'),
      'qianmo://taken/main  ws://127.0.0.1:38631\n',
    )
    const launcher = fakeLauncher()
    const port = openConsoleReplicate(
      { root, tree: '/srv/atlas-beta', consoleUrl: 'http://127.0.0.1:38600' },
      { launcher },
    )
    const first = await port.inspect(TARGET)
    const second = await port.inspect(TARGET)
    if (!first.ok || !second.ok) throw new Error('inspect')
    const taken = await port.start({
      ticket: first.value.ticket,
      fingerprint: FINGERPRINT,
      node: 'taken',
      agent: 'main',
      server: 's',
    })
    expect(taken.ok).toBe(false)
    const third = await port.inspect(TARGET)
    if (!third.ok) throw new Error('inspect')
    expect(
      (
        await port.start({
          ticket: second.value.ticket,
          fingerprint: FINGERPRINT,
          node: 'a1',
          agent: 'main',
          server: 's',
        })
      ).ok,
    ).toBe(true)
    const busy = await port.start({
      ticket: third.value.ticket,
      fingerprint: FINGERPRINT,
      node: 'a2',
      agent: 'main',
      server: 's',
    })
    expect(busy.ok).toBe(false)
    if (!busy.ok) expect(busy.failure.code).toBe('refused')
    const jobs = await port.jobs()
    expect(jobs.ok && jobs.value.map(job => job.node)).toEqual(['a1'])
  })

  test('a server that failed the check cannot be started', async () => {
    const root = tempRoot()
    const port = openConsoleReplicate(
      { root, tree: '/srv/atlas-beta', consoleUrl: 'http://127.0.0.1:38600' },
      {
        launcher: fakeLauncher({
          ...REPORT,
          supported: false,
          reason: '目标机缺 tar',
        }),
      },
    )
    const found = await port.inspect(TARGET)
    if (!found.ok) throw new Error('inspect')
    expect(found.value.reason).toBe('目标机缺 tar')
    const started = await port.start({
      ticket: found.value.ticket,
      fingerprint: FINGERPRINT,
      node: 'n1',
      agent: 'main',
      server: 's',
    })
    expect(started.ok).toBe(false)
  })

  test('a refused login comes back as rejected, with its reason', async () => {
    const root = tempRoot()
    const port = openConsoleReplicate(
      { root, tree: '/srv/atlas-beta', consoleUrl: 'http://127.0.0.1:38600' },
      {
        launcher: fakeLauncher({
          ok: false,
          code: 'auth',
          reason: '登录被拒 · 用户名 口令或私钥不对',
        }),
      },
    )
    const found = await port.inspect(TARGET)
    expect(found).toEqual({
      ok: false,
      failure: {
        code: 'rejected',
        message: '登录被拒 · 用户名 口令或私钥不对',
      },
    })
  })
})
