// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { streamScopeOf } from '../accountsHttp.js'
import { methodNotAllowed } from '../respond.js'
import { guard, readAuditSources } from './shared.js'
import type { RouteContext } from './types.js'

/** Sends only scope-derived revisions, never records or message contents. */
export function consoleEvents(ctx: RouteContext): Response {
  const denied = guard(ctx.access.credential, 'view', 'stream')
  if (denied) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const scope = streamScopeOf(ctx.access, ctx.accounts)
  const tenancy = ctx.deps.tenancy
  const revisionAtOpen = tenancy?.read().revision
  const alive = () => {
    try {
      return (
        (!scope || scope.alive()) && tenancy?.read().revision === revisionAtOpen
      )
    } catch {
      return false
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let detachAccount: (() => void) | undefined
  let detachTenant: (() => void) | undefined
  let closed = false
  let busy = false
  const previous = new Map<string, string>()
  const release = () => {
    closed = true
    clearInterval(timer)
    detachAccount?.()
    detachTenant?.()
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const end = () => {
          release()
          try {
            controller.close()
          } catch {}
        }
        const push = (value: string) => {
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(value))
            } catch {
              release()
            }
          }
        }
        const revision = (kind: string, value: unknown) => {
          const hash = new Bun.CryptoHasher('sha256')
            .update(JSON.stringify(value))
            .digest('hex')
          if (previous.get(kind) === hash) return
          previous.set(kind, hash)
          push(
            `event: revision\ndata: ${JSON.stringify({ kind, revision: hash })}\n\n`,
          )
        }
        const tick = async () => {
          if (closed || busy) return
          if (!alive()) {
            end()
            return
          }
          busy = true
          try {
            // Read the scoped port directly; ctx.roster caches only one request.
            const [roster, trails] = await Promise.all([
              ctx.deps.registry.list(),
              readAuditSources(ctx.deps, { limit: 1 }),
            ])
            if (closed || !alive()) {
              end()
              return
            }
            revision('roster', roster)
            revision(
              'audit',
              trails.map(trail => ({
                node: trail.node,
                page: trail.page,
                failure: trail.failure,
              })),
            )
            push(': keep-alive\n\n')
          } catch {
            end()
          } finally {
            busy = false
          }
        }
        push('retry: 5000\n: open\n\n')
        detachAccount = scope?.attach(end)
        if (closed) {
          detachAccount?.()
          return
        }
        detachTenant = ctx.deps.tenancy?.subscribe(end)
        if (closed || !alive()) {
          end()
          detachTenant?.()
          return
        }
        timer = setInterval(() => {
          void tick()
        }, 5000)
        timer.unref?.()
        void tick()
      },
      cancel() {
        release()
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    },
  )
}
