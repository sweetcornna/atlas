// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { desktopLauncher } from '../../src/host/desktop.js'
import {
  createCdpBridge,
  lsofPeers,
  platformPeers,
  procPeers,
  type CdpBridge,
  type CdpPeers,
} from '../../src/host/desktopCdp.js'

/**
 * The host bridge to a browser's DevTools pipe (runtimes-channels.md §6.3):
 * who gets in, how several clients share one pipe, the two transports
 * (FIFOs on Linux, launcher-made socket pairs on macOS), and the
 * per-platform lookup of a loopback connection's process. A fake browser
 * answers over the real pipes; the last test runs a real Chrome or Chromium
 * when the machine has one.
 */
const FAKE_BROWSER = path.join(
  import.meta.dir,
  'fixtures',
  'fake-devtools-browser.runner.ts',
)
const TOKEN = 'k'.repeat(43)
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(prefix: string): string {
  // Short: FIFO paths stay readable in failures.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Message {
  id?: number
  method?: string
  sessionId?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

/** Plays Chromium on the browser's ends of the two FIFOs. */
function fakeBrowser(command: readonly string[]) {
  const [, , , , input, output] = command
  const fromHost = fs.openSync(input!, fs.constants.O_RDWR)
  const toHost = fs.openSync(
    output!,
    fs.constants.O_RDWR | fs.constants.O_NONBLOCK,
  )
  const reader = Bun.file(fromHost).stream().getReader()
  const received: Message[] = []
  let sessions = 0
  const write = (message: Message) =>
    fs.writeSync(toHost, Buffer.from(`${JSON.stringify(message)}\0`))
  const answer = (m: Message): Record<string, unknown> => {
    switch (m.method) {
      case 'Browser.getVersion':
        return {
          product: 'HeadlessChrome/155',
          protocolVersion: '1.3',
          userAgent: 'fixture',
          jsVersion: '15',
          revision: 'r1',
        }
      case 'Target.getTargets':
        return {
          targetInfos: [
            { type: 'page' },
            { type: 'page' },
            { type: 'browser' },
          ],
        }
      case 'Target.attachToBrowserTarget':
        return { sessionId: `B${++sessions}` }
      case 'Target.attachToTarget':
        return { sessionId: `C${++sessions}` }
      default:
        return { echo: m.method }
    }
  }
  let silent = false
  void (async () => {
    let pending = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        pending += Buffer.from(value).toString('utf8')
        let end: number
        while ((end = pending.indexOf('\0')) !== -1) {
          const m = JSON.parse(pending.slice(0, end)) as Message
          pending = pending.slice(end + 1)
          received.push(m)
          if (!silent)
            write({
              id: m.id,
              result: answer(m),
              ...(m.sessionId ? { sessionId: m.sessionId } : {}),
            })
        }
      }
    } catch {
      /* Closed. */
    }
  })()
  const browser = {
    received,
    emit: write,
    mute() {
      silent = true
    },
    close() {
      void reader.cancel().catch(() => {})
      for (const fd of [fromHost, toHost])
        try {
          fs.closeSync(fd)
        } catch {
          /* Closed. */
        }
    },
  }
  cleanups.push(() => browser.close())
  return browser
}

/** One peer at a time, chosen by the test; pids 7 and 8 exist. */
function fakePeers() {
  const started = new Map([
    [7, 'start-7'],
    [8, 'start-8'],
  ])
  const state = { actor: 7, started }
  const peers: CdpPeers = {
    owner: async (_client, _server, pids) =>
      !pids || pids.includes(state.actor) ? state.actor : undefined,
    identity: async pid => started.get(pid),
  }
  return { state, peers }
}

async function bridged(peers: CdpPeers): Promise<{
  bridge: CdpBridge
  browser: ReturnType<typeof fakeBrowser>
  dir: string
}> {
  const dir = path.join(tempDir('cdp-'), 'cdp')
  const bridge = await createCdpBridge({
    dir,
    token: TOKEN,
    peers,
    transport: 'fifo',
  })
  cleanups.push(() => bridge.close())
  expect(bridge.pair).toBe(false)
  const browser = fakeBrowser(bridge.command(['chromium']))
  expect(await bridge.ready(() => true, 5000)).toBe(true)
  return { bridge, browser, dir }
}

