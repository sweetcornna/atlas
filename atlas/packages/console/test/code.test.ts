// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code's four page scripts and the frames the server draws for them
 * (P37.14a, P37.14d, P37.15, `docs/dev/qmo-local.md` §4.5.5):
 *
 * - **Budgets.** `CODE_RENDER_JS` under 14,000 characters, `CODE_JS` under
 *   37,000, `CODE_MANAGE_JS` under 8,000, `CODE_HUB_JS` under 7,000; all
 *   parse, all ship without their line comments.
 * - **No markup from strings, no hub but Remote's.** None of the four names
 *   `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`
 *   or `new Function`; the first three never ask the hub for anything
 *   (`fetch`, `EventSource`, `XMLHttpRequest`, the runtime's `sendJson` /
 *   `loadHtml`), and `CODE_HUB_JS` asks only `/v0/code/…` (P37.15).
 * - **The policy.** `/code` carries them in its one inline script, and its
 *   policy lists that script's hash; every other directive is the same
 *   string as the Work face's.
 * - **The frames.** Inside the app the box, the transcript and the changes
 *   panel are there and empty, the mode is 自动审批, the worktree switch
 *   waits for the page script and Remote's for the runner to say it has
 *   Remote, the line to undo a delete is hidden, the icons sit in a
 *   template; in a browser the one line. A personal account on a hub with
 *   Remote gets `data-remote` and `CODE_HUB_JS` too; anyone else's page is
 *   without them. The words travel with the page in each language.
 */

import { describe, expect, test } from 'bun:test'
import { CODE_JS } from '../src/assets/codeClient.js'
import { CODE_HUB_JS } from '../src/assets/codeHub.js'
import { CODE_MANAGE_JS } from '../src/assets/codeManage.js'
import { CODE_RENDER_JS } from '../src/assets/codeRender.js'
import { inlineScripts, scriptHash } from '../src/respond.js'
import { ADMIN, BASE, pageHarness } from './pageHarness.js'
import { accountsHarness, asSession, person } from './accountsHarness.js'
import { MemoryCopies } from './codeCopiesFake.js'
import { FakeHandoffDevices } from './directionFakes.js'

function page(path: string, cookie = ''): Request {
  const headers: Record<string, string> = {
    accept: 'text/html',
    authorization: `Bearer ${ADMIN}`,
  }
  if (cookie !== '') headers['cookie'] = cookie
  return new Request(`${BASE}${path}`, { headers })
}

/** Every directive of a policy but `script-src`. */
function otherDirectives(policy: string): string {
  return policy
    .split('; ')
    .filter(one => !one.startsWith('script-src '))
    .join('; ')
}

