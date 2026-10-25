// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/code/…` — the Remote copies of local Code sessions, for the
 * account's other devices (P37.15, `docs/dev/qmo-local.md` §5.2).
 *
 * | Method | Path | Who | What |
 * | --- | --- | --- | --- |
 * | GET | `/v0/code/sessions` | a personal account | the account's devices and copies, less those of the device this browser session came in through |
 * | GET | `/v0/code/sessions/<device>/<session>?before=&limit=` | the same | one copy's records, as `qmo_local_read` answers |
 * | POST | `…/messages` | member or ops | `{text, clientId}` to the device: `send` |
 * | POST | `…/answer` | member or ops | `{ask, decision, message?}`: `answer` |
 * | POST | `…/stop` | member or ops | `stop` |
 * | DELETE | `/v0/code/sessions/<device>/<session>` | member or ops | the copy, once Remote is off for it |
 * | GET | `/v0/code/stream` | a personal account | Server-Sent Events: `code` with a revision, nothing else |
 *
 * Only an account's own: every copy is stored under the account's subject
 * (`codeRemote.ts`), so a path naming another account's device finds
 * nothing. The two legacy tokens and break-glass have no devices and get a
 * 403. A write goes to the device over its link and waits for the runner's
 * answer; offline it is a 409, as is a copy whose Remote is off.
 */

import { streamScopeOf } from '../accountsHttp.js'
import {
  CODE_DEVICE_ID,
  CODE_READ_MAX,
  CODE_SESSION_ID,
  type CodeCopy,
} from '../codeRemote.js'
import type { CodeLinks, LinkReply, LinkRequest } from '../codeLink.js'
import {
  fail,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import { guard, guardChat } from './shared.js'
import type { HeadRoute, RouteContext } from './types.js'

const MAX_TEXT = 65_536
const MAX_MESSAGE = 500
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const ASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const CONTROL = /\p{Cc}/u
const DECISIONS = ['once', 'session', 'deny'] as const

/**
 * The stream's heartbeat: the chat stream's (`routes/chat.ts`,
 * `CHAT_STREAM_HEARTBEAT_MS`), which the server's idle timeout is derived
 * from; a test holds the two equal. Not imported: `chat.ts` claims this
 * module's head, and the import would make a cycle.
 */
export const CODE_STREAM_HEARTBEAT_MS = 15_000

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
} as const

/** A copy as the page's list takes it: a key unlike any local session's. */
function summaryOf(
  copy: CodeCopy,
  device: {
    readonly id: string
    readonly name: string
    readonly online: boolean
  },
): Record<string, unknown> {
  const { header } = copy
  return {
    id: `${copy.device}.${header.id}`,
    session: header.id,
    device,
    title: header.title,
    folder: { id: null, name: header.folder },
    agent: header.agent,
    mode: header.mode,
    state: header.state,
    remote: header.remote,
    full: copy.full,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    lastSeq: copy.stored,
  }
}

/** The person asking, when it is a personal account; otherwise the refusal. */
function ownerOf(ctx: RouteContext): string | Response {
  const principal = ctx.access.principal
  if (principal?.kind !== 'user' || ctx.access.breakGlass)
    return fail(403, 'forbidden', '只有个人账号有 Remote 会话')
  return principal.subject
}

/** The device this browser session came in through, if a client ticket opened it. */
function ownDevice(ctx: RouteContext): string | null {
  const sid = ctx.access.sid
  if (sid === null || ctx.accounts === undefined) return null
  return ctx.accounts.book.sessionDevice(sid)
}

async function deviceNames(
  ctx: RouteContext,
  owner: string,
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const devices = ctx.deps.handoffDevices
  if (devices === undefined) return names
  try {
    const listed = await devices.listDevices()
    if (listed.ok)
      for (const one of listed.value)
        if (one.owner === owner && one.revokedAt === null)
          names.set(one.deviceId, one.name)
  } catch {}
  return names
}

