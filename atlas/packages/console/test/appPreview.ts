// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A hub the desktop app can pair with, for seeing `/app` inside the shell.
 *
 * Not a test: `bun atlas/packages/console/test/appPreview.ts [port]` serves
 * the console on loopback (default 38691) with personal accounts on, an ops
 * account signed up at start, the preview fleet of `./preview/chat.ts` (five
 * agents that answer) and an in-memory device port that does what the
 * client's door needs (clients.md §3): pairing codes, pairing as a client,
 * tickets and revocation. It prints the hub's address and a pairing code for
 * `qmo sign-in`; `POST /__preview/pairing` mints another, and
 * `/__preview/login?next=/app` signs a browser in as the same account.
 *
 * Nothing is written to disk and nothing outlives the process: a restart
 * forgets every device, so a `qmo` paired with the last run reports
 * `invalid` and signs in again.
 */

import { createHash, randomBytes } from 'node:crypto'
import { AccountBook } from '../src/accounts.js'
import { accountSessionCookie } from '../src/access.js'
import type { ConsoleTokens } from '../src/auth.js'
import type { ConsoleDeps, ConsoleFailure, ConsoleResult } from '../src/deps.js'
import type {
  DirectionActor,
  HandoffDeviceIdentity,
  HandoffDeviceKind,
  HandoffDeviceRefusal,
  HandoffDevicesPort,
  HandoffDeviceView,
  HandoffPairingCode,
  HandoffPairingResult,
} from '../src/directionPorts.js'
import { createConsoleHandler } from '../src/http.js'
import {
  BASE,
  cookieFrom,
  credentialOn,
  formPost,
  MemoryLedger,
} from './accountsHarness.js'
import { FakeUpdates, PREVIEW_PORTS } from './directionFakes.js'
import { MemoryActionLedger } from './memoryActions.js'
import { agentAt, LIMITS, PageAudit, PageRegistry } from './pageHarness.js'
import { FakeProviders } from './providersFake.js'
import { PreviewApprovals } from './preview/approvals.js'
import { PreviewChat, TARGETS, ownResidents } from './preview/chat.js'
import { PreviewTasks } from './preview/tasks.js'

/** Test values, valid only in this preview. Never a real console's tokens. */
const PREVIEW_TOKENS: ConsoleTokens = {
  view: 'app-preview-view-5c0e7b19d24a',
  admin: 'app-preview-admin-93f4a6e2b81d',
}

/** How long a pairing code waits, as on a real hub. */
const PAIRING_TTL_MS = 10 * 60_000
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

function refused<T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

const base32 = (length: number): string =>
  [...randomBytes(length)].map(byte => BASE32[byte & 31]).join('')
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

interface Device extends Omit<HandoffDeviceView, 'tasks'> {
  readonly hash: string
}

interface Pairing {
  readonly owner: string
  readonly console: string
  readonly expiresAt: number
}

/**
 * The device ledger of `qm console`, in memory: the same codes (twelve
 * base32 characters, ten minutes, one use), tokens and refusals, without the
 * file, the rate limit or the account-reset bookkeeping.
 */
class PreviewDevices implements HandoffDevicesPort {
  readonly #devices: Device[] = []
  readonly #pairings = new Map<string, Pairing>()

  constructor(private readonly now: () => number) {}

  #byToken(token: string): Device | undefined {
    const hash = digest(token)
    return this.#devices.find(device => device.hash === hash)
  }

  authenticate(token: string): HandoffDeviceIdentity | null {
    const device = this.#byToken(token)
    if (device === undefined || device.revokedAt !== null) return null
    return { deviceId: device.deviceId, owner: device.owner, kind: device.kind }
  }

  refusalOf(token: string): HandoffDeviceRefusal {
    const device = this.#byToken(token)
    return device !== undefined && device.revokedAt !== null
      ? 'device_revoked'
      : 'unauthorized'
  }

  async pair(input: {
    readonly code: string
    readonly name: string
    readonly platform: string | null
    readonly kind?: HandoffDeviceKind
  }): Promise<ConsoleResult<HandoffPairingResult>> {
    const key = digest(input.code.replaceAll('-', '').toUpperCase())
    const pairing = this.#pairings.get(key)
    if (pairing === undefined || pairing.expiresAt <= this.now())
      return refused('rejected', '配对码无效或已过期')
    this.#pairings.delete(key)
    const token = `qmd_${randomBytes(32).toString('base64url')}`
    const device: Device = {
      deviceId: `d-${base32(12).toLowerCase()}`,
      hash: digest(token),
      name: input.name.trim().slice(0, 64) || 'device',
      platform: input.platform,
      owner: pairing.owner,
      kind: input.kind ?? 'handoff',
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
    }
    this.#devices.push(device)
    return ok({
      deviceId: device.deviceId,
      owner: device.owner,
      kind: device.kind,
      name: device.name,
      token,
      console: pairing.console,
    })
  }

  async listDevices() {
    return ok<readonly HandoffDeviceView[]>(
      this.#devices.map(({ hash: _hash, ...device }) => ({
        ...device,
        tasks: 0,
      })),
    )
  }

  async issuePairing(actor: DirectionActor, consoleUrl?: string) {
    if (actor.role !== 'member' && actor.role !== 'ops')
      return refused<HandoffPairingCode>('rejected', '需要成员或运维账号')
    const hub = (consoleUrl ?? '').replace(/\/$/, '')
    const code = base32(12)
    this.#pairings.set(digest(code), {
      owner: actor.subject,
      console: hub,
      expiresAt: this.now() + PAIRING_TTL_MS,
    })
    return ok<HandoffPairingCode>({
      code: code.match(/.{4}/g)!.join('-'),
      expiresAt: this.now() + PAIRING_TTL_MS,
      command: `qmo sign-in ${hub}`,
    })
  }

  async revokeDevice(deviceId: string, _actor: DirectionActor) {
    const index = this.#devices.findIndex(one => one.deviceId === deviceId)
    if (index < 0)
      return refused<HandoffDeviceView>('not_found', '没有这台设备')
    const { hash, ...found } = this.#devices[index]!
    const revoked: Device = {
      ...found,
      hash,
      revokedAt: found.revokedAt ?? this.now(),
    }
    this.#devices[index] = revoked
    return ok<HandoffDeviceView>({
      ...found,
      revokedAt: revoked.revokedAt,
      tasks: 0,
    })
  }
}

