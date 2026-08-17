// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The chat face: a session rail, a transcript, a composer.
 *
 * ## Why it is a second page rather than a sixth section
 *
 * The ledger page is a column of `[rail][pane]` rows that scrolls as one
 * document. A conversation is the opposite shape: two panes that scroll
 * independently, a composer pinned to the bottom of one of them, and a
 * viewport that never scrolls as a whole. Bolting that onto the ledger would
 * have cost the ledger its scroll model. So `/chat` is its own document, built
 * out of the same tokens (`assets/css.ts`) and the same escape discipline
 * (`escape.ts`) — the shell is shared, the body is not.
 *
 * ## The transcript is a ledger column, not a stack of bubbles
 *
 * Every turn is a hairline rule down the left with a small author label above
 * it and the text beside it — the same visual grammar the roster and the trail
 * already use, and the reason a transcript full of code and addresses stays
 * readable. Operator turns carry the rule in `--primary`; agent turns carry it
 * in `--border`. That is the whole distinction: no fill, no alignment flip, no
 * avatar. A conversation with one agent does not need to be told apart by
 * colour blocks; it needs to be read top to bottom.
 *
 * What sits under an operator turn is the part a bubble UI has nowhere to put:
 * the delivery pills. `已投递 · 回执 accepted · 42ms`, then `已读 1.2s` when
 * the agent takes the message into its input, then the reply. Those three are
 * distinct network events — a message can be receipted and never read, or read
 * and never answered — and a chat window that collapses them into one grey
 * tick is a chat window that cannot tell you which half is broken.
 *
 * ## Names come from the address
 *
 * A session's title is the `agent` segment of its target address, and the
 * group it sits under is that same address. Nothing here invents a display
 * name, and nothing here keeps a second copy of one: rename the agent in the
 * registry and the page renames itself.
 */

import type {
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ConsoleFailure,
} from '../deps.js'
import { chip, failureBar, hint, state, type Tone } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatClock, formatRelative, formatShortDuration } from './format.js'

/** How much of the last turn the session rail shows. */
const PREVIEW_LENGTH = 46

/** Longest message the composer accepts, in characters. */
export const MAX_CHAT_TEXT_LENGTH = 8_000

/**
 * Ids of the two regions the poller and the stream swap.
 *
 * Not exported: they are a contract with `assets/chatClient.ts`, which is a
 * string constant in this same package rather than an importer, so an export
 * here would be a public symbol nothing can consume.
 */
const CHAT_SESSIONS_MOUNT = 'chat-sessions'
const CHAT_THREAD_MOUNT = 'chat-thread'

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * One pill under a turn.
 *
 * Deliberately not {@link chip}: a chip is an outlined label for a value (a
 * capability, a filter), and these are events with a tone. Sharing the shape
 * would make `已读 1.2s` and `plan` look like the same kind of thing.
 */
function pill(text: string, tone: Tone = 'muted'): string {
  return `<span class="pill pill-${tone}">${escapeHtml(text)}</span>`
}

/**
 * A latency, in the unit it was actually measured in.
 *
 * {@link formatShortDuration} floors to whole seconds, so every receipt on a
 * loopback link reads `0s` — which is the one number that makes the pill
 * useless. Under a second this prints milliseconds; above it, the same compact
 * spelling the lease column uses.
 */
function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return formatShortDuration(ms)
  return ms < 1_000 ? `${Math.round(ms)}ms` : formatShortDuration(ms)
}

/** Short form of a W3C trace id, enough to find the chain on the ledger page. */
function shortTrace(traceId: string): string {
  const hex = traceId.includes('-') ? (traceId.split('-')[1] ?? '') : traceId
  return hex.slice(0, 8)
}

/**
 * The pills under one turn, in the order the events happened.
 *
 * Every one of them is a fact the transport or the agent reported; none of
 * them is derived from another. `已投递` without `已读` is the interesting
 * case, not a rendering gap.
 */
function turnMarks(turn: ChatTurn): string {
  const marks: string[] = []
  if (turn.author === 'operator') {
    if (turn.state === 'pending') marks.push(pill('待投递'))
    if (turn.receipt !== undefined) {
      const ms =
        turn.receiptMs === undefined
          ? ''
          : ` · ${formatLatency(turn.receiptMs)}`
      marks.push(pill(`已投递 · 回执 ${turn.receipt}${ms}`, 'ok'))
    }
    if (turn.readMs !== undefined) {
      marks.push(pill(`已读 · ${formatLatency(turn.readMs)}`, 'ok'))
    }
  } else if (turn.elapsedMs !== undefined) {
    marks.push(pill(`用时 ${formatLatency(turn.elapsedMs)}`))
  }
  if (turn.state === 'failed') {
    marks.push(
      pill(turn.code === undefined ? '失败' : `失败 · ${turn.code}`, 'bad'),
    )
  }
  if (turn.taskId !== undefined) {
    marks.push(
      `<span class="pill pill-id mono" title="${attr(turn.taskId)}">` +
        `task ${escapeHtml(turn.taskId.slice(0, 8))}</span>`,
    )
  }
  if (turn.traceId !== undefined) {
    marks.push(
      `<span class="pill pill-id mono" title="${attr(turn.traceId)}">` +
        `链 ${escapeHtml(shortTrace(turn.traceId))}</span>`,
    )
  }
  return marks.length === 0
    ? ''
    : `<div class="turn-marks">${marks.join('')}</div>`
}

