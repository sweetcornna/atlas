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
 *
 * ### 复制完成后的模型下发（`POST /v0/replicate/jobs/<作业>/models`）
 *
 * 模型服务的写操作只认运维角色的个人账号（`routes/providers.ts`，§7.3），共用
 * 令牌与 break-glass 不行；作业手里只有后者，而它的倒数第二步会重启控制台，发起
 * 部署的那次请求早已不在了。所以下发的名义在**开始**时就定下来：
 *
 * - `start` 时发起人若是模型服务的写者（{@link providerWriter}，且这台控制台对他
 *   接了模型服务），他的主体随 `modelsBy` 交给端口，端口给作业一张随机的单次授权，
 *   盘上只留摘要。发起人是共用令牌或 break-glass 时没有这张授权，作业最后一步只
 *   说明要运维去模型页下发。
 * - 作业到了「等待就绪」，把授权交回这条路由。这条路由**不看控制台凭据**：授权
 *   就是凭据，且只能换一件事——以发起人的名义，给这个作业登记的那一个节点下发它
 *   该有的档案（继承的默认档案或已有指派），不带 `force`、不指定档案、不动会话。
 * - 端口核对授权并作废它之后，这里再按模型服务的规则核一遍发起人：账号还在、还是
 *   ops；开了租户时还得是平台管理身份。下发由模型服务端口照常记 `provider.apply`，
 *   这里另记 `server.replicate.models`，两条都记在发起人名下、同一个请求 id。
 */

import { SERVERS_PAGE_JS } from '../assets/pageScripts.js'
import type { ConsoleCredential } from '../auth.js'
import type {
  ActionOutcome,
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
  calmApply,
  providerFailureResponse,
  providerWriter,
} from './providers.js'
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
  safeDecode,
  underPath,
  type Parsed,
} from './shared.js'
import type { ConsoleActionName, RouteContext, RouteModule } from './types.js'

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
  const modelsBy = modelsWriterOf(ctx)
  const result = await port.start({
    ticket,
    fingerprint,
    node,
    agent,
    server,
    ...(modelsBy === null ? {} : { modelsBy }),
  })
  await ctx.record('server.replicate.start', node, ...outcomeOf(result))
  return answer(result, 202)
}

/**
 * Who a copy job may ship a model profile for when it is done: the caller,
 * when they may write model services on this console right now. `null` for
 * the shared token, break-glass, a member, or a tenant whose scope has no
 * model services (`tenantScope.ts` drops the port for them).
 */
function modelsWriterOf(ctx: RouteContext): string | null {
  const principal = ctx.access.principal
  if (ctx.deps.providers === undefined || !providerWriter(ctx)) return null
  return principal?.kind === 'user' ? principal.subject : null
}

const MODELS_UNWIRED = '该控制台没有开模型服务 · 新节点没有档案可下发'
const MODELS_GRANT_REQUIRED = '缺少这次复制的下发授权'
/** 32 random bytes, base64url: what `consoleReplicate.ts` hands the job. */
const MODELS_GRANT = /^[A-Za-z0-9_-]{43}$/

/**
 * Why the person who started a copy may not ship its profile now, or `null`.
 * The same rule a direct apply meets (`providerWriter`), asked of an account
 * that is not on this request: still there, still `ops`, and a platform
 * subject when the console has tenants (`tenancy-m2.md`: shared profiles are
 * the platform's).
 */
function operatorStanding(ctx: RouteContext, subject: string): string | null {
  const book = ctx.accounts?.book
  if (book === undefined)
    return '这台控制台没有个人账号 · 模型档案请在模型页下发'
  const listed = book.list()
  if (!listed.ok) return '个人账号暂停服务 · 模型档案请稍后在模型页下发'
  const account = listed.value.accounts.find(one => one.subject === subject)
  if (account === undefined || account.state !== 'active') {
    return '发起部署的账号已不可用 · 模型档案请运维在模型页下发'
  }
  if (account.role !== 'ops') {
    return '发起部署的账号已不是运维角色 · 模型档案请运维在模型页下发'
  }
  const tenancy = ctx.deps.tenancy
  if (tenancy !== undefined) {
    let platform: boolean
    try {
      platform = tenancy.read().config.platformSubjects.includes(subject)
    } catch {
      return '租户配置不可用 · 模型档案请稍后在模型页下发'
    }
    if (!platform) return '模型档案需要平台管理身份下发 · 请在模型页下发'
  }
  return null
}

/**
 * A ledger line under `subject` on this request's id: the operator who
 * authorised the act, not the job that carried it out (`ctx.record` would
 * write `anonymous`, there being no console credential on the request).
 */
function recordAs(
  ctx: RouteContext,
  subject: string,
): (
  action: ConsoleActionName,
  target: string,
  outcome: ActionOutcome,
  code?: string,
) => Promise<boolean> {
  return async (action, target, outcome, code) => {
    const port = ctx.deps.actions
    if (port === undefined) return true
    try {
      const written = await port.record({
        // When it was written, as `ctx.record` stamps it: the apply takes a while.
        at: (ctx.deps.now ?? Date.now)(),
        requestId: ctx.requestId,
        subject,
        action,
        target,
        outcome,
        ...(code === undefined ? {} : { code }),
      })
      return written.ok
    } catch {
      return false
    }
  }
}

/**
 * `POST /v0/replicate/jobs/<job>/models` `{grant}`: the job's last step. See
 * the module note: the grant is the credential, and all it buys is one apply
 * of the job's own node, as the operator who started the job.
 */
async function handleReplicateModels(
  ctx: RouteContext,
  job: string,
): Promise<Response> {
  if (ctx.request.method !== 'POST') return methodNotAllowed(['POST'])
  const port = replicateOf(ctx)
  if (port instanceof Response) return port
  const providers = ctx.deps.providers
  if (providers === undefined) return fail(501, 'unsupported', MODELS_UNWIRED)
  const body = await readJsonObject(ctx.request)
  const grant = body?.['grant']
  if (typeof grant !== 'string' || !MODELS_GRANT.test(grant)) {
    return fail(401, 'unauthorized', MODELS_GRANT_REQUIRED)
  }
  // Before the grant is spent: a closed ledger must not cost the job its one try.
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const claim = await port.claimModels(job, grant)
  if (!claim.ok) return fail(403, 'forbidden', claim.failure.message)
  const { node, subject } = claim.value
  const record = recordAs(ctx, subject)
  const standing = operatorStanding(ctx, subject)
  if (standing !== null) {
    await record('server.replicate.models', node, 'refused', 'rejected')
    return fail(403, 'forbidden', standing)
  }
  const result = await providers.apply(
    { nodes: [node] },
    { subject, role: 'ops', breakGlass: false, record },
  )
  const shipped = result.ok
    ? result.value.find(one => one.node === node)
    : undefined
  let outcome: readonly [ActionOutcome, string?]
  if (!result.ok) outcome = ['failed', result.failure.code]
  else if (shipped === undefined) outcome = ['failed', 'no-result']
  else if (shipped.outcome === 'ok') outcome = ['ok']
  else outcome = [shipped.outcome, shipped.code ?? 'apply']
  await record('server.replicate.models', node, ...outcome)
  return result.ok
    ? json({ node, results: result.value.map(calmApply) })
    : providerFailureResponse(result.failure)
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
  if (verb === 'jobs' && tail.length === 2 && tail[1] === 'models') {
    const job = safeDecode(tail[0] ?? '')
    if (job === null) return notFound(`unknown path: ${ctx.url.pathname}`)
    return await handleReplicateModels(ctx, job)
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