const claim = (url: string, authorization?: string, method = 'POST') =>
  fetch(`${url}/qianmo/claim`, {
    method,
    headers: authorization ? { authorization } : {},
  })

/** A WebSocket client that keeps what it is sent. */
async function client(url: string) {
  const socket = new WebSocket(url)
  const inbox: Message[] = []
  const waiters: (() => void)[] = []
  socket.onmessage = event => {
    inbox.push(JSON.parse(String(event.data)) as Message)
    for (const wake of waiters.splice(0)) wake()
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('WebSocket refused'))
  })
  cleanups.push(() => socket.close())
  const next = async (match: (m: Message) => boolean, ms = 5000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const found = inbox.find(match)
      if (found) return found
      if (Date.now() > deadline) throw new Error('No matching message')
      await new Promise<void>(resolve => {
        waiters.push(resolve)
        setTimeout(resolve, 100)
      })
    }
  }
  return {
    inbox,
    send: (m: Message) => socket.send(JSON.stringify(m)),
    reply: (id: number, ms?: number) => next(m => m.id === id, ms),
    next,
    close: () => socket.close(),
  }
}

const settle = () => Bun.sleep(100)

test('the bridge lets in only the process that claimed it with the secret', async () => {
  const { state, peers } = fakePeers()
  const { bridge } = await bridged(peers)
  const version = () => fetch(`${bridge.url}/json/version`)
  // Nothing before a claim: no discovery, no socket.
  expect((await version()).status).toBe(403)
  expect((await claim(bridge.url)).status).toBe(403)
  expect((await claim(bridge.url, `Bearer ${'x'.repeat(43)}`)).status).toBe(403)
  expect((await claim(bridge.url, TOKEN)).status).toBe(403)
  expect((await claim(bridge.url, `Bearer ${TOKEN}`, 'GET')).status).toBe(405)
  expect((await claim(bridge.url, `Bearer ${TOKEN}`)).status).toBe(204)
  const answered = await version()
  expect(answered.status).toBe(200)
  const discovery = (await answered.json()) as Record<string, string>
  expect(discovery.Browser).toBe('HeadlessChrome/155')
  expect(discovery.webSocketDebuggerUrl).toMatch(
    new RegExp(
      `^ws://127\\.0\\.0\\.1:${new URL(bridge.url).port}/devtools/browser/[0-9a-f-]{36}$`,
    ),
  )
  expect((await fetch(`${bridge.url}/json/list`)).status).toBe(404)
  // Another process on the same network is refused everywhere, socket too.
  state.actor = 8
  expect((await version()).status).toBe(403)
  expect((await fetch(`${bridge.url}/json/list`)).status).toBe(403)
  await expect(client(discovery.webSocketDebuggerUrl!)).rejects.toThrow(
    'refused',
  )
  // A reused pid is not the process that claimed.
  state.actor = 7
  state.started.set(7, 'start-7-again')
  expect((await version()).status).toBe(403)
  expect((await claim(bridge.url, `Bearer ${TOKEN}`)).status).toBe(204)
  expect((await version()).status).toBe(200)
})

