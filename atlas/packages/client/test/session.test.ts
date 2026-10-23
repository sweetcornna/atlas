// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type ClientDeps,
  enterSession,
  signIn,
  statusReport,
} from '../src/commands.ts'
import { ClientHome } from '../src/home.ts'
import type { Fetch } from '../src/hub.ts'
import { enterWithTicket, parseSetCookie } from '../src/session.ts'
import { fakeHub } from './fakeHub.ts'

/**
 * `qmo session` (qmo-app.md §3): the client spends the ticket on
 * `/client/enter` itself and hands the cookies to the desktop shell.
 */
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function scene(
  options: { readonly accounts?: boolean; readonly fetch?: Fetch } = {},
) {
  const hub = fakeHub(options.accounts === false ? { accounts: false } : {})
  cleanups.push(() => hub.stop())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-session-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const deps: ClientDeps = {
    home: new ClientHome(path.join(dir, 'client'), 'linux'),
    platform: 'darwin',
    arch: 'arm64',
    io: { out: () => {}, err: () => {}, ask: async () => 'ABCD-EFGH-IJKL' },
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    hostname: () => 'mac',
    findBrowser: () => null,
    openOnArgv: () => {},
    openOnPipe: () => Promise.reject(new Error('no window here')),
    openDefault: () => {},
    sleep: ms => Bun.sleep(Math.min(ms, 10)),
  }
  return { hub, deps }
}

