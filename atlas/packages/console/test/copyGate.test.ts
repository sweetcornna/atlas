// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The copy gate, widened to everything that can reach the screen (I1), and
 * the error mapping that makes it pass (C5). One file, because the two were
 * landed together and one without the other is either a gate that fails on
 * twenty server strings or a mapping nothing holds to.
 *
 * The rule (`console-audit.md` §1, `providers-console-m1.md` §6.6): visible
 * copy is calm, short and professional; no `。，、`, no exclamation marks, no
 * emoji; facts are separated by ` · `. Before this file the gates checked the
 * server-rendered pages of the ledger. What they did not see:
 *
 * 1. **Every document** — the login door, the invitation card, the credential
 *    page, the error pages, the conversation page, a page whose ports failed.
 * 2. **Every string a page script writes** — `say`, `toast`, `setText` and
 *    the rest, read out of the scripts each page actually serves.
 * 3. **The error mapping itself** — every phrase it can produce.
 * 4. **Every message the server and its ports can send**, as the page shows
 *    it: each string literal in the console's source and its host ports,
 *    through {@link humanizeError}. The positive control runs the same corpus
 *    through an identity mapping and requires it to fail.
 *
 * The one text exempt is the original of a failure, folded under 详情 and
 * marked `data-raw`: it is the port's or the transport's own words, kept
 * verbatim on purpose so it can be pasted into a ticket.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONSOLE_CLIENT_JS } from '../src/assets/client.js'
import { ROUTES } from '../src/routes/index.js'
import {
  ERROR_CODES,
  ERROR_FALLBACK,
  ERROR_PATTERNS,
  ERROR_STATUSES,
  humanizeError,
  isCleanLine,
  type HumanError,
} from '../src/view/errors.js'
import {
  ADMIN as ACCOUNTS_ADMIN,
  BASE as ACCOUNTS_BASE,
  accountsHarness,
  asBearer,
  asSession,
  formPost,
  invite,
  person,
} from './accountsHarness.js'
import { ADMIN, VIEW, browse, pageHarness } from './pageHarness.js'

const BANNED = ['。', '，', '、', '！', '!'] as const
const EMOJI = /\p{Extended_Pictographic}/u

/** What a person reads: no style, no script, no markup, no folded original. */
function readable(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<pre class="raw" data-raw>[\s\S]*?<\/pre>/g, '')
    .replace(/<[^>]*>/g, ' ')
}

/** The attribute copy a person also reads: placeholders, labels, tooltips. */
function attributeCopy(html: string): string[] {
  const out: string[] = []
  const body = html.replace(/<script>[\s\S]*?<\/script>/g, '')
  for (const match of body.matchAll(
    /\s(?:placeholder|aria-label|title)="([^"]*)"/g,
  )) {
    out.push(
      (match[1] ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    )
  }
  return out
}

/** Every rule this gate holds a string to, as one list of findings. */
function violations(where: string, text: string): string[] {
  const found: string[] = []
  for (const mark of BANNED) {
    if (text.includes(mark)) found.push(`${where}: ${mark}`)
  }
  if (EMOJI.test(text)) found.push(`${where}: emoji`)
  return found
}

function checkDocument(where: string, html: string): string[] {
  const found = violations(where, readable(html))
  for (const value of attributeCopy(html)) {
    found.push(...violations(`${where} [attr ${value.slice(0, 24)}]`, value))
  }
  return found
}

/** The script a document serves, or empty. */
function scriptOf(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  return match?.[1] ?? ''
}

/**
 * The quoted string literals in a script that a person could read: the ones
 * with CJK in them. Identifiers, selectors and URLs are not copy.
 */
function cjkLiterals(script: string): string[] {
  const out: string[] = []
  for (const match of script.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const value = match[1] ?? ''
    if (/[㐀-鿿]/.test(value)) out.push(value)
  }
  return out
}

