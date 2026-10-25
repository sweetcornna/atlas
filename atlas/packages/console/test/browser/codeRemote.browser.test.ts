// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Remote on Code's page in a real browser (P37.15, `qmo-local.md` §5.2):
 *
 * 1. **A browser.** A hub with personal accounts and the device link, on
 *    loopback; a "runner" that is this test, on a real WebSocket, pushing a
 *    session of device MacBook. The account's `/code` lists it under
 *    MacBook · atlas, draws its records with the ask card, sends a line and
 *    an answer that reach the runner over the link and come back as
 *    records; the device offline makes it 离线 · 只读 with the box shut;
 *    Remote off shows 「从中枢删除副本」, which deletes it.
 * 2. **The desktop app.** The fake shell's runner says it has Remote: the
 *    switch over a session asks `qmo_local_set_remote`, the row gets its
 *    badge, the link's state is said beside the switch; the new session's
 *    switch is on offer and its `remote` reaches `qmo_local_start`; the
 *    copies of the account's other computer are listed beside.
 *
 * No app window, runner or agent is started. Skipped, with the reason
 * printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CodeLinks, type LinkData } from '../../src/codeLink.js'
import { accountsHarness, person } from '../accountsHarness.js'
import { LinkDevices, MemoryCopies } from '../codeCopiesFake.js'
import { Browser, skipReason, type Tab } from './cdp.js'
import { fakeShell } from './codeShell.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[code remote browser tests] skipped: ${SKIP}`)

const TOKEN = `qmd_${'a'.repeat(43)}`
const DEVICE = 'd-aaaaaaaaaaaa'
const SESSION = 'cs_AbCdEfGhIjKlMnOpQrSt_-'
const KEY = `${DEVICE}.${SESSION}`

type Frame = Record<string, unknown>

async function hub() {
  const devices = new LinkDevices()
  const copies = new MemoryCopies()
  const h = accountsHarness({
    deps: { handoffDevices: devices, codeCopies: copies },
  })
  const links = h.handle.links
  if (links === undefined) throw new Error('no links')
  const member = await person(h.handle, 'member')
  const principal = h.book.bearerPrincipal(member.credential)
  if (!principal.ok || principal.value.kind !== 'user')
    throw new Error('no subject')
  devices.byToken.set(TOKEN, {
    deviceId: DEVICE,
    owner: principal.value.subject,
    kind: 'client',
    name: 'MacBook',
  })
  const server = Bun.serve<LinkData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => {
      if (CodeLinks.isUpgrade(request)) return links.upgrade(request, bunServer)
      if (new URL(request.url).pathname === '/v0/events')
        return new Response(null, { status: 503 })
      return h.handle(request, bunServer)
    },
    websocket: links.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    url: `ws://127.0.0.1:${server.port}/v0/client/link`,
    sid: member.sid,
    owner: principal.value.subject,
    copies,
    stop: () => server.stop(true),
  }
}

/** The runner's end of the link: what it got, and what it pushes. */
class Runner {
  readonly socket: WebSocket
  readonly frames: Frame[] = []
  seq = 0
  constructor(url: string) {
    this.socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
      protocols: ['qmo-link.1'],
    })
    this.socket.onmessage = event =>
      this.frames.push(JSON.parse(String(event.data)) as Frame)
  }
  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame))
  }
  async next(t: string): Promise<Frame> {
    const deadline = Date.now() + 8_000
    for (;;) {
      const at = this.frames.findIndex(frame => frame.t === t)
      if (at >= 0) return this.frames.splice(at, 1)[0]!
      if (Date.now() > deadline)
        throw new Error(`no ${t}: ${JSON.stringify(this.frames)}`)
      await Bun.sleep(10)
    }
  }
  async up(remote = true, seq = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve()
      this.socket.onerror = () => reject(new Error('no link'))
    })
    this.send({ t: 'hello', v: 1, version: 'test' })
    const welcome = await this.next('welcome')
    this.seq = Number(
      (welcome.have as Record<string, { seq: number }>)[SESSION]?.seq ?? seq,
    )
    this.head(remote)
    await this.next('ack')
  }
  head(remote: boolean, state = 'idle'): void {
    this.send({
      t: 'session',
      session: {
        id: SESSION,
        title: '改一下 README',
        folder: 'atlas',
        agent: { id: 'claude-code', name: 'Claude Code' },
        mode: 'auto',
        state,
        remote,
        createdAt: 1_700_000_000_000,
        updatedAt: Date.now(),
        lastSeq: this.seq,
      },
    })
  }
  /** Pushes turns; their records' seq one by one after the last. */
  async push(turns: Frame[]): Promise<void> {
    const records = turns.map(turn => ({
      seq: ++this.seq,
      turn: {
        sessionId: SESSION,
        at: Date.now(),
        state: 'done',
        author: 'agent',
        ...turn,
      },
    }))
    this.send({ t: 'records', session: SESSION, records })
    await this.next('ack')
  }
}

