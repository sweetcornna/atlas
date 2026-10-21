// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What an approval request's card says (P39, P40 §6): one per-tool table,
 * read by both places a person decides — the conversation front's card
 * (`frontApproval.ts`) and the approvals page (`approvals.ts`).
 *
 * The table exists twice, once for each side of the wire:
 * {@link approvalCard} for the server's pages and {@link APPROVAL_CARD_JS}
 * for the front's script, which builds its cards from `GET /v0/approvals`
 * without a round trip. `test/frontApproval.test.ts` runs both over the same
 * requests in every language and holds them equal, so they cannot drift.
 *
 * A card holds the title after the agent's name (「ops 想更改设置」), one
 * line, label/value rows, a preformatted detail, the panel link, a tag, a
 * note, and what may be done with it:
 *
 * - **A settings change** (P40 §4.2) is drawn from the hub's `input.card`
 *   only — area · setting, the value now and the value after (one 新建 row
 *   when nothing is there yet), the role it needs and the panel it lives on.
 *   The raw `input.input`, secrets' markers included, is never drawn. A
 *   change that needs ops shows 需要运维批准 to anybody else, without
 *   buttons; a card that cannot be read can only be refused.
 * - **Mail, calendar, 云端电脑, elevated commands and memory** keep the
 *   facts they always showed; anything else is its name and arguments.
 * - **`resume`**: 批准 after the agent's turn has ended may continue the
 *   work (批准并继续) — everything but the tools the node approves fresh on
 *   every call (its `freshApprovalTool`). **`window`**: 批准 5 分钟 is on
 *   offer — not for those tools, and not for a settings change, which is
 *   approved once at a time (§4.1).
 */

import type { Lang } from '../i18n.js'
import { escapeHtml } from './escape.js'

/** The tool a settings change is approved as (§3.2). */
export const SETTINGS_CHANGE_TOOL = 'qianmo_settings_change'

interface Verbs {
  readonly settings: string
  readonly command: string
  readonly network: string
  readonly github: string
  readonly mail: string
  readonly calendar: string
  readonly desktop: string
  readonly memory: string
  readonly other: string
}

/** The words a card is made of, in the reader's language. */
export interface CardWords {
  /** After the agent's name: 「ops 想更改设置」. */
  readonly verbs: Verbs
  readonly now: string
  readonly next: string
  readonly created: string
  readonly panel: string
  readonly needsOps: string
  readonly opsTag: string
  readonly incomplete: string
  readonly to: string
  readonly subject: string
  readonly when: string
  readonly where: string
  readonly savedTo: string
}

export const CARD_WORDS: Readonly<Record<Lang, CardWords>> = {
  'zh-CN': {
    verbs: {
      settings: '想更改设置',
      command: '想执行命令',
      network: '想联网读取',
      github: '想操作 GitHub',
      mail: '想发送邮件',
      calendar: '想新建日程',
      desktop: '想操作云端电脑',
      memory: '想写入记忆',
      other: '想调用工具',
    },
    now: '现在',
    next: '改为',
    created: '新建',
    panel: '在面板里看',
    needsOps: '需要运维批准',
    opsTag: '需要运维',
    incomplete: '内容不完整 · 只能拒绝',
    to: '收件人',
    subject: '主题',
    when: '时间',
    where: '地点',
    savedTo: '写入',
  },
  en: {
    verbs: {
      settings: 'wants to change a setting',
      command: 'wants to run a command',
      network: 'wants to read from the network',
      github: 'wants a GitHub action',
      mail: 'wants to send an email',
      calendar: 'wants to create an event',
      desktop: 'wants to use the cloud computer',
      memory: 'wants to save a memory',
      other: 'wants to use a tool',
    },
    now: 'Now',
    next: 'Change to',
    created: 'New',
    panel: 'View in panel',
    needsOps: 'Needs an operator to approve',
    opsTag: 'Operator',
    incomplete: 'Incomplete · deny only',
    to: 'To',
    subject: 'Subject',
    when: 'When',
    where: 'Where',
    savedTo: 'Saved to',
  },
  ja: {
    verbs: {
      settings: 'が設定の変更を求めています',
      command: 'がコマンドの実行を求めています',
      network: 'がネットワークの読み取りを求めています',
      github: 'が GitHub の操作を求めています',
      mail: 'がメールの送信を求めています',
      calendar: 'が予定の作成を求めています',
      desktop: 'がクラウド PC の操作を求めています',
      memory: 'が記憶の保存を求めています',
      other: 'がツールの呼び出しを求めています',
    },
    now: '現在',
    next: '変更後',
    created: '新規',
    panel: 'パネルで見る',
    needsOps: '運用者の承認が必要です',
    opsTag: '運用者',
    incomplete: '内容が不完全 · 拒否のみ',
    to: '宛先',
    subject: '件名',
    when: '日時',
    where: '場所',
    savedTo: '保存先',
  },
}

