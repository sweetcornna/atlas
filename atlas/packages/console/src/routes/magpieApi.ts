// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/magpie` (P33/P34): the platform's magpie model gateway.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/magpie`, `GET /v0/magpie/usage?period=` | view and up (key tails and full addresses only for writers) |
 * | `GET /v0/magpie/agents` | view and up (failure details only for writers) |
 * | every `POST` and `DELETE` | personal ops, outside break-glass, a platform subject when there are tenants |
 *
 * The agents section (P36.5) takes its writes as
 * `POST /v0/magpie/agents/{configure,install,remove,autojoin,join}`.
 *
 * The hub never relays model traffic: these routes only drive magpie's
 * management API through the port. No key value, upstream key or management
 * key ever comes back.
 */

import type {
  MagpieAgentChange,
  MagpieAgentsSnapshot,
  MagpieBinding,
  MagpieCaller,
  MagpieConnectDraft,
  MagpieGroupDraft,
  MagpieKeyChange,
  MagpieKeyDraft,
  MagpieLimitDraft,
  MagpieProviderDraft,
  MagpieSnapshot,
  MagpieUsagePeriod,
} from '../directionPorts.js'
import {
  MAGPIE_AFFINITIES,
  MAGPIE_LANES,
  MAGPIE_LIMIT_PERIODS,
  MAGPIE_ROUTINGS,
  MAGPIE_USAGE_PERIODS,
} from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
  write,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const GROUP_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RUNTIME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** What a delivered profile accepts as a model id (`@qianmo/providers`). */
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:/~@+-]{0,127}$/
const AGENT_ACTIONS = [
  'configure',
  'install',
  'remove',
  'autojoin',
  'join',
] as const
type AgentAction = (typeof AGENT_ACTIONS)[number]

/**
 * May this caller change the gateway: a personal `ops` account outside
 * break-glass, and a platform subject when the console has tenants
 * (`tenancy-m2.md`: the platform's model plumbing is the platform's).
 */
export function magpieWriter(ctx: RouteContext): boolean {
  const principal = ctx.access.principal
  if (
    principal?.kind !== 'user' ||
    principal.role !== 'ops' ||
    ctx.access.breakGlass
  )
    return false
  const tenancy = ctx.deps.tenancy
  if (tenancy === undefined) return true
  try {
    return tenancy.read().config.platformSubjects.includes(principal.subject)
  } catch {
    return false
  }
}

/** The caller a port write is made under. */
function callerOf(ctx: RouteContext): MagpieCaller {
  return {
    ...actorOf(ctx),
    breakGlass: ctx.access.breakGlass,
    record: ctx.record,
  }
}

/** `node:<id>` or `tenant:<id>`, or null. */
export function bindingOf(raw: unknown): MagpieBinding | null {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>
    return bindingOf(`${String(value['kind'])}:${String(value['id'])}`)
  }
  if (typeof raw !== 'string') return null
  const at = raw.indexOf(':')
  const kind = raw.slice(0, at)
  const id = raw.slice(at + 1)
  if (kind === 'node' && NODE_ID.test(id)) return { kind, id }
  if (kind === 'tenant' && TENANT_ID.test(id)) return { kind, id }
  return null
}

/** The ledger target for a binding: our own grammar, never request text. */
export function bindingKey(binding: MagpieBinding): string {
  return `${binding.kind}:${binding.id}`
}

