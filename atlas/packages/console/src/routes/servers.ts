// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 服务器 — which machine each node runs on, and the operator's note on it.
 *
 * Owns the `/admin/servers` page, `/v0/servers` and `/v0/servers/<id>/note`.
 *
 * ## A server id is chosen from the startup list, never supplied
 *
 * `PUT /v0/servers/<id>/note` looks the id up in `deps.nodeServers` before it
 * reads the body, and answers 403 when it is not there. This is the same rule
 * the wake route applies to a target and it is there for the same reason: the
 * set of things this console will act on is fixed when it starts, so a caller
 * holding the admin token cannot grow it by typing into the page. Without the
 * check, a note route would be an arbitrary key-value store that anyone with
 * that token could fill up.
 *
 * A console started without any `--node-server` answers 501 on both routes
 * rather than 200 with an empty list: "this console was not told where anything
 * runs" and "nothing runs anywhere" are different facts.
 *
 * ## 添加服务器（`/v0/replicate/*`、`/fragments/replicate/jobs`）
 *
 * 只在宿主接了 {@link ConsoleDeps.replicate}（`--replicate`）时出现。检查与开始
 * 都是运维级写动作，各记一条账；账里的 target 是 `user@host:port` 或节点名，
 * 从不带口令或私钥。请求体里的凭据只交给端口一次，回包里没有它。
 */

import { SERVERS_PAGE_JS } from '../assets/pageScripts.js'
import type { ConsoleCredential } from '../auth.js'
import type {
  ConsoleDeps,
  NodeServer,
  ReplicateAuthInput,
  ReplicatePort,
} from '../deps.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import {
  REPLICATE_CSS,
  renderReplicate,
  renderReplicateJobs,
} from '../view/replicate.js'
import { REPLICATE_PAGE_JS } from '../view/replicateScript.js'
import { answer, canOps, guardOpsWrite, guardRead } from './directionShared.js'
import {
  MAX_SERVER_NOTE_LENGTH,
  renderServers,
  serverCards,
} from '../view/servers.js'
import { escapeHtml } from '../view/escape.js'
import {
  failureOf,
  failureResponse,
  guard,
  outcomeOf,
  underPath,
  type Parsed,
} from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

/** The machines this console was started with. Empty means the face is off. */
function nodeServersOf(deps: ConsoleDeps): readonly NodeServer[] {
  return deps.nodeServers ?? []
}

const SERVERS_UNSUPPORTED =
  '该控制台没有配置服务器归属（启动时缺少 --node-server），因此没有可看的服务器；' +
  '请在启动 qm console 时用 --node-server <node>=<server> 指定后重试。'

/** An empty string is a legitimate value: it is how an operator clears a note. */
function parseServerNote(body: Record<string, unknown>): Parsed<string> {
  const value = body['note']
  if (typeof value !== 'string') {
    return { ok: false, message: '字段 note 必须是字符串' }
  }
  if (value.length > MAX_SERVER_NOTE_LENGTH) {
    return {
      ok: false,
      message: `备注最多 ${MAX_SERVER_NOTE_LENGTH} 个字符`,
    }
  }
  return { ok: true, value }
}

/**
 * The servers section, or nothing at all.
 *
 * `undefined` — not an empty string — when this console was started without a
 * mapping: the page then leaves the whole section out rather than rendering a
 * header over an explanation nobody asked for. Degradation here is "the feature
 * is not on this console", which is a different thing from "the feature failed".
 *
 * A note read that fails does **not** take the section with it: the machines
 * come from the startup flags and are still true, so the strip goes above them.
 */
async function serversFragment(
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  now: number,
): Promise<string | undefined> {
  const nodeServers = nodeServersOf(deps)
  if (nodeServers.length === 0) return undefined
  const notes = await deps.serverNotes?.list()
  return renderServers({
    cards: serverCards(nodeServers, notes?.ok === true ? notes.value : []),
    failure: notes === undefined ? null : failureOf(notes),
    // Both halves matter: a view token may read a note but not write one, and
    // a console with no store may not write one whoever is holding it.
    editable: credential.role === 'admin' && deps.serverNotes !== undefined,
    notesEnabled: deps.serverNotes !== undefined,
    now,
  })
}

