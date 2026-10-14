// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 对话前台 — the conversation front at `/`.
 *
 * The console used to be one document with the conversation as its first
 * area. It is now two: this front, which is nothing but the conversation, and
 * the management side under `/admin` (`view/shell.ts`). A person who opens
 * the console's address lands on the agent they talk to, not on a sidebar of
 * twenty operator areas.
 *
 * ## The shape
 *
 * Modelled on Grok Bot: a quiet side list of agents, one row each — figure,
 * name, when it last spoke and what it said, a dot when there is something
 * unread — and one conversation beside it. Picking an agent opens its latest
 * conversation, so each agent reads as one running thread; older and parallel
 * conversations sit behind the history button in the bar. The transcript is
 * bubbles in one centred column (the agent's light, the person's dark), with
 * a time divider where the conversation paused, the process folded into one
 * checklist per step group, and the composer pinned under the column. On an
 * empty conversation the composer moves up under the agent's greeting.
 *
 * ## 主智能体 and 子智能体
 *
 * The **main agent** is the one the front opens by default: the console's
 * `--chat-default`, or the first agent the console may dial. It heads the
 * list; every other agent in the roster is a **sub-agent**, listed after it
 * by how recently it spoke, and any of them can be talked to from here
 * directly, on whichever server it lives. A row says when its agent is
 * working (a session whose last line is the person's and has no answer yet),
 * and the strip above the composer lists those other conversations, so work
 * handed to a sub-agent stays in view while the person talks to the main one.
 *
 * ## What did not change
 *
 * The rules the conversation face has always kept hold here unchanged:
 * every string is escaped on the way out (`escape.ts`); a turn's text goes
 * through the closed markdown subset of `richText.ts` and nothing else; the
 * delivery facts under a person's line stay three separate facts; the stream
 * carries no content, only "this session changed", and the page answers it by
 * fetching a fragment rendered here; and a transcript is read only through
 * the gate that writes the reading down (`routes/chatReads.ts`).
 *
 * The mount ids (`fx-agents`, `fx-history`, `fx-stack`, `fx-head`,
 * `fx-thread`) are a contract with `assets/frontClient.ts`, which swaps each
 * one by id out of a fetched fragment.
 */

import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from '../assets/client.js'
import { FRONT_JS } from '../assets/frontClient.js'
import type { ConsoleRole } from '../auth.js'
import { type Lang, LANG_NAMES, LANGS } from '../i18n.js'
import {
  CHAT_LOCAL_COMMANDS,
  type ChatSession,
  type ChatTarget,
  type ChatTranscript,
  type ChatTurn,
  type ConsoleFailure,
} from '../deps.js'
import { AVATAR_CSS, avatarDialog, avatarSvg, avatarWords } from './avatar.js'
import { AVATAR_PAGE_JS } from './avatarScript.js'
import {
  chevron,
  failureBar,
  icon,
  state,
  timeAttrs,
  type PageViewer,
  type Tone,
  viewerNotice,
} from './bits.js'
import {
  type ChatFaces,
  chatPreview,
  failureWords,
  faceState,
  formatLatency,
  MAX_CHAT_TEXT_LENGTH,
  targetState,
} from './chat.js'
import { unansweredTurns } from '../chatTurns.js'
import { attr, escapeHtml } from './escape.js'
import { formatTime, type TimeFormat } from './format.js'
import { ACCENT_PRESETS } from './accent.js'
import {
  FRONT_REPLICATE_CSS,
  FRONT_REPLICATE_JS,
  type FrontReplicateMode,
  frontReplicateCard,
} from './frontReplicate.js'
import { FRONT_CSS } from './frontStyle.js'
import { FRONT_TEXT, frontClientText, type FrontText } from './frontText.js'
import { qianmoMark } from './mark.js'
import { renderRichText } from './richText.js'
import { documentHead, sessionExpired, WORDMARK_CN } from './shell.js'

/** The management side's home, where the panel's admin links point. */
const ADMIN = '/admin'

/** How much of a notice's summary one step line shows. */
const STEP_LENGTH = 160

/** How much of a session's first line the history list shows. */
const TITLE_LENGTH = 40

/** Rows the strip above the composer lists before it stops. */
const STACK_ROWS = 6

/** Figures the folded strip shows side by side. */
const STACK_FACES = 3

/** A pause longer than this puts a time divider in the conversation. */
const PAUSE_MS = 10 * 60 * 1000

/** How much of the current step the live status line shows. */
const ACTIVITY_LENGTH = 80

/** The live mark: three dots in a wave, for anything an agent is doing now. */
const LIVE_DOTS = `<span class="fx-live-dots" aria-hidden="true"><i></i><i></i><i></i></span>`

/**
 * What an agent is doing, by kind. Each kind has its own small moving mark
 * in the live status line, so the line says at a glance whether the agent is
 * thinking, running a command, reading, writing, out on the web, working a
 * computer or a browser, or reaching a device or a service.
 */
type ActivityKind =
  | 'think'
  | 'run'
  | 'read'
  | 'edit'
  | 'web'
  | 'screen'
  | 'device'
  | 'fail'

/** The words for a kind of work, by the reader's language (`frontText.ts`). */
type ActivityWord = Exclude<keyof FrontText['activity'], 'colon' | 'failed'>

/**
 * A step's verb (the node's own short words, `omp-turn.ts`): its kind, and
 * what the line calls it.
 */
const VERB_KIND: Readonly<
  Record<string, readonly [ActivityKind, ActivityWord]>
> = {
  读: ['read', 'read'],
  搜: ['read', 'search'],
  改: ['edit', 'edit'],
  执行: ['run', 'run'],
  取: ['web', 'fetch'],
}

/**
 * Tools the node names instead of a verb, by kind, with what the line calls
 * them. A tool not listed keeps its own name and the thinking mark.
 */
const TOOL_KIND: readonly (readonly [RegExp, ActivityKind, ActivityWord])[] = [
  [/^computer$/, 'screen', 'computer'],
  [/^(browser|puppeteer)$/, 'screen', 'browser'],
  [/^qianmo_mail_/, 'device', 'mail'],
  [/^qianmo_calendar_/, 'device', 'calendar'],
  [/^qianmo_connectors$/, 'device', 'connectors'],
  [/^qianmo_file_request$/, 'device', 'file'],
  [/^(image_gen|qianmo_generate_video)$/, 'edit', 'generate'],
  [/^(memory_|qianmo_memory_)/, 'think', 'memory'],
]

/** The node's mark of a failed step, at the end of its summary. */
const FAILED_SUFFIX = ' — 失败'

/** What the live status line says and which mark it moves with. */
interface Activity {
  readonly kind: ActivityKind
  readonly words: string
}

/** A step's summary (`<verb or tool>：<subject>`), read as an activity. */
function activityOf(
  summary: string | undefined,
  t: FrontText,
  limit = ACTIVITY_LENGTH,
): Activity {
  const words = t.activity
  if (summary === undefined || summary.trim() === '') {
    return { kind: 'think', words: words.thinking }
  }
  const failed = summary.endsWith(FAILED_SUFFIX)
  const body = failed ? summary.slice(0, -FAILED_SUFFIX.length) : summary
  const split = body.indexOf('：')
  const head = split < 0 ? body.trim() : body.slice(0, split)
  const subject = split < 0 ? '' : body.slice(split + 1)
  const known = Object.hasOwn(VERB_KIND, head) ? VERB_KIND[head] : undefined
  const tool = TOOL_KIND.find(([pattern]) => pattern.test(head))
  const named =
    known ?? (tool === undefined ? undefined : ([tool[1], tool[2]] as const))
  const said =
    named === undefined
      ? body
      : subject === ''
        ? words[named[1]]
        : `${words[named[1]]}${words.colon}${subject}`
  return {
    kind: failed ? 'fail' : (named?.[0] ?? 'think'),
    words: truncate(failed ? `${said} — ${words.failed}` : said, limit),
  }
}

/** The moving mark of each kind: inline SVG in the text's own ink. */
function activityMark(kind: ActivityKind): string {
  const svg = (inner: string): string =>
    `<svg class="fx-act fx-act-${kind}" viewBox="0 0 16 16" width="16" height="16" ` +
    `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  switch (kind) {
    case 'run':
      return svg(
        `<path d="M3 4.5 6.5 8 3 11.5"/><rect class="fx-act-cursor" x="8.5" y="10.6" width="5" height="1.8" rx="0.5" fill="currentColor" stroke="none"/>`,
      )
    case 'read':
      return svg(
        `<path class="fx-act-faint" d="M3 4h10M3 8h10M3 12h7"/>` +
          `<rect class="fx-act-scan" x="2" y="2.8" width="12" height="2.4" rx="1.2" fill="currentColor" stroke="none"/>`,
      )
    case 'edit':
      return svg(
        `<path class="fx-act-ink" pathLength="1" d="M2 11c2.2-5 4.2-5 5.6 0s3.6 5 6.4-1"/>`,
      )
    case 'web':
      return svg(
        `<circle cx="8" cy="11.5" r="1.3" fill="currentColor" stroke="none"/>` +
          `<path class="fx-act-wave1" d="M5.2 8.7a4 4 0 0 1 5.6 0"/>` +
          `<path class="fx-act-wave2" d="M2.6 6.1a7.6 7.6 0 0 1 10.8 0"/>`,
      )
    case 'screen':
      return svg(
        `<rect x="1.8" y="2.6" width="12.4" height="8.6" rx="1.6"/><path d="M6 13.6h4"/>` +
          `<circle class="fx-act-pointer" cx="5" cy="6" r="1.3" fill="currentColor" stroke="none"/>`,
      )
    case 'device':
      return svg(
        `<rect x="1.6" y="5.6" width="3.6" height="4.8" rx="1"/><rect x="10.8" y="5.6" width="3.6" height="4.8" rx="1"/>` +
          `<path class="fx-act-faint" d="M5.2 8h5.6"/>` +
          `<circle class="fx-act-packet" cx="6" cy="8" r="1.1" fill="currentColor" stroke="none"/>`,
      )
    case 'fail':
      return svg(`<path d="M8 2.5 14 13H2Z"/><path d="M8 6.6v2.8M8 11.3v.1"/>`)
    default:
      return LIVE_DOTS
  }
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function timeTag(at: number, fmt: TimeFormat, cls: string): string {
  return (
    `<time class="${attr(cls)}" data-at="${attr(String(at))}"${timeAttrs(at, fmt)}>` +
    `${escapeHtml(formatTime(at, fmt))}</time>`
  )
}

/**
 * The roster's verdict on an agent, in the front's shorter words and the
 * reader's language. A status the registry reports that is not `online`
 * stays the registry's own word.
 */
function stateOf(
  target: ChatTarget | null,
  registryDown: boolean,
  t: FrontText,
): { readonly tone: Tone; readonly text: string } {
  const verdict = targetState(target, registryDown)
  const text = registryDown
    ? t.rosterDown
    : target === null
      ? t.notInRoster
      : !target.dialable
        ? t.notConnected
        : target.status === 'online'
          ? t.online
          : verdict.text
  return { tone: verdict.tone, text }
}

/** A failed turn's words: the console's own in Chinese, the code otherwise. */
function failText(code: string | undefined, lang: Lang, t: FrontText): string {
  if (lang === 'zh-CN') return failureWords(code)
  return code === undefined ? t.failed : `${t.failed} · ${code}`
}

function sessionTitle(session: ChatSession, t: FrontText): string {
  const title = session.title ?? ''
  if (title.trim() !== '') return truncate(title, TITLE_LENGTH)
  if (session.preview.trim() !== '') return chatPreview(session.preview)
  return t.newChat
}

// --- who there is to talk to --------------------------------------------------

/** One agent's conversations, as its row tells them. */
interface AgentLine {
  /** The conversation it spoke in last: what picking the row opens. */
  readonly latest: ChatSession
  /** How many of its conversations wait for an answer, beside the open one. */
  readonly running: number
}

function linesOf(
  sessions: readonly ChatSession[],
  activeId: string | null,
): ReadonlyMap<string, AgentLine> {
  const out = new Map<string, AgentLine>()
  for (const session of sessions) {
    const was = out.get(session.target)
    // The open conversation shows its own work in the thread.
    const busy = session.running === true && session.id !== activeId
    const running = (was?.running ?? 0) + (busy ? 1 : 0)
    const latest =
      was === undefined || session.updatedAt > was.latest.updatedAt
        ? session
        : was.latest
    out.set(session.target, { latest, running })
  }
  return out
}

export interface FrontSideModel {
  readonly faces: ChatFaces
  /** The roster; `null` when nobody could ask the registry. */
  readonly targets: readonly ChatTarget[] | null
  /** The sessions this reader may see. */
  readonly sessions: readonly ChatSession[]
  readonly sessionsFailure: ConsoleFailure | null
  /** The main agent's address, when there is one. */
  readonly main: string | null
  /** The agent in focus: the open conversation's, or the one picked. */
  readonly selected: string | null
  readonly activeId: string | null
  /** Whether this reader may open the management side. */
  readonly admin: boolean
  readonly now: number
  /** The reader's language (`i18n.ts`). */
  readonly lang: Lang
}

function agentMenu(
  target: ChatTarget,
  faces: ChatFaces,
  admin: boolean,
  t: FrontText,
): string {
  const node = encodeURIComponent(target.node)
  const items =
    (target.dialable
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-agent-new" ` +
        `data-address="${attr(target.address)}">${icon('square-pen', { small: true })}${escapeHtml(t.newChat)}</button>`
      : '') +
    (faces.editable
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="avatar-edit" ` +
        `data-key="${attr(`agent:${target.address}`)}" data-name="${attr(target.agent)}">` +
        `${icon('sparkles', { small: true })}${escapeHtml(t.changeLook)}</button>`
      : '') +
    `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-copy" ` +
    `data-copy="${attr(target.address)}">${icon('copy', { small: true })}${escapeHtml(t.copyAddress)}</button>` +
    (admin
      ? `<a class="fx-menu-item" role="menuitem" href="${attr(`${ADMIN}/nodes/${node}`)}">` +
        `${icon('server', { small: true })}${escapeHtml(t.nodeDetails)}</a>` +
        `<a class="fx-menu-item" role="menuitem" href="${attr(`${ADMIN}/providers/nodes/${node}`)}">` +
        `${icon('cpu', { small: true })}${escapeHtml(t.modelSettings)}</a>`
      : '')
  return (
    `<details class="fx-more">` +
    `<summary class="fx-icon-btn fx-more-btn" aria-label="${attr(t.actionsFor(target.agent))}">` +
    `${icon('ellipsis', { small: true })}</summary>` +
    `<div class="fx-menu" role="menu">${items}</div></details>`
  )
}

function agentRow(
  target: ChatTarget,
  model: FrontSideModel,
  line: AgentLine | undefined,
  main: boolean,
  twin: boolean,
): string {
  const t = FRONT_TEXT[model.lang]
  const verdict = stateOf(target, false, t)
  const current = target.address === model.selected
  const running = line?.running ?? 0
  const latest = line?.latest
  const figure = avatarSvg(model.faces.agent(target.address), {
    size: 32,
    state:
      verdict.tone === 'ok' ? (running > 0 ? 'thinking' : 'idle') : 'sleep',
    ...(running > 0 ? { live: true } : {}),
  })
  const preview =
    running > 0
      ? t.working
      : latest !== undefined && latest.preview.trim() !== ''
        ? chatPreview(latest.preview)
        : `${target.node} · ${verdict.text}`
  const when =
    latest === undefined
      ? ''
      : `<span class="fx-agent-when">${escapeHtml(
          t.ago(latest.updatedAt, model.now),
        )}</span>`
  const cls =
    `fx-agent-row${main ? ' fx-agent-main' : ''}${current ? ' is-current' : ''}` +
    `${target.dialable ? '' : ' is-off'}${running > 0 ? ' is-busy' : ''}`
  const latestAttr =
    latest === undefined
      ? ''
      : ` data-latest="${attr(latest.id)}" data-updated="${attr(String(latest.updatedAt))}"`
  return (
    `<div class="${cls}" data-address="${attr(target.address)}"${latestAttr}>` +
    `<button type="button" class="fx-agent" data-action="fx-agent" ` +
    `data-address="${attr(target.address)}"${current ? ' aria-current="true"' : ''} ` +
    `title="${attr(`${target.agent} · ${target.node} · ${verdict.text}`)}">` +
    `<span class="fx-agent-face">${figure}</span>` +
    `<span class="fx-agent-text">` +
    `<span class="fx-agent-line"><span class="fx-agent-name">${escapeHtml(target.agent)}</span>` +
    (twin
      ? `<span class="fx-agent-node mono">${escapeHtml(target.node)}</span>`
      : '') +
    (main ? `<span class="fx-agent-tag">${escapeHtml(t.mainTag)}</span>` : '') +
    when +
    `</span>` +
    `<span class="fx-agent-sub">${running > 0 ? LIVE_DOTS : ''}${escapeHtml(preview)}</span></span>` +
    `<span class="fx-unread" aria-hidden="true"></span>` +
    `</button>` +
    agentMenu(target, model.faces, model.admin, t) +
    `</div>`
  )
}

/**
 * The roster in the list's order: the main agent, then whoever spoke last,
 * then the agents nobody has talked to yet, in the roster's own order.
 */
function listOrder(
  targets: readonly ChatTarget[],
  main: string | null,
  lines: ReadonlyMap<string, AgentLine>,
): readonly ChatTarget[] {
  const spoken = (target: ChatTarget): number =>
    lines.get(target.address)?.latest.updatedAt ?? Number.NEGATIVE_INFINITY
  const head = targets.filter(target => target.address === main)
  const rest = targets
    .filter(target => target.address !== main)
    .map((target, index) => ({ target, index }))
    .sort((a, b) => {
      const gap = spoken(b.target) - spoken(a.target)
      return Number.isNaN(gap) || gap === 0 ? a.index - b.index : gap
    })
    .map(entry => entry.target)
  return [...head, ...rest]
}

function renderAgents(model: FrontSideModel): string {
  const t = FRONT_TEXT[model.lang]
  const open = `<section class="fx-agents" id="fx-agents" aria-label="${attr(t.agents)}">`
  if (model.targets === null) {
    return (
      open + `<p class="fx-none">${escapeHtml(t.rosterDown)}</p>` + `</section>`
    )
  }
  if (model.targets.length === 0) {
    return (
      open +
      `<p class="fx-none">${escapeHtml(t.noAgents)}</p>` +
      (model.admin
        ? `<a class="fx-side-link" href="${ADMIN}/nodes">${icon('server', { small: true })}${escapeHtml(t.manageNodes)}</a>`
        : '') +
      `</section>`
    )
  }
  const lines = linesOf(model.sessions, model.activeId)
  const names = new Map<string, number>()
  for (const target of model.targets) {
    names.set(target.agent, (names.get(target.agent) ?? 0) + 1)
  }
  const rows = listOrder(model.targets, model.main, lines).map(target =>
    agentRow(
      target,
      model,
      lines.get(target.address),
      target.address === model.main,
      (names.get(target.agent) ?? 0) > 1,
    ),
  )
  return (
    open +
    rows.join('') +
    `<p class="fx-none" data-empty="search" hidden>${escapeHtml(t.noMatch)}</p>` +
    `</section>`
  )
}

// --- what has been said ---------------------------------------------------------

/**
 * Rolling windows rather than calendar days: the server's zone is not the
 * reader's. Named in the reader's language (`FrontText.historyWindows`).
 */
const HISTORY_WINDOWS: readonly number[] = [
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  Number.POSITIVE_INFINITY,
]

function historyItem(
  session: ChatSession,
  model: FrontSideModel,
  hidden: boolean,
): string {
  const t = FRONT_TEXT[model.lang]
  const active = session.id === model.activeId
  return (
    `<button type="button" class="fx-hitem${active ? ' is-active' : ''}" data-action="fx-open" ` +
    `data-session="${attr(session.id)}" data-target="${attr(session.target)}"` +
    `${active ? ' aria-current="true"' : ''}${hidden ? ' hidden' : ''}>` +
    `<span class="fx-hitem-title">${escapeHtml(sessionTitle(session, t))}</span>` +
    `<span class="fx-hitem-meta">` +
    (session.running === true
      ? `<span class="fx-pulse" aria-label="${attr(t.working)}"></span>`
      : '') +
    `<span class="fx-hitem-who">${escapeHtml(session.agent)}</span>` +
    `<span>${escapeHtml(t.ago(session.updatedAt, model.now))}</span>` +
    `</span></button>`
  )
}

/** The conversations, newest first: the bar's history menu. */
function renderHistory(model: FrontSideModel): string {
  const t = FRONT_TEXT[model.lang]
  const head =
    `<div class="fx-sec-head"><h2 class="fx-sec-title">${escapeHtml(t.chats)}</h2>` +
    `<div class="fx-seg" role="group" aria-label="${attr(t.chatScope)}">` +
    `<button type="button" data-action="fx-scope" data-scope="agent" aria-pressed="true">${escapeHtml(t.thisAgent)}</button>` +
    `<button type="button" data-action="fx-scope" data-scope="all" aria-pressed="false">${escapeHtml(t.all)}</button>` +
    `</div></div>`
  const open =
    `<section class="fx-history" id="fx-history" aria-label="${attr(t.chatList)}" ` +
    `data-selected="${attr(model.selected ?? '')}">`
  if (model.sessionsFailure !== null) {
    return (
      open + head + failureBar(model.sessionsFailure, '会话列表') + `</section>`
    )
  }
  const ordered = [...model.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  let start = 0
  const groups: string[] = []
  for (const [index, span] of HISTORY_WINDOWS.entries()) {
    const label = t.historyWindows[index] ?? ''
    const inside: ChatSession[] = []
    while (start < ordered.length) {
      const session = ordered[start]
      if (session === undefined || model.now - session.updatedAt > span) break
      inside.push(session)
      start += 1
    }
    if (inside.length === 0) continue
    const items = inside.map(session =>
      historyItem(
        session,
        model,
        model.selected !== null && session.target !== model.selected,
      ),
    )
    const empty = inside.every(
      session => model.selected !== null && session.target !== model.selected,
    )
    groups.push(
      `<div class="fx-hgroup"${empty ? ' hidden' : ''}>` +
        `<p class="fx-hgroup-name">${escapeHtml(label)}</p>${items.join('')}</div>`,
    )
  }
  const mine =
    model.selected === null ||
    ordered.some(session => session.target === model.selected)
  return (
    open +
    head +
    `<div class="fx-hist-list">` +
    groups.join('') +
    `<p class="fx-none" data-empty="agent"${mine ? ' hidden' : ''}>${escapeHtml(t.noChats)}</p>` +
    `<p class="fx-none" data-empty="all"${ordered.length === 0 ? '' : ' hidden'}>${escapeHtml(t.noChats)}</p>` +
    `<p class="fx-none" data-empty="search" hidden>${escapeHtml(t.noMatch)}</p>` +
    `</div></section>`
  )
}

/**
 * The strip above the composer: the other conversations still waiting for
 * an answer, so work handed to a sub-agent stays in view while the person
 * talks to the main one. Folded to one line until somebody opens it.
 */
function renderStack(model: FrontSideModel): string {
  const running = model.sessions
    .filter(
      session => session.running === true && session.id !== model.activeId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (running.length === 0) {
    return `<div class="fx-stack" id="fx-stack" hidden></div>`
  }
  const t = FRONT_TEXT[model.lang]
  const subOnly = running.every(session => session.target !== model.main)
  const label = subOnly
    ? t.subAgentsWorking(running.length)
    : t.workingInBackground(running.length)
  const faces = [...new Set(running.map(session => session.target))]
    .slice(0, STACK_FACES)
    .map(target =>
      avatarSvg(model.faces.agent(target), { size: 18, state: 'thinking' }),
    )
    .join('')
  const rows = running
    .slice(0, STACK_ROWS)
    .map(
      session =>
        `<button type="button" class="fx-stack-row" data-action="fx-open" data-session="${attr(
          session.id,
        )}">` +
        `<span class="fx-stack-face">${avatarSvg(
          model.faces.agent(session.target),
          { size: 20, state: 'thinking' },
        )}</span>` +
        `<span class="fx-stack-who">${escapeHtml(session.agent)}</span>` +
        `<span class="fx-stack-node mono">${escapeHtml(session.node)}</span>` +
        `<span class="fx-stack-what">${escapeHtml(sessionTitle(session, t))}</span>` +
        `<span class="fx-stack-when">${escapeHtml(
          t.ago(session.updatedAt, model.now),
        )}</span></button>`,
    )
    .join('')
  const more =
    running.length > STACK_ROWS
      ? `<p class="fx-stack-more">${escapeHtml(t.more(running.length - STACK_ROWS))}</p>`
      : ''
  return (
    `<div class="fx-stack" id="fx-stack">` +
    `<details class="fx-stack-card" data-key="stack">` +
    `<summary class="fx-stack-head"><span class="fx-stack-faces">${faces}</span>` +
    LIVE_DOTS +
    `<span class="fx-stack-label">${escapeHtml(label)}</span>${chevron()}</summary>` +
    `<div class="fx-stack-rows">${rows}${more}</div></details></div>`
  )
}

/** The side's three mounts, apart: the document puts each where it lives. */
interface FrontSideParts {
  readonly agents: string
  readonly history: string
  readonly stack: string
}

export function frontSideParts(model: FrontSideModel): FrontSideParts {
  return {
    agents: renderAgents(model),
    history: renderHistory(model),
    stack: renderStack(model),
  }
}

/** The side fragment: three mounts the client swaps by id. */
export function renderFrontSide(model: FrontSideModel): string {
  const parts = frontSideParts(model)
  return parts.agents + parts.history + parts.stack
}

// --- one conversation -------------------------------------------------------------

export interface FrontViewModel {
  readonly faces: ChatFaces
  readonly transcript: ChatTranscript | null
  readonly failure: ConsoleFailure | null
  /** The registry's view of the agent in focus. */
  readonly target: ChatTarget | null
  /** The agent in focus when nothing is open; `null` when there is none. */
  readonly agent: string | null
  readonly registryDown: boolean
  /** The agent in focus is the main agent. */
  readonly main: boolean
  readonly admin: boolean
  readonly now: number
  /** The reader's language (`i18n.ts`). */
  readonly lang: Lang
}

/** The three facts under a person's line, as one compact mark. */
function deliveryMark(turn: ChatTurn, lang: Lang, t: FrontText): string {
  if (turn.state === 'failed') {
    return `<span class="fx-fail">${escapeHtml(failText(turn.code, lang, t))}</span>`
  }
  const receipted = turn.receipt !== undefined
  const read = turn.readMs !== undefined
  const facts = [
    t.sent,
    receipted
      ? `${t.delivered} · ${t.receipt(turn.receipt ?? '')}${
          turn.receiptMs === undefined
            ? ''
            : ` · ${formatLatency(turn.receiptMs)}`
        }`
      : turn.deliveryUnknown === true
        ? t.receiptUnknown
        : t.awaitingDelivery,
    read ? `${t.read} · ${formatLatency(turn.readMs ?? 0)}` : t.unread,
  ]
  const text = read
    ? `${t.read} · ${formatLatency(turn.readMs ?? 0)}`
    : receipted
      ? t.delivered
      : turn.deliveryUnknown === true
        ? t.receiptUnknown
        : t.awaitingDelivery
  return (
    `<span class="fx-chain" title="${attr(facts.join(' · '))}">` +
    `<i class="on"></i><i${receipted ? ' class="on"' : ''}></i><i${read ? ' class="on"' : ''}></i>` +
    `</span><span>${escapeHtml(text)}</span>`
  )
}

function idMarks(turn: ChatTurn, admin: boolean, t: FrontText): string {
  const marks: string[] = []
  if (turn.taskId !== undefined) {
    marks.push(
      `<span class="fx-id mono" title="${attr(turn.taskId)}">${escapeHtml(
        `task ${turn.taskId.slice(0, 8)}`,
      )}</span>`,
    )
  }
  if (turn.traceId !== undefined) {
    const hex = turn.traceId.includes('-')
      ? (turn.traceId.split('-')[1] ?? '')
      : turn.traceId
    const shown = `${t.trace} ${hex.slice(0, 8)}`
    marks.push(
      admin
        ? `<a class="fx-id mono" href="${attr(
            `${ADMIN}/audit/trace/${encodeURIComponent(turn.traceId)}`,
          )}" target="_blank" rel="noopener">${escapeHtml(shown)}</a>`
        : `<span class="fx-id mono" title="${attr(turn.traceId)}">${escapeHtml(shown)}</span>`,
    )
  }
  return marks.join('')
}

function userTurn(
  turn: ChatTurn,
  admin: boolean,
  last: boolean,
  lang: Lang,
  t: FrontText,
): string {
  const cls =
    `fx-msg fx-msg-user${turn.state === 'failed' ? ' is-failed' : ''}` +
    `${last ? ' is-last' : ''}`
  return (
    `<article class="${cls}">` +
    `<div class="fx-bubble">${renderRichText(turn.text)}</div>` +
    `<div class="fx-meta"><span class="fx-meta-more">${timeTag(turn.at, 'clock', 'fx-when')}` +
    `${idMarks(turn, admin, t)}</span>${deliveryMark(turn, lang, t)}</div></article>`
  )
}

function agentTurn(
  turn: ChatTurn,
  admin: boolean,
  lang: Lang,
  t: FrontText,
): string {
  const failed = turn.state === 'failed'
  const command = turn.command
  const body =
    command !== undefined
      ? `<header class="fx-msg-head"><code class="mono fx-cmd-name">/${escapeHtml(
          command,
        )}</code></header>` +
        `<pre class="fx-pre"><code>${escapeHtml(
          turn.text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd(),
        )}</code></pre>`
      : `<div class="fx-bubble fx-bubble-agent"><div class="fx-text">${renderRichText(
          turn.text,
        )}</div></div>`
  return (
    `<article class="fx-msg fx-msg-agent${failed ? ' is-failed' : ''}${
      command !== undefined ? ' fx-msg-cmd' : ''
    }">` +
    `<div class="fx-msg-body">` +
    body +
    `<div class="fx-meta">` +
    (failed
      ? `<span class="fx-fail">${escapeHtml(failText(turn.code, lang, t))}</span>`
      : '') +
    `<span class="fx-meta-more">` +
    timeTag(turn.at, 'clock', 'fx-when') +
    (turn.elapsedMs === undefined
      ? ''
      : `<span>${escapeHtml(formatLatency(turn.elapsedMs))}</span>`) +
    idMarks(turn, admin, t) +
    `</span>` +
    `<button type="button" class="fx-mini" data-action="fx-copy-turn" aria-label="${attr(t.copyReply)}">` +
    `${icon('copy', { small: true })}</button>` +
    `</div></div></article>`
  )
}

const STEP_MARK: Readonly<Record<string, string>> = {
  info: 'check',
  warn: 'alert-triangle',
  error: 'x',
}

/**
 * Consecutive process lines, folded into one checklist that says how many
 * steps and what the last one was. Folded by default: while the turn is still
 * running, the live status line under it says what the agent is doing now
 * (`pendingTail`), and the list is there for whoever opens it. The client
 * keeps whichever way the person left it across redraws (`data-key`).
 */
function stepGroup(
  steps: readonly ChatTurn[],
  running: boolean,
  t: FrontText,
): string {
  const first = steps[0]
  const last = steps[steps.length - 1]
  if (first === undefined || last === undefined) return ''
  const worst = steps.some(step => step.severity === 'error')
    ? 'bad'
    : steps.some(step => step.severity === 'warn')
      ? 'warn'
      : 'muted'
  const lines = steps
    .map(step => {
      const severity = step.severity ?? 'info'
      const detail =
        step.detail === undefined
          ? ''
          : `<details class="fx-step-detail"><summary>${chevron()}${escapeHtml(t.details)}</summary>` +
            `<pre class="fx-pre fx-pre-quiet">${escapeHtml(step.detail)}</pre></details>`
      return (
        `<li class="fx-step fx-step-${attr(severity)}">` +
        `<span class="fx-step-mark">${icon(STEP_MARK[severity] ?? 'check', { small: true })}</span>` +
        `<div class="fx-step-body"><div class="fx-step-line">` +
        `<span class="fx-step-text">${escapeHtml(
          activityOf(step.text, t, STEP_LENGTH).words,
        )}</span>` +
        (step.redelivered === true
          ? `<span class="fx-id">${escapeHtml(t.resent)}</span>`
          : '') +
        timeTag(step.at, 'clock', 'fx-when') +
        `</div>${detail}</div></li>`
      )
    })
    .join('')
  const summary = running
    ? t.stepsRunning(steps.length)
    : t.stepsDone(steps.length)
  return (
    `<details class="fx-steps fx-steps-${worst}${running ? ' is-running' : ''}" ` +
    `data-key="${attr(`steps:${first.id}`)}">` +
    `<summary class="fx-steps-head">` +
    icon('list-checks', { small: true }) +
    `<span class="fx-steps-label">${escapeHtml(summary)}</span>` +
    `<span class="fx-steps-last">${escapeHtml(activityOf(last.text, t).words)}</span>` +
    `${chevron()}</summary>` +
    `<ol class="fx-step-list">${lines}</ol></details>`
  )
}

/**
 * The answer has not come yet: the live status line — a mark that moves
 * the way the agent is working ({@link activityMark}), what it is doing now
 * (its latest step, or 思考中 before the first), and for how long. The client keeps this line across redraws and slides the new
 * words in, so it changes instead of blinking.
 */
function pendingTail(
  since: number,
  agent: string,
  step: string | undefined,
  now: number,
  t: FrontText,
): string {
  const elapsed = Math.max(0, now - since)
  const activity = activityOf(step, t)
  return (
    `<div class="fx-msg fx-msg-agent fx-pending" role="status" aria-label="${attr(`${agent} · ${activity.words}`)}">` +
    `<div class="fx-msg-body"><div class="fx-typing fx-typing-${activity.kind}" ` +
    `data-kind="${activity.kind}" data-elapsed="${attr(String(elapsed))}">` +
    `<span class="fx-act-slot">${activityMark(activity.kind)}</span>` +
    `<span class="fx-typing-word">${escapeHtml(activity.words)}</span>` +
    `<span class="fx-typing-time">${escapeHtml(formatLatency(elapsed))}</span>` +
    `</div></div></div>`
  )
}

/** A divider where the conversation paused: the time, centred. */
function divider(at: number, before: number | undefined): string {
  const newDay =
    before === undefined ||
    new Date(before).toDateString() !== new Date(at).toDateString()
  return (
    `<div class="fx-sep" role="separator">` +
    timeTag(at, newDay ? 'minute' : 'hm', 'fx-sep-time') +
    `</div>`
  )
}

function renderMessages(
  model: FrontViewModel,
  transcript: ChatTranscript,
): string {
  const { session, turns } = transcript
  const t = FRONT_TEXT[model.lang]
  if (turns.length === 0) {
    return `<div class="fx-msgs"></div>`
  }
  const unanswered = unansweredTurns(turns)
  const waiting = unanswered.length > 0
  let lastOperator = ''
  for (const turn of turns) {
    if (turn.variant !== 'notice' && turn.author === 'operator') {
      lastOperator = turn.id
    }
  }
  const out: string[] = []
  let steps: ChatTurn[] = []
  let previous: number | undefined
  const pause = (at: number): void => {
    if (previous === undefined || at - previous > PAUSE_MS) {
      out.push(divider(at, previous))
    }
    previous = at
  }
  const flush = (trailing: boolean): void => {
    if (steps.length === 0) return
    out.push(stepGroup(steps, trailing && waiting, t))
    steps = []
  }
  for (const turn of turns) {
    if (turn.variant === 'notice') {
      if (steps.length === 0) pause(turn.at)
      else previous = turn.at
      steps.push(turn)
      continue
    }
    flush(false)
    pause(turn.at)
    out.push(
      turn.author === 'operator'
        ? userTurn(turn, model.admin, turn.id === lastOperator, model.lang, t)
        : agentTurn(turn, model.admin, model.lang, t),
    )
  }
  const activity = waiting ? steps[steps.length - 1]?.text : undefined
  flush(true)
  const latest = unanswered[unanswered.length - 1]
  if (latest !== undefined) {
    out.push(pendingTail(latest.at, session.agent, activity, model.now, t))
  }
  return `<div class="fx-msgs">${out.join('')}</div>`
}

/** The two names an address carries, for an agent the roster no longer lists. */
function namesOf(address: string): {
  readonly node: string
  readonly agent: string
} {
  const match = /^qianmo:\/\/([^/]+)\/(.+)$/.exec(address)
  return match === null
    ? { node: '', agent: address }
    : { node: match[1] ?? '', agent: match[2] ?? address }
}

function welcome(model: FrontViewModel): string {
  const t = FRONT_TEXT[model.lang]
  const address = model.agent
  if (address === null) {
    return (
      `<div class="fx-welcome"><h2 class="fx-welcome-title">${escapeHtml(
        model.registryDown ? t.rosterDown : t.noAgents,
      )}</h2>` +
      (model.admin
        ? `<a class="btn btn-secondary btn-small" href="${ADMIN}/nodes">${escapeHtml(t.manageNodes)}</a>`
        : '') +
      `</div>`
    )
  }
  const target = model.target
  const names = target ?? namesOf(address)
  const dialable = target?.dialable === true
  const verdict = stateOf(target, model.registryDown, t)
  const spec = model.faces.agent(address)
  const figure = avatarSvg(spec, {
    size: 72,
    uid: 'av-greet',
    live: true,
    state: verdict.tone === 'ok' || model.registryDown ? 'idle' : 'sleep',
    label: `${names.agent} · ${avatarWords(spec, model.lang)}`,
  })
  const stage = model.faces.editable
    ? `<button type="button" class="fx-welcome-face" data-action="avatar-edit" ` +
      `data-key="${attr(`agent:${address}`)}" data-name="${attr(names.agent)}" ` +
      `aria-label="${attr(t.changeLookOf(names.agent))}">${figure}</button>`
    : `<span class="fx-welcome-face">${figure}</span>`
  const note = dialable
    ? ''
    : target === null
      ? model.registryDown
        ? t.rosterDown
        : t.noLongerListed
      : t.notConnectedForChat
  return (
    `<div class="fx-welcome">${stage}` +
    `<h2 class="fx-welcome-title">${escapeHtml(names.agent)}</h2>` +
    `<p class="fx-welcome-sub">${escapeHtml(`${names.node} · ${verdict.text}`)}</p>` +
    (note === '' ? '' : `<p class="fx-welcome-note">${escapeHtml(note)}</p>`) +
    `</div>`
  )
}

function headInfo(
  target: ChatTarget | null,
  address: string,
  node: string,
  verdict: { readonly tone: Tone; readonly text: string },
  model: FrontViewModel,
): string {
  const t = FRONT_TEXT[model.lang]
  const rows: (readonly [string, string])[] = [
    [t.address, `<code class="mono">${escapeHtml(address)}</code>`],
    [t.node, `<span class="mono">${escapeHtml(node)}</span>`],
    [t.status, state(verdict.tone, verdict.text)],
    [
      t.chatChannel,
      escapeHtml(
        target === null
          ? model.registryDown
            ? t.rosterDown
            : t.notInRoster
          : target.dialable
            ? t.connected
            : t.notConnected,
      ),
    ],
  ]
  if (model.transcript !== null) {
    rows.push([
      t.thisChat,
      escapeHtml(
        t.chatStats(
          model.transcript.session.turnCount,
          t.ago(model.transcript.session.createdAt, model.now),
        ),
      ),
    ])
  }
  const links = model.admin
    ? `<div class="fx-info-links">` +
      `<a href="${attr(`${ADMIN}/nodes/${encodeURIComponent(node)}`)}">${escapeHtml(t.nodeDetails)}</a>` +
      `<a href="${attr(`${ADMIN}/providers/nodes/${encodeURIComponent(node)}`)}">${escapeHtml(t.modelSettings)}</a>` +
      `<a href="${attr(`${ADMIN}/audit?node=${encodeURIComponent(node)}`)}">${escapeHtml(t.messageChain)}</a>` +
      `</div>`
    : ''
  return (
    `<details class="fx-more fx-info">` +
    `<summary class="fx-icon-btn" aria-label="${attr(t.agentInfo)}">${icon('info', { small: true })}</summary>` +
    `<div class="fx-menu fx-info-card">` +
    `<dl class="fx-facts">${rows
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`)
      .join('')}</dl>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="fx-copy" data-copy="${attr(
      address,
    )}">${icon('copy', { small: true })}${escapeHtml(t.copyAddress)}</button>` +
    links +
    `</div></details>`
  )
}