test('each client has its own browser session; answers and events reach their owner only', async () => {
  const { peers } = fakePeers()
  const { bridge, browser } = await bridged(peers)
  expect((await claim(bridge.url, `Bearer ${TOKEN}`)).status).toBe(204)
  const { webSocketDebuggerUrl: ws } = (await (
    await fetch(`${bridge.url}/json/version`)
  ).json()) as { webSocketDebuggerUrl: string }
  const one = await client(ws)
  const two = await client(ws)
  // Sent before the session is attached: queued, then delivered in order.
  one.send({ id: 1, method: 'Browser.getVersion' })
  two.send({ id: 1, method: 'SystemInfo.getInfo' })
  const first = await one.reply(1)
  const second = await two.reply(1)
  expect(first.result?.product).toBe('HeadlessChrome/155')
  expect(second.result).toEqual({ echo: 'SystemInfo.getInfo' })
  expect(first.sessionId).toBeUndefined()
  expect(second.sessionId).toBeUndefined()
  // Each went to the browser on its client's own browser session.
  const sessionFor = (method: string) =>
    browser.received.find(m => m.method === method && m.sessionId)!.sessionId!
  const oneBrowser = sessionFor('Browser.getVersion')
  const twoBrowser = sessionFor('SystemInfo.getInfo')
  expect(oneBrowser).toMatch(/^B\d$/)
  expect(twoBrowser).toMatch(/^B\d$/)
  expect(oneBrowser).not.toBe(twoBrowser)

  // A target session the client attached is the client's alone.
  one.send({
    id: 2,
    method: 'Target.attachToTarget',
    params: { targetId: 'T', flatten: true },
  })
  const child = (await one.reply(2)).result!.sessionId as string
  expect(child).toMatch(/^C\d+$/)
  const before = browser.received.length
  two.send({ id: 3, method: 'Runtime.evaluate', sessionId: child })
  expect((await two.reply(3)).error).toMatchObject({ code: -32001 })
  one.send({ id: 3, method: 'Runtime.evaluate', sessionId: child })
  expect(await one.reply(3)).toMatchObject({
    id: 3,
    sessionId: child,
    result: { echo: 'Runtime.evaluate' },
  })
  expect(
    browser.received.slice(before).filter(m => m.method === 'Runtime.evaluate'),
  ).toHaveLength(1)

  // Events: a target session's go to its owner as they are; a browser
  // session's go to its owner without the session; unknown ones nowhere.
  browser.emit({ method: 'Page.loadEventFired', sessionId: child })
  browser.emit({
    method: 'Target.attachedToTarget',
    sessionId: twoBrowser,
    params: { sessionId: 'C99', targetInfo: {} },
  })
  browser.emit({ method: 'Target.targetCreated', sessionId: 'nobody' })
  browser.emit({ method: 'Target.targetCreated' })
  expect(await one.next(m => m.method === 'Page.loadEventFired')).toMatchObject(
    { sessionId: child },
  )
  const attached = await two.next(m => m.method === 'Target.attachedToTarget')
  expect(attached.sessionId).toBeUndefined()
  // Auto-attached sessions become the owner's too.
  two.send({ id: 4, method: 'Runtime.enable', sessionId: 'C99' })
  expect(await two.reply(4)).toMatchObject({ sessionId: 'C99' })
  await settle()
  expect(one.inbox.some(m => m.method === 'Target.attachedToTarget')).toBe(
    false,
  )
  expect(two.inbox.some(m => m.method === 'Page.loadEventFired')).toBe(false)
  expect(
    [...one.inbox, ...two.inbox].some(m => m.method === 'Target.targetCreated'),
  ).toBe(false)

  // The host's own view: page targets, over the same pipe.
  expect(await bridge.pages(2000)).toBe(2)
  // A client that leaves gives its browser session back.
  one.close()
  await settle()
  expect(browser.received.at(-1)).toMatchObject({
    method: 'Target.detachFromTarget',
    params: { sessionId: oneBrowser },
  })
})

test('a malformed message closes its client; a browser that never answers is not ready', async () => {
  const { peers } = fakePeers()
  const { bridge } = await bridged(peers)
  await claim(bridge.url, `Bearer ${TOKEN}`)
  const { webSocketDebuggerUrl: ws } = (await (
    await fetch(`${bridge.url}/json/version`)
  ).json()) as { webSocketDebuggerUrl: string }
  const socket = new WebSocket(ws)
  const closed = new Promise<number>(resolve => {
    socket.onclose = event => resolve(event.code)
  })
  await new Promise(resolve => {
    socket.onopen = resolve
  })
  socket.send('{"method":"Browser.getVersion"}')
  expect(await closed).toBe(1007)

  const silent = await createCdpBridge({
    dir: path.join(tempDir('cdp-'), 'cdp'),
    token: TOKEN,
    peers,
    transport: 'fifo',
  })
  cleanups.push(() => silent.close())
  fakeBrowser(silent.command(['chromium'])).mute()
  const started = Date.now()
  expect(await silent.ready(() => true, 300)).toBe(false)
  expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  expect(await silent.ready(() => false, 5000)).toBe(false)
  await expect(silent.pages(200)).rejects.toThrow('timed out')
  await expect(
    createCdpBridge({ dir: tempDir('cdp-'), token: 'short', peers }),
  ).rejects.toThrow('Invalid DevTools bridge secret')
})

