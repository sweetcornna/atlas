// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The capability surface — the one file that decides what this component is
 * physically able to ask the sandbox daemon to do.
 *
 * Why this is a code artifact and not a config knob
 * -------------------------------------------------
 * The Dormice daemon's credential has **no privilege tiers**: the bearer that
 * runs a command is the same bearer that destroys the sandbox (selection-m0.md
 * §4). AC-6(c) — "the agent cannot destroy its own sandbox" — therefore rests
 * on exactly two things: the daemon binding to loopback only (P0.7), and this
 * component never handing a destructive verb to that bearer. A configuration
 * flag would put AC-6(c) one typo away from being false. So the restriction is
 * spelled as an allowlist that is (a) frozen, (b) the sole path to the wire in
 * `daemon.ts`, and (c) self-checked at import time by
 * {@link assertSurfaceIsSafe}.
 *
 * Three layers, each of which alone would be defeated by a determined caller,
 * and which together are not:
 *
 * 1. **Type layer** — `SandboxDaemon` in `daemon.ts` declares `touch`,
 *    `acquire` and `status`. There is no destructive member to call, so
 *    reaching one requires deliberately casting away the type.
 * 2. **Runtime layer** — every request is resolved through {@link resolveRoute}
 *    against {@link DAEMON_CAPABILITY_SURFACE}. An op that is not in the map is
 *    refused before any request is built, and the refusal is audited. This is
 *    the layer that catches the cast from layer 1.
 * 3. **Shape layer** — {@link assertSurfaceIsSafe} runs on this module's own
 *    surface at import time, so a future edit that adds a destructive route to
 *    the allowlist cannot even be loaded. This is the layer that catches a
 *    careless commit rather than a careless call.
 *
 * The denylist below is **not** the mechanism. Security comes from the
 * allowlist; the denylist exists only so a refusal can say *why* in the audit
 * record, and so layer 3 has recognizable words to look for.
 */

import { ActivatorEventType, type AuditLog } from './audit.js'

/** Every operation this component is allowed to perform. There are three. */
export enum DaemonOp {
  /**
   * Reset the sandbox idle timer. The heartbeat's entire vocabulary.
   *
   * E3: the idle judgement is refreshed *only* by API entry points. A process
   * burning 100 % CPU inside the sandbox is invisible to it and gets frozen at
   * 110 s regardless, then makes zero progress for the next 411 s and never
   * self-recovers. That is why this op exists at all.
   */
  Touch = 'touch',
  /** Bring a frozen or stopped sandbox back to running. The wake verb. */
  Acquire = 'acquire',
  /** Read the sandbox's lifecycle state. Read-only. */
  Status = 'status',
}

/** The only HTTP methods a non-destructive surface needs. */
export const ALLOWED_METHODS: readonly string[] = Object.freeze(['GET', 'POST'])

/**
 * Words that mark an operation as destructive.
 *
 * Classification aid only — see the module header. Anything not on the
 * allowlist is refused whether or not it matches one of these.
 */
export const DESTRUCTIVE_WORDS: readonly string[] = Object.freeze([
  'destroy',
  'delete',
  'remove',
  'purge',
  'prune',
  'terminate',
  'kill',
  'wipe',
  'shutdown',
])

/** One entry of the allowlist. */
export interface DaemonRoute {
  readonly method: 'GET' | 'POST'
  /** Path relative to the daemon's base URL, sandbox id already substituted. */
  readonly path: (sandboxId: string) => string
  /** Why this op is safe to expose, in one line. */
  readonly rationale: string
}

/**
 * The allowlist. Adding a fourth entry is a security change and should be
 * reviewed as one; {@link assertSurfaceIsSafe} refuses the obvious mistakes.
 */
export const DAEMON_CAPABILITY_SURFACE: ReadonlyMap<DaemonOp, DaemonRoute> =
  new Map<DaemonOp, DaemonRoute>([
    [
      DaemonOp.Touch,
      {
        method: 'POST',
        path: id => `/v1/sandboxes/${encodeURIComponent(id)}/touch`,
        rationale: 'moves the idle deadline forward; cannot change lifecycle',
      },
    ],
    [
      DaemonOp.Acquire,
      {
        method: 'POST',
        path: id => `/v1/sandboxes/${encodeURIComponent(id)}/acquire`,
        rationale: 'transitions towards running only; never towards gone',
      },
    ],
    [
      DaemonOp.Status,
      {
        method: 'GET',
        path: id => `/v1/sandboxes/${encodeURIComponent(id)}`,
        rationale: 'read-only',
      },
    ],
  ])