async function handleServers(ctx: RouteContext): Promise<Response> {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const nodeServers = nodeServersOf(ctx.deps)
  if (nodeServers.length === 0) {
    return fail(501, 'unsupported', SERVERS_UNSUPPORTED)
  }
  const notes = await ctx.deps.serverNotes?.list()
  if (notes !== undefined && !notes.ok) return failureResponse(notes.failure)
  return json({ servers: serverCards(nodeServers, notes?.value ?? []) })
}

/**
 * Write one machine's note.
 *
 * The allowlist check runs **before the body is read**, so an unknown id costs
 * a lookup rather than however many bytes the caller decided to send.
 */
async function handleServerNote(
  ctx: RouteContext,
  server: string,
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'PUT') return methodNotAllowed(['PUT'])
  const nodeServers = nodeServersOf(ctx.deps)
  if (nodeServers.length === 0) {
    return fail(501, 'unsupported', SERVERS_UNSUPPORTED)
  }
  if (!nodeServers.some(entry => entry.server === server)) {
    await ctx.record('server.note.set', server, 'refused', 'rejected')
    return fail(403, 'rejected', '该服务器不在启动时配置的白名单中')
  }
  const notes = ctx.deps.serverNotes
  if (notes === undefined) {
    return fail(
      501,
      'unsupported',
      '该控制台没有配置备注存储，因此不能保存备注。',
    )
  }
  const body = await readJsonObject(ctx.request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const note = parseServerNote(body)
  if (!note.ok) return fail(400, 'invalid', note.message)
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const result = await notes.set(server, note.value)
  await ctx.record('server.note.set', server, ...outcomeOf(result))
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

// ---------------------------------------------------------------------------
// 添加服务器

const REPLICATE_UNSUPPORTED =
  '该控制台没有打开「添加服务器」（启动时缺少 --replicate）'

/** The longest secret a request may carry: a private key is a few KB. */
const MAX_REPLICATE_SECRET = 16 * 1024

function replicateOf(ctx: RouteContext): ReplicatePort | Response {
  return ctx.deps.replicate ?? fail(501, 'unsupported', REPLICATE_UNSUPPORTED)
}

function stringField(
  body: Record<string, unknown>,
  name: string,
  max: number,
): string | null {
  const value = body[name]
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
    ? value.trim()
    : null
}

function parseReplicateAuth(value: unknown): ReplicateAuthInput | null {
  if (typeof value !== 'object' || value === null) return null
  const { kind, secret } = value as Record<string, unknown>
  if (kind !== 'password' && kind !== 'key') return null
  if (typeof secret !== 'string' || secret === '') return null
  if (secret.length > MAX_REPLICATE_SECRET) return null
  return { kind, secret }
}

async function handleReplicateInspect(ctx: RouteContext): Promise<Response> {
  const denied = guardOpsWrite(ctx)
  if (denied !== null) return denied
  if (ctx.request.method !== 'POST') return methodNotAllowed(['POST'])
  const port = replicateOf(ctx)
  if (port instanceof Response) return port
  const body = await readJsonObject(ctx.request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const host = stringField(body, 'host', 253)
  const user = stringField(body, 'user', 32)
  const sshPort = body['port'] === undefined ? 22 : body['port']
  const auth = parseReplicateAuth(body['auth'])
  if (host === null) return fail(400, 'invalid', '地址必填')
  if (user === null) return fail(400, 'invalid', '用户名必填')
  if (
    typeof sshPort !== 'number' ||
    !Number.isInteger(sshPort) ||
    sshPort < 1 ||
    sshPort > 65535
  ) {
    return fail(400, 'invalid', 'SSH 端口应在 1–65535')
  }
  if (auth === null) return fail(400, 'invalid', '要给口令或私钥')
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const result = await port.inspect({ host, port: sshPort, user, auth })
  await ctx.record(
    'server.replicate.inspect',
    `${user}@${host}:${sshPort}`,
    ...outcomeOf(result),
  )
  return answer(result)
}

async function handleReplicateStart(ctx: RouteContext): Promise<Response> {
  const denied = guardOpsWrite(ctx)
  if (denied !== null) return denied
  if (ctx.request.method !== 'POST') return methodNotAllowed(['POST'])
  const port = replicateOf(ctx)
  if (port instanceof Response) return port
  const body = await readJsonObject(ctx.request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const ticket = stringField(body, 'ticket', 128)
  const fingerprint = stringField(body, 'fingerprint', 128)
  const node = stringField(body, 'node', 64)
  const agent = stringField(body, 'agent', 63)
  const server = stringField(body, 'server', 64)
  if (ticket === null || fingerprint === null) {
    return fail(400, 'invalid', '先检查这台服务器 · 再确认部署')
  }
  if (node === null || agent === null || server === null) {
    return fail(400, 'invalid', '节点名 智能体名 服务器名都要填')
  }
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const result = await port.start({ ticket, fingerprint, node, agent, server })
  await ctx.record('server.replicate.start', node, ...outcomeOf(result))
  return answer(result, 202)
}

async function handleReplicateJobs(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const port = replicateOf(ctx)
  if (port instanceof Response) return port
  if (rest.length === 0) {
    const jobs = await port.jobs()
    return jobs.ok ? json({ jobs: jobs.value }) : failureResponse(jobs.failure)
  }
  return answer(await port.job(decodeURIComponent(rest[0] ?? '')))
}

async function replicateApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const [verb, ...tail] = rest
  if (verb === 'inspect' && tail.length === 0) {
    return await handleReplicateInspect(ctx)
  }
  if (verb === 'start' && tail.length === 0) {
    return await handleReplicateStart(ctx)
  }
  if (verb === 'jobs' && tail.length <= 1) {
    return await handleReplicateJobs(ctx, tail)
  }
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

async function replicateFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  if (rest.length !== 1 || rest[0] !== 'jobs') {
    return notFound(`unknown path: ${ctx.url.pathname}`)
  }
  const port = replicateOf(ctx)
  if (port instanceof Response) return port
  const jobs = await port.jobs()
  return jobs.ok
    ? html(renderReplicateJobs(jobs.value.slice(0, 8)))
    : failureResponse(jobs.failure)
}

async function replicateSection(ctx: RouteContext): Promise<string> {
  const port = ctx.deps.replicate
  if (port === undefined) return ''
  const jobs = await port.jobs()
  return (
    `<section class="sec" id="replicate-section">` +
    renderReplicate({
      writable: canOps(ctx),
      jobs: jobs.ok ? jobs.value.slice(0, 8) : [],
      jobsFailure: jobs.ok ? null : jobs.failure.message,
    }) +
    `</section>`
  )
}

/**
 * What the page says when the console was not told where anything runs: the
 * same fact the 501 states, in one line, with the flag that changes it.
 */
const SERVERS_ABSENT_LINE = '未配置服务器归属 · 启动时用 --node-server 指定'

export const serversRoute: RouteModule = {
  area: {
    id: 'servers',
    label: '服务器',
    group: 'manage',
    href: '/admin/servers',
    icon: 'hard-drive',
  },
  page: {
    match: underPath('servers'),
    guard: 'view',
    async render(ctx) {
      // Never polled: the cards hold a textarea somebody may be typing in.
      const cards = await serversFragment(
        ctx.deps,
        ctx.access.credential,
        ctx.now,
      )
      const replicate = await replicateSection(ctx)
      return {
        title: '服务器',
        body:
          replicate +
          (cards === undefined
            ? `<p class="hint">${escapeHtml(SERVERS_ABSENT_LINE)}</p>`
            : `<section class="sec" id="servers-section">` +
              `<div id="servers">${cards}</div></section>`),
      }
    },
    css: REPLICATE_CSS,
    script: SERVERS_PAGE_JS + REPLICATE_PAGE_JS,
  },
  fragments: {
    heads: ['replicate'],
    handle: (ctx, _head, rest) => replicateFragment(ctx, rest),
  },
  api: {
    heads: ['servers', 'replicate'],
    async handle(ctx, head, rest) {
      if (head === 'replicate') return await replicateApi(ctx, rest)
      if (rest.length === 0) return await handleServers(ctx)
      // The id rides in one percent-encoded segment, the same convention an
      // address uses. The charset the host enforces stops short of `/`, but it
      // allows `:` — an IPv6 literal is a legitimate machine name — so the
      // segment still has to be decoded rather than read raw.
      if (rest.length === 2 && rest[1] === 'note') {
        return await handleServerNote(ctx, decodeURIComponent(rest[0] ?? ''))
      }
      return notFound(`unknown path: ${ctx.url.pathname}`)
    },
  },
}
