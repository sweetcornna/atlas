// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The front's approval cards (P39 §2.1, P40 §6): the API filter, the mounts,
 * the per-tool table the card script draws from, and the approvals page's
 * settings card. The script's behaviour on a page — the card in the thread,
 * the credential step, the line for other conversations — is in
 * `browser/frontApproval.browser.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import type { ApprovalItem, ApprovalPort } from '../src/governance.js'
import { settingsCardOf } from '../src/view/approvalCard.js'
import {
  APPROVAL_CARD_JS,
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

  test('the page script and the approvals page read a card the same way', () => {
    const cases: (Record<string, unknown> | null)[] = [
      CARD,
      { ...CARD, current: null },
      { ...CARD, role: 'member' },
      { ...CARD, role: 'viewer' },
      { ...CARD, label: null },
      { ...CARD, area: 1 },
      { ...CARD, title: undefined },
      { ...CARD, page: '//evil.example' },
      { ...CARD, page: undefined },
      null,
    ]
    for (const card of cases) {
      const one = settings(card)
      const server = settingsCardOf(one.input)
      const client = draw(one)
      expect(client.note === '').toBe(server !== null)
      if (server === null) continue
      expect(client.what).toBe(`${server.area} · ${server.label}`)
      expect(client.page).toBe(server.page ?? '')
      expect(client.rows.map(row => row[1])).toEqual(
        server.current === null ? [server.next] : [server.current, server.next],
      )
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

describe('the approvals page draws a settings change from its card', () => {
  async function page(role: 'member' | 'ops'): Promise<string[]> {
    const h = accountsHarness({
      deps: {
        approvals: port(() => [
          settings(CARD),
          item({
            requestId: 'r-2',
            toolName: 'qianmo_mail_send',
            input: { connectorId: 'c1', to: 'a@example.com', subject: 'S' },
          }),
          { ...settings(null), requestId: 'r-3' },
        ]),
      },
    })
    const who = await person(h.handle, role)
    const html = await (
      await h.handle(asSession('GET', '/admin/approvals', who.sid))
    ).text()
    return html.split('<article class="sec">').slice(1)
  }

  test('area · setting, now and after, the role and the panel; never the raw input', async () => {
    const [change] = await page('ops')
    expect(change).toContain('<h2>设置更改 · 待审批</h2>')
    expect(change).toContain('<b>把默认模型服务改成 Claude 网关</b>')
    expect(change).toContain('模型 · 默认模型服务 · 需要运维批准')
    expect(change).toContain(
      '<span class="k">现在</span><span class="v">DeepSeek</span>',
    )
    expect(change).toContain(
      '<span class="k">改为</span><span class="v">Claude 网关</span>',
    )
    expect(change).toContain('href="/admin/providers#routing">在面板里看</a>')
    expect(change).toContain('<code>providers.default</code>')
    expect(change).not.toContain('$secret')
    expect(change).not.toContain('claude-gateway')
    expect(change).not.toContain('查看完整参数')
    // Approved once at a time: no window.
    expect(change).toContain('value="allow-once"')
    expect(change).toContain('value="continue"')
    expect(change).toContain('value="deny"')
    expect(change).not.toContain('value="allow-window"')
  })

  test('a member sees a change that needs ops without buttons; other tools are as they were', async () => {
    const [change, mail, broken] = await page('member')
    expect(change).toContain('<p class="bar">需要运维批准</p>')
    expect(change).not.toContain('data-approval=')
    expect(mail).toContain('<h2>qianmo_mail_send · 待审批</h2>')
    expect(mail).toContain('查看完整参数与摘要')
    expect(mail).toContain('value="allow-window"')
    // A card that cannot be read can only be refused.
    expect(broken).toContain('设置更改的内容不完整 · 只能拒绝')
    expect(broken).toContain('value="deny"')
    expect(broken).not.toContain('value="allow-once"')
  })
})
