// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The desktop app's own Code page (P37.16, `qmo-local.md` §8), opened from
 * the offline page when the hub is out of reach: `atlas/apps/qmo/ui/code.html`
 * served as the shell serves its pages, with the console's `CODE_RENDER_JS`
 * as its `code-render.js` (what `build-app.ts` copies in), against the same
 * in-page shell and runner as the hub's Code suite (`./codeShell.ts`) plus
 * the shell's own `local_state` and `local_reconnect`.
 *
 * 1. **This computer's sessions.** The channel before the list; rows by
 *    folder; the session in the address, else the last one opened; records
 *    in the hub's classes; a session is carried on — a line drawn at once,
 *    the answer by `delta`, its record, 停止, an ask answered — and only the
 *    seven commands of a session that exists are ever called, every one in
 *    the shape the shell takes.
 * 2. **Order**: a record skipped is read again.
 * 3. **The mode**: shown first, 跳过权限确认 asks once more, a refusal goes back.
 * 4. **Back to the hub**: 重新连接 asks the shell with this session; still
 *    out, the line says why; the network coming back tries by itself, except
 *    while something is typed.
 * 5. **A build without `code-render.js`** says so.
 * 6. **Three languages and 375 px.**
 *
 * No app window, runner or agent is started. Skipped, with the reason
 * printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { CODE_RENDER_JS } from '../../src/assets/codeRender.js'
import { Browser, skipReason, type Tab } from './cdp.js'
import { FOLDER, type FakeShellOptions, fakeShell } from './codeShell.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[code offline browser tests] skipped: ${SKIP}`)

const UI = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'qmo', 'ui')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/** The shell's own pages, as `tauri://localhost` serves them, and `code-render.js` as the build writes it. */
function serve(withRender = true): { base: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/code-render.js') {
        return withRender
          ? new Response(CODE_RENDER_JS, {
              headers: { 'content-type': TYPES['.js']! },
            })
          : new Response('', { status: 404 })
      }
      const file = normalize(join(UI, path))
      if (!file.startsWith(UI) || !existsSync(file) || !TYPES[extname(file)]) {
        return new Response('', { status: 404 })
      }
      return new Response(readFileSync(file), {
        headers: { 'content-type': TYPES[extname(file)]! },
      })
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

/** What the shell's own commands answer: `local_state`, and `local_reconnect` refused with `problem` (`null`: it goes on for good, as when the window leaves for the hub). */
function localShell(lang: string): string {
  return `(function () {
  if (window.top !== window || !window.__TAURI__) return;
  var core = window.__TAURI__.core;
  var inner = core.invoke;
  window.__local = { problem: { kind: 'network', message: 'connect ECONNREFUSED' } };
  core.invoke = function (command, args) {
    if (command === 'local_state') {
      window.__calls.push([command, args === undefined ? null : args]);
      return Promise.resolve({ lang: ${JSON.stringify(lang)}, platform: 'macos', version: 'test', phase: 'offline',
        hub: 'https://hub.example.com', deviceName: 'Mac', problem: { kind: 'network', message: '' }, notice: null });
    }
    if (command === 'local_reconnect') {
      window.__calls.push([command, args === undefined ? null : JSON.parse(JSON.stringify(args))]);
      var problem = window.__local.problem;
      return problem ? Promise.reject(problem) : new Promise(function () {});
    }
    return inner(command, args);
  };
})();`
}

/** The commands this page may call: the seven of `shell::OFFLINE_COMMANDS` and the shell's own. */
const ALLOWED = new Set([
  'qmo_local_list',
  'qmo_local_watch',
  'qmo_local_read',
  'qmo_local_send',
  'qmo_local_stop',
  'qmo_local_answer',
  'qmo_local_set_mode',
  'local_state',
  'local_reconnect',
])