describe('every document keeps the copy rules (I1)', () => {
  test('every area page, for the admin and the view token', async () => {
    const found: string[] = []
    for (const token of [ADMIN, VIEW]) {
      const h = pageHarness({
        chat: true,
        nodeServers: [{ node: 'tokyo-1', server: 'p11' }],
      })
      for (const module of ROUTES) {
        const response = await h.handle(browse(module.area.href, token))
        if (response.status === 404) continue
        found.push(
          ...checkDocument(
            `${module.area.href} as ${token === ADMIN ? 'admin' : 'view'}`,
            await response.text(),
          ),
        )
      }
    }
    expect(found).toEqual([])
  })

  test('pages whose ports failed: the strip says the line, the original is folded', async () => {
    const h = pageHarness({ chat: true })
    h.registry.listResult = {
      ok: false,
      failure: {
        code: 'unreachable',
        message:
          'http://127.0.0.1:38798 · Unable to connect. Is the computer able to access the url?',
      },
    }
    h.audit.readResult = {
      ok: false,
      failure: {
        code: 'unreachable',
        message: '/srv/qianmo/audit.ndjson · EACCES: permission denied, open',
      },
    }
    // A developer's sentence, as an older port wrote them: the punctuation is
    // in the original and must not reach the line.
    h.wake.send = () =>
      Promise.resolve({
        ok: false,
        failure: { code: 'unsupported', message: '唤醒不可用，请检查配置。' },
      })
    const found: string[] = []
    for (const path of ['/', '/nodes', '/nodes/tokyo-1', '/audit', '/alerts']) {
      const response = await h.handle(browse(path, ADMIN))
      const html = await response.text()
      found.push(...checkDocument(path, html))
      // The transport's own words are on the page — under 详情, not in the line.
      if (path === '/nodes') {
        expect(html).toContain('注册中心不可达 · 无法连接')
        expect(html).toContain(
          '<pre class="raw" data-raw>http://127.0.0.1:38798',
        )
      }
      if (path === '/audit') expect(html).toContain('没有读写权限')
    }
    expect(found).toEqual([])
  })

  test('positive control: a failure strip that printed the original would fail the gate', async () => {
    const h = pageHarness()
    h.registry.listResult = {
      ok: false,
      failure: {
        code: 'unreachable',
        message: '注册中心返回了错误，请稍后重试。',
      },
    }
    const html = await (await h.handle(browse('/nodes', ADMIN))).text()
    // The original is on the page, folded; the line is the mapped one.
    expect(html).toContain('注册中心返回了错误，请稍后重试。')
    expect(checkDocument('/nodes', html)).toEqual([])
    // The same document with the fold opened into the sentence is caught.
    const unfolded = html.replace(
      /<pre class="raw" data-raw>([\s\S]*?)<\/pre>/g,
      '<span>$1</span>',
    )
    expect(checkDocument('/nodes', unfolded).length).toBeGreaterThan(0)
  })

  test('the doors, the error pages and the conversation page', async () => {
    const found: string[] = []
    const h = pageHarness({ chat: true })
    const pages: [string, Request][] = [
      ['login', browse('/login')],
      ['404 signed in', browse('/nope', ADMIN)],
      ['404 signed out', browse('/nope')],
      ['403 card', browse('/chat', VIEW)],
      ['chat', browse('/chat', ADMIN)],
    ]
    for (const [where, request] of pages) {
      const response = await h.handle(request)
      found.push(...checkDocument(where, await response.text()))
    }

    const a = accountsHarness({ accounts: { breakGlass: true } })
    const ops = await person(a.handle, 'ops')
    const { token } = await invite(a.handle, 'member')
    const more: [string, Request][] = [
      ['accounts login', new Request(`${ACCOUNTS_BASE}/login`)],
      ['invite card', new Request(`${ACCOUNTS_BASE}/invite`)],
      ['credential page', formPost('/invite', { invite: token })],
      ['spent invite', formPost('/invite', { invite: token })],
      [
        'access as ops',
        asSession('GET', '/access', ops.sid, { header: false }),
      ],
      ['break-glass', asBearer('GET', '/', ACCOUNTS_ADMIN)],
    ]
    for (const [where, request] of more) {
      const response = await a.handle(request)
      found.push(...checkDocument(where, await response.text()))
    }
    expect(found).toEqual([])
  })
})

describe('every string a page script writes keeps the copy rules (I1)', () => {
  test('the scripts each page serves', async () => {
    const h = pageHarness({ chat: true })
    const scripts = new Map<string, string>()
    for (const module of ROUTES) {
      const response = await h.handle(browse(module.area.href, ADMIN))
      const script = scriptOf(await response.text())
      if (script !== '') scripts.set(module.area.href, script)
    }
    // The scan is looking at something: the runtime, and the pages' own.
    expect(scripts.size).toBeGreaterThanOrEqual(8)
    let literals = 0
    const found: string[] = []
    for (const [path, script] of scripts) {
      for (const literal of cjkLiterals(script)) {
        literals += 1
        found.push(...violations(`${path} '${literal}'`, literal))
      }
    }
    expect(literals).toBeGreaterThan(100)
    expect(found).toEqual([])
  })
})