function renderHead(model: FrontViewModel): string {
  const t = FRONT_TEXT[model.lang]
  const transcript = model.transcript
  const address = transcript?.session.target ?? model.agent ?? ''
  if (address === '') {
    return `<div class="fx-head" id="fx-head"><span class="fx-head-name">${escapeHtml(t.chat)}</span></div>`
  }
  const target = model.target
  const names = target ?? namesOf(address)
  const agent = transcript?.session.agent ?? names.agent
  const node = transcript?.session.node ?? names.node
  const verdict = stateOf(target, model.registryDown, t)
  const spec = model.faces.agent(address)
  const figure = avatarSvg(spec, {
    size: 24,
    uid: 'av-head',
    live: true,
    state: faceState(
      transcript?.turns ?? [],
      target,
      model.registryDown,
      model.now,
    ),
    label: `${agent} · ${avatarWords(spec, model.lang)}`,
  })
  const face = model.faces.editable
    ? `<button type="button" class="fx-head-face" data-action="avatar-edit" ` +
      `data-key="${attr(`agent:${address}`)}" data-name="${attr(agent)}" ` +
      `aria-label="${attr(t.changeLookOf(agent))}">${figure}</button>`
    : `<span class="fx-head-face">${figure}</span>`
  return (
    `<div class="fx-head" id="fx-head" data-target="${attr(address)}">` +
    face +
    `<span class="fx-head-name">${escapeHtml(agent)}</span>` +
    `<span class="fx-head-sub"><span class="mono">${escapeHtml(node)}</span>` +
    (verdict.tone === 'ok' ? '' : state(verdict.tone, verdict.text)) +
    `<span class="fx-model" id="fx-model"></span></span>` +
    headInfo(target, address, node, verdict, model) +
    `</div>`
  )
}