/** Why a call was refused. */
export type DenialReason =
  /** The op names a destructive action. */
  | 'destructive-op'
  /** The op is simply not on the allowlist. */
  | 'unknown-op'

/**
 * Thrown instead of performing an out-of-surface call.
 *
 * Carries the audited reason so a caller that swallows the error still cannot
 * make the refusal look like a success.
 */
export class CapabilityDeniedError extends Error {
  readonly op: string
  readonly reason: DenialReason

  constructor(op: string, reason: DenialReason) {
    super(
      `capability denied: "${op}" is outside the activator's daemon surface (${reason}); ` +
        `allowed: ${[...DAEMON_CAPABILITY_SURFACE.keys()].join(', ')}`,
    )
    this.name = 'CapabilityDeniedError'
    this.op = op
    this.reason = reason
  }
}

function classify(op: string): DenialReason {
  const lowered = op.toLowerCase()
  return DESTRUCTIVE_WORDS.some(word => lowered.includes(word))
    ? 'destructive-op'
    : 'unknown-op'
}

/**
 * The single gate between this component and the daemon's HTTP surface.
 *
 * `op` is typed `string`, not `DaemonOp`, on purpose: the whole point is to be
 * the layer that still holds when someone has cast past the enum. Typing the
 * parameter narrowly would let the compiler argue the check is dead code.
 *
 * @throws CapabilityDeniedError for anything not on the allowlist, always after
 * recording {@link ActivatorEventType.CapabilityDenied}.
 */
export function resolveRoute(
  op: string,
  sandboxId: string,
  audit: AuditLog,
  now: number,
): { readonly method: string; readonly path: string } {
  const route = DAEMON_CAPABILITY_SURFACE.get(op as DaemonOp)
  if (route === undefined) {
    const reason = classify(op)
    // Audited before the throw, so no `catch` anywhere upstream can erase the
    // record of the attempt.
    audit.record(ActivatorEventType.CapabilityDenied, now, {
      op,
      reason,
      sandboxId,
    })
    throw new CapabilityDeniedError(op, reason)
  }
  return { method: route.method, path: route.path(sandboxId) }
}

/** The ops this component can perform, for anyone who wants to assert on it. */
export function capabilitySurface(): readonly string[] {
  return [...DAEMON_CAPABILITY_SURFACE.keys()]
}

/**
 * Refuse to load a surface that could destroy anything.
 *
 * Called on this module's own allowlist at the bottom of the file, so a commit
 * that widens the surface the wrong way fails at import — which means it fails
 * in every test, in typecheck's sibling `bun test`, and in CI, rather than
 * failing in production on the one call that matters.
 *
 * Takes the surface as a parameter so the negative direction is testable: a
 * check that can only ever be fed the good value is a check nobody has seen
 * go red.
 */
export function assertSurfaceIsSafe(
  surface: ReadonlyMap<
    string,
    { method: string; path: (id: string) => string }
  >,
): void {
  // A fixed probe id: rendering the path is the only way to see what a route
  // actually points at, since paths are built by a function.
  const probe = 'probe'
  for (const [op, route] of surface) {
    const lowered = op.toLowerCase()
    for (const word of DESTRUCTIVE_WORDS) {
      if (lowered.includes(word)) {
        throw new Error(
          `activator capability surface is unsafe: op "${op}" contains destructive word "${word}"`,
        )
      }
    }
    if (!ALLOWED_METHODS.includes(route.method)) {
      throw new Error(
        `activator capability surface is unsafe: op "${op}" uses method "${route.method}"; ` +
          `allowed: ${ALLOWED_METHODS.join(', ')}`,
      )
    }
    const rendered = route.path(probe).toLowerCase()
    for (const word of DESTRUCTIVE_WORDS) {
      if (rendered.includes(word)) {
        throw new Error(
          `activator capability surface is unsafe: op "${op}" routes to "${route.path(probe)}", ` +
            `which contains destructive word "${word}"`,
        )
      }
    }
  }
}

assertSurfaceIsSafe(DAEMON_CAPABILITY_SURFACE)
