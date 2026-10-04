// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/handoff` as the route sees it (P17.4): who may do what, the order of
 * the answers, and what reaches the port and the action ledger. The port is a
 * hand-written fake; the real one (bare repository checks, the locked ledger)
 * is tested next to it in `src/cli/handlers/__tests__/consoleHandoff.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import type {
  ConsoleResult,
  HandoffAcceptance,
  HandoffAttachRequest,
  HandoffAttachView,
  HandoffManifestView,
  HandoffPort,
  HandoffReturnRequest,
  HandoffReturnView,
  HandoffSendView,
  HandoffTaskView,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import {
  CONSOLE_HEADER,
  accountsHarness,
  asBearer,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'
import { ADMIN, VIEW, call, pageHarness } from './pageHarness.js'

const MANIFEST: HandoffManifestView = {
  kind: 'handoff',
  project: 'atlas',
  device: 'cornna-mbp',
  branch: 'main',
  wip: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  tool: 'qmcode',
  sessionId: '01a101a4-f755-7fb2-80ed-d37be2a4040a',
  sessionRef:
    'refs/qianmo/sessions/cornna-mbp/01a101a4-f755-7fb2-80ed-d37be2a4040a',
  sessionCommit: 'c'.repeat(40),
  cwd: '/Users/cornna/project/atlas',
  brief: { goal: '跑完测试', done: '', remaining: '全部' },
  deadline: '2026-11-20T02:00:00Z',
}

function taskOf(taskId: string): HandoffTaskView {
  return {
    taskId,
    state: 'accepted',
    manifest: MANIFEST,
    node: null,
    result: null,
    reason: null,
    acceptedAt: 1,
    updatedAt: 1,
  }
}

/** Accepts every body whose `project` is `atlas`; remembers what it got. */
class FakeHandoff implements HandoffPort {
  readonly accepted: unknown[] = []
  readonly sent: [string, string][] = []
  readonly tasks = new Map<string, HandoffTaskView>()
  acceptFailure: ConsoleResult<HandoffAcceptance> | null = null

  accept(body: unknown): Promise<ConsoleResult<HandoffAcceptance>> {
    this.accepted.push(body)
    if (this.acceptFailure !== null) return Promise.resolve(this.acceptFailure)
    const existing = this.tasks.get('t-1')
    if (existing !== undefined) {
      return Promise.resolve({
        ok: true,
        value: { task: existing, created: false },
      })
    }
    const task = taskOf('t-1')
    this.tasks.set(task.taskId, task)
    return Promise.resolve({ ok: true, value: { task, created: true } })
  }

  list(): Promise<ConsoleResult<readonly HandoffTaskView[]>> {
    return Promise.resolve({ ok: true, value: [...this.tasks.values()] })
  }

  get(taskId: string): Promise<ConsoleResult<HandoffTaskView>> {
    const task = this.tasks.get(taskId)
    return Promise.resolve(
      task === undefined
        ? {
            ok: false,
            failure: { code: 'not_found', message: `没有任务 ${taskId}` },
          }
        : { ok: true, value: task },
    )
  }

  readonly attached: [string, HandoffAttachRequest][] = []
  readonly returned: [string, HandoffReturnRequest][] = []

  attach(
    taskId: string,
    request: HandoffAttachRequest,
  ): Promise<ConsoleResult<HandoffAttachView>> {
    this.attached.push([taskId, request])
    const task = this.tasks.get(taskId)
    if (task === undefined) {
      return Promise.resolve({
        ok: false,
        failure: { code: 'not_found', message: `没有任务 ${taskId}` },
      })
    }
    if (task.state !== 'running') {
      return Promise.resolve({
        ok: false,
        failure: {
          code: 'rejected',
          message: `任务 ${taskId} 是 ${task.state}，不在云端运行`,
        },
      })
    }
    return Promise.resolve({
      ok: true,
      value: {
        taskId,
        state: task.state,
        node: task.node ?? '?',
        threadId: task.manifest.sessionId,
        project: task.manifest.project,
        tool: task.manifest.tool,
      },
    })
  }

  markReturned(
    taskId: string,
    request: HandoffReturnRequest,
  ): Promise<ConsoleResult<HandoffReturnView>> {
    this.returned.push([taskId, request])
    const task = this.tasks.get(taskId)
    if (task === undefined) {
      return Promise.resolve({
        ok: false,
        failure: { code: 'not_found', message: `没有任务 ${taskId}` },
      })
    }
    const next: HandoffTaskView = { ...task, state: 'returned' }
    this.tasks.set(taskId, next)
    return Promise.resolve({
      ok: true,
      value: { task: next, changed: task.state !== 'returned' },
    })
  }

  send(taskId: string, text: string): Promise<ConsoleResult<HandoffSendView>> {
    this.sent.push([taskId, text])
    if (!this.tasks.has(taskId)) {
      return Promise.resolve({
        ok: false,
        failure: { code: 'not_found', message: `没有任务 ${taskId}` },
      })
    }
    return Promise.resolve({
      ok: true,
      value: { taskId, seq: this.sent.length, at: 2, text },
    })
  }
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('/v0/handoff without a port', () => {
  test('401 before anything, 501 for every caller with a credential', async () => {
    const h = pageHarness()
    const anonymous = await h.handle(
      new Request('http://console.test/v0/handoff'),
    )
    expect(anonymous.status).toBe(401)
    expect((await h.handle(call('GET', '/v0/handoff', VIEW))).status).toBe(501)
    const post = await h.handle(call('POST', '/v0/handoff', ADMIN, MANIFEST))
    expect(post.status).toBe(501)
    expect(JSON.stringify(await bodyOf(post))).toContain('--handoff-root')
  })
})

describe('/v0/handoff with the legacy tokens', () => {
  function wired() {
    const port = new FakeHandoff()
    const actions = new MemoryActionLedger()
    // pageHarness has no handoff option; its deps plus the port.
    const deps = { ...pageHarness({ actions }).deps, handoff: port }
    const handle = createConsoleHandler(deps, { view: VIEW, admin: ADMIN })
    return { port, actions, handle }
  }

  test('admin accepts (201, then 200 for the same manifest); view reads and is refused writes', async () => {
    const { port, actions, handle } = wired()

    const first = await handle(call('POST', '/v0/handoff', ADMIN, MANIFEST))
    expect(first.status).toBe(201)
    const body = await bodyOf(first)
    expect(body.created).toBe(true)
    expect((body.task as HandoffTaskView).taskId).toBe('t-1')
    expect(port.accepted).toEqual([MANIFEST])

    const again = await handle(call('POST', '/v0/handoff', ADMIN, MANIFEST))
    expect(again.status).toBe(200)
    expect((await bodyOf(again)).created).toBe(false)

    const listed = await handle(call('GET', '/v0/handoff', VIEW))
    expect(listed.status).toBe(200)
    expect(((await bodyOf(listed)).tasks as unknown[]).length).toBe(1)
    const one = await handle(call('GET', '/v0/handoff/t-1', VIEW))
    expect(((await bodyOf(one)).task as HandoffTaskView).state).toBe('accepted')
    expect((await handle(call('GET', '/v0/handoff/t-9', VIEW))).status).toBe(
      404,
    )

    const viewPost = await handle(call('POST', '/v0/handoff', VIEW, MANIFEST))
    expect(viewPost.status).toBe(403)
    const viewSend = await handle(
      call('POST', '/v0/handoff/t-1/send', VIEW, { text: 'x' }),
    )
    expect(viewSend.status).toBe(403)
    expect(port.accepted).toHaveLength(2)
    expect(port.sent).toEqual([])

    const sent = await handle(
      call('POST', '/v0/handoff/t-1/send', ADMIN, { text: '先跑测试' }),
    )
    expect(sent.status).toBe(202)
    expect((await bodyOf(sent)).send).toEqual({
      taskId: 't-1',
      seq: 1,
      at: 2,
      text: '先跑测试',
    })

    // The action ledger names the task, never the manifest or the text.
    expect(
      actions.entries.map(entry => [entry.action, entry.target, entry.outcome]),
    ).toEqual([
      ['handoff.accept', 't-1', 'ok'],
      ['handoff.accept', 't-1', 'ok'],
      ['handoff.send', 't-1', 'ok'],
    ])
    expect(JSON.stringify(actions.entries)).not.toContain('先跑测试')
  })

  test('port failures keep their codes; the failed attempt is recorded under the project', async () => {
    const { port, actions, handle } = wired()
    port.acceptFailure = {
      ok: false,
      failure: {
        code: 'rejected',
        message: '中枢裸仓里没有会话提交 cccc',
      },
    }
    const refused = await handle(call('POST', '/v0/handoff', ADMIN, MANIFEST))
    expect(refused.status).toBe(400)
    expect(JSON.stringify(await bodyOf(refused))).toContain('没有会话提交')
    expect(actions.entries.at(-1)).toMatchObject({
      action: 'handoff.accept',
      target: 'atlas',
      outcome: 'failed',
      code: 'rejected',
    })
    const missing = await handle(
      call('POST', '/v0/handoff/t-9/send', ADMIN, { text: 'x' }),
    )
    expect(missing.status).toBe(404)
  })

  test('paths, methods and bodies', async () => {
    const { port, handle } = wired()
    expect((await handle(call('PUT', '/v0/handoff', ADMIN))).status).toBe(405)
    expect((await handle(call('GET', '/v0/handoff/a.b', VIEW))).status).toBe(
      404,
    )
    expect(
      (await handle(call('GET', '/v0/handoff/t-1/other', VIEW))).status,
    ).toBe(404)
    expect(
      (await handle(call('GET', '/v0/handoff/t-1/send', ADMIN))).status,
    ).toBe(405)
    expect(
      (await handle(call('DELETE', '/v0/handoff/t-1', ADMIN))).status,
    ).toBe(405)

    const notJson = await handle(
      new Request('http://console.test/v0/handoff', {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}` },
        body: '[1,2]',
      }),
    )
    expect(notJson.status).toBe(400)
    const huge = await handle(
      call('POST', '/v0/handoff', ADMIN, { pad: 'x'.repeat(70_000) }),
    )
    expect(huge.status).toBe(413)
    const emptyText = await handle(
      call('POST', '/v0/handoff/t-1/send', ADMIN, { text: ' ' }),
    )
    expect(emptyText.status).toBe(400)
    expect(port.accepted).toEqual([])
  })
})