describe('parseSetCookie', () => {
  test('reads every attribute, in any case', () => {
    expect(
      parseSetCookie(
        'qianmo_session=abc.DEF-1; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure',
      ),
    ).toEqual({
      name: 'qianmo_session',
      value: 'abc.DEF-1',
      domain: null,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: 2592000,
      expires: null,
    })
    expect(
      parseSetCookie(
        'a=b; domain=.Hub.Example.com; path=/x; samesite=lax; expires=Wed, 21 Oct 2026 07:28:00 GMT; HTTPONLY',
      ),
    ).toEqual({
      name: 'a',
      value: 'b',
      domain: 'hub.example.com',
      path: '/x',
      secure: false,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: null,
      expires: '2026-10-21T07:28:00.000Z',
    })
  })

  test('a cleared cookie keeps its zero age; odd attributes are dropped', () => {
    const cleared = parseSetCookie(
      'qianmo_console=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    )
    expect(cleared?.value).toBe('')
    expect(cleared?.maxAge).toBe(0)
    const odd = parseSetCookie(
      'a=b; Max-Age=soon; SameSite=Sometimes; Expires=never; Path=relative; Domain=',
    )
    expect(odd).toMatchObject({
      maxAge: null,
      sameSite: null,
      expires: null,
      domain: null,
    })
  })

  test('the path defaults to the directory of the request (RFC 6265 §5.1.4)', () => {
    expect(parseSetCookie('a=b', '/client/enter')?.path).toBe('/client')
    expect(parseSetCookie('a=b', '/enter')?.path).toBe('/')
    expect(parseSetCookie('a=b; Path=/; ', '/client/enter')?.path).toBe('/')
  })

  test('a line without a name is no cookie', () => {
    for (const line of ['', '=b', 'novalue', ' =x; Path=/'])
      expect(parseSetCookie(line)).toBeNull()
  })
})

describe('enterSession', () => {
  test('spends the ticket as the device window and returns its cookies', async () => {
    const c = scene()
    await signIn(c.deps, { hub: c.hub.url })
    const deviceId = c.deps.home.load()!.deviceId
    const session = await enterSession(c.deps)
    expect(session.hub).toBe(c.hub.url)
    expect(session.deviceId).toBe(deviceId)
    expect(session.name).toBe('mac')
    expect(session.cookies).toHaveLength(1)
    expect(session.cookies[0]).toMatchObject({
      name: 'qianmo_session',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    })
    // The navigation the hub saw: the device header, no site.
    expect(c.hub.entered).toEqual([{ site: 'none', device: deviceId }])
    // The cookie opens the front.
    const front = await fetch(`${c.hub.url}/`, {
      redirect: 'manual',
      headers: {
        cookie: `qianmo_session=${session.cookies[0]!.value}`,
      },
    })
    expect(front.status).toBe(200)
    expect(c.hub.front).toEqual(['/'])
  })

  test('each refusal has its kind', async () => {
    const signedOut = scene()
    await expect(enterSession(signedOut.deps)).rejects.toMatchObject({
      kind: 'signed_out',
    })

    for (const [arrange, kind] of [
      [
        (c: ReturnType<typeof scene>, id: string) => c.hub.revoked.add(id),
        'revoked',
      ],
      [
        (c: ReturnType<typeof scene>, id: string) => c.hub.inactive.add(id),
        'owner_inactive',
      ],
    ] as const) {
      const c = scene()
      await signIn(c.deps, { hub: c.hub.url })
      arrange(c, c.deps.home.load()!.deviceId)
      await expect(enterSession(c.deps)).rejects.toMatchObject({ kind })
      expect(c.hub.entered).toEqual([])
    }

    const unknown = scene()
    await signIn(unknown.deps, { hub: unknown.hub.url })
    await unknown.deps.home.secret.write(`qmd_${'u'.repeat(43)}`)
    await expect(enterSession(unknown.deps)).rejects.toMatchObject({
      kind: 'invalid',
    })
  })

  test('a hub without personal accounts is unsupported, with its reason', async () => {
    const c = scene({ accounts: false })
    await signIn(c.deps, { hub: c.hub.url })
    await expect(enterSession(c.deps)).rejects.toMatchObject({
      kind: 'unsupported',
      message: '这个中枢没开个人账号，只能在登录页登录',
    })
  })

  test('a hub that went away is a network failure', async () => {
    const c = scene()
    await signIn(c.deps, { hub: c.hub.url })
    c.hub.stop()
    await expect(enterSession(c.deps)).rejects.toMatchObject({
      kind: 'network',
    })
    expect((await statusReport(c.deps)).device).toBe('unreachable')
  })

  test('an entry the hub did not record as spending the ticket is refused', async () => {
    // Something between answers /client/enter itself: the ticket stays unspent.
    const c = scene({
      fetch: (input, init) =>
        new URL(input).pathname === '/client/enter'
          ? Promise.resolve(
              new Response(null, {
                status: 303,
                headers: {
                  location: '/',
                  'set-cookie': 'qianmo_session=forged; Path=/; HttpOnly',
                },
              }),
            )
          : fetch(input, init),
    })
    await signIn(c.deps, { hub: c.hub.url })
    await expect(enterSession(c.deps)).rejects.toMatchObject({
      kind: 'refused',
      message: '中枢没有记下票据已经用掉',
    })
  })
})

describe('enterWithTicket', () => {
  const answering =
    (response: () => Response): Fetch =>
    () =>
      Promise.resolve(response())

  test('the confirmation page, a cleared session or no 303 is refused', async () => {
    const cases: [() => Response, string][] = [
      [
        () => new Response('<form>', { status: 200 }),
        '中枢要求在页面上确认账号，没有认出这台设备',
      ],
      [
        () =>
          new Response(null, {
            status: 303,
            headers: { 'set-cookie': 'qianmo_session=; Path=/; Max-Age=0' },
          }),
        '中枢没有让这台设备进门（HTTP 303）',
      ],
      [() => new Response('', { status: 409 }), '这个窗口已经以另一个账号登录'],
      [
        () => new Response('', { status: 401 }),
        '中枢没有让这台设备进门（HTTP 401）',
      ],
    ]
    for (const [response, message] of cases)
      await expect(
        enterWithTicket(
          'http://127.0.0.1:1/client/enter?ticket=x',
          'd-abcdefghijkl',
          answering(response),
        ),
      ).rejects.toMatchObject({ kind: 'refused', message })
    await expect(
      enterWithTicket(
        'http://127.0.0.1:1/client/enter?ticket=x',
        'd-abcdefghijkl',
        answering(() => new Response('', { status: 429 })),
      ),
    ).rejects.toMatchObject({ kind: 'throttled' })
  })

  test('sends the device header and no-site, and follows no redirect', async () => {
    let seen: RequestInit | undefined
    const cookies = await enterWithTicket(
      'http://127.0.0.1:1/client/enter?ticket=x',
      'd-abcdefghijkl',
      (_input, init) => {
        seen = init
        return Promise.resolve(
          new Response(null, {
            status: 303,
            headers: [
              ['location', '/'],
              ['set-cookie', 'qianmo_session=s; Path=/; HttpOnly'],
              ['set-cookie', 'qianmo_console=; Path=/; Max-Age=0'],
            ],
          }),
        )
      },
    )
    expect(cookies.map(c => c.name)).toEqual([
      'qianmo_session',
      'qianmo_console',
    ])
    expect(seen?.redirect).toBe('manual')
    expect(seen?.credentials).toBe('omit')
    expect(seen?.headers).toMatchObject({
      'sec-fetch-site': 'none',
      'x-qmo-device': 'd-abcdefghijkl',
    })
  })
})