/** The view's two mounts, apart: the document puts the head in the top bar. */
interface FrontViewParts {
  readonly head: string
  readonly thread: string
}

/** The view fragment: the head and the thread, two mounts swapped by id. */
export function renderFrontView(model: FrontViewModel): string {
  const parts = frontViewParts(model)
  return parts.head + parts.thread
}

export function frontViewParts(model: FrontViewModel): FrontViewParts {
  const transcript = model.transcript
  const address = transcript?.session.target ?? model.agent ?? ''
  const verdict = stateOf(
    model.target,
    model.registryDown,
    FRONT_TEXT[model.lang],
  )
  let inner: string
  let attrs: string
  if (model.failure !== null) {
    inner = `<div class="fx-msgs">${failureBar(model.failure, '会话')}</div>`
    attrs = `data-target="" data-open="0"`
  } else if (transcript === null) {
    inner = welcome(model)
    const startable = model.target?.dialable === true
    attrs =
      `data-target="${attr(address)}" data-open="0"` +
      `${startable ? ' data-start="1"' : ''} data-welcome="1"`
  } else {
    inner = renderMessages(model, transcript)
    const running = unansweredTurns(transcript.turns).length > 0
    attrs =
      `data-target="${attr(address)}" data-open="1" ` +
      `data-session="${attr(transcript.session.id)}"${running ? ' data-running="1"' : ''}`
  }
  const agentName =
    transcript?.session.agent ??
    model.target?.agent ??
    (address === '' ? '' : namesOf(address).agent)
  return {
    head: renderHead(model),
    thread:
      `<div class="fx-thread" id="fx-thread" ${attrs} data-agent="${attr(agentName)}" ` +
      `data-state="${attr(verdict.text)}" data-tone="${attr(verdict.tone)}">` +
      inner +
      `</div>`,
  }
}