describe('/v0/handoff/<task>/attach and /return (P17.6)', () => {
  function wired() {
    const port = new FakeHandoff()
    const actions = new MemoryActionLedger()
    const deps = { ...pageHarness({ actions }).deps, handoff: port }
    const handle = createConsoleHandler(deps, { view: VIEW, admin: ADMIN })
    port.tasks.set('t-run', {
      ...taskOf('t-run'),
      state: 'running',
      node: 'cloud-1',
    })
    port.tasks.set('t-done', { ...taskOf('t-done'), state: 'done' })
    return { port, actions, handle }
  }

  test('attach answers where a running task is, and nothing secret', async () => {
    const { port, actions, handle } = wired()
    const answer = await handle(
      call('POST', '/v0/handoff/t-run/attach', ADMIN, { device: 'phone-1' }),
    )
    expect(answer.status).toBe(200)
    const body = await bodyOf(answer)
    expect(body).toEqual({
      attach: {
        taskId: 't-run',
        state: 'running',
        node: 'cloud-1',
        threadId: MANIFEST.sessionId,
        project: 'atlas',
        tool: 'qmcode',
      },
    })
    expect(port.attached).toEqual([['t-run', { device: 'phone-1' }]])
    // No body at all is a request without a device.
    const bare = await handle(
      new Request('http://console.test/v0/handoff/t-run/attach', {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}` },
        body: '{}',
      }),
    )
    expect(bare.status).toBe(200)
    expect(port.attached.at(-1)).toEqual(['t-run', { device: null }])

    const notRunning = await handle(
      call('POST', '/v0/handoff/t-done/attach', ADMIN, {}),
    )
    expect(notRunning.status).toBe(400)
    expect(JSON.stringify(await bodyOf(notRunning))).toContain('不在云端运行')
    const missing = await handle(
      call('POST', '/v0/handoff/t-9/attach', ADMIN, {}),
    )
    expect(missing.status).toBe(404)
    const badDevice = await handle(
      call('POST', '/v0/handoff/t-run/attach', ADMIN, { device: '../x' }),
    )
    expect(badDevice.status).toBe(400)
    expect(port.attached).toHaveLength(4)

    expect(
      actions.entries.map(entry => [
        entry.action,
        entry.target,
        entry.outcome,
        entry.code ?? null,
      ]),
    ).toEqual([
      ['handoff.attach', 't-run', 'ok', null],
      ['handoff.attach', 't-run', 'ok', null],
      ['handoff.attach', 't-done', 'failed', 'rejected'],
      ['handoff.attach', 't-9', 'failed', 'not_found'],
      ['handoff.attach', 't-run', 'refused', 'invalid'],
    ])
  })

  test('return marks the task, with how it came back', async () => {
    const { port, actions, handle } = wired()
    const first = await handle(
      call('POST', '/v0/handoff/t-done/return', ADMIN, {
        device: 'laptop',
        mode: 'branch',
      }),
    )
    expect(first.status).toBe(200)
    const body = await bodyOf(first)
    expect(body.changed).toBe(true)
    expect((body.task as HandoffTaskView).state).toBe('returned')
    expect(port.returned).toEqual([
      ['t-done', { device: 'laptop', mode: 'branch' }],
    ])
    const again = await handle(
      call('POST', '/v0/handoff/t-done/return', ADMIN, {}),
    )
    expect((await bodyOf(again)).changed).toBe(false)
    expect(port.returned.at(-1)).toEqual([
      't-done',
      { device: null, mode: null },
    ])
    const badMode = await handle(
      call('POST', '/v0/handoff/t-done/return', ADMIN, { mode: 'merge' }),
    )
    expect(badMode.status).toBe(400)
    expect(port.returned).toHaveLength(2)
    expect(actions.entries.map(entry => entry.outcome)).toEqual([
      'ok',
      'ok',
      'refused',
    ])
  })

  test('view may not, GET is 405, an unknown write is 404', async () => {
    const { port, handle } = wired()
    for (const tail of ['attach', 'return']) {
      const byView = await handle(
        call('POST', `/v0/handoff/t-run/${tail}`, VIEW, {}),
      )
      expect(byView.status).toBe(403)
      expect(
        (await handle(call('GET', `/v0/handoff/t-run/${tail}`, ADMIN))).status,
      ).toBe(405)
    }
    expect(
      (await handle(call('POST', '/v0/handoff/t-run/toString', ADMIN, {})))
        .status,
    ).toBe(404)
    expect(port.attached).toEqual([])
    expect(port.returned).toEqual([])
  })
})

describe('/v0/handoff with personal accounts', () => {
  test('member and ops write, viewer reads only; a cookie needs the console header', async () => {
    const port = new FakeHandoff()
    const h = accountsHarness({ deps: { handoff: port } })
    const member = await person(h.handle, 'member')
    const viewer = await person(h.handle, 'viewer')
    const ops = await person(h.handle, 'ops')

    const byMember = await h.handle(
      asBearer('POST', '/v0/handoff', member.credential, MANIFEST),
    )
    expect(byMember.status).toBe(201)
    const byOps = await h.handle(
      asBearer('POST', '/v0/handoff/t-1/send', ops.credential, { text: 'x' }),
    )
    expect(byOps.status).toBe(202)

    const byViewer = await h.handle(
      asBearer('POST', '/v0/handoff', viewer.credential, MANIFEST),
    )
    expect(byViewer.status).toBe(403)
    expect(JSON.stringify(await bodyOf(byViewer))).toContain('成员或运维账号')
    const viewerReads = await h.handle(
      asBearer('GET', '/v0/handoff', viewer.credential),
    )
    expect(viewerReads.status).toBe(200)
    port.tasks.set('t-1', {
      ...taskOf('t-1'),
      state: 'running',
      node: 'cloud-1',
    })
    const attachByMember = await h.handle(
      asBearer('POST', '/v0/handoff/t-1/attach', member.credential, {}),
    )
    expect(attachByMember.status).toBe(200)
    const attachByViewer = await h.handle(
      asBearer('POST', '/v0/handoff/t-1/attach', viewer.credential, {}),
    )
    expect(attachByViewer.status).toBe(403)
    const returnByOps = await h.handle(
      asBearer('POST', '/v0/handoff/t-1/return', ops.credential, {}),
    )
    expect(returnByOps.status).toBe(200)
    const returnByViewer = await h.handle(
      asBearer('POST', '/v0/handoff/t-1/return', viewer.credential, {}),
    )
    expect(returnByViewer.status).toBe(403)

    const noHeader = await h.handle(
      asSession('POST', '/v0/handoff', member.sid, {
        body: MANIFEST,
        header: false,
      }),
    )
    expect(noHeader.status).toBe(403)
    expect(JSON.stringify(await bodyOf(noHeader))).toContain(CONSOLE_HEADER)
    expect(port.accepted).toHaveLength(1)
  })
})
