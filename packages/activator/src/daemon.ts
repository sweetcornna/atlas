// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The sandbox daemon port, and the one HTTP implementation of it.
 *
 * Both faces of P2.5 — the activator and the keepalive — talk to the sandbox
 * supervisor (Dormice) through this port and through nothing else. That is not
 * tidiness: it is what makes "this component cannot destroy a sandbox" a
 * property of three small files rather than a claim about the whole codebase.
 *
 * The port is an interface because the daemon is an **external system, not the
 * unit under test**. Substituting a local stand-in for it lets every line of
 * our own scheduling, backoff, allowlist and recovery logic run for real
 * against a real socket. It does **not** make any statement about how the real
 * daemon behaves — no test in this package can, and none claims to.
 *
 * Credentials are injected as a getter and read from the environment at most.
 * Nothing key-shaped is ever written down here.
 */

import type { AuditLog } from './audit.js'
import { DaemonOp, resolveRoute } from './capability.js'
import { type Clock, systemClock } from './clock.js'

/** Lifecycle states this component distinguishes. */
export type SandboxState =
  /** Executing; the idle timer is what it has to fear. */
  | 'running'
  /** Paused. Memory intact, clocks still advancing (E4). Wakes via `acquire`. */
  | 'frozen'
  /** Shut down. A wake means a cold start, not a thaw. */
  | 'stopped'
  /** The daemon said something this version does not recognize. */
  | 'unknown'

/** A sandbox's lifecycle state as of one observation. */
export interface SandboxStatus {
  readonly sandboxId: string
  readonly state: SandboxState
}

/**
 * What this component can ask of the sandbox supervisor.
 *
 * Three members. There is no destructive member and there must never be one:
 * the daemon bearer has no privilege tiers, so the surface declared here *is*
 * the privilege boundary AC-6(c) rests on (see `capability.ts`).
 */
export interface SandboxDaemon {
  /** Move the idle deadline forward. The heartbeat's whole job. */
  touch(sandboxId: string): Promise<void>
  /** Bring a frozen or stopped sandbox back to running. */
  acquire(sandboxId: string): Promise<SandboxStatus>
  /** Read lifecycle state. */
  status(sandboxId: string): Promise<SandboxStatus>
}

/** The daemon answered, but not with success. */
export class DaemonRequestError extends Error {
  readonly op: string
  readonly httpStatus: number

  constructor(op: string, httpStatus: number, message: string) {
    super(`daemon ${op} failed with status ${httpStatus}: ${message}`)
    this.name = 'DaemonRequestError'
    this.op = op
    this.httpStatus = httpStatus
  }
}

/** Environment variable the bearer token is read from. Never a literal. */
export const DAEMON_TOKEN_ENV_VAR = 'QIANMO_SANDBOX_DAEMON_TOKEN'

