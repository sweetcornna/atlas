// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.2 — the lifecycle routes (`routes/nodes.ts`): publish, pause, resume,
 * retire, and the ledger read.
 *
 * What this file answers: the four writes are open to `ops` and the admin
 * token and to nobody else; a refused caller reaches no port and leaves no
 * line in the action ledger; an admitted write leaves exactly one, under its
 * own verb, whatever the outcome; and the refusals the registration ledger
 * makes come back as the statuses the design names, with the rule recorded.
 *
 * The lifecycle port is hand-written and counts its calls — the real one lives
 * in the host (`packages/node/src/commands/consoleRegistrations.ts`, with its own
 * suite). The action ledger is the real hash-chained one over memory.
 */

import { describe, expect, test } from 'bun:test'
import { ActionLedger } from '../src/actionLedger.js'
import type {
  ActionRecord,
  LifecycleChange,
  LifecycleOutcome,
  LifecyclePort,
  LifecycleSnapshot,
  PublishInput,
  RegistrationRecord,
} from '../src/deps.js'
import {
  ADDRESS,
  ADMIN,
  VIEW,
  accountsHarness,
  asBearer,
  asSession,
  person,
  type AccountsHarness,
} from './accountsHarness.js'
import { MemoryActionStore } from './actionStore.js'

const ENC = encodeURIComponent(ADDRESS)

/** A lifecycle port that remembers every call and answers what it is told to. */
class CountingLifecycle implements LifecyclePort {
  readonly calls: string[] = []
  reads = 0
  /** The next write's answer; a plain success when unset. */
  next: LifecycleOutcome<LifecycleChange> | null = null
  snapshot: LifecycleSnapshot = {
    problem: null,
    managed: [ADDRESS],
    registrations: [
      {
        address: ADDRESS,
        state: 'paused',
        by: 'u:0123456789abcdef',
        at: 1,
        managed: true,
      },
    ],
  }

  #answer(
    state: RegistrationRecord['state'],
    address: string,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    const next = this.next
    this.next = null
    return Promise.resolve(
      next ?? {
        ok: true,
        value: { registration: { address, state, by, at: 2 } },
      },
    )
  }

  read(): Promise<LifecycleSnapshot> {
    this.reads += 1
    return Promise.resolve(this.snapshot)
  }
  publish(
    input: PublishInput,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    this.calls.push(
      `publish ${input.address} ${input.endpoint ?? '(managed)'} ${by}`,
    )
    return this.#answer('active', input.address, by)
  }
  pause(address: string, by: string) {
    this.calls.push(`pause ${address} ${by}`)
    return this.#answer('paused', address, by)
  }
  resume(address: string, by: string) {
    this.calls.push(`resume ${address} ${by}`)
    return this.#answer('active', address, by)
  }
  retire(address: string, by: string) {
    this.calls.push(`retire ${address} ${by}`)
    return this.#answer('retired', address, by)
  }
}

function scene() {
  const lifecycle = new CountingLifecycle()
  const store = new MemoryActionStore()
  const ledger = new ActionLedger({ store })
  const h = accountsHarness({ deps: { lifecycle, actions: ledger } })
  /** The lifecycle lines in the action ledger, oldest first. */
  const written = async (): Promise<readonly ActionRecord[]> => {
    const page = await ledger.list({ actionPrefix: 'agent.', limit: 500 })
    if (!page.ok) throw new Error('the action ledger did not answer')
    return [...page.value.entries].reverse()
  }
  return { h, lifecycle, written }
}

/** The four writes, as the page script would send them. */
const WRITES: readonly {
  readonly name: string
  readonly method: string
  readonly path: string
  readonly body?: unknown
  readonly verb: string
  readonly call: string
}[] = [
  {
    name: 'publish',
    method: 'POST',
    path: '/v0/agents',
    body: { address: ADDRESS },
    verb: 'agent.register',
    call: `publish ${ADDRESS} (managed)`,
  },
  {
    name: 'pause',
    method: 'POST',
    path: `/v0/agents/${ENC}/pause`,
    verb: 'agent.pause',
    call: `pause ${ADDRESS}`,
  },
  {
    name: 'resume',
    method: 'POST',
    path: `/v0/agents/${ENC}/resume`,
    verb: 'agent.resume',
    call: `resume ${ADDRESS}`,
  },
  {
    name: 'retire',
    method: 'POST',
    path: `/v0/agents/${ENC}/retire`,
    verb: 'agent.retire',
    call: `retire ${ADDRESS}`,
  },
]