// --- the terms (I2) --------------------------------------------------------

/** One "不用" entry of the glossary in `docs/dev/console.md` §5.2.1. */
interface BannedTerm {
  readonly term: string
  readonly found: (text: string) => boolean
}

/**
 * The glossary's banned spellings, read off the document itself so the table
 * and the gate cannot disagree: every code span in the second column, a
 * `/…/` one as a regular expression.
 */
function bannedTerms(): BannedTerm[] {
  const doc = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'docs', 'dev', 'console.md'),
    'utf8',
  )
  const block =
    /<!-- glossary:start -->([\s\S]*?)<!-- glossary:end -->/.exec(doc)?.[1] ??
    ''
  const out: BannedTerm[] = []
  for (const row of block.split('\n')) {
    if (
      !row.startsWith('|') ||
      row.startsWith('| ---') ||
      row.startsWith('| 用 ')
    )
      continue
    const banned = row.split(' | ')[1] ?? ''
    for (const match of banned.matchAll(/`([^`]+)`/g)) {
      const term = match[1] ?? ''
      if (term.length > 2 && term.startsWith('/') && term.endsWith('/')) {
        const pattern = new RegExp(term.slice(1, -1))
        out.push({ term, found: text => pattern.test(text) })
      } else {
        out.push({ term, found: text => text.includes(term) })
      }
    }
  }
  return out
}

/** Every place a term could reach a person, as (where, text) pairs. */
async function everythingShown(): Promise<[string, string][]> {
  const out: [string, string][] = []
  const add = (where: string, html: string): void => {
    out.push([where, readable(html)])
    for (const value of attributeCopy(html))
      out.push([`${where} [attr]`, value])
    for (const literal of cjkLiterals(scriptOf(html))) {
      out.push([`${where} [script]`, literal])
    }
  }
  for (const token of [ADMIN, VIEW]) {
    const h = pageHarness({
      chat: true,
      wake: false,
      nodeServers: [{ node: 'tokyo-1', server: 'p11' }],
    })
    for (const module of ROUTES) {
      const response = await h.handle(browse(module.area.href, token))
      add(
        `${module.area.href} as ${token === ADMIN ? 'admin' : 'view'}`,
        await response.text(),
      )
    }
    h.registry.listResult = { ok: true, value: [] }
    add('/nodes empty', await (await h.handle(browse('/nodes', token))).text())
  }
  const h = pageHarness({ chat: true })
  for (const path of ['/login', '/nope']) {
    add(path, await (await h.handle(browse(path))).text())
  }
  add('403 card', await (await h.handle(browse('/chat', VIEW))).text())
  const a = accountsHarness({ accounts: { breakGlass: true } })
  const ops = await person(a.handle, 'ops')
  add(
    'break-glass',
    await (await a.handle(asBearer('GET', '/', ACCOUNTS_ADMIN))).text(),
  )
  add(
    'access as ops',
    await (
      await a.handle(asSession('GET', '/access', ops.sid, { header: false }))
    ).text(),
  )
  // What the console's own code can say: every CJK literal in its source.
  for (const literal of messageCorpus(
    sourceFiles().filter(isConsoleSource),
    withoutPinnedBlock,
  )) {
    out.push(['source', literal])
  }
  return out
}

/**
 * `resolveTokens` is pinned byte for byte to its pre-accounts text
 * (`invites.test.ts`, tenancy-m1.md §3.4), and its one message is a startup
 * error on the command line, never a page. It keeps its words.
 */
function withoutPinnedBlock(file: string, text: string): string {
  if (!file.endsWith(`${join('src', 'auth.ts')}`)) return text
  const start = text.indexOf('export function resolveTokens(')
  const end = text.indexOf('\n}\n', start)
  return start < 0 || end < 0
    ? text
    : text.slice(0, start) + text.slice(end + 2)
}

describe('one name for each thing (I2)', () => {
  test('the glossary is there to be read', () => {
    const terms = bannedTerms().map(banned => banned.term)
    expect(terms.length).toBeGreaterThanOrEqual(10)
    expect(terms).toContain('阡陌 console')
    expect(terms).toContain('审计日志')
  })

  test('no banned spelling reaches a page, a script or a message', async () => {
    const terms = bannedTerms()
    const shown = await everythingShown()
    expect(shown.length).toBeGreaterThan(500)
    const found: string[] = []
    for (const [where, text] of shown) {
      for (const banned of terms) {
        if (banned.found(text))
          found.push(`${where}: ${banned.term} in ${text.trim().slice(0, 60)}`)
      }
    }
    expect(found).toEqual([])
  })

  test('positive control: the spellings this commit retired would be caught', () => {
    const terms = bannedTerms()
    for (const old of [
      '<title>阡陌 console · 总览 · tokyo-hub</title>',
      '该页面需要 admin 令牌',
      '审计日志不可达 · 见证端点 · 无法连接',
      '速率预算 600 / 分',
      '还没有节点 · 注册第一个',
      '还没有打开会话 · 在左边选一个智能体开始',
      '请在启动 occ console 时用 --node-server 指定',
    ]) {
      expect(terms.filter(banned => banned.found(old)).length).toBeGreaterThan(
        0,
      )
    }
    // …and the current spellings pass.
    for (const now of [
      '阡陌控制台 · 总览',
      '速率预算 600 / 分钟',
      '还没有节点',
    ]) {
      expect(terms.filter(banned => banned.found(now))).toEqual([])
    }
  })

  test('a row never mixes the two duration spellings', async () => {
    const h = pageHarness()
    const html = await (await h.handle(browse('/nodes', ADMIN))).text()
    const roster = readable(
      html.slice(
        html.indexOf('id="roster"'),
        html.indexOf('</section>', html.indexOf('id="roster"')),
      ),
    )
    expect(roster).toMatch(/租约 \d+[smhd]/)
    expect(roster).toMatch(/剩余 \d+[smhd]/)
    // 1 秒前 is a relative time, not a duration.
    expect(roster).not.toMatch(/\d+ (秒|分|小时|天)(?![前后])/)
  })
})

// --- the mapping (C5) ------------------------------------------------------

/** The console's own source and its host ports: where every message is written. */
const SOURCES = [
  join(import.meta.dir, '..', 'src'),
  join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'handlers'),
]

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string, filter: (name: string) => boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path, filter)
      } else if (filter(entry.name)) {
        out.push(path)
      }
    }
  }
  walk(SOURCES[0] as string, name => name.endsWith('.ts'))
  const handlers = SOURCES[1] as string
  for (const name of readdirSync(handlers)) {
    if (/^(console|residentWake).*\.ts$/.test(name)) {
      out.push(join(handlers, name))
    }
  }
  return out
}

/** A file of this package, rather than of its host. */
function isConsoleSource(file: string): boolean {
  return file.startsWith(SOURCES[0] as string)
}

/**
 * Every string literal with CJK in it, outside comments, with each template
 * hole filled by a sample value. Over-inclusive on purpose: a page label is
 * not a message, but it is held to the same rule and costs nothing to check.
 */
function messageCorpus(
  files: readonly string[] = sourceFiles(),
  prune: (file: string, text: string) => string = (_file, text) => text,
): string[] {
  const out = new Set<string>()
  for (const file of files) {
    const text = prune(file, readFileSync(file, 'utf8'))
      .split('\n')
      .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    for (const match of text.matchAll(
      /'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
    )) {
      const value = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, 'x')
      if (/[㐀-鿿]/.test(value) && value.length < 400) out.add(value)
    }
  }
  return [...out]
}

/** What the transports themselves say (`console-audit.md` §2.2). */
const TRANSPORT_TEXT = [
  'transport did not become ready within 15000ms',
  'transport did not become ready within 30000ms',
  'invalid endpoint: not-a-url',
  'Unable to connect. Is the computer able to access the url?',
  'Failed to fetch',
  'HTTP 401',
  'HTTP 503',
  'The operation timed out.',
  'connect ECONNREFUSED 127.0.0.1:38611',
  'ENOSPC: no space left on device, write',
  'EACCES: permission denied, open',
  'PSK unavailable',
  'E_CAP_INSUFFICIENT: capability does not cover task.request',
]

const CODES = [undefined, ...Object.keys(ERROR_CODES), 'unknown_code']
const STATUSES = [undefined, 400, 403, 404, 409, 500, 503, 599]

function visibleAfter(map: (raw: string) => HumanError): string[] {
  const found: string[] = []
  for (const raw of [...messageCorpus(), ...TRANSPORT_TEXT]) {
    const shown = map(raw).text
    found.push(...violations(raw.slice(0, 40), shown))
  }
  return found
}

describe('the error mapping (C5)', () => {
  test('every phrase it can produce keeps the copy rules', () => {
    const phrases = [
      ...ERROR_PATTERNS.map(([, phrase]) => phrase),
      ...Object.values(ERROR_CODES),
      ...Object.values(ERROR_STATUSES),
      ERROR_FALLBACK,
    ]
    for (const phrase of phrases) {
      expect(`${phrase} ${isCleanLine(phrase)}`).toBe(`${phrase} true`)
      expect(violations(phrase, phrase)).toEqual([])
    }
  })

  test('the corpus has the strings the audit counted, and they are unclean as written', () => {
    const corpus = [...messageCorpus(), ...TRANSPORT_TEXT]
    expect(corpus.length).toBeGreaterThan(300)
    const unclean = corpus.filter(raw =>
      BANNED.some(mark => raw.includes(mark)),
    )
    // console-audit.md I1: twenty server strings with 。，；： reached the page.
    expect(unclean.length).toBeGreaterThanOrEqual(20)
  })

  test('positive control: shown as written, the corpus fails the gate', () => {
    expect(
      visibleAfter(raw => ({ text: raw, detail: '' })).length,
    ).toBeGreaterThanOrEqual(20)
  })

  test('through the mapping, every message the server or a port can send is a clean line', () => {
    expect(visibleAfter(raw => humanizeError({ message: raw }))).toEqual([])
    for (const code of CODES) {
      for (const status of STATUSES) {
        for (const raw of TRANSPORT_TEXT) {
          const shown = humanizeError({
            ...(code === undefined ? {} : { code }),
            ...(status === undefined ? {} : { status }),
            message: raw,
          }).text
          expect(violations(raw, shown)).toEqual([])
        }
      }
    }
  })

  test('known transport text reads as the fixed phrase, the original kept as detail', () => {
    expect(
      humanizeError({
        code: 'unreachable',
        message: 'transport did not become ready within 15000ms',
      }),
    ).toEqual({
      text: '连接超时',
      detail: 'transport did not become ready within 15000ms',
    })
    expect(
      humanizeError({
        code: 'unreachable',
        message: 'http://127.0.0.1:38798 · Unable to connect.',
      }).text,
    ).toBe('无法连接')
    // A clean leading noun stays: the page's subject does not say which half.
    expect(
      humanizeError({
        code: 'unreachable',
        message: '见证端点 · connect ECONNREFUSED 127.0.0.1:1',
      }).text,
    ).toBe('见证端点 · 无法连接')
    // A protocol code stays on the line: the runbooks are written against it.
    expect(
      humanizeError({
        code: 'refused',
        message: 'E_CAP_INSUFFICIENT: capability does not cover task.request',
      }).text,
    ).toBe('对端拒绝执行 · E_CAP_INSUFFICIENT')
  })

  test('a message that already keeps the rules is shown as written', () => {
    expect(
      humanizeError({
        code: 'conflict',
        message: '此服务已被他人修改 · 刷新后再保存',
      }),
    ).toEqual({ text: '此服务已被他人修改 · 刷新后再保存', detail: '' })
    // A developer sentence is not.
    expect(
      humanizeError({
        code: 'forbidden',
        status: 403,
        message: '该操作需要管理令牌，当前凭据只有只读权限。',
      }).text,
    ).toBe('权限不足')
    // A code from Object.prototype is not a phrase.
    expect(
      humanizeError({ code: 'constructor', status: 400, message: 'bad: x' })
        .text,
    ).toBe('请求内容不合法')
  })

  test('the browser runtime maps every string exactly as the server does', () => {
    const start = CONSOLE_CLIENT_JS.indexOf('/* humanize:start */')
    const end = CONSOLE_CLIENT_JS.indexOf('/* humanize:end */')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const client = new Function(
      `${CONSOLE_CLIENT_JS.slice(start, end)}; return humanize;`,
    )() as (code: unknown, status: unknown, raw: unknown) => HumanError
    let compared = 0
    for (const raw of [...messageCorpus(), ...TRANSPORT_TEXT, '', '  ']) {
      for (const code of CODES) {
        for (const status of [undefined, 503]) {
          const server = humanizeError({
            ...(code === undefined ? {} : { code }),
            ...(status === undefined ? {} : { status }),
            message: raw,
          })
          expect(client(code, status, raw)).toEqual(server)
          compared += 1
        }
      }
    }
    expect(compared).toBeGreaterThan(1000)
  })
})
