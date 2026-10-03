// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 节点 — the roster, and the four things the console does to it: register,
 * deregister, heartbeat, wake.
 *
 * Owns `/v0/agents/…`, `/v0/wake` and `/fragments/roster`.
 *
 * ## A wake target is chosen from the startup list, never supplied
 *
 * The multi-target form names a node, and the URL the wake goes to is looked
 * up in `deps.wakeTargets` — whatever URL the browser sent is discarded before
 * the port sees it. The set of things this console will act on is fixed when
 * it starts, so a caller holding the admin token cannot grow it by typing into
 * the page (`console.md` §4.4).
 */

import type {
  ConsoleAgent,
  ConsoleDeps,
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
import { renderRoster } from '../view/agents.js'
import {
  DEFAULT_BIN_NAME,
  failureOf,
  failureResponse,
  guard,
  optionalString,
  requiredString,
  valueOf,
  type Parsed,
} from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

function parseRegisterInput(
  body: Record<string, unknown>,
): Parsed<RegisterAgentInput> {
  const address = requiredString(body, 'address')
  if (!address.ok) return address
  const endpoint = requiredString(body, 'endpoint')
  if (!endpoint.ok) return endpoint
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
      address: address.value,
      endpoint: endpoint.value,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(publicKey.value === undefined ? {} : { publicKey: publicKey.value }),
      ...(status.value === undefined ? {} : { status: status.value }),
    },
  }
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

export async function rosterFragment(
  deps: ConsoleDeps,
  now: number,
): Promise<RosterRender> {
  // Two independent reads, overlapped: the certificate face lives behind the
  // same zero-auth registry the roster does (§5.2), and serialising them would
  // double the page's worst case for no gain. A certificate port that fails is
  // a strip on the page, never a 500 — same rule as every other port here.
  const certificatePort = deps.certificates
  const [result, certificates] = await Promise.all([
    deps.registry.list(),
    certificatePort?.read(),
  ])
  const agents = valueOf(result)
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
    const input = parseRegisterInput(body)
    if (!input.ok) return fail(400, 'invalid', input.message)
    const result = await deps.registry.register(input.value)
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
  const result = await ctx.deps.registry.deregister(address)
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
  const result = await ctx.deps.registry.heartbeat(address)
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
      '该控制台没有配置唤醒通道（缺少传输层 PSK），因此不能发起唤醒；' +
        '请在启动 occ console 时提供 PSK 后重试。',
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
    if (target === undefined) {
      return fail(403, 'rejected', '唤醒节点不在启动时配置的白名单中')
    }
    if (!input.value.to.startsWith('qianmo://' + target.node + '/')) {
      return fail(403, 'rejected', '唤醒地址与所选节点不匹配')
    }
    if (target.wake === undefined) {
      return fail(
        501,
        'unsupported',
        '节点 ' + target.node + ' 没有可用的唤醒 PSK',
      )
    }
    // The URL is selected only from the startup allowlist. A client-supplied
    // URL is intentionally discarded before it reaches the pinned wake port.
    const result = await target.wake.send({
      ...input.value,
      url: target.url,
    })
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  if (wake === undefined) {
    return fail(501, 'unsupported', '该控制台没有配置唤醒通道')
  }
  const result = await wake.send(input.value)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

export const nodesRoute: RouteModule = {
  area: {
    id: 'nodes',
    label: '节点',
    group: 'run',
    href: '/nodes',
    icon: 'server',
  },
  api: {
    heads: ['agents', 'wake'],
    async handle(ctx, head, rest) {
      if (head === 'wake') {
        if (rest.length === 0) return await handleWake(ctx)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      if (rest.length === 0) return await handleAgentsCollection(ctx)
      const address = decodeURIComponent(rest[0] ?? '')
      if (rest.length === 1) return await handleAgentItem(ctx, address)
      if (rest.length === 2 && rest[1] === 'heartbeat') {
        return await handleHeartbeat(ctx, address)
      }
      return notFound(`unknown path: ${ctx.url.pathname}`)
    },
  },
  fragments: {
    heads: ['roster'],
    async handle(ctx, _head, rest) {
      if (rest.length !== 0) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      return html((await rosterFragment(ctx.deps, ctx.now)).html)
    },
  },
}