/** Host and port of an origin, without the scheme. */
function hostOf(url: string | null): string | null {
  if (url === null) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/** What a caller who may not write sees: no key tails, addresses by host. */
export function magpieForReader(
  snapshot: MagpieSnapshot,
  writer: boolean,
): MagpieSnapshot {
  if (writer) return snapshot
  return {
    ...snapshot,
    connection: {
      ...snapshot.connection,
      gatewayUrl: hostOf(snapshot.connection.gatewayUrl),
      managementUrl: hostOf(snapshot.connection.managementUrl),
    },
    keys: snapshot.keys.map(key => ({ ...key, masked: null })),
  }
}

/** What a caller who may not write sees of the agents: names and states, no failure text. */
export function magpieAgentsForReader(
  snapshot: MagpieAgentsSnapshot,
  writer: boolean,
): MagpieAgentsSnapshot {
  if (writer) return snapshot
  return {
    ...snapshot,
    nodes: snapshot.nodes.map(node => ({
      ...node,
      error: null,
      runtimes: node.runtimes.map(runtime => ({
        ...runtime,
        failed:
          runtime.failed === null ? null : { ...runtime.failed, message: null },
      })),
      agents: node.agents.map(agent => ({
        ...agent,
        reason:
          agent.reason === null ? null : { ...agent.reason, message: null },
        write: agent.write === null ? null : { ...agent.write, message: null },
      })),
    })),
  }
}

// --- body parsing ------------------------------------------------------

class Invalid extends Error {}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Invalid(`${key} 要是字符串`)
  return value.trim()
}

function strings(
  body: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some(item => typeof item !== 'string')
  )
    throw new Invalid(`${key} 要是字符串列表`)
  return (value as string[]).map(item => item.trim()).filter(Boolean)
}

function oneOf<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = str(body, key)
  if (value === undefined || value === '') return undefined
  if (!(values as readonly string[]).includes(value))
    throw new Invalid(`${key} 不在可选范围内`)
  return value as T
}

function count(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
    throw new Invalid(`${key} 要是非负数`)
  return n
}

function limitsOf(value: unknown): readonly MagpieLimitDraft[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 5)
    throw new Invalid('限额最多 5 条')
  return value.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new Invalid('限额的形状不对')
    const row = raw as Record<string, unknown>
    const period = oneOf(row, 'period', MAGPIE_LIMIT_PERIODS)
    if (period === undefined) throw new Invalid('限额要给周期')
    const days = count(row['days'], 'days')
    const hours = count(row['hours'], 'hours')
    const tokens = count(row['tokens'], 'tokens')
    const cost = count(row['cost'], 'cost')
    return {
      period,
      ...(days === undefined ? {} : { days }),
      ...(hours === undefined ? {} : { hours }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(cost === undefined ? {} : { cost }),
      ...(row['cacheReads'] === true ? { cacheReads: true } : {}),
    }
  })
}

function connectDraft(body: Record<string, unknown>): MagpieConnectDraft {
  const gatewayUrl = str(body, 'gatewayUrl')
  const managementUrl = str(body, 'managementUrl')
  if (!gatewayUrl || !managementUrl) throw new Invalid('网关与管理地址都要填')
  const managementKey = str(body, 'managementKey')
  const port = count(body['webCookiePort'], 'webCookiePort')
  return {
    gatewayUrl,
    managementUrl,
    ...(managementKey ? { managementKey } : {}),
    ...(port === undefined ? {} : { webCookiePort: port }),
  }
}

function providerDraft(body: Record<string, unknown>): MagpieProviderDraft {
  const preset = str(body, 'preset')
  const key = str(body, 'key')
  const name = str(body, 'name')
  const urls: { chat?: string; responses?: string; anthropic?: string } = {}
  for (const lane of ['chat', 'responses', 'anthropic'] as const) {
    const url = str(body, lane)
    if (url) urls[lane] = url
  }
  const custom = Object.keys(urls).length > 0
  if (preset && custom) throw new Invalid('选了预设就不填地址')
  if (!preset && !custom) throw new Invalid('要选预设或填自定义地址')
  if (!preset && !name) throw new Invalid('自定义上游要给名称')
  return {
    preset: preset ?? '',
    ...(key ? { key } : {}),
    ...(name ? { name } : {}),
    ...urls,
  }
}

function groupDraft(body: Record<string, unknown>): MagpieGroupDraft {
  const id = str(body, 'id')
  if (!id) throw new Invalid('路由组 id 必填')
  const from = str(body, 'from')
  const name = str(body, 'name')
  const members = strings(body, 'members')
  const routing = oneOf(body, 'routing', MAGPIE_ROUTINGS)
  const affinity = oneOf(body, 'affinity', MAGPIE_AFFINITIES)
  return {
    id,
    ...(from ? { from } : {}),
    ...(name ? { name } : {}),
    ...(members === undefined ? {} : { members }),
    ...(routing === undefined ? {} : { routing }),
    ...(affinity === undefined ? {} : { affinity }),
  }
}