test('closing the bridge refuses everyone, fails the host view and removes the pipe', async () => {
  const { peers } = fakePeers()
  const { bridge, dir } = await bridged(peers)
  const command = bridge.command(['chromium', '--remote-debugging-pipe'])
  expect(command.slice(0, 4)).toEqual([
    '/bin/sh',
    '-c',
    'i=$1 o=$2; shift 2; exec "$@" 3<"$i" 4>"$o"',
    'qianmo-cdp',
  ])
  expect(command.slice(4, 6)).toEqual([
    path.join(dir, 'in'),
    path.join(dir, 'out'),
  ])
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  for (const fifo of command.slice(4, 6)) {
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true)
    expect(fs.statSync(fifo).mode & 0o777).toBe(0o600)
  }
  bridge.close()
  await expect(fetch(`${bridge.url}/json/version`)).rejects.toThrow()
  await expect(bridge.pages(500)).rejects.toThrow('closed')
  for (const fifo of command.slice(4, 6))
    expect(fs.existsSync(fifo)).toBe(false)
})

test('peer lookups are capped, old claims age out, and a bridge closes when its browser stops', async () => {
  // Lookups that hang: past the cap a request is turned away, not queued.
  const held: (() => void)[] = []
  const hanging: CdpPeers = {
    owner: () => new Promise(resolve => held.push(() => resolve(undefined))),
    identity: async () => undefined,
  }
  const slow = await bridged(hanging)
  const stuck = Array.from({ length: 8 }, () =>
    claim(slow.bridge.url, `Bearer ${TOKEN}`),
  )
  while (held.length < 8) await Bun.sleep(5)
  expect((await claim(slow.bridge.url, `Bearer ${TOKEN}`)).status).toBe(503)
  for (const release of held) release()
  expect((await Promise.all(stuck)).map(r => r.status)).toEqual(
    Array(8).fill(403),
  )

  // Each restarted executor claims anew; the oldest claims are forgotten.
  let actor = 0
  const many: CdpPeers = {
    owner: async (_client, _server, pids) =>
      !pids || pids.includes(actor) ? actor : undefined,
    identity: async pid => `start-${pid}`,
  }
  const aged = await bridged(many)
  for (actor = 1; actor <= 17; actor++)
    expect((await claim(aged.bridge.url, `Bearer ${TOKEN}`)).status).toBe(204)
  actor = 2
  expect((await fetch(`${aged.bridge.url}/json/version`)).status).toBe(200)
  actor = 1
  expect((await fetch(`${aged.bridge.url}/json/version`)).status).toBe(403)

  // A FIFO never ends while the host holds it: the bridge asks the process.
  const dir = path.join(tempDir('cdp-'), 'cdp')
  const bridge = await createCdpBridge({
    dir,
    token: TOKEN,
    peers: fakePeers().peers,
    transport: 'fifo',
  })
  cleanups.push(() => bridge.close())
  const command = bridge.command(['chromium'])
  fakeBrowser(command)
  let running = true
  expect(await bridge.ready(() => running, 5000)).toBe(true)
  expect(await bridge.pages(1000)).toBe(2)
  running = false
  const deadline = Date.now() + 3000
  while (fs.existsSync(command[4]!) && Date.now() < deadline)
    await Bun.sleep(50)
  await expect(bridge.pages(500)).rejects.toThrow('closed')
  await expect(fetch(`${bridge.url}/json/version`)).rejects.toThrow()
})

test('the pair transport runs over the fd 3 and 4 the launcher made, and closes them', async () => {
  const { peers } = fakePeers()
  const bridge = await createCdpBridge({
    dir: path.join(tempDir('cdp-'), 'cdp'),
    token: TOKEN,
    peers,
    transport: 'pair',
  })
  cleanups.push(() => bridge.close())
  expect(bridge.pair).toBe(true)
  // Nothing to wrap: the launcher hands the browser its descriptors.
  expect(bridge.command(['chrome', '--remote-debugging-pipe'])).toEqual([
    'chrome',
    '--remote-debugging-pipe',
  ])
  const proc = Bun.spawn([process.execPath, FAKE_BROWSER], {
    stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'],
  })
  cleanups.push(() => {
    proc.kill()
  })
  const [input, output] = [proc.stdio[3], proc.stdio[4]] as unknown as [
    number,
    number,
  ]
  bridge.attach({ input, output })
  expect(() => bridge.attach({ input, output })).toThrow('already open')
  expect(await bridge.ready(() => proc.exitCode === null, 10_000)).toBe(true)
  expect(await bridge.pages(2000)).toBe(1)
  await claim(bridge.url, `Bearer ${TOKEN}`)
  expect(
    (
      (await (await fetch(`${bridge.url}/json/version`)).json()) as {
        Browser: string
      }
    ).Browser,
  ).toBe('PairChrome/1')
  bridge.close()
  for (const fd of [input, output]) expect(() => fs.fstatSync(fd)).toThrow()
})

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'the launcher hands out socket pairs on macOS only',
  async () => {
    if (process.platform === 'linux') {
      await expect(
        desktopLauncher.start('/bin/sh', ['-c', 'true'], process.env, true),
      ).rejects.toThrow('not passed on Linux')
      return
    }
    const proc = await desktopLauncher.start(
      '/bin/sh',
      ['-c', 'exec cat <&3 >&4'],
      process.env,
      true,
    )
    cleanups.push(() => proc.stop())
    const pipe = proc.devtools!
    fs.writeSync(pipe.input, 'ping')
    const reader = Bun.file(pipe.output).stream().getReader()
    const { value } = await reader.read()
    expect(Buffer.from(value!).toString()).toBe('ping')
    await reader.cancel()
    for (const fd of [pipe.input, pipe.output]) fs.closeSync(fd)
  },
)