async function list(
  ctx: RouteContext,
  links: CodeLinks,
  owner: string,
): Promise<Response> {
  const names = await deviceNames(ctx, owner)
  const own = ownDevice(ctx)
  const copies = links
    .copies(owner)
    .filter(copy => copy.device !== own && names.has(copy.device))
  const devices = new Map<
    string,
    { id: string; name: string; online: boolean }
  >()
  for (const copy of copies)
    if (!devices.has(copy.device))
      devices.set(copy.device, {
        id: copy.device,
        name: names.get(copy.device) ?? copy.device,
        online: links.online(copy.device),
      })
  return json({
    devices: [...devices.values()],
    sessions: copies
      .map(copy => summaryOf(copy, devices.get(copy.device)!))
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)),
  })
}

function positive(value: string | null): number | undefined | null {
  if (value === null) return undefined
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

function stream(ctx: RouteContext, links: CodeLinks, owner: string): Response {
  const scope = streamScopeOf(ctx.access, ctx.accounts)
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let detach: (() => void) | null = null
  const release = (): void => {
    unsubscribe?.()
    unsubscribe = null
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
    detach?.()
    detach = null
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          release()
        }
      }
      const end = (): void => {
        release()
        try {
          controller.close()
        } catch {}
      }
      push(': open\n\n')
      unsubscribe = links.subscribe(owner, rev => {
        if (scope !== undefined && !scope.alive()) {
          end()
          return
        }
        push(`event: code\ndata: ${JSON.stringify({ rev })}\n\n`)
      })
      heartbeat = setInterval(() => {
        if (scope !== undefined && !scope.alive()) {
          end()
          return
        }
        push(': keep-alive\n\n')
      }, CODE_STREAM_HEARTBEAT_MS)
      heartbeat.unref?.()
      if (scope !== undefined) detach = scope.attach(end)
    },
    cancel() {
      release()
    },
  })
  return new Response(body, { headers: STREAM_HEADERS })
}

/** The runner's answer as HTTP: the hub's own codes, then the runner's. */
function replied(reply: LinkReply): Response {
  if (reply.ok) return json(reply.result ?? {})
  if (reply.code === 'timeout') return fail(504, 'timeout', reply.message)
  if (reply.code === 'offline') return fail(409, 'offline', reply.message)
  const code = /^E_[A-Z_]{1,30}$/.test(reply.code)
    ? (reply.code as `E_${string}`)
    : 'E_RUNNER'
  return fail(409, code, reply.message)
}