// --- the document -------------------------------------------------------------------

function roleText(role: ConsoleRole, t: FrontText): string {
  return role === 'admin' ? t.roleAdmin : role === 'view' ? t.roleView : ''
}

export interface FrontDocumentModel {
  readonly label: string
  readonly role: ConsoleRole
  readonly viewer?: PageViewer
  readonly side: FrontSideParts
  readonly view: FrontViewParts
  /** Nothing is open: the composer sits under the greeting. */
  readonly welcome: boolean
  /** The composer is live: a conversation is open, or the first line opens one. */
  readonly composerEnabled: boolean
  readonly admin: boolean
  readonly faces: ChatFaces
  /** The login door with the way back here. */
  readonly relogin: string
  /** The reader's language (`i18n.ts`). */
  readonly lang: Lang
  /** 部署到新服务器 above the composer (`frontReplicate.ts`). Absent is `off`. */
  readonly replicate?: FrontReplicateMode
}

function composer(enabled: boolean, t: FrontText): string {
  const off = enabled ? '' : ' disabled'
  const commands = CHAT_LOCAL_COMMANDS.map(
    name =>
      `<button type="button" class="fx-cmd" role="option" id="${attr(`fx-cmd-${name}`)}" ` +
      `data-cmd="${attr(`/${name}`)}" tabindex="-1">` +
      `<code class="mono">/${escapeHtml(name)}</code><span>${escapeHtml(t.commandWords[name] ?? '')}</span></button>`,
  ).join('')
  return (
    `<form class="fx-composer" id="fx-composer" novalidate>` +
    `<div class="fx-cmds" id="fx-cmds" role="listbox" aria-label="${attr(t.localCommands)}" hidden>${commands}</div>` +
    `<button type="button" class="fx-icon-btn fx-plus" id="fx-plus" data-action="fx-plus" ` +
    `aria-label="${attr(t.commands)}" aria-controls="fx-cmds" aria-expanded="false"${off}>${icon('plus', { small: true })}</button>` +
    `<label class="sr-only" for="fx-text">${escapeHtml(t.message)}</label>` +
    `<textarea id="fx-text" rows="1" spellcheck="false" ` +
    `maxlength="${attr(String(MAX_CHAT_TEXT_LENGTH))}" aria-describedby="fx-status" ` +
    `aria-controls="fx-cmds" ` +
    `placeholder="${attr(t.placeholder)}"${off}></textarea>` +
    `<button type="button" class="fx-icon-btn fx-mic" id="fx-mic" data-action="fx-mic" ` +
    `aria-label="${attr(t.voiceInput)}" aria-pressed="false" hidden>${icon('mic', { small: true })}</button>` +
    `<button type="submit" class="fx-send" id="fx-send" aria-label="${attr(t.send)}"${off}>` +
    `${icon('arrow-up', { small: true })}</button>` +
    `<p class="fx-status" id="fx-status" role="status"></p>` +
    `</form>`
  )
}