/**
 * The text of one turn.
 *
 * `<p>` per blank-line-separated block, `escapeHtml` on every one. No markdown,
 * no code-fence detection, no link autolinking: the model on the other end is
 * being asked questions by an operator holding an admin token, and every one of
 * those three features is a way for its output to become markup on this page.
 * Whitespace is preserved by CSS (`white-space: pre-wrap`), which is the whole
 * of the formatting this page offers.
 */
function turnText(text: string): string {
  const blocks = text.split(/\n{2,}/).filter(block => block.trim().length > 0)
  if (blocks.length === 0) {
    return `<p class="turn-empty">（空）</p>`
  }
  return blocks
    .map(block => `<p class="turn-p">${escapeHtml(block)}</p>`)
    .join('')
}

const AUTHOR_CLASS: Readonly<Record<ChatTurn['author'], string>> = {
  operator: 'turn-operator',
  agent: 'turn-agent',
}

function renderTurn(turn: ChatTurn, agent: string): string {
  const who = turn.author === 'operator' ? '你' : agent
  const failed = turn.state === 'failed' ? ' turn-failed' : ''
  return (
    `<article class="turn ${AUTHOR_CLASS[turn.author]}${failed}">` +
    `<header class="turn-head">` +
    `<span class="turn-who">${escapeHtml(who)}</span>` +
    `<time class="turn-when">${escapeHtml(formatClock(turn.at))}</time>` +
    `</header>` +
    `<div class="turn-body">${turnText(turn.text)}${turnMarks(turn)}</div>` +
    `</article>`
  )
}

/**
 * The dot beside the target in the thread header and on the composer.
 *
 * `不在名册` and `名册不可达` are deliberately two different answers. The first
 * says the registry replied and this address was not in it — somebody
 * deregistered the agent, and the next send will fail. The second says nobody
 * asked, so this page knows nothing about the target's state; the send may well
 * work. Collapsing them into one grey dot is how an operator ends up
 * restarting a node that was never down.
 */
function targetState(
  target: ChatTarget | null,
  registryDown: boolean,
): { readonly tone: Tone; readonly text: string } {
  if (registryDown) return { tone: 'muted', text: '名册不可达' }
  if (target === null) return { tone: 'muted', text: '不在名册' }
  if (!target.dialable) return { tone: 'bad', text: '端点不在允许名单' }
  if (target.status === 'online') return { tone: 'ok', text: '在线' }
  return { tone: 'warn', text: target.status }
}

export interface ChatThreadModel {
  readonly transcript: ChatTranscript | null
  readonly failure: ConsoleFailure | null
  /** The registry's current view of this session's target, when it has one. */
  readonly target: ChatTarget | null
  /** True when the roster lookup itself failed, which is not "absent". */
  readonly registryDown?: boolean
  readonly now: number
}

/**
 * The transcript pane: a header naming the target, then the turns.
 *
 * The root carries `data-target` / `data-state` / `data-tone` because the
 * composer's chips have to show the same two facts and the composer is *not*
 * re-rendered on a poll — it holds half-typed text. The client copies those
 * attributes across with `textContent` rather than the server rendering the
 * same strings into two places that can then disagree.
 */
export function renderChatThread(model: ChatThreadModel): string {
  if (model.failure !== null) {
    return (
      `<div class="thread" id="${CHAT_THREAD_MOUNT}">` +
      failureBar(model.failure, '会话') +
      `</div>`
    )
  }
  if (model.transcript === null) {
    return (
      `<div class="thread thread-empty" id="${CHAT_THREAD_MOUNT}" ` +
      `data-target="" data-state="选一条会话" data-tone="muted">` +
      hint('还没有打开会话 · 在左边选一个智能体开始') +
      `</div>`
    )
  }

  const { session, turns } = model.transcript
  const status = targetState(model.target, model.registryDown === true)
  const body =
    turns.length === 0
      ? hint('这条会话还没有内容 · 在下面写第一句')
      : turns.map(turn => renderTurn(turn, session.agent)).join('')

  return (
    `<div class="thread" id="${CHAT_THREAD_MOUNT}" ` +
    `data-target="${attr(session.target)}" ` +
    `data-state="${attr(status.text)}" data-tone="${attr(status.tone)}" ` +
    `data-session="${attr(session.id)}">` +
    `<header class="thread-head">` +
    `<h1 class="thread-title">${escapeHtml(session.agent)}</h1>` +
    `<span class="thread-addr mono">${escapeHtml(session.target)}</span>` +
    `<span class="spacer"></span>` +
    state(status.tone, status.text) +
    `<span class="thread-count">${escapeHtml(String(session.turnCount))} 轮</span>` +
    `</header>` +
    `<div class="turns">${body}</div>` +
    `</div>`
  )
}