/** A line of text: 1–65,536 UTF-16 code units, no NUL. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_TEXT &&
    !value.includes('\0')
    ? value
    : null
}

async function write(
  ctx: RouteContext,
  links: CodeLinks,
  owner: string,
  copy: CodeCopy,
  verb: 'messages' | 'answer' | 'stop',
): Promise<Response> {
  const body = await readJsonObject(ctx.request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const session = copy.header.id
  let request: LinkRequest
  if (verb === 'messages') {
    const text = textOf(body.text)
    if (text === null)
      return fail(400, 'invalid', `text 要有 1–${MAX_TEXT} 个字符`)
    if (typeof body.clientId !== 'string' || !CLIENT_ID.test(body.clientId))
      return fail(400, 'invalid', 'clientId 不对')
    request = { t: 'send', session, text, clientId: body.clientId }
  } else if (verb === 'answer') {
    if (typeof body.ask !== 'string' || !ASK_ID.test(body.ask))
      return fail(400, 'invalid', '征询 id 不对')
    const decision = DECISIONS.find(one => one === body.decision)
    if (decision === undefined)
      return fail(400, 'invalid', 'decision 只能是 once、session、deny')
    if (
      body.message !== undefined &&
      (typeof body.message !== 'string' ||
        body.message.length > MAX_MESSAGE ||
        CONTROL.test(body.message))
    )
      return fail(400, 'invalid', 'message 不对')
    request = {
      t: 'answer',
      session,
      ask: body.ask,
      decision,
      ...(typeof body.message === 'string' && body.message !== ''
        ? { message: body.message }
        : {}),
    }
  } else request = { t: 'stop', session }
  if (!copy.header.remote)
    return fail(409, 'remote_off', 'Remote 已在那台电脑上关掉，只能看')
  if (!links.online(copy.device))
    return fail(409, 'offline', '设备离线，只能看')
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const reply = await links.ask(owner, copy.device, request)
  await ctx.record(
    verb === 'messages'
      ? 'code.remote.send'
      : verb === 'answer'
        ? 'code.remote.answer'
        : 'code.remote.stop',
    `${copy.device}/${session}`,
    reply.ok ? 'ok' : 'refused',
    reply.ok ? undefined : reply.code,
  )
  return replied(reply)
}

async function dispatch(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const { url, request } = ctx
  const name = rest[0]
  const verb = rest[3]
  // The paths first: anything else under `/v0/code` is the router's 404.
  const shape =
    name === 'stream' && rest.length === 1
      ? 'stream'
      : name !== 'sessions'
        ? null
        : rest.length === 1
          ? 'list'
          : rest.length === 3
            ? 'copy'
            : rest.length === 4 &&
                (verb === 'messages' || verb === 'answer' || verb === 'stop')
              ? verb
              : null
  if (shape === null) return notFound(`unknown path: ${url.pathname}`)
  const isStream = shape === 'stream'
  const reading =
    request.method === 'GET' || request.method === 'HEAD' || isStream
  // Role before existence, as everywhere: the stream leans on fetch metadata,
  // the rest on the console header.
  const denied = reading
    ? guard(ctx.access.credential, 'view', isStream ? 'stream' : 'guarded')
    : guardChat(ctx.access, 'guarded')
  if (denied !== null) return denied
  const owner = ownerOf(ctx)
  if (owner instanceof Response) return owner
  const allowed =
    shape === 'copy'
      ? ['GET', 'DELETE']
      : shape === 'stream' || shape === 'list'
        ? ['GET']
        : ['POST']
  if (!allowed.includes(request.method)) return methodNotAllowed(allowed)
  const links = ctx.deps.codeLinks
  if (links === undefined)
    return fail(501, 'unsupported', '这台中枢没有接 Remote')
  if (shape === 'stream') return stream(ctx, links, owner)
  if (shape === 'list') return list(ctx, links, owner)
  const device = rest[1] ?? ''
  const session = rest[2] ?? ''
  const copy =
    CODE_DEVICE_ID.test(device) && CODE_SESSION_ID.test(session)
      ? links
          .copies(owner)
          .find(one => one.device === device && one.header.id === session)
      : undefined
  if (copy === undefined) return notFound('没有这个 Remote 会话')
  if (shape !== 'copy') return write(ctx, links, owner, copy, shape)
  if (request.method === 'DELETE') {
    if (copy.header.remote)
      return fail(409, 'remote_on', 'Remote 还开着，先在那台电脑上关掉')
    const blocked = await ctx.admit()
    if (blocked !== null) return blocked
    const removed = ctx.deps.codeCopies?.remove(owner, device, session) ?? false
    links.changed(owner)
    await ctx.record(
      'code.remote.drop',
      `${device}/${session}`,
      removed ? 'ok' : 'failed',
    )
    return removed
      ? new Response(null, { status: 204 })
      : notFound('没有这个 Remote 会话')
  }
  const before = positive(url.searchParams.get('before'))
  const limit = positive(url.searchParams.get('limit'))
  if (
    before === null ||
    limit === null ||
    (limit !== undefined && limit > CODE_READ_MAX)
  )
    return fail(
      400,
      'invalid',
      `before 要是正整数，limit 在 1–${CODE_READ_MAX} 之间`,
    )
  const page = ctx.deps.codeCopies?.read(
    owner,
    device,
    session,
    before,
    limit ?? 100,
  )
  if (page === undefined) return notFound('没有这个 Remote 会话')
  const names = await deviceNames(ctx, owner)
  return json({
    session: summaryOf(copy, {
      id: device,
      name: names.get(device) ?? device,
      online: links.online(device),
    }),
    records: page.records,
    more: page.more,
    lastSeq: page.lastSeq,
  })
}

/** `/v0/code/…`, claimed by the conversation module (`routes/chat.ts`). */
export const codeApiRoute: HeadRoute = {
  heads: ['code'],
  handle: (ctx, _head, rest) => dispatch(ctx, rest),
}
