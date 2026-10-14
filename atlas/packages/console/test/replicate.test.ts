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
 * - `sshIntent` 认得常见写法，也不把「密码怎么改」当成口令；
 * - 复制完成后的模型下发：共用令牌照旧 403；只有运维个人账号发起的作业拿得到
 *   授权，授权只换一次、只对那一个节点、以发起人的名义下发、记在发起人名下。
 */

import { describe, expect, test } from 'bun:test'
import { ActionLedger } from '../src/actionLedger.js'
import type {
  ConsoleResult,
  ReplicateInspection,
  ReplicateJob,
  ReplicateModelsClaim,
  ReplicatePort,
  ReplicateStartInput,
  ReplicateTargetInput,
} from '../src/deps.js'
import { SSH_INTENT_JS } from '../src/view/frontReplicate.js'
import {
  accountsHarness,
  asBearer,
  asSession,
  BASE,
  person,
} from './accountsHarness.js'
import { MemoryActionStore } from './actionStore.js'
import { MemoryActionLedger } from './memoryActions.js'
import { ADMIN, browse, call, pageHarness, VIEW } from './pageHarness.js'
import { FakeProviders } from './providersFake.js'

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

/** What the fake hands a job whose starter may ship its profile. */
const GRANT = 'g'.repeat(43)

