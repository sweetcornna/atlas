// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务 (P18.9), through the router, against a hand-written port
 * (`providersFake.ts`): what each page shows, to whom, in which words, and
 * what each write does to the port and the action ledger.
 *
 * The real port, a real node process and a real resident are in
 * `tests/integration/qianmo-providers-page.test.ts`; the browser is in
 * `browser/providers.browser.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ProviderNodeActual } from '../src/deps.js'
import { effectiveCells } from '../src/view/providers.js'
import {
  ADMIN,
  ManualClock,
  VIEW,
  accountsHarness,
  asBearer,
  asSession,
  person,
  type Person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'
import { visibleText, withoutScripts } from './pageHarness.js'
import {
  CHAT_URL,
  FINGERPRINT,
  FakeProviders,
  NOW,
  SHORT_FINGERPRINT,
} from './providersFake.js'

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

interface Setup {
  readonly handle: (request: Request) => Promise<Response>
  readonly providers: FakeProviders
  readonly actions: MemoryActionLedger
  readonly ops: Person
  readonly member: Person
  readonly viewer: Person
  /** Ledger lines and admits before the test's own requests. */
  readonly base: { readonly entries: number; readonly admits: number }
}

async function setup(
  options: { readonly breakGlass?: boolean; readonly wired?: boolean } = {},
): Promise<Setup> {
  const actions = new MemoryActionLedger()
  const providers = new FakeProviders()
  const clock = new ManualClock(NOW)
  const h = accountsHarness({
    clock,
    deps: {
      actions,
      ...(options.wired === false ? {} : { providers }),
    },
    ...(options.breakGlass === true ? { accounts: { breakGlass: true } } : {}),
  })
  const ops = await person(h.handle, 'ops')
  const member = await person(h.handle, 'member')
  const viewer = await person(h.handle, 'viewer')
  return {
    handle: h.handle,
    providers,
    actions,
    ops,
    member,
    viewer,
    base: { entries: actions.entries.length, admits: actions.admitCalls },
  }
}

/** A page as a browser navigates to it: the cookie, no console header. */
function page(path: string, who: Person): Request {
  return asSession('GET', path, who.sid, { header: false })
}

/** A script's request: the cookie and the console header. */
function call(
  method: string,
  path: string,
  who: Person,
  body?: unknown,
): Request {
  return asSession(method, path, who.sid, body === undefined ? {} : { body })
}

async function text(
  handle: Setup['handle'],
  request: Request,
  status = 200,
): Promise<string> {
  const response = await handle(request)
  const body = await response.text()
  expect(`${request.url} ${response.status}`).toBe(`${request.url} ${status}`)
  return body
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

/** Every page and fragment of the area a reader can open. */
const PAGES = [
  '/providers',
  '/providers?node=node-b',
  '/providers/new',
  '/providers/new?q=kimi',
  '/providers/new?preset=deepseek',
  '/providers/new?preset=kimi-code',
  '/providers/new?preset=qwen',
  '/providers/new?preset=ollama',
  '/providers/profiles/deepseek',
  '/providers/profiles/chat-svc',
  '/providers/nodes/node-a',
  '/providers/nodes/node-b',
  '/providers/nodes/node-c',
  '/providers/import',
]

const FRAGMENTS = [
  '/fragments/providers/board',
  '/fragments/providers/board?node=node-a',
  '/fragments/providers/node/node-a',
  '/fragments/providers/node/node-b',
  '/fragments/providers/node/node-c',
  '/fragments/providers/profiles/deepseek/nodes',
  `/fragments/providers/chat?target=${encodeURIComponent('qianmo://node-a/planner')}`,
]

const JSON_READS = [
  '/v0/providers',
  '/v0/providers/profiles/deepseek',
  '/v0/providers/profiles/chat-svc',
  '/v0/providers/nodes/node-b',
]

/** Everything in a document that would let its reader change something (`roles.test.ts`). */
function writeMarks(html: string): readonly string[] {
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '')
  const found: string[] = []
  if (/\sdata-write[\s>=]/.test(markup)) found.push('data-write')
  for (const action of markup.match(/data-action="confirm-[a-z-]+"/g) ?? []) {
    if (action !== 'data-action="confirm-cancel"') found.push(action)
  }
  for (const action of markup.match(/data-action="prov-[a-z-]+"/g) ?? []) {
    found.push(action)
  }
  for (const form of markup.match(/<form[^>]*>/g) ?? []) {
    const plainGet = /method="get"/i.test(form)
    const logout = form.includes('id="logout-form"')
    if (!plainGet && !logout) found.push(form)
  }
  return found
}

/** What only a writer may read (§7.3), wherever it shows up. */
function writerOnly(body: string): readonly string[] {
  const found: string[] = []
  for (const needle of [
    'fp1:',
    SHORT_FINGERPRINT,
    '/v1/secret-path',
    'env.ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'req-apply-a',
    'hash-applied',
  ]) {
    if (body.includes(needle)) found.push(needle)
  }
  return found
}

function assertCopy(label: string, html: string): void {
  const visible = visibleText(html)
  for (const banned of ['。', '，', '、', '！', '!']) {
    expect(`${label} ${visible.includes(banned)} ${banned}`).toBe(
      `${label} false ${banned}`,
    )
  }
  expect(visible).not.toMatch(/\p{Extended_Pictographic}/u)
}

/** One node's row of the matrix. */
function row(html: string, node: string): string {
  const match = new RegExp(
    `<details class="row prov-row" data-key="node:${node}"[\\s\\S]*?</details>`,
  ).exec(html)
  if (match === null) throw new Error(`no row for ${node}`)
  return match[0]
}

/** The text of one cell of a row. */
function cell(markup: string, name: string): string {
  const match = new RegExp(
    `data-cell="${name}"[^>]*>([\\s\\S]*?)</span>(?:<span class="note">|$|<span class="prov-cell|<svg)`,
  ).exec(markup)
  return match?.[1]?.replace(/<[^>]*>/g, '').trim() ?? ''
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

