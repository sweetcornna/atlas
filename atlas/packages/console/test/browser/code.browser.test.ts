// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code's local sessions in a real browser (P37.14a, `qmo-local.md` §4.5),
 * against a shell and a runner that live only in the page
 * (`./codeShell.ts`):
 *
 * 1. **A session end to end.** The line is drawn before the runner answers;
 *    the answer streams in by `delta`; a tool line runs and finishes with its
 *    counts and diff, and the changes panel is read again within a second;
 *    an ask takes the focus, Enter approves nothing, 允许一次 and a 拒绝 with a
 *    note go to the runner; the changes panel lists the files and shows a
 *    diff — and through all of it the page sends not one request over the
 *    network. After a reload the session is there and reads back the same.
 * 2. **Order.** A record skipped is read again; one seen twice is not drawn
 *    twice; a `delta` out of place waits for its record.
 * 3. **The runner** going down and coming back.
 * 4. **Stop and the queue**, **the permission mode** (跳过权限确认 asks once
 *    more, a refusal goes back and says why, 下一轮生效), **a send or a start
 *    that fails**, **picking a folder**.
 * 5. **Other homes**: an app older than local sessions, an app whose runner
 *    refuses, a browser.
 * 6. **Three languages, light and dark contrast, 375 px.**
 *
 * No app window, runner or agent is started. Skipped, with the reason
 * printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../../src/http.js'
import { ADMIN, TOKENS, pageHarness } from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'
import { FOLDER, type FakeShellOptions, fakeShell } from './codeShell.js'
import { type Probe, probe } from './contrastProbe.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[code browser tests] skipped: ${SKIP}`)

function serve(): { base: string; stop(): void } {
  const harness = pageHarness({ chat: true })
  const handle = createConsoleHandler(harness.deps, TOKENS)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      if (new URL(request.url).pathname === '/v0/events') {
        return new Response(null, { status: 503 })
      }
      return handle(request)
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  " import { serve } from './serve'",
  '-const port = 3000',
  '+const port = Number(process.env.PORT ?? 3000)',
  ' serve({ port })',
].join('\n')

const CHANGES = {
  source: 'git',
  truncated: false,
  files: [
    { path: 'src/app.ts', status: 'M', added: 1, removed: 1, binary: false },
    { path: 'README.md', status: '?', added: 4, removed: 0, binary: false },
  ],
}

const WITH_CHANGES: FakeShellOptions = {
  changes: CHANGES,
  diffs: { 'src/app.ts': DIFF },
}

interface Opened {
  readonly tab: Tab
  /** Every http(s) request the page made since `count()` was last called. */
  readonly requests: string[]
  count(): void
}

const q = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})`

const calls = (name: string) =>
  `window.__calls.filter(c => c[0] === ${JSON.stringify(name)})`

/** `/code` signed in, inside the fake app when `shell` is given. */
async function open(
  browser: Browser,
  base: string,
  shell: FakeShellOptions | null,
  options: {
    readonly lang?: string
    readonly scheme?: 'light' | 'dark'
    readonly width?: number
    readonly height?: number
    readonly changes?: boolean
  } = {},
): Promise<Opened> {
  const tab = await browser.tab({
    width: options.width ?? 1280,
    height: options.height ?? 860,
  })
  const requests: string[] = []
  let counting = false
  browser.on(
    'Network.requestWillBeSent',
    params => {
      const url = String((params['request'] as { url?: string })?.url ?? '')
      if (counting && /^https?:/.test(url)) requests.push(url)
    },
    tab.sessionId,
  )
  await tab.send('Network.enable')
  await tab.send('Network.clearBrowserCookies')
  if (options.lang !== undefined) {
    await tab.send('Network.setCookie', {
      name: 'qianmo_lang',
      value: options.lang,
      url: base,
    })
  }
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
  // Fetches still in flight, so a test can wait for the token's exchange.
  await tab.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__inflight = 0; const f = window.fetch; window.fetch = function () {
      window.__inflight += 1;
      return f.apply(this, arguments).finally(() => { window.__inflight -= 1; });
    };`,
  })
  await tab.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: options.scheme ?? 'light' },
    ],
  })
  await tab.goto(`${base}/code?token=${ADMIN}`)
  await tab.waitFor('window.qianmoConsole !== undefined')
  if (shell !== null && shell.listRefusal === undefined) {
    await tab.waitFor(
      `${calls('qmo_local_list')}.length === 1 && ${calls('qmo_local_agents')}.length === 1 && ` +
        `(${typeof shell.agents === 'string'} || document.querySelectorAll('#code-agent option').length === 3)`,
    )
    // The panel's choice is kept in the browser; each test starts from its own.
    const want = options.changes ?? true
    await tab.evaluate(`(() => {
      const on = ${q('#code-local')}.getAttribute('data-changes') === 'open';
      if (on !== ${want}) ${q('#code-changes-btn')}.click();
    })()`)
  }
  // The token's exchange for a session cookie is behind us.
  await tab.waitFor('window.__inflight === 0')
  return {
    tab,
    requests,
    count: () => {
      requests.length = 0
      counting = true
    },
  }
}

async function key(
  tab: Tab,
  name: string,
  code: string,
  keyCode: number,
  modifiers = 0,
): Promise<void> {
  await tab.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: name,
    code,
    windowsVirtualKeyCode: keyCode,
    modifiers,
  })
  if (name === 'Enter') {
    await tab.send('Input.dispatchKeyEvent', {
      type: 'char',
      key: name,
      text: '\r',
      windowsVirtualKeyCode: keyCode,
      modifiers,
    })
  }
  await tab.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: name,
    code,
    windowsVirtualKeyCode: keyCode,
    modifiers,
  })
}

const enter = (tab: Tab) => key(tab, 'Enter', 'Enter', 13)

/** Types `text` into the box and presses Enter. */
async function say(tab: Tab, text: string): Promise<void> {
  await tab.evaluate(
    `(() => { const b = ${q('#code-text')}; b.focus(); b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event('input')); })()`,
  )
  await enter(tab)
}

