// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The front's approval cards (P39 §2.1, P40 §6): the API filter, the mounts,
 * the per-tool table the card script draws from, and the approvals page's
 * settings card. The script's behaviour on a page — the card in the thread,
 * deciding on one click, the line for other conversations — is in
 * `browser/frontApproval.browser.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import type { ApprovalItem, ApprovalPort } from '../src/governance.js'
import {
  APPROVAL_CARD_JS,
  approvalCard,
  CARD_WORDS,
} from '../src/view/approvalCard.js'
import { APPROVALS_PAGE_JS } from '../src/view/approvals.js'
import {
  FRONT_APPROVAL_JS,
  frontApprovalWords,
} from '../src/view/frontApproval.js'
import { LANGS } from '../src/i18n.js'
import {
  accountsHarness,
  asSession,
  person,
  START,
  type Person,
} from './accountsHarness.js'

function item(over: Partial<ApprovalItem>): ApprovalItem {
  return {
    requestId: 'r-1',
    node: 'tokyo-1',
    agent: 'qianmo://tokyo-1/planner',
    contextId: 'session-1',
    owner: null,
    toolName: 'qianmo_elevated_github',
    input: { op: 'pr_create', repo: 'acme/app', title: 'Fix' },
    digest: 'digest-1',
    createdAt: START,
    expiresAt: START + 600_000,
    status: 'pending',
    ...over,
  }
}

/** A settings change as the hub binds it (§4.2); the secret is a marker. */
function settings(card: Record<string, unknown> | null): ApprovalItem {
  return item({
    agent: 'qianmo://hub/ops',
    toolName: 'qianmo_settings_change',
    input: {
      id: 'providers.default',
      target: null,
      input: {
        profileId: 'claude-gateway',
        key: { $secret: '…abcd', sha256: 'f'.repeat(64) },
      },
      ...(card === null ? {} : { card }),
    },
  })
}

const CARD = {
  area: '模型',
  label: '默认模型服务',
  title: '把默认模型服务改成 Claude 网关',
  current: 'DeepSeek',
  next: 'Claude 网关',
  role: 'ops',
  page: '/admin/providers#routing',
}

function port(
  items: (subject: string) => readonly ApprovalItem[],
): ApprovalPort {
  return {
    async list(principal) {
      return { ok: true, value: items(principal.subject) }
    },
    async decide() {
      return { ok: true, value: { delivered: true } }
    },
    async revoke() {
      return { ok: true, value: { delivered: true } }
    },
  }
}

interface Card {
  readonly kind: string
  readonly title: string
  readonly what: string
  readonly rows: readonly (readonly [string, string, number])[]
  readonly detail: string
  readonly page: string
  readonly tag: string
  readonly note: string
  readonly summary: string
  readonly allow: boolean
  readonly deny: boolean
  readonly resume: boolean
  readonly window: boolean
}

/** The page script's per-tool table, run alone with the Chinese words. */
const cardOf = new Function(
  'item',
  'w',
  'role',
  `${APPROVAL_CARD_JS}\nreturn approvalCard(item, w, role);`,
) as (item: ApprovalItem, w: unknown, role: string) => Card
const zh = frontApprovalWords('zh-CN')
const draw = (one: ApprovalItem, role = 'ops'): Card => cardOf(one, zh, role)

describe('GET /v0/approvals?mine=1', () => {
  test('only pending requests whose session belongs to this person', async () => {
    const h = accountsHarness({
      deps: {
        approvals: port(me => [
          item({ requestId: 'mine', owner: me }),
          item({ requestId: 'done', owner: me, status: 'allowed' }),
          item({ requestId: 'theirs', owner: 'u:someone-else' }),
        ]),
      },
    })
    const ops = await person(h.handle, 'ops')
    const all = (await (
      await h.handle(asSession('GET', '/v0/approvals', ops.sid))
    ).json()) as { approvals: ApprovalItem[] }
    expect(all.approvals.map(a => a.requestId)).toEqual([
      'mine',
      'done',
      'theirs',
    ])
    const mine = (await (
      await h.handle(asSession('GET', '/v0/approvals?mine=1', ops.sid))
    ).json()) as { approvals: ApprovalItem[] }
    expect(mine.approvals.map(a => a.requestId)).toEqual(['mine'])
  })
})

describe('the front document', () => {
  async function front(
    role: 'member' | 'ops',
    wired: boolean,
  ): Promise<string> {
    const h = wired
      ? accountsHarness({ deps: { approvals: port(() => []) } })
      : accountsHarness()
    const who: Person = await person(h.handle, role)
    return (
      await h.handle(asSession('GET', '/', who.sid, { header: false }))
    ).text()
  }

  test('carries the cards and the line only when approvals are wired and the reader may approve', async () => {
    const page = await front('member', true)
    expect(page).toContain('id="fx-asks"')
    expect(page).toContain('id="fx-ask-bar"')
    expect(page).toContain('/v0/approvals?mine=1')
    // No modal any more: the request is drawn in the conversation.
    expect(page).not.toContain('<dialog class="dialog fx-approval"')
    const plain = await front('member', false)
    expect(plain).not.toContain('fx-ask')
    expect(plain).not.toContain('/v0/approvals?mine=1')
  })

  test('the cards follow the thread, the line sits right above the composer, and the reader role rides along', async () => {
    const member = await front('member', true)
    const thread = member.indexOf('id="fx-thread"')
    const cards = member.indexOf('id="fx-asks"')
    const bar = member.indexOf('id="fx-ask-bar"')
    const composer = member.indexOf('id="fx-composer"')
    expect(thread).toBeGreaterThan(0)
    expect(cards).toBeGreaterThan(thread)
    expect(bar).toBeGreaterThan(cards)
    expect(composer).toBeGreaterThan(bar)
    expect(member).toContain('data-role="member"')
    expect(await front('ops', true)).toContain('data-role="ops"')
  })

  test('a card decides on the click: no credential field, no verification call', () => {
    expect(FRONT_APPROVAL_JS).not.toContain('/v0/approvals/auth')
    expect(FRONT_APPROVAL_JS).not.toContain('fx-ask-auth')
    expect(FRONT_APPROVAL_JS).not.toContain('password')
    expect(FRONT_APPROVAL_JS).not.toContain("addEventListener('submit'")
    expect(FRONT_APPROVAL_JS).toContain(
      "decide(entry, button.getAttribute('data-ask-choice') || '');",
    )
    expect(APPROVALS_PAGE_JS).not.toContain('/v0/approvals/auth')
    expect(APPROVALS_PAGE_JS).not.toContain('approval-auth')
    expect(APPROVALS_PAGE_JS).not.toContain('个人凭据')
  })

  test('nothing in the cards takes focus or the Enter key by itself', () => {
    expect(FRONT_APPROVAL_JS).not.toContain('autofocus')
    expect(FRONT_APPROVAL_JS).not.toContain('keydown')
    expect(FRONT_APPROVAL_JS).not.toContain('showModal')
    expect(() => new Function(FRONT_APPROVAL_JS)).not.toThrow()
    // The card table lives inside the page script's own scope.
    expect(FRONT_APPROVAL_JS.trimStart().startsWith('(function () {')).toBe(
      true,
    )
    expect(FRONT_APPROVAL_JS.trimEnd().endsWith('})();')).toBe(true)
  })
})

describe('the settings change card', () => {
  test('who asks, area · setting, now and after, the panel, approve and deny', () => {
    const card = draw(settings(CARD))
    expect(card.title).toBe('ops 想更改设置')
    expect(card.what).toBe('模型 · 默认模型服务')
    expect(card.rows).toEqual([
      ['现在', 'DeepSeek', 0],
      ['改为', 'Claude 网关', 1],
    ])
    expect(card.page).toBe('/admin/providers#routing')
    expect(card.tag).toBe('需要运维')
    expect(card.summary).toBe('把默认模型服务改成 Claude 网关')
    expect(card.allow).toBe(true)
    expect(card.deny).toBe(true)
  })

  test('a reader who is not ops gets no buttons on a change that needs ops', () => {
    const card = draw(settings(CARD), 'member')
    expect(card.allow).toBe(false)
    expect(card.deny).toBe(false)
    expect(card.note).toBe('需要运维批准')
    expect(card.tag).toBe('')
    // A change any member may make keeps both buttons for a member.
    const open = draw(settings({ ...CARD, role: 'member' }), 'member')
    expect([open.allow, open.deny, open.note, open.tag]).toEqual([
      true,
      true,
      '',
      '',
    ])
  })

  test('a change that creates something has one row, 新建', () => {
    const card = draw(settings({ ...CARD, current: null }))
    expect(card.rows).toEqual([['新建', 'Claude 网关', 1]])
  })

  test('the raw input is never drawn, only the card', () => {
    const shown = JSON.stringify(draw(settings(CARD)))
    expect(shown).not.toContain('$secret')
    expect(shown).not.toContain('claude-gateway')
    expect(shown).not.toContain('f'.repeat(64))
    expect(shown).not.toContain('providers.default')
  })

  test('a malformed card shows nothing of the change and can only be denied', () => {
    for (const broken of [
      null,
      { ...CARD, role: 'admin' },
      { ...CARD, next: 3 },
      { ...CARD, current: undefined },
    ]) {
      const card = draw(settings(broken))
      expect(card.title).toBe('ops 想更改设置')
      expect(card.note).toBe('内容不完整 · 只能拒绝')
      expect(card.allow).toBe(false)
      expect(card.deny).toBe(true)
      expect(card.rows).toEqual([])
      expect(card.what).toBe('')
    }
  })

  test('the panel link is a path on this console or nothing', () => {
    for (const page of [
      'javascript:alert(1)',
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example/',
      '/admin/x y',
      '/admin/\u0007',
    ]) {
      expect(draw(settings({ ...CARD, page })).page).toBe('')
    }
  })
})

describe('one table on both sides of the wire', () => {
  /** Every row of the table, and the edges of each. */
  const corpus: ApprovalItem[] = [
    settings(CARD),
    settings({ ...CARD, current: null }),
    settings({ ...CARD, role: 'member' }),
    settings({ ...CARD, role: 'viewer' }),
    settings({ ...CARD, label: null }),
    settings({ ...CARD, area: 1 }),
    settings({ ...CARD, title: undefined }),
    settings({ ...CARD, page: '//evil.example' }),
    settings({ ...CARD, page: '/admin/\u0085x' }),
    settings({ ...CARD, page: '/admin/x\u3000y' }),
    settings({ ...CARD, next: 'x'.repeat(500) }),
    settings(null),
    item({ toolName: 'qianmo_settings_change', input: { card: [] } }),
    item({
      toolName: 'qianmo_mail_send',
      input: { to: ['a@example.com', 3], subject: '周报', body: 'b' },
    }),
    item({ toolName: 'qianmo_mail_send', input: { to: 'a@example.com' } }),
    item({
      toolName: 'qianmo_calendar_create',
      input: { title: 't', start: 's', end: 'e', location: 'l', notes: 'n' },
    }),
    item({ toolName: 'qianmo_calendar_create', input: { start: 's' } }),
    item({ toolName: 'qianmo_browser_click', input: { summary: '点击' } }),
    item({ toolName: 'qianmo_computer_type', input: { op: 'type' } }),
    item({ toolName: 'qianmo_computer_key', input: {} }),
    item({
      toolName: 'qianmo_memory_write',
      input: { title: 't', summary: 's', body: 'b', destination: 'd' },
    }),
    item({ toolName: 'qianmo_memory_write', input: { title: 't' } }),
    item({ toolName: 'qianmo_elevated_bash', input: { command: 'ls' } }),
    item({ toolName: 'bash', input: { command: 'x'.repeat(2000) } }),
    item({ toolName: 'qianmo_elevated_web_search', input: { query: 'q' } }),
    item({ toolName: 'qianmo_elevated_read', input: { paths: ['a', 'b'] } }),
    item({ toolName: 'read', input: { url: 'https://example.com' } }),
    item({}),
    item({ input: { op: 'issue_list' } }),
    item({ toolName: 'write', input: { path: '/tmp/\u202ea', n: [1] } }),
    item({ agent: 'planner', toolName: 'write', input: {} }),
    item({ toolName: '', input: {} }),
  ]

  test('the page script and the server draw every request the same, in every language and role', () => {
    for (const lang of LANGS) {
      const words = frontApprovalWords(lang)
      for (const role of ['ops', 'member']) {
        for (const one of corpus) {
          expect({
            tool: one.toolName,
            card: cardOf(one, words, role),
          }).toEqual({
            tool: one.toolName,
            card: JSON.parse(
              JSON.stringify(approvalCard(one, CARD_WORDS[lang], role)),
            ),
          })
        }
      }
    }
  })
})

describe('the other tools keep their facts in the same frame', () => {
  test('mail: recipients, subject and the body', () => {
    const card = draw(
      item({
        toolName: 'qianmo_mail_send',
        input: {
          connectorId: 'c1',
          to: ['a@example.com', 'b@example.com'],
          subject: '周报',
          body: '本周进展见附件',
        },
      }),
    )
    expect(card.title).toBe('planner 想发送邮件')
    expect(card.rows).toEqual([
      ['收件人', 'a@example.com, b@example.com', 0],
      ['主题', '周报', 0],
    ])
    expect(card.detail).toBe('本周进展见附件')
    expect(card.allow && card.deny).toBe(true)
  })

  test('calendar: title, time and place', () => {
    const card = draw(
      item({
        toolName: 'qianmo_calendar_create',
        input: {
          connectorId: 'c1',
          title: '发版评审',
          start: '2026-10-22T10:00:00+08:00',
          end: '2026-10-22T11:00:00+08:00',
          location: '三楼',
        },
      }),
    )
    expect(card.title).toBe('planner 想新建日程')
    expect(card.what).toBe('发版评审')
    expect(card.rows).toEqual([
      ['时间', '2026-10-22T10:00:00+08:00 – 2026-10-22T11:00:00+08:00', 0],
      ['地点', '三楼', 0],
    ])
  })

  test('云端电脑: the one readable line the node signed', () => {
    const card = draw(
      item({
        toolName: 'qianmo_browser_click',
        input: { op: 'click', summary: '点击「提交」按钮', args: { x: 1 } },
      }),
    )
    expect(card.title).toBe('planner 想操作云端电脑')
    expect(card.what).toBe('点击「提交」按钮')
    expect(card.detail).toBe('')
  })

  test('elevated: the command, the query, the GitHub action', () => {
    expect(
      draw(
        item({
          toolName: 'qianmo_elevated_bash',
          input: { command: 'npm test' },
        }),
      ),
    ).toMatchObject({ title: 'planner 想执行命令', detail: 'npm test' })
    expect(
      draw(
        item({
          toolName: 'qianmo_elevated_web_search',
          input: { query: 'bun 1.4.3' },
        }),
      ),
    ).toMatchObject({ title: 'planner 想联网读取', what: 'bun 1.4.3' })
    expect(draw(item({}))).toMatchObject({
      title: 'planner 想操作 GitHub',
      what: 'pr_create · acme/app · Fix',
    })
  })

  test('memory: the title, where it goes, and what is written', () => {
    const card = draw(
      item({
        toolName: 'qianmo_memory_write',
        input: {
          scope: 'long',
          title: '部署口径',
          summary: '部署要带 p8',
          body: '单元须 PrivateUsers=yes',
          destination: '写进 u:1 的长期记忆',
        },
      }),
    )
    expect(card.title).toBe('planner 想写入记忆')
    expect(card.what).toBe('部署口径')
    expect(card.rows).toEqual([['写入', '写进 u:1 的长期记忆', 0]])
    expect(card.detail).toBe('部署要带 p8\n\n单元须 PrivateUsers=yes')
  })

  test('anything else: the tool and its arguments', () => {
    const card = draw(
      item({ toolName: 'write', input: { path: '/tmp/a', content: 'x' } }),
    )
    expect(card.title).toBe('planner 想调用工具')
    expect(card.what).toBe('write')
    expect(card.detail).toContain('"path": "/tmp/a"')
  })
})

describe('批准 after the turn has ended', () => {
  test('continues a request a new turn can carry, and keeps the ones the node approves fresh as allow-once', () => {
    const resumes = (toolName: string) =>
      draw(item({ toolName, input: {} })).resume
    expect(resumes('qianmo_settings_change')).toBe(true)
    expect(resumes('write')).toBe(true)
    expect(resumes('bash')).toBe(true)
    for (const fresh of [
      'qianmo_mail_send',
      'qianmo_calendar_create',
      'qianmo_memory_write',
      'qianmo_browser_click',
      'qianmo_computer_type',
      'qianmo_elevated_bash',
      'qianmo_elevated_github',
    ])
      expect({ fresh, resume: resumes(fresh) }).toEqual({
        fresh,
        resume: false,
      })
  })

  test('the page script picks the path at the moment of the click', () => {
    expect(FRONT_APPROVAL_JS).toContain(
      "var resume = choice === 'allow-once' && entry.card.resume && !running(item);",
    )
    expect(FRONT_APPROVAL_JS).toContain("(resume ? '/continue' : '')")
    expect(FRONT_APPROVAL_JS).toContain(
      "thread.getAttribute('data-running') === '1'",
    )
  })
})

describe('the words', () => {
  test('every language has every word, and no visible copy breaks the copy rule', () => {
    const keys = (value: unknown): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, inner]) =>
            typeof inner === 'string'
              ? [key]
              : keys(inner).map(k => `${key}.${k}`),
          )
        : []
    const reference = keys(frontApprovalWords('zh-CN')).sort()
    // The credential step's words went with it (2026-10-22).
    for (const gone of ['credential', 'needCredential', 'verifyFailed'])
      expect(reference).not.toContain(gone)
    for (const lang of LANGS) {
      const words = frontApprovalWords(lang)
      expect(keys(words).sort()).toEqual(reference)
      const text = JSON.stringify(words)
      for (const mark of ['。', '，', '、', '！', '!']) {
        expect({ lang, mark, found: text.includes(mark) }).toEqual({
          lang,
          mark,
          found: false,
        })
      }
    }
  })
})

describe('the approvals page', () => {
  async function page(
    role: 'member' | 'ops' | 'viewer',
    items: (me: string) => readonly ApprovalItem[] = () => [
      settings(CARD),
      item({
        requestId: 'r-2',
        toolName: 'qianmo_mail_send',
        input: { connectorId: 'c1', to: 'a@example.com', subject: 'S' },
        createdAt: START + 1,
      }),
      { ...settings(null), requestId: 'r-3', createdAt: START + 2 },
      item({
        requestId: 'r-4',
        toolName: 'write',
        input: { path: '/tmp/a' },
        createdAt: START + 3,
      }),
      item({ requestId: 'r-5', status: 'allowed', createdAt: START + 4 }),
      item({ requestId: 'r-6', status: 'denied', createdAt: START + 5 }),
    ],
  ): Promise<{ readonly html: string; readonly cards: string[] }> {
    const h = accountsHarness({ deps: { approvals: port(items) } })
    const who = await person(h.handle, role)
    const html = await (
      await h.handle(asSession('GET', '/admin/approvals', who.sid))
    ).text()
    return {
      html,
      cards: html.split('<article class="card elev-sm apv-card"').slice(1),
    }
  }

  test('pending first, one short note, the decided folded under 已处理', async () => {
    const { html, cards } = await page('ops')
    expect(html).toContain('<p class="apv-note">批准绑定确切参数</p>')
    expect(cards.map(card => /data-key="apv:([^"]+)"/.exec(card)?.[1])).toEqual(
      ['r-1', 'r-2', 'r-3', 'r-4', 'r-6', 'r-5'],
    )
    const done = html.slice(html.indexOf('<details class="apv-done"'))
    expect(done).toContain('已处理 · 2')
    expect(done).toContain('data-key="apv:r-6"')
    expect(done.indexOf('data-key="apv:r-1"')).toBe(-1)
    // A signed-in person decides directly (2026-10-22): the status line is
    // there for what a refusal says, and no credential row is.
    expect(html).toContain(
      '<p id="approval-status" class="apv-status" role="status"></p>',
    )
    expect(html).not.toContain('id="approval-auth"')
    expect(html).not.toContain('name="credential"')
    expect(html).not.toContain('apv-auth')
  })

  test('a settings change: the figure and title, area · setting, now and after, the panel; never the raw input', async () => {
    const [change = ''] = (await page('ops')).cards
    expect(change).toContain('<svg class="avatar"')
    expect(change).toContain('<h2 class="apv-title">ops 想更改设置</h2>')
    expect(change).toContain('<span class="tag tag-neutral">需要运维</span>')
    expect(change).toContain('<span class="tag tag-accent">待审批</span>')
    expect(change).toContain('<p class="apv-what">模型 · 默认模型服务</p>')
    expect(change).toContain('<dt>现在</dt><dd>DeepSeek</dd>')
    expect(change).toContain(
      '<dt>改为</dt><dd class="is-next">Claude 网关</dd>',
    )
    expect(change).toContain('href="/admin/providers#routing">在面板里看</a>')
    // The meta line: node, the way back, when it lapses in words, not ISO.
    expect(change).toContain(
      '节点 tokyo-1 · <a href="/?session=session-1">查看原会话</a>',
    )
    expect(change).toMatch(
      /<time datetime="[^"]+" title="[^"]+">10 分钟后<\/time>到期/,
    )
    // 详情: the id and the digest; no arguments.
    expect(change).toContain(
      '<dt>设置项</dt><dd class="mono">providers.default</dd>',
    )
    expect(change).toContain('<dt>摘要</dt><dd class="mono">digest-1</dd>')
    expect(change).not.toContain('apv-json')
    expect(change).not.toContain('$secret')
    expect(change).not.toContain('claude-gateway')
    // Approved once at a time: no window.
    const buttons = [...change.matchAll(/value="([a-z-]+)"/g)].map(m => m[1])
    expect(buttons).toEqual(['deny', 'continue', 'allow-once'])
    expect(change).toContain(
      'class="btn btn-ghost btn-danger" name="decision" value="deny"',
    )
    expect(change).toContain(
      'class="btn btn-primary" name="decision" value="allow-once">批准</button>',
    )
  })

  test('other tools: the same summary as the conversation, the arguments under 详情, a window only where the node allows one', async () => {
    const { cards } = await page('ops')
    const mail = cards[1] ?? ''
    expect(mail).toContain('<h2 class="apv-title">planner 想发送邮件</h2>')
    expect(mail).toContain('<dt>收件人</dt><dd>a@example.com</dd>')
    expect(mail).toContain('<pre class="apv-json">')
    expect(mail).not.toContain('value="allow-window"')
    const write = cards[3] ?? ''
    expect(write).toContain('<h2 class="apv-title">planner 想调用工具</h2>')
    expect(write).toContain('<p class="apv-what">write</p>')
    expect(write).not.toContain('apv-detail')
    expect([...write.matchAll(/value="([a-z-]+)"/g)].map(m => m[1])).toEqual([
      'deny',
      'allow-window',
      'continue',
      'allow-once',
    ])
    // Allowed: the window can be revoked; refused: nothing to do.
    expect(cards[5]).toContain('data-revoke="r-5">撤销授权窗口</button>')
    expect(cards[5]).toContain('<span class="tag tag-accent-2">已批准</span>')
    expect(cards[4]).not.toContain('<button')
  })

  test('a member sees a change that needs ops without buttons; a card that cannot be read can only be refused', async () => {
    const { cards } = await page('member')
    const [change = '', , broken = ''] = cards
    expect(change).toContain('<p class="apv-hold">需要运维批准</p>')
    expect(change).not.toContain('data-approval=')
    expect(change).not.toContain(
      '<span class="tag tag-neutral">需要运维</span>',
    )
    expect(broken).toContain('内容不完整 · 只能拒绝')
    expect([...broken.matchAll(/value="([a-z-]+)"/g)].map(m => m[1])).toEqual([
      'deny',
    ])
  })

  test('a reader who cannot decide gets the audit summary as one card', async () => {
    const { html } = await page('viewer')
    expect(html).toContain('<section class="card elev-sm apv-audit"')
    expect(html).toContain('审计汇总')
    expect(html).not.toContain('<article class="card elev-sm apv-card"')
    expect(html).not.toContain('id="approval-auth"')
  })

  test('nothing on the page breaks the copy rule', async () => {
    const { html } = await page('ops')
    const readable = html
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace(/<pre class="apv-json">[\s\S]*?<\/pre>/g, '')
      .replace(/<[^>]*>/g, ' ')
    for (const mark of ['。', '，', '、', '！', '!'])
      expect({ mark, found: readable.includes(mark) }).toEqual({
        mark,
        found: false,
      })
  })
})