test('procPeers finds the process holding the client socket, and its start time', async () => {
  const proc = tempDir('proc-')
  fs.mkdirSync(path.join(proc, 'net'))
  // Client 127.0.0.1:54321 → server 127.0.0.1:8080, and the server's side.
  fs.writeFileSync(
    path.join(proc, 'net', 'tcp'),
    [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0 100 0 0 10 0',
      '   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 55555 1 0 20 4 30 10 -1',
      '   2: 0100007F:D431 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 77777 1 0 20 4 30 10 -1',
      '   3: 0100007F:D432 0100007F:1F90 06 00000000:00000000 03:00000000 00000000     0        0 0 3 0',
      '',
    ].join('\n'),
  )
  const fd = (pid: number, n: number, target: string) => {
    fs.mkdirSync(path.join(proc, String(pid), 'fd'), { recursive: true })
    fs.symlinkSync(target, path.join(proc, String(pid), 'fd', String(n)))
  }
  fd(41, 3, 'socket:[55555]')
  fd(42, 0, '/dev/null')
  fd(42, 5, 'socket:[77777]')
  fs.mkdirSync(path.join(proc, '43'))
  fs.writeFileSync(
    path.join(proc, '42', 'stat'),
    `42 (bun (x) y) S ${Array.from({ length: 18 }, (_, i) => i + 1).join(' ')} 987654 0 0\n`,
  )
  const peers = procPeers(proc)
  expect(await peers.owner(54321, 8080)).toBe(42)
  expect(await peers.owner(54321, 8080, [41, 43])).toBeUndefined()
  expect(await peers.owner(54321, 8080, [42])).toBe(42)
  // TIME_WAIT has no inode; an unknown port has no line.
  expect(await peers.owner(54322, 8080)).toBeUndefined()
  expect(await peers.owner(1, 8080)).toBeUndefined()
  expect(await peers.identity(42)).toBe('987654')
  expect(await peers.identity(43)).toBeUndefined()
  expect(await procPeers(path.join(proc, 'missing')).owner(54321, 8080)).toBe(
    undefined,
  )
})

test('lsofPeers reads the client end out of lsof, and refuses when lsof fails', async () => {
  const dir = tempDir('lsof-')
  const lsof = path.join(dir, 'lsof')
  // Both ends of the connection, as `lsof -Fpn` prints them.
  fs.writeFileSync(
    lsof,
    [
      '#!/bin/sh',
      "printf 'p300\\nf9\\nn127.0.0.1:8080->127.0.0.1:54321\\np400\\nf12\\nn127.0.0.1:54321->127.0.0.1:8080\\n'",
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const ps = path.join(dir, 'ps')
  fs.writeFileSync(
    ps,
    '#!/bin/sh\n[ "$4" = 400 ] && echo "Sat Oct 17 09:00:00 2026" || exit 1\n',
    { mode: 0o755 },
  )
  const peers = lsofPeers(lsof, ps)
  expect(await peers.owner(54321, 8080)).toBe(400)
  expect(await peers.owner(54321, 8080, [300])).toBeUndefined()
  expect(await peers.owner(54321, 9090)).toBeUndefined()
  expect(await peers.identity(400)).toBe('Sat Oct 17 09:00:00 2026')
  expect(await peers.identity(401)).toBeUndefined()
  const failing = lsofPeers(path.join(dir, 'missing'), ps)
  expect(await failing.owner(54321, 8080)).toBeUndefined()
  expect(await platformPeers('win32').owner(54321, 8080)).toBeUndefined()
})

test.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'this platform names this process as the client of its own loopback connection',
  async () => {
    const peers = platformPeers()
    const seen: { owner?: number } = {}
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req, srv) {
        seen.owner = await peers.owner(srv.requestIP(req)!.port, srv.port!)
        return new Response('ok')
      },
    })
    try {
      await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
    } finally {
      server.stop(true)
    }
    expect(seen.owner).toBe(process.pid)
    expect(await peers.identity(process.pid)).toBeTruthy()
  },
  30_000,
)