const q = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})`
/** Whether `selector` takes up room on the screen: the `hidden` property is not enough when a rule sets `display`. */
const shown = (selector: string) =>
  `(n => !!n && n.getClientRects().length > 0)(${q(selector)})`
const calls = (name: string) =>
  `window.__calls.filter(c => c[0] === ${JSON.stringify(name)})`
const fake = (tab: Tab, call: string) => tab.evaluate(`window.__fake.${call}`)

interface Opened {
  readonly tab: Tab
  /** Every http(s) request the page made, its own files aside. */
  readonly requests: string[]
}

async function open(
  browser: Browser,
  base: string,
  shell: FakeShellOptions = {},
  options: {
    readonly lang?: string
    readonly width?: number
    readonly path?: string
  } = {},
): Promise<Opened> {
  const tab = await browser.tab({ width: options.width ?? 1200, height: 800 })
  const requests: string[] = []
  browser.on(
    'Network.requestWillBeSent',
    params => {
      const url = String((params['request'] as { url?: string })?.url ?? '')
      if (/^https?:/.test(url) && !url.startsWith(base)) requests.push(url)
    },
    tab.sessionId,
  )
  await tab.send('Network.enable')
  await tab.send('Page.addScriptToEvaluateOnNewDocument', {
    source: fakeShell(shell),
  })
  await tab.send('Page.addScriptToEvaluateOnNewDocument', {
    source: localShell(options.lang ?? 'zh'),
  })
  await tab.goto(`${base}${options.path ?? '/code.html'}`)
  const close = tab.close.bind(tab)
  tab.close = async () => {
    const bad = await tab.evaluate<unknown>('window.__badArgs || []')
    const used = await tab.evaluate<string[]>(
      '(window.__calls || []).map(c => c[0])',
    )
    await close()
    expect(bad).toEqual([])
    expect(used.filter(c => !ALLOWED.has(c))).toEqual([])
  }
  return { tab, requests }
}

/** Sessions on this computer before the page opens: made through the fake runner, then the page loaded afresh. */
async function seed(
  tab: Tab,
  base: string,
  titles: readonly string[],
): Promise<string[]> {
  await tab.waitFor(`${calls('qmo_local_list')}.length === 1`)
  const ids: string[] = []
  for (const title of titles) {
    const answer = await tab.evaluate<{ session: { id: string } }>(
      `window.__TAURI__.core.invoke('qmo_local_start', { folder: ${JSON.stringify(FOLDER.id)}, agent: 'claude-code',
        mode: 'auto', worktree: false, text: ${JSON.stringify(title)}, clientId: 'seed' })`,
    )
    const id = answer.session.id
    await fake(
      tab,
      `write(${JSON.stringify(id)}, { text: 'Done: **${title}**' })`,
    )
    await fake(tab, `state(${JSON.stringify(id)}, 'idle')`)
    ids.push(id)
  }
  await tab.goto(`${base}/code.html`)
  await tab.waitFor(`${calls('qmo_local_list')}.length === 1`)
  return ids
}

async function type(tab: Tab, text: string): Promise<void> {
  await tab.evaluate(
    `(() => { const b = ${q('#text')}; b.focus(); b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event('input')); })()`,
  )
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await tab.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      ...(type === 'char' ? { text: '\r' } : {}),
    })
  }
}

describe.skipIf(SKIP !== null)('Code offline: the shell’s own page', () => {
  let browser: Browser
  let served: ReturnType<typeof serve>

  beforeAll(async () => {
    browser = await Browser.launch()
    served = serve()
  }, 30_000)

  afterAll(async () => {
    served?.stop()
    await browser?.close()
  }, 30_000)

  test('this computer’s sessions, carried on through the seven commands only, with no request anywhere', async () => {
    const { tab, requests } = await open(browser, served.base)
    try {
      const [first, second] = await seed(tab, served.base, [
        'fix the build',
        'add a flag',
      ])
      // The channel first, then the list; with nothing in the address and
      // nothing opened before, no session is open.
      const order = await tab.evaluate<string[]>(
        'window.__calls.map(c => c[0])',
      )
      expect(order.indexOf('qmo_local_watch')).toBeLessThan(
        order.indexOf('qmo_local_list'),
      )
      expect(
        await tab.evaluate<unknown>(`({
          groups: [...document.querySelectorAll('.code-group-name')].map(n => n.textContent),
          rows: [...document.querySelectorAll('.code-row')].map(r => [r.getAttribute('data-session'), r.querySelector('.code-row-title').textContent, r.querySelector('.code-row-agent').textContent]),
          empty: ${q('#empty')}.textContent,
          disabled: ${q('#text')}.disabled,
          dock: ${shown('#dock')},
          offline: ${q('#offline')}.textContent,
        })`),
      ).toEqual({
        groups: ['atlas'],
        rows: [
          [second, 'add a flag', 'Claude Code'],
          [first, 'fix the build', 'Claude Code'],
        ],
        empty: '选一个会话接着做 · 新会话要等连上中枢后在 Code 里开',
        disabled: true,
        dock: false,
        offline: '连不上中枢 · 这里只有这台电脑上的会话',
      })

      // Opening one reads it and draws its records in the hub's classes.
      await tab.evaluate(`${q(`[data-session="${first}"]`)}.click()`)
      await tab.waitFor(
        `document.querySelectorAll('#msgs .fx-msg').length === 2`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          url: location.search,
          title: ${q('#title')}.textContent,
          sub: ${q('#sub')}.textContent,
          user: ${q('#msgs .fx-msg-user .fx-bubble')}.textContent,
          bold: ${q('#msgs .fx-msg-agent .fx-text b')}.textContent,
          current: ${q('.code-row.is-current')}.getAttribute('data-session'),
          read: ${calls('qmo_local_read')}.map(c => c[1]),
          mode: ${q('#mode')}.value,
          seen: [${shown('#dock')}, ${shown('#go')}, ${shown('#stop')}, ${shown('#bypass')}],
        })`),
      ).toEqual({
        url: `?session=${first}`,
        title: 'fix the build',
        sub: 'atlas · Claude Code',
        user: 'fix the build',
        bold: 'fix the build',
        current: first,
        read: [{ session: first, limit: 200 }],
        mode: 'auto',
        seen: [true, true, false, false],
      })

      // A line: drawn at once, then the runner's record; the answer streams.
      await type(tab, 'and the tests')
      await tab.waitFor(`${calls('qmo_local_send')}.length === 1`)
      const sent = await tab.evaluate<{
        session: string
        text: string
        clientId: string
      }>(`${calls('qmo_local_send')}[0][1]`)
      expect(sent.session).toBe(first)
      expect(sent.text).toBe('and the tests')
      await tab.waitFor(`${shown('#stop')} && !${shown('#go')}`)
      await tab.waitFor(
        `document.querySelectorAll('#msgs .fx-msg-user').length === 2`,
      )
      await tab.waitFor(`${q('#msgs .fx-pending')} !== null`)
      const turn = 't_answer'
      await fake(tab, `live(${JSON.stringify(first)}, '${turn}', 'Running ')`)
      await fake(
        tab,
        `live(${JSON.stringify(first)}, '${turn}', '\`bun test\`')`,
      )
      await tab.waitFor(
        `${q('#msgs .fx-msg-agent.is-live code')}?.textContent === 'bun test'`,
      )
      expect(
        await tab.evaluate<boolean>(`${q('#msgs .fx-pending')} === null`),
      ).toBe(true)
      await fake(
        tab,
        `rewrite(${JSON.stringify(first)}, { id: '${turn}', sessionId: ${JSON.stringify(first)}, author: 'agent', at: Date.now(), text: 'Running \`bun test\`: all green', state: 'done' })`,
      )
      await tab.waitFor(
        `${q('#msgs .fx-msg-agent.is-live')} === null && [...document.querySelectorAll('#msgs .fx-msg-agent .fx-text')].some(n => n.textContent.endsWith('all green'))`,
      )

      // An ask takes the focus; Enter approves nothing; 允许一次 answers.
      await fake(
        tab,
        `write(${JSON.stringify(first)}, { variant: 'notice', text: 'Run bun test', ask: { id: 'ask-1', title: 'Run bun test', tool: 'Bash', input: 'bun test' } })`,
      )
      await tab.waitFor(
        `document.activeElement?.classList.contains('fx-perm-once')`,
      )
      expect(await tab.evaluate<boolean>(shown('.fx-perm-note'))).toBe(false)
      await tab.evaluate(`${q('.fx-perm [data-action="code-deny"]')}.click()`)
      expect(await tab.evaluate<boolean>(shown('.fx-perm-note'))).toBe(true)
      await tab.evaluate(`${q('.fx-perm [data-action="code-deny"]')}.click()`)
      await tab.evaluate(`${q('.fx-perm-once')}.focus()`)
      await tab.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      await tab.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      expect(
        await tab.evaluate<number>(`${calls('qmo_local_answer')}.length`),
      ).toBe(0)
      await tab.evaluate(`${q('.fx-perm-once')}.click()`)
      await tab.waitFor(`${calls('qmo_local_answer')}.length === 1`)
      expect(
        await tab.evaluate<unknown>(`${calls('qmo_local_answer')}[0][1]`),
      ).toEqual({
        session: first,
        ask: 'ask-1',
        decision: 'once',
      })
      await tab.waitFor(
        `${q('.fx-perm')} === null && ${q('.fx-steps')} !== null`,
      )

      // 停止 stops the turn.
      await tab.evaluate(`${q('#stop')}.click()`)
      await tab.waitFor(
        `${calls('qmo_local_stop')}.length === 1 && ${shown('#go')} && !${shown('#stop')}`,
      )
      await tab.waitFor(
        `${q('.code-row.is-current .code-dot')}.classList.contains('is-interrupted')`,
      )

      // Back to the list and to the other one; reloaded, the last one opens.
      await tab.evaluate(`${q(`[data-session="${second}"]`)}.click()`)
      await tab.waitFor(`${q('#title')}.textContent === 'add a flag'`)
      await tab.goto(`${served.base}/code.html`)
      await tab.waitFor(`${q('#title')}.textContent === 'add a flag'`)
      expect(requests).toEqual([])
    } finally {
      await tab.close()
    }
  }, 60_000)

  test('a record skipped is read again, one seen twice is drawn once', async () => {
    const { tab } = await open(browser, served.base)
    try {
      const [id] = await seed(tab, served.base, ['order'])
      await tab.goto(`${served.base}/code.html?session=${id}`)
      await tab.waitFor(
        `document.querySelectorAll('#msgs .fx-msg').length === 2`,
      )
      const reads = await tab.evaluate<number>(
        `${calls('qmo_local_read')}.length`,
      )
      await fake(tab, `skip(${JSON.stringify(id)}, { text: 'skipped' })`)
      await fake(tab, `write(${JSON.stringify(id)}, { text: 'after' })`)
      await tab.waitFor(`${calls('qmo_local_read')}.length === ${reads + 1}`)
      await tab.waitFor(
        `document.querySelectorAll('#msgs .fx-msg-agent').length === 3`,
      )
      const last = await tab.evaluate<{ seq: number; record: unknown }>(
        `JSON.parse(sessionStorage.getItem('__qmoFakeRunner')).sessions[${JSON.stringify(id)}].records.slice(-1)[0]`,
      )
      await fake(
        tab,
        `emit({ type: 'record', session: ${JSON.stringify(id)}, seq: ${last.seq}, record: ${JSON.stringify(last)} })`,
      )
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(
        await tab.evaluate<string[]>(
          `[...document.querySelectorAll('#msgs .fx-msg-agent .fx-text')].map(n => n.textContent)`,
        ),
      ).toEqual(['Done: order', 'skipped', 'after'])
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('the mode shows at once, 跳过权限确认 asks once more, a refusal goes back and says why', async () => {
    const { tab } = await open(browser, served.base, {
      refuseMode: 'off',
      modeNextTurn: true,
    })
    try {
      const [id] = await seed(tab, served.base, ['modes'])
      await tab.goto(`${served.base}/code.html?session=${id}`)
      await tab.waitFor(`${q('#mode')}.disabled === false`)
      const pick = (mode: string) =>
        tab.evaluate(
          `(() => { const s = ${q('#mode')}; s.value = '${mode}'; s.dispatchEvent(new Event('change')); })()`,
        )
      await pick('accept-edits')
      await tab.waitFor(`${q('#say')}.textContent === '下一轮生效'`)
      expect(
        await tab.evaluate<unknown>(
          `${calls('qmo_local_set_mode')}.map(c => c[1])`,
        ),
      ).toEqual([{ session: id, mode: 'accept-edits' }])
      expect(await tab.evaluate<boolean>(shown('#bypass'))).toBe(false)
      await pick('full-access')
      expect(await tab.evaluate<boolean>(shown('#bypass'))).toBe(true)
      expect(
        await tab.evaluate<number>(`${calls('qmo_local_set_mode')}.length`),
      ).toBe(1)
      await tab.evaluate(`${q('#bypass-no')}.click()`)
      expect(await tab.evaluate<string>(`${q('#mode')}.value`)).toBe(
        'accept-edits',
      )
      await pick('full-access')
      await tab.evaluate(`${q('#bypass-ok')}.click()`)
      await tab.waitFor(`${calls('qmo_local_set_mode')}.length === 2`)
      await pick('off')
      await tab.waitFor(`${q('#say')}.textContent.includes('E_ARGS')`)
      expect(await tab.evaluate<string>(`${q('#mode')}.value`)).toBe(
        'full-access',
      )
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('重新连接 asks the shell on this session; still out, the line says why; the network back tries by itself unless something is typed', async () => {
    const { tab } = await open(browser, served.base)
    try {
      const [id] = await seed(tab, served.base, ['reconnect'])
      await tab.goto(`${served.base}/code.html?session=${id}`)
      await tab.waitFor(`${q('#title')}.textContent === 'reconnect'`)
      await tab.evaluate(`${q('#reconnect')}.click()`)
      await tab.waitFor(
        `${calls('local_reconnect')}.length === 1 && ${q('#reconnect')}.disabled === false`,
      )
      expect(
        await tab.evaluate<unknown>(`${calls('local_reconnect')}[0][1]`),
      ).toEqual({ session: id })
      expect(await tab.evaluate<string>(`${q('#offline')}.textContent`)).toBe(
        '连不上中枢 · 这里只有这台电脑上的会话',
      )
      await tab.evaluate(
        `window.__local.problem = { kind: 'owner_inactive', message: 'inactive' }`,
      )
      await tab.evaluate(`${q('#reconnect')}.click()`)
      await tab.waitFor(`${q('#offline')}.textContent === '账号暂时不能用'`)
      // Words in the box: the network coming back does not take the page away.
      await tab.evaluate(
        `(() => { const b = ${q('#text')}; b.value = 'half a thought'; b.dispatchEvent(new Event('input')); })()`,
      )
      await tab.evaluate(`window.dispatchEvent(new Event('online'))`)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(
        await tab.evaluate<number>(`${calls('local_reconnect')}.length`),
      ).toBe(2)
      await tab.evaluate(
        `(() => { const b = ${q('#text')}; b.value = ''; b.dispatchEvent(new Event('input')); })()`,
      )
      await tab.evaluate(`window.__local.problem = null`)
      await tab.evaluate(`window.dispatchEvent(new Event('online'))`)
      await tab.waitFor(`${calls('local_reconnect')}.length === 3`)
      // Under way: the button waits, a second try does not go.
      expect(
        await tab.evaluate<unknown>(
          `({ disabled: ${q('#reconnect')}.disabled, line: ${q('#offline')}.textContent })`,
        ),
      ).toEqual({
        disabled: true,
        line: '正在重新连接…',
      })
      await tab.evaluate(`window.dispatchEvent(new Event('online'))`)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(
        await tab.evaluate<number>(`${calls('local_reconnect')}.length`),
      ).toBe(3)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('a line that did not go keeps the page from leaving by itself; another entry under way is not 尝试太多', async () => {
    const { tab } = await open(browser, served.base, { sendRefusals: 1 })
    try {
      const [id] = await seed(tab, served.base, ['unsent'])
      await tab.goto(`${served.base}/code.html?session=${id}`)
      await tab.waitFor(`${q('#title')}.textContent === 'unsent'`)
      await type(tab, '这一句没发出去')
      await tab.waitFor(`!!${q('#msgs .fx-msg-user.is-failed')}`)
      // The network back: the 未送达 line lives in this page only, so no
      // reconnect by itself.
      await tab.evaluate(`window.dispatchEvent(new Event('online'))`)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(
        await tab.evaluate<number>(`${calls('local_reconnect')}.length`),
      ).toBe(0)
      // By hand it goes; the shell says another entry is under way.
      await tab.evaluate(
        `window.__local.problem = { kind: 'busy', message: 'an entry is under way' }`,
      )
      await tab.evaluate(`${q('#reconnect')}.click()`)
      await tab.waitFor(`${calls('local_reconnect')}.length === 1`)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(await tab.evaluate<string>(`${q('#offline')}.textContent`)).toBe(
        '正在重新连接…',
      )
      await tab.waitFor(`${q('#reconnect')}.disabled === false`, 4_000)
      expect(await tab.evaluate<string>(`${q('#offline')}.textContent`)).toBe(
        '连不上中枢 · 这里只有这台电脑上的会话',
      )
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('a build without code-render.js says so and asks nothing of the runner', async () => {
    const bare = serve(false)
    const { tab } = await open(browser, bare.base)
    try {
      await tab.waitFor(`${q('#empty')}.textContent !== ''`)
      expect(
        await tab.evaluate<unknown>(`({
        line: ${q('#empty')}.textContent,
        box: ${q('#text')}.disabled,
        calls: window.__calls.map(c => c[0]),
      })`),
      ).toEqual({
        line: '这个版本缺少本机会话的页面脚本，重新安装阡陌后再试',
        box: true,
        calls: ['local_state'],
      })
    } finally {
      await tab.close()
      bare.stop()
    }
  }, 30_000)

  test('three languages, and 375 px with nothing off the side', async () => {
    for (const [lang, title, offline] of [
      [
        'en',
        'Local sessions',
        'Can’t reach the hub · only this computer’s sessions here',
      ],
      [
        'ja',
        'ローカルセッション',
        'ハブに接続できません · このコンピュータのセッションのみ表示しています',
      ],
    ] as const) {
      const { tab } = await open(browser, served.base, {}, { lang })
      try {
        await tab.waitFor(
          `${calls('qmo_local_list')}.length === 1 && ${q('.code-none')} !== null`,
        )
        expect(
          await tab.evaluate<unknown>(`({
          lang: document.documentElement.lang,
          title: document.title,
          offline: ${q('#offline')}.textContent,
          modes: [...${q('#mode')}.options].map(o => o.textContent).length,
          none: ${q('.code-none')}.textContent.length > 0,
        })`),
        ).toEqual({ lang, title, offline, modes: 4, none: true })
      } finally {
        await tab.close()
      }
    }
    const { tab } = await open(browser, served.base, {}, { width: 375 })
    try {
      const [id] = await seed(tab, served.base, ['narrow'])
      await tab.goto(`${served.base}/code.html?session=${id}`)
      await tab.waitFor(
        `document.querySelectorAll('#msgs .fx-msg').length === 2`,
      )
      expect(
        await tab.evaluate<unknown>(`({
        wide: document.documentElement.scrollWidth <= 375,
        box: ${q('#box')}.getBoundingClientRect().bottom <= innerHeight,
        reconnect: ${q('#reconnect')}.getBoundingClientRect().right <= 375,
      })`),
      ).toEqual({ wide: true, box: true, reconnect: true })
    } finally {
      await tab.close()
    }
  }, 60_000)
})