export interface ChatSessionsModel {
  readonly sessions: readonly ChatSession[]
  readonly targets: readonly ChatTarget[]
  readonly failure: ConsoleFailure | null
  readonly activeId: string | null
  readonly now: number
}

/** Sessions under one target, newest activity first. */
interface SessionGroup {
  readonly target: string
  readonly agent: string
  readonly node: string
  readonly sessions: readonly ChatSession[]
}

/**
 * Group by target address.
 *
 * Sorted by each group's most recent activity rather than alphabetically: the
 * rail is a list of conversations, and the one that just answered is the one
 * being looked for.
 */
function groupSessions(
  sessions: readonly ChatSession[],
): readonly SessionGroup[] {
  const byTarget = new Map<string, ChatSession[]>()
  for (const session of sessions) {
    const bucket = byTarget.get(session.target)
    if (bucket === undefined) byTarget.set(session.target, [session])
    else bucket.push(session)
  }
  const groups: SessionGroup[] = []
  for (const [target, bucket] of byTarget) {
    const ordered = [...bucket].sort((a, b) => b.updatedAt - a.updatedAt)
    const head = ordered[0]
    if (head === undefined) continue
    groups.push({
      target,
      agent: head.agent,
      node: head.node,
      sessions: ordered,
    })
  }
  return groups.sort(
    (a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0),
  )
}

function sessionItem(
  session: ChatSession,
  active: boolean,
  now: number,
): string {
  const cls = active ? 'chat-item chat-item-active' : 'chat-item'
  const preview =
    session.preview === ''
      ? '还没有内容'
      : truncate(session.preview, PREVIEW_LENGTH)
  return (
    `<button type="button" class="${cls}" data-action="chat-open" ` +
    `data-session="${attr(session.id)}"${active ? ' aria-current="true"' : ''}>` +
    `<span class="chat-item-line">${escapeHtml(preview)}</span>` +
    `<span class="chat-item-meta">${escapeHtml(
      formatRelative(session.updatedAt, now),
    )} · ${escapeHtml(String(session.turnCount))} 轮</span>` +
    `</button>`
  )
}

/**
 * The session rail.
 *
 * The target picker sits at the top rather than beside the composer: opening a
 * conversation and continuing one are different actions, and a picker next to
 * the send button is a picker somebody eventually sends into by accident.
 */
export function renderChatSessions(model: ChatSessionsModel): string {
  const options = model.targets
    .map(target => {
      const suffix = target.dialable ? '' : '（不可拨号）'
      return `<option value="${attr(target.address)}"${
        target.dialable ? '' : ' disabled'
      }>${escapeHtml(target.agent)} · ${escapeHtml(target.node)}${escapeHtml(
        suffix,
      )}</option>`
    })
    .join('')

  const picker =
    model.targets.length === 0
      ? `<p class="chat-none">注册中心里没有可聊的智能体</p>`
      : `<div class="chat-new">` +
        `<label class="sr-only" for="chat-target">目标</label>` +
        `<select id="chat-target">${options}</select>` +
        `<button type="button" class="btn btn-primary" data-action="chat-new">` +
        `新会话</button></div>`

  const body =
    model.failure !== null
      ? failureBar(model.failure, '会话列表')
      : model.sessions.length === 0
        ? `<p class="chat-none">还没有会话</p>`
        : groupSessions(model.sessions)
            .map(
              group =>
                `<div class="chat-group">` +
                `<p class="chat-group-name">${escapeHtml(group.agent)}</p>` +
                `<p class="chat-group-node mono">${escapeHtml(group.node)}</p>` +
                group.sessions
                  .map(session =>
                    sessionItem(
                      session,
                      session.id === model.activeId,
                      model.now,
                    ),
                  )
                  .join('') +
                `</div>`,
            )
            .join('')

  return (
    `<div class="chat-rail" id="${CHAT_SESSIONS_MOUNT}">${picker}` +
    `<div class="chat-groups">${body}</div></div>`
  )
}