const chrome =
  process.platform === 'darwin'
    ? fs.existsSync(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      )
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : null
    : process.platform === 'linux'
      ? (Bun.which('chromium') ?? Bun.which('google-chrome'))
      : null

test.skipIf(chrome === null)(
  'a real browser on the pipe: no port, the claiming process drives it, another process is refused',
  async () => {
    const page = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(
          '<!doctype html><title>Qmo pipe</title><h1>Qmo pipe</h1>',
          { headers: { 'Content-Type': 'text/html' } },
        ),
    })
    cleanups.push(() => page.stop(true))
    const root = tempDir('cdp-real-')
    const profile = path.join(root, 'profile')
    fs.mkdirSync(profile, { mode: 0o700 })
    // This platform's transport, through the launcher the host uses.
    const bridge = await createCdpBridge({
      dir: path.join(root, 'cdp'),
      token: TOKEN,
    })
    cleanups.push(() => bridge.close())
    const [program, ...argv] = bridge.command([
      chrome!,
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      'about:blank',
    ])
    const proc = await desktopLauncher.start(
      program!,
      argv,
      process.env,
      bridge.pair,
    )
    cleanups.push(() => proc.stop())
    if (bridge.pair) bridge.attach(proc.devtools!)
    expect(await bridge.ready(() => proc.alive(), 30_000)).toBe(true)
    // Chrome publishes no debugging port in pipe mode.
    expect(fs.existsSync(path.join(profile, 'DevToolsActivePort'))).toBe(false)
    expect(await bridge.pages(5000)).toBeGreaterThanOrEqual(1)

    expect((await claim(bridge.url, `Bearer ${TOKEN}`)).status).toBe(204)
    expect((await fetch(`${bridge.url}/json/version`)).status).toBe(200)
    // Another process on this machine, after this one claimed: the real
    // lookup tells the two apart.
    const other = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const r = await fetch(${JSON.stringify(`${bridge.url}/json/version`)}); console.log(r.status)`,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    expect((await new Response(other.stdout).text()).trim()).toBe('403')
    const { webSocketDebuggerUrl: ws } = (await (
      await fetch(`${bridge.url}/json/version`)
    ).json()) as { webSocketDebuggerUrl: string }
    const cdp = await client(ws)
    cdp.send({
      id: 1,
      method: 'Target.createTarget',
      params: { url: `http://127.0.0.1:${page.port}/` },
    })
    const targetId = (await cdp.reply(1)).result!.targetId as string
    cdp.send({
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId, flatten: true },
    })
    const sessionId = (await cdp.reply(2)).result!.sessionId as string
    let title = ''
    for (let id = 3; id < 60 && title !== 'Qmo pipe'; id++) {
      cdp.send({
        id,
        method: 'Runtime.evaluate',
        sessionId,
        params: { expression: 'document.title', returnByValue: true },
      })
      const value = (await cdp.reply(id)).result as {
        result?: { value?: string }
      }
      title = value.result?.value ?? ''
      if (title !== 'Qmo pipe') await Bun.sleep(100)
    }
    expect(title).toBe('Qmo pipe')
    cdp.send({ id: 99, method: 'Page.bringToFront', sessionId })
    await cdp.reply(99)
    cdp.send({
      id: 100,
      method: 'Page.captureScreenshot',
      sessionId,
      params: { format: 'png' },
    })
    const shot = (await cdp.reply(100, 20_000)).result!.data as string
    expect(Buffer.from(shot, 'base64').subarray(1, 4).toString()).toBe('PNG')
  },
  60_000,
)
