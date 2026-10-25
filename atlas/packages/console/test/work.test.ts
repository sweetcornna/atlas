// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P37.17 B — `/v0/work/*` (`docs/dev/work-tasks.md` §1, §2, §4): opening a
 * work session (its kind and executor), the workflow riding on the first
 * line and on later ones, and that outputs reach only someone who may read
 * the session — judged, as on the chat face, by the port never being asked.
 */

import { describe, expect, test } from 'bun:test'
import type {
  ChatOpenOptions,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ConsoleResult,
  WorkDownload,
  WorkPort,
  WorkResult,
} from '../src/deps.js'
import {
  deliveredFiles,
  isWorkName,
  progressOf,
  workflowPrompt,
  WORKFLOWS,
  type WorkFileRef,
  type WorkOutput,
} from '../src/work.js'
import {
  ADDRESS,
  ADMIN,
  BASE,
  CONSOLE_HEADER,
  CountingChat,
  START,
  accountsHarness,
  asAdmin,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'

const QUIET = 'qianmo://tokyo-1/quiet'
const OTHER = 'qianmo://osaka-2/writer'

/** The harness's chat, plus the open options and a second and third agent. */
class WorkChat extends CountingChat {
  readonly options: (ChatOpenOptions | undefined)[] = []
  readonly turnsBy = new Map<string, ChatTurn[]>()
  activity: ChatTranscript['activity'] = undefined

  override targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return Promise.resolve({
      ok: true,
      value: [
        {
          address: ADDRESS,
          node: 'tokyo-1',
          agent: 'planner',
          endpoint: 'ws://127.0.0.1:38611/',
          status: 'online',
          dialable: true,
        },
        {
          address: QUIET,
          node: 'tokyo-1',
          agent: 'quiet',
          endpoint: 'ws://127.0.0.1:38612/',
          status: 'online',
          dialable: false,
        },
        {
          address: OTHER,
          node: 'osaka-2',
          agent: 'writer',
          endpoint: 'ws://127.0.0.1:38613/',
          status: 'online',
          dialable: true,
        },
      ],
    })
  }

  override async open(
    target: string,
    options?: ChatOpenOptions,
  ): Promise<ConsoleResult<ChatSession>> {
    this.options.push(options)
    const opened = await super.open(target)
    if (!opened.ok) return opened
    const session: ChatSession = {
      ...opened.value,
      node: target.split('/')[2] ?? '',
      agent: target.split('/')[3] ?? '',
      ...(options?.work === true ? { work: true as const } : {}),
      ...(options?.workflow === undefined
        ? {}
        : { workflow: options.workflow }),
    }
    this.sessionsById.set(session.id, session)
    return { ok: true, value: session }
  }

  override async transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const read = await super.transcript(sessionId)
    if (!read.ok) return read
    return {
      ok: true,
      value: {
        ...read.value,
        turns: this.turnsBy.get(sessionId) ?? [],
        ...(this.activity === undefined ? {} : { activity: this.activity }),
      },
    }
  }
}

/** Outputs for any session, counting each call. */
class FakeWork implements WorkPort {
  lists = 0
  fetches: { session: string; node: string; name: string; view: string }[] = []
  answer: WorkResult<WorkDownload> | null = null

  outputs(session: ChatSession): Promise<
    WorkResult<{
      readonly files: readonly WorkOutput[]
      readonly truncated: boolean
    }>
  > {
    this.lists += 1
    return Promise.resolve({
      ok: true,
      value: {
        files: [
          {
            name: `${session.id}.pptx`,
            size: 3,
            kind: 'presentation',
            mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            mtime: START,
            preview: true,
          },
        ],
        truncated: false,
      },
    })
  }

  fetch(
    session: ChatSession,
    name: string,
    view: 'file' | 'preview',
  ): Promise<WorkResult<WorkDownload>> {
    this.fetches.push({ session: session.id, node: session.node, name, view })
    if (this.answer !== null) return Promise.resolve(this.answer)
    const bytes =
      view === 'file'
        ? new Uint8Array([0x50, 0x4b, 0x03])
        : new TextEncoder().encode('<!doctype html><p>预览</p>')
    return Promise.resolve({
      ok: true,
      value: {
        name,
        size: bytes.byteLength,
        mime:
          view === 'file'
            ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'text/html; charset=utf-8',
        body: new Response(bytes).body!,
      },
    })
  }
}