class FakeReplicate implements ReplicatePort {
  readonly inspected: ReplicateTargetInput[] = []
  readonly started: ReplicateStartInput[] = []
  /** Unspent grants, as the host keeps them: the claim they buy. */
  readonly grants = new Map<string, ReplicateModelsClaim>()
  readonly claims: string[] = []

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
    if (input.modelsBy !== undefined)
      this.grants.set(GRANT, {
        job: JOB.job,
        node: input.node,
        subject: input.modelsBy,
      })
    return Promise.resolve({ ok: true, value: JOB })
  }

  claimModels(
    job: string,
    grant: string,
  ): Promise<ConsoleResult<ReplicateModelsClaim>> {
    this.claims.push(job)
    const claim = this.grants.get(grant)
    if (claim === undefined || claim.job !== job)
      return Promise.resolve({
        ok: false,
        failure: { code: 'rejected', message: '复制的下发授权不对' },
      })
    this.grants.delete(grant)
    return Promise.resolve({ ok: true, value: claim })
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

// ---------------------------------------------------------------------------
// 复制完成后的模型下发
// ---------------------------------------------------------------------------

const START_BODY = {
  ticket: 'ticket-1',
  fingerprint: FINGERPRINT,
  node: 'node-a',
  agent: 'main',
  server: 'box-a',
}

/** The job's last step: no console credential, the grant in the body. */
function shipAs(grant: unknown, job = JOB.job): Request {
  return new Request(`${BASE}/v0/replicate/jobs/${job}/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant }),
  })
}

async function modelsSetup(
  options: { readonly breakGlass?: boolean; readonly providers?: boolean } = {},
) {
  const actions = new MemoryActionLedger()
  const providers = new FakeProviders()
  const replicate = new FakeReplicate()
  const h = accountsHarness({
    deps: {
      actions,
      replicate,
      ...(options.providers === false ? {} : { providers }),
    },
    ...(options.breakGlass === true ? { accounts: { breakGlass: true } } : {}),
  })
  const ops = await person(h.handle, 'ops')
  const listed = h.book.list()
  if (!listed.ok) throw new Error('book')
  const subject = listed.value.accounts.find(one => one.role === 'ops')?.subject
  if (subject === undefined) throw new Error('no ops account')
  return { ...h, actions, providers, replicate, ops, subject }
}

describe('the model profile after a copy', () => {
  test('the shared token still may not apply: 403, the port never asked', async () => {
    const h = await modelsSetup({ breakGlass: true })
    const response = await h.handle(
      asBearer('POST', '/v0/providers/apply', ADMIN, { nodes: ['node-a'] }),
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('共用令牌与 break-glass 只能查看')
    expect(h.providers.calls).not.toContain('apply')
  })

  test('a copy the shared token starts carries no grant', async () => {
    for (const breakGlass of [false, true]) {
      const h = await modelsSetup({ breakGlass })
      const started = await h.handle(
        asBearer('POST', '/v0/replicate/start', ADMIN, START_BODY),
      )
      expect(started.status).toBe(202)
      expect(h.replicate.started).toHaveLength(1)
      expect(h.replicate.started[0]?.modelsBy).toBeUndefined()
      expect(h.replicate.grants.size).toBe(0)
    }
  })

  test('an ops account starts it: the job ships the profile as that operator, once', async () => {
    const h = await modelsSetup()
    const started = await h.handle(
      asSession('POST', '/v0/replicate/start', h.ops.sid, { body: START_BODY }),
    )
    expect(started.status).toBe(202)
    expect(h.replicate.started[0]?.modelsBy).toBe(h.subject)
    const before = h.actions.entries.length

    const shipped = await h.handle(shipAs(GRANT))
    expect(shipped.status).toBe(200)
    expect(await shipped.json()).toMatchObject({
      node: 'node-a',
      results: [{ node: 'node-a', outcome: 'ok' }],
    })
    // One node, its own profile: no force, no other profile, sessions untouched.
    expect(h.providers.writes).toEqual([
      { method: 'apply', input: { nodes: ['node-a'] } },
    ])
    const lines = h.actions.entries.slice(before)
    expect(
      lines.map(line => [line.action, line.subject, line.outcome]),
    ).toEqual([
      ['provider.apply', h.subject, 'ok'],
      ['server.replicate.models', h.subject, 'ok'],
    ])
    expect(new Set(lines.map(line => line.requestId)).size).toBe(1)
    expect(JSON.stringify(h.actions.entries)).not.toContain(GRANT)

    const again = await h.handle(shipAs(GRANT))
    expect(again.status).toBe(403)
    expect(h.providers.writes).toHaveLength(1)
  })

  test('no grant, a wrong one, or another job: nothing is shipped', async () => {
    const h = await modelsSetup()
    await h.handle(
      asSession('POST', '/v0/replicate/start', h.ops.sid, { body: START_BODY }),
    )
    const missing = await h.handle(
      asBearer('POST', `/v0/replicate/jobs/${JOB.job}/models`, ADMIN, {}),
    )
    expect(missing.status).toBe(401)
    const wrong = await h.handle(shipAs('h'.repeat(43)))
    expect(wrong.status).toBe(403)
    const elsewhere = await h.handle(shipAs(GRANT, 'other-000000'))
    expect(elsewhere.status).toBe(403)
    expect(h.providers.calls).not.toContain('apply')
    // The real grant is still good: the failed tries did not spend it.
    const shipped = await h.handle(shipAs(GRANT))
    expect(shipped.status).toBe(200)
  })

  test('an operator revoked before the end ships nothing; the refusal is on record', async () => {
    const h = await modelsSetup()
    await h.handle(
      asSession('POST', '/v0/replicate/start', h.ops.sid, { body: START_BODY }),
    )
    expect(h.book.revoke(h.subject, 'legacy:admin').ok).toBe(true)
    const shipped = await h.handle(shipAs(GRANT))
    expect(shipped.status).toBe(403)
    expect(await shipped.text()).toContain('发起部署的账号已不可用')
    expect(h.providers.calls).not.toContain('apply')
    expect(
      h.actions.entries
        .filter(line => line.action === 'server.replicate.models')
        .map(line => [line.subject, line.outcome, line.code]),
    ).toEqual([[h.subject, 'refused', 'rejected']])
  })

  test('a node that refuses the profile comes back as its own answer', async () => {
    const h = await modelsSetup()
    await h.handle(
      asSession('POST', '/v0/replicate/start', h.ops.sid, {
        body: { ...START_BODY, node: 'node-b' },
      }),
    )
    const shipped = await h.handle(shipAs(GRANT))
    expect(shipped.status).toBe(200)
    expect(await shipped.json()).toMatchObject({
      results: [{ node: 'node-b', outcome: 'refused', code: 'conflict' }],
    })
    expect(
      h.actions.entries
        .filter(line => line.action === 'server.replicate.models')
        .map(line => [line.outcome, line.code]),
    ).toEqual([['refused', 'conflict']])
  })

  test('a console without model services gives no grant and answers 501', async () => {
    const h = await modelsSetup({ providers: false })
    await h.handle(
      asSession('POST', '/v0/replicate/start', h.ops.sid, { body: START_BODY }),
    )
    expect(h.replicate.started[0]?.modelsBy).toBeUndefined()
    const shipped = await h.handle(shipAs(GRANT))
    expect(shipped.status).toBe(501)
  })
})