describe("Code's page scripts", () => {
  test('stay inside their budgets, parse, and ship without line comments', () => {
    expect(CODE_RENDER_JS.length).toBeLessThan(14_000)
    expect(CODE_JS.length).toBeLessThan(37_000)
    expect(CODE_MANAGE_JS.length).toBeLessThan(8_000)
    expect(CODE_HUB_JS.length).toBeLessThan(7_000)
    for (const script of [
      CODE_RENDER_JS,
      CODE_JS,
      CODE_MANAGE_JS,
      CODE_HUB_JS,
    ]) {
      expect(() => new Function(script)).not.toThrow()
      expect(script.split('\n').filter(line => /^\s*\/\//.test(line))).toEqual(
        [],
      )
    }
  })

  test('never turn a string into markup and never ask the hub', () => {
    for (const script of [CODE_RENDER_JS, CODE_JS, CODE_MANAGE_JS]) {
      for (const banned of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'eval(',
        'new Function',
        'fetch(',
        'EventSource',
        'XMLHttpRequest',
        'sendJson',
        'loadHtml',
        'refreshRegion',
      ]) {
        expect(`${banned} ${script.includes(banned)}`).toBe(`${banned} false`)
      }
    }
    for (const banned of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
      'XMLHttpRequest',
      'sendJson',
      'loadHtml',
    ])
      expect(`${banned} ${CODE_HUB_JS.includes(banned)}`).toBe(
        `${banned} false`,
      )
    // Remote's script asks the hub one place only: `/v0/code/…`.
    expect(
      [...CODE_HUB_JS.matchAll(/'\/v0\/[a-z]+\//g)].map(m => m[0]),
    ).toEqual(["'/v0/code/"])
    expect(CODE_HUB_JS.match(/fetch\(/g)).toHaveLength(1)
    // The runner is reached through the shell alone, by these commands.
    const commands = [...CODE_JS.matchAll(/'(qmo_[a-z_]+)'/g)].map(m => m[1])
    expect([...new Set(commands)].sort()).toEqual([
      'qmo_local_agents',
      'qmo_local_answer',
      'qmo_local_changes',
      'qmo_local_diff',
      'qmo_local_list',
      'qmo_local_pick_folder',
      'qmo_local_read',
      'qmo_local_send',
      'qmo_local_set_mode',
      'qmo_local_set_remote',
      'qmo_local_start',
      'qmo_local_stop',
      'qmo_local_watch',
    ])
    const managing = [...CODE_MANAGE_JS.matchAll(/'(qmo_[a-z_]+)'/g)].map(
      m => m[1],
    )
    expect([...new Set(managing)].sort()).toEqual([
      'qmo_local_delete',
      'qmo_local_rename',
    ])
  })
})

describe('the /code document', () => {
  test('carries both scripts in its one inline script, allowed by hash; the rest of the policy is Work’s', async () => {
    const h = pageHarness({ chat: true })
    const code = await h.handle(page('/code', 'qianmo_shell=macos'))
    expect(code.status).toBe(200)
    const html = await code.text()
    const scripts = inlineScripts(html)
    expect(scripts.length).toBe(1)
    const script = scripts[0] ?? ''
    const render = script.indexOf(CODE_RENDER_JS)
    const client = script.indexOf(CODE_JS)
    expect(render).toBeGreaterThan(0)
    expect(client).toBe(render + CODE_RENDER_JS.length)
    expect(script.indexOf(CODE_MANAGE_JS)).toBe(client + CODE_JS.length)
    const policy = code.headers.get('content-security-policy') ?? ''
    expect(policy).toContain(scriptHash(script))
    const work = await h.handle(page('/app', 'qianmo_shell=macos'))
    expect(otherDirectives(policy)).toBe(
      otherDirectives(work.headers.get('content-security-policy') ?? ''),
    )
    // Work's documents do not carry Code's scripts.
    const workScript = inlineScripts(await work.text())[0]
    expect(workScript).not.toContain(CODE_JS)
    expect(workScript).not.toContain(CODE_MANAGE_JS)
    // Nor does a console without Remote carry Remote's.
    expect(script).not.toContain(CODE_HUB_JS)
    expect(html).not.toContain('data-remote')
  })

  test('a personal account on a hub with Remote: data-remote, and Remote\u2019s script first', async () => {
    const h = accountsHarness({
      deps: {
        handoffDevices: new FakeHandoffDevices(() => 1_700_000_000_000),
        codeCopies: new MemoryCopies(),
      },
    })
    // The fake ledger cannot authenticate a token: no link, no Remote.
    expect(h.handle.links).toBeUndefined()
    const ledger = new FakeHandoffDevices(() => 1_700_000_000_000)
    const devices = Object.assign(ledger, {
      authenticate: () => null,
      refusalOf: () => 'unauthorized' as const,
    })
    const remote = accountsHarness({
      deps: { handoffDevices: devices, codeCopies: new MemoryCopies() },
    })
    expect(remote.handle.links).toBeDefined()
    const member = await person(remote.handle, 'member')
    const code = await remote.handle(
      asSession('GET', '/code', member.sid, {
        accept: 'text/html',
        extra: { cookie: `qianmo_session=${member.sid}; qianmo_shell=macos` },
      }),
    )
    expect(code.status).toBe(200)
    const html = await code.text()
    expect(html).toMatch(
      /id="code-local" data-view="blank" data-text="[^"]+" data-remote="1">/,
    )
    const script = inlineScripts(html)[0] ?? ''
    const hub = script.indexOf(CODE_HUB_JS)
    expect(hub).toBeGreaterThan(0)
    expect(script.indexOf(CODE_RENDER_JS)).toBe(hub + CODE_HUB_JS.length)
    expect(code.headers.get('content-security-policy')).toContain(
      scriptHash(script),
    )
    // The switch over a session, the link's state and the drop, all waiting.
    expect(html).toMatch(
      /<label class="sw fx-code-remote-head" id="code-remote-head" title="[^"]+" hidden>/,
    )
    expect(html).toContain(
      '<span class="fx-code-link" id="code-link" role="status" hidden></span>',
    )
    expect(html).toContain(
      'id="code-drop" data-action="code-drop" hidden>从中枢删除副本</button>',
    )
    // The legacy admin token on the same hub: no copies to draw.
    const admin = await (
      await remote.handle(page('/code', 'qianmo_shell=macos'))
    ).text()
    expect(admin).not.toContain('data-remote')
  })

  test('inside the app: empty frames, 自动审批, the worktree and Remote held, the icons in a template', async () => {
    const h = pageHarness({ chat: true })
    const html = await (
      await h.handle(page('/code', 'qianmo_shell=macos'))
    ).text()
    expect(html).toContain('<p class="fx-code-web" id="code-web" hidden>')
    expect(html).toMatch(
      /<div class="fx-code-local" id="code-local" data-view="blank" data-text="[^"]+">/,
    )
    expect(html).toContain('<div class="fx-msgs" id="code-msgs"></div>')
    expect(html).toContain('<ul class="fx-code-files" id="code-files"></ul>')
    expect(html).toContain('<option value="auto" selected>自动审批</option>')
    expect(html).toMatch(/<option value="full-access">跳过权限确认<\/option>/)
    expect(html).toContain(
      '<input type="checkbox" role="switch" id="code-remote" disabled>',
    )
    expect(html).toContain(
      '<input type="checkbox" role="switch" id="code-worktree" aria-describedby="code-wt-hint" disabled>',
    )
    expect(html).toContain(
      '<p class="fx-code-hint fx-code-blank-only" id="code-wt-hint" hidden>从当前提交开始，没提交的改动不带过去</p>',
    )
    expect(html).toMatch(
      /<div class="fx-code-undo" id="code-undo" role="status" hidden>.*>撤销<\/button><\/div>/,
    )
    expect(html).toContain('<template id="code-icons">')
    for (const name of [
      'check',
      'x',
      'alert-triangle',
      'list-checks',
      'copy',
      'ellipsis',
      'pencil',
      'trash-2',
      'chev',
    ]) {
      expect(html).toContain(`<i data-i="${name}"><svg`)
    }
    expect(html).toContain('id="code-bypass" role="alert" hidden')
    expect(html).toContain('agent 将不经确认执行任何命令与改动')
    // The sessions' head and the changes button wait for a session.
    expect(html).toContain(
      '<div class="fx-head fx-code-head" id="code-head" hidden>',
    )
    expect(html).toMatch(/id="code-changes-btn"[^>]* hidden>/)
    const words = /data-text="([^"]+)"/.exec(
      html.slice(html.indexOf('id="code-local"')),
    )?.[1]
    const parsed = JSON.parse(
      (words ?? '{}')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&'),
    ) as Record<string, string>
    expect(parsed['updateApp']).toBe('更新桌面版后可开本机会话')
    expect(parsed['notGit']).toBe('不是 Git 仓库 · 按会话记录列出')
    expect(parsed['removed']).toBe('已删除「{t}」')
    expect(parsed['once']).toBe('允许一次')
    expect(parsed['none']).toBe('还没有代码会话')
  })

  test('in a browser the one line, the box hidden', async () => {
    const h = pageHarness({ chat: true })
    const html = await (await h.handle(page('/code'))).text()
    expect(html).toContain(
      '<p class="fx-code-web" id="code-web">Code 在 Qmo 桌面版里用</p>',
    )
    expect(html).toMatch(
      /id="code-local" data-view="blank" data-text="[^"]+" hidden>/,
    )
  })

  test('the words are there in each language', async () => {
    const h = pageHarness({ chat: true })
    const cases = [
      ['en', 'Describe a task', 'Allow once', 'Changes'],
      ['ja', 'やることを入力', '今回だけ許可', '変更'],
      ['zh-CN', '描述要做的事', '允许一次', '变更'],
    ] as const
    for (const [lang, first, once, changes] of cases) {
      const html = await (
        await h.handle(page('/code', `qianmo_shell=macos; qianmo_lang=${lang}`))
      ).text()
      expect([lang, html.includes(`placeholder="${first}"`)]).toEqual([
        lang,
        true,
      ])
      expect([lang, html.includes(once)]).toEqual([lang, true])
      expect([lang, html.includes(`>${changes}</h2>`)]).toEqual([lang, true])
    }
  })
})
