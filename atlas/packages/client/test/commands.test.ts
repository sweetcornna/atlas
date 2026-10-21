// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

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
} from '../src/commands.ts'
import { ClientHome } from '../src/home.ts'
import type { PipeOpen } from '../src/window.ts'
import { type FakeHub, fakeHub, PAIRING_CODE } from './fakeHub.ts'

/**
 * The commands over stand-in effects: the stand-in hub over HTTP, and a
 * window that navigates the way a launched one does (`Sec-Fetch-Site: none`,
 * the 303 followed by hand).
 */
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function navigate(
  url: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const first = await fetch(url, {
    redirect: 'manual',
    headers: { 'sec-fetch-site': 'none', ...headers },
  })
  const cookie = first.headers
    .getSetCookie()
    .find(line => line.startsWith('qianmo_session='))
    ?.split(';')[0]
  await fetch(new URL(first.headers.get('location') ?? url, url), {
    redirect: 'manual',
    headers: {
      'sec-fetch-site': 'same-origin',
      ...(cookie === undefined ? {} : { cookie }),
    },
  })
}

function scene(
  platform: NodeJS.Platform,
  options: {
    readonly accounts?: boolean
    readonly answer?: string | null
  } = {},
) {
  const hub = fakeHub(options.accounts === false ? { accounts: false } : {})
  cleanups.push(() => hub.stop())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-commands-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  const launched: string[] = []
  const visits: Promise<void>[] = []
  /** What the pipe route was handed, and every DevTools method sent to it. */
  const pipe = { deviceId: null as string | null, sent: [] as unknown[] }
  const deps: ClientDeps = {
    home: new ClientHome(path.join(dir, 'client'), 'linux'),
    platform,
    arch: 'x64',
    io: {
      out: line => out.push(line),
      err: line => err.push(line),
      async ask(question) {
        asked.push(question)
        return options.answer === undefined ? PAIRING_CODE : options.answer
      },
    },
    fetch: (input, init) => fetch(input, init),
    hostname: () => 'ymy-pc',
    findBrowser: () => ({ path: '/fake/msedge', name: 'edge' }),
    openOnArgv(_browser, _profile, url) {
      launched.push(url)
      visits.push(navigate(url))
    },
    async openOnPipe(_browser, _profile, _pipeDir, url, deviceId) {
      launched.push('about:blank')
      pipe.deviceId = deviceId
      // What window.openOnPipe asks the browser for over DevTools.
      const visit = navigate(url, { 'x-qmo-device': deviceId })
      visits.push(visit)
      let closeWindow: (code: number) => void = () => {}
      const exited = new Promise<number>(resolve => {
        closeWindow = resolve
      })
      void visit.then(() => setTimeout(() => closeWindow(0), 50))
      const open: PipeOpen = {
        sessionId: 'S',
        window: {
          exited,
          async send(method, params) {
            pipe.sent.push([method, params])
            return method === 'Runtime.evaluate'
              ? { result: { value: '/' } }
              : {}
          },
          close: () => {},
        },
      }
      return open
    },
    openDefault: url => launched.push(`default ${url}`),
    sleep: ms => Bun.sleep(Math.min(ms, 20)),
  }
  return { hub, deps, out, err, asked, launched, visits, pipe }
}