type Caller =
  | { readonly kind: 'session'; readonly sid: string }
  | { readonly kind: 'bearer'; readonly token: string }

function send(caller: Caller, write: (typeof WRITES)[number]): Request {
  return caller.kind === 'session'
    ? asSession(write.method, write.path, caller.sid, {
        ...(write.body === undefined ? {} : { body: write.body }),
      })
    : asBearer(write.method, write.path, caller.token, write.body)
}

async function callers(h: AccountsHarness) {
  const [viewer, member, ops] = [
    await person(h.handle, 'viewer'),
    await person(h.handle, 'member'),
    await person(h.handle, 'ops'),
  ]
  return {
    viewer: { kind: 'session', sid: viewer.sid } as const,
    member: { kind: 'session', sid: member.sid } as const,
    ops: { kind: 'session', sid: ops.sid } as const,
    legacyView: { kind: 'bearer', token: VIEW } as const,
    legacyAdmin: { kind: 'bearer', token: ADMIN } as const,
  }
}

describe('who may write the lifecycle (DoD: viewer, member, ops, legacy tokens)', () => {
  for (const write of WRITES) {
    test(`${write.name}: viewer, member and the view token are refused with nothing called and nothing written`, async () => {
      const { h, lifecycle, written } = scene()
      const who = await callers(h)
      for (const caller of [who.viewer, who.member, who.legacyView]) {
        const response = await h.handle(send(caller, write))
        expect(response.status).toBe(403)
      }
      expect(lifecycle.calls).toEqual([])
      // A role refusal is not an action (`deps.ts`, `ActionOutcome`).
      expect(await written()).toEqual([])
    })

    test(`${write.name}: ops and the admin token go through, each leaving exactly one line under ${write.verb}`, async () => {
      const { h, lifecycle, written } = scene()
      const who = await callers(h)

      const asOps = await h.handle(send(who.ops, write))
      expect(asOps.status).toBe(200)
      expect(lifecycle.calls).toHaveLength(1)
      const opsSubject = lifecycle.calls[0]?.split(' ').at(-1) ?? ''
      expect(opsSubject).toMatch(/^u:[0-9a-f]{16}$/)
      expect(lifecycle.calls[0]).toBe(`${write.call} ${opsSubject}`)
      expect(await written()).toHaveLength(1)

      const asAdmin = await h.handle(send(who.legacyAdmin, write))
      expect(asAdmin.status).toBe(200)
      expect(lifecycle.calls[1]).toBe(`${write.call} legacy:admin`)

      const lines = await written()
      expect(lines).toHaveLength(2)
      expect(
        lines.map(line => [
          line.action,
          line.target,
          line.subject,
          line.outcome,
        ]),
      ).toEqual([
        [write.verb, ADDRESS, opsSubject, 'ok'],
        [write.verb, ADDRESS, 'legacy:admin', 'ok'],
      ])
      // The two lines are two requests.
      expect(lines[0]?.requestId).not.toBe(lines[1]?.requestId)
    })
  }
})

