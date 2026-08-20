// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The minimal network surface for an append-only witness store.
 *
 * This deliberately copies `@qianmo/backup`'s three layers: an HTTP method
 * allowlist, an import-time destructive-vocabulary check over the declared
 * surface, and `wx` storage that rejects an existing `(node, seq)` instead of
 * overwriting it. The second location is the scheme's load-bearing boundary.
 */

import { timingSafeEqual } from 'node:crypto'
import { isValidSegment } from '@qianmo/protocol'
import type { WitnessAnchor, WitnessEvidence } from './anchor.js'
import { isWitnessAnchor, isWitnessAnchorReceipt } from './anchor.js'
import type { WitnessAnchorWriter } from './sender.js'
import { FileWitnessAnchorStore, WitnessAnchorExistsError } from './store.js'

export enum WitnessOp {
  CreateAnchor = 'createAnchor',
  ListAnchors = 'listAnchors',
}

export type WitnessAudience = 'writer' | 'reader'

export interface WitnessRoute {
  readonly method: 'POST' | 'GET'
  readonly path: string
  readonly audience: WitnessAudience
  readonly rationale: string
}

/** Same destructive vocabulary as the backup service. */
export const DESTRUCTIVE_WORDS: readonly string[] = Object.freeze([
  'delete',
  'remove',
  'destroy',
  'purge',
  'prune',
  'expire',
  'rotate',
  'overwrite',
  'replace',
  'truncate',
  'wipe',
])

/** The two verbs that cannot themselves remove an existing anchor. */
export const ALLOWED_METHODS: readonly string[] = Object.freeze(['GET', 'POST'])

/** The complete endpoint surface. Adding a route is a security change. */
export const WITNESS_SURFACE: ReadonlyMap<WitnessOp, WitnessRoute> = new Map<
  WitnessOp,
  WitnessRoute
>([
  [
    WitnessOp.CreateAnchor,
    {
      method: 'POST',
      path: '/v0/anchor',
      audience: 'writer',
      rationale:
        'creates exactly one new (node, seq) statement and cannot replace an existing one',
    },
  ],
  [
    WitnessOp.ListAnchors,
    {
      method: 'GET',
      path: '/v0/anchor?node=',
      audience: 'reader',
      rationale: 'read-only verification input',
    },
  ],
])

/** Refuse to load a surface with a destructive operation or widened writer. */
export function assertWitnessSurfaceIsSafe(
  surface: ReadonlyMap<string, WitnessRoute>,
): void {
  let writerRoutes = 0
  for (const [op, route] of surface) {
    const haystack = `${op} ${route.path}`.toLowerCase()
    for (const word of DESTRUCTIVE_WORDS) {
      if (haystack.includes(word)) {
        throw new Error(
          `witness surface is unsafe: "${op}" (${route.path}) contains destructive word "${word}"`,
        )
      }
    }
    if (!ALLOWED_METHODS.includes(route.method)) {
      throw new Error(
        `witness surface is unsafe: "${op}" uses method "${route.method}"; allowed: ${ALLOWED_METHODS.join(', ')}`,
      )
    }
    if (route.audience === 'writer') {
      writerRoutes += 1
      if (route.method !== 'POST' || route.path !== '/v0/anchor') {
        throw new Error(
          `witness surface is unsafe: the writer audience may only reach POST /v0/anchor, not ${route.method} ${route.path}`,
        )
      }
    }
  }
  if (writerRoutes !== 1) {
    throw new Error(
      `witness surface is unsafe: the writer audience must have exactly one route, found ${writerRoutes}`,
    )
  }
}

assertWitnessSurfaceIsSafe(WITNESS_SURFACE)

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/**
 * Keep the node-signed wire statement field-closed at the trust boundary.
 *
 * `isWitnessAnchor` intentionally accepts a JSON object with additive fields
 * for reader compatibility. The endpoint must not persist those additions:
 * in particular a sender must not smuggle a lookalike `receivedAt` beside its
 * signed `at` field.
 */
function acceptedAnchor(anchor: WitnessAnchor): WitnessAnchor {
  return {
    v: anchor.v,
    node: anchor.node,
    seq: anchor.seq,
    head: anchor.head,
    count: anchor.count,
    at: anchor.at,
    signature: anchor.signature,
  }
}

export interface WitnessServiceOptions {
  readonly store: FileWitnessAnchorStore
  /** Held by nodes. It can add an anchor but cannot inspect or remove history. */
  readonly writeToken: string
  /** Held by the verifier host. It can inspect anchors but cannot add one. */
  readonly readToken: string
  readonly port?: number
  readonly hostname?: string
  readonly unix?: string
  /** Host clock injected only for deterministic receipt tests. */
  readonly now?: () => number
}

export interface WitnessServiceHandle {
  readonly url?: string
  readonly port?: number
  readonly unix?: string
  stop(): Promise<void>
}

const MIN_TOKEN_LENGTH = 16