/** Pair the way `qm handoff login` does: no `kind`. */
async function pairAsHandoff(hub: FakeHub, home: ClientHome): Promise<void> {
  const response = await fetch(`${hub.url}/v0/handoff/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: PAIRING_CODE, name: 'pc', platform: 'x' }),
  })
  const paired = (await response.json()) as { deviceId: string; token: string }
  await home.save(
    {
      version: 1,
      hub: hub.url,
      deviceId: paired.deviceId,
      name: 'pc',
      pairedAt: new Date().toISOString(),
    },
    paired.token,
  )
}

describe('sign-in', () => {
  test('without --code the code is asked for, never put on a command line', async () => {
    const c = scene('linux')
    expect(await signIn(c.deps, { hub: c.hub.url })).toBe(0)
    expect(c.asked).toEqual([
      '配对码（配对码在中枢「连接」页「添加设备」里拿）：',
    ])
    // The pairing marks a client device.
    expect(c.hub.paired).toEqual(['client'])
    expect(c.deps.home.load()?.name).toBe('ymy-pc')
  })

  test('--code is taken as given, and no answer is a usage error', async () => {
    const given = scene('linux', { answer: 'WRONG' })
    expect(
      await signIn(given.deps, { hub: given.hub.url, code: PAIRING_CODE }),
    ).toBe(0)
    expect(given.asked).toEqual([])
    for (const answer of [null, '  ']) {
      const none = scene('linux', { answer })
      const refused = signIn(none.deps, { hub: none.hub.url })
      await expect(refused).rejects.toThrow(/需要配对码/)
      await expect(refused).rejects.toMatchObject({ exitCode: 2 })
      expect(none.hub.paired).toEqual([])
    }
  })
})

describe('open', () => {
  test('the command line route says the window may ask to confirm the account', async () => {
    const c = scene('win32')
    await signIn(c.deps, { hub: c.hub.url })
    expect(await openFront(c.deps)).toBe(0)
    await Promise.all(c.visits)
    expect(c.launched[0]).toContain('/client/enter?ticket=qmt_')
    expect(c.out).toContain('等窗口进入前台 · 要在窗口里点「进入」确认账号')
    expect(c.out.at(-1)).toBe(`已在窗口里打开 ${c.hub.url}/`)
    expect(c.hub.entered).toEqual([{ site: 'none', device: null }])
    expect(c.err).toEqual([])
  })

  test('the pipe route carries the device id and drops the header once landed', async () => {
    const c = scene('linux')
    await signIn(c.deps, { hub: c.hub.url })
    const deviceId = c.deps.home.load()!.deviceId
    expect(await openFront(c.deps)).toBe(0)
    expect(c.pipe.deviceId).toBe(deviceId)
    expect(c.hub.entered).toEqual([{ site: 'none', device: deviceId }])
    const methods = c.pipe.sent.map(m => (m as [string])[0])
    const landed = methods.indexOf('Runtime.evaluate')
    const cleared = c.pipe.sent.findIndex(
      m =>
        (m as [string, unknown])[0] === 'Network.setExtraHTTPHeaders' &&
        JSON.stringify((m as [string, unknown])[1]) === '{"headers":{}}',
    )
    expect(landed).toBeGreaterThanOrEqual(0)
    expect(cleared).toBeGreaterThan(landed)
    expect(methods.indexOf('Network.disable')).toBeGreaterThan(cleared)
    expect(c.out.at(-1)).toStartWith('已在窗口里打开')
  })

  test('a qm handoff device is told to pair again, and no window opens', async () => {
    const c = scene('win32')
    await pairAsHandoff(c.hub, c.deps.home)
    await expect(openFront(c.deps)).rejects.toThrow(
      '这台设备是用 qm handoff login 配对的接力设备，不能打开前台 · 请 qmo sign-in --force 重新配对',
    )
    expect(c.launched).toEqual([])
  })

  test('a hub without personal accounts gets the login page, with that reason', async () => {
    const c = scene('linux', { accounts: false })
    await signIn(c.deps, { hub: c.hub.url })
    expect(await openFront(c.deps)).toBe(0)
    await Promise.all(c.visits)
    expect(c.launched).toEqual([`${c.hub.url}/login`])
    expect(c.out.at(-1)).toBe(
      '这个中枢没开个人账号，只能在登录页登录 · 窗口打开了登录页',
    )
  })

  test('an owner no longer active is told so, and no window opens', async () => {
    const c = scene('win32')
    await signIn(c.deps, { hub: c.hub.url })
    c.hub.inactive.add(c.deps.home.load()!.deviceId)
    await expect(openFront(c.deps)).rejects.toThrow(
      /账号已停用或已重置.*qmo sign-in --force/,
    )
    expect(c.launched).toEqual([])
  })
})

describe('status and sign-out', () => {
  test('status names why the hub refuses the device', async () => {
    const lines: [(c: ReturnType<typeof scene>) => Promise<void>, string][] = [
      [async () => {}, '状态    有效'],
      [
        async c => {
          c.hub.revoked.add(c.deps.home.load()!.deviceId)
        },
        '状态    已吊销，请 qmo sign-in --force',
      ],
      [
        async c => {
          c.hub.inactive.add(c.deps.home.load()!.deviceId)
        },
        '状态    所属账号已停用或已重置 · 账号恢复或重新登录中枢后，再 qmo sign-in --force',
      ],
      [
        c => c.deps.home.secret.write(`qmd_${'u'.repeat(43)}`),
        '状态    令牌无效，请 qmo sign-in --force',
      ],
    ]
    for (const [arrange, line] of lines) {
      const c = scene('linux')
      await signIn(c.deps, { hub: c.hub.url })
      await arrange(c)
      expect(await status(c.deps)).toBe(0)
      expect(c.out).toContain(line)
    }
  })

  test('sign-out with an inactive account leaves the device to the 连接 page', async () => {
    const c = scene('linux')
    await signIn(c.deps, { hub: c.hub.url })
    c.hub.inactive.add(c.deps.home.load()!.deviceId)
    expect(await signOut(c.deps)).toBe(1)
    expect(c.err.at(-1)).toContain('账号已停用')
    expect(c.err.at(-1)).toContain('「连接」页手动吊销')
    // This computer is signed out either way.
    expect(c.deps.home.load()).toBeUndefined()
  })
})
