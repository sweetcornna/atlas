// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * A real HTTP server on loopback that stands in for the sandbox daemon.
 *
 * **Read this before reading any assertion in this package.** The sandbox
 * supervisor is an *external system*, not the unit under test. Nothing here
 * reproduces its real behaviour and nothing in these tests is evidence about
 * it. What the stub buys is that everything on *our* side of the port — the
 * capability allowlist, the heartbeat schedule, the retry-sooner-on-failure
 * rule, the wake coalescing, the journal, the recovery pass — runs for real,
 * over a real socket, with real JSON and real HTTP status codes, instead of
 * being asserted against a hand-written double of our own code.
 *
 * It is deliberately *more* permissive than the thing it stands in for. In
 * particular it **implements a destroy route**, records hits on it, and will
 * happily serve one to any client that asks. That is the control for DoD ③:
 * a test can prove the route is live and reachable, and then prove that our
 * component cannot reach it. A stub without a destroy route would make the
 * "cannot destroy" assertion vacuous.
 */

import type { SandboxState } from '../src/daemon.js'

/** Requests the stub has served, by name. */
export interface StubHits {
  touch: number
  acquire: number
  status: number
  /** Must stay at zero for every request that went through our component. */
  destroy: number
  /** Requests rejected for a bad or missing bearer. */
  unauthorized: number
  /** Anything the stub does not route. */
  unknown: number
}

export interface StubDaemonOptions {
  /** Bearer the stub demands. Fake, fixed, and obviously not a real secret. */
  readonly token?: string
  /** Lifecycle state each sandbox starts in. */
  readonly initialState?: SandboxState
  /**
   * How many probes after an `acquire` still report not-ready.
   *
   * Models the shape E2 measured — unpause returns long before the working set
   * is warm — without claiming any particular duration.
   */
  readonly readyAfterProbes?: number
}

/** A running stub, plus the levers a test needs. */
export interface StubDaemon {
  readonly url: string
  readonly port: number
  readonly hits: StubHits
  /** Fail the next `n` touches with 503, then recover. */
  failTouches(n: number): void
  /** Current lifecycle state of a sandbox. */
  stateOf(sandboxId: string): SandboxState
  setState(sandboxId: string, state: SandboxState): void
  /** True once the sandbox has been acquired and its probe budget is spent. */
  isReady(sandboxId: string): boolean
  stop(): Promise<void>
}

/** Obviously fake, fixed, and long enough to look like a bearer. */
export const STUB_TOKEN = 'stub-daemon-token-not-a-real-secret'

/**
 * Start the stub on an OS-assigned loopback port.
 *
 * Port 0 so parallel work never collides, and `127.0.0.1` rather than a
 * wildcard bind so the stub is unreachable from anywhere but this machine —
 * the same invariant P0.7 puts on the real daemon.
 */
export function startStubDaemon(options: StubDaemonOptions = {}): StubDaemon {
  const token = options.token ?? STUB_TOKEN
  const initialState: SandboxState = options.initialState ?? 'frozen'
  const readyAfterProbes = options.readyAfterProbes ?? 0

  const hits: StubHits = {
    touch: 0,
    acquire: 0,
    status: 0,
    destroy: 0,
    unauthorized: 0,
    unknown: 0,
  }
  const states = new Map<string, SandboxState>()
  const probesLeft = new Map<string, number>()
  let touchFailures = 0

  const stateOf = (id: string): SandboxState => states.get(id) ?? initialState

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request: Request): Response {
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
        hits.unauthorized += 1
        return json({ error: 'unauthorized' }, 401)
      }
      const { pathname } = new URL(request.url)
      const segments = pathname.split('/').filter(segment => segment !== '')
      // /v1/sandboxes/<id>[/<verb>]
      if (
        segments[0] !== 'v1' ||
        segments[1] !== 'sandboxes' ||
        segments[2] === undefined
      ) {
        hits.unknown += 1
        return json({ error: `unknown path: ${pathname}` }, 404)
      }
      const id = decodeURIComponent(segments[2])
      const verb = segments[3]

      if (verb === 'touch' && request.method === 'POST') {
        hits.touch += 1
        if (touchFailures > 0) {
          touchFailures -= 1
          return json({ error: 'daemon busy' }, 503)
        }
        return json({ id, state: stateOf(id) })
      }

      if (verb === 'acquire' && request.method === 'POST') {
        hits.acquire += 1
        states.set(id, 'running')
        probesLeft.set(id, readyAfterProbes)
        return json({ id, state: 'running' })
      }

      if (verb === undefined && request.method === 'GET') {
        hits.status += 1
        return json({ id, state: stateOf(id) })
      }

      // The destructive route. Live, functional, and never reached through
      // @qianmo/activator — that is the point of it being here.
      if (verb === undefined && request.method === 'DELETE') {
        hits.destroy += 1
        states.set(id, 'stopped')
        return json({ id, state: 'stopped', destroyed: true })
      }

      hits.unknown += 1
      return json(
        { error: `unknown route: ${request.method} ${pathname}` },
        404,
      )
    },
  })

  return {
    // Bun types `port` as optional because unix-socket servers have none; this
    // one always binds TCP.
    port: server.port as number,
    url: `http://127.0.0.1:${server.port}`,
    hits,
    failTouches(n: number): void {
      touchFailures = n
    },
    stateOf,
    setState(id: string, state: SandboxState): void {
      states.set(id, state)
    },
    isReady(id: string): boolean {
      if (stateOf(id) !== 'running') return false
      const left = probesLeft.get(id) ?? 0
      if (left > 0) {
        probesLeft.set(id, left - 1)
        return false
      }
      return true
    },
    stop: async (): Promise<void> => {
      await server.stop(true)
    },
  }
}