/** Start the host-side witness endpoint. */
export function startWitnessService(
  options: WitnessServiceOptions,
): WitnessServiceHandle {
  if (
    options.writeToken.length < MIN_TOKEN_LENGTH ||
    options.readToken.length < MIN_TOKEN_LENGTH
  ) {
    throw new Error(
      `witness tokens must be at least ${MIN_TOKEN_LENGTH} characters`,
    )
  }
  if (options.writeToken === options.readToken) {
    throw new Error('the witness write and read tokens must differ')
  }

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    const path = url.pathname
    if (!ALLOWED_METHODS.includes(method)) {
      return json({ error: 'mutation_denied' }, 405)
    }

    const token = bearerOf(request)
    const isWriter = tokenMatches(token, options.writeToken)
    const isReader = tokenMatches(token, options.readToken)
    if (!isWriter && !isReader) return json({ error: 'access_denied' }, 401)

    if (method === 'POST' && path === '/v0/anchor') {
      if (!isWriter) return json({ error: 'access_denied' }, 403)
      let anchor: unknown
      try {
        anchor = await request.json()
      } catch {
        return json({ error: 'invalid_anchor' }, 400)
      }
      if (!isWitnessAnchor(anchor))
        return json({ error: 'invalid_anchor' }, 400)
      const receipt = {
        anchor: acceptedAnchor(anchor),
        receivedAt: (options.now ?? Date.now)(),
      }
      if (!isWitnessAnchorReceipt(receipt)) {
        return json({ error: 'invalid_witness_clock' }, 500)
      }
      try {
        await options.store.create(receipt)
        return json(receipt, 201)
      } catch (error) {
        if (error instanceof WitnessAnchorExistsError) {
          return json({ error: 'anchor_exists' }, 409)
        }
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400,
        )
      }
    }

    if (method === 'GET' && path === '/v0/anchor') {
      if (!isReader) return json({ error: 'access_denied' }, 403)
      const node = url.searchParams.get('node') ?? ''
      if (!isValidSegment(node)) return json({ error: 'invalid_node' }, 400)
      return json(await options.store.list(node), 200)
    }

    return json({ error: 'no_such_route' }, 404)
  }

  const server = Bun.serve({
    ...(options.unix === undefined
      ? {
          port: options.port ?? 0,
          hostname: options.hostname ?? '127.0.0.1',
        }
      : { unix: options.unix }),
    fetch: handle,
  })
  return {
    ...(options.unix === undefined
      ? { url: `http://${server.hostname}:${server.port}`, port: server.port }
      : { unix: options.unix }),
    stop: async (): Promise<void> => {
      await server.stop(true)
    },
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Operational I/O bound for every remote witness request.
 *
 * This is not a protocol budget: it bounds a best-effort second location so a
 * half-open endpoint cannot stall admission, audit verification, or the
 * console forever. Ten seconds leaves room for an off-host TLS round trip
 * without turning an unavailable witness into a long interactive hang.
 */
export const DEFAULT_WITNESS_REMOTE_TIMEOUT_MS = 10_000

/** The diagnostic failure returned when a remote witness phase exceeds its bound. */
export class WitnessRemoteTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`witness remote request timed out after ${timeoutMs} ms`)
    this.name = 'WitnessRemoteTimeoutError'
  }
}

function assertRemoteTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('witness remote timeout must be a positive integer')
  }
}

/**
 * Bound every phase of one remote operation, even for a test/custom fetch
 * implementation that ignores AbortSignal. The detached catch observes a
 * late rejection after the race has already timed out.
 */
async function withinWitnessRemoteTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertRemoteTimeout(timeoutMs)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = Promise.resolve().then(() => operation(controller.signal))
  void work.catch(() => {})
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new WitnessRemoteTimeoutError(timeoutMs))
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface RemoteWitnessAnchorWriterOptions {
  readonly url?: string
  readonly unix?: string
  readonly token: string
  readonly fetchImpl?: typeof fetch
  /** Defaults to {@link DEFAULT_WITNESS_REMOTE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** The node-side writer has one method and one destination path. */
export function remoteWitnessAnchorWriter(
  options: RemoteWitnessAnchorWriterOptions,
): WitnessAnchorWriter {
  const base = options.url ?? 'http://localhost'
  const call = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_WITNESS_REMOTE_TIMEOUT_MS
  return {
    async append(anchor: WitnessAnchor): Promise<void> {
      await withinWitnessRemoteTimeout(timeoutMs, async signal => {
        const response = await call(new URL('/v0/anchor', base), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(anchor),
          signal,
          ...(options.unix === undefined ? {} : { unix: options.unix }),
        } as RequestInit)
        if (!response.ok) {
          throw new Error(
            `witness service refused the anchor: ${response.status}`,
          )
        }
      })
    },
  }
}

export interface RemoteWitnessAnchorReaderOptions {
  readonly url?: string
  readonly unix?: string
  readonly token: string
  readonly fetchImpl?: typeof fetch
  /** Defaults to {@link DEFAULT_WITNESS_REMOTE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** Read anchors for a verifier without granting it an append operation. */
export function remoteWitnessAnchorReader(
  options: RemoteWitnessAnchorReaderOptions,
): { list(node: string): Promise<readonly WitnessEvidence[]> } {
  const base = options.url ?? 'http://localhost'
  const call = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_WITNESS_REMOTE_TIMEOUT_MS
  return {
    async list(node: string): Promise<readonly WitnessEvidence[]> {
      return await withinWitnessRemoteTimeout(timeoutMs, async signal => {
        const url = new URL('/v0/anchor', base)
        url.searchParams.set('node', node)
        const response = await call(url, {
          headers: { authorization: `Bearer ${options.token}` },
          signal,
          ...(options.unix === undefined ? {} : { unix: options.unix }),
        } as RequestInit)
        if (!response.ok) {
          throw new Error(
            `witness service refused the anchor read: ${response.status}`,
          )
        }
        const parsed: unknown = await response.json()
        if (!Array.isArray(parsed) || !parsed.every(isWitnessAnchorReceipt)) {
          throw new Error('witness service returned invalid anchor receipts')
        }
        return parsed
      })
    },
  }
}