describe('what a refusal looks like, and what it leaves behind', () => {
  const CASES: readonly {
    readonly outcome: LifecycleOutcome<LifecycleChange>
    readonly status: number
    readonly body: string
    readonly line: readonly [string, string]
  }[] = [
    {
      outcome: {
        ok: false,
        refusal: { code: 'unavailable', message: '登记簿不可用' },
      },
      status: 503,
      body: 'unavailable',
      line: ['refused', 'unavailable'],
    },
    {
      outcome: {
        ok: false,
        refusal: { code: 'unmanaged', message: '不在托管清单里' },
      },
      status: 403,
      body: 'rejected',
      line: ['refused', 'unmanaged'],
    },
    {
      outcome: {
        ok: false,
        refusal: { code: 'retired', message: '已退役' },
      },
      status: 409,
      body: 'rejected',
      line: ['refused', 'retired'],
    },
    {
      outcome: {
        ok: false,
        refusal: { code: 'paused', message: '已暂停' },
      },
      status: 409,
      body: 'rejected',
      line: ['refused', 'paused'],
    },
    {
      outcome: {
        ok: false,
        refusal: { code: 'not_found', message: '没有这个地址' },
      },
      status: 404,
      body: 'not_found',
      line: ['refused', 'not_found'],
    },
    {
      outcome: {
        ok: false,
        failure: { code: 'unreachable', message: '注册中心不可达' },
      },
      status: 503,
      body: 'unreachable',
      line: ['failed', 'unreachable'],
    },
  ]

  for (const item of CASES) {
    const label =
      'refusal' in item.outcome
        ? item.outcome.refusal.code
        : item.outcome.ok
          ? 'ok'
          : `registry ${item.outcome.failure.code}`
    test(`${label}: ${item.status}, one ${item.line[0]} line with ${item.line[1]}`, async () => {
      const { h, lifecycle, written } = scene()
      lifecycle.next = item.outcome
      const response = await h.handle(
        asBearer('POST', `/v0/agents/${ENC}/resume`, ADMIN),
      )
      expect(response.status).toBe(item.status)
      const body = (await response.json()) as {
        error: { code: string; message: string }
      }
      expect(body.error.code).toBe(item.body)
      const lines = await written()
      expect(lines.map(line => [line.outcome, line.code])).toEqual([
        [...item.line],
      ])
    })
  }

  test('an unknown lifecycle verb is not a route', async () => {
    const { h, lifecycle, written } = scene()
    const response = await h.handle(
      asBearer('POST', `/v0/agents/${ENC}/unretire`, ADMIN),
    )
    expect(response.status).toBe(404)
    expect(lifecycle.calls).toEqual([])
    expect(await written()).toEqual([])
  })

  test('a GET on a lifecycle route is 405 and calls nothing', async () => {
    const { h, lifecycle } = scene()
    const response = await h.handle(
      asBearer('GET', `/v0/agents/${ENC}/pause`, ADMIN),
    )
    expect(response.status).toBe(405)
    expect(lifecycle.calls).toEqual([])
  })

  test('publish: an endpoint that is given is passed on; a malformed body is 400 before the port', async () => {
    const { h, lifecycle, written } = scene()
    const given = await h.handle(
      asBearer('POST', '/v0/agents', ADMIN, {
        address: ADDRESS,
        endpoint: 'ws://127.0.0.1:38611',
      }),
    )
    expect(given.status).toBe(200)
    expect(lifecycle.calls).toEqual([
      `publish ${ADDRESS} ws://127.0.0.1:38611 legacy:admin`,
    ])
    const bad = await h.handle(
      asBearer('POST', '/v0/agents', ADMIN, { address: 7 }),
    )
    expect(bad.status).toBe(400)
    expect(lifecycle.calls).toHaveLength(1)
    expect(await written()).toHaveLength(1)
  })
})

describe('GET /v0/registrations', () => {
  test('a reader sees every state but not who changed it; a writer sees who', async () => {
    const { h, lifecycle, written } = scene()
    const who = await callers(h)
    const asView = await h.handle(asBearer('GET', '/v0/registrations', VIEW))
    expect(asView.status).toBe(200)
    expect(await asView.json()).toEqual({
      problem: null,
      managed: [ADDRESS],
      registrations: [
        { address: ADDRESS, state: 'paused', at: 1, managed: true },
      ],
    })
    const asOps = await h.handle(
      asSession('GET', '/v0/registrations', who.ops.sid),
    )
    expect(await asOps.json()).toEqual(lifecycle.snapshot)
    // Reading records nothing.
    expect(await written()).toEqual([])
  })

  test('nobody: 401 before anything is read', async () => {
    const { h, lifecycle } = scene()
    const response = await h.handle(
      new Request('http://console.test/v0/registrations'),
    )
    expect(response.status).toBe(401)
    expect(lifecycle.reads).toBe(0)
  })
})

describe('a console without a lifecycle', () => {
  test('the lifecycle routes are 501 after the role check, and registering goes to the registry as before', async () => {
    const h = accountsHarness()
    const denied = await h.handle(
      asBearer('POST', `/v0/agents/${ENC}/pause`, VIEW),
    )
    expect(denied.status).toBe(403)
    const absent = await h.handle(
      asBearer('POST', `/v0/agents/${ENC}/pause`, ADMIN),
    )
    expect(absent.status).toBe(501)
    const read = await h.handle(asBearer('GET', '/v0/registrations', VIEW))
    expect(read.status).toBe(501)
    const registered = await h.handle(
      asBearer('POST', '/v0/agents', ADMIN, {
        address: ADDRESS,
        endpoint: 'ws://127.0.0.1:38611',
      }),
    )
    // The harness registry answers every write with `unsupported`.
    expect(registered.status).toBe(501)
    expect(h.registry.calls).toBe(1)
  })
})