function harness(withWork = true) {
  const chat = new WorkChat()
  const work = new FakeWork()
  const actions = new MemoryActionLedger()
  const h = accountsHarness({
    deps: {
      chat,
      actions,
      ...(withWork ? { work } : {}),
      chatDefault: ADDRESS,
    },
  })
  return { h, chat, work, actions }
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('the workflow table', () => {
  test('six, in card order, each with its skill and outputs', async () => {
    const { h } = harness()
    const response = await h.handle(asAdmin('GET', '/v0/work/workflows'))
    expect(response.status).toBe(200)
    const listed = await body<{
      workflows: { id: string; skill: string; outputs: string[] }[]
    }>(response)
    expect(listed.workflows.map(one => one.id)).toEqual([
      'slides',
      'document',
      'sheet',
      'research',
      'webpage',
      'analysis',
    ])
    expect(listed.workflows[0]).toEqual({
      id: 'slides',
      skill: 'qmo-slides',
      outputs: ['pptx', 'pdf'],
    })
    expect(WORKFLOWS.every(one => one.skill === `qmo-${one.id}`)).toBe(true)
  })

  test('the skill command goes in front of the line', () => {
    expect(workflowPrompt('slides', '做一份季度汇报')).toBe(
      '/skill:qmo-slides 做一份季度汇报',
    )
  })
})

describe('opening a work session', () => {
  test('the main agent, the work kind and the workflow; the first line carries the workflow', async () => {
    const { h, chat, actions } = harness()
    const response = await h.handle(
      asAdmin('POST', '/v0/work/sessions', {
        workflow: 'slides',
        text: '做一份季度汇报',
      }),
    )
    expect(response.status).toBe(200)
    const opened = await body<{ session: ChatSession; turn: ChatTurn }>(
      response,
    )
    expect(opened.session.target).toBe(ADDRESS)
    expect(opened.session.work).toBe(true)
    expect(opened.session.workflow).toBe('slides')
    expect(chat.options).toEqual([{ work: true, workflow: 'slides' }])
    expect(chat.sent).toHaveLength(1)
    expect(chat.sent[0]?.workflow).toBe('slides')
    expect(chat.sent[0]?.text).toBe('做一份季度汇报')
    expect(opened.turn.text).toBe('做一份季度汇报')
    expect(actions.entries.map(one => [one.action, one.target])).toEqual([
      ['work.session.open', ADDRESS],
      ['chat.message.send', opened.session.id],
    ])
  })

  test('without a first line: the session and no turn', async () => {
    const { h, chat } = harness()
    const response = await h.handle(
      asAdmin('POST', '/v0/work/sessions', { agent: OTHER }),
    )
    expect(response.status).toBe(200)
    const opened = await body<{ session: ChatSession; turn: null }>(response)
    expect(opened.turn).toBeNull()
    expect(opened.session.target).toBe(OTHER)
    expect(opened.session.workflow).toBeUndefined()
    expect(chat.options).toEqual([{ work: true }])
    expect(chat.sends).toBe(0)
  })

  test('the executor is checked: unknown 404, not dialable 400, not an address 400; nothing opened', async () => {
    const { h, chat } = harness()
    const cases: [unknown, number, string][] = [
      ['qianmo://nowhere/nobody', 404, 'not_found'],
      [QUIET, 400, 'rejected'],
      ['planner', 400, 'invalid'],
      [7, 400, 'invalid'],
    ]
    for (const [agent, status, code] of cases) {
      const response = await h.handle(
        asAdmin('POST', '/v0/work/sessions', { agent }),
      )
      expect(response.status).toBe(status)
      expect(
        (await body<{ error: { code: string } }>(response)).error.code,
      ).toBe(code)
    }
    expect(chat.opened).toBe(0)
  })

  test('unknown keys and unknown workflows are 400 before anything opens', async () => {
    const { h, chat } = harness()
    for (const sent of [
      { target: ADDRESS },
      { workflow: 'poster' },
      { workflow: 'slides', text: '-----BEGIN OPENSSH PRIVATE KEY-----' },
    ]) {
      const response = await h.handle(
        asAdmin('POST', '/v0/work/sessions', sent),
      )
      expect(response.status).toBe(400)
    }
    expect(chat.opened).toBe(0)
  })

  test('a viewer cannot open one; a cookie needs the console header', async () => {
    const { h, chat } = harness()
    const viewer = await person(h.handle, 'viewer')
    const member = await person(h.handle, 'member')
    const refused = await h.handle(
      asSession('POST', '/v0/work/sessions', viewer.sid, { body: {} }),
    )
    expect(refused.status).toBe(403)
    const headerless = await h.handle(
      asSession('POST', '/v0/work/sessions', member.sid, {
        body: {},
        header: false,
      }),
    )
    expect(headerless.status).toBe(403)
    expect(chat.opened).toBe(0)
    const opened = await h.handle(
      asSession('POST', '/v0/work/sessions', member.sid, { body: {} }),
    )
    expect(opened.status).toBe(200)
  })

  test('a workflow picked again inside the conversation rides on that line; never with a local command', async () => {
    const { h, chat } = harness()
    const opened = await body<{ session: ChatSession }>(
      await h.handle(asAdmin('POST', '/v0/work/sessions', {})),
    )
    const id = opened.session.id
    const sent = await h.handle(
      asAdmin('POST', `/v0/chat/sessions/${id}/messages`, {
        text: '再做一份表格',
        workflow: 'sheet',
      }),
    )
    expect(sent.status).toBe(200)
    expect(chat.sent.at(-1)?.workflow).toBe('sheet')
    for (const extra of [
      { text: '/compact', workflow: 'sheet' },
      { text: '随便', workflow: 'poster' },
    ]) {
      const refused = await h.handle(
        asAdmin('POST', `/v0/chat/sessions/${id}/messages`, extra),
      )
      expect(refused.status).toBe(400)
    }
    expect(chat.sends).toBe(1)
  })
})

describe('only someone who can read the session can fetch its files', () => {
  async function twoMembers() {
    const fixture = harness()
    const a = await person(fixture.h.handle, 'member')
    const b = await person(fixture.h.handle, 'member')
    const opened = await body<{ session: ChatSession }>(
      await fixture.h.handle(
        asSession('POST', '/v0/work/sessions', a.sid, { body: {} }),
      ),
    )
    return { ...fixture, a, b, id: opened.session.id }
  }

  test("B gets the same 404 for A's session as for none, and the node is never asked", async () => {
    const { h, work, b, id } = await twoMembers()
    for (const path of [
      `/v0/work/sessions/${id}/outputs`,
      `/v0/work/sessions/${id}/activity`,
      `/v0/work/sessions/${id}/file?name=a.pptx`,
      `/v0/work/sessions/${id}/preview?name=a.pptx`,
      '/v0/work/sessions/nope/file?name=a.pptx',
    ]) {
      const response = await h.handle(asSession('GET', path, b.sid))
      expect(response.status).toBe(404)
      expect(await response.text()).toContain('这条会话不在本控制台的记录里')
    }
    expect(work.lists).toBe(0)
    expect(work.fetches).toHaveLength(0)
  })

  test('A downloads by cookie alone, with the attachment headers; the read is recorded', async () => {
    const { h, work, actions, a, id } = await twoMembers()
    const response = await h.handle(
      asSession(
        'GET',
        `/v0/work/sessions/${id}/file?name=${encodeURIComponent('图/季度 汇报.pptx')}`,
        a.sid,
        {
          header: false,
        },
      ),
    )
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03]),
    )
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="__ __.pptx"; filename*=UTF-8''${encodeURIComponent('季度 汇报.pptx')}`,
    )
    expect(response.headers.get('content-length')).toBe('3')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cross-origin-resource-policy')).toBe(
      'same-origin',
    )
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox",
    )
    expect(work.fetches).toEqual([
      { session: id, node: 'tokyo-1', name: '图/季度 汇报.pptx', view: 'file' },
    ])
    expect(actions.entries.at(-1)).toMatchObject({
      action: 'work.output.read',
      target: `${id} 图/季度 汇报.pptx`,
      outcome: 'ok',
    })
  })

  test('a cookie from another origin is refused before the node is asked', async () => {
    const { h, work, a, id } = await twoMembers()
    const response = await h.handle(
      asSession('GET', `/v0/work/sessions/${id}/preview?name=a.pptx`, a.sid, {
        header: false,
        extra: { 'sec-fetch-site': 'cross-site' },
      }),
    )
    expect(response.status).toBe(403)
    expect(work.fetches).toHaveLength(0)
  })

  test('the preview is a sandboxed page with no script allowed, framable by this origin only', async () => {
    const { h, a, id } = await twoMembers()
    const response = await h.handle(
      asSession('GET', `/v0/work/sessions/${id}/preview?name=a.pptx`, a.sid, {
        header: false,
        accept: 'text/html',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).toContain('sandbox')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    // Served as the node drew it: not dressed up as a console page.
    expect(await response.text()).toBe('<!doctype html><p>预览</p>')
  })

  test('bad names are 400 and over-limit files 413, the node told nothing for the first', async () => {
    const { h, work, a, id } = await twoMembers()
    for (const name of [
      '../x',
      '/etc/passwd',
      'a\\b',
      'a/./b',
      'a/b/c/d/e.txt',
      'x.',
    ]) {
      const response = await h.handle(
        asSession(
          'GET',
          `/v0/work/sessions/${id}/file?name=${encodeURIComponent(name)}`,
          a.sid,
          { header: false },
        ),
      )
      expect(response.status).toBe(400)
    }
    expect(work.fetches).toHaveLength(0)
    work.answer = {
      ok: false,
      failure: { code: 'limit', message: '文件超过 50 MiB' },
    }
    const big = await h.handle(
      asSession('GET', `/v0/work/sessions/${id}/file?name=big.bin`, a.sid, {
        header: false,
      }),
    )
    expect(big.status).toBe(413)
  })

  test('a closed ledger answers 503 and the node is not asked', async () => {
    const { h, work, actions, a, id } = await twoMembers()
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'closed' },
    }
    const response = await h.handle(
      asSession('GET', `/v0/work/sessions/${id}/file?name=a.pptx`, a.sid, {
        header: false,
      }),
    )
    expect(response.status).toBe(503)
    expect(work.fetches).toHaveLength(0)
  })

  test('outputs need the console header; without control links they are 501', async () => {
    const { h, a, id } = await twoMembers()
    const headerless = await h.handle(
      asSession('GET', `/v0/work/sessions/${id}/outputs`, a.sid, {
        header: false,
      }),
    )
    expect(headerless.status).toBe(403)
    const listed = await h.handle(
      asSession('GET', `/v0/work/sessions/${id}/outputs`, a.sid),
    )
    expect(listed.status).toBe(200)
    expect((await body<{ files: WorkOutput[] }>(listed)).files[0]?.name).toBe(
      `${id}.pptx`,
    )
    const bare = harness(false)
    const opened = await body<{ session: ChatSession }>(
      await bare.h
        .handle(asAdmin('GET', '/v0/work/workflows'))
        .then(() => bare.h.handle(asAdmin('POST', '/v0/work/sessions', {}))),
    )
    const none = await bare.h.handle(
      new Request(`${BASE}/v0/work/sessions/${opened.session.id}/outputs`, {
        headers: { authorization: `Bearer ${ADMIN}`, [CONSOLE_HEADER]: '1' },
      }),
    )
    expect(none.status).toBe(501)
  })
})

describe('the activity panel', () => {
  const ref = (name: string, sha: string): WorkFileRef => ({
    name,
    size: 1,
    kind: 'presentation',
    mime: 'application/octet-stream',
    sha256: sha.repeat(64).slice(0, 64),
    preview: true,
  })

  test('progress and context from the transcript, delivered files by last name, newest first', async () => {
    const { h, chat } = harness()
    const opened = await body<{ session: ChatSession }>(
      await h.handle(
        asAdmin('POST', '/v0/work/sessions', { workflow: 'slides' }),
      ),
    )
    const id = opened.session.id
    const card = (at: number, files: WorkFileRef[]): ChatTurn => ({
      id: `card-${at}`,
      sessionId: id,
      author: 'agent',
      at,
      text: 'x',
      state: 'done',
      variant: 'notice',
      noticeSource: 'files',
      files,
    })
    chat.turnsBy.set(id, [
      card(1, [ref('a.pptx', 'a'), ref('b.pdf', 'b')]),
      card(2, [ref('a.pptx', 'c')]),
    ])
    const progress = progressOf('t-1', 5, [
      { phase: '准备', content: '整理材料', status: 'completed' },
      { phase: '准备', content: '定大纲', status: 'in_progress' },
      { phase: '制作', content: '生成', status: 'pending' },
      { phase: '制作', content: '旧方案', status: 'abandoned' },
    ])
    chat.activity = { progress, context: null }
    const response = await h.handle(
      asAdmin('GET', `/v0/work/sessions/${id}/activity`),
    )
    expect(response.status).toBe(200)
    const read = await body<{
      work: boolean
      workflow: string
      progress: { total: number; done: number; step: number; current: string }
      context: null
      delivered: WorkFileRef[]
    }>(response)
    expect(read.work).toBe(true)
    expect(read.workflow).toBe('slides')
    expect(read.progress).toMatchObject({
      total: 3,
      done: 1,
      step: 2,
      current: '定大纲',
    })
    expect(read.context).toBeNull()
    expect(read.delivered.map(one => [one.name, one.sha256[0]])).toEqual([
      ['a.pptx', 'c'],
      ['b.pdf', 'b'],
    ])
  })

  test('no list, or an emptied one, shows no progress block', () => {
    expect(progressOf('t', 0, [])).toBeNull()
    expect(
      progressOf('t', 0, [{ phase: '', content: 'x', status: 'abandoned' }]),
    ).toBeNull()
    expect(deliveredFiles([])).toEqual([])
  })

  test('names: what the node is asked for is a plain relative path', () => {
    expect(isWorkName('季度汇报.pptx')).toBe(true)
    expect(isWorkName('图/趋势.png')).toBe(true)
    for (const bad of [
      '',
      '/a',
      '../a',
      'a/../b',
      'a\\b',
      'C:x',
      'a\u0001',
      'a/b/c/d/e',
      'a ',
      7,
    ])
      expect(isWorkName(bad)).toBe(false)
  })
})