describe('the pages, for ops', () => {
  test('the board: default card, node matrix, profile cards', async () => {
    const s = await setup()
    const html = await text(s.handle, page('/providers', s.ops))
    expect(html).toContain('id="prov-default"')
    expect(html).toContain('id="prov-matrix"')
    expect(html).toContain('data-profile="deepseek"')
    expect(html).toContain('data-profile="chat-svc"')
    expect(html).toContain('data-poll="/fragments/providers/board"')
    // §6.3.3: the key, as a state and a short fingerprint, for ops.
    expect(html).toContain(`指纹 ${SHORT_FINGERPRINT}`)
    expect(html).not.toContain(FINGERPRINT)
    // Drift in the page's own words, never the hub's sentence.
    expect(row(html, 'node-b')).toContain('本地改动')
    expect(html).not.toContain('期望（chat-svc r1）')
    // §6.3.1: the actions on each row.
    for (const action of [
      'prov-apply',
      'prov-probe',
      'prov-diff',
      'prov-assign',
      'prov-context',
      'prov-autocompact',
      'prov-refresh',
      'prov-force',
      'prov-unmanage',
    ]) {
      expect(html).toContain(`data-action="${action}"`)
    }
    expect(html).toContain('导出 · 不含密钥')
    expect(html).toContain('id="prov-switch-dialog"')
  })

  test('?node= narrows the matrix to one node', async () => {
    const s = await setup()
    const html = await text(s.handle, page('/providers?node=node-b', s.ops))
    expect(html).toContain('data-key="node:node-b"')
    expect(html).not.toContain('data-key="node:node-a"')
    expect(html).toContain('data-poll="/fragments/providers/board?node=node-b"')
  })

  test('the preset grid: five groups, unlisted hidden, searched by GET', async () => {
    const s = await setup()
    const html = await text(s.handle, page('/providers/new', s.ops))
    for (const group of ['国内按量', '国际', '套餐', '本地', '自定义']) {
      expect(html).toContain(`>${group}</h3>`)
    }
    expect(html).toContain('<form class="prov-search" method="get"')
    expect(html).not.toContain('data-preset="azure"')
    const searched = await text(s.handle, page('/providers/new?q=kimi', s.ops))
    expect(searched).toContain('data-preset="kimi"')
    expect(searched).toContain('data-preset="kimi-code"')
    expect(searched).not.toContain('data-preset="deepseek"')
  })

  test('the form a preset starts: the key, and the rest folded', async () => {
    const s = await setup()
    const html = await text(
      s.handle,
      page('/providers/new?preset=deepseek', s.ops),
    )
    expect(html).toContain('id="prov-editor" data-mode="create"')
    // §7.5: the key field is a password field nobody can submit.
    const key = /<input[^>]*id="prov-key"[^>]*>/.exec(html)?.[0] ?? ''
    expect(key).toContain('type="password"')
    expect(key).toContain('autocomplete="off"')
    expect(key).not.toContain('name=')
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'))
    expect(main).not.toMatch(/<form(?![^>]*method="get")/)
    expect(main).not.toMatch(/<button(?![^>]*type="button")[^>]*>/)
    // The advanced half is folded for an untouched preset.
    expect(html).toMatch(/<details class="adv" id="prov-adv">/)
    // The three checks, each with its cost.
    expect(html).toContain('验证地址和密钥 · 不产生费用')
    expect(html).toContain('网络往返 · 不含推理')
    expect(html).toContain('会产生一次计费调用')
    // The 保存并切换 rule is said once, on the line the script turns into the
    // warning; the result line under the buttons starts empty.
    expect(
      visibleText(main).split('保存并切换要求本页测连可用').length - 1,
    ).toBe(1)
    expect(main).toContain(
      '<p class="note prov-rule" id="prov-switch-rule" role="status" data-tone="muted">保存并切换要求本页测连可用 · 或勾选跳过测连</p>',
    )
    expect(main).toContain(
      '<p class="prov-result" id="prov-result" role="status" data-tone="muted"></p>',
    )
    // A pay-as-you-go preset knows the plan prefixes of its vendor.
    const kimi = await text(s.handle, page('/providers/new?preset=kimi', s.ops))
    expect(kimi).toContain('data-plan-prefixes="[&quot;sk-kimi-&quot;]"')
    expect(kimi).toContain('data-base-url="https://api.moonshot.ai/anthropic"')
  })

  test('template variables are required fields, terms are said, local keys may be empty', async () => {
    const s = await setup()
    const qwen = await text(s.handle, page('/providers/new?preset=qwen', s.ops))
    expect(qwen).toContain('data-template="WorkspaceId"')
    expect(qwen).toContain('data-template="region"')
    const plan = await text(
      s.handle,
      page('/providers/new?preset=kimi-code', s.ops),
    )
    expect(plan).toContain('套餐条款多限定用于交互式编程工具')
    // The vendor's note, in the console's register.
    expect(plan).toContain('仅限编程工具使用 · 禁止转售')
    const local = await text(
      s.handle,
      page('/providers/new?preset=ollama', s.ops),
    )
    expect(local).toContain('data-placeholder-key="ollama"')
    // No model in the preset: the advanced half is open.
    expect(local).toMatch(/<details class="adv" id="prov-adv" open>/)
  })

  test('one profile: the form filled in, the key, the nodes on it', async () => {
    const s = await setup()
    const html = await text(
      s.handle,
      page('/providers/profiles/deepseek', s.ops),
    )
    expect(html).toContain('data-mode="edit"')
    expect(html).toContain('data-revision="3"')
    expect(html).toContain(`已设置 · 设置于`)
    expect(html).toContain(`指纹 ${SHORT_FINGERPRINT}`)
    expect(html).toContain('data-action="prov-key-refill"')
    expect(html).toContain('data-action="prov-key-clear"')
    expect(html).toContain(
      'data-poll="/fragments/providers/profiles/deepseek/nodes"',
    )
    expect(html).toContain('id="prov-on"')
    // X-3 beside the key.
    expect(html).toContain('下一轮会整段重读 · 不命中缓存')
  })

  test('a profile or node that is not there is a 404 page', async () => {
    const s = await setup()
    await text(s.handle, page('/providers/profiles/nope', s.ops), 404)
    await text(s.handle, page('/providers/nodes/nope', s.ops), 404)
    await text(s.handle, page('/providers/new?preset=nope', s.ops), 404)
    const deeper = await s.handle(page('/providers/a/b/c', s.ops))
    expect(deeper.status).toBe(404)
  })

  test('without a port the page says how to turn it on', async () => {
    const s = await setup({ wired: false })
    const html = await text(s.handle, page('/providers', s.ops))
    expect(html).toContain('模型服务未开启')
    expect(html).not.toContain('data-poll=')
    const api = await s.handle(call('GET', '/v0/providers', s.ops))
    expect(api.status).toBe(501)
    const write = await s.handle(
      call('PUT', '/v0/providers/default', s.ops, { profileId: null }),
    )
    expect(write.status).toBe(501)
  })

  test('a closed face is said in the console register', async () => {
    const s = await setup()
    s.providers.down = {
      code: 'unavailable',
      message: '模型服务已停用：主密钥缺失，已告警。',
    }
    const html = await text(s.handle, page('/providers', s.ops))
    expect(html).toContain(
      '模型服务已停用 · 模型服务已停用 · 主密钥缺失 · 已告警',
    )
    expect(html).toContain('节点继续使用上次下发的配置')
    assertCopy('/providers down', html)
  })
})

