// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `qmo` client against a real console over HTTP (clients.md §3): pairing
 * with a code from the device ledger, a ticket per window, the window's
 * navigation opening the front as the device owner, and sign-out revoking the
 * device and closing that session. The account book and the device ledger are
 * the production ones on temp files; only the browser is stood in for, by a
 * fetch that navigates the way a launched window does (`Sec-Fetch-Site: none`,
 * redirects followed by hand, cookies kept).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type ClientDeps,
  openFront,
  signIn,
  signOut,
  status,
} from '@qianmo/client/commands.js'
import { ClientHome } from '@qianmo/client/home.js'
import type { PipeOpen } from '@qianmo/client/window.js'
import { AccountBook, createConsoleHandler } from '@qianmo/console'
import { FileLedger } from '@qianmo/node/commands/consoleAccountsStore.js'
import { openConsoleHandoffDevices } from '@qianmo/node/commands/consoleHandoffDevices.js'
import {
  CountingChat,
  LIMITS,
  TOKENS,
} from '../../packages/console/test/accountsHarness.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const unsupported = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'not here' },
}

function hubScene(withAccounts = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-front-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const accounts = new FileLedger(path.join(root, 'accounts.ndjson'))
  const sessions = new FileLedger(path.join(root, 'sessions.ndjson'))
  cleanups.push(() => {
    accounts.close()
    sessions.close()
  })
  const book = new AccountBook({ accounts, sessions })
  const devices = openConsoleHandoffDevices({
    path: path.join(root, 'devices.ndjson'),
    accounts: book,
    pairWith: 'client',
  })
  cleanups.push(() => devices.close())
  const handle = createConsoleHandler(
    {
      registry: {
        list: async () => ({ ok: true, value: [] }),
        register: async () => unsupported,
        deregister: async () => ({ ok: true, value: undefined }),
        heartbeat: async () => unsupported,
      },
      audit: {
        read: async () => unsupported,
        chain: async () => ({ ok: true, value: null }),
      },
      limits: LIMITS,
      chat: new CountingChat(),
      handoffDevices: devices,
    },
    TOKENS,
    withAccounts ? { book } : undefined,
  )
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, srv) => handle(request, srv),
  })
  cleanups.push(() => server.stop(true))
  const hub = `http://127.0.0.1:${server.port}`
  const member = () => {
    const invite = book.issueInvite({
      role: 'member',
      issuedBy: 'legacy:admin',
    })
    if (!invite.ok) throw new Error('invite')
    const user = book.acceptInvite(invite.value.token)
    if (!user.ok) throw new Error('accept')
    return {
      subject: user.value.subject,
      role: 'member' as const,
      requestId: 'e2e',
    }
  }
  return { root, hub, book, devices, member }
}

/** What the stand-in window did: its first navigation and where it settled. */
interface Visit {
  readonly site: string
  readonly entered: number
  readonly cookie: string | null
  readonly landed: { status: number; location: string | null; body: string }
}

/** Navigate like a launched app window: user-initiated, redirects by hand. */
async function navigate(url: string): Promise<Visit> {
  const first = await fetch(url, {
    redirect: 'manual',
    headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
  })
  const line = first.headers
    .getSetCookie()
    .find(cookie => cookie.startsWith('qianmo_session='))
  const cookie = line?.split(';')[0] ?? null
  const next = new URL(first.headers.get('location') ?? url, url)
  const second = await fetch(next, {
    redirect: 'manual',
    headers: {
      'sec-fetch-site': 'same-origin',
      ...(cookie === null ? {} : { cookie }),
    },
  })
  return {
    site: 'none',
    entered: first.status,
    cookie,
    landed: {
      status: second.status,
      location: second.headers.get('location'),
      body: await second.text(),
    },
  }
}

function clientScene(
  platform: NodeJS.Platform,
  pipeAnswers: (expression: string) => unknown = () => '/',
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-home-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out: string[] = []
  const err: string[] = []
  const visits: Promise<Visit>[] = []
  const launched: string[] = []
  const deps: ClientDeps = {
    // A file store on every platform here; DPAPI is covered on Windows itself.
    home: new ClientHome(dir, 'linux'),
    platform,
    arch: 'x64',
    io: {
      out: line => out.push(line),
      err: line => err.push(line),
      ask: () => null,
    },
    fetch: (input, init) => fetch(input, init),
    hostname: () => 'ymy-pc',
    findBrowser: () => ({ path: '/fake/msedge', name: 'edge' }),
    openOnArgv: (_browser, _profile, url) => {
      launched.push(url)
      visits.push(navigate(url))
    },
    async openOnPipe(_browser, _profile, _pipeDir, url) {
      launched.push('about:blank')
      const visit = navigate(url)
      visits.push(visit)
      let closeWindow: (code: number) => void = () => {}
      const exited = new Promise<number>(resolve => {
        closeWindow = resolve
      })
      // The user closes the window once the front has been shown.
      void visit.then(() => setTimeout(() => closeWindow(0), 50))
      const open: PipeOpen = {
        sessionId: 'S',
        window: {
          exited,
          async send(method, params) {
            if (method === 'Runtime.evaluate')
              return {
                result: { value: pipeAnswers(String(params?.expression)) },
              }
            return {}
          },
          close: () => {},
        },
      }
      return open
    },
    openDefault: url => launched.push(`default ${url}`),
    sleep: ms => Bun.sleep(ms),
  }
  return { deps, out, err, visits, launched }
}

