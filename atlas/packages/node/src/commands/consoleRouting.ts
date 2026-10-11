// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
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
  MODEL_DIRECTIONS,
  isModelDirection,
  routingProblem,
  type ModelRouting,
  type ProviderProfile,
} from '@qianmo/providers'
import {
  ensurePrivateDir,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'

type State = {
  v: 1
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
    })),
    revision,
    updatedAt: null,
    updatedBy: null,
  }
}
function validView(raw: ModelRoutingView): boolean {
  return (
    !!raw &&
    (raw.node === null || /^[a-z0-9-]{1,32}$/.test(raw.node)) &&
    typeof raw.auto === 'boolean' &&
    Number.isSafeInteger(raw.revision) &&
    raw.revision >= 0 &&
    (raw.updatedAt === null ||
      (Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0)) &&
    (raw.updatedBy === null || typeof raw.updatedBy === 'string') &&
    Array.isArray(raw.routes) &&
    raw.routes.length === MODEL_DIRECTIONS.length &&
    new Set(raw.routes.map(r => r.direction)).size ===
      MODEL_DIRECTIONS.length &&
    raw.routes.every(validRoute)
  )
}
function validRoute(raw: ModelRouteView): boolean {
  return (
    !!raw &&
    isModelDirection(raw.direction) &&
    ((raw.profileId === null && raw.modelId === null) ||
      (typeof raw.profileId === 'string' &&
        /^[a-z0-9-]{1,48}$/.test(raw.profileId) &&
        typeof raw.modelId === 'string' &&
        raw.modelId.length > 0))
  )
}
export function routingWire(view: ModelRoutingView): ModelRouting {
  const routes: ModelRouting['routes'] = {}
  for (const route of view.routes)
    if (route.profileId !== null && route.modelId !== null)
      routes[route.direction] = {
        profileId: route.profileId,
        modelId: route.modelId,
      }
  return { auto: view.auto, routes }
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
      return { v: 1, defaults: empty(), nodes: [], revision: 0 }
    const state = JSON.parse(text) as State
    if (
      state.v !== 1 ||
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
          if (
            d &&
            isModelDirection(d.direction) &&
            ['hint', 'auto', 'default'].includes(String(d.source)) &&
            typeof d.model === 'string' &&
            typeof d.agent === 'string'
          )
            recent.push({
              node: source.node,
              agent: d.agent,
              at: record.at,
              direction: d.direction,
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
        (input.node !== null && !/^[a-z0-9-]{1,32}$/.test(input.node)) ||
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
      if (!/^[a-z0-9-]{1,32}$/.test(node)) return rejected('节点名不合法')
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
    if (
      !(actor.role === 'ops' && actor.subject.startsWith('u:')) &&
      actor.subject !== 'legacy:admin'
    )
      return rejected('需要 ops 或管理令牌')
    let fd: number | undefined
    try {
      ensurePrivateDir(path.dirname(this.#options.path))
      fd = fs.openSync(`${this.#options.path}.lock`, 'wx', 0o600)
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
      if (fd !== undefined) {
        fs.closeSync(fd)
        fs.unlinkSync(`${this.#options.path}.lock`)
      }
    }
  }
}