/** 主题色: the presets, and a picker for any other colour (`accent.ts`). */
function accentField(t: FrontText): string {
  return (
    `<div class="fx-menu-item fx-menu-field fx-accent-field" role="group" aria-label="${attr(t.accent)}">` +
    `<span>${escapeHtml(t.accent)}</span><span class="fx-swatches">` +
    ACCENT_PRESETS.map(
      preset =>
        `<button type="button" class="fx-swatch" data-action="fx-accent" ` +
        `data-accent="${attr(preset.name)}" aria-label="${attr(t.accentNames[preset.name] ?? preset.label)}" ` +
        `title="${attr(t.accentNames[preset.name] ?? preset.label)}" aria-pressed="false"></button>`,
    ).join('') +
    `<label class="fx-swatch fx-swatch-custom" title="${attr(t.accentCustom)}">` +
    `<input type="color" id="fx-accent-custom" aria-label="${attr(t.accentCustomAria)}" value="#111110"></label>` +
    `</span></div>`
  )
}

/** The language picker: changing it reloads the page in the new language. */
function langField(lang: Lang, t: FrontText): string {
  return (
    `<label class="fx-menu-item fx-menu-field">${escapeHtml(t.language)}` +
    `<select id="fx-lang" aria-label="${attr(t.language)}">` +
    LANGS.map(
      one =>
        `<option value="${attr(one)}" lang="${attr(one)}"${one === lang ? ' selected' : ''}>` +
        `${escapeHtml(LANG_NAMES[one])}</option>`,
    ).join('') +
    `</select></label>`
  )
}