// ---------------------------------------------------------------------------
// Who sees what (§7.3)
// ---------------------------------------------------------------------------

describe('who sees what', () => {
  test('viewer, member, both legacy tokens and break-glass see no write control and no fingerprint', async () => {
    const s = await setup()
    const glass = await setup({ breakGlass: true })
    const readers: readonly [
      string,
      Setup,
      (path: string, fragment: boolean) => Request,
    ][] = [
      [
        'viewer',
        s,
        (path, fragment) =>
          fragment ? call('GET', path, s.viewer) : page(path, s.viewer),
      ],
      [
        'member',
        s,
        (path, fragment) =>
          fragment ? call('GET', path, s.member) : page(path, s.member),
      ],
      ['legacy view', s, path => asBearer('GET', path, VIEW)],
      ['legacy admin', s, path => asBearer('GET', path, ADMIN)],
      ['break-glass', glass, path => asBearer('GET', path, ADMIN)],
    ]
    let scanned = 0
    for (const [who, setupOf, request] of readers) {
      for (const path of [...PAGES, ...FRAGMENTS]) {
        const fragment = path.startsWith('/fragments/')
        const body = await text(setupOf.handle, request(path, fragment))
        expect(`${who} ${path} ${writeMarks(body).join(',')}`).toBe(
          `${who} ${path} `,
        )
        expect(`${who} ${path} ${writerOnly(body).join(',')}`).toBe(
          `${who} ${path} `,
        )
        if (!fragment) {
          expect(body).toContain(
            '只读 · 模型服务的写操作需要运维角色的个人账号',
          )
        }
        scanned += 1
      }
      for (const path of JSON_READS) {
        const body = await text(setupOf.handle, request(path, true))
        expect(`${who} ${path} ${writerOnly(body).join(',')}`).toBe(
          `${who} ${path} `,
        )
        scanned += 1
      }
    }
    expect(scanned).toBe(
      readers.length * (PAGES.length + FRAGMENTS.length + JSON_READS.length),
    )
  })

  test('the same scan, as ops, finds them — the scan is not blind', async () => {
    const s = await setup()
    const board = await text(s.handle, page('/providers', s.ops))
    expect(writeMarks(board).length).toBeGreaterThan(5)
    expect(writerOnly(board)).toEqual(
      expect.arrayContaining([
        SHORT_FINGERPRINT,
        '/v1/secret-path',
        'env.ANTHROPIC_MODEL',
      ]),
    )
    const tab = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-a', s.ops),
    )
    expect(writeMarks(tab).length).toBeGreaterThan(3)
    expect(writerOnly(tab)).toContain('req-apply-a')
    const api = await text(s.handle, call('GET', '/v0/providers', s.ops))
    expect(api).toContain(FINGERPRINT)
    expect(api).toContain(CHAT_URL)
  })

  test('a base URL is its host for a reader, whole for ops', async () => {
    const s = await setup()
    const viewer = await text(s.handle, page('/providers', s.viewer))
    expect(viewer).toContain('chat.example.com')
    expect(viewer).not.toContain(CHAT_URL)
    const json = await jsonOf(
      await s.handle(call('GET', '/v0/providers/profiles/chat-svc', s.viewer)),
    )
    expect(json.baseUrl).toBe('chat.example.com')
    expect(json.compat).toBeUndefined()
    expect(JSON.stringify(json.keys)).toBe('[{"id":"k1"}]')
  })

  test('every write is refused to everyone but ops, before the port and unrecorded', async () => {
    const s = await setup()
    const glass = await setup({ breakGlass: true })
    const writes: readonly [string, string, unknown][] = [
      [
        'POST',
        '/v0/providers/profiles',
        { presetId: 'deepseek', profile: { name: 'x' } },
      ],
      [
        'PUT',
        '/v0/providers/profiles/deepseek',
        { ifMatch: 3, profile: { name: 'x' } },
      ],
      ['DELETE', '/v0/providers/profiles/deepseek', { ifMatch: 3 }],
      [
        'PUT',
        '/v0/providers/profiles/deepseek/keys/k1',
        { ifMatch: 3, value: 'sk-test-canary-0001' },
      ],
      ['DELETE', '/v0/providers/profiles/deepseek/keys/k1', { ifMatch: 3 }],
      ['POST', '/v0/providers/profiles/deepseek/skip-probe', {}],
      ['PUT', '/v0/providers/default', { profileId: null }],
      ['PUT', '/v0/providers/nodes/node-a/assignment', { mode: 'unmanaged' }],
      ['PUT', '/v0/providers/nodes/node-a/context', { tokens: '300k' }],
      ['POST', '/v0/providers/nodes/node-a/refresh', {}],
      ['GET', '/v0/providers/nodes/node-a/autocompact', undefined],
      ['PUT', '/v0/providers/nodes/node-a/autocompact', { value: '150k' }],
      ['POST', '/v0/providers/apply', { nodes: ['node-a'] }],
      [
        'POST',
        '/v0/providers/probe',
        { node: 'node-a', profileId: 'deepseek' },
      ],
      ['POST', '/v0/providers/models', { node: 'node-a' }],
      ['POST', '/v0/providers/preview', { profileId: 'deepseek' }],
      ['GET', '/v0/providers/export', undefined],
      ['POST', '/v0/providers/import/preview', { text: '{}' }],
      ['POST', '/v0/providers/import', { text: '{}' }],
    ]
    for (const [method, path, body] of writes) {
      for (const [who, request] of [
        ['viewer', call(method, path, s.viewer, body)],
        ['member', call(method, path, s.member, body)],
        ['legacy view', asBearer(method, path, VIEW, body)],
        ['legacy admin', asBearer(method, path, ADMIN, body)],
      ] as const) {
        const response = await s.handle(request)
        expect(`${who} ${method} ${path} ${response.status}`).toBe(
          `${who} ${method} ${path} 403`,
        )
      }
      const response = await glass.handle(asBearer(method, path, ADMIN, body))
      expect(`break-glass ${method} ${path} ${response.status}`).toBe(
        `break-glass ${method} ${path} 403`,
      )
    }
    expect(s.providers.writes).toEqual([])
    expect(glass.providers.writes).toEqual([])
    expect(s.actions.entries.length).toBe(s.base.entries)
    expect(s.actions.admitCalls).toBe(s.base.admits)
    expect(
      glass.actions.entries.filter(entry =>
        entry.action.startsWith('provider.'),
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Words (§6.6)
// ---------------------------------------------------------------------------

describe('the copy gate', () => {
  test('every page and fragment, for ops and for a viewer', async () => {
    const s = await setup()
    let checked = 0
    for (const who of [s.ops, s.viewer]) {
      for (const path of [...PAGES, ...FRAGMENTS]) {
        const fragment = path.startsWith('/fragments/')
        const html = await text(
          s.handle,
          fragment ? call('GET', path, who) : page(path, who),
        )
        assertCopy(path, html)
        checked += 1
      }
    }
    expect(checked).toBe(2 * (PAGES.length + FRAGMENTS.length))
  })

  test('the script and the messages the API sends say things in the same register', async () => {
    const s = await setup()
    const html = await text(s.handle, page('/providers', s.ops))
    const scripts = (html.match(/<script>[\s\S]*?<\/script>/g) ?? []).join('')
    // The area's own strings, the ones its script puts on the page.
    const area = scripts.slice(
      scripts.indexOf("qc.onAction('prov-progress-close'"),
    )
    const quoted = area.match(/'[^'\n]*[一-鿿][^'\n]*'/g) ?? []
    expect(quoted.length).toBeGreaterThan(20)
    for (const literal of quoted) {
      for (const banned of ['。', '，', '、', '！', '!']) {
        expect(`${literal} ${literal.includes(banned)}`).toBe(
          `${literal} false`,
        )
      }
    }
    // A hub sentence with full stops reaches the script calmed.
    const applied = await jsonOf(
      await s.handle(
        call('POST', '/v0/providers/apply', s.ops, { nodes: ['node-b'] }),
      ),
    )
    const message = JSON.stringify(applied)
    expect(message).toContain('节点上的配置被改过 · 拒绝覆盖')
    expect(message).not.toContain('，')
  })
})

// ---------------------------------------------------------------------------
// Without script (§6.7)
// ---------------------------------------------------------------------------

describe('without script', () => {
  test('reading works and the write controls say why they do nothing', async () => {
    const s = await setup()
    for (const path of [
      '/providers',
      '/providers/profiles/deepseek',
      '/providers/nodes/node-a',
      '/providers/new?preset=deepseek',
      '/providers/import',
    ]) {
      const html = withoutScripts(await text(s.handle, page(path, s.ops)))
      expect(
        `${path} ${html.includes('<noscript><p class="note prov-noscript">保存 · 切换 · 测连 · 删除与导入需要启用脚本 · 阅读不受影响</p></noscript>')}`,
      ).toBe(`${path} true`)
    }
    const board = withoutScripts(
      await text(s.handle, page('/providers', s.ops)),
    )
    expect(cell(row(board, 'node-a'), 'model')).toBe('deepseek-v4-pro')
    // The links still lead somewhere.
    expect(board).toContain('href="/providers/nodes/node-a"')
    expect(board).toContain('href="/providers/profiles/deepseek"')
    // The tab's write controls are links to this area's node page.
    const tab = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-a', s.ops),
    )
    expect(tab).toContain('href="/providers/nodes/node-a?do=context"')
    expect(tab).toContain('href="/providers/nodes/node-a?do=autocompact"')
  })
})

// ---------------------------------------------------------------------------
// AC-P4, the console half: what a node runs is the node's answer
// ---------------------------------------------------------------------------

describe('display = the node', () => {
  test('effectiveCells reads effective and nothing else', () => {
    const touched = new Set<string>()
    const effective = {
      apiProvider: 'firstParty',
      wire: 'chat',
      model: 'glm-5.3',
      wireModel: 'glm-5.3',
      modelSettingsSlot: 'opus',
      effortOnWire: true,
      effortLevel: 'high',
      contextTokens: 128_000,
      autoCompactWindow: 100_000,
      autoCompactSource: 'auto' as const,
    }
    const actual = new Proxy(
      { managed: true, effective } as unknown as ProviderNodeActual,
      {
        get(target, key, receiver) {
          touched.add(String(key))
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const cells = effectiveCells(actual)
    expect([...touched]).toEqual(['effective'])
    expect(cells.lane).toBe('OpenAI Chat')
    expect(cells.model).toBe('glm-5.3')
    expect(cells.effort).toBe('high')
    expect(cells.context).toBe('128k')
    expect(cells.autoCompact).toBe('100k · 自动')
    expect(effectiveCells(null).model).toBe('未报告')
  })

  test('no view of the area reads effective except through effectiveCells', () => {
    for (const file of [
      'providers.ts',
      'providersForm.ts',
      'providersNode.ts',
    ]) {
      const source = readFileSync(
        new URL(`../src/view/${file}`, import.meta.url),
        'utf8',
      )
      const body =
        file === 'providers.ts'
          ? source.replace(/export function effectiveCells\([\s\S]*?\n}\n/, '')
          : source
      const code = body
        .replace(/\/\*\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(`${file} ${/\.effective\b/.test(code)}`).toBe(`${file} false`)
    }
  })

  test('the matrix shows what the node computed, not what the hub asked for', async () => {
    const s = await setup()
    let html = await text(s.handle, page('/providers', s.ops))
    // The profile asks for 500k; node-a reported 200k.
    expect(cell(row(html, 'node-a'), 'context')).toBe('200k')
    expect(row(html, 'node-a')).not.toContain('500k')
    // node-b expects chat-svc (gateway-large) but still runs deepseek.
    expect(cell(row(html, 'node-b'), 'model')).toBe('deepseek-v4-pro')
    expect(row(html, 'node-b')).not.toContain('gateway-large')

    s.providers.report('node-a', {
      model: 'deepseek-flash',
      contextTokens: 1_000_000,
      effortLevel: 'low',
    })
    html = await text(
      s.handle,
      call('GET', '/fragments/providers/board', s.ops),
    )
    expect(cell(row(html, 'node-a'), 'model')).toBe('deepseek-flash')
    expect(cell(row(html, 'node-a'), 'context')).toBe('1M')
    expect(cell(row(html, 'node-a'), 'effort')).toBe('low')

    // A node that reports nothing is shown as reporting nothing.
    s.providers.silence('node-a')
    html = await text(
      s.handle,
      call('GET', '/fragments/providers/board', s.ops),
    )
    expect(cell(row(html, 'node-a'), 'model')).toBe('未报告')
    expect(cell(row(html, 'node-a'), 'context')).toBe('未报告')
    expect(row(html, 'node-a')).not.toContain('deepseek-v4-pro')
  })

  test('the node tab and the profile page read the same answer', async () => {
    const s = await setup()
    s.providers.report('node-a', {
      contextTokens: 400_000,
      autoCompactWindow: 320_000,
    })
    const tab = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-a', s.viewer),
    )
    expect(tab).toContain(
      '<span class="k">上下文窗口 · 节点算出</span><span class="v">400k</span>',
    )
    expect(tab).toContain(
      '<span class="k">自动压缩阈值 · 节点算出</span><span class="v">320k</span>',
    )
    const on = await text(
      s.handle,
      call('GET', '/fragments/providers/profiles/deepseek/nodes', s.viewer),
    )
    expect(on).toContain('上下文 400k')
    expect(on).not.toContain('500k')
  })
})

// ---------------------------------------------------------------------------
// D-8: the context window, from three places
// ---------------------------------------------------------------------------

describe('D-8 the context window', () => {
  test('the profile form carries it per model and saves it', async () => {
    const s = await setup()
    const html = await text(
      s.handle,
      page('/providers/profiles/deepseek', s.ops),
    )
    expect(html).toMatch(/data-f="context"[^>]*value="500000"/)
    const response = await s.handle(
      call('PUT', '/v0/providers/profiles/deepseek', s.ops, {
        ifMatch: 3,
        profile: {
          name: 'DeepSeek',
          lane: 'anthropic',
          baseUrl: 'https://api.deepseek.com/anthropic',
          auth: { scheme: 'bearer' },
          effortLock: null,
          models: [
            {
              id: 'deepseek-v4-pro',
              role: 'main',
              tiers: ['opus', 'sonnet'],
              capabilities: {
                mode: 'explicit',
                thinking: true,
                adaptive_thinking: false,
                interleaved_thinking: false,
              },
              effort: {
                send: 'always',
                level: 'max',
                levels: ['low', 'high', 'max'],
              },
              contextTokens: 300_000,
            },
          ],
          compat: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
          templateValues: {},
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(s.providers.profiles.get('deepseek')?.models[0]?.contextTokens).toBe(
      300_000,
    )
  })

  test('the matrix row and the node tab both set and clear the node override', async () => {
    const s = await setup()
    const board = await text(s.handle, page('/providers', s.ops))
    expect(row(board, 'node-a')).toContain('data-action="prov-context"')
    const tab = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-b', s.ops),
    )
    expect(tab).toContain('data-action="prov-context"')
    expect(tab).toContain('data-action="prov-context-clear"')
    expect(tab).toContain('节点覆盖 · 覆盖 1M')

    let response = await s.handle(
      call('PUT', '/v0/providers/nodes/node-a/context', s.ops, {
        tokens: '300k',
      }),
    )
    expect(response.status).toBe(200)
    expect(s.providers.nodes.get('node-a')?.contextOverride).toBe(300_000)
    response = await s.handle(
      call('PUT', '/v0/providers/nodes/node-a/context', s.ops, {
        tokens: null,
      }),
    )
    expect(response.status).toBe(200)
    expect(s.providers.nodes.get('node-a')?.contextOverride).toBeNull()
    response = await s.handle(
      call('PUT', '/v0/providers/nodes/node-a/context', s.ops, {
        tokens: 'lots',
      }),
    )
    expect(response.status).toBe(400)
    // The override is the hub's record; the cell is still what the node said.
    const after = await text(
      s.handle,
      call('GET', '/fragments/providers/board', s.ops),
    )
    expect(cell(row(after, 'node-a'), 'context')).toBe('200k')
  })

  test('the source is named from the hub, the value from the node', async () => {
    const s = await setup()
    const a = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-a', s.ops),
    )
    expect(a).toContain(
      '<span class="k">来源 · 中枢期望</span><span class="v">档案</span>',
    )
    const c = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-c', s.ops),
    )
    expect(c).toContain('<span class="v">节点本地配置</span>')
    expect(c).toContain(
      '<span class="k">上下文窗口 · 节点算出</span><span class="v">未报告</span>',
    )
  })
})

// ---------------------------------------------------------------------------
// D-9: the auto-compact window, on the node
// ---------------------------------------------------------------------------

describe('D-9 the auto-compact window', () => {
  test('the tab shows the node value and source, and changes it through the port', async () => {
    const s = await setup()
    const tab = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-a', s.ops),
    )
    expect(tab).toContain('<span class="v">180k</span>')
    expect(tab).toContain('来自节点设置')
    expect(tab).toContain('data-action="prov-autocompact"')

    const read = await s.handle(
      call('GET', '/v0/providers/nodes/node-a/autocompact', s.ops),
    )
    expect(read.status).toBe(200)
    expect(s.actions.admitCalls).toBe(s.base.admits)

    const set = await s.handle(
      call('PUT', '/v0/providers/nodes/node-a/autocompact', s.ops, {
        value: '150k',
      }),
    )
    expect(set.status).toBe(200)
    expect(
      ((await set.json()) as { autoCompactWindow: number }).autoCompactWindow,
    ).toBe(150_000)
    expect(s.providers.writes.at(-1)).toEqual({
      method: 'autocompact',
      input: { node: 'node-a', value: 150_000 },
    })
    const auto = await s.handle(
      call('PUT', '/v0/providers/nodes/node-a/autocompact', s.ops, {
        value: 'auto',
      }),
    )
    expect(auto.status).toBe(200)
    expect(s.providers.writes.at(-1)?.input).toEqual({
      node: 'node-a',
      value: 'auto',
    })
  })

  test('a window pinned by the environment is not offered and is refused with the reason', async () => {
    const s = await setup()
    const tab = await text(
      s.handle,
      call('GET', '/fragments/providers/node/node-b', s.ops),
    )
    expect(tab).toContain('来自节点进程的环境变量 · 控制台改不了')
    expect(tab).not.toContain('data-action="prov-autocompact"')
    const response = await s.handle(
      call('PUT', '/v0/providers/nodes/node-b/autocompact', s.ops, {
        value: '150k',
      }),
    )
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('env-override')
  })
})

// ---------------------------------------------------------------------------
// Writes: admit, then the port, which records
// ---------------------------------------------------------------------------

describe('writes', () => {
  test('each write asks the ledger once and is recorded once, by the port', async () => {
    const s = await setup()
    const cases: readonly [string, string, unknown, number][] = [
      ['PUT', '/v0/providers/default', { profileId: 'chat-svc' }, 1],
      [
        'PUT',
        '/v0/providers/nodes/node-a/assignment',
        { mode: 'profile', profileId: 'chat-svc' },
        1,
      ],
      ['PUT', '/v0/providers/nodes/node-a/context', { tokens: '1M' }, 1],
      ['PUT', '/v0/providers/nodes/node-a/autocompact', { value: '120k' }, 1],
      [
        'POST',
        '/v0/providers/probe',
        { node: 'node-a', mode: 'latency', profileId: 'deepseek' },
        1,
      ],
      ['POST', '/v0/providers/apply', { nodes: ['node-a', 'node-b'] }, 2],
      [
        'PUT',
        '/v0/providers/profiles/deepseek/keys/k1',
        { ifMatch: 3, value: 'sk-test-canary-0002' },
        1,
      ],
    ]
    for (const [method, path, body, lines] of cases) {
      const entries = s.actions.entries.length
      const admits = s.actions.admitCalls
      const response = await s.handle(call(method, path, s.ops, body))
      expect(`${method} ${path} ${response.status}`).toBe(
        `${method} ${path} 200`,
      )
      expect(`${path} admits ${s.actions.admitCalls - admits}`).toBe(
        `${path} admits 1`,
      )
      expect(`${path} lines ${s.actions.entries.length - entries}`).toBe(
        `${path} lines ${lines}`,
      )
    }
    const actions = s.actions.entries
      .slice(s.base.entries)
      .map(entry => entry.action)
    expect(actions).toEqual([
      'provider.default.set',
      'provider.assign',
      'provider.context.set',
      'provider.autocompact',
      'provider.probe.latency',
      'provider.apply',
      'provider.apply',
      'provider.secret.set',
    ])
    // The key went to the port and nowhere else.
    expect(JSON.stringify(s.actions.entries)).not.toContain('sk-test-canary')
  })

  test('reads, polls and dry runs ask nothing and record nothing', async () => {
    const s = await setup()
    for (const path of PAGES) await text(s.handle, page(path, s.ops))
    for (const path of [...FRAGMENTS, ...JSON_READS, '/v0/providers/catalog']) {
      await text(s.handle, call('GET', path, s.ops))
    }
    const dry = await s.handle(
      call('POST', '/v0/providers/apply', s.ops, {
        nodes: ['node-a'],
        dryRun: true,
        profileId: 'chat-svc',
      }),
    )
    expect(dry.status).toBe(200)
    expect(s.actions.entries.length).toBe(s.base.entries)
    expect(s.actions.admitCalls).toBe(s.base.admits)
    // And no read asked a node for anything.
    expect(s.providers.calls).not.toContain('refreshNode')
  })

  test('跳过测连 is one line the route writes, and unrecorded it stops the switch', async () => {
    const s = await setup()
    const path = '/v0/providers/profiles/deepseek/skip-probe'
    const response = await s.handle(call('POST', path, s.ops, {}))
    expect(response.status).toBe(200)
    expect(await jsonOf(response)).toEqual({
      recorded: true,
      profileId: 'deepseek',
    })
    expect(s.actions.admitCalls - s.base.admits).toBe(1)
    const lines = s.actions.entries.slice(s.base.entries)
    expect(
      lines.map(line => [line.action, line.target, line.outcome, line.code]),
    ).toEqual([['provider.probe.skip', 'deepseek', 'ok', undefined]])
    expect(lines[0]?.subject).toMatch(/^u:/)
    // The port was read, not written: nothing about the profile changed.
    expect(s.providers.writes).toEqual([])

    // A profile that is not there: 404, no line.
    const gone = await s.handle(
      call('POST', '/v0/providers/profiles/nope/skip-probe', s.ops, {}),
    )
    expect(gone.status).toBe(404)
    expect(s.actions.entries.length - s.base.entries).toBe(1)

    // The ledger takes the admit but not the line: 503, and the page script
    // does not go on to assign or apply (providers.browser.test.ts).
    s.actions.recordResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'disk full' },
    }
    const unrecorded = await s.handle(call('POST', path, s.ops, {}))
    expect(unrecorded.status).toBe(503)
    const body = (await jsonOf(unrecorded)) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe('unavailable')
    expect(body.error.message).toContain('切换没有执行')
    expect(s.actions.entries.length - s.base.entries).toBe(1)

    // A closed ledger answers before the profile is even read.
    s.actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'closed' },
    }
    const reads = s.providers.calls.length
    const closed = await s.handle(call('POST', path, s.ops, {}))
    expect(closed.status).toBe(503)
    expect(s.providers.calls.length).toBe(reads)
  })

  test('a closed ledger stops a write before the port', async () => {
    const s = await setup()
    s.actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'closed' },
    }
    const response = await s.handle(
      call('PUT', '/v0/providers/default', s.ops, { profileId: null }),
    )
    expect(response.status).toBe(503)
    expect(s.providers.writes).toEqual([])
  })

  test('the form sends only what it edits: preset, plan and evaluation are the hub’s', async () => {
    const s = await setup()
    const response = await s.handle(
      call('POST', '/v0/providers/profiles', s.ops, {
        presetId: 'kimi',
        site: 'intl',
        profile: {
          id: 'kimi-intl',
          name: 'Kimi 国际',
          lane: 'anthropic',
          baseUrl: 'https://api.moonshot.ai/anthropic',
          evaluated: { at: '2026-10-01', by: 'me', evidence: 'none' },
          plan: 'plan',
          presetId: 'deepseek',
          models: [],
        },
        secrets: { k1: 'sk-test-canary-0003' },
      }),
    )
    expect(response.status).toBe(200)
    const saved = s.providers.writes.at(-1)?.input as {
      profile: Record<string, unknown>
      ifMatch: number | null
      secrets: Record<string, string>
    }
    expect(saved.ifMatch).toBeNull()
    expect(saved.profile.id).toBe('kimi-intl')
    expect(saved.profile.evaluated).toBe(false)
    expect(saved.profile.plan).toBe('paygo')
    expect(saved.profile.presetId).toBe('kimi')
    expect(saved.profile.site).toBe('intl')
    expect(saved.profile.revision).toBeUndefined()
    expect(saved.secrets).toEqual({ k1: 'sk-test-canary-0003' })
  })

  test('If-Match: body or header, and they must agree', async () => {
    const s = await setup()
    const edit = { name: 'DeepSeek 2' }
    let response = await s.handle(
      asSession('PUT', '/v0/providers/profiles/deepseek', s.ops.sid, {
        body: { profile: edit },
        extra: { 'if-match': '3' },
      }),
    )
    expect(response.status).toBe(200)
    response = await s.handle(
      asSession('PUT', '/v0/providers/profiles/deepseek', s.ops.sid, {
        body: { profile: edit, ifMatch: 4 },
        extra: { 'if-match': '3' },
      }),
    )
    expect(response.status).toBe(400)
    response = await s.handle(
      call('PUT', '/v0/providers/profiles/deepseek', s.ops, { profile: edit }),
    )
    expect(response.status).toBe(400)
  })

  test('failures map to their status, with the detail in the message', async () => {
    const s = await setup()
    let response = await s.handle(
      call('PUT', '/v0/providers/profiles/deepseek', s.ops, {
        ifMatch: 1,
        profile: { name: 'x' },
      }),
    )
    expect(response.status).toBe(409)
    let body = (await response.json()) as {
      error: { code: string; message: string; fields?: string[] }
    }
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toBe(
      '此服务已被他人修改 · 刷新后再保存 · 被改动的字段 models',
    )

    response = await s.handle(
      call('DELETE', '/v0/providers/profiles/deepseek', s.ops, { ifMatch: 3 }),
    )
    expect(response.status).toBe(409)
    body = (await response.json()) as typeof body
    expect(body.error.code).toBe('in_use')
    expect(body.error.message).toContain('在用的节点 node-a')

    s.providers.nextFailure = { code: 'unreachable', message: '节点够不着' }
    response = await s.handle(
      call('PUT', '/v0/providers/nodes/node-a/autocompact', s.ops, {
        value: '200k',
      }),
    )
    expect(response.status).toBe(502)
    response = await s.handle(call('GET', '/v0/providers/nodes/nope', s.ops))
    expect(response.status).toBe(404)
  })

  test('a partial apply answers each node, the conflict with its keys', async () => {
    const s = await setup()
    const response = await s.handle(
      call('POST', '/v0/providers/apply', s.ops, {
        nodes: ['node-a', 'node-b'],
        sessions: 'reset',
      }),
    )
    expect(response.status).toBe(200)
    const { results } = (await response.json()) as {
      results: {
        node: string
        outcome: string
        code?: string
        diffKeys?: string[]
        pending?: boolean
      }[]
    }
    expect(results.map(r => `${r.node} ${r.outcome} ${r.code ?? ''}`)).toEqual([
      'node-a ok ',
      'node-b refused conflict',
    ])
    expect(results[1]?.diffKeys).toEqual(['env.ANTHROPIC_MODEL'])
    const forced = await s.handle(
      call('POST', '/v0/providers/apply', s.ops, {
        nodes: ['node-b'],
        force: true,
      }),
    )
    expect(forced.status).toBe(200)
    expect(s.actions.entries.at(-1)?.action).toBe('provider.apply.force')
  })

  test('export is a file for ops, without a key or a fingerprint', async () => {
    const s = await setup()
    const response = await s.handle(
      asSession('GET', '/v0/providers/export', s.ops.sid, { header: false }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="qianmo-providers-2026-10-03.json"',
    )
    const body = await response.text()
    expect(body).not.toContain('fp1:')
    expect(body).not.toContain('sk-')
    expect(s.actions.admitCalls).toBe(s.base.admits)
  })
})

// ---------------------------------------------------------------------------
// Follow-ups 3 and 4
// ---------------------------------------------------------------------------

describe('what a line allows', () => {
  test('a Claude model on the Anthropic line says the setting does not reach the wire', async () => {
    const s = await setup()
    const html = await text(
      s.handle,
      page('/providers/new?preset=anthropic', s.ops),
    )
    expect(html).toContain(
      '<p class="note prov-hint field-wide" data-family-note>Claude 系模型在 Anthropic 线上按内置模型族判断 · 该线路不受此设置控制</p>',
    )
    const other = await text(
      s.handle,
      page('/providers/new?preset=deepseek', s.ops),
    )
    expect(other).toContain('data-family-note hidden>')
  })

  test('总是发送 on the OpenAI Chat line follows what the nodes reported', async () => {
    const s = await setup()
    // chat-svc is expected on node-b, which reports it cannot honour it.
    let html = await text(s.handle, page('/providers/profiles/chat-svc', s.ops))
    expect(html).toContain('data-chat-always="0"')
    expect(html).toMatch(
      /<option value="always" data-chat-gate data-explicit disabled>/,
    )
    expect(html).toContain('节点 node-b 报告 OpenAI Chat 线路发不了显式 effort')
    // Once node-b reports it can, the choice opens; nothing here is a constant.
    const b = s.providers.nodes.get('node-b')
    const actual = b?.actual
    if (b === undefined || actual === null || actual === undefined)
      throw new Error('fixture')
    s.providers.nodes.set('node-b', {
      ...b,
      actual: {
        ...actual,
        capabilities: {
          ...actual.capabilities,
          chatEffortHonorsOverride: true,
        },
      },
    })
    html = await text(s.handle, page('/providers/profiles/chat-svc', s.ops))
    expect(html).toContain('data-chat-always="1"')
    expect(html).toMatch(/<option value="always" data-chat-gate data-explicit>/)
  })
})

// ---------------------------------------------------------------------------
// The chat page's label (§6.3.8)
// ---------------------------------------------------------------------------

describe('the chat label', () => {
  test('the fragment names the model the node computed, and its last switch', async () => {
    const s = await setup()
    const html = await text(
      s.handle,
      call(
        'GET',
        `/fragments/providers/chat?target=${encodeURIComponent('qianmo://node-a/planner')}`,
        s.member,
      ),
    )
    expect(html).toContain('模型 · deepseek-v4-pro')
    expect(html).toContain('已切换到 DeepSeek · deepseek-v4-pro')
    expect(html).toContain(`data-at="${NOW - 3_600_000}"`)
    const none = await text(
      s.handle,
      call(
        'GET',
        `/fragments/providers/chat?target=${encodeURIComponent('qianmo://node-c/planner')}`,
        s.member,
      ),
    )
    expect(none).toBe('')
    const unknown = await text(
      s.handle,
      call(
        'GET',
        `/fragments/providers/chat?target=${encodeURIComponent('qianmo://elsewhere/planner')}`,
        s.member,
      ),
    )
    expect(unknown).toBe('')
  })
})
