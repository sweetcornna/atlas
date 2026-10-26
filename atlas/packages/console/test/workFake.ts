// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 广泛性工作 for the front's tests and previews (P37.17 B): a chat port that
 * keeps work sessions with their turns, deliveries and activity, and the
 * hub's `/v0/work/*` answered the way `docs/dev/work-tasks.md` §1.2 and §4
 * give them. The node's half (`feat/p37-17-work-node`) is not on this
 * branch, so these hold the front to the documented shapes, not to that
 * code.
 */

import type { AccountBook } from '../src/accounts.js'
import type {
  ChatOpenOptions,
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTranscript,
  ChatTurn,
  ConsoleResult,
} from '../src/deps.js'
import type {
  WorkActivity,
  WorkFileKind,
  WorkFileRef,
  WorkflowId,
} from '../src/work.js'
import { ADDRESS, CountingChat } from './accountsHarness.js'

/** A chat port whose sessions keep what was said in them. */
export class WorkChat extends CountingChat {
  readonly lines = new Map<string, ChatTurn[]>()
  readonly activity = new Map<string, WorkActivity>()
  #turn = 0

  override async open(
    target: string,
    options?: ChatOpenOptions,
  ): Promise<ConsoleResult<ChatSession>> {
    const opened = await super.open(target, options)
    if (!opened.ok || options?.work !== true) return opened
    const session: ChatSession = {
      ...opened.value,
      work: true,
      ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
    }
    this.sessionsById.set(session.id, session)
    return { ok: true, value: session }
  }

  override async transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const read = await super.transcript(sessionId)
    if (!read.ok) return read
    const activity = this.activity.get(sessionId)
    return {
      ok: true,
      value: {
        session: read.value.session,
        turns: this.lines.get(sessionId) ?? [],
        ...(activity === undefined ? {} : { activity }),
      },
    }
  }

  override async send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    const sent = await super.send(input)
    if (!sent.ok) return sent
    const turn: ChatTurn = { ...sent.value, id: `line-${++this.#turn}` }
    this.add(input.sessionId, turn, true)
    return { ok: true, value: turn }
  }

  /** A line in a session, as the hub would have recorded it. */
  add(sessionId: string, turn: ChatTurn, running?: boolean): void {
    const session = this.sessionsById.get(sessionId)
    if (session === undefined) throw new Error(`no session ${sessionId}`)
    const lines = this.lines.get(sessionId) ?? []
    lines.push(turn)
    this.lines.set(sessionId, lines)
    const { running: _was, ...rest } = session
    const busy = running ?? session.running === true
    this.sessionsById.set(sessionId, {
      ...rest,
      updatedAt: Math.max(session.updatedAt, turn.at),
      turnCount: lines.filter(line => line.variant !== 'notice').length,
      ...(turn.variant === 'notice' || turn.text === ''
        ? {}
        : { preview: turn.text }),
      ...(busy ? { running: true as const } : {}),
    })
    this.emit(sessionId)
  }

  /** The agent's answer: the session stops waiting. */
  answer(sessionId: string, text: string, at: number): void {
    this.add(
      sessionId,
      {
        id: `line-${++this.#turn}`,
        sessionId,
        author: 'agent',
        at,
        text,
        state: 'done',
      },
      false,
    )
  }

  /** A delivery (`work-tasks.md` §3.2): a files card in the conversation. */
  deliver(sessionId: string, files: readonly WorkFileRef[], at: number): void {
    this.add(sessionId, {
      id: `line-${++this.#turn}`,
      sessionId,
      author: 'agent',
      at,
      text: `交付了 ${files.length} 个文件：${files.map(file => file.name).join('、')}`,
      state: 'done',
      variant: 'notice',
      noticeSource: 'files',
      severity: 'info',
      files,
    })
  }

  /** The node's report of progress and context (§3.3). */
  report(sessionId: string, activity: WorkActivity): void {
    this.activity.set(sessionId, activity)
    this.emit(sessionId)
  }
}

/** A file in a session's outputs folder, with what fetching it gives. */
export interface FakeOutput {
  readonly name: string
  readonly size: number
  readonly kind: WorkFileKind
  readonly mime: string
  readonly mtime: number
  readonly preview: boolean
  readonly tooLarge?: true
  readonly body?: string
}

/** A delivered file's record, as the node would hand it over. */
export function fileRef(
  name: string,
  kind: WorkFileKind,
  size: number,
  preview = true,
  title?: string,
): WorkFileRef {
  return {
    name,
    size,
    kind,
    mime: 'application/octet-stream',
    sha256: 'a'.repeat(64),
    preview,
    ...(title === undefined ? {} : { title }),
  }
}

const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The hub's `/v0/work/*` in front of a console handler: everything else goes
 * to the handler as it is. `POST /v0/work/sessions` opens the session with
 * the work mark, records its owner like the chat face does, and sends the
 * first line through the console's own messages route.
 */