const q = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})`

async function signedIn(
  browser: Browser,
  base: string,
  sid: string,
  shell: Parameters<typeof fakeShell>[0] | null,
): Promise<Tab> {
  const tab = await browser.tab({ width: 1280, height: 860 })
  await tab.send('Network.enable')
  await tab.send('Network.clearBrowserCookies')
  await tab.send('Network.setCookie', {
    name: 'qianmo_session',
    value: sid,
    url: base,
  })
  if (shell !== null) {
    await tab.send('Network.setCookie', {
      name: 'qianmo_shell',
      value: 'macos',
      url: base,
    })
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: fakeShell(shell),
    })
  }
  await tab.goto(`${base}/code`)
  await tab.waitFor('window.qianmoCodeHub !== undefined')
  return tab
}

const rowFor = (key: string) => `[data-session="${key}"]`

describe.skipIf(SKIP !== null)('Code: Remote', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('a browser: the copy listed, read, continued and answered online; offline read-only; Remote off, deleted', async () => {
    const h = await hub()
    const runner = new Runner(h.url)
    let tab: Tab | undefined
    try {
      await runner.up()
      await runner.push([
        { id: 't-1', author: 'operator', text: '改一下 README', state: 'read' },
        { id: 't-2', text: '先看看文件' },
        {
          id: 't-3',
          text: '要编辑 README.md',
          variant: 'notice',
          severity: 'warn',
          ask: {
            id: 'ask_1',
            tool: 'Edit',
            title: '编辑 README.md',
            options: ['once', 'session', 'deny'],
          },
        },
      ])
      tab = await signedIn(browser, h.base, h.sid, null)
      await tab.waitFor(`${q(rowFor(KEY))} !== null`)
      expect(
        await tab.evaluate<unknown>(`({
          web: ${q('#code-web')}.hidden,
          local: ${q('#code-local')}.hidden,
          start: ${q('#code-new')}.disabled,
          group: ${q('.fx-rgroup-name')}.textContent,
          line: ${q('.fx-code-hub-line')}?.textContent,
          dock: getComputedStyle(${q('.fx-dock')}).display,
        })`),
      ).toEqual({
        web: true,
        local: false,
        start: true,
        group: 'MacBook · atlas',
        line: '这里是你在别的电脑上开了 Remote 的会话 · 新会话在 Qmo 桌面版里开',
        dock: 'none',
      })

      await tab.evaluate(`${q(`${rowFor(KEY)}`)}.click()`)
      await tab.waitFor(`${q('.fx-perm')} !== null`)
      expect(
        await tab.evaluate<unknown>(`({
          url: location.search,
          title: ${q('#code-title')}.textContent,
          sub: ${q('#code-sub')}.textContent,
          changes: ${q('#code-changes-btn')}.hidden,
          mode: ${q('#code-mode')}.disabled,
          box: ${q('#code-text')}.disabled,
          remote: ${q('#code-remote-head')}.hidden,
          drop: ${q('#code-drop')}.hidden,
          texts: [...document.querySelectorAll('#code-msgs .fx-bubble')].map(n => n.textContent),
        })`),
      ).toEqual({
        url: `?session=${encodeURIComponent(KEY)}`,
        title: '改一下 README',
        sub: 'MacBook · atlas · Claude Code',
        changes: true,
        mode: true,
        box: false,
        remote: true,
        drop: true,
        texts: ['改一下 README', '先看看文件'],
      })

      // A line from here: over the link to the runner, back as records.
      await tab.evaluate(
        `(() => { const b = ${q('#code-text')}; b.value = '也改一下 CHANGELOG'; b.dispatchEvent(new Event('input')); ${q('#code-box')}.requestSubmit(); })()`,
      )
      const send = await runner.next('send')
      expect(send).toMatchObject({
        session: SESSION,
        text: '也改一下 CHANGELOG',
      })
      runner.send({
        t: 'reply',
        id: send.id,
        ok: true,
        result: { queued: false },
      })
      await runner.push([
        {
          id: 't-4',
          author: 'operator',
          text: '也改一下 CHANGELOG',
          state: 'read',
          clientId: send.clientId,
          origin: 'remote',
        },
        { id: 't-5', text: '好，一起改' },
      ])
      await tab.waitFor(
        `[...document.querySelectorAll('#code-msgs .fx-bubble')].some(n => n.textContent === '好，一起改')`,
        8_000,
      )
      expect(
        await tab.evaluate<number>(
          `[...document.querySelectorAll('#code-msgs .fx-bubble')].filter(n => n.textContent === '也改一下 CHANGELOG').length`,
        ),
      ).toBe(1)

      // The ask, answered from here.
      await tab.evaluate(`${q('.fx-perm-once')}.click()`)
      const answer = await runner.next('answer')
      expect(answer).toMatchObject({
        session: SESSION,
        ask: 'ask_1',
        decision: 'once',
      })
      runner.send({ t: 'reply', id: answer.id, ok: true, result: {} })

      // The computer goes offline: read-only.
      runner.socket.close()
      await tab.waitFor(`${q('#code-sub')}.textContent.includes('离线')`, 8_000)
      expect(
        await tab.evaluate<unknown>(`({
          sub: ${q('#code-sub')}.textContent,
          box: ${q('#code-text')}.disabled,
          go: ${q('#code-go')}.disabled,
          badge: ${q(`${rowFor(KEY)} .fx-code-badge`)}?.textContent,
        })`),
      ).toEqual({
        sub: 'MacBook · atlas · Claude Code · 离线 · 只读',
        box: true,
        go: true,
        badge: '离线',
      })

      // Back with Remote off: 「从中枢删除副本」 deletes the copy.
      const back = new Runner(h.url)
      try {
        await back.up(false)
        await tab.waitFor(`!${q('#code-drop')}.hidden`, 8_000)
        expect(
          await tab.evaluate<string>(`${q('#code-sub')}.textContent`),
        ).toBe('MacBook · atlas · Claude Code · Remote 已关 · 只读')
        await tab.evaluate(`${q('#code-drop')}.click()`)
        await tab.waitFor(
          `${q(rowFor(KEY))} === null && location.search === ''`,
        )
        expect(
          await tab.evaluate<string>(`${q('.fx-code-hub-line')}.textContent`),
        ).toBe(
          '还没有开着 Remote 的会话 · 在 Qmo 桌面版里打开一个会话的 Remote',
        )
        expect(h.copies.list(h.owner)).toEqual([])
      } finally {
        back.socket.close()
      }
    } finally {
      await tab?.close()
      runner.socket.close()
      await h.stop()
    }
  }, 60_000)

  test('the desktop app: the switch over a session, the badge, the link said, Remote from the first line, the other computer beside', async () => {
    const h = await hub()
    const runner = new Runner(h.url)
    let tab: Tab | undefined
    try {
      await runner.up()
      await runner.push([
        { id: 't-1', author: 'operator', text: '在另一台上', state: 'read' },
      ])
      tab = await signedIn(browser, h.base, h.sid, { remote: true })
      await tab.waitFor(
        `${q(rowFor(KEY))} !== null && !${q('#code-remote')}.disabled`,
      )
      // The new session's switch, on: `remote: true` from the first line.
      await tab.evaluate(`${q('#code-remote')}.click()`)
      await tab.evaluate(
        `(() => { const b = ${q('#code-text')}; b.value = '本机这一条'; b.dispatchEvent(new Event('input')); ${q('#code-box')}.requestSubmit(); })()`,
      )
      await tab.waitFor(`/[?&]session=cs_/.test(location.search)`)
      const started = await tab.evaluate<Frame>(
        `window.__calls.filter(c => c[0] === 'qmo_local_start')[0][1]`,
      )
      expect(started.remote).toBe(true)
      const local = await tab.evaluate<string>(
        `new URLSearchParams(location.search).get('session')`,
      )
      await tab.waitFor(`!${q('#code-remote-head')}.hidden`)
      expect(
        await tab.evaluate<unknown>(`({
          on: ${q('#code-remote-on')}.checked,
          badge: ${q(`${rowFor(local)} .fx-code-badge`)}?.textContent,
          link: ${q('#code-link')}.hidden,
        })`),
      ).toEqual({ on: true, badge: 'Remote', link: true })

      // The runner says the link is up, then retrying.
      await tab.evaluate(`window.__fake.emit({ type: 'link', state: 'up' })`)
      await tab.waitFor(`${q('#code-link')}.textContent === '已同步'`)
      await tab.evaluate(
        `window.__fake.emit({ type: 'link', state: 'retrying', reason: '连不上中枢' })`,
      )
      await tab.waitFor(
        `${q('#code-link')}.textContent === '正在重连 · 连不上中枢'`,
      )

      // The switch off: `qmo_local_set_remote`, the badge gone.
      await tab.evaluate(`${q('#code-remote-on')}.click()`)
      await tab.waitFor(
        `window.__calls.some(c => c[0] === 'qmo_local_set_remote' && c[1].on === false)`,
      )
      await tab.waitFor(`${q(`${rowFor(local)} .fx-code-badge`)} === null`)
      expect(await tab.evaluate<boolean>(`${q('#code-link')}.hidden`)).toBe(
        true,
      )

      // The other computer's copy, beside: what it is asked goes to the hub.
      await tab.evaluate(`${q(rowFor(KEY))}.click()`)
      await tab.waitFor(
        `[...document.querySelectorAll('#code-msgs .fx-bubble')].some(n => n.textContent === '在另一台上')`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          remote: ${q('#code-remote-head')}.hidden,
          group: [...document.querySelectorAll('.fx-rgroup-name')].map(n => n.textContent),
          reads: window.__calls.filter(c => c[0] === 'qmo_local_read' && c[1].session.indexOf('.') > 0).length,
        })`),
      ).toEqual({ remote: true, group: ['atlas', 'MacBook · atlas'], reads: 0 })
      expect(await tab.evaluate<unknown>('window.__badArgs')).toEqual([])
    } finally {
      await tab?.close()
      runner.socket.close()
      await h.stop()
    }
  }, 60_000)
})