function sideFoot(model: FrontDocumentModel): string {
  const t = FRONT_TEXT[model.lang]
  const me = avatarSvg(model.faces.self, { size: 28 })
  const role = model.viewer?.roleText ?? roleText(model.role, t)
  return (
    `<div class="fx-side-foot">` +
    `<span class="fx-me">${me}<span class="fx-me-text"><b>${escapeHtml(t.me)}</b><span>${escapeHtml(
      role,
    )}</span></span></span>` +
    (model.admin
      ? `<a class="fx-icon-btn" href="${ADMIN}" aria-label="${attr(t.adminConsole)}">${icon('settings', { small: true })}</a>`
      : '') +
    `<details class="fx-more fx-me-menu">` +
    `<summary class="fx-icon-btn" aria-label="${attr(t.accountMenu)}">${icon('ellipsis', { small: true })}</summary>` +
    `<div class="fx-menu fx-menu-up" role="menu">` +
    (model.faces.editable
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="avatar-edit" ` +
        `data-key="${attr(model.faces.selfKey)}" data-name="${attr(t.me)}">${icon('sparkles', { small: true })}${escapeHtml(t.changeMyLook)}</button>`
      : '') +
    `<label class="fx-menu-item fx-menu-field">${escapeHtml(t.appearance)}` +
    `<select id="theme-choice" aria-label="${attr(t.appearance)}"><option value="system">${escapeHtml(t.themeSystem)}</option>` +
    `<option value="light">${escapeHtml(t.themeLight)}</option><option value="dark">${escapeHtml(t.themeDark)}</option></select></label>` +
    accentField(t) +
    langField(model.lang, t) +
    (model.admin
      ? `<a class="fx-menu-item" role="menuitem" href="${ADMIN}">${icon('layout-dashboard', { small: true })}${escapeHtml(t.adminConsole)}</a>`
      : '') +
    `<form method="post" action="/logout" class="fx-menu-form">` +
    `<button type="submit" class="fx-menu-item" role="menuitem">${icon('log-out', { small: true })}${escapeHtml(t.signOut)}</button>` +
    `</form></div></details></div>`
  )
}

/** The front's own keyboard help, in place of the management side's. */
function keyboardHelp(t: FrontText): string {
  return (
    `<dialog class="dialog" id="keyboard-help" aria-labelledby="keyboard-help-title">` +
    `<h2 id="keyboard-help-title">${escapeHtml(t.keyboardTitle)}</h2>` +
    `<p>${escapeHtml(t.keyboardHelp)}</p>` +
    `<button class="btn" type="button" data-action="confirm-cancel">${escapeHtml(t.close)}</button></dialog>`
  )
}

/** The whole front document. */
export function renderFrontDocument(model: FrontDocumentModel): string {
  const runtime =
    model.viewer === undefined ? CONSOLE_CLIENT_JS : CONSOLE_CLIENT_JS_ACCOUNTS
  // 部署到新服务器 rides only on a console that has it: everyone else's page
  // stays byte for byte what it was.
  const replicate = model.replicate ?? 'off'
  const script =
    runtime +
    FRONT_JS +
    AVATAR_PAGE_JS +
    (replicate === 'off' ? '' : FRONT_REPLICATE_JS)
  const t = FRONT_TEXT[model.lang]
  return (
    documentHead(
      `${WORDMARK_CN} · ${t.chat} · ${model.label}`,
      FRONT_CSS + AVATAR_CSS + (replicate === 'off' ? '' : FRONT_REPLICATE_CSS),
      [script],
    ).replace('<html lang="zh-CN">', `<html lang="${attr(model.lang)}">`) +
    `<body class="fx-body">\n` +
    `<a class="skip-link" href="#fx-text">${escapeHtml(t.skipToBox)}</a>\n` +
    `<h1 class="sr-only">${escapeHtml(`${WORDMARK_CN} · ${t.chat}`)}</h1>` +
    `<div class="fx" id="fx" data-side="open" data-text="${attr(frontClientText(model.lang))}">` +
    `<aside class="fx-side" id="fx-side" aria-label="${attr(t.agents)}">` +
    `<div class="fx-side-top">` +
    `<a class="fx-brand" href="/">${qianmoMark(22)}` +
    `<b class="fx-brand-name">${escapeHtml(WORDMARK_CN)}</b></a>` +
    `<button type="button" class="fx-icon-btn fx-new" data-action="fx-new" aria-label="${attr(t.newChat)}">` +
    `${icon('square-pen', { small: true })}</button>` +
    `<button type="button" class="fx-icon-btn" data-action="fx-side" aria-label="${attr(t.collapseSide)}" aria-controls="fx-side">` +
    `${icon('panel-left', { small: true })}</button></div>` +
    `<label class="fx-search">${icon('search', { small: true })}<span class="sr-only">${escapeHtml(t.search)}</span>` +
    `<input type="search" id="fx-search" placeholder="${attr(t.search)}" autocomplete="off" spellcheck="false"></label>` +
    `<div class="fx-side-scroll" id="fx-side-scroll">${model.side.agents}</div>` +
    sideFoot(model) +
    `</aside>` +
    `<button type="button" class="fx-scrim" data-action="fx-side-close" aria-label="${attr(t.closeSide)}" tabindex="-1"></button>` +
    `<main class="fx-main${model.welcome ? ' is-welcome' : ''}" id="fx-main">` +
    `<header class="fx-top">` +
    `<button type="button" class="fx-icon-btn fx-side-open" data-action="fx-side" aria-label="${attr(t.expandSide)}" aria-controls="fx-side">` +
    `${icon('panel-left', { small: true })}</button>` +
    `<div class="fx-head-mount">${model.view.head}</div>` +
    `<div class="fx-top-tail"><span class="fx-live" id="fx-live"></span>` +
    `<details class="fx-more fx-hist-menu">` +
    `<summary class="fx-icon-btn" aria-label="${attr(t.chatHistory)}">${icon('history', { small: true })}</summary>` +
    `<div class="fx-menu fx-hist-pop">${model.side.history}</div></details>` +
    `<button type="button" class="fx-icon-btn" data-action="fx-new" aria-label="${attr(t.newChat)}">` +
    `${icon('square-pen', { small: true })}</button></div>` +
    `</header>` +
    viewerNotice(model.viewer) +
    `<div class="fx-scroll" id="fx-scroll"><div class="fx-column">${model.view.thread}</div></div>` +
    `<div class="fx-dock"><div class="fx-column">` +
    `<button type="button" class="fx-jump" id="fx-jump" data-action="fx-jump" aria-label="${attr(t.jumpToLatest)}" hidden>` +
    `${icon('arrow-down', { small: true })}</button>` +
    model.side.stack +
    (replicate === 'off' ? '' : frontReplicateCard(replicate)) +
    composer(model.composerEnabled, t) +
    `</div></div>` +
    `</main></div>\n` +
    sessionExpired(model.relogin, model.lang) +
    `<div class="toasts" id="toasts" aria-live="polite" aria-relevant="additions"></div>\n` +
    `<p id="reply-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>` +
    keyboardHelp(t) +
    avatarDialog(model.lang) +
    `<script>${script}</script>\n` +
    `</body>\n</html>\n`
  )
}
