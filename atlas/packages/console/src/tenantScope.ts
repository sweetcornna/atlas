// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Access } from './access.js'
import type { ConsoleDeps, ConsoleResult, ChatPort, WakePort } from './deps.js'
import { fail } from './respond.js'
import { tenantScope, type TenantScope } from './tenancy.js'

const hidden = <T>(): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'not_found', message: '资源不存在' },
})
const filtered = <T>(
  result: ConsoleResult<readonly T[]>,
  allowed: (item: T) => boolean,
): ConsoleResult<readonly T[]> =>
  result.ok ? { ok: true, value: result.value.filter(allowed) } : result
const emptyAudit: ConsoleDeps['audit'] = {
  async read() {
    return {
      ok: true,
      value: {
        records: [],
        chain: 'empty',
        intact: true,
        issueCount: 0,
        total: 0,
        head: 0,
        earlier: null,
      },
    }
  },
  async chain() {
    return { ok: true, value: null }
  },
}

/** Called after authentication, per request. Never mutate the shared host adapters. */
export function scopedConsoleDeps(
  deps: ConsoleDeps,
  access: Access,
): { deps: ConsoleDeps; scope?: TenantScope } {
  const port = deps.tenancy
  if (port === undefined) return { deps }
  const scope = tenantScope(port.read(), access.principal, access.breakGlass)
  const current = () => {
    try {
      return port.read().revision === scope.revision
    } catch {
      return false
    }
  }
  // Platform membership can be withdrawn while the wake timer/handshake waits.
  // Preserve its broad scope only for the exact policy revision that granted it.
  if (scope.platform) {
    const guarded = (wake: WakePort): WakePort => ({
      async send(input) {
        if (!current()) return hidden()
        return wake.send({
          ...input,
          beforeDispatch: () => {
            if (!current()) throw new Error('E_AUTH_REVOKED: 资源不存在')
            input.beforeDispatch?.()
          },
        })
      },
    })
    return {
      scope,
      deps: {
        ...deps,
        ...(deps.wake === undefined ? {} : { wake: guarded(deps.wake) }),
        ...(deps.wakeTargets === undefined
          ? {}
          : {
              wakeTargets: deps.wakeTargets.map(target => ({
                ...target,
                ...(target.wake === undefined
                  ? {}
                  : { wake: guarded(target.wake) }),
              })),
            }),
      },
    }
  }
  const node = (id: string) => current() && scope.node(id)
  const address = (id: string) => current() && scope.address(id)
  const server = (id: string) => current() && scope.server(id)
  const {
    providers: _providers,
    about: _about,
    handoff: _handoff,
    wake: _wake,
    ...base
  } = deps
  const result: ConsoleDeps = {
    ...base,
    registry: {
      async list() {
        return filtered(await deps.registry.list(), v => address(v.address))
      },
      async register(input) {
        return address(input.address) ? deps.registry.register(input) : hidden()
      },
      async heartbeat(id) {
        return address(id) ? deps.registry.heartbeat(id) : hidden()
      },
      async deregister(id) {
        return address(id) ? deps.registry.deregister(id) : hidden()
      },
    },
    audit: emptyAudit,
    audits: (deps.audits ?? [])
      .filter(v => node(v.node))
      .map(source => ({
        ...source,
        audit: {
          async read(input) {
            if (!node(source.node)) return hidden()
            const value = await source.audit.read(input)
            return node(source.node) ? value : hidden()
          },
          async chain(traceId) {
            if (!node(source.node)) return hidden()
            const value = await source.audit.chain(traceId)
            return node(source.node) ? value : hidden()
          },
        },
      })),
    nodeServers: (deps.nodeServers ?? []).filter(
      v => node(v.node) && server(v.server),
    ),
    wakeTargets: (deps.wakeTargets ?? [])
      .filter(v => node(v.node))
      .map(v => ({
        ...v,
        ...(v.wake === undefined
          ? {}
          : {
              wake: {
                async send(input) {
                  return node(v.node) &&
                    address(input.to) &&
                    input.node === v.node
                    ? v.wake!.send({
                        ...input,
                        beforeDispatch: () => {
                          if (
                            !node(v.node) ||
                            !address(input.to) ||
                            input.node !== v.node
                          )
                            throw new Error('E_AUTH_REVOKED: 资源不存在')
                          input.beforeDispatch?.()
                        },
                      })
                    : hidden()
                },
              },
            }),
      })),
    ...(deps.lifecycle === undefined
      ? {}
      : {
          lifecycle: {
            async read() {
              const value = await deps.lifecycle!.read()
              return {
                ...value,
                registrations: value.registrations.filter(v =>
                  address(v.address),
                ),
                managed: value.managed?.filter(address) ?? [],
              }
            },
            async publish(input, by) {
              return address(input.address)
                ? deps.lifecycle!.publish(input, by)
                : hidden()
            },
            async pause(id, by) {
              return address(id) ? deps.lifecycle!.pause(id, by) : hidden()
            },
            async resume(id, by) {
              return address(id) ? deps.lifecycle!.resume(id, by) : hidden()
            },
            async retire(id, by) {
              return address(id) ? deps.lifecycle!.retire(id, by) : hidden()
            },
          },
        }),
    ...(deps.serverNotes === undefined
      ? {}
      : {
          serverNotes: {
            async list() {
              return filtered(await deps.serverNotes!.list(), v =>
                server(v.server),
              )
            },
            async set(id, note) {
              return server(id) ? deps.serverNotes!.set(id, note) : hidden()
            },
          },
        }),
    ...(deps.certificates === undefined
      ? {}
      : {
          certificates: {
            roots: () => [],
            async read() {
              const r = await deps.certificates!.read()
              return r.ok
                ? {
                    ok: true,
                    value: {
                      ...r.value,
                      certificates: r.value.certificates.filter(v =>
                        node(v.node),
                      ),
                      revocationList: null,
                    },
                  }
                : r
            },
          },
        }),
    ...(deps.scheduler === undefined
      ? {}
      : {
          scheduler: {
            async read() {
              const r = await deps.scheduler!.read()
              return r.ok
                ? {
                    ok: true,
                    value: {
                      ...r.value,
                      tick: {
                        state: 'unwired',
                        reason: '全局调度器心跳仅平台管理可见',
                      },
                      estop: {
                        state: 'unknown',
                        reason: '全局急停状态仅平台管理可见',
                      },
                      jobs: r.value.jobs.filter(
                        v =>
                          current() &&
                          scope.job(v.id) &&
                          v.target !== undefined &&
                          address(v.target),
                      ),
                      definitions: {
                        state: 'unwired',
                        reason: '调度器文件位置仅平台管理可见',
                      },
                    },
                  }
                : r
            },
          },
        }),
    ...(deps.notify === undefined
      ? {}
      : {
          notify: {
            async notices(limit) {
              const r = await deps.notify!.notices(limit)
              if (!r.ok) return r
              const notices = r.value.notices.filter(
                v => v.node !== undefined && node(v.node),
              )
              return {
                ok: true,
                value: { ...r.value, notices, total: notices.length },
              }
            },
            // ACK metadata can contain another subject; route validates ids against scoped alerts.
            async acks() {
              const [acks, feed] = await Promise.all([
                deps.notify!.acks(),
                deps.notify!.notices(10000),
              ])
              if (!acks.ok) return acks
              const ids = new Set(
                feed.ok
                  ? feed.value.notices
                      .filter(v => v.node !== undefined && node(v.node))
                      .map(v => v.id)
                  : [],
              )
              return filtered(
                acks,
                v =>
                  ids.has(v.id) ||
                  (/^(node-lost|cert|audit-broken|audit-absent|witness-tampered):/.test(
                    v.id,
                  ) &&
                    node(v.id.split(':')[1] ?? '')),
              )
            },
            async ack(id, by) {
              return deps.notify!.ack(id, by)
            },
          },
        }),
    ...(deps.actions === undefined
      ? {}
      : {
          actions: {
            ...(deps.actions.admit === undefined
              ? {}
              : { admit: () => deps.actions!.admit!() }),
            record: entry => deps.actions!.record(entry),
            async list(query) {
              const r = await deps.actions!.list(query)
              return r.ok
                ? {
                    ok: true,
                    value: {
                      ...r.value,
                      entries: r.value.entries.filter(
                        v => current() && scope.subject(v.subject),
                      ),
                      nextBeforeSeq: null,
                    },
                  }
                : r
            },
          },
        }),
    ...(deps.approvals === undefined
      ? {}
      : {
          approvals: {
            ...(deps.approvals.continue === undefined
              ? {}
              : {
                  async continue(principal, input) {
                    const r = await deps.approvals!.list(principal)
                    return r.ok &&
                      r.value.some(
                        v => v.requestId === input.requestId && node(v.node),
                      )
                      ? deps.approvals!.continue!(principal, input)
                      : hidden()
                  },
                }),
            async list(principal) {
              return filtered(await deps.approvals!.list(principal), v =>
                node(v.node),
              )
            },
            async decide(principal, input) {
              const r = await deps.approvals!.list(principal)
              return r.ok &&
                r.value.some(
                  v => v.requestId === input.requestId && node(v.node),
                )
                ? deps.approvals!.decide(principal, input)
                : hidden()
            },
            async revoke(principal, id) {
              const r = await deps.approvals!.list(principal)
              return r.ok &&
                r.value.some(v => v.requestId === id && node(v.node))
                ? deps.approvals!.revoke(principal, id)
                : hidden()
            },
          },
        }),
    ...(deps.usage === undefined
      ? {}
      : {
          usage: {
            ...deps.usage,
            reserve: (usageScope, input) =>
              deps.usage!.reserve(
                {
                  ...usageScope,
                  ...(scope.tenant === null ? {} : { tenant: scope.tenant }),
                },
                input,
              ),
            finish: (...args) => deps.usage!.finish(...args),
            closeSession: (usageScope, sessionId) =>
              deps.usage!.closeSession(
                {
                  ...usageScope,
                  ...(scope.tenant === null ? {} : { tenant: scope.tenant }),
                },
                sessionId,
              ),
            record: (...args) => deps.usage!.record(...args),
            adoptSession: (...args) => deps.usage!.adoptSession(...args),
            recordTask: (...args) => deps.usage!.recordTask(...args),
            finishTask: (...args) => deps.usage!.finishTask(...args),
            bindTask: (...args) => deps.usage!.bindTask(...args),
            async read(subject) {
              const r = await deps.usage!.read(subject)
              return {
                ...r,
                rows: r.rows.filter(
                  v =>
                    current() &&
                    (scope.subject(v.bucket.replace(/^person:/, '')) ||
                      (v.bucket.startsWith('job:') &&
                        scope.job(v.bucket.slice(4))) ||
                      (scope.tenant !== null &&
                        v.bucket === `tenant:${scope.tenant}`)),
                ),
              }
            },
          },
        }),
  }
  if (deps.chat !== undefined) {
    const chat = deps.chat
    const visible = async (id: string) => {
      const sessions = await chat.sessions()
      return (
        sessions.ok &&
        sessions.value.some(
          v => v.id === id && node(v.node) && address(v.target),
        )
      )
    }
    const scoped: ChatPort = {
      async targets() {
        return filtered(
          await chat.targets(),
          v => node(v.node) && address(v.address),
        )
      },
      async sessions() {
        return filtered(
          await chat.sessions(),
          v => node(v.node) && address(v.target),
        )
      },
      async open(target) {
        return address(target) ? chat.open(target) : hidden()
      },
      async transcript(id) {
        return (await visible(id)) ? chat.transcript(id) : hidden()
      },
      async send(input) {
        return (await visible(input.sessionId)) ? chat.send(input) : hidden()
      },
      subscribe(listener) {
        return chat.subscribe(update => {
          void visible(update.sessionId)
            .then(ok => {
              if (ok && current()) listener(update)
            })
            .catch(() => {})
        })
      },
    }
    return { deps: { ...result, chat: scoped }, scope }
  }
  return { deps: result, scope }
}

