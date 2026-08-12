// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * DoD ③, part one: the capability surface itself.
 *
 * "The component's reachable capability surface contains no destructive
 * interface" is asserted here against the allowlist; part two
 * (`destroy-unreachable.test.ts`) asserts the same thing end to end against a
 * live server that *does* offer a destroy route.
 *
 * Every guard below also has its red direction pinned. A guard nobody has seen
 * fail is a guard nobody knows works — the same discipline P0.7's bind
 * invariant test uses on `check-daemon-bind.sh`.
 */

import { describe, expect, test } from 'bun:test'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import {
  ALLOWED_METHODS,
  CapabilityDeniedError,
  DAEMON_CAPABILITY_SURFACE,
  DESTRUCTIVE_WORDS,
  DaemonOp,
  assertSurfaceIsSafe,
  capabilitySurface,
  resolveRoute,
} from '../src/capability.js'

const SANDBOX = 'sandbox-1'

describe('the reachable surface is exactly three read/keep-alive verbs', () => {
  test('capabilitySurface() lists touch, acquire, status and nothing else', () => {
    expect([...capabilitySurface()].sort()).toEqual([
      'acquire',
      'status',
      'touch',
    ])
  })

  test('no route uses a mutating HTTP method beyond POST', () => {
    for (const [, route] of DAEMON_CAPABILITY_SURFACE) {
      expect(ALLOWED_METHODS).toContain(route.method)
    }
    expect(ALLOWED_METHODS).not.toContain('DELETE')
  })

  test('no op name or rendered path contains a destructive word', () => {
    for (const [op, route] of DAEMON_CAPABILITY_SURFACE) {
      const rendered = route.path('any-sandbox').toLowerCase()
      for (const word of DESTRUCTIVE_WORDS) {
        expect(op.toLowerCase()).not.toContain(word)
        expect(rendered).not.toContain(word)
      }
    }
  })

  test('sandbox ids are escaped into the path, not concatenated', () => {
    const route = DAEMON_CAPABILITY_SURFACE.get(DaemonOp.Touch)
    expect(route).toBeDefined()
    // A traversal attempt has to come back encoded, or a crafted id would let
    // the caller pick the route instead of the allowlist.
    expect(route?.path('../evil')).toBe('/v1/sandboxes/..%2Fevil/touch')
  })
})

describe('resolveRoute refuses everything outside the allowlist', () => {
  test.each([
    ['destroy', 'destructive-op'],
    ['destroySandbox', 'destructive-op'],
    ['deleteSandbox', 'destructive-op'],
    ['removeSandbox', 'destructive-op'],
    ['terminate', 'destructive-op'],
    ['kill', 'destructive-op'],
    ['purge', 'destructive-op'],
  ])('%s is denied, and the denial is audited', (op, reason) => {
    const audit = new AuditLog()
    expect(() => resolveRoute(op, SANDBOX, audit, 5_000)).toThrow(
      CapabilityDeniedError,
    )

    const events = audit.of(ActivatorEventType.CapabilityDenied)
    expect(events).toHaveLength(1)
    expect(events[0]?.detail).toEqual({ op, reason, sandboxId: SANDBOX })
    expect(events[0]?.at).toBe(5_000)
  })

  test('an op nobody recognises is denied too, classified as unknown', () => {
    const audit = new AuditLog()
    let thrown: unknown
    try {
      resolveRoute('exec', SANDBOX, audit, 1)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CapabilityDeniedError)
    expect((thrown as CapabilityDeniedError).reason).toBe('unknown-op')
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(1)
  })

  test('the error names the allowed surface, so the denial is diagnosable', () => {
    const audit = new AuditLog()
    expect(() => resolveRoute('destroy', SANDBOX, audit, 1)).toThrow(
      /touch, acquire, status/,
    )
  })

  test('the audit is written before the throw, so a catch cannot erase it', () => {
    const audit = new AuditLog()
    try {
      resolveRoute('destroy', SANDBOX, audit, 1)
    } catch {
      // Swallowed exactly as a careless caller would swallow it.
    }
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(1)
  })

  test('denials stay counted after the ring has evicted them', () => {
    // A flood of attempts must not be able to push the evidence out of the log.
    const audit = new AuditLog(2)
    for (let i = 0; i < 50; i += 1) {
      try {
        resolveRoute('destroy', SANDBOX, audit, i)
      } catch {
        // expected
      }
    }
    expect(audit.of(ActivatorEventType.CapabilityDenied)).toHaveLength(2)
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(50)
  })

  test.each([
    DaemonOp.Touch,
    DaemonOp.Acquire,
    DaemonOp.Status,
  ])('%s resolves and is not audited as a denial', op => {
    const audit = new AuditLog()
    const route = resolveRoute(op, SANDBOX, audit, 1)
    expect(ALLOWED_METHODS).toContain(route.method)
    expect(route.path).toContain(SANDBOX)
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(0)
  })
})

describe('assertSurfaceIsSafe refuses a widened surface at import time', () => {
  const path = (id: string) => `/v1/sandboxes/${id}`

  test('the shipped surface passes', () => {
    expect(() => assertSurfaceIsSafe(DAEMON_CAPABILITY_SURFACE)).not.toThrow()
  })

  // ↓↓↓ Red direction. Each of these is a plausible future commit.
  test('a DELETE route is refused', () => {
    const surface = new Map([['evict', { method: 'DELETE', path }]])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(/uses method "DELETE"/)
  })

  test('a PUT route is refused', () => {
    const surface = new Map([['replace', { method: 'PUT', path }]])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(/uses method "PUT"/)
  })

  test('an op named after a destructive action is refused', () => {
    const surface = new Map([['destroySandbox', { method: 'POST', path }]])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(
      /contains destructive word "destroy"/,
    )
  })

  test('an innocently named op routed at a destructive path is refused', () => {
    // The nastier case: the name looks fine and the URL does the damage.
    const surface = new Map([
      [
        'cleanup',
        { method: 'POST', path: (id: string) => `/v1/sandboxes/${id}/destroy` },
      ],
    ])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(/routes to .*destroy/)
  })

  test('importing capability.ts already ran the check on the real surface', () => {
    // If the module-level call were removed, this file would still pass its
    // other tests, so the fact of the call is asserted directly: a surface that
    // fails the check cannot be loaded, which is what makes the guard a
    // property of the build rather than of anyone's diligence.
    const source = Bun.file(
      new URL('../src/capability.ts', import.meta.url).pathname,
    )
    return source.text().then(text => {
      expect(text).toContain('assertSurfaceIsSafe(DAEMON_CAPABILITY_SURFACE)')
    })
  })
})
