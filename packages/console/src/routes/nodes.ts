// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 节点 — the roster, and the things the console does to it: register,
 * deregister, heartbeat, wake, and the lifecycle — pause, resume, retire
 * (P15.2, `tenancy-m1.md` §3.6).
 *
 * Owns the `/nodes` page and one node's four tabs — `/nodes/<node>` (概览),
 * `/nodes/<node>/agents`, `/nodes/<node>/lifecycle` and
 * `/nodes/<node>/models` (A3, J2; `view/node.ts`) — `/v0/agents/…`,
 * `/v0/registrations`, `/v0/wake`, `/fragments/roster` and
 * `/fragments/lifecycle/<node>`. The 「模型」 tab's content is the providers
 * area's (`/fragments/providers/node/<node>`); this module only gives it a
 * place.
 *
 * ## The lifecycle writes are ops writes
 *
 * Publish, pause, resume and retire take the admin guard — the admin token or
 * a personal `ops` account — and each asks the action ledger first and writes
 * exactly one line after: `ok`, `refused` with the rule that stopped it here
 * (`unavailable`, `unmanaged`, `retired`, …), or `failed` with the registry's
 * code. Who did it is written into the registration ledger as well, as the
 * same subject the action ledger names (`access.ts`, `subjectOf`).
 *
 * ## Register and wake are this page's actions
 *
 * They used to be two forms at the bottom of the one long page, five screens
 * under the roster they act on. They are now the top bar's buttons here and
 * on every node's page, each opening its form in a `<dialog>` (§6.4), and the
 * deregister and wake confirmations are dialogs on the same page. With a
 * managed list 注册节点 becomes 发布: the address is picked from the list and
 * the endpoint is the hub's (`tenancy-m1.md` §3.6).
 *
 * ## The lifecycle page reads the ledger, and writes only through the routes
 *
 * `/nodes/<node>/lifecycle` is drawn from `GET /v0/registrations`'s source,
 * the lifecycle port's snapshot, and the roster. Its four actions each open a
 * confirmation and then call the routes below, which ask the action ledger
 * and record exactly once; the page itself records nothing.
 *
 * ## A wake target is chosen from the startup list, never supplied
 *
 * The multi-target form names a node, and the URL the wake goes to is looked
 * up in `deps.wakeTargets` — whatever URL the browser sent is discarded before
 * the port sees it. The set of things this console will act on is fixed when
 * it starts, so a caller holding the admin token cannot grow it by typing into
 * the page (`console.md` §4.4).
 */

import { subjectOf } from '../access.js'
import type {
  ConsoleAgent,
  LifecycleChange,
  LifecycleOutcome,
  LifecycleRefusal,
  PublishInput,
  RegisterAgentInput,
  WakeInput,
} from '../deps.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import { NODES_PAGE_JS } from '../assets/pageScripts.js'
import {
  agentsOfNode,
  deregisterConfirm,
  registerDialog,
  renderRoster,
  wakeAvailable,
  wakeConfirm,
  wakeDialog,
  wakeTargetOptions,
} from '../view/agents.js'
import { renderAuditExcerpt } from '../view/audit.js'
import { icon } from '../view/bits.js'
import { certificateIndex } from '../view/certificates.js'
import { attr, escapeHtml } from '../view/escape.js'
import {
  LIFECYCLE_NO_SCRIPT,
  NODE_PAGE_CSS,
  NODE_PAGE_JS,
  lifecycleDialogs,
  nodeOf,
  nodeTabLabel,
  nodeTabPath,
  publishDialog,
  publishable,
  renderLedgerOnly,
  renderLifecycle,
  renderModelsTab,
  renderNodeOverview,
  renderNodeTabs,
  type LifecycleModel,
  type NodeOverviewModel,
  type NodeTab,
} from '../view/node.js'
import {
  DEFAULT_BIN_NAME,
  canWrite,
  failureOf,
  failureResponse,
  guard,
  optionalString,
  outcomeOf,
  readOnlyNote,
  requiredString,
  safeDecode,
  textParam,
  valueOf,
  type Parsed,
} from './shared.js'
import type {
  ConsoleActionName,
  PageRender,
  RouteContext,
  RouteModule,
} from './types.js'