/** Starts a session with `text` and waits until the page is on it. */
async function begin(tab: Tab, text: string): Promise<string> {
  await say(tab, text)
  await tab.waitFor(`/[?&]session=cs_/.test(location.search)`)
  const id = await tab.evaluate<string>(
    `new URLSearchParams(location.search).get('session')`,
  )
  await tab.waitFor(
    `document.querySelectorAll('#code-msgs .fx-msg-user:not(.is-sending)').length >= 1`,
  )
  return id
}

const fake = (tab: Tab, call: string) => tab.evaluate(`window.__fake.${call}`)

describe.skipIf(SKIP !== null)('Code: local sessions', () => {
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

  test('a session end to end, without one request to the hub; after a reload it is still there', async () => {
    const { tab, requests, count } = await open(browser, served.base, {
      ...WITH_CHANGES,
      delays: { qmo_local_start: 300 },
    })
    try {
      // The channel first, then the list.
      const order = await tab.evaluate<string[]>(
        'window.__calls.map(c => c[0])',
      )
      expect(order.indexOf('qmo_local_watch')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('qmo_local_watch')).toBeLessThan(
        order.indexOf('qmo_local_list'),
      )
      expect(
        await tab.evaluate<unknown>(`({
          agents: [...${q('#code-agent')}.options].map(o => [o.value, o.disabled, o.textContent]),
          agent: ${q('#code-agent')}.value,
          folder: ${q('#code-folder')}.value,
          folders: [...${q('#code-folder')}.options].filter(o => !o.hidden).map(o => o.textContent),
          mode: ${q('#code-mode')}.value,
          remote: [${q('#code-remote')}.disabled, ${q('#code-remote')}.checked],
          view: ${q('#code-local')}.getAttribute('data-view'),
          web: ${q('#code-web')}.hidden,
        })`),
      ).toEqual({
        agents: [
          ['claude-code', false, 'Claude Code · 2.1.310'],
          ['codex', true, 'Codex · 0.164.0 · 后续版本支持'],
          ['gemini', true, 'Gemini CLI · 0.9.0 · 版本太旧'],
        ],
        agent: 'claude-code',
        folder: FOLDER.id,
        folders: ['atlas', '选择文件夹…'],
        mode: 'auto',
        remote: [true, false],
        view: 'blank',
        web: true,
      })
      count()

      // Sent: the line is on the page before the runner answers.
      await say(tab, '把端口改成读环境变量')
      expect(
        await tab.evaluate<unknown>(`({
          sending: document.querySelectorAll('#code-msgs .fx-msg-user.is-sending').length,
          search: location.search,
          box: ${q('#code-text')}.value,
        })`),
      ).toEqual({ sending: 1, search: '', box: '' })
      const start = await tab.evaluate<Record<string, unknown>>(
        `${calls('qmo_local_start')}[0][1]`,
      )
      expect<Record<string, unknown>>({ ...start, clientId: '' }).toEqual({
        folder: FOLDER.id,
        agent: 'claude-code',
        mode: 'auto',
        worktree: false,
        text: '把端口改成读环境变量',
        clientId: '',
        remote: false,
      })
      expect(String(start['clientId'])).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      await tab.waitFor(`/[?&]session=cs_/.test(location.search)`)
      const id = await tab.evaluate<string>(
        `new URLSearchParams(location.search).get('session')`,
      )
      await tab.waitFor(
        `document.querySelectorAll('#code-msgs .fx-msg-user').length === 1 && !${q('#code-msgs .fx-msg-user')}.classList.contains('is-sending')`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          row: ${q('#code-sessions .fx-ritem-row.is-current .fx-ritem-title')}.textContent,
          group: ${q('#code-sessions .fx-rgroup-name')}.textContent,
          dot: ${q('#code-sessions .fx-code-dot')}.getAttribute('aria-label'),
          title: ${q('#code-title')}.textContent,
          sub: ${q('#code-sub')}.textContent,
          go: ${q('#code-go')}.hidden,
          stop: ${q('#code-stop')}.hidden,
          pending: ${q('#code-msgs .fx-pending .fx-typing-word')}.textContent,
          view: ${q('#code-local')}.getAttribute('data-view'),
        })`),
      ).toEqual({
        row: '把端口改成读环境变量',
        group: 'atlas',
        dot: '运行中',
        title: '把端口改成读环境变量',
        sub: 'atlas · Claude Code',
        go: true,
        stop: false,
        pending: '思考中',
        view: 'session',
      })

      // What the agent is doing, then its words as they come.
      await fake(
        tab,
        `emit({ type: 'activity', session: '${id}', kind: 'tool', words: '读 src/app.ts' })`,
      )
      await tab.waitFor(
        `${q('#code-msgs .fx-pending .fx-typing-word')}.textContent === '读 src/app.ts'`,
      )
      await fake(tab, `live('${id}', 't_answer', '先看 \`src/app.ts\`')`)
      await fake(tab, `live('${id}', 't_answer', '，端口写死成 **3000**。')`)
      await tab.waitFor(
        `(${q('#code-msgs .fx-msg-agent.is-live .fx-text')} || {}).textContent === '先看 src/app.ts，端口写死成 3000。'`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          code: ${q('.is-live .fx-text code.mono')}.textContent,
          bold: ${q('.is-live .fx-text b')}.textContent,
          pending: document.querySelectorAll('#code-msgs .fx-pending').length,
        })`),
      ).toEqual({ code: 'src/app.ts', bold: '3000', pending: 0 })
      // A delta at an offset already drawn is not drawn again.
      await fake(
        tab,
        `emit({ type: 'delta', session: '${id}', turn: 't_answer', offset: 0, text: '重复' })`,
      )
      await Bun.sleep(100)
      expect(
        await tab.evaluate<string>(`${q('.is-live .fx-text')}.textContent`),
      ).toBe('先看 src/app.ts，端口写死成 3000。')

      // A tool line runs, then finishes with its counts and its diff; the
      // changes panel reads again within a second.
      await fake(
        tab,
        `write('${id}', { id: 't_tool', variant: 'notice', noticeSource: 'step', severity: 'info', text: '编辑 src/app.ts', tool: { id: 'u1', name: 'Edit', status: 'running', paths: ['src/app.ts'], detailKind: 'diff' } })`,
      )
      await tab.waitFor(
        `${q('#code-msgs .fx-steps.is-running .fx-steps-label')}?.textContent === '进行中 · 1 步' && ${q('#code-msgs .fx-step .fx-spin')} !== null`,
      )
      const before = await tab.evaluate<number>(
        `${calls('qmo_local_changes')}.length`,
      )
      const finished = Date.now()
      await fake(
        tab,
        `rewrite('${id}', { id: 't_tool', sessionId: '${id}', author: 'agent', at: Date.now(), state: 'done', variant: 'notice', noticeSource: 'step', severity: 'info', text: '编辑 src/app.ts', detail: ${JSON.stringify(DIFF.split('\n').slice(3).join('\n'))}, tool: { id: 'u1', name: 'Edit', status: 'done', paths: ['src/app.ts'], detailKind: 'diff', added: 1, removed: 1 } })`,
      )
      await tab.waitFor(
        `${calls('qmo_local_changes')}.length > ${before}`,
        1_000,
      )
      expect(Date.now() - finished).toBeLessThan(1_000)
      expect(
        await tab.evaluate<unknown>(`(() => {
          const steps = ${q('#code-msgs .fx-steps')};
          steps.open = true;
          const detail = steps.querySelector('.fx-step-detail');
          detail.open = true;
          return {
            steps: document.querySelectorAll('#code-msgs .fx-step').length,
            spin: steps.querySelectorAll('.fx-spin').length,
            stat: steps.querySelector('.fx-stat').textContent,
            add: [...detail.querySelectorAll('.fx-diff-add')].map(s => s.textContent),
            del: [...detail.querySelectorAll('.fx-diff-del')].map(s => s.textContent),
            hunk: [...detail.querySelectorAll('.fx-diff-hunk')].map(s => s.textContent),
          };
        })()`),
      ).toEqual({
        steps: 1,
        spin: 0,
        stat: '+1\u22121',
        add: ['+const port = Number(process.env.PORT ?? 3000)'],
        del: ['-const port = 3000'],
        hunk: ['@@ -1,3 +1,3 @@'],
      })

      // An ask: the card takes the focus; Enter approves nothing.
      await fake(
        tab,
        `write('${id}', { variant: 'notice', noticeSource: 'step', severity: 'warn', text: '运行 bun test', ask: { id: 'ask-1', tool: 'Bash', title: '运行 bun test', paths: ['/Users/me/project/atlas'], input: 'bun test', options: ['once', 'session', 'deny'] } })`,
      )
      await fake(tab, `state('${id}', 'waiting')`)
      await tab.waitFor(
        `document.activeElement && document.activeElement.classList.contains('fx-perm-once')`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          buttons: [...document.querySelectorAll('.fx-perm .fx-perm-acts button')].map(b => b.textContent),
          title: ${q('.fx-perm-title')}.textContent,
          paths: ${q('.fx-perm-paths')}.textContent,
          dot: ${q('#code-sessions .fx-code-dot')}.getAttribute('aria-label'),
        })`),
      ).toEqual({
        buttons: ['允许一次', '本会话都允许', '拒绝'],
        title: '运行 bun test',
        paths: '/Users/me/project/atlas',
        dot: '等你确认',
      })
      await enter(tab)
      await Bun.sleep(100)
      expect(
        await tab.evaluate<number>(`${calls('qmo_local_answer')}.length`),
      ).toBe(0)
      await tab.evaluate(`${q('.fx-perm-once')}.click()`)
      await tab.waitFor(
        `${calls('qmo_local_answer')}.length === 1 && ${q('.fx-perm')} === null`,
      )
      expect(
        await tab.evaluate<unknown>(`${calls('qmo_local_answer')}[0][1]`),
      ).toEqual({ session: id, ask: 'ask-1', decision: 'once' })
      expect(
        await tab.evaluate<string>(
          `[...document.querySelectorAll('#code-msgs .fx-step-text')].map(s => s.textContent).join('|')`,
        ),
      ).toBe('编辑 src/app.ts|运行 bun test · 已允许')

      // Another, denied with a note: Enter in the note sends the denial.
      await fake(
        tab,
        `write('${id}', { variant: 'notice', noticeSource: 'step', severity: 'warn', text: '运行 rm -rf dist', ask: { id: 'ask-2', tool: 'Bash', title: '运行 rm -rf dist', options: ['once', 'deny'] } })`,
      )
      await tab.waitFor(`${q('.fx-perm')} !== null`)
      expect(
        await tab.evaluate<string[]>(
          `[...document.querySelectorAll('.fx-perm .fx-perm-acts button')].map(b => b.textContent)`,
        ),
      ).toEqual(['允许一次', '拒绝'])
      await tab.evaluate(`${q('.fx-perm [data-action="code-deny"]')}.click()`)
      await tab.waitFor(
        `!${q('.fx-perm-note')}.hidden && document.activeElement === ${q('.fx-perm-note input')}`,
      )
      await tab.evaluate(`${q('.fx-perm-note input')}.value = '先别删'`)
      await enter(tab)
      await tab.waitFor(`${calls('qmo_local_answer')}.length === 2`)
      expect(
        await tab.evaluate<unknown>(`${calls('qmo_local_answer')}[1][1]`),
      ).toEqual({
        session: id,
        ask: 'ask-2',
        decision: 'deny',
        message: '先别删',
      })
      await tab.waitFor(`${q('.fx-perm')} === null`)

      // The answer lands as a record and replaces the live one; the turn ends.
      await fake(
        tab,
        `write('${id}', { id: 't_answer', text: '改好了：\\n\\n- 端口读 \`PORT\`' })`,
      )
      await fake(tab, `state('${id}', 'idle')`)
      await tab.waitFor(
        `${q('.is-live')} === null && ${q('#code-msgs .fx-pending')} === null && !${q('#code-go')}.hidden`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          agent: [...document.querySelectorAll('#code-msgs .fx-msg-agent .fx-text')].map(t => t.textContent),
          stop: ${q('#code-stop')}.hidden,
          dot: ${q('#code-sessions .fx-code-dot')}.getAttribute('aria-label'),
        })`),
      ).toEqual({ agent: ['改好了：端口读 PORT'], stop: true, dot: '完成' })

      // The changes panel: the files, and a diff opened.
      await tab.waitFor(
        `document.querySelectorAll('#code-files .fx-code-file').length === 2`,
      )
      await tab.evaluate(`${q('#code-files .fx-code-frow')}.click()`)
      await tab.waitFor(`${q('#code-files .fx-diff .fx-diff-add')} !== null`)
      expect(
        await tab.evaluate<unknown>(`({
          files: [...document.querySelectorAll('#code-files .fx-code-frow')].map(r => r.textContent),
          count: ${q('#code-count')}.textContent,
          diff: ${calls('qmo_local_diff')}[0][1],
          lines: ${q('#code-files .fx-diff')}.children.length,
        })`),
      ).toEqual({
        files: ['Msrc/app.ts+1\u22121', '?README.md+4\u22120'],
        count: '2',
        diff: { session: id, path: 'src/app.ts' },
        lines: DIFF.split('\n').length,
      })

      // Not one request to the hub through all of it.
      expect(requests).toEqual([])

      // A reload: the session is there, read back the same.
      const shown = await tab.evaluate<string>(`${q('#code-msgs')}.textContent`)
      const loaded = tab.next('Page.loadEventFired')
      await tab.send('Page.reload')
      await loaded
      await tab.waitFor(
        `window.__calls && ${calls('qmo_local_read')}.length === 1 && document.querySelectorAll('#code-msgs .fx-msg').length >= 2`,
      )
      count()
      expect(
        await tab.evaluate<unknown>(`({
          search: location.search,
          row: ${q('#code-sessions .fx-ritem-row.is-current .fx-ritem-title')}.textContent,
          text: ${q('#code-msgs')}.textContent,
          view: ${q('#code-local')}.getAttribute('data-view'),
        })`),
      ).toEqual({
        search: `?session=${id}`,
        row: '把端口改成读环境变量',
        text: shown,
        view: 'session',
      })
      // And it goes on: another line, sent and drawn.
      await say(tab, '再跑一次测试')
      await tab.waitFor(
        `${calls('qmo_local_send')}.length === 1 && document.querySelectorAll('#code-msgs .fx-msg-user').length === 2`,
      )
      expect(
        await tab.evaluate<unknown>(
          `(() => { const c = ${calls('qmo_local_send')}[0][1]; return [c.session, c.text]; })()`,
        ),
      ).toEqual([id, '再跑一次测试'])
      expect(requests).toEqual([])
    } finally {
      await tab.close()
    }
  }, 60_000)

  test('a record skipped is read again, one seen twice is not drawn twice, a delta out of place waits for its record', async () => {
    const { tab } = await open(browser, served.base, {})
    try {
      const id = await begin(tab, '看一下')
      await fake(tab, `state('${id}', 'idle')`)
      await tab.waitFor(`${q('#code-msgs .fx-pending')} === null`)
      const reads = await tab.evaluate<number>(
        `${calls('qmo_local_read')}.length`,
      )
      // seq 2 never reaches the page; seq 3 does.
      await fake(tab, `skip('${id}', { text: '跳过的这条' })`)
      await fake(tab, `write('${id}', { text: '紧接着这条' })`)
      await tab.waitFor(
        `${calls('qmo_local_read')}.length === ${reads + 1} && ${q('#code-msgs')}.textContent.includes('跳过的这条') && ${q('#code-msgs')}.textContent.includes('紧接着这条')`,
      )
      // An old seq again: dropped, nothing on the page moves.
      await tab.evaluate(`(() => {
        window.__moved = 0;
        new MutationObserver(r => { window.__moved += r.length; }).observe(${q('#code-msgs')}, { childList: true, subtree: true, characterData: true });
      })()`)
      await fake(
        tab,
        `emit({ type: 'record', session: '${id}', seq: 2, record: { seq: 2, kind: 'turn', turn: { id: 't_dup', sessionId: '${id}', author: 'agent', at: Date.now(), text: '不该出现', state: 'done' } } })`,
      )
      await Bun.sleep(100)
      expect(
        await tab.evaluate<unknown>(
          `({ moved: window.__moved, text: ${q('#code-msgs')}.textContent.includes('不该出现') })`,
        ),
      ).toEqual({ moved: 0, text: false })
      // A delta that starts mid-answer is not drawn; the record is.
      await fake(
        tab,
        `emit({ type: 'delta', session: '${id}', turn: 't_mid', offset: 5, text: '半截' })`,
      )
      await Bun.sleep(100)
      expect(await tab.evaluate<unknown>(`${q('.is-live')}`)).toBeNull()
      await fake(tab, `write('${id}', { id: 't_mid', text: '整条回答' })`)
      await tab.waitFor(`${q('#code-msgs')}.textContent.includes('整条回答')`)
      expect(
        await tab.evaluate<boolean>(
          `${q('#code-msgs')}.textContent.includes('半截')`,
        ),
      ).toBe(false)
      // A record too large for the channel is read when it is announced.
      const again = await tab.evaluate<number>(
        `${calls('qmo_local_read')}.length`,
      )
      const big = await tab.evaluate<string>(
        `window.__fake.write('${id}', { text: '很长的一条' }, true).id`,
      )
      expect(big).toMatch(/^t_/)
      const seq = await tab.evaluate<number>(
        `JSON.parse(sessionStorage.getItem('__qmoFakeRunner')).sessions['${id}'].seq`,
      )
      await fake(
        tab,
        `emit({ type: 'record', session: '${id}', seq: ${seq}, trimmed: true })`,
      )
      await tab.waitFor(
        `${calls('qmo_local_read')}.length === ${again + 1} && ${q('#code-msgs')}.textContent.includes('很长的一条')`,
      )
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('the runner going down says so, and coming back reads the list again', async () => {
    const { tab } = await open(browser, served.base, {})
    try {
      // Every start says up, the first one too: that alone reads nothing again.
      await fake(tab, `emit({ type: 'runner', state: 'up' })`)
      await Bun.sleep(100)
      expect(
        await tab.evaluate<number>(`${calls('qmo_local_list')}.length`),
      ).toBe(1)
      await fake(
        tab,
        `emit({ type: 'runner', state: 'down', reason: '退出码 1' })`,
      )
      await tab.waitFor(
        `${q('#code-say')}.textContent === '运行器已停止 · 正在重启 · 退出码 1'`,
      )
      expect(
        await tab.evaluate<string>(
          `${q('#code-say')}.getAttribute('data-tone')`,
        ),
      ).toBe('warn')
      await fake(tab, `emit({ type: 'runner', state: 'up' })`)
      await tab.waitFor(
        `${calls('qmo_local_list')}.length === 2 && ${q('#code-say')}.textContent === ''`,
      )
    } finally {
      await tab.close()
    }
    // A runner that was not there when the page came: up reads the list then.
    const late = await open(browser, served.base, {
      listRefusal: 'qmo local E_RUNNER: qmo code serve exited',
    })
    try {
      await late.tab.waitFor(
        `${q('#code-say')}.textContent === 'qmo local E_RUNNER: qmo code serve exited'`,
      )
      await fake(late.tab, `set('listRefusal', '')`)
      await fake(late.tab, `emit({ type: 'runner', state: 'up' })`)
      await late.tab.waitFor(
        `${calls('qmo_local_list')}.length === 2 && ${q('#code-say')}.textContent === '' && ${q('#code-agent')}.value === 'claude-code'`,
      )
    } finally {
      await late.tab.close()
    }
  }, 30_000)

  test('a line sent while the agent runs is queued; 停止 stops the turn', async () => {
    const { tab } = await open(browser, served.base, {})
    try {
      const id = await begin(tab, '先做第一件')
      expect(await tab.evaluate<boolean>(`${q('#code-stop')}.hidden`)).toBe(
        false,
      )
      await say(tab, '再做第二件')
      await tab.waitFor(
        `${q('#code-msgs .fx-msg-user.is-queued .fx-queued')}?.textContent === '排队中'`,
      )
      expect(
        await tab.evaluate<unknown>(`${calls('qmo_local_send')}[0][1].text`),
      ).toBe('再做第二件')
      await tab.evaluate(`${q('#code-stop')}.click()`)
      await tab.waitFor(
        `${calls('qmo_local_stop')}.length === 1 && !${q('#code-go')}.hidden`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          stop: ${calls('qmo_local_stop')}[0][1],
          hidden: ${q('#code-stop')}.hidden,
          dot: ${q('#code-sessions .fx-code-dot')}.getAttribute('aria-label'),
        })`),
      ).toEqual({ stop: { session: id }, hidden: true, dot: '已中断' })
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('an ask that comes while a line is being typed leaves the focus in the box', async () => {
    const { tab } = await open(browser, served.base, {})
    try {
      const id = await begin(tab, '先做第一件')
      await tab.evaluate(
        `(() => { const b = ${q('#code-text')}; b.focus(); b.value = '还有 '; })()`,
      )
      await fake(
        tab,
        `write('${id}', { variant: 'notice', noticeSource: 'step', severity: 'warn', text: '运行 ls', ask: { id: 'ask-2', tool: 'Bash', title: '运行 ls', options: ['once', 'deny'] } })`,
      )
      await tab.waitFor(`${q('#code-msgs .fx-perm')} !== null`)
      await tab.evaluate(
        `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          focus: document.activeElement === ${q('#code-text')},
          value: ${q('#code-text')}.value,
          buttons: [...document.querySelectorAll('.fx-perm .fx-perm-acts button')].map(b => b.textContent),
        })`),
      ).toEqual({ focus: true, value: '还有 ', buttons: ['允许一次', '拒绝'] })
      expect(
        await tab.evaluate<number>(`${calls('qmo_local_answer')}.length`),
      ).toBe(0)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('跳过权限确认 asks once more; a mode shows at once, says when it applies, and goes back when refused', async () => {
    const { tab } = await open(browser, served.base, {
      refuseMode: 'accept-edits',
      delays: { qmo_local_set_mode: 200 },
    })
    try {
      const choose = (mode: string) =>
        tab.evaluate(
          `(() => { const s = ${q('#code-mode')}; s.value = '${mode}'; s.dispatchEvent(new Event('change')); })()`,
        )
      // A new session: the line under the box, and 取消 goes back.
      await choose('full-access')
      expect(
        await tab.evaluate<unknown>(`({
          row: ${q('#code-bypass')}.hidden,
          text: ${q('#code-bypass span')}.textContent,
          mode: ${q('#code-mode')}.value,
          focus: document.activeElement === ${q('[data-action="code-bypass-ok"]')},
        })`),
      ).toEqual({
        row: false,
        text: 'agent 将不经确认执行任何命令与改动',
        mode: 'full-access',
        focus: true,
      })
      await tab.evaluate(`${q('[data-action="code-bypass-no"]')}.click()`)
      expect(
        await tab.evaluate<unknown>(
          `[${q('#code-bypass')}.hidden, ${q('#code-mode')}.value]`,
        ),
      ).toEqual([true, 'auto'])
      // 确认: the session starts in it.
      await choose('full-access')
      await tab.evaluate(`${q('[data-action="code-bypass-ok"]')}.click()`)
      const id = await begin(tab, '清一下构建目录')
      expect(
        await tab.evaluate<string>(`${calls('qmo_local_start')}[0][1].mode`),
      ).toBe('full-access')
      expect(await tab.evaluate<string>(`${q('#code-mode')}.value`)).toBe(
        'full-access',
      )
      // In the session: 人工确认, at once.
      await choose('off')
      await tab.waitFor(`${q('#code-say')}.textContent === '已生效'`)
      expect(
        await tab.evaluate<unknown>(`${calls('qmo_local_set_mode')}[0][1]`),
      ).toEqual({ session: id, mode: 'off' })
      // Refused: back to what it was, and why.
      await choose('accept-edits')
      expect(await tab.evaluate<string>(`${q('#code-mode')}.value`)).toBe(
        'accept-edits',
      )
      await tab.waitFor(
        `${q('#code-say')}.textContent === 'qmo local E_ARGS: 这个 Claude Code 没有自动模式' && ${q('#code-mode')}.value === 'off'`,
      )
      // 跳过权限确认 in a session is only written after 确认.
      const asked = await tab.evaluate<number>(
        `${calls('qmo_local_set_mode')}.length`,
      )
      await choose('full-access')
      expect(
        await tab.evaluate<number>(`${calls('qmo_local_set_mode')}.length`),
      ).toBe(asked)
      await tab.evaluate(`${q('[data-action="code-bypass-ok"]')}.click()`)
      await tab.waitFor(
        `${calls('qmo_local_set_mode')}.length === ${asked + 1}`,
      )
    } finally {
      await tab.close()
    }
    const later = await open(browser, served.base, { modeNextTurn: true })
    try {
      await begin(later.tab, '下一轮再说')
      await later.tab.evaluate(
        `(() => { const s = ${q('#code-mode')}; s.value = 'off'; s.dispatchEvent(new Event('change')); })()`,
      )
      await later.tab.waitFor(`${q('#code-say')}.textContent === '下一轮生效'`)
    } finally {
      await later.tab.close()
    }
  }, 30_000)

  test('a send that fails stays as 未送达 · 重试; a start that fails puts the line back', async () => {
    const { tab } = await open(browser, served.base, { sendRefusals: 1 })
    try {
      const id = await begin(tab, '第一句')
      await fake(tab, `state('${id}', 'idle')`)
      await say(tab, '第二句')
      await tab.waitFor(`${q('#code-msgs .fx-msg-user.is-failed')} !== null`)
      expect(
        await tab.evaluate<unknown>(`({
          meta: ${q('.fx-msg-user.is-failed .fx-meta')}.textContent.replace(/^\\d\\d:\\d\\d/, ''),
          box: ${q('#code-text')}.value,
          say: ${q('#code-say')}.textContent,
        })`),
      ).toEqual({
        meta: '未送达重试',
        box: '',
        say: 'qmo local E_BUSY: 队列已满',
      })
      await tab.evaluate(`${q('.fx-msg-user.is-failed .fx-retry')}.click()`)
      await tab.waitFor(
        `${calls('qmo_local_send')}.length === 2 && ${q('.fx-msg-user.is-failed')} === null && document.querySelectorAll('#code-msgs .fx-msg-user').length === 2`,
      )
    } finally {
      await tab.close()
    }
    const refused = await open(browser, served.base, {
      startRefusal: 'qmo local E_FOLDER: 文件夹不在了',
    })
    try {
      await say(refused.tab, '这句会回到输入框')
      await refused.tab.waitFor(
        `${q('#code-say')}.textContent === 'qmo local E_FOLDER: 文件夹不在了'`,
      )
      expect(
        await refused.tab.evaluate<unknown>(`({
          view: ${q('#code-local')}.getAttribute('data-view'),
          box: ${q('#code-text')}.value,
          lines: document.querySelectorAll('#code-msgs .fx-msg').length,
          search: location.search,
        })`),
      ).toEqual({
        view: 'blank',
        box: '这句会回到输入框',
        lines: 0,
        search: '',
      })
    } finally {
      await refused.tab.close()
    }
  }, 30_000)

  test('选择文件夹… asks the shell, and the folder it picked is chosen', async () => {
    const picked = {
      id: 'fedcba9876543210',
      name: 'web',
      path: '/Users/me/web',
      git: false,
    }
    const { tab } = await open(browser, served.base, { pick: picked })
    try {
      await tab.evaluate(
        `(() => { const s = ${q('#code-folder')}; s.value = 'pick'; s.dispatchEvent(new Event('change')); })()`,
      )
      await tab.waitFor(`${q('#code-folder')}.value === '${picked.id}'`)
      expect(
        await tab.evaluate<unknown>(`({
          calls: ${calls('qmo_local_pick_folder')}.map(c => c[1]),
          options: [...${q('#code-folder')}.options].filter(o => !o.hidden).map(o => o.textContent),
          title: ${q('#code-folder')}.selectedOptions[0].title,
        })`),
      ).toEqual({
        calls: [{}],
        options: ['web', 'atlas', '选择文件夹…'],
        title: '/Users/me/web',
      })
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('back and forward move between sessions; the top of a long one reads the rest; Shift+Enter and a composition do not send', async () => {
    const { tab } = await open(browser, served.base, {})
    try {
      const first = await begin(tab, '第一个会话')
      // Two hundred and fifty more lines in it, never shown to the page.
      await tab.evaluate(`(() => {
        for (let i = 0; i < 250; i++) window.__fake.write('${first}', { at: Date.now() + i, text: '第 ' + i + ' 行' }, true);
        window.__fake.state('${first}', 'idle');
      })()`)
      await tab.evaluate(`${q('#code-new')}.click()`)
      await tab.waitFor(
        `${q('#code-local')}.getAttribute('data-view') === 'blank' && location.search === ''`,
      )
      const second = await begin(tab, '第二个会话')
      expect(second).not.toBe(first)
      // Back to the first: read from the runner, the newest 200 records.
      await tab.evaluate(`${q(`[data-session="${first}"]`)}.click()`)
      await tab.waitFor(
        `location.search === '?session=${first}' && ${q('#code-msgs')}.textContent.includes('第 249 行')`,
      )
      const read = await tab.evaluate<Record<string, unknown>>(
        `${calls('qmo_local_read')}.slice(-1)[0][1]`,
      )
      expect(read).toEqual({ session: first, limit: 200 })
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('#code-msgs .fx-msg').length`,
        ),
      ).toBe(200)
      // The top reads what came before.
      await tab.evaluate(
        `${q('#code-scroll')}.scrollTop = 0; ${q('#code-scroll')}.dispatchEvent(new Event('scroll'))`,
      )
      await tab.waitFor(`${q('#code-msgs')}.textContent.includes('第一个会话')`)
      const older = await tab.evaluate<Record<string, unknown>>(
        `${calls('qmo_local_read')}.slice(-1)[0][1]`,
      )
      expect(older['before']).toBeGreaterThan(0)
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('#code-msgs .fx-msg').length`,
        ),
      ).toBe(251)
      // Back and forward.
      await tab.evaluate('history.back()')
      await tab.waitFor(
        `location.search === '?session=${second}' && ${q('#code-title')}.textContent === '第二个会话'`,
      )
      await tab.evaluate('history.back()')
      await tab.waitFor(
        `location.search === '' && ${q('#code-local')}.getAttribute('data-view') === 'blank'`,
      )
      await tab.evaluate('history.forward()')
      await tab.waitFor(`location.search === '?session=${second}'`)
      await tab.evaluate('history.forward()')
      await tab.waitFor(
        `location.search === '?session=${first}' && ${q('#code-title')}.textContent === '第一个会话'`,
      )
      // Shift+Enter is a new line; Enter while composing is the IME's.
      const sends = await tab.evaluate<number>(
        `${calls('qmo_local_send')}.length`,
      )
      await tab.evaluate(
        `${q('#code-text')}.focus(); ${q('#code-text')}.value = '还没写完'`,
      )
      await key(tab, 'Enter', 'Enter', 13, 8)
      await tab.evaluate(
        `${q('#code-text')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))`,
      )
      await Bun.sleep(100)
      expect(
        await tab.evaluate<number>(`${calls('qmo_local_send')}.length`),
      ).toBe(sends)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('重新检测 asks the shell again; an agent scan that fails says why', async () => {
    const { tab } = await open(browser, served.base, {})
    try {
      await tab.evaluate(`${q('#code-rescan')}.click()`)
      await tab.waitFor(`${calls('qmo_local_agents')}.length === 2`)
      expect(
        await tab.evaluate<unknown>(
          `${calls('qmo_local_agents')}.map(c => c[1])`,
        ),
      ).toEqual([{ rescan: false }, { rescan: true }])
    } finally {
      await tab.close()
    }
    const failing = await open(
      browser,
      served.base,
      {
        agents: 'qmo agents: unknown command "agents"',
      },
      { changes: false },
    )
    try {
      await failing.tab.waitFor(
        `${q('#code-say')}.textContent === 'qmo agents: unknown command "agents"'`,
      )
      expect(
        await failing.tab.evaluate<unknown>(
          `({ local: ${q('#code-local')}.hidden, again: ${q('#code-rescan')}.disabled })`,
        ),
      ).toEqual({ local: false, again: false })
    } finally {
      await failing.tab.close()
    }
  }, 30_000)

  test('an app older than local sessions, an app whose runner refuses, and a browser', async () => {
    const old = await open(browser, served.base, {
      listRefusal: 'Command qmo_local_list not found',
    })
    try {
      await old.tab.waitFor(`!${q('#code-web')}.hidden`)
      expect(
        await old.tab.evaluate<unknown>(`({
          line: ${q('#code-web')}.textContent,
          local: ${q('#code-local')}.hidden,
          start: ${q('#code-new')}.disabled,
        })`),
      ).toEqual({ line: '更新桌面版后可开本机会话', local: true, start: true })
    } finally {
      await old.tab.close()
    }
    const refusing = await open(browser, served.base, {
      listRefusal:
        'qmo local E_RUNNER: qmo code serve did not say hello in 2 s',
    })
    try {
      await refusing.tab.waitFor(
        `${q('#code-say')}.textContent === 'qmo local E_RUNNER: qmo code serve did not say hello in 2 s'`,
      )
      expect(
        await refusing.tab.evaluate<unknown>(
          `[${q('#code-web')}.hidden, ${q('#code-local')}.hidden]`,
        ),
      ).toEqual([true, false])
    } finally {
      await refusing.tab.close()
    }
    const web = await open(browser, served.base, null)
    try {
      expect(
        await web.tab.evaluate<unknown>(`({
          line: ${q('#code-web')}.textContent,
          web: ${q('#code-web')}.hidden,
          local: ${q('#code-local')}.hidden,
          start: ${q('#code-new')}.disabled,
        })`),
      ).toEqual({
        line: 'Code 在 Qmo 桌面版里用',
        web: false,
        local: true,
        start: true,
      })
    } finally {
      await web.tab.close()
    }
  }, 30_000)

  test('three languages', async () => {
    const cases = [
      [
        'en',
        'Describe a task',
        'Reply',
        ['Allow once', 'Allow for this session', 'Deny'],
        'Running',
        'Changes',
      ],
      [
        'ja',
        'やることを入力',
        '続けて入力',
        ['今回だけ許可', 'このセッションでは許可', '拒否'],
        '実行中',
        '変更',
      ],
      [
        'zh-CN',
        '描述要做的事',
        '接着说',
        ['允许一次', '本会话都允许', '拒绝'],
        '运行中',
        '变更',
      ],
    ] as const
    for (const [lang, first, reply, buttons, running, changes] of cases) {
      const { tab } = await open(browser, served.base, {}, { lang })
      try {
        expect([
          lang,
          await tab.evaluate<string>(`${q('#code-text')}.placeholder`),
        ]).toEqual([lang, first])
        const id = await begin(tab, 'hello')
        await fake(
          tab,
          `write('${id}', { variant: 'notice', text: 'Bash', ask: { id: 'a1', tool: 'Bash', title: 'bun test', options: ['once', 'session', 'deny'] } })`,
        )
        await tab.waitFor(`${q('.fx-perm')} !== null`)
        expect(
          await tab.evaluate<unknown>(`({
            reply: ${q('#code-text')}.placeholder,
            buttons: [...document.querySelectorAll('.fx-perm-acts button')].map(b => b.textContent),
            running: ${q('#code-sessions .fx-code-dot')}.getAttribute('aria-label'),
            changes: ${q('#code-changes-title')}.textContent,
          })`),
        ).toEqual({ reply, buttons: [...buttons], running, changes })
      } finally {
        await tab.close()
      }
    }
  }, 60_000)

  for (const scheme of ['light', 'dark'] as const) {
    test(`every text of a session meets AA contrast, ${scheme}`, async () => {
      const { tab } = await open(browser, served.base, WITH_CHANGES, { scheme })
      try {
        const id = await begin(tab, '把 **端口** 改成读 `PORT`')
        await fake(
          tab,
          `write('${id}', { variant: 'notice', noticeSource: 'step', severity: 'info', text: '编辑 src/app.ts', detail: ${JSON.stringify(DIFF)}, tool: { id: 'u1', name: 'Edit', status: 'done', detailKind: 'diff', added: 1, removed: 1 } })`,
        )
        await fake(
          tab,
          `write('${id}', { variant: 'notice', noticeSource: 'step', severity: 'error', text: '执行 bun test', detail: '1 fail', tool: { id: 'u2', name: 'Bash', status: 'failed', detailKind: 'output' } })`,
        )
        await fake(
          tab,
          `write('${id}', { text: '改好了：\\n\\n- 端口读 \`PORT\`\\n\\n\`\`\`ts\\nconst port = 1\\n\`\`\`', state: 'done' })`,
        )
        await fake(
          tab,
          `write('${id}', { variant: 'notice', text: '运行 bun test', ask: { id: 'a9', tool: 'Bash', title: '运行 bun test', paths: ['src'], input: 'bun test', options: ['once', 'session', 'deny'] } })`,
        )
        await fake(tab, `state('${id}', 'waiting')`)
        await say(tab, '排在后面的一句')
        await tab.waitFor(
          `document.querySelectorAll('#code-files .fx-code-frow').length === 2 && ${q('.fx-perm')} !== null`,
        )
        await tab.evaluate(`(() => {
          for (const d of document.querySelectorAll('#code-msgs details')) d.open = true;
          ${q('.fx-perm [data-action="code-deny"]')}.click();
          ${q('#code-files .fx-code-frow')}.click();
        })()`)
        await tab.waitFor(`${q('#code-files .fx-diff .fx-diff-add')} !== null`)
        await tab.evaluate(`(() => {
          const s = ${q('#code-mode')}; s.value = 'full-access'; s.dispatchEvent(new Event('change'));
          for (const m of document.querySelectorAll('.fx-meta-more, .fx-mini')) m.style.opacity = '1';
        })()`)
        const result = await tab.evaluate<Probe>(
          probe(`document.getElementById('fx')`),
        )
        expect(result.total).toBeGreaterThan(40)
        expect(result.short).toEqual([])
      } finally {
        await tab.close()
      }
    }, 30_000)
  }

  test('375 px: nothing runs off the side, the box stays in view, the changes cover the session', async () => {
    const { tab } = await open(browser, served.base, WITH_CHANGES, {
      width: 375,
      height: 760,
      changes: false,
    })
    try {
      const fits = `({
        wide: document.documentElement.scrollWidth,
        box: Math.round(${q('#code-box')}.getBoundingClientRect().bottom),
        right: Math.round(${q('#code-box')}.getBoundingClientRect().right),
      })`
      const blank = await tab.evaluate<{
        wide: number
        box: number
        right: number
      }>(fits)
      expect(blank.wide).toBeLessThanOrEqual(375)
      expect(blank.box).toBeLessThanOrEqual(760)
      expect(blank.right).toBeLessThanOrEqual(375)
      const id = await begin(tab, '修一下登录页')
      await fake(
        tab,
        `write('${id}', { variant: 'notice', text: '运行 rm -rf build', ask: { id: 'n1', tool: 'Bash', title: '运行 rm -rf build', paths: ['build/a/very/long/path/that/keeps/going/and/going/index.html'], options: ['once', 'session', 'deny'] } })`,
      )
      await tab.waitFor(`${q('.fx-perm')} !== null`)
      const session = await tab.evaluate<{
        wide: number
        box: number
        right: number
      }>(fits)
      expect(session.wide).toBeLessThanOrEqual(375)
      expect(session.box).toBeLessThanOrEqual(760)
      expect(session.right).toBeLessThanOrEqual(375)
      expect(await tab.evaluate<boolean>(`${q('#code-changes')}.hidden`)).toBe(
        true,
      )
      await tab.evaluate(`${q('#code-changes-btn')}.click()`)
      await tab.waitFor(
        `!${q('#code-changes')}.hidden && document.querySelectorAll('#code-files .fx-code-file').length === 2`,
      )
      expect(
        await tab.evaluate<unknown>(`(() => {
          const r = ${q('#code-changes')}.getBoundingClientRect();
          return { left: Math.round(r.left), width: Math.round(r.width), shut: getComputedStyle(${q('.fx-code-shut')}).display !== 'none' };
        })()`),
      ).toEqual({ left: 0, width: 375, shut: true })
      await tab.evaluate(`${q('.fx-code-shut')}.click()`)
      await tab.waitFor(`${q('#code-changes')}.hidden`)
    } finally {
      await tab.close()
    }
  }, 30_000)
})
