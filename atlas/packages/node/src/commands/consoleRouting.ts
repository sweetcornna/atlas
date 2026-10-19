// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import type {
  ActionLedgerPort,
  ConsoleAuditSource,
  ConsoleResult,
  DirectionActor,
  ModelRoutingPort,
  ModelRoutingSnapshot,
  ModelRoutingView,
  ModelRouteView,
  RouteDecisionView,
} from '@qianmo/console'
import {
  LEGACY_DIRECTIONS,
  MODEL_DIRECTIONS,
  directionOf,
  isModelDirection,
  isTierEffort,
  migrateLegacyRoutes,
  routingProblem,
  tierEffortChoices,
  type LegacyDirection,
  type ModelRouting,
  type ProviderProfile,
} from '@qianmo/providers'
import {
  acquirePrivateLock,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'

/**
 * v2 (P38): the three tiers and three media, each with an effort. A v1 book
 * (the eight P22 directions) is read and mapped, and written back as v2 on
 * the next save or clear.
 */
type State = {
  v: 2
  defaults: ModelRoutingView
  nodes: ModelRoutingView[]
  revision: number
}
type Options = {
  path: string
  profiles: () => readonly ProviderProfile[]
  actions?: ActionLedgerPort
  audits?: readonly ConsoleAuditSource[]
  now?: () => number
}
const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value })
const rejected = <T>(message: string): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'rejected', message },
})
function empty(node: string | null = null, revision = 0): ModelRoutingView {
  return {
    node,
    auto: false,
    routes: MODEL_DIRECTIONS.map(direction => ({
      direction,
      profileId: null,
      modelId: null,
      effort: null,
    })),
    revision,
    updatedAt: null,
    updatedBy: null,
  }
}
function validHead(raw: ModelRoutingView): boolean {
  return (
    !!raw &&
    (raw.node === null || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.node)) &&
    typeof raw.auto === 'boolean' &&
    Number.isSafeInteger(raw.revision) &&
    raw.revision >= 0 &&
    (raw.updatedAt === null ||
      (Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0)) &&
    (raw.updatedBy === null || typeof raw.updatedBy === 'string') &&
    Array.isArray(raw.routes)
  )
}
function validView(raw: ModelRoutingView): boolean {
  return (
    validHead(raw) &&
    raw.routes.length === MODEL_DIRECTIONS.length &&
    new Set(raw.routes.map(r => r.direction)).size ===
      MODEL_DIRECTIONS.length &&
    raw.routes.every(validRoute)
  )
}
function validRef(raw: {
  readonly profileId: unknown
  readonly modelId: unknown
}): boolean {
  return (
    (raw.profileId === null && raw.modelId === null) ||
    (typeof raw.profileId === 'string' &&
      /^[a-z0-9-]{1,48}$/.test(raw.profileId) &&
      typeof raw.modelId === 'string' &&
      raw.modelId.length > 0)
  )
}
function validRoute(raw: ModelRouteView): boolean {
  return (
    !!raw &&
    isModelDirection(raw.direction) &&
    validRef(raw) &&
    // An effort belongs to a picked model; following the main model has none.
    (raw.effort === null ||
      (isTierEffort(raw.effort) && raw.profileId !== null))
  )
}
type LegacyRouteView = {
  readonly direction: LegacyDirection
  readonly profileId: string | null
  readonly modelId: string | null
}
/** A v1 view (the eight P22 directions) as v2; `null` when it is not one. */
function migratedView(raw: ModelRoutingView): ModelRoutingView | null {
  if (!validHead(raw)) return null
  const routes = raw.routes as unknown as readonly LegacyRouteView[]
  if (
    routes.length !== LEGACY_DIRECTIONS.length ||
    new Set(routes.map(r => r.direction)).size !== LEGACY_DIRECTIONS.length ||
    !routes.every(
      r =>
        !!r &&
        (LEGACY_DIRECTIONS as readonly unknown[]).includes(r.direction) &&
        validRef(r),
    )
  )
    return null
  const picked: Partial<
    Record<LegacyDirection, { profileId: string; modelId: string }>
  > = {}
  for (const r of routes)
    if (r.profileId !== null && r.modelId !== null)
      picked[r.direction] = { profileId: r.profileId, modelId: r.modelId }
  const tiers = migrateLegacyRoutes(picked)
  return {
    ...raw,
    routes: MODEL_DIRECTIONS.map(direction => ({
      direction,
      profileId: tiers[direction]?.profileId ?? null,
      modelId: tiers[direction]?.modelId ?? null,
      effort: null,
    })),
  }
}
export function routingWire(view: ModelRoutingView): ModelRouting {
  const routes: ModelRouting['routes'] = {}
  for (const route of view.routes)
    if (route.profileId !== null && route.modelId !== null)
      routes[route.direction] = {
        profileId: route.profileId,
        modelId: route.modelId,
        ...(route.effort === null ? {} : { effort: route.effort }),
      }
  return { auto: view.auto, routes }
}
/** The book as stored, either version, as v2; throws when it is neither. */
function parseBook(text: string): State {
  const raw = JSON.parse(text) as {
    v?: unknown
    defaults: ModelRoutingView
    nodes: ModelRoutingView[]
    revision: number
  }
  if (raw.v === 1) {
    const defaults = migratedView(raw.defaults)
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.map(migratedView) : null
    if (defaults === null || nodes === null || nodes.some(n => n === null))
      throw new Error('invalid routing book')
    return {
      v: 2,
      defaults,
      nodes: nodes as ModelRoutingView[],
      revision: raw.revision,
    }
  }
  if (raw.v !== 2) throw new Error('invalid routing book')
  return raw as State
}
/** Private atomic JSON; every operation re-reads, and writes hold an exclusive lock. */
export class ConsoleRouting implements ModelRoutingPort {
  readonly #options: Options
  constructor(options: Options) {
    this.#options = options
  }
  #read(): State {
    const text = readTextIfExists(this.#options.path)
    if (text === undefined)
      return { v: 2, defaults: empty(), nodes: [], revision: 0 }
    const state = parseBook(text)
    if (
      !validView(state.defaults) ||
      state.defaults.node !== null ||
      !Array.isArray(state.nodes) ||
      !state.nodes.every(n => validView(n) && n.node !== null) ||
      new Set(state.nodes.map(n => n.node)).size !== state.nodes.length ||
      !Number.isSafeInteger(state.revision) ||
      state.revision <
        Math.max(state.defaults.revision, ...state.nodes.map(n => n.revision))
    )
      throw new Error('invalid routing book')
    const stat = fs.lstatSync(this.#options.path)
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error('routing book must be owner-only')
    return state
  }
  effective(node: string): ModelRoutingView {
    const state = this.#read()
    return {
      ...(state.nodes.find(n => n.node === node) ?? state.defaults),
      node,
      revision: state.revision,
    }
  }
  async #record(
    action: 'routing.save' | 'routing.clear',
    target: string,
    actor: DirectionActor,
    outcome: 'ok' | 'refused' | 'failed',
  ): Promise<void> {
    try {
      await this.#options.actions?.record({
        action,
        target,
        subject: actor.subject,
        requestId: actor.requestId,
        outcome,
        at: (this.#options.now ?? Date.now)(),
      })
    } catch {
      /* The mutation has happened; the HTTP ledger admission guards writes. */
    }
  }
  async snapshot(): Promise<ConsoleResult<ModelRoutingSnapshot>> {
    try {
      const state = this.#read()
      const recent: RouteDecisionView[] = []
      for (const source of this.#options.audits ?? []) {
        const page = await source.audit.read({ q: 'model.route', limit: 20 })
        if (!page.ok || !page.value.intact) continue
        for (const record of page.value.records) {
          if (record.kind !== 'model.route') continue
          const d = record.detail
          // A node older than P38 records the P22 name.
          const direction = directionOf(d?.direction)
          if (
            d &&
            direction !== null &&
            ['hint', 'auto', 'default'].includes(String(d.source)) &&
            typeof d.model === 'string' &&
            typeof d.agent === 'string'
          )
            recent.push({
              node: source.node,
              agent: d.agent,
              at: record.at,
              direction,
              source: d.source as RouteDecisionView['source'],
              model: d.model,
            })
        }
      }
      return ok({
        defaults: { ...state.defaults, revision: state.revision },
        nodes: state.nodes.map(n => ({ ...n, revision: state.revision })),
        models: this.#options.profiles().flatMap(p =>
          p.models.map(m => ({
            profileId: p.id,
            profileName: p.name,
            modelId: m.id,
            kind: m.kind ?? 'chat',
            evaluated: p.evaluated !== false,
            efforts: tierEffortChoices(m, p),
          })),
        ),
        recent: recent.sort((a, b) => b.at - a.at).slice(0, 20),
      })
    } catch {
      return rejected('路由簿不可用 · 检查格式、权限与模型服务簿')
    }
  }
  async save(
    input: Parameters<ModelRoutingPort['save']>[0],
    actor: DirectionActor,
  ): Promise<ConsoleResult<ModelRoutingView>> {
    return this.#mutate(input.node, actor, 'routing.save', state => {
      if (
        (input.node !== null &&
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.node)) ||
        typeof input.auto !== 'boolean' ||
        !Number.isSafeInteger(input.revision) ||
        !Array.isArray(input.routes) ||
        !input.routes.every(validRoute) ||
        new Set(input.routes.map(r => r.direction)).size !== input.routes.length
      )
        return rejected('路由输入不合法')
      const current =
        input.node === null
          ? state.defaults
          : (state.nodes.find(n => n.node === input.node) ?? {
              ...state.defaults,
              node: input.node,
            })
      if (input.revision !== state.revision)
        return rejected('revision 不符 · 请刷新后重试')
      const view: ModelRoutingView = {
        ...current,
        auto: input.auto,
        routes: current.routes.map(
          r => input.routes.find(patch => patch.direction === r.direction) ?? r,
        ),
        revision: state.revision + 1,
        updatedAt: (this.#options.now ?? Date.now)(),
        updatedBy: actor.subject,
      }
      const problem = routingProblem(
        routingWire(view),
        this.#options.profiles(),
      )
      if (problem) return rejected(problem)
      state.revision = view.revision
      if (input.node === null) state.defaults = view
      else
        state.nodes = [...state.nodes.filter(n => n.node !== input.node), view]
      return ok(view)
    })
  }
  async clearNode(
    node: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ModelRoutingView>> {
    return this.#mutate(node, actor, 'routing.clear', state => {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(node))
        return rejected('节点名不合法')
      state.nodes = state.nodes.filter(n => n.node !== node)
      state.revision++
      return ok({ ...state.defaults, node, revision: state.revision })
    })
  }
  async #mutate(
    node: string | null,
    actor: DirectionActor,
    action: 'routing.save' | 'routing.clear',
    change: (state: State) => ConsoleResult<ModelRoutingView>,
  ): Promise<ConsoleResult<ModelRoutingView>> {
    // A route ships another service's credentials to the nodes: the same
    // writer as the 模型服务 book, a personal ops account.
    if (!(actor.role === 'ops' && actor.subject.startsWith('u:')))
      return rejected('需要运维角色的个人账号')
    let lock: { release(): void } | null = null
    try {
      lock = acquirePrivateLock(`${this.#options.path}.lock`, {
        maxAgeMs: 5 * 60_000,
      })
      if (!lock) throw new Error('routing book is busy')
      const fresh = this.#read()
      const result = change(fresh)
      if (result.ok) writePrivateJson(this.#options.path, fresh)
      await this.#record(
        action,
        node ?? 'default',
        actor,
        result.ok ? 'ok' : 'refused',
      )
      return result
    } catch {
      await this.#record(action, node ?? 'default', actor, 'failed')
      return rejected('路由簿写入失败或正被另一进程使用')
    } finally {
      lock?.release()
    }
  }
}
