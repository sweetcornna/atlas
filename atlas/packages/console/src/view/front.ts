// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 对话前台 — the conversation front, in two faces: 智能体 at `/` and 对话 at
 * `/app` (`docs/dev/qmo-app.md` §4).
 *
 * The console used to be one document with the conversation as its first
 * area. It is now two: this front, which is nothing but the conversation, and
 * the management side under `/admin` (`view/shell.ts`). A person who opens
 * the console's address lands on the agent they talk to, not on a sidebar of
 * twenty operator areas.
 *
 * ## The shape
 *
 * Modelled on Grok Bot: a quiet side list of agents, one row each — figure
 * with the roster's verdict as a dot, name, when its conversation last moved
 * and what was said, a dot when there is something unread — and one
 * conversation beside it. Each agent is **one conversation that stays**
 * (P37.17, `chatResident.ts`): picking the row opens the reader's resident
 * conversation with it, or its welcome before the first line, and nothing
 * opens a second one. What the reader had with it before, and what schedules,
 * channels and background tasks opened, are its 其他对话 behind ⋯, read here
 * and not written in. Above 搜索, 开始一项工作; under the agents, by day,
 * the reader's work sessions with their state (P37.17 B, `frontWork.ts`,
 * `docs/dev/work-tasks.md` §9), a work being no agent's row. The
 * transcript is bubbles in one centred column (the agent's light, the
 * person's dark), with a time divider where the conversation paused, the
 * process folded into one checklist per step group, and the composer pinned
 * under the column. On an empty conversation the composer moves up under the
 * agent's greeting.
 *
 * ## The 对话 face
 *
 * `/app` is the same front for the desktop app's main window and for anyone
 * who prefers it, with the same side list: an agent's welcome is a greeting
 * with a large composer that can pick another agent, and the transcript
 * reads as a column of prose — the person's lines in a quiet block at the
 * right, the agent's unboxed under its figure and name. Both faces share the
 * bar, the sidebar (brand, the Work | Code switch, 搜索, the list title with
 * 对话 · 智能体 as two icons, the agents) and its metrics, the session panel,
 * the approvals and the gate, and each is one renderer here with a layout
 * switch, so the two read as one product.
 * Code (`/code`, `view/frontCode.ts`) is the second mode, and the settings
 * card (`view/shell.ts`) opens over any of them. Quick entry (`/app/quick`)
 * is a page of its own (`view/frontQuick.ts`).
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
 * The mount ids (`fx-agents`, `fx-history`, `fx-stack`, `fx-recents`,
 * `fx-agent-menu`, `fx-head`, `fx-thread`) are a contract with
 * `assets/frontClient.ts`, which swaps each one by id out of a fetched
 * fragment.
 */

import {
  type ApproverRole,
  FRONT_APPROVAL_CSS,
  FRONT_APPROVAL_JS,
  frontApprovalBar,
  frontApprovalCards,
} from './frontApproval.js'
import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from '../assets/client.js'
import { CODE_JS } from '../assets/codeClient.js'
import { CODE_HUB_JS } from '../assets/codeHub.js'
import { CODE_RENDER_JS } from '../assets/codeRender.js'
import { FRONT_JS } from '../assets/frontClient.js'
import { NAV_MOUNTED_JS } from '../assets/nav.js'
import { FRONT_PANEL_JS } from '../assets/frontPanel.js'
import { FRONT_WORK_JS } from '../assets/frontWork.js'
import { FRONT_SHELL_JS } from '../assets/frontShell.js'
import { FRONT_SPLIT_JS } from '../assets/frontSplit.js'
import { FRONT_TOOLS_JS } from '../assets/frontTools.js'
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
import {
  FRONT_PANEL_CSS,
  frontPanelFrame,
  frontPanelToggle,
} from './frontPanel.js'
import { FRONT_CSS } from './frontStyle.js'
import {
  composerPickers,
  FRONT_TOOLS_CSS,
  permissionConfirm,
} from './frontTools.js'
import { FRONT_TEXT, frontClientText, type FrontText } from './frontText.js'
import {
  activityPanel,
  fileCards,
  fileTemplates,
  flowChip,
  flowIcon,
  flowTag,
  FRONT_WORK_CSS,
  newWorkWelcome,
  previewDialog,
  WORK_TEXT,
  workflowOptions,
  workRowState,
} from './frontWork.js'
import { qianmoMark } from './mark.js'
import { renderRichText } from './richText.js'
import { type SourceLinks, sourceFooter } from './source.js'
import { codeHead, codeMain, codeSide, codeTail } from './frontCode.js'
import {
  agentQuery,
  FRONT_SPLIT_CSS,
  paneClose,
  paneMenu,
  SPLIT_TEXT,
  sessionQuery,
  splitFrame,
  splitItems,
  splitText,
} from './frontSplit.js'
import {
  CONSOLE_NAV_JS,
  documentHead,
  documentTitle,
  renderSettings,
  sessionExpired,
  type SettingsCard,
  shellScripts,
  WORDMARK_CN,
} from './shell.js'

/**
 * The management side's home. Its links open the settings card over the
 * page (`assets/nav.ts`); in a browser without script they load the area.
 */
const ADMIN = '/admin'

/**
 * The two faces the front draws (`docs/dev/qmo-app.md` §1, §4): `agents` is
 * `/`, Grok Bot's shape — the roster down the side, one running thread per
 * agent, bubbles; `chat` is `/app`, Claude Desktop's — every conversation
 * down the side by day, a greeting over a large composer, and the answer set
 * as text in a reading column. One renderer draws both: the frame, the
 * composer, the step groups, the live line, the approval cards and the panel
 * are the same; the side list, the bar's head, the welcome and how a turn
 * sits on the page follow the layout.
 */
export type FrontLayout = 'agents' | 'chat'

/** Where each face lives: the brand and the 对话 · 智能体 switch link here. */
const FRONT_HOME: Readonly<Record<FrontLayout, string>> = {
  agents: '/',
  chat: '/app',
}

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
  if (title.trim() !== '') return chatPreview(title, TITLE_LENGTH)
  if (session.preview.trim() !== '') return chatPreview(session.preview)
  return t.newChat
}

// --- who there is to talk to --------------------------------------------------

/** One agent's conversations, as its row tells them. */
interface AgentLine {
  /**
   * The reader's resident conversation with it (P37.17, `chatResident.ts`):
   * what picking the row opens, and what its time, last line and unread dot
   * are about. Absent until the reader has said something to it.
   */
  readonly latest?: ChatSession
  /** How many of its conversations wait for an answer, beside the open one. */
  readonly running: number
  /** Its conversations other than the resident one: the ⋯ menu's 其他对话. */
  readonly others: number
}

function linesOf(model: FrontSideModel): ReadonlyMap<string, AgentLine> {
  const out = new Map<string, AgentLine>()
  // The reader's work sessions are in the list by day, not the agent's row.
  const works = new Set(model.works.map(session => session.id))
  for (const session of model.sessions) {
    if (works.has(session.id)) continue
    const was = out.get(session.target)
    // The open conversation shows its own work in the thread.
    const busy = session.running === true && session.id !== model.activeId
    const resident = model.residents.get(session.target)
    const mine = resident?.id === session.id
    out.set(session.target, {
      ...(resident === undefined ? {} : { latest: resident }),
      running: (was?.running ?? 0) + (busy ? 1 : 0),
      others: (was?.others ?? 0) + (mine ? 0 : 1),
    })
  }
  for (const [target, resident] of model.residents) {
    if (!out.has(target))
      out.set(target, { latest: resident, running: 0, others: 0 })
  }
  return out
}

