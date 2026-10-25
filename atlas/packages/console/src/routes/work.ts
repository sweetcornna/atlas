// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 工作 — `/v0/work/…` (P37.17 B, `docs/dev/work-tasks.md` §4).
 *
 * A work session is a chat session with a `work` mark; everything here sits
 * on the chat face's guard and its port. Opening one goes through the same
 * `ChatDispatch` as `POST /v0/chat/sessions` (role, tenancy, quota, the
 * owner record), and reading its activity counts as reading the transcript.
 * Outputs come from the node that runs the session, over the hub's control
 * link (`deps.work`), and only ever for a session this caller may read: the
 * node and agent are the session record's, never the request's.
 *
 * `file` and `preview` are `stream` routes, like `/v0/chat/stream`: an
 * `<a download>` and an `<iframe src>` cannot send the console header, so a
 * cookie alone is enough unless `Sec-Fetch-Site` says another origin sent
 * it. Both only read.
 */

import { parseAddress } from '@qianmo/protocol'
import { chatScopeOf } from '../accountsHttp.js'
import { ChatDispatch } from '../chatDispatch.js'
import type { ChatTarget, ChatTranscript, WorkFailure } from '../deps.js'
import {
  fail,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import {
  deliveredFiles,
  isWorkflowId,
  isWorkName,
  WORKFLOWS,
  type WorkflowId,
} from '../work.js'
import { parseChatText } from './chatText.js'
import { HIDDEN_SESSION, noteTranscriptRead } from './chatReads.js'
import {
  failureResponse,
  guardChat,
  outcomeOf,
  preferredMainAgent,
  type Protection,
} from './shared.js'
import type { RouteContext } from './types.js'

/** The keys `POST /v0/work/sessions` takes (§1.2). */
const OPEN_KEYS: ReadonlySet<string> = new Set(['agent', 'workflow', 'text'])

function workUnsupported(): Response {
  return fail(501, 'unsupported', '该控制台没有接控制链路，取不了产出')
}

function workFailure(failure: WorkFailure): Response {
  return failure.code === 'limit'
    ? fail(413, 'limit', failure.message)
    : failureResponse({ code: failure.code, message: failure.message })
}

/** The executor when none was picked: the front's main agent rule (§1.3). */
function mainTarget(
  targets: readonly ChatTarget[],
  preferred: string | undefined,
): ChatTarget | undefined {
  const listed =
    preferred === undefined
      ? undefined
      : targets.find(target => target.address === preferred)
  return listed ?? targets.find(target => target.dialable)
}

async function openWork(ctx: RouteContext): Promise<Response> {
  const { request, deps } = ctx
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const chat = deps.chat!
  const body = await readJsonObject(request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const unknown = Object.keys(body).filter(key => !OPEN_KEYS.has(key))
  if (unknown.length > 0)
    return fail(400, 'invalid', `不认识的字段：${unknown.join('、')}`)
  const agent = body['agent'] ?? undefined
  if (
    agent !== undefined &&
    (typeof agent !== 'string' || parseAddress(agent) === null)
  )
    return fail(400, 'invalid', 'agent 必须是 qianmo://<节点>/<智能体> 地址')
  const workflow = body['workflow'] ?? undefined
  if (workflow !== undefined && !isWorkflowId(workflow))
    return fail(400, 'invalid', '没有这个工作流')
  let text: string | undefined
  if (body['text'] !== undefined && body['text'] !== null) {
    const parsed = parseChatText(body)
    if (!parsed.ok) return fail(400, 'invalid', parsed.message)
    text = parsed.value
  }
  const targets = await chat.targets()
  if (!targets.ok) return failureResponse(targets.failure)
  const dispatch = new ChatDispatch(ctx)
  let target: ChatTarget | undefined
  if (agent !== undefined) {
    target = targets.value.find(row => row.address === agent)
    if (target === undefined) return fail(404, 'not_found', '没有这个智能体')
    const denied = dispatch.authorize(target.address)
    if (denied !== null) return denied
  } else {
    target = mainTarget(targets.value, preferredMainAgent(deps))
    if (target === undefined)
      return fail(400, 'rejected', '现在没有能对话的智能体')
  }
  if (!target.dialable) return fail(400, 'rejected', '这个智能体现在不能对话')
  const address = target.address
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const opened = await dispatch.open(
    address,
    async result => {
      await ctx.record('work.session.open', address, ...outcomeOf(result))
    },
    {
      work: true,
      ...(workflow === undefined ? {} : { workflow: workflow as WorkflowId }),
    },
  )
  if (opened instanceof Response) return opened
  if (!opened.ok) return failureResponse(opened.failure)
  const session = opened.value
  if (text === undefined) return json({ session, turn: null })
  const sent = await dispatch.send({
    sessionId: session.id,
    text,
    ...(workflow === undefined ? {} : { workflow: workflow as WorkflowId }),
  })
  if (sent instanceof Response) {
    // The session is open; the page goes into it and shows why the first
    // line did not leave (§1.2).
    let error: unknown = null
    try {
      error = ((await sent.clone().json()) as { error?: unknown }).error ?? null
    } catch {
      error = null
    }
    return json({ error, session }, sent.status)
  }
  await ctx.record('chat.message.send', session.id, ...outcomeOf(sent))
  if (!sent.ok) {
    const answer = failureResponse(sent.failure)
    const error = ((await answer.json()) as { error?: unknown }).error ?? null
    return json({ error, session }, answer.status)
  }
  return json({ session, turn: sent.value })
}

/** The transcript behind `/v0/work/sessions/<id>/…`, read through the port. */
async function readableSession(
  ctx: RouteContext,
  sessionId: string,
): Promise<ChatTranscript | Response> {
  const transcript = await ctx.deps.chat!.transcript(sessionId)
  return transcript.ok ? transcript.value : failureResponse(transcript.failure)
}

function attachmentName(name: string): string {
  const base = name.split('/').pop() ?? name
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`
}

const DOWNLOAD_HEADERS = {
  'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
} as const

/** The preview's policy (§4.4): inline styles and `data:` images, no script. */
export const WORK_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox"

async function fetchOutput(
  ctx: RouteContext,
  sessionId: string,
  view: 'file' | 'preview',
): Promise<Response> {
  const { request, deps, url } = ctx
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const name = url.searchParams.get('name')
  if (!isWorkName(name)) return fail(400, 'invalid', '文件名不合法')
  // A download is a reading the ledger must take, before the node is asked.
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const found = await readableSession(ctx, sessionId)
  if (found instanceof Response) return found
  const work = deps.work
  if (work === undefined) return workUnsupported()
  const result = await work.fetch(found.session, name, view)
  if (!result.ok) return workFailure(result.failure)
  await ctx.record('work.output.read', `${sessionId} ${name}`, 'ok')
  const file = result.value
  return new Response(file.body, {
    status: 200,
    headers:
      view === 'file'
        ? {
            ...DOWNLOAD_HEADERS,
            'content-type': file.mime,
            'content-length': String(file.size),
            'content-disposition': attachmentName(name),
            'content-security-policy': "default-src 'none'; sandbox",
          }
        : {
            ...DOWNLOAD_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(file.size),
            'content-disposition': 'inline',
            'content-security-policy': WORK_PREVIEW_CSP,
            'x-frame-options': 'SAMEORIGIN',
          },
  })
}

async function sessionRoute(
  ctx: RouteContext,
  sessionId: string,
  name: 'activity' | 'outputs' | 'file' | 'preview',
): Promise<Response> {
  const { request, deps } = ctx
  if (name === 'file' || name === 'preview')
    return await fetchOutput(ctx, sessionId, name)
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  // Both read the conversation: the transcript read window covers them.
  const reading = await noteTranscriptRead(ctx, sessionId, false)
  if (reading instanceof Response) return reading
  const found = await readableSession(ctx, sessionId)
  if (found instanceof Response) {
    await reading.done(false)
    return found
  }
  await reading.done(true)
  const { session, turns, activity } = found
  if (name === 'activity') {
    return json({
      work: session.work === true,
      workflow: session.workflow ?? null,
      progress: activity?.progress ?? null,
      context: activity?.context ?? null,
      delivered: deliveredFiles(turns),
    })
  }
  const work = deps.work
  if (work === undefined) return workUnsupported()
  const listed = await work.outputs(session)
  return listed.ok ? json(listed.value) : workFailure(listed.failure)
}

export async function dispatchWorkApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const { access, accounts, deps, url, request } = ctx
  if (rest.length === 0) return notFound(`unknown path: ${url.pathname}`)
  const protection: Protection =
    rest[0] === 'sessions' &&
    rest.length === 3 &&
    (rest[2] === 'file' || rest[2] === 'preview')
      ? 'stream'
      : 'guarded'
  // Role before existence, as on the chat face.
  const denied = guardChat(access, protection)
  if (denied !== null) return denied
  if (deps.chat === undefined)
    return fail(
      501,
      'unsupported',
      '该控制台没有配置聊天通道 · 启动 qm console 时给 --chat-url 与传输层 PSK',
    )
  if (rest[0] === 'workflows' && rest.length === 1) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return json({
      workflows: WORKFLOWS.map(one => ({
        id: one.id,
        skill: one.skill,
        outputs: [...one.outputs],
      })),
    })
  }
  if (rest[0] !== 'sessions') return notFound(`unknown path: ${url.pathname}`)
  if (rest.length === 1) return await openWork(ctx)
  const part = rest[2] ?? ''
  if (
    rest.length !== 3 ||
    !(
      part === 'activity' ||
      part === 'outputs' ||
      part === 'file' ||
      part === 'preview'
    )
  )
    return notFound(`unknown path: ${url.pathname}`)
  let sessionId: string
  try {
    sessionId = decodeURIComponent(rest[1] ?? '')
  } catch {
    return fail(400, 'invalid', '会话 id 不合法')
  }
  if (!chatScopeOf(access, accounts).visible(sessionId))
    return failureResponse(HIDDEN_SESSION)
  return await sessionRoute(ctx, sessionId, part)
}