function keyDraft(body: Record<string, unknown>): MagpieKeyDraft {
  const binding = bindingOf(body['binding'])
  if (binding === null) throw new Invalid('要选节点或租户')
  const mainModel = str(body, 'mainModel')
  if (!mainModel) throw new Invalid('主模型必填')
  const fastModel = str(body, 'fastModel')
  const lane = oneOf(body, 'lane', MAGPIE_LANES)
  const limits = limitsOf(body['limits'])
  const models = strings(body, 'models')
  return {
    binding,
    mainModel,
    ...(fastModel ? { fastModel } : {}),
    ...(lane === undefined ? {} : { lane }),
    ...(limits === undefined ? {} : { limits }),
    ...(models === undefined || models.length === 0 ? {} : { models }),
  }
}

function keyChange(body: Record<string, unknown>): MagpieKeyChange {
  const enabled = body['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean')
    throw new Invalid('enabled 要是布尔值')
  const limits = limitsOf(body['limits'])
  const models =
    body['models'] === null
      ? null
      : (() => {
          const list = strings(body, 'models')
          return list === undefined || list.length === 0 ? undefined : list
        })()
  const mainModel = str(body, 'mainModel')
  const fast = body['fastModel']
  const fastModel =
    fast === null
      ? null
      : fast === undefined
        ? undefined
        : str(body, 'fastModel') || null
  const reset = body['resetLimit']
  if (
    reset !== undefined &&
    reset !== 'all' &&
    !(typeof reset === 'number' && Number.isInteger(reset) && reset >= 0)
  )
    throw new Invalid('resetLimit 要是序号或 all')
  return {
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(limits === undefined ? {} : { limits }),
    ...(models === undefined ? {} : { models }),
    ...(mainModel ? { mainModel } : {}),
    ...(fastModel === undefined ? {} : { fastModel }),
    ...(reset === undefined ? {} : { resetLimit: reset as number | 'all' }),
  }
}

function nodeOf(body: Record<string, unknown>): string {
  const node = str(body, 'node')
  if (!node || !NODE_ID.test(node)) throw new Invalid('节点名无效')
  return node
}

function runtimeOf(body: Record<string, unknown>): string {
  const runtime = str(body, 'runtime')
  if (!runtime || !RUNTIME_ID.test(runtime)) throw new Invalid('底层 id 无效')
  return runtime
}

function agentChange(body: Record<string, unknown>): MagpieAgentChange {
  const node = nodeOf(body)
  const agent = str(body, 'agent')
  if (!agent || !AGENT_ID.test(agent)) throw new Invalid('智能体名无效')
  const runtime = str(body, 'runtime')
  if (runtime !== undefined && !RUNTIME_ID.test(runtime))
    throw new Invalid('底层 id 无效')
  const model = str(body, 'model')
  if (model !== undefined && model !== 'auto' && !MODEL_ID.test(model))
    throw new Invalid('模型 id 无效')
  if (!runtime && !model) throw new Invalid('要给底层或模型')
  return {
    node,
    agent,
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
  }
}

// --- routing -----------------------------------------------------------

type Name =
  | 'snapshot'
  | 'usage'
  | 'connect'
  | 'check'
  | 'provider-add'
  | 'provider'
  | 'provider-test'
  | 'group-save'
  | 'group'
  | 'key-issue'
  | 'key'
  | 'key-rotate'
  | 'agents'
  | `agents-${AgentAction}`