/** What a registration says besides where: the same three optional fields either way. */
function parseDeclarationTail(
  body: Record<string, unknown>,
): Parsed<Omit<RegisterAgentInput, 'address' | 'endpoint'>> {
  const publicKey = optionalString(body, 'publicKey')
  if (!publicKey.ok) return publicKey
  const status = optionalString(body, 'status')
  if (!status.ok) return status

  const rawCapabilities = body['capabilities']
  let capabilities: readonly string[] | undefined
  if (rawCapabilities !== undefined && rawCapabilities !== null) {
    if (
      !Array.isArray(rawCapabilities) ||
      rawCapabilities.some(item => typeof item !== 'string')
    ) {
      return { ok: false, message: '字段 capabilities 必须是字符串数组' }
    }
    capabilities = rawCapabilities as readonly string[]
  }

  return {
    ok: true,
    value: {
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(publicKey.value === undefined ? {} : { publicKey: publicKey.value }),
      ...(status.value === undefined ? {} : { status: status.value }),
    },
  }
}

function parseRegisterInput(
  body: Record<string, unknown>,
): Parsed<RegisterAgentInput> {
  const address = requiredString(body, 'address')
  if (!address.ok) return address
  const endpoint = requiredString(body, 'endpoint')
  if (!endpoint.ok) return endpoint
  const tail = parseDeclarationTail(body)
  if (!tail.ok) return tail
  return {
    ok: true,
    value: { address: address.value, endpoint: endpoint.value, ...tail.value },
  }
}

/**
 * The publish body. The endpoint may be left out: with a managed list it comes
 * from the hub's configuration (`tenancy-m1.md` §3.6), and the ledger says so
 * when one that was given does not match.
 */
function parsePublishInput(
  body: Record<string, unknown>,
): Parsed<PublishInput> {
  const address = requiredString(body, 'address')
  if (!address.ok) return address
  const endpoint = optionalString(body, 'endpoint')
  if (!endpoint.ok) return endpoint
  const tail = parseDeclarationTail(body)
  if (!tail.ok) return tail
  return {
    ok: true,
    value: {
      address: address.value,
      ...(endpoint.value === undefined || endpoint.value.trim() === ''
        ? {}
        : { endpoint: endpoint.value }),
      ...tail.value,
    },
  }
}

// --- the lifecycle (P15.2) -------------------------------------------------

const LIFECYCLE_UNSUPPORTED =
  '该控制台没有接入登记簿的生命周期 · 不能暂停、恢复或退役'

/** The three lifecycle sub-routes and the verb each is written down under. */
const LIFECYCLE_ACTIONS = {
  pause: 'agent.pause',
  resume: 'agent.resume',
  retire: 'agent.retire',
} as const satisfies Record<string, ConsoleActionName>

type LifecycleAction = keyof typeof LIFECYCLE_ACTIONS

function isLifecycleAction(name: string | undefined): name is LifecycleAction {
  return name !== undefined && Object.hasOwn(LIFECYCLE_ACTIONS, name)
}

/**
 * The answer to a refusal the ledger made before anything left: the status,
 * and the body's code from the console's one vocabulary (`respond.ts`). The
 * rule itself — `unmanaged`, `retired`, `paused` — is what the action ledger
 * records and what the message says.
 */
function refusalResponse(refusal: LifecycleRefusal): Response {
  switch (refusal.code) {
    case 'unavailable':
      return fail(503, 'unavailable', refusal.message)
    // Not on the list the hub was started with: the same answer a wake aimed
    // outside its allowlist gets.
    case 'unmanaged':
      return fail(403, 'rejected', refusal.message)
    // The state forbids it, and there is no doubt about which state: the
    // address is retired for good, or paused and waiting for resume.
    case 'retired':
    case 'paused':
      return fail(409, 'rejected', refusal.message)
    case 'not_found':
      return fail(404, 'not_found', refusal.message)
    case 'invalid':
      return fail(400, 'invalid', refusal.message)
  }
}

