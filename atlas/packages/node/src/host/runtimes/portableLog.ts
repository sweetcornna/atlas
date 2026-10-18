// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The portable transcript (P36.6, `harness-backends.md` §6.3): whatever
 * runtime a session runs on, each turn leaves one line in the session
 * directory's `portable.ndjson` (0600) — the user's text, the final answer,
 * a one-line tool summary and the runtime it ran on — keeping the last 64 KiB.
 *
 * When a session's next turn runs on another runtime than its last one (the
 * operator moved the agent, or it fell back to qianmopi and came back), the
 * new runtime has no native history of it: that turn's prompt opens with a
 * 「前情」 block of the most recent turns (at most 12 KiB) saying where they
 * ran. Later turns go on natively.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type {
  OmpPromptAdmission,
  OmpRpcChannel,
  OmpRpcFrame,
} from '@qianmo/resident'
import { writePrivateFileAtomic } from '../../providers/store.js'
import { parseResidentOmpLocalCommand } from '../residentLocalCommand.js'
import { runtimeSpec } from './catalog.js'

export const PORTABLE_LOG = 'portable.ndjson'
/** The file keeps this much, newest turns last. */
export const PORTABLE_LOG_MAX_BYTES = 64 * 1024
/** The 「前情」 block is at most this long. */
export const PORTABLE_PREAMBLE_MAX_BYTES = 12 * 1024
const USER_MAX_BYTES = 4 * 1024
const ANSWER_MAX_BYTES = 8 * 1024
const TOOLS_MAX_BYTES = 300
/** One turn inside the preamble, each of its two texts. */
const PREAMBLE_TEXT_MAX_BYTES = 3 * 1024

export interface PortableTurn {
  readonly v: 1
  readonly at: number
  /** Catalog id of the runtime the turn ran on (`omp` for qianmopi). */
  readonly runtime: string
  readonly messageId: string
  readonly user: string
  readonly answer: string
  /** `read ×3、bash`; absent when no tool ran. */
  readonly tools?: string
  readonly status: 'completed' | 'error' | 'aborted'
}

/** The session's portable transcript, beside the runtime's own files. */
export function portableLogPath(agent: string, sessionId: string): string {
  return join(
    qianmoConfigPath('resident', 'sessions', agent, sessionId),
    PORTABLE_LOG,
  )
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** At most `max` UTF-8 bytes: the head and the tail, the middle elided. */
export function clipText(text: string, max: number): string {
  if (bytes(text) <= max) return text
  const marker = '\n…（中间省略）…\n'
  const budget = Math.max(0, max - bytes(marker))
  const buffer = Buffer.from(text, 'utf8')
  const head = Math.floor((budget * 2) / 3)
  // A cut inside a multi-byte character decodes to U+FFFD; drop those.
  const front = buffer.subarray(0, head).toString('utf8').replace(/�+$/, '')
  const back = buffer
    .subarray(buffer.length - (budget - head))
    .toString('utf8')
    .replace(/^�+/, '')
  return `${front}${marker}${back}`
}

function isTurn(value: unknown): value is PortableTurn {
  if (value === null || typeof value !== 'object') return false
  const turn = value as Record<string, unknown>
  return (
    turn['v'] === 1 &&
    typeof turn['at'] === 'number' &&
    typeof turn['runtime'] === 'string' &&
    typeof turn['user'] === 'string' &&
    typeof turn['answer'] === 'string'
  )
}

/** The recorded turns, oldest first; a damaged line is skipped. */
export function readPortableTurns(file: string): PortableTurn[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const turns: PortableTurn[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isTurn(value)) turns.push(value)
    } catch {
      // A torn last line from a crash; the rest stands.
    }
  }
  return turns
}

/** Appends one turn and trims the file to the newest `maxBytes`. */
export function appendPortableTurn(
  file: string,
  turn: PortableTurn,
  maxBytes = PORTABLE_LOG_MAX_BYTES,
): void {
  const line = `${JSON.stringify(turn)}\n`
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, line, { mode: 0o600 })
  if (statSync(file).size <= maxBytes) return
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(one => one.trim() !== '')
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = bytes(lines[i]!) + 1
    if (size + next > maxBytes) break
    kept.unshift(lines[i]!)
    size += next
  }
  writePrivateFileAtomic(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
}

function label(runtime: string): string {
  return runtimeSpec(runtime)?.label ?? runtime
}

/**
 * The 「前情」 block for a session moving to `next`: the most recent turns
 * that fit in `maxBytes`, oldest first, each named by its runtime. When
 * `next` continues a conversation begun at `since`, only the turns after its
 * last turn in it: the earlier ones are there already. `undefined` when there
 * is nothing to carry over.
 */