/** Reads {@link DAEMON_TOKEN_ENV_VAR}, or throws if it is unset or blank. */
export function tokenFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[DAEMON_TOKEN_ENV_VAR]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${DAEMON_TOKEN_ENV_VAR} is unset; the daemon token is injected, never stored in the repository`,
    )
  }
  return value
}

/** Hosts that are on the machine and only on the machine. */
const LOOPBACK_HOSTS: readonly string[] = [
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]

/**
 * Refuse a daemon URL that is not on loopback.
 *
 * P0.7 measured what stands between a sandboxed agent and the full daemon API:
 * one thing, the daemon's loopback bind. Nothing in the firewall restricts
 * container-to-host traffic. If this component is ever pointed at a routable
 * address, it has published to the sandbox exactly the credential that AC-6(c)
 * depends on the sandbox never holding. So a non-loopback base URL is a
 * startup error, not a warning.
 */
export function assertLoopbackBaseUrl(baseUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`daemon base URL is not a URL: ${baseUrl}`)
  }
  const host = parsed.hostname.toLowerCase()
  const loopback =
    LOOPBACK_HOSTS.includes(host) ||
    // 127.0.0.0/8 in full, not just the one canonical address.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  if (!loopback) {
    throw new Error(
      `daemon base URL must stay on loopback, got host "${parsed.hostname}"; ` +
        'reaching the daemon from anywhere but the host machine breaks AC-6(c) (P0.7)',
    )
  }
  return parsed
}

/** Sandbox ids go into URL paths; keep them boring. */
export function assertSandboxId(sandboxId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sandboxId)) {
    throw new Error(`not a usable sandbox id: ${JSON.stringify(sandboxId)}`)
  }
  return sandboxId
}

/** The slice of `fetch` this file uses. Injected so tests can be offline. */
export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    signal: AbortSignal
  },
) => Promise<Response>

/** One daemon reply, already read. */
export interface DaemonResponse {
  readonly ok: boolean
  readonly status: number
  readonly body: unknown
}

/** Knobs of {@link HttpSandboxDaemon}. */
export interface HttpSandboxDaemonOptions {
  /** Must be on loopback — see {@link assertLoopbackBaseUrl}. */
  readonly baseUrl: string
  /** Called per request. A getter, so a rotated token is picked up. */
  readonly token: () => string
  readonly audit: AuditLog
  readonly fetch?: FetchLike
  readonly clock?: Clock
  /** Per-request ceiling. Short: a hung touch is a freeze in waiting. */
  readonly timeoutMs?: number
}

/** Default per-request timeout. */
export const DEFAULT_DAEMON_TIMEOUT_MS = 5_000

function parseState(body: unknown, sandboxId: string): SandboxStatus {
  const state =
    typeof body === 'object' && body !== null && 'state' in body
      ? (body as { state: unknown }).state
      : undefined
  if (state === 'running' || state === 'frozen' || state === 'stopped') {
    return { sandboxId, state }
  }
  return { sandboxId, state: 'unknown' }
}

/**
 * HTTP client for the sandbox daemon, restricted to the allowlist.
 *
 * `send` is public on purpose. Hiding the low-level door would be security by
 * obscurity, and DoD ③ asks for a *demonstrated* refusal of a destructive call,
 * which needs a door to knock on. The safety comes from the guard being on the
 * door: every request, from any caller, resolves through
 * {@link resolveRoute} first.
 */
export class HttpSandboxDaemon implements SandboxDaemon {
  readonly #base: URL
  readonly #token: () => string
  readonly #audit: AuditLog
  readonly #fetch: FetchLike
  readonly #clock: Clock
  readonly #timeoutMs: number

  constructor(options: HttpSandboxDaemonOptions) {
    this.#base = assertLoopbackBaseUrl(options.baseUrl)
    this.#token = options.token
    this.#audit = options.audit
    const injected = options.fetch
    this.#fetch =
      injected ??
      ((input, init) => fetch(input, init as unknown as RequestInit))
    this.#clock = options.clock ?? systemClock
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS
  }

  /** The daemon this client talks to, for logs and assertions. */
  get baseUrl(): string {
    return this.#base.toString()
  }

  /**
   * The single chokepoint to the daemon's HTTP surface.
   *
   * @param op Typed `string`, not `DaemonOp`: this is the layer that has to
   * hold when a caller has already cast past the enum.
   * @throws CapabilityDeniedError before any request is built, for any op
   * outside the allowlist — with an audit record written first.
   */
  async send(op: string, sandboxId: string): Promise<DaemonResponse> {
    assertSandboxId(sandboxId)
    const route = resolveRoute(op, sandboxId, this.#audit, this.#clock.now())
    // Keep any path prefix the base URL carries: `new URL('/v1/x', base)` would
    // discard it, silently addressing a different service on the same port.
    const prefix = this.#base.pathname.replace(/\/+$/, '')
    const url = new URL(`${prefix}${route.path}`, this.#base).toString()
    const response = await this.#fetch(url, {
      method: route.method,
      headers: {
        // Injected per call; never read from a file in this repository.
        authorization: `Bearer ${this.#token()}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // A body-less 204 is a perfectly good answer to `touch`.
      body = null
    }
    return { ok: response.ok, status: response.status, body }
  }

  async #expectOk(op: DaemonOp, sandboxId: string): Promise<DaemonResponse> {
    const response = await this.send(op, sandboxId)
    if (!response.ok) {
      throw new DaemonRequestError(
        op,
        response.status,
        JSON.stringify(response.body),
      )
    }
    return response
  }

  async touch(sandboxId: string): Promise<void> {
    await this.#expectOk(DaemonOp.Touch, sandboxId)
  }

  async acquire(sandboxId: string): Promise<SandboxStatus> {
    const response = await this.#expectOk(DaemonOp.Acquire, sandboxId)
    return parseState(response.body, sandboxId)
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    const response = await this.#expectOk(DaemonOp.Status, sandboxId)
    return parseState(response.body, sandboxId)
  }
}
