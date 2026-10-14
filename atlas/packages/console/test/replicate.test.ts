// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 添加服务器（`node-provisioning.md` §14）在控制台包里的部分：`/v0/replicate/*` 的
 * 守卫与账本、服务器页上的那一块、对话前台的卡片，以及前台认出 SSH 登录信息的
 * `sshIntent`。端口是手写的假端口，不拨任何 SSH。
 *
 * 钉住的几件事：
 * - 检查与开始只有 admin（ops）能做，只读令牌 403、端口一次都没被调；
 * - 账本里的 target 是 `user@host:port` 或节点名，**没有口令**；
 * - 回包里没有凭据（假端口如实把凭据留在自己手里）；
 * - 没开 `--replicate` 的控制台：API 501，服务器页没有这一块，前台没有卡片；
 * - 聊天消息里带私钥，服务端拒收，不交给对话端口；
 * - `sshIntent` 认得常见写法，也不把「密码怎么改」当成口令。
 */

import { describe, expect, test } from 'bun:test'
import { ActionLedger } from '../src/actionLedger.js'
import type {
  ConsoleResult,
  ReplicateInspection,
  ReplicateJob,
  ReplicatePort,
  ReplicateStartInput,
  ReplicateTargetInput,
} from '../src/deps.js'
import { SSH_INTENT_JS } from '../src/view/frontReplicate.js'
import { MemoryActionStore } from './actionStore.js'
import { ADMIN, browse, call, pageHarness, VIEW } from './pageHarness.js'

const SECRET = 'correct horse battery staple'
const FINGERPRINT = `SHA256:${'A'.repeat(43)}`

const JOB: ReplicateJob = {
  job: 'kq1abc-0011aa22',
  node: 'n113-7',
  agent: 'main',
  host: '203.0.113.7',
  state: 'running',
  step: 'payload',
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_005_000,
  events: [
    { at: 1_700_000_000_000, step: 'queued', state: 'info' },
    { at: 1_700_000_001_000, step: 'pin', state: 'ok' },
    { at: 1_700_000_005_000, step: 'payload', state: 'start' },
  ],
}

class FakeReplicate implements ReplicatePort {
  readonly inspected: ReplicateTargetInput[] = []
  readonly started: ReplicateStartInput[] = []

  inspect(
    target: ReplicateTargetInput,
  ): Promise<ConsoleResult<ReplicateInspection>> {
    this.inspected.push(target)
    return Promise.resolve({
      ok: true,
      value: {
        ticket: 'ticket-1',
        host: target.host,
        port: target.port,
        user: target.user,
        hostKeys: [{ type: 'ssh-ed25519', fingerprint: FINGERPRINT }],
        os: 'Linux',
        arch: 'x86_64',
        kernel: '6.1.0',
        memMb: 3900,
        diskMb: 40_000,
        supported: true,
        suggested: { node: 'n113-7', agent: 'main', server: target.host },
        expiresAt: 1_700_000_900_000,
      },
    })
  }

  start(input: ReplicateStartInput): Promise<ConsoleResult<ReplicateJob>> {
    this.started.push(input)
    return Promise.resolve({ ok: true, value: JOB })
  }

  jobs(): Promise<ConsoleResult<readonly ReplicateJob[]>> {
    return Promise.resolve({ ok: true, value: [JOB] })
  }

  job(id: string): Promise<ConsoleResult<ReplicateJob>> {
    return Promise.resolve(
      id === JOB.job
        ? { ok: true, value: JOB }
        : {
            ok: false,
            failure: { code: 'not_found', message: '没有这个作业' },
          },
    )
  }
}

function setup(options: { readonly replicate?: boolean } = {}) {
  const store = new MemoryActionStore()
  const actions = new ActionLedger({ store })
  const replicate = new FakeReplicate()
  const harness = pageHarness({
    chat: true,
    actions,
    ports: options.replicate === false ? {} : { replicate },
  })
  return { ...harness, store, replicate }
}

const TARGET_BODY = {
  host: '203.0.113.7',
  port: 22,
  user: 'root',
  auth: { kind: 'password', secret: SECRET },
}