/** Which route a path is and the methods it takes, or null for none. */
function routeOf(
  rest: readonly string[],
): { readonly name: Name; readonly allowed: readonly string[] } | null {
  const [head, id, tail] = rest
  if (rest.length === 0) return { name: 'snapshot', allowed: ['GET'] }
  if (head === 'agents') {
    if (rest.length === 1) return { name: 'agents', allowed: ['GET'] }
    const action = AGENT_ACTIONS.find(one => one === id)
    if (rest.length === 2 && action !== undefined)
      return { name: `agents-${action}`, allowed: ['POST'] }
    return null
  }
  if (rest.length === 1) {
    if (head === 'usage') return { name: 'usage', allowed: ['GET'] }
    if (head === 'connection') return { name: 'connect', allowed: ['POST'] }
    if (head === 'check') return { name: 'check', allowed: ['POST'] }
    if (head === 'providers') return { name: 'provider-add', allowed: ['POST'] }
    if (head === 'groups') return { name: 'group-save', allowed: ['POST'] }
    if (head === 'keys') return { name: 'key-issue', allowed: ['POST'] }
    return null
  }
  if (rest.length === 2 && id !== undefined) {
    if (head === 'providers')
      return { name: 'provider', allowed: ['POST', 'DELETE'] }
    if (head === 'groups') return { name: 'group', allowed: ['DELETE'] }
    if (head === 'keys') return { name: 'key', allowed: ['POST', 'DELETE'] }
    return null
  }
  if (rest.length === 3) {
    if (head === 'providers' && tail === 'test')
      return { name: 'provider-test', allowed: ['POST'] }
    if (head === 'keys' && tail === 'rotate')
      return { name: 'key-rotate', allowed: ['POST'] }
  }
  return null
}

function invalid(message: string): Response {
  return fail(400, 'invalid', message)
}

/** One write of the agents section, recorded under our own target. */
async function agentsWrite(
  ctx: RouteContext,
  name: Name,
  caller: MagpieCaller,
): Promise<Response> {
  const agents = ctx.deps.magpie?.agents
  if (agents === undefined) return unwired('节点控制链路')
  const body = await bodyOf(ctx)
  if (body instanceof Response) return body
  try {
    if (name === 'agents-configure') {
      const change = agentChange(body)
      return write(
        ctx,
        'runtime.configure',
        `qianmo://${change.node}/${change.agent}`,
        () => agents.configure(change, caller),
      )
    }
    if (name === 'agents-install' || name === 'agents-remove') {
      const input = { node: nodeOf(body), runtime: runtimeOf(body) }
      const target = `${input.node}/${input.runtime}`
      return name === 'agents-install'
        ? write(ctx, 'runtime.install', target, () =>
            agents.install(input, caller),
          )
        : write(ctx, 'runtime.remove', target, () =>
            agents.remove(input, caller),
          )
    }
    if (name === 'agents-autojoin') {
      const on = body['on']
      if (typeof on !== 'boolean') throw new Invalid('on 要是布尔值')
      return write(ctx, 'magpie.autojoin', 'magpie', () =>
        agents.setAutoJoin(on, caller),
      )
    }
    const node = nodeOf(body)
    return write(ctx, 'magpie.key.issue', `node:${node}`, () =>
      agents.join(node, caller),
    )
  } catch (error) {
    if (error instanceof Invalid) return invalid(error.message)
    throw error
  }
}