export class WorkRoutes {
  /** The bodies `POST /v0/work/sessions` was sent. */
  readonly opens: Record<string, unknown>[] = []
  /** The bodies `POST /v0/chat/sessions/<id>/messages` was sent. */
  readonly messages: Record<string, unknown>[] = []
  /** What `…/outputs`, `…/file` and `…/preview` were asked for. */
  readonly reads: string[] = []
  /** Each session's outputs folder, newest first. */
  readonly outputs: Map<string, FakeOutput[]>
  /** 501: a hub without the control link, or a node that cannot list. */
  listing: 200 | 501 = 200
  /** The session opens and its first line does not go (§1.2). */
  firstLineFails = false
  /**
   * The preview's own policy (§4.4); `null` to serve one without it, so a
   * test sees what the page's frame alone holds back.
   */
  previewPolicy: string | null = PREVIEW_CSP

  private readonly chat: ChatPort
  private readonly handle: (request: Request) => Promise<Response>
  private readonly book: AccountBook | null
  private readonly main: string

  /**
   * `book`: the account book whose session cookie says who opened a work
   * session, recorded as its owner the way the chat face records one;
   * absent for a console without accounts. `main`: who does a work nobody
   * picked an agent for.
   */
  constructor(options: {
    readonly chat: ChatPort
    readonly handle: (request: Request) => Promise<Response>
    readonly book?: AccountBook
    readonly main?: string
    readonly outputs?: Map<string, FakeOutput[]>
  }) {
    this.chat = options.chat
    this.handle = options.handle
    this.book = options.book ?? null
    this.main = options.main ?? ADDRESS
    this.outputs = options.outputs ?? new Map()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    if (
      request.method === 'POST' &&
      /^\/v0\/chat\/sessions\/[^/]+\/messages$/.test(path)
    ) {
      const body = (await request.clone().json()) as Record<string, unknown>
      this.messages.push(body)
      return this.handle(request)
    }
    if (request.method === 'POST' && path === '/v0/work/sessions') {
      return await this.open(request)
    }
    const part = /^\/v0\/work\/sessions\/([^/]+)\/(outputs|file|preview)$/.exec(
      path,
    )
    if (part === null || request.method !== 'GET') return this.handle(request)
    const id = decodeURIComponent(part[1] ?? '')
    const what = part[2] ?? ''
    // `file` and `preview` are stream routes: the cookie is enough (§4.6).
    if (!(request.headers.get('cookie') ?? '').includes('qianmo_session=')) {
      return json({ error: { code: 'forbidden', message: '没有登录' } }, 403)
    }
    const files = this.outputs.get(id) ?? []
    if (what === 'outputs') {
      this.reads.push(`outputs ${id}`)
      if (this.listing === 501)
        return json(
          { error: { code: 'unsupported', message: '取不了产出' } },
          501,
        )
      return json({
        files: files.map(({ body: _body, ...rest }) => rest),
        truncated: false,
      })
    }
    const name = url.searchParams.get('name') ?? ''
    this.reads.push(`${what} ${name}`)
    const file = files.find(one => one.name === name)
    if (file === undefined || (what === 'preview' && !file.preview)) {
      return json(
        { error: { code: 'not_found', message: '这个文件没有预览' } },
        404,
      )
    }
    if (what === 'file') {
      return new Response(file.body ?? '', {
        status: 200,
        headers: {
          'content-type': file.mime,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'no-store',
        },
      })
    }
    return new Response(
      file.body ??
        `<!doctype html><meta charset="utf-8"><title>${name}</title>` +
          `<style>body{font-family:sans-serif;margin:24px}</style><h1>${name}</h1>` +
          `<script>parent.document.title = 'preview script ran'</script>`,
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition': 'inline',
          ...(this.previewPolicy === null
            ? {}
            : { 'content-security-policy': this.previewPolicy }),
          'x-frame-options': 'SAMEORIGIN',
          'cache-control': 'no-store',
        },
      },
    )
  }

  private async open(request: Request): Promise<Response> {
    const body = (await request.clone().json()) as Record<string, unknown>
    this.opens.push(body)
    const agent = typeof body['agent'] === 'string' ? body['agent'] : this.main
    const workflow = body['workflow'] as WorkflowId | undefined
    const opened = await this.chat.open(agent, {
      work: true,
      ...(workflow === undefined ? {} : { workflow }),
    })
    if (!opened.ok) return json({ error: opened.failure }, 503)
    const session = opened.value
    const sid = /(?:^|;\s*)qianmo_session=([^;]+)/.exec(
      request.headers.get('cookie') ?? '',
    )?.[1]
    if (this.book !== null && sid !== undefined) {
      const principal = this.book.sessionPrincipal(sid, false)
      if (principal.ok && principal.value.kind === 'user')
        this.book.recordOwner(session.id, principal.value.subject)
    }
    const text = typeof body['text'] === 'string' ? body['text'] : null
    if (text === null) return json({ session, turn: null })
    if (this.firstLineFails) {
      return json(
        { error: { code: 'unreachable', message: '节点暂时连不上' }, session },
        503,
      )
    }
    const headers = new Headers(request.headers)
    const sent = await this.handle(
      new Request(
        new URL(
          `/v0/chat/sessions/${encodeURIComponent(session.id)}/messages`,
          request.url,
        ).href,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            text,
            ...(workflow === undefined ? {} : { workflow }),
          }),
        },
      ),
    )
    if (!sent.ok) {
      const answer = (await sent.json()) as { error?: unknown }
      return json({ error: answer.error ?? null, session }, sent.status)
    }
    return json({ session, turn: await sent.json() })
  }
}