describe('/v0/replicate', () => {
  test('inspect: admin only, ledger without the secret, answer without it', async () => {
    const h = setup()
    const denied = await h.handle(
      call('POST', '/v0/replicate/inspect', VIEW, TARGET_BODY),
    )
    expect(denied.status).toBe(403)
    expect(h.replicate.inspected).toHaveLength(0)

    const response = await h.handle(
      call('POST', '/v0/replicate/inspect', ADMIN, TARGET_BODY),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain(SECRET)
    expect(JSON.parse(text)).toMatchObject({
      ticket: 'ticket-1',
      supported: true,
    })
    expect(h.replicate.inspected).toEqual([
      {
        host: '203.0.113.7',
        port: 22,
        user: 'root',
        auth: { kind: 'password', secret: SECRET },
      },
    ])
    const ledger = h.store.rawLines().join('\n')
    expect(ledger).toContain('server.replicate.inspect')
    expect(ledger).toContain('root@203.0.113.7:22')
    expect(ledger).not.toContain(SECRET)
  })

  test('inspect: a bad body never reaches the port', async () => {
    const h = setup()
    for (const body of [
      { ...TARGET_BODY, host: '' },
      { ...TARGET_BODY, port: 70_000 },
      { ...TARGET_BODY, auth: { kind: 'token', secret: 'x' } },
      { ...TARGET_BODY, auth: { kind: 'password', secret: '' } },
    ]) {
      const response = await h.handle(
        call('POST', '/v0/replicate/inspect', ADMIN, body),
      )
      expect(response.status).toBe(400)
    }
    expect(h.replicate.inspected).toHaveLength(0)
  })

  test('start: needs the ticket, the fingerprint and three names; 202 with the job', async () => {
    const h = setup()
    const missing = await h.handle(
      call('POST', '/v0/replicate/start', ADMIN, {
        ticket: 'ticket-1',
        node: 'n1',
      }),
    )
    expect(missing.status).toBe(400)
    const response = await h.handle(
      call('POST', '/v0/replicate/start', ADMIN, {
        ticket: 'ticket-1',
        fingerprint: FINGERPRINT,
        node: 'n113-7',
        agent: 'main',
        server: '203.0.113.7',
      }),
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      job: JOB.job,
      state: 'running',
    })
    expect(h.replicate.started).toHaveLength(1)
    expect(h.store.rawLines().join('\n')).toContain('server.replicate.start')
  })

  test('jobs: a view token may read them', async () => {
    const h = setup()
    const list = await h.handle(call('GET', '/v0/replicate/jobs', VIEW))
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ jobs: [{ node: 'n113-7' }] })
    const one = await h.handle(
      call('GET', `/v0/replicate/jobs/${JOB.job}`, VIEW),
    )
    expect(await one.json()).toMatchObject({ step: 'payload' })
    const none = await h.handle(
      call('GET', '/v0/replicate/jobs/nope-000000', VIEW),
    )
    expect(none.status).toBe(404)
  })

  test('a console without --replicate answers 501', async () => {
    const h = setup({ replicate: false })
    const response = await h.handle(
      call('POST', '/v0/replicate/inspect', ADMIN, TARGET_BODY),
    )
    expect(response.status).toBe(501)
  })
})

describe('the pages', () => {
  test('服务器 shows 添加服务器 to admin, the reason to a view token', async () => {
    const h = setup()
    const admin = await (await h.handle(browse('/admin/servers', ADMIN))).text()
    expect(admin).toContain('id="rp-inspect-form"')
    expect(admin).toContain('id="rp-progress"')
    expect(admin).toContain('data-job="kq1abc-0011aa22"')
    const view = await (await h.handle(browse('/admin/servers', VIEW))).text()
    expect(view).not.toContain('id="rp-inspect-form"')
    expect(view).toContain('只有运维账号可以添加服务器')
  })

  test('without --replicate there is no section and no front card', async () => {
    const h = setup({ replicate: false })
    const servers = await (
      await h.handle(browse('/admin/servers', ADMIN))
    ).text()
    expect(servers).not.toContain('添加服务器')
    const front = await (await h.handle(browse('/', ADMIN))).text()
    expect(front).not.toContain('id="fx-rp"')
    expect(front).not.toContain('function sshIntent')
  })

  test('the front carries the card where the console has it', async () => {
    const h = setup()
    const front = await (await h.handle(browse('/', ADMIN))).text()
    expect(front).toContain('id="fx-rp" data-mode="ops"')
    expect(front).toContain('function sshIntent')
  })

  test('the fragment lists the jobs', async () => {
    const h = setup()
    const response = await h.handle(
      call('GET', '/fragments/replicate/jobs', VIEW),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('n113-7')
  })
})

describe('a private key never reaches a model', () => {
  test('the chat send refuses it', async () => {
    const h = setup()
    const opened = await h.handle(
      call('POST', '/v0/chat/sessions', ADMIN, {
        target: 'qianmo://tokyo-hub/planner',
      }),
    )
    const session = (await opened.json()) as { id?: string }
    const id = session.id ?? 's-1'
    const sent = await h.handle(
      call('POST', `/v0/chat/sessions/${id}/messages`, ADMIN, {
        text: 'root@203.0.113.7\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
      }),
    )
    expect(sent.status).toBe(400)
    expect(JSON.stringify(h.chat)).not.toContain('PRIVATE KEY')
  })
})

describe('sshIntent', () => {
  const sshIntent = new Function(`${SSH_INTENT_JS}; return sshIntent;`)() as (
    text: string,
  ) => {
    host: string
    user: string
    port: number
    auth: { kind: string; secret: string }
  } | null

  test('user@host with a password', () => {
    expect(
      sshIntent('帮我部署到 root@203.0.113.7 密码：Abc#123，谢谢'),
    ).toEqual({
      host: '203.0.113.7',
      user: 'root',
      port: 22,
      auth: { kind: 'password', secret: 'Abc#123' },
    })
  })

  test('ssh -p, a hostname, password=', () => {
    expect(
      sshIntent('ssh -p 2222 ops@box-1.example.com password=s3cr3t'),
    ).toEqual({
      host: 'box-1.example.com',
      user: 'ops',
      port: 2222,
      auth: { kind: 'password', secret: 's3cr3t' },
    })
  })

  test('fields written apart', () => {
    expect(
      sshIntent('服务器 IP 198.51.100.20 端口 22022 用户名 ubuntu 口令 p@ss'),
    ).toEqual({
      host: '198.51.100.20',
      user: 'ubuntu',
      port: 22022,
      auth: { kind: 'password', secret: 'p@ss' },
    })
  })

  test('a private key', () => {
    const key =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'
    expect(sshIntent(`root@203.0.113.9:2200\n${key}`)).toEqual({
      host: '203.0.113.9',
      user: 'root',
      port: 2200,
      auth: { kind: 'key', secret: key },
    })
  })

  test('not credentials', () => {
    expect(sshIntent('帮我看看 203.0.113.7 上的日志')).toBeNull()
    expect(sshIntent('服务器 10.0.0.1 的密码怎么改')).toBeNull()
    expect(sshIntent('写一个 password 校验函数')).toBeNull()
  })
})