export function portablePreamble(
  all: readonly PortableTurn[],
  next: string,
  maxBytes = PORTABLE_PREAMBLE_MAX_BYTES,
  since?: number,
): string | undefined {
  const last = all.at(-1)
  if (last === undefined) return undefined
  let from = 0
  if (since !== undefined)
    for (let i = all.length - 1; i >= 0; i--)
      if (all[i]!.runtime === next && all[i]!.at >= since) {
        from = i + 1
        break
      }
  const turns = all.slice(from)
  const blocks: string[] = []
  const footer = '「前情」完。下面是这一轮的消息：\n\n'
  const header = (count: number) =>
    `「前情」这段对话之前在 ${label(last.runtime)} 上进行，现在换到了 ${label(next)}，那边的记录这里看不到。下面是最近 ${count} 轮的摘录（更早的已省略），只供你接上上下文，不用回复它本身。\n\n`
  let used = bytes(header(turns.length)) + bytes(footer)
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    const tag = `[${label(turn.runtime)}]`
    const lines = [
      `${tag} 用户：${clipText(turn.user, PREAMBLE_TEXT_MAX_BYTES)}`,
      turn.answer === ''
        ? `${tag} 回答：（这一轮没有完成：${turn.status}）`
        : `${tag} 回答：${clipText(turn.answer, PREAMBLE_TEXT_MAX_BYTES)}`,
      ...(turn.tools === undefined ? [] : [`${tag} 工具：${turn.tools}`]),
    ]
    const block = `${lines.join('\n')}\n\n`
    if (used + bytes(block) > maxBytes) break
    blocks.unshift(block)
    used += bytes(block)
  }
  if (blocks.length === 0) return undefined
  return `${header(blocks.length)}${blocks.join('')}${footer}`
}

function messageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content)
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    )
      text += (block as { text: string }).text
  return text
}

function toolSummary(tools: ReadonlyMap<string, number>): string | undefined {
  if (tools.size === 0) return undefined
  const text = [...tools]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join('、')
  return clipText(text, TOOLS_MAX_BYTES)
}

export interface PortableChannelOptions {
  /** {@link portableLogPath} of the session. */
  readonly file: string
  /** The runtime this channel is (`omp` or an external catalog id). */
  readonly runtime: string
  /**
   * When the native conversation this channel continues began; absent or
   * `undefined`: a new one (everything is carried over).
   */
  readonly conversationSince?: () => number | undefined
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

/**
 * `channel`, recording each turn it runs into the portable transcript and
 * opening the first turn after a runtime change with the 「前情」 block.
 * Everything but `prompt` is the channel's own.
 */
export function portableChannel<C extends OmpRpcChannel>(
  channel: C,
  options: PortableChannelOptions,
): C {
  const report = (error: unknown) => options.onError?.(error)
  // One close listener for the wrapper, ending whichever turn is current: a
  // listener per turn would stay on the long-lived promise with its turn.
  let current: (() => void) | undefined
  const closed = () => current?.()
  void channel.closed.then(closed, closed)
  const prompt = async (input: {
    readonly messageId: string
    readonly text: string
  }): Promise<OmpPromptAdmission> => {
    // Local commands (`/compact`, `/model …`) are the runtime's, untouched.
    if (parseResidentOmpLocalCommand(input.text) !== undefined)
      return channel.prompt(input)
    let text = input.text
    try {
      const turns = readPortableTurns(options.file)
      if (turns.length > 0 && turns.at(-1)!.runtime !== options.runtime) {
        const preamble = portablePreamble(
          turns,
          options.runtime,
          PORTABLE_PREAMBLE_MAX_BYTES,
          options.conversationSince?.(),
        )
        if (preamble !== undefined) text = `${preamble}${input.text}`
      }
    } catch (error) {
      report(error)
    }
    const answers: string[] = []
    const tools = new Map<string, number>()
    const results = new Map<string, OmpRpcFrame>()
    let requestId: string | undefined
    let done = false
    // A process gone mid-turn still leaves the question in the record.
    const gone = () => finish('error')
    const release = () => {
      if (current === gone) current = undefined
    }
    const finish = (status: PortableTurn['status']) => {
      if (done) return
      done = true
      unsubscribe()
      release()
      try {
        appendPortableTurn(options.file, {
          v: 1,
          at: (options.now ?? Date.now)(),
          runtime: options.runtime,
          messageId: input.messageId,
          user: clipText(input.text, USER_MAX_BYTES),
          answer: clipText(answers.join('\n\n'), ANSWER_MAX_BYTES),
          ...(tools.size === 0 ? {} : { tools: toolSummary(tools) }),
          status,
        })
      } catch (error) {
        report(error)
      }
      answers.length = 0
      tools.clear()
    }
    const settle = (frame: OmpRpcFrame) =>
      finish(
        frame.status === 'completed'
          ? 'completed'
          : frame.status === 'aborted'
            ? 'aborted'
            : 'error',
      )
    const unsubscribe = channel.onFrame(frame => {
      if (frame.type === 'message_end') {
        const message = frame.message as { role?: unknown } | undefined
        if (message?.role !== 'assistant') return
        const body = messageText(message)
        if (body !== '') answers.push(body)
      } else if (frame.type === 'tool_execution_start') {
        const name =
          typeof frame.toolName === 'string' ? frame.toolName : 'tool'
        tools.set(name, (tools.get(name) ?? 0) + 1)
      } else if (
        frame.type === 'prompt_result' &&
        typeof frame.id === 'string'
      ) {
        if (requestId === undefined) results.set(frame.id, frame)
        else if (frame.id === requestId) settle(frame)
      }
    })
    current = gone
    let admission: OmpPromptAdmission
    try {
      admission = await channel.prompt({ messageId: input.messageId, text })
    } catch (error) {
      done = true
      unsubscribe()
      release()
      throw error
    }
    if (!admission.agentInvoked) {
      done = true
      unsubscribe()
      release()
      return admission
    }
    requestId = admission.requestId
    const early = results.get(requestId)
    results.clear()
    if (early !== undefined) settle(early)
    return admission
  }
  return new Proxy(channel, {
    get(target, property) {
      if (property === 'prompt') return prompt
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