/**
 * Write one lifecycle outcome down and answer it: `ok`; `refused` with the
 * rule that stopped it on this side; `failed` with the registry's code.
 */
async function answerLifecycle(
  ctx: RouteContext,
  verb: ConsoleActionName,
  address: string,
  outcome: LifecycleOutcome<LifecycleChange>,
  success: (change: LifecycleChange) => Response,
): Promise<Response> {
  if (outcome.ok) {
    await ctx.record(verb, address, 'ok')
    return success(outcome.value)
  }
  if ('refusal' in outcome) {
    await ctx.record(verb, address, 'refused', outcome.refusal.code)
    return refusalResponse(outcome.refusal)
  }
  await ctx.record(verb, address, 'failed', outcome.failure.code)
  return failureResponse(outcome.failure)
}

async function handleLifecycle(
  ctx: RouteContext,
  address: string,
  action: LifecycleAction,
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'POST') return methodNotAllowed(['POST'])
  const lifecycle = ctx.deps.lifecycle
  if (lifecycle === undefined) {
    return fail(501, 'unsupported', LIFECYCLE_UNSUPPORTED)
  }
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const by = subjectOf(ctx.access)
  const outcome =
    action === 'pause'
      ? await lifecycle.pause(address, by)
      : action === 'resume'
        ? await lifecycle.resume(address, by)
        : await lifecycle.retire(address, by)
  return await answerLifecycle(
    ctx,
    LIFECYCLE_ACTIONS[action],
    address,
    outcome,
    change => json(change),
  )
}

/**
 * `GET /v0/registrations`: the ledger as it stands — each address's state,
 * the managed list, and what is wrong with the ledger if anything is.
 *
 * Who changed an entry is shown only to a caller who may write: the same rule
 * the alert acknowledgements keep (`deps.ts`, `AlertAck.by`) — who did what
 * belongs to the operations record, not to every reader.
 */
async function handleRegistrations(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (rest.length !== 0) return notFound(`unknown path: ${ctx.url.pathname}`)
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const lifecycle = ctx.deps.lifecycle
  if (lifecycle === undefined) {
    return fail(501, 'unsupported', LIFECYCLE_UNSUPPORTED)
  }
  const snapshot = await lifecycle.read()
  if (canWrite(ctx.access)) return json(snapshot)
  return json({
    ...snapshot,
    registrations: snapshot.registrations.map(({ by: _by, ...rest }) => rest),
  })
}

function parseWakeInput(body: Record<string, unknown>): Parsed<WakeInput> {
  const from = requiredString(body, 'from')
  if (!from.ok) return from
  const to = requiredString(body, 'to')
  if (!to.ok) return to
  const prompt = requiredString(body, 'prompt')
  if (!prompt.ok) return prompt
  const node = optionalString(body, 'node')
  if (!node.ok) return node
  // Optional, and empty means "the one this console was started with".
  // `createWakePort` pins the receipt URL and refuses any other value
  // (`consolePorts.ts`), so the field could only ever hold one string — the
  // form stopped asking for it, and a body without it is not malformed. Still
  // type-checked when present: a caller that sends a number is confused about
  // something and should hear about it.
  const url = optionalString(body, 'url')
  if (!url.ok) return url

  const rawAfter = body['afterMs']
  let afterMs: number | undefined
  if (rawAfter !== undefined && rawAfter !== null) {
    if (
      typeof rawAfter !== 'number' ||
      !Number.isFinite(rawAfter) ||
      rawAfter < 0
    ) {
      return { ok: false, message: '字段 afterMs 必须是非负数（毫秒）' }
    }
    afterMs = rawAfter
  }

  return {
    ok: true,
    value: {
      ...(node.value === undefined ? {} : { node: node.value }),
      from: from.value,
      to: to.value,
      prompt: prompt.value,
      url: url.value ?? '',
      ...(afterMs === undefined ? {} : { afterMs }),
    },
  }
}