const port = Number(process.argv[2] ?? 38691)
const hub = `http://127.0.0.1:${port}`
const now = (): number => Date.now()

const registry = new PageRegistry()
registry.listResult = ok(TARGETS.map(target => agentAt(target.address)))
const devices = new PreviewDevices(now)
const ports = Object.fromEntries(
  Object.entries(PREVIEW_PORTS).map(([name, make]) => [name, make(now)]),
) as Partial<ConsoleDeps>

const chat = new PreviewChat()
const deps: ConsoleDeps = {
  ...ports,
  registry,
  audit: new PageAudit(),
  limits: LIMITS,
  now,
  label: 'app-preview',
  identity: 'qianmo://hub/console',
  chat,
  chatDefault: 'qianmo://hub/ops',
  nodeServers: [
    { node: 'hub', server: 'p5' },
    { node: 'beta-5', server: 'p3' },
    { node: 'beta-1', server: 'p1' },
    { node: 'beta-4', server: 'p3' },
  ],
  actions: new MemoryActionLedger(),
  providers: new FakeProviders(),
  tasks: new PreviewTasks(now),
  updates: new FakeUpdates(now),
  approvals: new PreviewApprovals(Date.now()),
  handoffDevices: devices,
}

const book = new AccountBook({
  accounts: new MemoryLedger(),
  sessions: new MemoryLedger('memory://sessions.ndjson'),
  now,
})
const handle = createConsoleHandler(deps, PREVIEW_TOKENS, { book })

/** Invite an ops account with the management token and redeem it. */
async function signUpOwner(): Promise<{
  readonly sid: string
  readonly actor: DirectionActor
}> {
  const invited = await handle(
    new Request(`${BASE}/v0/accounts/invites`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PREVIEW_TOKENS.admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'ops', label: 'app-preview owner' }),
    }),
  )
  const { link } = (await invited.json()) as { link: string }
  const redeemed = await handle(
    formPost('/invite', { invite: link.slice(link.indexOf('#') + 1) }),
  )
  const credential = credentialOn(await redeemed.text())
  const sid = cookieFrom(redeemed, 'qianmo_session')
  const principal = book.bearerPrincipal(credential)
  if (sid === null || !principal.ok || principal.value.kind !== 'user')
    throw new Error('the preview could not sign its owner up')
  ownResidents(chat, book, credential)
  return {
    sid,
    actor: {
      subject: principal.value.subject,
      role: 'ops',
      requestId: 'app-preview',
    },
  }
}

const owner = await signUpOwner()

async function mintCode(): Promise<string> {
  const issued = await devices.issuePairing(owner.actor, hub)
  if (!issued.ok) throw new Error(issued.failure.message)
  return issued.value.code
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__preview/pairing' && request.method === 'POST')
      return new Response(`${await mintCode()}\n`)
    if (url.pathname === '/__preview/login') {
      const next = url.searchParams.get('next') ?? '/app'
      return new Response(null, {
        status: 302,
        headers: {
          location: next.startsWith('/') ? next : '/app',
          'set-cookie': accountSessionCookie(owner.sid, false),
        },
      })
    }
    return handle(request)
  },
})

process.stdout.write(
  [
    `app preview on ${hub}`,
    `pairing code ${await mintCode()} (ops account, 10 minutes, one use)`,
    `  sign in:      qmo sign-in ${hub}   # then type the code`,
    `  another code: curl -s -X POST ${hub}/__preview/pairing`,
    `  browser:      ${hub}/__preview/login?next=/app`,
    '',
  ].join('\n'),
)
