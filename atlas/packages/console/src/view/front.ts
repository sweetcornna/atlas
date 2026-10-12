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
 * Three columns' worth of information in two: a side panel and the
 * conversation. The side panel holds who there is to talk to and what has
 * been said, the conversation holds one exchange and its composer. The
 * layout borrows from the agent desktops people already use (hermes desktop,
 * Grok): the transcript as one centred column, the person's own lines as
 * right-hand bubbles, the agent's answers as unboxed text under its name, the
 * process folded into one line per step group, the composer pinned under the
 * column, and on an empty conversation the composer moves up to the middle
 * under the agent's greeting.
 *
 * ## 主智能体, 节点智能体 and 子智能体
 *
 * The **main agent** is the one the front opens by default: the console's
 * `--chat-default`, or the first agent the console may dial. Every other
 * agent in the roster is a **node agent** (节点智能体), listed under the
 * server (node) it runs on, and any of them can be talked to from here
 * directly: picking one starts a conversation with it, on whichever server
 * it lives. The panel says which agents are working right now (a session
 * with a task still unanswered), and the strip above the composer lists
 * those other conversations, so work left running elsewhere stays in view
 * while the person talks to the main one.
 *
 * A **sub-agent** (子智能体) is what an agent spawns inside one turn to do
 * part of the work (omp's `task` tool). The node reports each spawn as a
 * process line starting with {@link SUBAGENT_STEP_LABEL}; the thread draws
 * those lines as sub-agents, and the step group's summary counts them.
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
import {
  CHAT_LOCAL_COMMANDS,
  type ChatLocalCommand,
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
import { formatClock, formatRelative } from './format.js'
import { FRONT_CSS } from './frontStyle.js'
import { renderRichText } from './richText.js'
import {
  documentHead,
  sessionExpired,
  WORDMARK_CN,
  WORDMARK_EN,
} from './shell.js'

/** The management side's home, where the panel's admin links point. */
const ADMIN = '/admin'

/** How much of a notice's summary one step line shows. */
const STEP_LENGTH = 160

/**
 * What a process line reporting a sub-agent spawn starts with. A copy of
 * the resident's `SUBAGENT_STEP_LABEL` (`@qianmo/resident`, `omp-turn.ts`):
 * the console does not depend on the resident, so the node package pins the
 * two equal (`test/host/subagentStepLabel.test.ts`).
 */
export const SUBAGENT_STEP_LABEL = '委派子智能体'

/** How much of a session's first line the history list shows. */
const TITLE_LENGTH = 40

/** Rows the strip above the composer lists before it stops. */
const STACK_ROWS = 6

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function clockTag(at: number, cls: string): string {
  return (
    `<time class="${attr(cls)}" data-at="${attr(String(at))}"${timeAttrs(at, 'clock')}>` +
    `${escapeHtml(formatClock(at))}</time>`
  )
}

/** The opening lines the empty conversation offers, sent as written. */
const SUGGESTIONS: readonly string[] = [
  '检查各节点的运行状态',
  '总结最近一天的审计记录',
  '说明你能使用的工具',
  '列出今天需要处理的事项',
]

/** What each local command does, as the composer's command list says it. */
const COMMAND_WORDS: Readonly<Record<ChatLocalCommand, string>> = {
  model: '查看或切换本会话的模型',
  thinking: '打开或关闭本会话的思考',
  effort: '查看或调整本会话的推理档位',
  compact: '压缩本会话的上下文',
  context: '查看本会话的上下文用量',
  autocompact: '设置整台节点的自动压缩阈值 · 需要运维权限',
}

// --- who there is to talk to --------------------------------------------------

/** Sessions per agent: how many, and how many are waiting for an answer. */
interface AgentLoad {
  readonly sessions: number
  readonly running: number
}

function loadsOf(
  sessions: readonly ChatSession[],
): ReadonlyMap<string, AgentLoad> {
  const out = new Map<string, AgentLoad>()
  for (const session of sessions) {
    const was = out.get(session.target) ?? { sessions: 0, running: 0 }
    out.set(session.target, {
      sessions: was.sessions + 1,
      running: was.running + (session.running === true ? 1 : 0),
    })
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
}

function agentMenu(
  target: ChatTarget,
  faces: ChatFaces,
  admin: boolean,
): string {
  const node = encodeURIComponent(target.node)
  const items =
    (target.dialable
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-agent-new" ` +
        `data-address="${attr(target.address)}">${icon('square-pen', { small: true })}新对话</button>`
      : '') +
    (faces.editable
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="avatar-edit" ` +
        `data-key="${attr(`agent:${target.address}`)}" data-name="${attr(target.agent)}">` +
        `${icon('sparkles', { small: true })}换形象</button>`
      : '') +
    `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-copy" ` +
    `data-copy="${attr(target.address)}">${icon('copy', { small: true })}复制地址</button>` +
    (admin
      ? `<a class="fx-menu-item" role="menuitem" href="${attr(`${ADMIN}/nodes/${node}`)}">` +
        `${icon('server', { small: true })}节点详情</a>` +
        `<a class="fx-menu-item" role="menuitem" href="${attr(`${ADMIN}/providers/nodes/${node}`)}">` +
        `${icon('cpu', { small: true })}模型设置</a>`
      : '')
  return (
    `<details class="fx-more">` +
    `<summary class="fx-icon-btn fx-more-btn" aria-label="${attr(`${target.agent} 的操作`)}">` +
    `${icon('ellipsis', { small: true })}</summary>` +
    `<div class="fx-menu" role="menu">${items}</div></details>`
  )
}

function agentRow(
  target: ChatTarget,
  model: FrontSideModel,
  load: AgentLoad | undefined,
  main: boolean,
): string {
  const verdict = targetState(target, false)
  const current = target.address === model.selected
  const running = load?.running ?? 0
  const sessions = load?.sessions ?? 0
  const size = main ? 40 : 30
  const figure = avatarSvg(model.faces.agent(target.address), {
    size,
    state:
      verdict.tone === 'ok' ? (running > 0 ? 'thinking' : 'idle') : 'sleep',
    ...(main ? { uid: 'av-main', live: true } : {}),
  })
  const tail =
    running > 0
      ? `<span class="fx-badge fx-badge-live"><span class="fx-pulse"></span>${escapeHtml(
          `${running} 执行中`,
        )}</span>`
      : sessions > 0
        ? `<span class="fx-agent-count">${escapeHtml(String(sessions))}</span>`
        : ''
  const cls =
    `fx-agent-row${main ? ' fx-agent-main' : ''}${current ? ' is-current' : ''}` +
    `${target.dialable ? '' : ' is-off'}`
  return (
    `<div class="${cls}" data-address="${attr(target.address)}">` +
    `<button type="button" class="fx-agent" data-action="fx-agent" ` +
    `data-address="${attr(target.address)}"${current ? ' aria-current="true"' : ''}>` +
    `<span class="fx-agent-face">${figure}` +
    `<span class="fx-presence dot dot-${attr(verdict.tone)}"></span></span>` +
    `<span class="fx-agent-text">` +
    `<span class="fx-agent-name">${escapeHtml(target.agent)}</span>` +
    `<span class="fx-agent-sub">${escapeHtml(
      main ? `${target.node} · ${verdict.text}` : verdict.text,
    )}</span></span>` +
    tail +
    `</button>` +
    agentMenu(target, model.faces, model.admin) +
    `</div>`
  )
}

/** Servers in roster order, each with its agents, the main agent left out. */
function serversOf(
  targets: readonly ChatTarget[],
  main: string | null,
): readonly (readonly [string, readonly ChatTarget[]])[] {
  const byNode = new Map<string, ChatTarget[]>()
  for (const target of targets) {
    if (target.address === main) continue
    const bucket = byNode.get(target.node)
    if (bucket === undefined) byNode.set(target.node, [target])
    else bucket.push(target)
  }
  return [...byNode.entries()]
}

function renderAgents(model: FrontSideModel): string {
  const open = `<section class="fx-sec fx-agents" id="fx-agents" aria-label="智能体">`
  if (model.targets === null) {
    return (
      open +
      `<p class="fx-none">${escapeHtml('名册不可达 · 智能体列表暂时读不到 · 已有会话照常可开')}</p>` +
      `</section>`
    )
  }
  if (model.targets.length === 0) {
    return (
      open +
      `<p class="fx-none">${escapeHtml('注册中心里没有可对话的智能体')}</p>` +
      (model.admin
        ? `<a class="fx-side-link" href="${ADMIN}/nodes">${icon('server', { small: true })}管理节点</a>`
        : '') +
      `</section>`
    )
  }
  const loads = loadsOf(model.sessions)
  const main = model.targets.find(target => target.address === model.main)
  const servers = serversOf(model.targets, model.main)
  const subCount = servers.reduce((sum, [, agents]) => sum + agents.length, 0)
  const mainBlock =
    main === undefined
      ? ''
      : `<h2 class="fx-sec-title">主智能体</h2>` +
        agentRow(main, model, loads.get(main.address), true)
  const subs =
    servers.length === 0
      ? ''
      : `<h2 class="fx-sec-title">节点智能体<span class="fx-count">${escapeHtml(
          String(subCount),
        )}</span></h2>` +
        servers
          .map(([node, agents]) => {
            const online = agents.filter(
              target => targetState(target, false).tone === 'ok',
            ).length
            const busy = agents.reduce(
              (sum, target) => sum + (loads.get(target.address)?.running ?? 0),
              0,
            )
            return (
              `<details class="fx-server" open data-key="${attr(`server:${node}`)}">` +
              `<summary class="fx-server-head">` +
              `${icon('server', { small: true })}` +
              `<span class="fx-server-name mono">${escapeHtml(node)}</span>` +
              `<span class="fx-server-meta">${escapeHtml(
                `${online}/${agents.length} 在线${busy > 0 ? ` · ${busy} 执行中` : ''}`,
              )}</span>` +
              `${chevron()}</summary>` +
              `<div class="fx-server-body">${agents
                .map(target =>
                  agentRow(target, model, loads.get(target.address), false),
                )
                .join('')}</div></details>`
            )
          })
          .join('')
  return (
    open +
    mainBlock +
    subs +
    (model.admin
      ? `<a class="fx-side-link" href="${ADMIN}/nodes">${icon('server', { small: true })}管理节点与智能体</a>`
      : '') +
    `</section>`
  )
}

// --- what has been said ---------------------------------------------------------

/** Rolling windows rather than calendar days: the server's zone is not the reader's. */
const HISTORY_WINDOWS: readonly (readonly [string, number])[] = [
  ['24 小时内', 24 * 60 * 60 * 1000],
  ['7 天内', 7 * 24 * 60 * 60 * 1000],
  ['30 天内', 30 * 24 * 60 * 60 * 1000],
  ['更早', Number.POSITIVE_INFINITY],
]

function sessionTitle(session: ChatSession): string {
  const title = session.title ?? ''
  if (title.trim() !== '') return truncate(title, TITLE_LENGTH)
  if (session.preview.trim() !== '') return chatPreview(session.preview)
  return '新对话'
}

function historyItem(
  session: ChatSession,
  model: FrontSideModel,
  hidden: boolean,
): string {
  const active = session.id === model.activeId
  return (
    `<button type="button" class="fx-hitem${active ? ' is-active' : ''}" data-action="fx-open" ` +
    `data-session="${attr(session.id)}" data-target="${attr(session.target)}"` +
    `${active ? ' aria-current="true"' : ''}${hidden ? ' hidden' : ''}>` +
    `<span class="fx-hitem-title">${escapeHtml(sessionTitle(session))}</span>` +
    `<span class="fx-hitem-meta">` +
    (session.running === true
      ? `<span class="fx-pulse" aria-label="执行中"></span>`
      : '') +
    `<span class="fx-hitem-who">${escapeHtml(session.agent)}</span>` +
    `<span>${escapeHtml(formatRelative(session.updatedAt, model.now))}</span>` +
    `</span></button>`
  )
}

function renderHistory(model: FrontSideModel): string {
  const head =
    `<div class="fx-sec-head"><h2 class="fx-sec-title">会话</h2>` +
    `<div class="fx-seg" role="group" aria-label="会话范围">` +
    `<button type="button" data-action="fx-scope" data-scope="agent" aria-pressed="true">当前智能体</button>` +
    `<button type="button" data-action="fx-scope" data-scope="all" aria-pressed="false">全部</button>` +
    `</div></div>`
  const open =
    `<section class="fx-sec fx-history" id="fx-history" aria-label="会话列表" ` +
    `data-selected="${attr(model.selected ?? '')}">`
  if (model.sessionsFailure !== null) {
    return (
      open + head + failureBar(model.sessionsFailure, '会话列表') + `</section>`
    )
  }
  const ordered = [...model.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  let start = 0
  const groups: string[] = []
  for (const [label, span] of HISTORY_WINDOWS) {
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
    groups.join('') +
    `<p class="fx-none" data-empty="agent"${mine ? ' hidden' : ''}>还没有和这个智能体的会话</p>` +
    `<p class="fx-none" data-empty="all"${ordered.length === 0 ? '' : ' hidden'}>还没有会话</p>` +
    `<p class="fx-none" data-empty="search" hidden>没有匹配的会话</p>` +
    `</section>`
  )
}

/**
 * The strip above the composer: the other conversations still waiting for
 * an answer, so work left running with another agent stays in view while
 * the person talks to this one.
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
  const label = `其他会话执行中 · ${running.length}`
  const rows = running
    .slice(0, STACK_ROWS)
    .map(
      session =>
        `<button type="button" class="fx-stack-row" data-action="fx-open" data-session="${attr(
          session.id,
        )}">` +
        `<span class="fx-stack-face">${avatarSvg(
          model.faces.agent(session.target),
          {
            size: 22,
            state: 'thinking',
          },
        )}</span>` +
        `<span class="fx-stack-who">${escapeHtml(session.agent)}</span>` +
        `<span class="fx-stack-node mono">${escapeHtml(session.node)}</span>` +
        `<span class="fx-stack-what">${escapeHtml(sessionTitle(session))}</span>` +
        `<span class="fx-stack-when">${escapeHtml(
          formatRelative(session.updatedAt, model.now),
        )}</span>` +
        `<span class="tail-dot" aria-hidden="true"></span></button>`,
    )
    .join('')
  const more =
    running.length > STACK_ROWS
      ? `<p class="fx-stack-more">${escapeHtml(`另有 ${running.length - STACK_ROWS} 条 · 在会话列表里`)}</p>`
      : ''
  return (
    `<div class="fx-stack" id="fx-stack">` +
    `<details class="fx-stack-card" open data-key="stack">` +
    `<summary class="fx-stack-head">${icon('bot', { small: true })}` +
    `<span class="fx-stack-label">${escapeHtml(label)}</span>${chevron()}</summary>` +
    `<div class="fx-stack-rows">${rows}${more}</div></details></div>`
  )
}

/** The side's three mounts, apart: the document puts the strip in the dock. */
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
}

/** The three facts under a person's line, as one compact mark. */
function deliveryMark(turn: ChatTurn): string {
  if (turn.state === 'failed') {
    return `<span class="fx-fail">${escapeHtml(failureWords(turn.code))}</span>`
  }
  const receipted = turn.receipt !== undefined
  const read = turn.readMs !== undefined
  const facts = [
    '已发出',
    receipted
      ? `已投递 · 回执 ${turn.receipt ?? ''}${
          turn.receiptMs === undefined
            ? ''
            : ` · ${formatLatency(turn.receiptMs)}`
        }`
      : turn.deliveryUnknown === true
        ? '回执未知'
        : '待投递',
    read ? `已读 · ${formatLatency(turn.readMs ?? 0)}` : '未读',
  ]
  const text = read
    ? `已读 · ${formatLatency(turn.readMs ?? 0)}`
    : receipted
      ? '已投递'
      : turn.deliveryUnknown === true
        ? '回执未知'
        : '待投递'
  return (
    `<span class="fx-chain" title="${attr(facts.join(' · '))}">` +
    `<i class="on"></i><i${receipted ? ' class="on"' : ''}></i><i${read ? ' class="on"' : ''}></i>` +
    `</span><span>${escapeHtml(text)}</span>`
  )
}

function idMarks(turn: ChatTurn, admin: boolean): string {
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
    const shown = `链 ${hex.slice(0, 8)}`
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

function userTurn(turn: ChatTurn, admin: boolean): string {
  return (
    `<article class="fx-msg fx-msg-user${turn.state === 'failed' ? ' is-failed' : ''}">` +
    `<div class="fx-bubble">${renderRichText(turn.text)}</div>` +
    `<div class="fx-meta">${clockTag(turn.at, 'fx-when')}${deliveryMark(turn)}` +
    `${idMarks(turn, admin)}</div></article>`
  )
}

function agentTurn(
  turn: ChatTurn,
  agent: string,
  address: string,
  faces: ChatFaces,
  admin: boolean,
): string {
  const failed = turn.state === 'failed'
  const face = avatarSvg(faces.agent(address), {
    size: 30,
    state: failed ? 'error' : 'idle',
  })
  const body =
    turn.command !== undefined
      ? `<pre class="fx-pre"><code>${escapeHtml(
          turn.text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd(),
        )}</code></pre>`
      : `<div class="fx-text">${renderRichText(turn.text)}</div>`
  const who =
    turn.command !== undefined
      ? `<span class="fx-msg-name">命令输出</span><code class="mono fx-cmd-name">/${escapeHtml(
          turn.command,
        )}</code>`
      : `<span class="fx-msg-name">${escapeHtml(agent)}</span>`
  return (
    `<article class="fx-msg fx-msg-agent${failed ? ' is-failed' : ''}${
      turn.command !== undefined ? ' fx-msg-cmd' : ''
    }">` +
    `<span class="fx-msg-face" aria-hidden="true">${face}</span>` +
    `<div class="fx-msg-body">` +
    `<header class="fx-msg-head">${who}${clockTag(turn.at, 'fx-when')}</header>` +
    body +
    `<div class="fx-meta">` +
    (failed
      ? `<span class="fx-fail">${escapeHtml(failureWords(turn.code))}</span>`
      : '') +
    (turn.elapsedMs === undefined
      ? ''
      : `<span>${escapeHtml(`用时 ${formatLatency(turn.elapsedMs)}`)}</span>`) +
    idMarks(turn, admin) +
    `<button type="button" class="fx-mini" data-action="fx-copy-turn" aria-label="复制这条回复">` +
    `${icon('copy', { small: true })}<span>复制</span></button>` +
    `</div></div></article>`
  )
}

const STEP_TONE: Readonly<Record<string, Tone>> = {
  info: 'muted',
  warn: 'warn',
  error: 'bad',
}

/**
 * Consecutive process lines, folded into one line that says how many steps
 * and what the last one was. Open while the turn they belong to is still
 * running, folded once it has answered; the client keeps whichever way the
 * person left it across redraws (`data-key`).
 */
/**
 * The spawn a process line reports, when it reports one: how many sub-agents
 * (a batch says `× N`) and who they are. A failed spawn's line is a step
 * like any other failure, and counts none.
 */
function spawnOf(
  step: ChatTurn,
): { readonly count: number; readonly who: string } | null {
  if (!step.text.startsWith(SUBAGENT_STEP_LABEL)) return null
  if (step.severity === 'warn' || step.severity === 'error') return null
  const rest = step.text.slice(SUBAGENT_STEP_LABEL.length)
  const batch = /^ × (\d+)/.exec(rest)
  const count = batch === null ? 1 : Number(batch[1])
  const colon = rest.indexOf('：')
  return {
    count: Number.isSafeInteger(count) && count > 0 ? count : 1,
    who: colon === -1 ? '' : rest.slice(colon + 1).trim(),
  }
}

/** One sub-agent spawn, in place of a plain step line. */
function spawnLine(step: ChatTurn, count: number, who: string): string {
  const detail =
    step.detail === undefined
      ? ''
      : `<details class="fx-step-detail"><summary>${chevron()}任务</summary>` +
        `<pre class="fx-pre fx-pre-quiet">${escapeHtml(step.detail)}</pre></details>`
  return (
    `<li class="fx-step fx-step-sub">` +
    `<span class="fx-step-mark" aria-hidden="true">${icon('bot', { small: true })}</span>` +
    `<div class="fx-step-body"><div class="fx-step-line">` +
    `<span class="fx-sub-tag">${escapeHtml(count > 1 ? `子智能体 × ${count}` : '子智能体')}</span>` +
    (who === ''
      ? ''
      : `<span class="fx-step-text fx-sub-who">${escapeHtml(truncate(who, STEP_LENGTH))}</span>`) +
    (step.redelivered === true ? `<span class="fx-id">重发</span>` : '') +
    clockTag(step.at, 'fx-when') +
    `</div>${detail}</div></li>`
  )
}

function stepGroup(steps: readonly ChatTurn[], running: boolean): string {
  const first = steps[0]
  const last = steps[steps.length - 1]
  if (first === undefined || last === undefined) return ''
  let spawned = 0
  const worst = steps.some(step => step.severity === 'error')
    ? 'bad'
    : steps.some(step => step.severity === 'warn')
      ? 'warn'
      : 'muted'
  const lines = steps
    .map(step => {
      const spawn = spawnOf(step)
      if (spawn !== null) {
        spawned += spawn.count
        return spawnLine(step, spawn.count, spawn.who)
      }
      const tone = STEP_TONE[step.severity ?? 'info'] ?? 'muted'
      const detail =
        step.detail === undefined
          ? ''
          : `<details class="fx-step-detail"><summary>${chevron()}详情</summary>` +
            `<pre class="fx-pre fx-pre-quiet">${escapeHtml(step.detail)}</pre></details>`
      return (
        `<li class="fx-step">` +
        `<span class="dot dot-${attr(tone)}" aria-hidden="true"></span>` +
        `<div class="fx-step-body"><div class="fx-step-line">` +
        `<span class="fx-step-text">${escapeHtml(truncate(step.text, STEP_LENGTH))}</span>` +
        (step.redelivered === true ? `<span class="fx-id">重发</span>` : '') +
        clockTag(step.at, 'fx-when') +
        `</div>${detail}</div></li>`
      )
    })
    .join('')
  const summary =
    `${running ? '执行中' : '执行过程'} · ${steps.length} 步` +
    (spawned === 0 ? '' : ` · 子智能体 ${spawned}`) +
    (running ? '' : ` · ${truncate(last.text, 48)}`)
  return (
    `<details class="fx-steps fx-steps-${worst}${running ? ' is-running' : ''}" ` +
    `data-key="${attr(`steps:${first.id}`)}"${running ? ' open' : ''}>` +
    `<summary class="fx-steps-head">` +
    (running
      ? `<span class="fx-spin" aria-hidden="true"></span>`
      : icon('list-checks', { small: true })) +
    `<span class="fx-steps-label">${escapeHtml(summary)}</span>${chevron()}</summary>` +
    `<ol class="fx-step-list">${lines}</ol></details>`
  )
}

/** The answer has not come yet: the agent's figure thinking, and for how long. */
function pendingTail(
  since: number,
  agent: string,
  address: string,
  faces: ChatFaces,
  now: number,
): string {
  return (
    `<div class="fx-msg fx-msg-agent fx-pending" role="status">` +
    `<span class="fx-msg-face" aria-hidden="true">${avatarSvg(
      faces.agent(address),
      {
        size: 30,
        state: 'thinking',
      },
    )}</span>` +
    `<div class="fx-msg-body"><div class="fx-typing" data-elapsed="${attr(
      String(Math.max(0, now - since)),
    )}">` +
    `<span class="fx-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
    `<span>${escapeHtml(`${agent} 正在处理 · `)}<span class="fx-typing-time">${escapeHtml(
      formatLatency(Math.max(0, now - since)),
    )}</span></span>` +
    `</div></div></div>`
  )
}

function renderMessages(
  model: FrontViewModel,
  transcript: ChatTranscript,
): string {
  const { session, turns } = transcript
  if (turns.length === 0) {
    return `<div class="fx-msgs"><p class="fx-none fx-none-center">这条会话还没有内容 · 在下面写第一句</p></div>`
  }
  const unanswered = unansweredTurns(turns)
  const waiting = unanswered.length > 0
  const out: string[] = []
  let steps: ChatTurn[] = []
  const flush = (trailing: boolean): void => {
    if (steps.length === 0) return
    out.push(stepGroup(steps, trailing && waiting))
    steps = []
  }
  for (const turn of turns) {
    if (turn.variant === 'notice') {
      steps.push(turn)
      continue
    }
    flush(false)
    out.push(
      turn.author === 'operator'
        ? userTurn(turn, model.admin)
        : agentTurn(
            turn,
            session.agent,
            session.target,
            model.faces,
            model.admin,
          ),
    )
  }
  flush(true)
  const latest = unanswered[unanswered.length - 1]
  if (latest !== undefined) {
    out.push(
      pendingTail(
        latest.at,
        session.agent,
        session.target,
        model.faces,
        model.now,
      ),
    )
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
  const address = model.agent
  if (address === null) {
    const line = model.registryDown
      ? '名册不可达 · 稍后刷新 · 已有会话在会话列表里'
      : '注册中心里没有可对话的智能体'
    return (
      `<div class="fx-welcome"><h2 class="fx-welcome-title">${escapeHtml('还没有可对话的智能体')}</h2>` +
      `<p class="fx-welcome-note">${escapeHtml(line)}</p>` +
      (model.admin
        ? `<a class="btn btn-secondary btn-small" href="${ADMIN}/nodes">管理节点</a>`
        : '') +
      `</div>`
    )
  }
  const target = model.target
  const names = target ?? namesOf(address)
  const dialable = target?.dialable === true
  const verdict = targetState(target, model.registryDown)
  const spec = model.faces.agent(address)
  const figure = avatarSvg(spec, {
    size: 112,
    uid: 'av-greet',
    live: true,
    state: verdict.tone === 'ok' || model.registryDown ? 'idle' : 'sleep',
    label: `${names.agent} · ${avatarWords(spec)}`,
  })
  const stage = model.faces.editable
    ? `<button type="button" class="fx-welcome-face" data-action="avatar-edit" ` +
      `data-key="${attr(`agent:${address}`)}" data-name="${attr(names.agent)}" ` +
      `aria-label="${attr(`换形象 · ${names.agent}`)}">${figure}</button>`
    : `<span class="fx-welcome-face">${figure}</span>`
  const chips = dialable
    ? `<div class="fx-chips" role="group" aria-label="常用开场">${SUGGESTIONS.map(
        text =>
          `<button type="button" class="fx-chip" data-action="fx-suggest" data-text="${attr(
            text,
          )}">${escapeHtml(text)}</button>`,
      ).join('')}</div>`
    : ''
  const note = dialable
    ? '直接写下要做的事 · Enter 开始一条新会话 · 会话里的过程与结果都会留在这里'
    : target === null
      ? model.registryDown
        ? '名册不可达 · 暂时不能确认这个智能体在不在 · 已有会话在会话列表里'
        : '这个智能体已不在名册 · 已有会话仍可查看'
      : '这个智能体没有接入对话 · 端点不在允许名单 · 需要在控制台启动参数里加上它的节点'
  return (
    `<div class="fx-welcome">${stage}` +
    `<h2 class="fx-welcome-title">${escapeHtml(`你好 · 我是 ${names.agent}`)}</h2>` +
    `<p class="fx-welcome-sub">${escapeHtml(
      `${model.main ? '主智能体' : '节点智能体'} · ${names.node} · ${verdict.text}`,
    )}</p>` +
    `<p class="fx-welcome-note">${escapeHtml(note)}</p>` +
    chips +
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
  const rows: (readonly [string, string])[] = [
    ['地址', `<code class="mono">${escapeHtml(address)}</code>`],
    ['节点', `<span class="mono">${escapeHtml(node)}</span>`],
    ['状态', state(verdict.tone, verdict.text)],
    [
      '对话通道',
      escapeHtml(
        target === null
          ? model.registryDown
            ? '名册不可达'
            : '不在名册'
          : target.dialable
            ? '已接入'
            : '端点不在允许名单',
      ),
    ],
  ]
  if (model.transcript !== null) {
    rows.push([
      '本会话',
      escapeHtml(
        `${model.transcript.session.turnCount} 轮 · 开始于 ${formatRelative(
          model.transcript.session.createdAt,
          model.now,
        )}`,
      ),
    ])
  }
  const links = model.admin
    ? `<div class="fx-info-links">` +
      `<a href="${attr(`${ADMIN}/nodes/${encodeURIComponent(node)}`)}">节点详情</a>` +
      `<a href="${attr(`${ADMIN}/providers/nodes/${encodeURIComponent(node)}`)}">模型设置</a>` +
      `<a href="${attr(`${ADMIN}/audit?node=${encodeURIComponent(node)}`)}">消息链</a>` +
      `</div>`
    : ''
  return (
    `<details class="fx-more fx-info">` +
    `<summary class="fx-icon-btn" aria-label="智能体信息">${icon('info', { small: true })}</summary>` +
    `<div class="fx-menu fx-info-card">` +
    `<dl class="fx-facts">${rows
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`)
      .join('')}</dl>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="fx-copy" data-copy="${attr(
      address,
    )}">${icon('copy', { small: true })}复制地址</button>` +
    links +
    `</div></details>`
  )
}

function renderHead(model: FrontViewModel): string {
  const transcript = model.transcript
  const address = transcript?.session.target ?? model.agent ?? ''
  if (address === '') {
    return `<div class="fx-head" id="fx-head"><span class="fx-head-name">对话</span></div>`
  }
  const target = model.target
  const names = target ?? namesOf(address)
  const agent = transcript?.session.agent ?? names.agent
  const node = transcript?.session.node ?? names.node
  const verdict = targetState(target, model.registryDown)
  const spec = model.faces.agent(address)
  const figure = avatarSvg(spec, {
    size: 34,
    uid: 'av-head',
    live: true,
    state: faceState(
      transcript?.turns ?? [],
      target,
      model.registryDown,
      model.now,
    ),
    label: `${agent} · ${avatarWords(spec)}`,
  })
  const face = model.faces.editable
    ? `<button type="button" class="fx-head-face" data-action="avatar-edit" ` +
      `data-key="${attr(`agent:${address}`)}" data-name="${attr(agent)}" ` +
      `aria-label="${attr(`换形象 · ${agent}`)}">${figure}</button>`
    : `<span class="fx-head-face">${figure}</span>`
  return (
    `<div class="fx-head" id="fx-head" data-target="${attr(address)}">` +
    face +
    `<div class="fx-head-text">` +
    `<div class="fx-head-line"><span class="fx-head-name">${escapeHtml(agent)}</span>` +
    (model.main
      ? `<span class="fx-tag">主智能体</span>`
      : `<span class="fx-tag fx-tag-quiet">节点智能体</span>`) +
    `</div>` +
    `<div class="fx-head-sub"><span class="mono">${escapeHtml(node)}</span>` +
    `${state(verdict.tone, verdict.text)}<span class="fx-model" id="fx-model"></span></div>` +
    `</div>` +
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
  const verdict = targetState(model.target, model.registryDown)
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

const ROLE_TEXT: Readonly<Record<ConsoleRole, string>> = {
  admin: '管理',
  view: '只读',
  none: '',
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
}

function composer(enabled: boolean): string {
  const off = enabled ? '' : ' disabled'
  const commands = CHAT_LOCAL_COMMANDS.map(
    name =>
      `<button type="button" class="fx-cmd" role="option" id="${attr(`fx-cmd-${name}`)}" ` +
      `data-cmd="${attr(`/${name}`)}" tabindex="-1">` +
      `<code class="mono">/${escapeHtml(name)}</code><span>${escapeHtml(COMMAND_WORDS[name])}</span></button>`,
  ).join('')
  return (
    `<form class="fx-composer" id="fx-composer" novalidate>` +
    `<div class="fx-cmds" id="fx-cmds" role="listbox" aria-label="本地命令" hidden>${commands}</div>` +
    `<label class="sr-only" for="fx-text">消息</label>` +
    `<textarea id="fx-text" rows="1" spellcheck="false" ` +
    `maxlength="${attr(String(MAX_CHAT_TEXT_LENGTH))}" aria-describedby="fx-status" ` +
    `aria-controls="fx-cmds" ` +
    `placeholder="写下要做的事 · Enter 发送 · Shift Enter 换行"${off}></textarea>` +
    `<div class="fx-composer-foot">` +
    `<span class="fx-target"><span class="dot dot-muted" id="fx-target-dot"></span>` +
    `<span id="fx-target-name">—</span></span>` +
    `<span class="fx-composer-hint" id="fx-hint">输入 / 查看本地命令</span>` +
    `<button type="submit" class="fx-send" id="fx-send" aria-label="发送"${off}>` +
    `${icon('arrow-up')}</button></div>` +
    `<p class="fx-status" id="fx-status" role="status"></p>` +
    `</form>`
  )
}

function sideFoot(model: FrontDocumentModel): string {
  const me = avatarSvg(model.faces.self, { size: 30 })
  const role = model.viewer?.roleText ?? ROLE_TEXT[model.role]
  return (
    `<div class="fx-side-foot">` +
    `<span class="fx-me">${me}<span class="fx-me-text"><b>我</b><span>${escapeHtml(
      role,
    )}</span></span></span>` +
    (model.admin
      ? `<a class="fx-icon-btn" href="${ADMIN}" aria-label="管理后台">${icon('settings', { small: true })}</a>`
      : '') +
    `<details class="fx-more fx-me-menu">` +
    `<summary class="fx-icon-btn" aria-label="账号与外观">${icon('ellipsis', { small: true })}</summary>` +
    `<div class="fx-menu fx-menu-up" role="menu">` +
    (model.faces.editable
      ? `<button type="button" class="fx-menu-item" role="menuitem" data-action="avatar-edit" ` +
        `data-key="${attr(model.faces.selfKey)}" data-name="我">${icon('sparkles', { small: true })}换我的形象</button>`
      : '') +
    `<label class="fx-menu-item fx-menu-field">外观` +
    `<select id="theme-choice" aria-label="外观"><option value="system">跟随系统</option>` +
    `<option value="light">浅色</option><option value="dark">深色</option></select></label>` +
    (model.admin
      ? `<a class="fx-menu-item" role="menuitem" href="${ADMIN}">${icon('layout-dashboard', { small: true })}管理后台</a>`
      : '') +
    `<form method="post" action="/logout" class="fx-menu-form">` +
    `<button type="submit" class="fx-menu-item" role="menuitem">${icon('log-out', { small: true })}退出</button>` +
    `</form></div></details></div>`
  )
}

/** The front's own keyboard help, in place of the management side's. */
const KEYBOARD_HELP =
  `<dialog class="dialog" id="keyboard-help" aria-labelledby="keyboard-help-title">` +
  `<h2 id="keyboard-help-title">快捷键</h2>` +
  `<p>Enter 发送 · Shift Enter 换行 · / 搜索会话 · Ctrl Shift O 新对话 · Esc 关闭菜单 · ? 帮助</p>` +
  `<button class="btn" type="button" data-action="confirm-cancel">关闭</button></dialog>`

/** The whole front document. */
export function renderFrontDocument(model: FrontDocumentModel): string {
  const runtime =
    model.viewer === undefined ? CONSOLE_CLIENT_JS : CONSOLE_CLIENT_JS_ACCOUNTS
  const script = runtime + FRONT_JS + AVATAR_PAGE_JS
  return (
    documentHead(
      `${WORDMARK_CN} · 对话 · ${model.label}`,
      FRONT_CSS + AVATAR_CSS,
      [script],
    ) +
    `<body class="fx-body">\n` +
    `<a class="skip-link" href="#fx-text">跳到输入框</a>\n` +
    `<h1 class="sr-only">${escapeHtml(`${WORDMARK_CN} · 对话`)}</h1>` +
    `<div class="fx" id="fx" data-side="open">` +
    `<aside class="fx-side" id="fx-side" aria-label="智能体与会话">` +
    `<div class="fx-side-top">` +
    `<a class="fx-brand" href="/"><span class="fx-mark" aria-hidden="true">阡</span>` +
    `<span class="fx-brand-text"><b>${escapeHtml(WORDMARK_CN)}</b><span>${escapeHtml(
      WORDMARK_EN,
    )}</span></span></a>` +
    `<button type="button" class="fx-icon-btn" data-action="fx-side" aria-label="收起侧栏" aria-controls="fx-side">` +
    `${icon('panel-left', { small: true })}</button></div>` +
    `<button type="button" class="fx-new" data-action="fx-new">${icon('square-pen', { small: true })}<span>新对话</span></button>` +
    `<label class="fx-search">${icon('search', { small: true })}<span class="sr-only">搜索会话</span>` +
    `<input type="search" id="fx-search" placeholder="搜索会话" autocomplete="off" spellcheck="false"></label>` +
    `<div class="fx-side-scroll" id="fx-side-scroll">${model.side.agents}${model.side.history}</div>` +
    sideFoot(model) +
    `</aside>` +
    `<button type="button" class="fx-scrim" data-action="fx-side-close" aria-label="关闭侧栏" tabindex="-1"></button>` +
    `<main class="fx-main${model.welcome ? ' is-welcome' : ''}" id="fx-main">` +
    `<header class="fx-top">` +
    `<button type="button" class="fx-icon-btn fx-side-open" data-action="fx-side" aria-label="展开侧栏" aria-controls="fx-side">` +
    `${icon('panel-left', { small: true })}</button>` +
    `<div class="fx-head-mount">${model.view.head}</div>` +
    `<div class="fx-top-tail"><span class="fx-live" id="fx-live"></span>` +
    `<button type="button" class="fx-icon-btn" data-action="fx-new" aria-label="新对话">` +
    `${icon('square-pen', { small: true })}</button></div>` +
    `</header>` +
    viewerNotice(model.viewer) +
    `<div class="fx-scroll" id="fx-scroll"><div class="fx-column">${model.view.thread}</div></div>` +
    `<div class="fx-dock"><div class="fx-column">` +
    `<button type="button" class="fx-jump" id="fx-jump" data-action="fx-jump" aria-label="回到最新" hidden>` +
    `${icon('arrow-down', { small: true })}</button>` +
    model.side.stack +
    composer(model.composerEnabled) +
    `<p class="fx-fine">回复由智能体生成 · 涉及变更的操作请先核对</p>` +
    `</div></div>` +
    `</main></div>\n` +
    sessionExpired(model.relogin) +
    `<div class="toasts" id="toasts" aria-live="polite" aria-relevant="additions"></div>\n` +
    `<p id="reply-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>` +
    KEYBOARD_HELP +
    avatarDialog() +
    `<script>${script}</script>\n` +
    `</body>\n</html>\n`
  )
}