/** The roster fragment, plus the list it was rendered from. */
interface RosterRender {
  readonly html: string
  /**
   * The agents themselves, so the page around the fragment can build its two
   * address pickers (the wake target and the trail's node filter) from the
   * *same* read rather than asking the registry a second time.
   */
  readonly agents: readonly ConsoleAgent[] | null
}

/**
 * The roster fragment, for the whole registry or for one node.
 *
 * The registry is read through `ctx.roster()`, the once-per-request read the
 * shell's sidebar count shares, so the count beside 节点 and the cards under it
 * come from one answer. `node` narrows the cards to one bare node name
 * (`/nodes/<node>`); the header counts then describe that node.
 */
async function rosterFragment(
  ctx: Pick<RouteContext, 'deps' | 'now' | 'roster' | 'access'>,
  node?: string,
): Promise<RosterRender> {
  const { deps, now } = ctx
  // Two independent reads, overlapped: the certificate face lives behind the
  // same zero-auth registry the roster does (§5.2), and serialising them would
  // double the page's worst case for no gain. A certificate port that fails is
  // a strip on the page, never a 500 — same rule as every other port here.
  const certificatePort = deps.certificates
  const [result, certificates] = await Promise.all([
    ctx.roster(),
    certificatePort?.read(),
  ])
  const listed = valueOf(result)
  const agents =
    listed === null || node === undefined ? listed : agentsOfNode(listed, node)
  return {
    html: renderRoster(
      agents,
      failureOf(result),
      now,
      deps.limits.registryTtlMs,
      certificatePort === undefined || certificates === undefined
        ? undefined
        : {
            snapshot: valueOf(certificates),
            failure: failureOf(certificates),
            roots: certificatePort.roots(),
            binName: deps.binName ?? DEFAULT_BIN_NAME,
          },
      deps.nodeServers,
      { canWrite: canWrite(ctx.access) },
    ),
    agents,
  }
}

async function handleAgentsCollection(ctx: RouteContext): Promise<Response> {
  const { request, deps } = ctx
  const credential = ctx.access.credential
  if (request.method === 'GET') {
    const denied = guard(credential, 'view', 'guarded')
    if (denied !== null) return denied
    const result = await deps.registry.list()
    return result.ok
      ? json({ agents: result.value })
      : failureResponse(result.failure)
  }
  if (request.method === 'POST') {
    const denied = guard(credential, 'admin', 'guarded')
    if (denied !== null) return denied
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const lifecycle = deps.lifecycle
    if (lifecycle !== undefined) {
      // With a lifecycle, registering is publishing (§3.6): the ledger checks
      // the managed list and the address's state, and writes down who.
      const publish = parsePublishInput(body)
      if (!publish.ok) return fail(400, 'invalid', publish.message)
      const blocked = await ctx.admit()
      if (blocked !== null) return blocked
      const outcome = await lifecycle.publish(
        publish.value,
        subjectOf(ctx.access),
      )
      // The body stays the registry's record, as it was before the ledger.
      return await answerLifecycle(
        ctx,
        'agent.register',
        publish.value.address,
        outcome,
        change =>
          change.agent === undefined
            ? json(change.registration)
            : json(change.agent),
      )
    }
    const input = parseRegisterInput(body)
    if (!input.ok) return fail(400, 'invalid', input.message)
    const blocked = await ctx.admit()
    if (blocked !== null) return blocked
    const result = await deps.registry.register(input.value)
    await ctx.record(
      'agent.register',
      input.value.address,
      ...outcomeOf(result),
    )
    // 200, not 201: the port answers with the record either way and cannot say
    // whether this address was new, so claiming "created" would be a guess.
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  return methodNotAllowed(['GET', 'POST'])
}

async function handleAgentItem(
  ctx: RouteContext,
  address: string,
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'DELETE') return methodNotAllowed(['DELETE'])
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const result = await ctx.deps.registry.deregister(address)
  await ctx.record('agent.deregister', address, ...outcomeOf(result))
  return result.ok
    ? new Response(null, { status: 204 })
    : failureResponse(result.failure)
}

