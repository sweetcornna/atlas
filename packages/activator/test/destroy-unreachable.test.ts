// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * DoD ③, part two: end to end against a server that really does offer destroy.
 *
 * The shape of the argument matters more than any single assertion:
 *
 *   1. **Control** — a plain `fetch`, holding the same bearer this component
 *      holds, destroys a sandbox through the stub. The route is live, the
 *      credential is sufficient, and nothing about the environment is stopping
 *      anybody. (This is the real daemon's situation: its credential has no
 *      privilege tiers, so *execute* and *destroy* are the same key.)
 *   2. **The attempt** — the same destructive call, made through this
 *      component, fails and is audited.
 *   3. **The counter** — the stub's destroy hit count proves the request never
 *      reached the wire, rather than merely that an exception was raised
 *      somewhere.
 *
 * Without step 1 the whole file would be vacuous; a route nobody implements is
 * unreachable for uninteresting reasons.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import { CapabilityDeniedError } from '../src/capability.js'
import { HttpSandboxDaemon, type SandboxDaemon } from '../src/daemon.js'
import { STUB_TOKEN, type StubDaemon, startStubDaemon } from './stub-daemon.js'

let stub: StubDaemon
let audit: AuditLog
let daemon: HttpSandboxDaemon

beforeAll(() => {
  stub = startStubDaemon({ initialState: 'frozen' })
  audit = new AuditLog()
  daemon = new HttpSandboxDaemon({
    baseUrl: stub.url,
    token: () => STUB_TOKEN,
    audit,
  })
})

afterAll(async () => {
  await stub.stop()
})

describe('control: the destroy route is live and the credential suffices', () => {
  test('a plain client destroys a sandbox through the same bearer', async () => {
    const before = stub.hits.destroy
    const response = await fetch(`${stub.url}/v1/sandboxes/control-victim`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${STUB_TOKEN}` },
    })
    expect(response.status).toBe(200)
    expect(stub.hits.destroy).toBe(before + 1)
    expect(stub.stateOf('control-victim')).toBe('stopped')
  })
})

describe('the component cannot reach a destructive verb', () => {
  test('the port type has no destructive member at all', () => {
    const port: SandboxDaemon = daemon
    expect(Object.keys(port)).not.toContain('destroy')
    expect('destroy' in port).toBe(false)
    expect('destroySandbox' in port).toBe(false)
    // Reaching for it the only way TypeScript leaves open — casting the type
    // away — finds nothing to call.
    const smuggled = port as unknown as {
      destroy?: (id: string) => Promise<void>
    }
    expect(smuggled.destroy).toBeUndefined()
  })

  test.each([
    'destroy',
    'destroySandbox',
    'deleteSandbox',
    'terminate',
    'kill',
  ])('send(%p) is refused before any request is built, and audited', async op => {
    const destroysBefore = stub.hits.destroy
    const deniedBefore = audit.count(ActivatorEventType.CapabilityDenied)

    // The low-level door is public on purpose: the guard is on the door, not
    // on knowing where the door is.
    const attempt = daemon.send(op, 'target-sandbox')
    await expect(attempt).rejects.toBeInstanceOf(CapabilityDeniedError)

    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(
      deniedBefore + 1,
    )
    const last = audit.of(ActivatorEventType.CapabilityDenied).at(-1)
    expect(last?.detail.op).toBe(op)
    expect(last?.detail.reason).toBe('destructive-op')
    expect(last?.detail.sandboxId).toBe('target-sandbox')

    // The load-bearing assertion: nothing went out.
    expect(stub.hits.destroy).toBe(destroysBefore)
  })

  test('a crafted sandbox id cannot smuggle a route past the allowlist', async () => {
    const destroysBefore = stub.hits.destroy
    const unknownBefore = stub.hits.unknown
    await expect(daemon.send('touch', '../victim')).rejects.toThrow(
      /not a usable sandbox id/,
    )
    await expect(daemon.send('touch', 'ok/../../victim')).rejects.toThrow(
      /not a usable sandbox id/,
    )
    expect(stub.hits.destroy).toBe(destroysBefore)
    expect(stub.hits.unknown).toBe(unknownBefore)
  })

  test('an HTTP method is not something a caller gets to choose', async () => {
    // `send` takes an op, never a method: there is no parameter to pass DELETE
    // through. Asking for one by name is just another unknown op.
    const destroysBefore = stub.hits.destroy
    await expect(
      daemon.send('DELETE', 'target-sandbox'),
    ).rejects.toBeInstanceOf(CapabilityDeniedError)
    expect(stub.hits.destroy).toBe(destroysBefore)
  })
})

describe('the allowed surface still works, over the real socket', () => {
  test('status, acquire and touch all reach the stub', async () => {
    const id = 'live-sandbox'
    expect((await daemon.status(id)).state).toBe('frozen')
    expect((await daemon.acquire(id)).state).toBe('running')
    await daemon.touch(id)

    expect(stub.hits.status).toBeGreaterThan(0)
    expect(stub.hits.acquire).toBeGreaterThan(0)
    expect(stub.hits.touch).toBeGreaterThan(0)
    expect(stub.hits.unauthorized).toBe(0)
  })

  test('the only destroy the stub ever served was the control one', () => {
    expect(stub.hits.destroy).toBe(1)
  })
})