export interface FrontSideModel {
  readonly faces: ChatFaces
  /** The roster; `null` when nobody could ask the registry. */
  readonly targets: readonly ChatTarget[] | null
  /** The sessions this reader may see. */
  readonly sessions: readonly ChatSession[]
  /**
   * The reader's resident conversation with each agent, by address (P37.17,
   * `chatResident.ts`): each agent's row is that one conversation.
   */
  readonly residents: ReadonlyMap<string, ChatSession>
  /**
   * The reader's work sessions (P37.17 B, 广泛性工作, `chatResident.ts`
   * `workSessions`), by day under the agents.
   */
  readonly works: readonly ChatSession[]
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
  /** Which face the side is drawn for; absent is `/`'s. */
  readonly layout?: FrontLayout
}

/**
 * Who a row is about: an agent in the roster, or one the reader has a
 * resident conversation with that the roster no longer lists (or that
 * nobody could ask the registry about), whose row stays so the
 * conversation does.
 */
interface RowAgent {
  readonly address: string
  readonly node: string
  readonly agent: string
  readonly target: ChatTarget | null
}

function agentMenu(
  who: RowAgent,
  others: number,
  faces: ChatFaces,
  admin: boolean,
  t: FrontText,
  lang: Lang,
): string {
  const node = encodeURIComponent(who.node)
  const items =
    (others > 0
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-others" ` +
        `data-address="${attr(who.address)}">${icon('history', { small: true })}` +
        `${escapeHtml(t.otherChats)}<span class="fx-menu-count">${escapeHtml(String(others))}</span></button>`
      : '') +
    (faces.editable
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="avatar-edit" ` +
        `data-key="${attr(`agent:${who.address}`)}" data-name="${attr(who.agent)}">` +
        `${icon('sparkles', { small: true })}${escapeHtml(t.changeLook)}</button>`
      : '') +
    `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-copy" ` +
    `data-copy="${attr(who.address)}">${icon('copy', { small: true })}${escapeHtml(t.copyAddress)}</button>` +
    (admin && who.node !== ''
      ? `<a class="fx-menu-item" role="menuitem" href="${attr(`${ADMIN}/nodes/${node}`)}">` +
        `${icon('server', { small: true })}${escapeHtml(t.nodeDetails)}</a>` +
        `<a class="fx-menu-item" role="menuitem" href="${attr(`${ADMIN}/providers/nodes/${node}`)}">` +
        `${icon('cpu', { small: true })}${escapeHtml(t.modelSettings)}</a>`
      : '') +
    // Beside the panes already up (P37.18, view/frontSplit.ts).
    splitItems(agentQuery(who.address), lang)
  return (
    `<details class="fx-more">` +
    `<summary class="fx-icon-btn fx-more-btn" aria-label="${attr(t.actionsFor(who.agent))}">` +
    `${icon('ellipsis', { small: true })}</summary>` +
    `<div class="fx-menu" role="menu">${items}</div></details>`
  )
}

/**
 * One agent in the side list (P37.17): its figure with the roster's verdict
 * as a dot on it, its name (and node when two share a name), 主 on the main
 * agent, when its conversation last moved, the last line or that it is
 * working, the unread dot and ⋯. Picking it opens the reader's one
 * conversation with it, or its welcome before the first line.
 */
function agentRow(
  who: RowAgent,
  model: FrontSideModel,
  line: AgentLine | undefined,
  main: boolean,
  twin: boolean,
): string {
  const t = FRONT_TEXT[model.lang]
  const target = who.target
  const verdict = stateOf(target, model.targets === null, t)
  // A work session on screen is its own row's, not its agent's (P37.17 B).
  const current =
    who.address === model.selected &&
    !model.works.some(session => session.id === model.activeId)
  const running = line?.running ?? 0
  const latest = line?.latest
  const live = verdict.tone === 'ok'
  const figure = avatarSvg(model.faces.agent(who.address), {
    size: 32,
    state: live ? (running > 0 ? 'thinking' : 'idle') : 'sleep',
    ...(running > 0 ? { live: true } : {}),
  })
  const preview =
    running > 0
      ? t.working
      : latest !== undefined && latest.preview.trim() !== ''
        ? chatPreview(latest.preview)
        : `${who.node} · ${verdict.text}`
  const when =
    latest === undefined
      ? ''
      : `<span class="fx-agent-when">${escapeHtml(
          t.ago(latest.updatedAt, model.now),
        )}</span>`
  const dialable = target?.dialable === true
  const cls =
    `fx-agent-row${main ? ' fx-agent-main' : ''}${current ? ' is-current' : ''}` +
    `${dialable ? '' : ' is-off'}${running > 0 ? ' is-busy' : ''}`
  const latestAttr =
    latest === undefined
      ? ''
      : ` data-latest="${attr(latest.id)}" data-updated="${attr(String(latest.updatedAt))}"`
  return (
    `<div class="${cls}" data-address="${attr(who.address)}"${latestAttr}>` +
    `<button type="button" class="fx-agent" data-action="fx-agent" ` +
    `data-address="${attr(who.address)}"${current ? ' aria-current="true"' : ''} ` +
    `title="${attr(`${who.agent} · ${who.node} · ${verdict.text}`)}">` +
    `<span class="fx-agent-face">${figure}` +
    `<span class="fx-presence" data-tone="${attr(verdict.tone)}"><span class="sr-only">${escapeHtml(verdict.text)}</span></span></span>` +
    `<span class="fx-agent-text">` +
    `<span class="fx-agent-line"><span class="fx-agent-name">${escapeHtml(who.agent)}</span>` +
    (twin
      ? `<span class="fx-agent-node mono">${escapeHtml(who.node)}</span>`
      : '') +
    (main ? `<span class="fx-agent-tag">${escapeHtml(t.mainTag)}</span>` : '') +
    when +
    `</span>` +
    `<span class="fx-agent-sub">${running > 0 ? LIVE_DOTS : ''}${escapeHtml(preview)}</span></span>` +
    `<span class="fx-unread" aria-hidden="true"></span>` +
    `</button>` +
    agentMenu(who, line?.others ?? 0, model.faces, model.admin, t, model.lang) +
    `</div>`
  )
}

/**
 * The agents in the list's order: the main agent, then whoever's
 * conversation moved last, then the agents nobody has talked to yet, in the
 * roster's own order.
 */
function listOrder(
  agents: readonly RowAgent[],
  main: string | null,
  lines: ReadonlyMap<string, AgentLine>,
): readonly RowAgent[] {
  const spoken = (who: RowAgent): number =>
    lines.get(who.address)?.latest?.updatedAt ?? Number.NEGATIVE_INFINITY
  const head = agents.filter(who => who.address === main)
  const rest = agents
    .filter(who => who.address !== main)
    .map((who, index) => ({ who, index }))
    .sort((a, b) => {
      const gap = spoken(b.who) - spoken(a.who)
      return Number.isNaN(gap) || gap === 0 ? a.index - b.index : gap
    })
    .map(entry => entry.who)
  return [...head, ...rest]
}

/**
 * Every agent a row is drawn for: the roster, then the agents the reader
 * has a resident conversation with that it does not list.
 */
function rowAgents(model: FrontSideModel): readonly RowAgent[] {
  const listed: RowAgent[] = (model.targets ?? []).map(target => ({
    address: target.address,
    node: target.node,
    agent: target.agent,
    target,
  }))
  const known = new Set(listed.map(who => who.address))
  for (const [address, resident] of model.residents) {
    if (known.has(address)) continue
    known.add(address)
    listed.push({
      address,
      node: resident.node,
      agent: resident.agent,
      target: null,
    })
  }
  return listed
}

/**
 * The top of Work's side list on both faces (P37.17): every agent once, the
 * main agent first.
 */
function renderAgents(model: FrontSideModel): string {
  const t = FRONT_TEXT[model.lang]
  const open = `<section class="fx-agents" id="fx-agents" aria-label="${attr(t.agents)}">`
  const agents = rowAgents(model)
  const none =
    model.targets === null
      ? `<p class="fx-none">${escapeHtml(t.rosterDown)}</p>`
      : agents.length === 0
        ? `<p class="fx-none">${escapeHtml(t.noAgents)}</p>`
        : ''
  const lines = linesOf(model)
  const names = new Map<string, number>()
  for (const who of agents) {
    names.set(who.agent, (names.get(who.agent) ?? 0) + 1)
  }
  const rows = listOrder(agents, model.main, lines).map(who =>
    agentRow(
      who,
      model,
      lines.get(who.address),
      who.address === model.main,
      (names.get(who.agent) ?? 0) > 1,
    ),
  )
  return (
    open +
    (model.sessionsFailure === null
      ? ''
      : failureBar(model.sessionsFailure, '会话列表')) +
    none +
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

/**
 * 其他对话 (P37.17): every conversation the reader may see that is not one of
 * their resident ones, newest first — what they had with an agent before
 * there was one conversation per agent, and what schedules, channels and
 * background tasks opened. Drawn into a dialog an agent's ⋯ opens, scoped to
 * that agent or all; each opens read-only.
 */
function renderHistory(model: FrontSideModel): string {
  const t = FRONT_TEXT[model.lang]
  const head =
    `<div class="fx-sec-head"><h2 class="fx-sec-title" id="fx-others-title">${escapeHtml(t.otherChats)}</h2>` +
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
  // Neither the reader's resident conversations nor their work sessions:
  // those are the agents' rows and the list by day.
  const resident = new Set([
    ...[...model.residents.values()].map(one => one.id),
    ...model.works.map(one => one.id),
  ])
  const ordered = model.sessions
    .filter(session => !resident.has(session.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
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

// --- `/app`: every conversation, by day -----------------------------------------

/** The day groups' keys, in the order the list draws them. */
const DAY_KEYS = ['today', 'yesterday', 'week', 'older'] as const

/**
 * Which calendar day group an instant falls in: today, yesterday, the seven
 * days before that, or older. Drawn in this process's zone; the page moves
 * each row to its group in the reader's zone (`assets/frontClient.ts`).
 */
function dayGroupOf(at: number, now: number): number {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const before = (days: number): number => {
    const day = new Date(midnight)
    day.setDate(day.getDate() - days)
    return day.getTime()
  }
  if (at >= midnight.getTime()) return 0
  if (at >= before(1)) return 1
  if (at >= before(7)) return 2
  return 3
}

/** A conversation's ⋯: what the front does for one conversation. */
function sessionMenu(
  session: ChatSession,
  title: string,
  t: FrontText,
  lang: Lang,
): string {
  const items =
    `<a class="fx-menu-item" role="menuitem" href="${attr(
      `${FRONT_HOME.agents}?session=${encodeURIComponent(session.id)}`,
    )}">${icon('bot', { small: true })}${escapeHtml(t.openInAgents)}</a>` +
    `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-copy" ` +
    `data-copy="${attr(session.target)}">${icon('copy', { small: true })}${escapeHtml(t.copyAddress)}</button>` +
    splitItems(sessionQuery(session.id), lang)
  return (
    `<details class="fx-more">` +
    `<summary class="fx-icon-btn fx-more-btn" aria-label="${attr(t.sessionActions(title))}">` +
    `${icon('ellipsis', { small: true })}</summary>` +
    `<div class="fx-menu" role="menu">${items}</div></details>`
  )
}

/**
 * One work session in the list (P37.17 B, `work-tasks.md` §9.1): its
 * workflow's mark, its title, its state — 进行中, 等你 or 完成, the three
 * drawn and `data-state` / the approval poll's `data-asking` showing one
 * (`frontWork.ts`) — the unread dot, and ⋯. Who carries it out is in the
 * row's tooltip and found by the search. The row carries what the page
 * needs for the unread dot and the shell's notification: when it last
 * moved, whether it waits, the agent, and the last line.
 */
function recentItem(session: ChatSession, model: FrontSideModel): string {
  const t = FRONT_TEXT[model.lang]
  const active = session.id === model.activeId
  const running = session.running === true
  const title = sessionTitle(session, t)
  const cls =
    `fx-ritem-row${active ? ' is-current' : ''}` +
    `${running ? ' is-busy' : ''}`
  return (
    `<div class="${cls}" data-session="${attr(session.id)}" data-target="${attr(session.target)}" ` +
    `data-agent="${attr(session.agent)}" data-updated="${attr(String(session.updatedAt))}"` +
    `${running ? ' data-running="1"' : ''} data-preview="${attr(chatPreview(session.preview))}" ` +
    `data-work="1" data-state="${running ? 'running' : 'done'}">` +
    `<button type="button" class="fx-ritem" data-action="fx-open" data-session="${attr(session.id)}"` +
    `${active ? ' aria-current="true"' : ''} title="${attr(`${title} · ${session.agent}`)}">` +
    `<span class="fx-ritem-mark">${flowIcon(session.workflow)}</span>` +
    `<span class="fx-ritem-title">${escapeHtml(title)}</span>` +
    `</button>` +
    workRowState(model.lang) +
    `<span class="fx-unread" aria-hidden="true"></span>` +
    sessionMenu(session, title, t, model.lang) +
    `</div>`
  )
}

/**
 * Under the agents on both faces (P37.17): the reader's work sessions —
 * 广泛性工作, B — newest first under 今天 / 昨天 / 过去 7 天 / 更早. A
 * conversation with an agent is that agent's row, or under its ⋯ when it is
 * not the resident one; a background task's worker (P29) stays in the
 * panel's 后台任务. With no work session the list has nothing in it and
 * nothing is drawn for it: no heading, no line saying it is empty. All four
 * groups are always drawn, the empty ones hidden, so the page can move rows
 * between them.
 */
function renderRecents(model: FrontSideModel): string {
  const t = FRONT_TEXT[model.lang]
  const open =
    `<section class="fx-recents" id="fx-recents" aria-label="${attr(t.recents)}" ` +
    `data-now="${attr(String(model.now))}">`
  const shown = model.works
    .filter(session => session.background !== true)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const buckets: ChatSession[][] = DAY_KEYS.map(() => [])
  for (const session of shown) {
    buckets[dayGroupOf(session.updatedAt, model.now)]?.push(session)
  }
  const groups = DAY_KEYS.map((key, index) => {
    const inside = buckets[index] ?? []
    return (
      `<div class="fx-rgroup" data-group="${key}"${inside.length === 0 ? ' hidden' : ''}>` +
      `<h3 class="fx-rgroup-name">${escapeHtml(t.dayGroups[index] ?? '')}</h3>` +
      inside.map(session => recentItem(session, model)).join('') +
      `</div>`
    )
  }).join('')
  return open + groups + `</section>`
}

/**
 * The agent picker's menu under the composer: the roster in the side list's
 * order, the agent the next conversation goes to checked — on `/app`'s
 * welcome, and as 由谁来做 on the new work page of either face (P37.17 B). An
 * agent that cannot be dialled is listed and cannot be picked.
 */
function renderRoster(model: FrontSideModel): string {
  const t = FRONT_TEXT[model.lang]
  const open =
    `<div class="fx-menu fx-pick-menu fx-agent-menu" id="fx-agent-menu" role="menu" ` +
    `aria-label="${attr(t.pickAgent)}" hidden>`
  if (model.targets === null || model.targets.length === 0) {
    return (
      open +
      `<p class="fx-pick-note">${escapeHtml(
        model.targets === null ? t.rosterDown : t.noAgents,
      )}</p></div>`
    )
  }
  const lines = linesOf(model)
  const listed = model.targets.map(target => ({
    address: target.address,
    node: target.node,
    agent: target.agent,
    target,
  }))
  const ordered = listOrder(listed, model.main, lines).flatMap(who =>
    who.target === null ? [] : [who.target],
  )
  const items = ordered.map(target => {
    const verdict = stateOf(target, false, t)
    const picked = target.address === model.selected
    return (
      `<button type="button" class="fx-pick-item fx-agent-item" role="menuitemradio" ` +
      `aria-checked="${picked ? 'true' : 'false'}" data-agent-pick="${attr(target.address)}" ` +
      `data-name="${attr(target.agent)}"${target.address === model.main ? ' data-main="1"' : ''}` +
      `${target.dialable ? '' : ' disabled'}>` +
      `<span class="fx-agent-item-face">${avatarSvg(
        model.faces.agent(target.address),
        { size: 24, state: verdict.tone === 'ok' ? 'idle' : 'sleep' },
      )}</span>` +
      `<span class="fx-agent-item-name">${escapeHtml(target.agent)}` +
      (target.address === model.main
        ? `<i class="fx-agent-tag">${escapeHtml(t.mainTag)}</i>`
        : '') +
      `</span>` +
      `<small>${escapeHtml(`${target.node} · ${verdict.text}`)}</small>` +
      icon('check', { small: true }) +
      `</button>`
    )
  })
  return (
    open +
    `<p class="fx-pick-head fx-pick-head-agents">${escapeHtml(t.agents)}</p>` +
    `<p class="fx-pick-head fx-pick-head-work">${escapeHtml(WORK_TEXT[model.lang].whoDoes)}</p>` +
    items.join('') +
    `</div>`
  )
}

/**
 * The side's mounts, apart: the document puts each where it lives. Both
 * faces have the agents with the work sessions by day under them, the other
 * conversations for the dialog an agent's ⋯ opens (P37.17), and the
 * composer's agent picker; `/` has the running strip. A face's empty parts
 * are empty strings.
 */
interface FrontSideParts {
  readonly agents: string
  readonly history: string
  readonly stack: string
  readonly recents: string
  readonly roster: string
}

export function frontSideParts(model: FrontSideModel): FrontSideParts {
  const chat = model.layout === 'chat'
  return {
    agents: renderAgents(model),
    history: renderHistory(model),
    stack: chat
      ? `<div class="fx-stack" id="fx-stack" hidden></div>`
      : renderStack(model),
    recents: renderRecents(model),
    roster: renderRoster(model),
  }
}

/** The side fragment: the mounts the client swaps by id. */
export function renderFrontSide(model: FrontSideModel): string {
  const parts = frontSideParts(model)
  return (
    parts.agents + parts.history + parts.stack + parts.recents + parts.roster
  )
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
  /** Which face the view is drawn for; absent is `/`'s. */
  readonly layout?: FrontLayout
  /**
   * The open conversation is the reader's resident one with its agent
   * (P37.17): the agent's row, written in from here.
   */
  readonly resident?: boolean
  /**
   * The open conversation is not one of the reader's resident ones or work
   * sessions — an older one, a schedule's, a channel's, a worker's, someone
   * else's: read here, not written in. The way back is the agent's own
   * conversation.
   */
  readonly readOnly?: boolean
  /**
   * The open conversation is one of the reader's own work sessions (P37.17
   * B): written in here, with the activity beside it.
   */
  readonly work?: boolean
  /**
   * Nothing is open and the page is 开始一项工作 (P37.17 B): the workflows
   * over the composer, `agent` being who does it.
   */
  readonly newWork?: boolean
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
        `${t.task} ${turn.taskId.slice(0, 8)}`,
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

/**
 * A line sent while the agent was still on an earlier one: it waits on the
 * node and goes in at the agent's next step, so it says that rather than a
 * bare 待投递 that reads as stuck. Until the node reads it.
 */
function queuedMark(t: FrontText): string {
  return (
    `<span class="fx-chain" title="${attr(t.queuedNext)}"><i class="on"></i><i></i><i></i></span>` +
    `<span class="fx-queued">${escapeHtml(t.queuedNext)}</span>`
  )
}

function userTurn(
  turn: ChatTurn,
  admin: boolean,
  last: boolean,
  queued: boolean,
  lang: Lang,
  t: FrontText,
): string {
  const cls =
    `fx-msg fx-msg-user${turn.state === 'failed' ? ' is-failed' : ''}` +
    `${last ? ' is-last' : ''}${queued ? ' is-queued' : ''}`
  return (
    `<article class="${cls}">` +
    // Sent with a workflow (P37.17 B): its mark over the line.
    (turn.workflow === undefined ? '' : flowTag(turn.workflow, lang)) +
    `<div class="fx-bubble">${renderRichText(turn.text)}</div>` +
    `<div class="fx-meta"><span class="fx-meta-more">${timeTag(turn.at, 'clock', 'fx-when')}` +
    `${idMarks(turn, admin, t)}</span>${
      queued ? queuedMark(t) : deliveryMark(turn, lang, t)
    }</div></article>`
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
  // Lines after the one the agent is on, that the node has not read yet.
  const queued = new Set(
    unanswered
      .slice(1)
      .filter(turn => turn.readMs === undefined)
      .map(turn => turn.id),
  )
  let lastOperator = ''
  for (const turn of turns) {
    if (turn.variant !== 'notice' && turn.author === 'operator') {
      lastOperator = turn.id
    }
  }
  const out: string[] = []
  let steps: ChatTurn[] = []
  let previous: number | undefined
  // `/app` sets the agent's answer as text, so who is speaking goes at the
  // head of each run of its output: once after every line of the person's.
  const heads = model.layout === 'chat'
  let inRun = false
  const runHead = (): void => {
    if (!heads || inRun) return
    inRun = true
    out.push(
      `<div class="fx-run">${avatarSvg(model.faces.agent(session.target), {
        size: 20,
      })}<span class="fx-run-name">${escapeHtml(session.agent)}</span></div>`,
    )
  }
  const pause = (at: number): void => {
    if (previous === undefined || at - previous > PAUSE_MS) {
      out.push(divider(at, previous))
    }
    previous = at
  }
  const flush = (trailing: boolean): void => {
    if (steps.length === 0) return
    runHead()
    out.push(stepGroup(steps, trailing && waiting, t))
    steps = []
  }
  for (const turn of turns) {
    // Files handed over (P37.17 B, `work-tasks.md` §3.2): cards of their
    // own, never folded into the steps around them.
    if (
      turn.variant === 'notice' &&
      turn.noticeSource === 'files' &&
      (turn.files?.length ?? 0) > 0
    ) {
      flush(false)
      pause(turn.at)
      runHead()
      out.push(fileCards(turn, session.id, model.lang))
      continue
    }
    if (turn.variant === 'notice') {
      if (steps.length === 0) pause(turn.at)
      else previous = turn.at
      steps.push(turn)
      continue
    }
    flush(false)
    pause(turn.at)
    if (turn.author === 'operator') {
      inRun = false
      out.push(
        userTurn(
          turn,
          model.admin,
          turn.id === lastOperator,
          queued.has(turn.id),
          model.lang,
          t,
        ),
      )
    } else {
      runHead()
      out.push(agentTurn(turn, model.admin, model.lang, t))
    }
  }
  const activity = waiting ? steps[steps.length - 1]?.text : undefined
  flush(true)
  const latest = unanswered[unanswered.length - 1]
  if (latest !== undefined) {
    runHead()
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

/**
 * Which of the three greetings an hour gets: morning from five, afternoon
 * from noon, evening from six. The page's script makes the same choice by
 * the reader's own clock (`assets/frontClient.ts`).
 */
function greetingOf(hour: number): number {
  return hour >= 5 && hour < 12 ? 0 : hour >= 12 && hour < 18 ? 1 : 2
}

/**
 * `/app`'s welcome: the agent the next conversation goes to (the main agent
 * unless another was picked), and a greeting by the time of day, over the
 * large composer. No suggestions: what to ask is the person's.
 */
function greeting(model: FrontViewModel): string {
  const t = FRONT_TEXT[model.lang]
  const address = model.agent
  if (address === null) {
    return `<div class="fx-welcome fx-greet"><h2 class="fx-greet-title">${escapeHtml(
      model.registryDown ? t.rosterDown : t.noAgents,
    )}</h2></div>`
  }
  const target = model.target
  const names = target ?? namesOf(address)
  const verdict = stateOf(target, model.registryDown, t)
  const spec = model.faces.agent(address)
  const figure = avatarSvg(spec, {
    size: 40,
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
  const note =
    target?.dialable === true
      ? ''
      : target === null
        ? model.registryDown
          ? t.rosterDown
          : t.noLongerListed
        : `${names.agent} · ${t.notConnectedForChat}`
  return (
    `<div class="fx-welcome fx-greet"><div class="fx-greet-line">${stage}` +
    `<h2 class="fx-greet-title" data-greet>${escapeHtml(
      t.greetings[greetingOf(new Date(model.now).getHours())],
    )}</h2></div>` +
    (note === '' ? '' : `<p class="fx-welcome-note">${escapeHtml(note)}</p>`) +
    `</div>`
  )
}

function welcome(model: FrontViewModel): string {
  if (model.newWork === true) return newWorkWelcome(model.lang)
  if (model.layout === 'chat') return greeting(model)
  const t = FRONT_TEXT[model.lang]
  const address = model.agent
  if (address === null) {
    return `<div class="fx-welcome"><h2 class="fx-welcome-title">${escapeHtml(
      model.registryDown ? t.rosterDown : t.noAgents,
    )}</h2></div>`
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
  summary?: string,
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
    (summary ??
      `<summary class="fx-icon-btn" aria-label="${attr(t.agentInfo)}">${icon('info', { small: true })}</summary>`) +
    `<div class="fx-menu fx-info-card">` +
    `<dl class="fx-facts">${rows
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`)
      .join('')}</dl>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="fx-copy" data-copy="${attr(
      address,
    )}">${icon('copy', { small: true })}${escapeHtml(t.copyAddress)}</button>` +
    // `/app`'s chip is the whole summary, so the look is changed from here.
    (summary !== undefined && model.faces.editable
      ? `<button type="button" class="btn btn-ghost btn-small" data-action="avatar-edit" ` +
        `data-key="${attr(`agent:${address}`)}" data-name="${attr(target?.agent ?? namesOf(address).agent)}">` +
        `${icon('sparkles', { small: true })}${escapeHtml(t.changeLook)}</button>`
      : '') +
    links +
    `</div></details>`
  )
}

/**
 * `/app`'s head, and a work session's on either face (P37.17 B): the
 * conversation's title, and the agent as a chip — figure, name, node and,
 * once the page has it, the model — that opens the agent's facts. A new
 * conversation or a new work has no head: the bar keeps only its buttons.
 */
function renderChatHead(model: FrontViewModel): string {
  const t = FRONT_TEXT[model.lang]
  const transcript = model.transcript
  const address = transcript?.session.target ?? model.agent ?? ''
  if (transcript === null || address === '') {
    return `<div class="fx-head fx-head-chat" id="fx-head" data-target="${attr(address)}"></div>`
  }
  // An agent's own conversation is named by the agent: the chip says it,
  // and its first line is no title for it (P37.17).
  const title =
    model.resident === true
      ? ''
      : `<h2 class="fx-head-title" data-tauri-drag-region>${escapeHtml(
          sessionTitle(transcript.session, t),
        )}</h2>`
  const target = model.target
  const agent = transcript.session.agent
  const node = transcript.session.node
  const verdict = stateOf(target, model.registryDown, t)
  const spec = model.faces.agent(address)
  const figure = avatarSvg(spec, {
    size: 20,
    uid: 'av-head',
    live: true,
    state: faceState(transcript.turns, target, model.registryDown, model.now),
    label: `${agent} · ${avatarWords(spec, model.lang)}`,
  })
  const chip =
    `<summary class="fx-chip" aria-label="${attr(`${t.agentInfo} · ${agent}`)}">` +
    `<span class="fx-head-face">${figure}</span>` +
    `<span class="fx-chip-name">${escapeHtml(agent)}</span>` +
    `<span class="fx-chip-sub"><span class="mono">${escapeHtml(node)}</span>` +
    `<span class="fx-chip-model" id="fx-chip-model"></span></span>` +
    (verdict.tone === 'ok' ? '' : state(verdict.tone, verdict.text)) +
    `${chevron()}</summary>`
  return (
    `<div class="fx-head fx-head-chat" id="fx-head" data-target="${attr(address)}">` +
    title +
    headInfo(target, address, node, verdict, model, chip) +
    `</div>`
  )
}

function renderHead(model: FrontViewModel): string {
  if (
    model.layout === 'chat' ||
    model.newWork === true ||
    model.transcript?.session.work === true
  )
    return renderChatHead(model)
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
    `</span>` +
    headInfo(target, address, node, verdict, model) +
    `</div>`
  )
}

/**
 * Under a conversation that is read here and not written in (P37.17): the
 * state, and the way to the agent's own conversation.
 */
function readOnlyLine(
  model: FrontViewModel,
  transcript: ChatTranscript,
): string {
  const t = FRONT_TEXT[model.lang]
  const { target, agent } = transcript.session
  return (
    `<div class="fx-readonly" role="note"><span class="fx-readonly-word">${escapeHtml(t.readOnly)}</span>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="fx-agent" data-address="${attr(target)}">` +
    `${avatarSvg(model.faces.agent(target), { size: 18 })}${escapeHtml(t.backTo(agent))}</button></div>`
  )
}

/**
 * The view's three mounts, apart: the document puts the head in the top bar
 * and a work session's activity in the session panel (P37.17 B).
 */
interface FrontViewParts {
  readonly head: string
  readonly thread: string
  readonly activity: string
}

/** The view fragment: the head, the thread and the activity, swapped by id. */
export function renderFrontView(model: FrontViewModel): string {
  const parts = frontViewParts(model)
  return parts.head + parts.thread + parts.activity
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
      `${startable ? ' data-start="1"' : ''} data-welcome="1"` +
      `${model.newWork === true ? ' data-new-work="1"' : ''}`
  } else {
    inner =
      renderMessages(model, transcript) +
      (model.readOnly === true ? readOnlyLine(model, transcript) : '')
    const running = unansweredTurns(transcript.turns).length > 0
    attrs =
      `data-target="${attr(address)}" data-open="1" ` +
      `data-session="${attr(transcript.session.id)}"${running ? ' data-running="1"' : ''}` +
      `${model.resident === true ? ' data-resident="1"' : ''}` +
      `${model.work === true ? ' data-work="1"' : ''}` +
      `${model.readOnly === true ? ' data-readonly="1"' : ''}`
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
    activity: activityPanel(
      model.failure === null ? transcript : null,
      model.lang,
    ),
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
  /**
   * The public edition's source and terms links (AGPL §13, `source.ts`),
   * under the side list's foot. Absent — the default edition — nothing.
   */
  readonly source?: SourceLinks
  /**
   * The front's approval cards (P39, P40 §6, `frontApproval.ts`): the
   * reader's account role, set when the console has approvals and the reader
   * may approve. Absent, nothing changes.
   */
  readonly approvals?: ApproverRole
  /** Which face the document is (`/` or `/app`); absent is `/`'s. */
  readonly layout?: FrontLayout
  /** The agent a new conversation or a new work goes to, for the composer's picker. */
  readonly picked?: string | null
  /** The page is 开始一项工作 (P37.17 B, `frontWork.ts`). */
  readonly newWork?: boolean
  /**
   * The settings card (`view/shell.ts`): drawn closed on every front a reader
   * who may see the management side gets, open on an area's address.
   */
  readonly settings?: SettingsCard
  /**
   * A Work face with no conversation in it, and the one line that says why:
   * no chat channel here, or an identity that may not hold one. The side
   * list and the page say it; there is no composer.
   */
  readonly chatless?: string
  /**
   * The Code face (`/code`) instead of a Work face: `desktop` is the desktop
   * app's cookie, which draws the local agents' panel from the first paint.
   */
  readonly code?: {
    readonly desktop: boolean
    /** A personal account on a hub with Remote (P37.15): the copies are drawn too. */
    readonly remote?: boolean
  }
  /** Where Work goes from Code: `/app` in the desktop app, `/` in a browser. */
  readonly workHome?: string
  /**
   * The face drawn as one pane of a window's (`?pane=1`, P37.18,
   * `view/frontSplit.ts`): no settings card, the side list hidden, ⌄ and ×
   * in the bar. Only such a document may be framed (`respond.ts`).
   */
  readonly pane?: boolean
}

function composer(
  enabled: boolean,
  admin: boolean,
  t: FrontText,
  lang: Lang,
  picker = '',
): string {
  const off = enabled ? '' : ' disabled'
  // The workflows first (P37.17 B): `/` picks one for the next line.
  const commands =
    workflowOptions(lang) +
    CHAT_LOCAL_COMMANDS.map(
      name =>
        `<button type="button" class="fx-cmd" role="option" id="${attr(`fx-cmd-${name}`)}" ` +
        `data-cmd="${attr(`/${name}`)}" tabindex="-1">` +
        `<code class="mono">/${escapeHtml(name)}</code><span>${escapeHtml(t.commandWords[name] ?? '')}</span></button>`,
    ).join('')
  return (
    `<form class="fx-composer" id="fx-composer" novalidate>` +
    `<div class="fx-cmds" id="fx-cmds" role="listbox" aria-label="${attr(t.localCommands)}" hidden>${commands}</div>` +
    flowChip(lang) +
    `<label class="sr-only" for="fx-text">${escapeHtml(t.message)}</label>` +
    `<textarea id="fx-text" rows="1" spellcheck="false" ` +
    `maxlength="${attr(String(MAX_CHAT_TEXT_LENGTH))}" aria-describedby="fx-status" ` +
    `aria-controls="fx-cmds" ` +
    `placeholder="${attr(t.placeholder)}"${off}></textarea>` +
    `<div class="fx-tools">` +
    `<button type="button" class="fx-icon-btn fx-plus" id="fx-plus" data-action="fx-plus" ` +
    `aria-label="${attr(t.commands)}" aria-controls="fx-cmds" aria-expanded="false"${off}>${icon('plus', { small: true })}</button>` +
    picker +
    composerPickers(t, admin, enabled) +
    `<button type="button" class="fx-icon-btn fx-mic" id="fx-mic" data-action="fx-mic" ` +
    `aria-label="${attr(t.voiceInput)}" aria-pressed="false" hidden>${icon('mic', { small: true })}</button>` +
    `<button type="submit" class="fx-send" id="fx-send" aria-label="${attr(t.send)}"${off}>` +
    `${icon('arrow-up', { small: true })}</button></div>` +
    `<p class="fx-status" id="fx-status" role="status"></p>` +
    `</form>`
  )
}

/**
 * The agent picker under the composer's line: who the next conversation
 * goes to on `/app`'s welcome, and 由谁来做 on the new work page of either
 * face (P37.17 B) — the main agent unless another was picked. Shown only
 * there; an open conversation already has its agent, and on `/` an agent's
 * welcome is that agent's. Its menu is the side fragment's
 * `#fx-agent-menu`, redrawn with the side list.
 */
function agentPicker(model: FrontDocumentModel, t: FrontText): string {
  const address = model.picked ?? ''
  const name = address === '' ? t.pickAgent : namesOf(address).agent
  const face =
    address === '' ? '' : avatarSvg(model.faces.agent(address), { size: 18 })
  const shown =
    model.welcome && (model.newWork === true || model.layout === 'chat')
  return (
    `<div class="fx-pick fx-agent-pick" id="fx-agent-pick"${shown ? '' : ' hidden'}>` +
    `<button type="button" class="fx-pick-btn fx-agent-btn" id="fx-agent-btn" aria-haspopup="menu" ` +
    `aria-expanded="false" aria-controls="fx-agent-menu" title="${attr(t.pickAgent)}">` +
    `<span class="fx-agent-btn-face" id="fx-agent-face">${face}</span>` +
    `<span class="fx-agent-btn-name" id="fx-agent-name">${escapeHtml(name)}</span>${chevron()}</button>` +
    model.side.roster +
    `</div>`
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

/**
 * The foot of the side list: 我 and the role, the slider that opens the
 * settings card, and the account menu behind ⋯ (外观, 主题色, 语言, 设置,
 * 退出). The two ways into the card are links to `/admin`, which the card's
 * runtime takes (`data-settings`); a browser without script loads the area.
 */
function sideFoot(model: FrontDocumentModel): string {
  const t = FRONT_TEXT[model.lang]
  const me = avatarSvg(model.faces.self, { size: 28 })
  const role = model.viewer?.roleText ?? roleText(model.role, t)
  const settings = model.settings !== undefined
  return (
    `<div class="fx-side-foot">` +
    `<span class="fx-me">${me}<span class="fx-me-text"><b>${escapeHtml(t.me)}</b><span>${escapeHtml(
      role,
    )}</span></span></span>` +
    (settings
      ? `<a class="fx-icon-btn" href="${ADMIN}" data-settings aria-label="${attr(t.settings)}" title="${attr(t.settings)}">` +
        `${icon('settings', { small: true })}</a>`
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
    (settings
      ? `<a class="fx-menu-item" role="menuitem" href="${ADMIN}" data-settings>${icon('settings', { small: true })}${escapeHtml(t.settings)}</a>`
      : '') +
    // In the desktop app this form is the device's sign-out instead
    // (`assets/frontShell.ts`, `qmo_sign_out`).
    `<form method="post" action="/logout" class="fx-menu-form fx-sign-out">` +
    `<button type="submit" class="fx-menu-item" role="menuitem">${icon('log-out', { small: true })}${escapeHtml(t.signOut)}</button>` +
    `</form></div></details></div>`
  )
}

/**
 * Work | Code: the two modes, one switch the width of the side list, under
 * the brand (P37.13, `qmo-local.md` §3.6). Work is the conversations — the
 * face this document is, or from Code the desktop app's `/app` (`/` in a
 * browser); Code is `/code`. The current mode is not a link anywhere else.
 */
function modeSwitch(
  current: 'work' | 'code',
  work: string,
  t: FrontText,
): string {
  const item = (mode: 'work' | 'code', href: string, name: string): string =>
    `<a class="fx-switch-item" href="${attr(href)}" data-to="${mode}"` +
    `${mode === current ? ' aria-current="page"' : ''}>${escapeHtml(name)}</a>`
  return (
    `<nav class="fx-switch" aria-label="${attr(t.modes)}">` +
    item('work', work, t.work) +
    item('code', '/code', t.code) +
    `</nav>`
  )
}

/**
 * Over Work's list: what it lists, and the two lists as two small icons —
 * 对话 (`/app`, the conversations by day) and 智能体 (`/`, the agents). They
 * behave as the old 对话 · 智能体 switch did: the page carries the open
 * conversation across (`assets/frontClient.ts`, `.fx-mode-item`).
 */
function listHead(layout: FrontLayout, t: FrontText): string {
  const item = (to: FrontLayout, name: string, mark: string): string =>
    `<a class="fx-mode-item" href="${FRONT_HOME[to]}" data-mode="${to}" aria-label="${attr(name)}" title="${attr(name)}"` +
    `${to === layout ? ' aria-current="page"' : ''}>${icon(mark, { small: true })}</a>`
  return (
    `<div class="fx-list-head">` +
    `<span class="fx-list-title">${escapeHtml(layout === 'chat' ? t.faceChat : t.faceAgents)}</span>` +
    `<nav class="fx-mode" aria-label="${attr(t.faces)}">` +
    item('chat', t.faceChat, 'messages-square') +
    item('agents', t.faceAgents, 'bot') +
    `</nav></div>`
  )
}

/**
 * A shortcut's keys: `Mod` is ⌘ on a Mac and Ctrl elsewhere, `Ctrl` is ⌃ on
 * a Mac, and `ModAlt` ⌘ on a Mac and Alt elsewhere, so ⌃⌘\ reads Ctrl Alt \
 * off a Mac (P37.18). The page decides (`assets/frontShell.ts`).
 */
function keyCaps(keys: string): string {
  return keys
    .split(' ')
    .map(key =>
      key === 'Mod'
        ? `<kbd data-mod>Ctrl</kbd>`
        : key === 'Shift'
          ? `<kbd data-shift>Shift</kbd>`
          : key === 'Ctrl'
            ? `<kbd data-ctrl>Ctrl</kbd>`
            : key === 'ModAlt'
              ? `<kbd data-modalt>Alt</kbd>`
              : `<kbd>${escapeHtml(key)}</kbd>`,
    )
    .join('')
}

/**
 * The side's head, the same on every face: the brand and the collapse
 * button (the window's drag strip in the desktop app, its traffic lights
 * at the left on macOS), then Work | Code.
 */
function sideHead(
  home: string,
  mode: 'work' | 'code',
  work: string,
  t: FrontText,
): string {
  return (
    `<div class="fx-side-top" data-tauri-drag-region>` +
    `<a class="fx-brand" href="${attr(home)}">${qianmoMark(22)}` +
    `<b class="fx-brand-name">${escapeHtml(WORDMARK_CN)}</b></a>` +
    `<button type="button" class="fx-icon-btn" data-action="fx-side" aria-label="${attr(t.collapseSide)}" aria-controls="fx-side">` +
    `${icon('panel-left', { small: true })}</button></div>` +
    modeSwitch(mode, work, t)
  )
}

/**
 * Work's rows under the switch: 开始一项工作 (P37.17 B, 广泛性工作; ⌘N, or
 * ⌘⇧O in a browser) and 搜索. Talking to an agent is its row in the list
 * (P37.17 A), so there is no 新对话 here.
 */
function workRows(
  t: FrontText,
  layout: FrontLayout,
  lang: Lang,
  current: boolean,
): string {
  return (
    `<div class="fx-side-rows">` +
    `<a class="fx-row fx-new-work" id="fx-new-work" href="${attr(`${FRONT_HOME[layout]}?work=new`)}" ` +
    `data-action="fx-new-work"${current ? ' aria-current="true"' : ''}>` +
    `${icon('square-pen', { small: true })}<span class="fx-row-word">${escapeHtml(WORK_TEXT[lang].newWork)}</span>` +
    `<span class="fx-row-keys" aria-hidden="true"><span class="fx-key-shell">${keyCaps('Mod N')}</span>` +
    `<span class="fx-key-web">${keyCaps('Mod Shift O')}</span></span></a>` +
    `<label class="fx-row fx-search">${icon('search', { small: true })}<span class="sr-only">${escapeHtml(t.search)}</span>` +
    `<input type="search" id="fx-search" placeholder="${attr(t.search)}" autocomplete="off" spellcheck="false">` +
    `<span class="fx-row-keys" aria-hidden="true">${keyCaps('Mod K')}</span></label>` +
    `</div>`
  )
}

/** One row of the keyboard help. */
function keyRow(keys: string, what: string, only = ''): string {
  return (
    `<div class="fx-key${only === '' ? '' : ` fx-key-${only}`}"><dt>${escapeHtml(what)}</dt>` +
    `<dd>${keyCaps(keys)}</dd></div>`
  )
}

/**
 * The front's own keyboard help, in place of the management side's. ⌘N is
 * 开始一项工作 (P37.17 B); a browser keeps ⌘N for a new window, so there it
 * is ⌘⇧O. The quick-entry row is filled in by the desktop app
 * (`qmo_shell_info`).
 */
function keyboardHelp(t: FrontText, settings: boolean, lang: Lang): string {
  const k = t.keys
  const p = SPLIT_TEXT[lang].keys
  return (
    `<dialog class="dialog fx-keys" id="keyboard-help" aria-labelledby="keyboard-help-title">` +
    `<h2 id="keyboard-help-title">${escapeHtml(t.keyboardTitle)}</h2>` +
    `<dl class="fx-key-list">` +
    keyRow('Enter', k.send) +
    keyRow('Shift Enter', k.newline) +
    keyRow('Mod N', k.newWork, 'shell') +
    keyRow('Mod Shift O', k.newWork, 'web') +
    keyRow('Mod K', k.search) +
    keyRow('Mod B', k.side) +
    keyRow('Mod .', k.panel) +
    // The panes (P37.18, qmo-app.md §11.3).
    keyRow('Ctrl ModAlt \\', p.right) +
    keyRow('Ctrl ModAlt -', p.below) +
    keyRow('Ctrl ]', p.next) +
    keyRow('Ctrl [', p.prev) +
    keyRow('Ctrl ModAlt W', p.close) +
    (settings ? keyRow('Mod ,', k.settings) : '') +
    keyRow('Esc', k.close) +
    keyRow('?', k.help) +
    `<div class="fx-key" id="fx-key-quick" hidden><dt>${escapeHtml(k.quick)}</dt>` +
    `<dd id="fx-key-quick-keys"></dd></div>` +
    `</dl>` +
    `<button class="btn" type="button" data-action="confirm-cancel">${escapeHtml(t.close)}</button></dialog>`
  )
}

/**
 * 其他对话 (P37.17): the dialog an agent's ⋯ opens, the list in it swapped
 * with the side list (`assets/frontClient.ts`).
 */
function othersDialog(history: string, t: FrontText): string {
  return (
    `<dialog class="dialog fx-others" id="fx-others" aria-labelledby="fx-others-title">` +
    history +
    `<button class="btn" type="button" data-action="confirm-cancel">${escapeHtml(t.close)}</button></dialog>`
  )
}

/**
 * A Work face with no conversation in it: the side list and the page each
 * say the one line why (`FrontDocumentModel.chatless`). Drawn for a reader
 * who may see the management side but not hold a conversation here, under
 * the settings card.
 */
export function chatlessParts(line: string): {
  readonly side: FrontSideParts
  readonly view: FrontViewParts
} {
  const none = `<p class="fx-none">${escapeHtml(line)}</p>`
  return {
    side: {
      agents: `<section class="fx-agents" id="fx-agents">${none}</section>`,
      history: '',
      stack: '',
      recents: '',
      roster: '',
    },
    view: {
      head: '',
      thread:
        `<div class="fx-thread" id="fx-thread" data-target="" data-open="0" data-welcome="1">` +
        `<div class="fx-welcome"><h2 class="fx-welcome-title">${escapeHtml(line)}</h2></div></div>`,
      activity: '',
    },
  }
}

/**
 * What the document's policy allows beyond the one script it carries: the
 * open area's page script and those of the areas its reader can move to in
 * the card (`view/shell.ts`, `shellScripts`). Hand it to `html()` with the
 * document.
 */
export function frontAllow(model: FrontDocumentModel): readonly string[] {
  return model.settings === undefined ? [] : shellScripts(model.settings.model)
}

/** The whole front document: a Work face (`/`, `/app`) or Code (`/code`). */
export function renderFrontDocument(model: FrontDocumentModel): string {
  const layout = model.layout ?? 'agents'
  const code = model.code !== undefined
  const chat = !code && layout === 'chat'
  const chatless = code || model.chatless !== undefined
  const runtime =
    model.viewer === undefined ? CONSOLE_CLIENT_JS : CONSOLE_CLIENT_JS_ACCOUNTS
  // 部署到新服务器 rides only on a console that has it: everyone else's page
  // stays byte for byte what it was.
  const replicate = chatless ? 'off' : (model.replicate ?? 'off')
  const approvals = chatless ? undefined : model.approvals
  // A pane (P37.18) is one conversation of a window's: the card is the window's.
  const pane = model.pane === true
  const card = pane ? undefined : model.settings
  const open = card?.open === true ? card.model : undefined
  // The card's runtime after the front's own, then the open area's script
  // inside its recording scope (`assets/nav.ts`).
  const script =
    runtime +
    // Ahead of the front's own: the hooks they look for (assets/frontSplit.ts).
    FRONT_SPLIT_JS +
    FRONT_JS +
    (chatless ? '' : FRONT_TOOLS_JS + FRONT_PANEL_JS + FRONT_WORK_JS) +
    FRONT_SHELL_JS +
    // The figure editor's script goes with the editor (below).
    (model.faces.editable ? AVATAR_PAGE_JS : '') +
    (code
      ? (model.code?.remote === true ? CODE_HUB_JS : '') +
        CODE_RENDER_JS +
        CODE_JS
      : '') +
    (replicate === 'off' ? '' : FRONT_REPLICATE_JS) +
    (approvals === undefined ? '' : FRONT_APPROVAL_JS) +
    (card === undefined
      ? ''
      : CONSOLE_NAV_JS + (open?.pageScript ?? '') + NAV_MOUNTED_JS)
  const t = FRONT_TEXT[model.lang]
  const name = code ? t.code : chat ? t.faceChat : t.chat
  const workTitle = `${WORDMARK_CN} · ${name} · ${model.label}`
  const home = code ? '/code' : FRONT_HOME[layout]
  const work = code ? (model.workHome ?? FRONT_HOME.agents) : home
  // Both faces list the agents, then the conversations that are not with
  // one agent (P37.17); the faces differ in how a conversation reads.
  const sideList = code
    ? codeSide(t)
    : listHead(layout, t) +
      `<div class="fx-side-scroll" id="fx-side-scroll">${model.side.agents}${model.side.recents}</div>`
  const top =
    `<header class="fx-top" data-tauri-drag-region>` +
    `<button type="button" class="fx-icon-btn fx-side-open" data-action="fx-side" aria-label="${attr(t.expandSide)}" aria-controls="fx-side">` +
    `${icon('panel-left', { small: true })}</button>` +
    `<div class="fx-head-mount" data-tauri-drag-region>${code ? codeHead() : model.view.head}</div>` +
    (pane ? paneMenu(model.lang) : '') +
    `<div class="fx-top-tail"><span class="fx-live" id="fx-live"></span>` +
    (code ? codeTail(t, model.lang) : '') +
    (chatless ? '' : frontPanelToggle(t)) +
    (pane ? paneClose(model.lang) : '') +
    `</div>` +
    `</header>`
  const page = code
    ? codeMain(
        t,
        model.lang,
        model.code?.desktop === true,
        model.code?.remote === true,
      )
    : `<div class="fx-scroll" id="fx-scroll"><div class="fx-column">${model.view.thread}` +
      (approvals === undefined
        ? ''
        : frontApprovalCards(model.lang, approvals)) +
      `</div></div>` +
      (chatless
        ? ''
        : `<div class="fx-dock"><div class="fx-column">` +
          `<button type="button" class="fx-jump" id="fx-jump" data-action="fx-jump" aria-label="${attr(t.jumpToLatest)}" hidden>` +
          `${icon('arrow-down', { small: true })}</button>` +
          model.side.stack +
          (replicate === 'off' ? '' : frontReplicateCard(replicate)) +
          (approvals === undefined ? '' : frontApprovalBar(model.lang)) +
          composer(
            model.composerEnabled,
            model.admin,
            t,
            model.lang,
            agentPicker(model, t),
          ) +
          `</div></div>`)
  return (
    documentHead(
      open === undefined ? workTitle : documentTitle(open),
      open?.pageCss ?? '',
      [script, ...frontAllow(model)],
      {
        shared:
          FRONT_CSS +
          (chatless ? '' : FRONT_TOOLS_CSS + FRONT_PANEL_CSS + FRONT_WORK_CSS) +
          FRONT_SPLIT_CSS +
          AVATAR_CSS +
          (replicate === 'off' ? '' : FRONT_REPLICATE_CSS) +
          (approvals === undefined ? '' : FRONT_APPROVAL_CSS),
      },
    ).replace('<html lang="zh-CN">', `<html lang="${attr(model.lang)}">`) +
    `<body class="fx-body${pane ? ' fx-pane-doc' : ''}">\n` +
    (code || chatless
      ? ''
      : `<a class="skip-link" href="#fx-text">${escapeHtml(t.skipToBox)}</a>\n`) +
    `<h1 class="sr-only">${escapeHtml(`${WORDMARK_CN} · ${name}`)}</h1>` +
    `<div class="fx" id="fx" data-layout="${code ? 'code' : layout}"${chatless ? ' data-chatless' : ''}${pane ? ' data-pane="1"' : ''} ` +
    `data-side="open" data-text="${attr(frontClientText(model.lang))}" data-split-text="${attr(splitText(model.lang))}">` +
    `<aside class="fx-side" id="fx-side" aria-label="${attr(code ? t.codeSessions : chat ? t.recents : t.agents)}">` +
    sideHead(home, code ? 'code' : 'work', work, t) +
    (code || chatless
      ? ''
      : workRows(t, layout, model.lang, model.newWork === true)) +
    sideList +
    sideFoot(model) +
    (model.source === undefined
      ? ''
      : sourceFooter(model.source, 'foot fx-source')) +
    `</aside>` +
    `<button type="button" class="fx-scrim" data-action="fx-side-close" aria-label="${attr(t.closeSide)}" tabindex="-1"></button>` +
    `<main class="fx-main${model.welcome || (chatless && !code) ? ' is-welcome' : ''}${code ? ' fx-code' : ''}" id="fx-main">` +
    top +
    `<p class="fx-offline" id="fx-offline" role="status" hidden>${escapeHtml(t.offline)}</p>` +
    `<div class="fx-progress" aria-hidden="true"></div>` +
    viewerNotice(model.viewer) +
    page +
    `</main>` +
    (chatless ? '' : frontPanelFrame(t, model.view.activity)) +
    `</div>\n` +
    (card === undefined
      ? ''
      : renderSettings(
          card,
          {
            settings: t.settings,
            search: t.settingsSearch,
            close: t.closeSettings,
            noMatch: t.noMatch,
            desktop: t.desktopApp,
            skip: t.skipToArea,
          },
          workTitle,
        )) +
    sessionExpired(model.relogin, model.lang) +
    // A row's right-click menu (P37.18), where panes may open.
    (pane || (chatless && !code) ? '' : splitFrame(model.lang)) +
    `<div class="toasts" id="toasts" aria-live="polite" aria-relevant="additions"></div>\n` +
    `<p id="reply-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>` +
    keyboardHelp(t, card !== undefined, model.lang) +
    (chatless ? '' : othersDialog(model.side.history, t)) +
    // A work session's files (P37.17 B): the preview, and the rows the page
    // adds when the outputs folder lists more than was delivered.
    (chatless ? '' : previewDialog(model.lang) + fileTemplates(model.lang)) +
    (chatless ? '' : permissionConfirm(t)) +
    // The figure editor, for a reader who may dress a figure (`routes/avatars.ts`).
    (model.faces.editable ? avatarDialog(model.lang) : '') +
    `<script>${script}</script>\n` +
    `</body>\n</html>\n`
  )
}