describe('qmo against a console with personal accounts', () => {
  for (const platform of ['win32', 'linux'] as const) {
    test(`${platform}: pair, open the front as the owner, sign out`, async () => {
      const hub = hubScene()
      const owner = hub.member()
      const pairing = await hub.devices.issuePairing(owner, hub.hub)
      if (!pairing.ok) throw new Error('pairing')
      expect(pairing.value.command).toBe(
        `qmo sign-in ${hub.hub} --code ${pairing.value.code}`,
      )

      const c = clientScene(platform)
      expect(
        await signIn(c.deps, { hub: `${hub.hub}/`, code: pairing.value.code }),
      ).toBe(0)
      const state = c.deps.home.load()
      expect(state?.hub).toBe(hub.hub)
      expect(state?.name).toBe('ymy-pc')
      const token = await c.deps.home.token()
      expect(hub.devices.authenticate!(token)).toEqual({
        deviceId: state!.deviceId,
        owner: owner.subject,
      })
      const listed = await hub.devices.listDevices()
      expect(listed.ok && listed.value[0]?.platform).toBe(`${platform}-x64`)

      await status(c.deps)
      expect(c.out).toContain('状态    有效')

      expect(await openFront(c.deps)).toBe(0)
      const [visit] = await Promise.all(c.visits)
      // Windows hands the window its ticket on the command line; Linux never does.
      if (platform === 'win32')
        expect(c.launched[0]).toContain('/client/enter?ticket=qmt_')
      else expect(c.launched).toEqual(['about:blank'])
      expect(visit!.entered).toBe(303)
      expect(visit!.cookie).toMatch(/^qianmo_session=/)
      expect(visit!.landed.status).toBe(200)
      expect(visit!.landed.location).toBeNull()
      expect(visit!.landed.body).not.toContain('name="token"')
      const sid = visit!.cookie!.slice('qianmo_session='.length)
      const principal = hub.book.sessionPrincipal(sid)
      expect(principal.ok && principal.value.subject).toBe(owner.subject)
      expect(c.err).toEqual([])

      expect(await signOut(c.deps)).toBe(0)
      expect(hub.devices.authenticate!(token)).toBeNull()
      expect(hub.book.sessionPrincipal(sid).ok).toBe(false)
      expect(c.deps.home.load()).toBeUndefined()
      expect(fs.existsSync(c.deps.home.secret.file)).toBe(false)
    }, 30_000)
  }

  test('a second sign-in without --force is refused, with it the old device is revoked', async () => {
    const hub = hubScene()
    const owner = hub.member()
    const c = clientScene('win32')
    const first = await hub.devices.issuePairing(owner, hub.hub)
    if (!first.ok) throw new Error('pairing')
    await signIn(c.deps, { hub: hub.hub, code: first.value.code })
    const oldToken = await c.deps.home.token()
    const second = await hub.devices.issuePairing(owner, hub.hub)
    if (!second.ok) throw new Error('pairing')
    await expect(
      signIn(c.deps, { hub: hub.hub, code: second.value.code }),
    ).rejects.toThrow(/--force/)
    expect(
      await signIn(c.deps, {
        hub: hub.hub,
        code: second.value.code,
        force: true,
      }),
    ).toBe(0)
    expect(hub.devices.authenticate!(oldToken)).toBeNull()
    expect(hub.devices.authenticate!(await c.deps.home.token())).not.toBeNull()
  })
})

test('a console without personal accounts gets the login page, not a ticket', async () => {
  const hub = hubScene(false)
  const pairing = await hub.devices.issuePairing(
    { subject: 'legacy:admin', role: null, requestId: 'e2e' },
    hub.hub,
  )
  if (!pairing.ok) throw new Error('pairing')
  const c = clientScene('win32')
  expect(await signIn(c.deps, { hub: hub.hub, code: pairing.value.code })).toBe(
    0,
  )
  expect(await openFront(c.deps)).toBe(0)
  expect(c.launched).toEqual([`${hub.hub}/login`])
  expect(c.out.at(-1)).toContain('窗口打开了登录页')
  const [visit] = await Promise.all(c.visits)
  expect(visit!.cookie).toBeNull()
  expect(visit!.entered).toBe(200)
})