async function handleHeartbeat(
  ctx: RouteContext,
  address: string,
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'POST') return methodNotAllowed(['POST'])
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const result = await ctx.deps.registry.heartbeat(address)
  await ctx.record('agent.heartbeat', address, ...outcomeOf(result))
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

async function handleWake(ctx: RouteContext): Promise<Response> {
  const { request, deps } = ctx
  const denied = guard(ctx.access.credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const wake = deps.wake
  if (wake === undefined && deps.wakeTargets === undefined) {
    return fail(
      501,
      'unsupported',
      '这台控制台启动时没有配置唤醒目标 · 用 qm console --wake-url 启动后再试',
    )
  }
  const body = await readJsonObject(request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const input = parseWakeInput(body)
  if (!input.ok) return fail(400, 'invalid', input.message)
  const configuredTargets = deps.wakeTargets
  if (configuredTargets !== undefined) {
    if (input.value.node === undefined || input.value.node.trim() === '') {
      return fail(400, 'invalid', '多目标唤醒必须给出 node')
    }
    const target = configuredTargets.find(
      candidate => candidate.node === input.value.node,
    )
    // A wake aimed outside the startup allowlist is the one refusal here
    // worth a ledger line: somebody holding the admin token tried to reach a
    // node this console was never told it may act on.
    if (target === undefined) {
      await ctx.record('wake.send', input.value.to, 'refused', 'rejected')
      return fail(403, 'rejected', '唤醒节点不在启动时配置的白名单中')
    }
    if (!input.value.to.startsWith('qianmo://' + target.node + '/')) {
      await ctx.record('wake.send', input.value.to, 'refused', 'rejected')
      return fail(403, 'rejected', '唤醒地址与所选节点不匹配')
    }
    if (target.wake === undefined) {
      return fail(
        501,
        'unsupported',
        '节点 ' + target.node + ' 没有可用的唤醒 PSK',
      )
    }
    const blocked = await ctx.admit()
    if (blocked !== null) return blocked
    // The URL is selected only from the startup allowlist. A client-supplied
    // URL is intentionally discarded before it reaches the pinned wake port.
    const result = await target.wake.send({
      ...input.value,
      url: target.url,
    })
    await ctx.record('wake.send', input.value.to, ...outcomeOf(result))
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  if (wake === undefined) {
    return fail(501, 'unsupported', '该控制台没有配置唤醒通道')
  }
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const result = await wake.send(input.value)
  await ctx.record('wake.send', input.value.to, ...outcomeOf(result))
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

/**
 * What the top bar offers to add an agent: the register form, or — with a
 * managed list — 发布 with the addresses still to publish (`null`: no list).
 */
interface AddAction {
  readonly register: boolean
  readonly publish: readonly string[] | null
}

/**
 * The dialogs and confirmations, rendered once, outside the polled regions: a
 * dialog inside a region the poller replaces would be replaced out from under
 * whoever is filling it in.
 */
function nodeDialogs(
  ctx: RouteContext,
  agents: readonly ConsoleAgent[] | null,
  add: AddAction,
): string {
  const { deps, now } = ctx
  // Nothing to open for a caller with nothing they may submit.
  if (!canWrite(ctx.access)) return ''
  const withRegister = add.register && add.publish === null
  return (
    (withRegister ? registerDialog() : '') +
    (add.publish !== null && add.publish.length > 0
      ? publishDialog(add.publish)
      : '') +
    (deps.lifecycle === undefined ? '' : lifecycleDialogs()) +
    wakeDialog({
      enabled: wakeAvailable(deps),
      targetOptions: wakeTargetOptions(agents, now, deps.limits.registryTtlMs),
      ...(deps.wakeUrl === undefined ? {} : { wakeUrl: deps.wakeUrl }),
      ...(deps.wakeTargets === undefined
        ? {}
        : { wakeTargets: deps.wakeTargets }),
      ...(deps.identity === undefined ? {} : { identity: deps.identity }),
    }) +
    deregisterConfirm() +
    wakeConfirm()
  )
}

/**
 * The top bar's actions: 唤醒, and 注册节点 or 发布, for a caller who may use
 * them; the read-only line for one who may not (C7). 发布 is drawn only when
 * there is a managed address left to publish.
 */
function nodeActions(ctx: RouteContext, add: AddAction): string {
  if (!canWrite(ctx.access)) return readOnlyNote(ctx.accounts !== undefined)
  const addButton =
    add.publish !== null
      ? add.publish.length === 0
        ? ''
        : `<button type="button" class="btn btn-primary" ` +
          `data-open-dialog="publish-dialog" data-write>` +
          icon('arrow-up', { small: true }) +
          `发布</button>`
      : add.register
        ? `<button type="button" class="btn btn-primary" ` +
          `data-open-dialog="register-dialog" data-write>` +
          icon('plus', { small: true }) +
          `注册节点</button>`
        : ''
  return (
    `<button type="button" class="btn btn-secondary" ` +
    `data-open-dialog="wake-dialog" data-write>` +
    icon('zap', { small: true }) +
    `唤醒</button>` +
    addButton
  )
}

/**
 * The polled roster region. The row actions report through the shell's
 * toasts (`assets/client.ts`), not a status line here: the rows are replaced
 * by the refresh that follows every action.
 */
function rosterRegion(fragment: string, poll: string): string {
  return (
    `<section class="sec" id="nodes-section">` +
    `<div id="roster" data-poll="${attr(poll)}">${fragment}</div>` +
    `</section>`
  )
}

/** The ledger, when this console has one. */
async function snapshotOf(ctx: RouteContext) {
  return (await ctx.deps.lifecycle?.read()) ?? null
}

/** What the top bar may add, given the ledger and the agents the roster lists. */
function addActionOf(
  snapshot: Awaited<ReturnType<typeof snapshotOf>>,
  agents: readonly ConsoleAgent[] | null,
  node?: string,
): AddAction {
  return {
    register: true,
    publish:
      snapshot === null || snapshot.managed === null
        ? null
        : publishable(snapshot, agents, node),
  }
}

async function nodesPage(ctx: RouteContext): Promise<PageRender> {
  const [roster, snapshot] = await Promise.all([
    rosterFragment(ctx),
    snapshotOf(ctx),
  ])
  const add = addActionOf(snapshot, roster.agents)
  return {
    title: '节点',
    actions: nodeActions(ctx, add),
    body:
      rosterRegion(roster.html, '/fragments/roster') +
      renderLedgerOnly(snapshot, roster.agents) +
      nodeDialogs(ctx, roster.agents, add),
    poll: true,
  }
}

/** One node's lifecycle, as the tab and its fragment draw it. */
async function lifecycleModelOf(
  ctx: RouteContext,
  node: string,
  snapshot?: Awaited<ReturnType<typeof snapshotOf>>,
): Promise<LifecycleModel> {
  const [listed, ledger] = await Promise.all([
    ctx.roster(),
    snapshot === undefined ? snapshotOf(ctx) : Promise.resolve(snapshot),
  ])
  const all = valueOf(listed)
  return {
    node,
    snapshot: ledger,
    agents: all === null ? null : agentsOfNode(all, node),
    rosterFailure: failureOf(listed),
    now: ctx.now,
    ttlMs: ctx.deps.limits.registryTtlMs,
    canWrite: canWrite(ctx.access),
  }
}

/**
 * Whether the console knows this node at all: the roster lists it, the
 * ledger or the managed list holds an address on it, or the startup flags
 * name it. A node whose every address is paused is off the roster and still
 * a page — the one that resumes it.
 */
function knownNode(ctx: RouteContext, model: LifecycleModel): boolean {
  const { node, agents, snapshot } = model
  if (agents === null || agents.length > 0) return true
  if (snapshot?.registrations.some(record => nodeOf(record.address) === node)) {
    return true
  }
  if (snapshot?.managed?.some(address => nodeOf(address) === node)) {
    return true
  }
  const { deps } = ctx
  return (
    deps.nodeServers?.some(entry => entry.node === node) === true ||
    deps.wakeTargets?.some(target => target.node === node) === true ||
    deps.audits?.some(source => source.node === node) === true
  )
}

/**
 * The latest lines of the trail about this node: its own trail when the
 * console reads one per node, else the console's one trail searched for the
 * node's name. Absent on a console of several trails with none for it.
 */
async function trailExcerpt(
  ctx: RouteContext,
  node: string,
): Promise<NodeOverviewModel['trail']> {
  const { deps } = ctx
  const enc = encodeURIComponent(node)
  if (deps.audits !== undefined) {
    const source = deps.audits.find(entry => entry.node === node)
    if (source === undefined) return undefined
    const result = await source.audit.read({ limit: 10 })
    return {
      page: valueOf(result),
      failure: failureOf(result),
      html: renderAuditExcerpt(valueOf(result), failureOf(result), node),
      href: `/audit?node=${enc}`,
    }
  }
  const result = await deps.audit.read({ q: node, limit: 10 })
  return {
    page: valueOf(result),
    failure: failureOf(result),
    html: renderAuditExcerpt(valueOf(result), failureOf(result)),
    href: `/audit?q=${enc}`,
  }
}

async function overviewOf(
  ctx: RouteContext,
  model: LifecycleModel,
): Promise<string> {
  const { deps, now } = ctx
  const node = model.node
  const [certificates, trail] = await Promise.all([
    deps.certificates?.read(),
    trailExcerpt(ctx, node),
  ])
  const server = deps.nodeServers?.find(entry => entry.node === node)?.server
  const certificate =
    certificates === undefined || !certificates.ok
      ? undefined
      : certificateIndex(certificates.value.certificates).get(node)
  return renderNodeOverview({
    node,
    agents: model.agents,
    rosterFailure: model.rosterFailure,
    now,
    ttlMs: deps.limits.registryTtlMs,
    ...(server === undefined ? {} : { server }),
    ...(certificate === undefined ? {} : { certificate }),
    lifecycle: deps.lifecycle === undefined ? null : model,
    ...(trail === undefined ? {} : { trail }),
  })
}

/** The lifecycle tab's polled region. */
function lifecycleRegion(model: LifecycleModel): string {
  const noScript =
    model.canWrite && model.snapshot !== null
      ? `<noscript><p class="note">${escapeHtml(LIFECYCLE_NO_SCRIPT)}</p></noscript>`
      : ''
  return (
    `<section class="sec" id="lifecycle-section">${noScript}` +
    `<div id="lifecycle" data-poll="${attr(
      `/fragments/lifecycle/${encodeURIComponent(model.node)}`,
    )}">${renderLifecycle(model)}</div></section>`
  )
}

/**
 * One node's page, on one of its four tabs (A3).
 *
 * A node the console knows nothing about is a 404, not an empty page: the URL
 * names something, and "nothing is registered under that name" is the
 * answer. A registry that cannot be read is the failure strip at 200 — the
 * node may well exist.
 */
async function nodePage(
  ctx: RouteContext,
  node: string,
  tab: NodeTab,
): Promise<PageRender | Response> {
  const snapshot = await snapshotOf(ctx)
  const model = await lifecycleModelOf(ctx, node, snapshot)
  if (!knownNode(ctx, model)) return notFound(`unknown node: ${node}`)
  const add = addActionOf(snapshot, model.agents, node)
  let content: string
  if (tab === 'agents') {
    const roster = await rosterFragment(ctx, node)
    content = rosterRegion(
      roster.html,
      `/fragments/roster?node=${encodeURIComponent(node)}`,
    )
  } else if (tab === 'lifecycle') {
    content = lifecycleRegion(model)
  } else if (tab === 'models') {
    content = renderModelsTab(node)
  } else {
    content = await overviewOf(ctx, model)
  }
  return {
    title: node,
    crumbs:
      tab === 'overview'
        ? [{ label: node }]
        : [
            { label: node, href: nodeTabPath(node, 'overview') },
            { label: nodeTabLabel(tab) },
          ],
    actions: nodeActions(ctx, add),
    body:
      renderNodeTabs(node, tab) + content + nodeDialogs(ctx, model.agents, add),
    ...(tab === 'overview' ? {} : { poll: true }),
  }
}

/** The tab a node page's second segment names; `null` for anything else. */
function tabOf(segment: string | undefined): NodeTab | null {
  if (segment === undefined) return 'overview'
  if (segment === 'agents') return 'agents'
  if (segment === 'lifecycle') return 'lifecycle'
  if (segment === 'models') return 'models'
  return null
}

export const nodesRoute: RouteModule = {
  area: {
    id: 'nodes',
    label: '节点',
    group: 'run',
    href: '/nodes',
    icon: 'server',
  },
  page: {
    // `/nodes`, `/nodes/<node>`, and `/nodes/<node>/<tab>` for the three
    // named tabs; anything else under `/nodes` is nobody's page.
    match(segments) {
      if (segments[0] !== 'nodes' || segments.length > 3) return null
      if (segments.length === 3 && tabOf(segments[2]) === null) return null
      return segments.slice(1)
    },
    guard: 'view',
    async render(ctx, rest) {
      const node = rest[0]
      if (node === undefined) return await nodesPage(ctx)
      const tab = tabOf(rest[1])
      if (tab === null) return notFound(`unknown path: ${ctx.url.pathname}`)
      const name = safeDecode(node)
      return name === null
        ? notFound(`unknown node: ${node}`)
        : await nodePage(ctx, name, tab)
    },
    css: NODE_PAGE_CSS,
    script: NODES_PAGE_JS + NODE_PAGE_JS,
  },
  api: {
    heads: ['agents', 'wake', 'registrations'],
    async handle(ctx, head, rest) {
      if (head === 'wake') {
        if (rest.length === 0) return await handleWake(ctx)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      if (head === 'registrations') {
        return await handleRegistrations(ctx, rest)
      }
      if (rest.length === 0) return await handleAgentsCollection(ctx)
      const address = decodeURIComponent(rest[0] ?? '')
      if (rest.length === 1) return await handleAgentItem(ctx, address)
      if (rest.length === 2 && rest[1] === 'heartbeat') {
        return await handleHeartbeat(ctx, address)
      }
      const action = rest[1]
      if (rest.length === 2 && isLifecycleAction(action)) {
        return await handleLifecycle(ctx, address, action)
      }
      return notFound(`unknown path: ${ctx.url.pathname}`)
    },
  },
  fragments: {
    heads: ['roster', 'lifecycle'],
    async handle(ctx, head, rest) {
      const lifecycle = head === 'lifecycle' && rest.length === 1
      if (!lifecycle && !(head === 'roster' && rest.length === 0)) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      if (lifecycle) {
        const node = safeDecode(rest[0] ?? '')
        if (node === null) return notFound(`unknown path: ${ctx.url.pathname}`)
        return html(renderLifecycle(await lifecycleModelOf(ctx, node)))
      }
      return html(
        (await rosterFragment(ctx, textParam(ctx.url.searchParams, 'node')))
          .html,
      )
    },
  },
}