/** Existence-independent guard ahead of route admission and any outbound effect. */
export async function tenantRequestDenial(
  request: Request,
  url: URL,
  deps: ConsoleDeps,
  scope: TenantScope | undefined,
): Promise<Response | null> {
  if (scope === undefined || scope.platform) return null
  const pieces = url.pathname
    .split('/')
    .filter(Boolean)
    .map(v => {
      try {
        return decodeURIComponent(v)
      } catch {
        return ''
      }
    })
  const head =
    pieces[0] === 'v0' || pieces[0] === 'fragments' ? pieces[1] : pieces[0]
  if (
    [
      'accounts',
      'access',
      'actions',
      'providers',
      'settings',
      'handoff',
    ].includes(head ?? '')
  )
    return fail(403, 'forbidden', '此功能需要平台管理身份')
  if (
    head === 'servers' &&
    pieces[0] === 'v0' &&
    pieces[2] !== undefined &&
    !scope.server(pieces[2])
  )
    return fail(404, 'not_found', '资源不存在')
  if (
    (head === 'agents' || head === 'registrations') &&
    pieces[2] !== undefined &&
    !scope.address(pieces[2])
  )
    return fail(404, 'not_found', '资源不存在')
  if (head === 'chat') {
    const id =
      pieces[0] === 'v0' && pieces[2] === 'sessions'
        ? pieces[3]
        : pieces[0] === 'fragments' && pieces[2] === 'thread'
          ? pieces[3]
          : (url.searchParams.get('session') ?? undefined)
    if (id !== undefined) {
      const sessions = await deps.chat?.sessions()
      if (!sessions?.ok || !sessions.value.some(v => v.id === id))
        return fail(404, 'not_found', '资源不存在')
    }
  }
  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    ['agents', 'registrations', 'wake', 'chat'].includes(head ?? '')
  ) {
    let body: unknown
    try {
      body = await request.clone().json()
    } catch {
      return null
    }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const row = body as Record<string, unknown>
      for (const key of ['address', 'target', 'to'])
        if (typeof row[key] === 'string' && !scope.address(row[key]))
          return fail(404, 'not_found', '资源不存在')
      if (typeof row['node'] === 'string' && !scope.node(row['node']))
        return fail(404, 'not_found', '资源不存在')
    }
  }
  return null
}
