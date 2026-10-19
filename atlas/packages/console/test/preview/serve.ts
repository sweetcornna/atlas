// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A whole console on loopback, every area filled from the test fakes, for
 * looking at pages while they are being designed. Not a test.
 *
 * `bun atlas/packages/console/test/preview/serve.ts [port] [--no-magpie]`
 * serves http://127.0.0.1:<port>/ (default 38700). Personal accounts are on,
 * with an ops, a member and a viewer account made at start;
 * `/__preview/login?as=ops|member|viewer` signs the browser in as one of
 * them. The management token is the test value in `README.md`. Nothing is
 * written to disk: every port is the in-memory fake the page tests use.
 */

import { AccountBook } from '../../src/accounts.js'
import { accountSessionCookie } from '../../src/access.js'
import type { ConsoleTokens } from '../../src/auth.js'
import type { ConsoleDeps, ConsoleResult } from '../../src/deps.js'
import { createConsoleHandler } from '../../src/http.js'
import {
  BASE,
  cookieFrom,
  credentialOn,
  formPost,
  MemoryLedger,
} from '../accountsHarness.js'
import {
  FakeChannels,
  FakeExtensions,
  FakeMagpie,
  FakeUpdates,
  PREVIEW_PORTS,
} from '../directionFakes.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { agentAt, LIMITS, PageAudit, PageRegistry } from '../pageHarness.js'
import { FakeProviders } from '../providersFake.js'
import { PreviewChat, TARGETS } from './chat.js'
import { PreviewTasks } from './tasks.js'

/** Test values, printed in `README.md`. Never a real console's tokens. */
const PREVIEW_TOKENS: ConsoleTokens = {
  view: 'preview-view-0b7e52c41a9d',
  admin: 'preview-admin-6f1d3a8c27e4',
}

type Role = 'ops' | 'member' | 'viewer'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

const args = process.argv.slice(2)
const port = Number(args.find(arg => /^\d+$/.test(arg)) ?? 38700)
const withMagpie = !args.includes('--no-magpie')
const now = (): number => Date.now()

const registry = new PageRegistry()
registry.listResult = ok(TARGETS.map(target => agentAt(target.address)))

const ports = Object.fromEntries(
  Object.entries(PREVIEW_PORTS).map(([name, make]) => [name, make(now)]),
) as Partial<ConsoleDeps>

const deps: ConsoleDeps = {
  registry,
  audit: new PageAudit(),
  limits: LIMITS,
  now,
  label: 'preview-hub',
  identity: 'qianmo://hub/console',
  chat: new PreviewChat(),
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
  channels: new FakeChannels(now),
  updates: new FakeUpdates(now),
  extensions: new FakeExtensions(),
  ...(withMagpie ? { magpie: new FakeMagpie() } : {}),
  ...ports,
}

const book = new AccountBook({
  accounts: new MemoryLedger(),
  sessions: new MemoryLedger('memory://sessions.ndjson'),
  now,
})
const handle = createConsoleHandler(deps, PREVIEW_TOKENS, { book })

/** Invite with the management token and redeem: a signed-in person. */
async function signUp(role: Role): Promise<string> {
  const invited = await handle(
    new Request(`${BASE}/v0/accounts/invites`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PREVIEW_TOKENS.admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role, label: `preview-${role}` }),
    }),
  )
  const { link } = (await invited.json()) as { link: string }
  const token = link.slice(link.indexOf('#') + 1)
  const redeemed = await handle(formPost('/invite', { invite: token }))
  credentialOn(await redeemed.text())
  const sid = cookieFrom(redeemed, 'qianmo_session')
  if (sid === null || sid === '') throw new Error(`no session for ${role}`)
  return sid
}

const sessions: Record<Role, string> = {
  ops: await signUp('ops'),
  member: await signUp('member'),
  viewer: await signUp('viewer'),
}

/** `/__preview/login?as=<role>&next=<path>`: the cookie, then the page. */
function previewLogin(url: URL): Response {
  const asked = url.searchParams.get('as') ?? 'ops'
  const role: Role =
    asked === 'member' || asked === 'viewer' ? asked : ('ops' as const)
  const next = url.searchParams.get('next') ?? '/'
  return new Response(null, {
    status: 302,
    headers: {
      location: next.startsWith('/') ? next : '/',
      'set-cookie': accountSessionCookie(sessions[role], false),
    },
  })
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__preview/login') return previewLogin(url)
    return handle(request)
  },
})

process.stdout.write(
  `console preview on http://127.0.0.1:${port}/__preview/login?as=ops` +
    `${withMagpie ? '' : ' (no magpie)'}\n`,
)