export const magpieApi: HeadRoute = {
  heads: ['magpie'],
  async handle(ctx, _head, rest) {
    const route = routeOf(rest)
    if (route === null) return notFound(`unknown path: ${ctx.url.pathname}`)
    const read = ctx.request.method === 'GET' && route.allowed.includes('GET')
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    if (!read && !magpieWriter(ctx))
      return fail(
        403,
        'forbidden',
        '模型网关需要平台运维的个人账号 · 共用令牌与 break-glass 只能查看',
      )
    if (!route.allowed.includes(ctx.request.method))
      return methodNotAllowed([...route.allowed])
    const port = ctx.deps.magpie
    if (!port) return unwired('模型网关')

    if (route.name === 'snapshot') {
      const snapshot = await port.snapshot()
      return answer(
        snapshot.ok
          ? {
              ok: true,
              value: magpieForReader(snapshot.value, magpieWriter(ctx)),
            }
          : snapshot,
      )
    }
    if (route.name === 'usage') {
      const period = ctx.url.searchParams.get('period') ?? '7d'
      if (!(MAGPIE_USAGE_PERIODS as readonly string[]).includes(period))
        return invalid('用量周期只能是 today 7d 30d all')
      return answer(await port.usage(period as MagpieUsagePeriod))
    }

    if (route.name === 'agents') {
      const agents = port.agents
      if (agents === undefined) return unwired('节点控制链路')
      const snapshot = await agents.snapshot()
      return answer(
        snapshot.ok
          ? {
              ok: true,
              value: magpieAgentsForReader(snapshot.value, magpieWriter(ctx)),
            }
          : snapshot,
      )
    }

    const caller = callerOf(ctx)

    if (route.name.startsWith('agents-'))
      return agentsWrite(ctx, route.name, caller)

    if (route.name === 'check')
      return write(ctx, 'magpie.check', 'magpie', () => port.check(caller))

    if (route.name === 'provider' || route.name === 'provider-test') {
      const id = segment(rest[1])
      if (id === null || !PROVIDER_ID.test(id)) return invalid('上游 id 无效')
      if (route.name === 'provider-test')
        return write(ctx, 'magpie.provider.test', id, () =>
          port.testProvider(id, caller),
        )
      if (ctx.request.method === 'DELETE') {
        const response = await write(ctx, 'magpie.provider.remove', id, () =>
          port.removeProvider(id, caller),
        )
        return response.ok ? new Response(null, { status: 204 }) : response
      }
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      if (typeof body['enabled'] !== 'boolean')
        return invalid('enabled 要是布尔值')
      const on = body['enabled']
      return write(ctx, 'magpie.provider.toggle', id, () =>
        port.setProviderEnabled(id, on, caller),
      )
    }

    if (route.name === 'group') {
      const id = segment(rest[1])
      if (id === null || !GROUP_ID.test(id)) return invalid('路由组 id 无效')
      const response = await write(ctx, 'magpie.group.remove', id, () =>
        port.removeGroup(id, caller),
      )
      return response.ok ? new Response(null, { status: 204 }) : response
    }

    if (route.name === 'key' || route.name === 'key-rotate') {
      const binding = bindingOf(segment(rest[1]))
      if (binding === null) return invalid('绑定无效')
      const target = bindingKey(binding)
      if (route.name === 'key-rotate')
        return write(ctx, 'magpie.key.rotate', target, () =>
          port.rotateKey(binding, caller),
        )
      if (ctx.request.method === 'DELETE')
        return write(ctx, 'magpie.key.remove', target, () =>
          port.removeKey(binding, caller),
        )
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      let change: MagpieKeyChange
      try {
        change = keyChange(body)
      } catch (error) {
        if (error instanceof Invalid) return invalid(error.message)
        throw error
      }
      return write(ctx, 'magpie.key.update', target, () =>
        port.updateKey(binding, change, caller),
      )
    }

    const body = await bodyOf(ctx)
    if (body instanceof Response) return body
    try {
      if (route.name === 'connect') {
        const draft = connectDraft(body)
        return write(ctx, 'magpie.connect', 'magpie', () =>
          port.connect(draft, caller),
        )
      }
      if (route.name === 'provider-add') {
        const draft = providerDraft(body)
        return write(ctx, 'magpie.provider.save', 'new', () =>
          port.saveProvider(draft, caller),
        )
      }
      if (route.name === 'group-save') {
        const draft = groupDraft(body)
        return write(
          ctx,
          'magpie.group.save',
          GROUP_ID.test(draft.id) ? draft.id : '-',
          () => port.saveGroup(draft, caller),
        )
      }
      const draft = keyDraft(body)
      return write(ctx, 'magpie.key.issue', bindingKey(draft.binding), () =>
        port.issueKey(draft, caller),
      )
    } catch (error) {
      if (error instanceof Invalid) return invalid(error.message)
      throw error
    }
  },
}