/** Which row of the table drew the card. */
type CardKind =
  | 'settings'
  | 'desktop'
  | 'mail'
  | 'calendar'
  | 'memory'
  | 'command'
  | 'network'
  | 'github'
  | 'other'

interface ApprovalCard {
  readonly kind: CardKind
  readonly title: string
  readonly what: string
  /** Label, value, and 1 for the value after a change. */
  readonly rows: readonly (readonly [string, string, 0 | 1])[]
  readonly detail: string
  /** A path on this console, or empty. */
  readonly page: string
  readonly tag: string
  readonly note: string
  /** One line for a notification. */
  readonly summary: string
  readonly allow: boolean
  readonly deny: boolean
  readonly resume: boolean
  readonly window: boolean
}

interface Mutable {
  kind: CardKind
  title: string
  what: string
  rows: (readonly [string, string, 0 | 1])[]
  detail: string
  page: string
  tag: string
  note: string
  summary: string
  allow: boolean
  deny: boolean
  resume: boolean
  window: boolean
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(value: string, n: number): string {
  return value.length > n ? `${value.slice(0, n)}…` : value
}

/** A path on this console: `/…`, not `//host` or `/\host`, no space or control. */
function consolePath(page: string): boolean {
  if (!/^\/(?![/\\])/.test(page) || /\s/.test(page) || page.length > 512)
    return false
  for (let i = 0; i < page.length; i++) {
    const code = page.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
  }
  return true
}

/** The tools the node approves fresh on every call (`freshApprovalTool`). */
function freshTool(name: string): boolean {
  return (
    name === 'qianmo_memory_write' ||
    name === 'qianmo_mail_send' ||
    name === 'qianmo_calendar_create' ||
    name.startsWith('qianmo_browser_') ||
    name.startsWith('qianmo_computer_') ||
    name.startsWith('qianmo_elevated_')
  )
}

/**
 * One request's card, for a reader with `role` (an account role). The
 * server's copy of {@link APPROVAL_CARD_JS}, line for line.
 */
export function approvalCard(
  item: {
    readonly toolName?: unknown
    readonly input?: unknown
    readonly agent?: unknown
  },
  w: CardWords,
  role: string,
): ApprovalCard {
  const verbs = w.verbs
  const name = String(item.toolName || '')
  const input = (
    item.input && typeof item.input === 'object' ? item.input : {}
  ) as Record<string, unknown>
  const agent = String(item.agent || '')
  const who = agent.replace(/^qianmo:\/\/[^/]*\//, '') || agent
  const fresh = freshTool(name)
  const card: Mutable = {
    kind: 'other',
    title: '',
    what: '',
    rows: [],
    detail: '',
    page: '',
    tag: '',
    note: '',
    summary: '',
    allow: true,
    deny: true,
    resume: !fresh,
    window: !fresh && name !== SETTINGS_CHANGE_TOOL,
  }
  const done = (kind: CardKind, verb: string): ApprovalCard => {
    card.kind = kind
    card.title = `${who} ${verb || ''}`
    if (!card.summary) card.summary = card.what || card.detail.slice(0, 120)
    return card
  }
  if (name === SETTINGS_CHANGE_TOOL) {
    const raw = input['card']
    const c = (raw && typeof raw === 'object' ? raw : null) as Record<
      string,
      unknown
    > | null
    if (
      c === null ||
      typeof c['area'] !== 'string' ||
      typeof c['label'] !== 'string' ||
      typeof c['next'] !== 'string' ||
      (c['current'] !== null && typeof c['current'] !== 'string') ||
      (c['role'] !== 'ops' && c['role'] !== 'member')
    ) {
      card.note = w.incomplete || ''
      card.allow = false
      return done('settings', verbs.settings)
    }
    const next = clip(c['next'], 400)
    card.what = `${clip(c['area'], 400)} · ${clip(c['label'], 400)}`
    card.rows =
      c['current'] === null
        ? [[w.created, next, 1]]
        : [
            [w.now, clip(c['current'] as string, 400), 0],
            [w.next, next, 1],
          ]
    const page = str(c['page'])
    if (consolePath(page)) card.page = page
    card.summary = str(c['title']) ? clip(str(c['title']), 200) : card.what
    if (c['role'] === 'ops') card.tag = w.opsTag || ''
    if (c['role'] === 'ops' && role !== 'ops') {
      card.allow = false
      card.deny = false
      card.tag = ''
      card.note = w.needsOps || ''
    }
    return done('settings', verbs.settings)
  }
  if (
    name.startsWith('qianmo_browser_') ||
    name.startsWith('qianmo_computer_')
  ) {
    card.what = clip(str(input['summary']) || str(input['op']) || name, 400)
    return done('desktop', verbs.desktop)
  }
  if (name === 'qianmo_mail_send') {
    const to = Array.isArray(input['to'])
      ? input['to'].map(String).join(', ')
      : str(input['to'])
    card.rows = [
      [w.to, clip(to, 400), 0],
      [w.subject, clip(str(input['subject']), 400), 0],
    ]
    card.detail = clip(str(input['body']), 600)
    return done('mail', verbs.mail)
  }
  if (name === 'qianmo_calendar_create') {
    card.what = clip(str(input['title']), 400)
    const end = str(input['end'])
    const span = str(input['start']) + (end ? ` – ${end}` : '')
    card.rows = [[w.when, clip(span, 400), 0]]
    const location = str(input['location'])
    if (location) card.rows.push([w.where, clip(location, 400), 0])
    card.detail = clip(str(input['notes']), 600)
    return done('calendar', verbs.calendar)
  }
  if (name === 'qianmo_memory_write') {
    card.what = clip(str(input['title']), 400)
    const body = str(input['body'])
    card.detail = clip(str(input['summary']) + (body ? `\n\n${body}` : ''), 600)
    const destination = str(input['destination'])
    if (destination) card.rows = [[w.savedTo, clip(destination, 400), 0]]
    return done('memory', verbs.memory)
  }
  const tool = name.startsWith('qianmo_elevated_') ? name.slice(16) : name
  if (tool === 'bash') {
    card.detail = clip(str(input['command']), 1200)
    return done('command', verbs.command)
  }
  if (tool === 'web_search') {
    card.what = clip(str(input['query']), 400)
    return done('network', verbs.network)
  }
  if (tool === 'read') {
    card.what = clip(
      String(input['path'] || input['paths'] || input['url'] || ''),
      400,
    )
    return done('network', verbs.network)
  }
  if (tool === 'github') {
    let line = str(input['op'])
    if (input['repo']) line += ` · ${String(input['repo'])}`
    if (input['title']) line += ` · ${String(input['title'])}`
    card.what = clip(line, 400)
    return done('github', verbs.github)
  }
  let json = ''
  try {
    json = JSON.stringify(input, null, 2) || ''
  } catch {
    json = ''
  }
  card.what = name
  card.detail = clip(json, 1200)
  return done('other', verbs.other)
}

/**
 * The page script's copy of {@link approvalCard}: `approvalCard(item, w,
 * role)` with the same fields, for the front to build cards from the JSON
 * it polls. Self-contained; the front puts it inside its own scope.
 */
export const APPROVAL_CARD_JS = `
function approvalCard(item, w, role) {
  var verbs = (w && w.verbs) || {};
  var name = String(item.toolName || '');
  var input = item.input && typeof item.input === 'object' ? item.input : {};
  var agent = String(item.agent || '');
  var who = agent.replace(/^qianmo:\\/\\/[^\\/]*\\//, '') || agent;
  function str(value) { return typeof value === 'string' ? value : ''; }
  function clip(value, n) { return value.length > n ? value.slice(0, n) + '…' : value; }
  function consolePath(page) {
    if (!/^\\/(?![\\/\\\\])/.test(page) || /\\s/.test(page) || page.length > 512) return false;
    for (var i = 0; i < page.length; i++) {
      var code = page.charCodeAt(i);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
    }
    return true;
  }
  // A tool the node approves fresh on every call (its freshApprovalTool) is
  // never carried into a continued turn, nor approved for a window.
  var fresh = name === 'qianmo_memory_write' || name === 'qianmo_mail_send' ||
    name === 'qianmo_calendar_create' || name.indexOf('qianmo_browser_') === 0 ||
    name.indexOf('qianmo_computer_') === 0 || name.indexOf('qianmo_elevated_') === 0;
  var card = { kind: 'other', title: '', what: '', rows: [], detail: '', page: '', tag: '', note: '', summary: '',
    allow: true, deny: true, resume: !fresh, window: !fresh && name !== 'qianmo_settings_change' };
  function done(kind, verb) {
    card.kind = kind;
    card.title = who + ' ' + (verb || '');
    if (!card.summary) card.summary = card.what || card.detail.slice(0, 120);
    return card;
  }
  if (name === 'qianmo_settings_change') {
    var c = input.card && typeof input.card === 'object' ? input.card : null;
    if (!c || typeof c.area !== 'string' || typeof c.label !== 'string' ||
        typeof c.next !== 'string' || (c.current !== null && typeof c.current !== 'string') ||
        (c.role !== 'ops' && c.role !== 'member')) {
      card.note = w.incomplete || '';
      card.allow = false;
      return done('settings', verbs.settings);
    }
    var next = clip(c.next, 400);
    card.what = clip(c.area, 400) + ' · ' + clip(c.label, 400);
    card.rows = c.current === null ? [[w.created, next, 1]] :
      [[w.now, clip(c.current, 400), 0], [w.next, next, 1]];
    var page = str(c.page);
    if (consolePath(page)) card.page = page;
    card.summary = str(c.title) ? clip(str(c.title), 200) : card.what;
    if (c.role === 'ops') card.tag = w.opsTag || '';
    if (c.role === 'ops' && role !== 'ops') {
      card.allow = false;
      card.deny = false;
      card.tag = '';
      card.note = w.needsOps || '';
    }
    return done('settings', verbs.settings);
  }
  if (name.indexOf('qianmo_browser_') === 0 || name.indexOf('qianmo_computer_') === 0) {
    card.what = clip(str(input.summary) || str(input.op) || name, 400);
    return done('desktop', verbs.desktop);
  }
  if (name === 'qianmo_mail_send') {
    var to = Array.isArray(input.to) ? input.to.map(String).join(', ') : str(input.to);
    card.rows = [[w.to, clip(to, 400), 0], [w.subject, clip(str(input.subject), 400), 0]];
    card.detail = clip(str(input.body), 600);
    return done('mail', verbs.mail);
  }
  if (name === 'qianmo_calendar_create') {
    card.what = clip(str(input.title), 400);
    var end = str(input.end);
    var span = str(input.start) + (end ? ' – ' + end : '');
    card.rows = [[w.when, clip(span, 400), 0]];
    var location = str(input.location);
    if (location) card.rows.push([w.where, clip(location, 400), 0]);
    card.detail = clip(str(input.notes), 600);
    return done('calendar', verbs.calendar);
  }
  if (name === 'qianmo_memory_write') {
    card.what = clip(str(input.title), 400);
    var body = str(input.body);
    card.detail = clip(str(input.summary) + (body ? '\\n\\n' + body : ''), 600);
    var destination = str(input.destination);
    if (destination) card.rows = [[w.savedTo, clip(destination, 400), 0]];
    return done('memory', verbs.memory);
  }
  var tool = name.indexOf('qianmo_elevated_') === 0 ? name.slice(16) : name;
  if (tool === 'bash') {
    card.detail = clip(str(input.command), 1200);
    return done('command', verbs.command);
  }
  if (tool === 'web_search') {
    card.what = clip(str(input.query), 400);
    return done('network', verbs.network);
  }
  if (tool === 'read') {
    card.what = clip(String(input.path || input.paths || input.url || ''), 400);
    return done('network', verbs.network);
  }
  if (tool === 'github') {
    var line = str(input.op);
    if (input.repo) line += ' · ' + String(input.repo);
    if (input.title) line += ' · ' + String(input.title);
    card.what = clip(line, 400);
    return done('github', verbs.github);
  }
  var json = '';
  try { json = JSON.stringify(input, null, 2) || ''; } catch (e) { json = ''; }
  card.what = name;
  card.detail = clip(json, 1200);
  return done('other', verbs.other);
}
`

/**
 * Show invisible controls as literal codepoints, including inside paths and
 * JSON: a bidirectional override in a value reads as `‮`, not as text
 * running the other way.
 */
export function escapeShown(value: string): string {
  return escapeHtml(
    [...String(value)]
      .map(char => {
        const code = char.codePointAt(0)!
        return (code < 32 && code !== 10 && code !== 9) ||
          (code >= 0x7f && code <= 0x9f) ||
          code === 0x61c ||
          code === 0x200e ||
          code === 0x200f ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : char
      })
      .join(''),
  )
}
