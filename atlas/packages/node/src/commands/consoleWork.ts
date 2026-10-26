// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's side of work outputs (P37.17 B, `docs/dev/work-tasks.md` §4,
 * §5.4): the `WorkPort` that lists and fetches a session's files from the
 * node running it over the hub→node control link, and the handler for the
 * node's `work.*` hub calls (file cards, progress and context).
 *
 * Nothing is written to the hub's disk on the way: a download is fetched in
 * chunks and written to the browser as they come, at most
 * {@link WORK_CHUNKS_PER_MINUTE} chunks a minute per node — half the control
 * link's budget, so a download never starves the console's own polls.
 */

import {
  WORK_FILE_MAX_BYTES,
  workFileType,
  type ChatSession,
  type WorkDownload,
  type WorkFailure,
  type WorkOutput,
  type WorkPort,
  type WorkResult,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import type { ConsoleChatHub } from './consoleChat.js'
import type { HubCallHandler } from './consoleControl.js'

/** Chunks one node may be asked for per minute (§4.3). */
export const WORK_CHUNKS_PER_MINUTE = 150
const CHUNK_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 15_000
/** The actor control operations are recorded under on the node. */
const WORK_ACTOR = 'system:work'

export interface ConsoleWorkOptions {
  readonly control: {
    request(
      node: string,
      op: string,
      args: Record<string, unknown>,
      actor: string,
      options?: { readonly timeoutMs?: number },
    ): Promise<ControlOutcome>
  }
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

function failure(
  code: WorkFailure['code'],
  message: string,
): WorkResult<never> {
  return { ok: false, failure: { code, message } }
}

/** A node's refusal as the page reads it (§4.7). */
function failureOf(outcome: ControlOutcome & { ok: false }): WorkResult<never> {
  switch (outcome.code) {
    case 'not_found':
      return failure('not_found', '文件不存在或没有预览')
    case 'invalid':
      return failure('invalid', '文件名不合法')
    case 'limit':
      return failure('limit', '文件超过 50 MiB')
    case 'unsupported':
      return failure('unsupported', '节点版本不认工作产出')
    case 'unreachable':
    case 'not-sent':
    case 'unknown':
      return failure('unreachable', '节点控制链路未连接')
    case 'E_BUSY':
      return failure('unreachable', '节点暂时不能处理')
    default:
      return failure('unreachable', `节点没能读出产出（${outcome.code}）`)
  }
}

interface Chunk {
  readonly name: string
  readonly size: number
  readonly mime: string
  readonly etag: string
  readonly offset: number
  readonly data: Uint8Array
  readonly eof: boolean
}

function chunkOf(value: unknown, offset: number): Chunk | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const { name, size, mime, etag, data, eof } = row
  if (
    typeof name !== 'string' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > WORK_FILE_MAX_BYTES ||
    typeof mime !== 'string' ||
    typeof etag !== 'string' ||
    typeof data !== 'string' ||
    typeof eof !== 'boolean' ||
    row.offset !== offset
  )
    return null
  const bytes = new Uint8Array(Buffer.from(data, 'base64'))
  if (offset + bytes.byteLength > size) return null
  if (!eof && bytes.byteLength === 0) return null
  return { name, size, mime, etag, offset, data: bytes, eof }
}

function outputOf(value: unknown): WorkOutput | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const { name, size, mtime, preview, tooLarge } = row
  if (
    typeof name !== 'string' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof mtime !== 'number' ||
    typeof preview !== 'boolean'
  )
    return null
  // Kind and MIME are the hub's own reading of the name: one table.
  const type = workFileType(name)
  return {
    name,
    size,
    kind: type.kind,
    mime: type.mime,
    mtime,
    preview,
    ...(tooLarge === true || size > WORK_FILE_MAX_BYTES
      ? { tooLarge: true as const }
      : {}),
  }
}

export class ConsoleWork implements WorkPort {
  readonly #options: ConsoleWorkOptions
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  /** The earliest moment each node may be asked for its next chunk. */
  readonly #next = new Map<string, number>()

  constructor(options: ConsoleWorkOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#sleep =
      options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Wait for this node's next chunk slot (§4.3 pacing). */
  async #slot(node: string): Promise<void> {
    const now = this.#now()
    const at = Math.max(now, this.#next.get(node) ?? now)
    this.#next.set(node, at + 60_000 / WORK_CHUNKS_PER_MINUTE)
    if (at > now) await this.#sleep(at - now)
  }

  async outputs(session: ChatSession): Promise<
    WorkResult<{
      readonly files: readonly WorkOutput[]
      readonly truncated: boolean
    }>
  > {
    const outcome = await this.#options.control.request(
      session.node,
      'work.list',
      { agent: session.agent, session: session.id },
      WORK_ACTOR,
      { timeoutMs: LIST_TIMEOUT_MS },
    )
    if (!outcome.ok) return failureOf(outcome)
    const value = outcome.value as { files?: unknown; truncated?: unknown }
    if (!Array.isArray(value?.files))
      return failure('unreachable', '节点答复不合格')
    const files = value.files.flatMap(one => outputOf(one) ?? [])
    return {
      ok: true,
      value: { files, truncated: value.truncated === true },
    }
  }

  async #chunk(
    session: ChatSession,
    name: string,
    view: 'file' | 'preview',
    offset: number,
    etag: string | undefined,
  ): Promise<WorkResult<Chunk>> {
    await this.#slot(session.node)
    const outcome = await this.#options.control.request(
      session.node,
      'work.read',
      {
        agent: session.agent,
        session: session.id,
        name,
        view,
        offset,
        ...(etag === undefined ? {} : { etag }),
      },
      WORK_ACTOR,
      { timeoutMs: CHUNK_TIMEOUT_MS },
    )
    if (!outcome.ok) return failureOf(outcome)
    const chunk = chunkOf(outcome.value, offset)
    if (chunk === null) return failure('unreachable', '节点答复不合格')
    if (etag !== undefined && chunk.etag !== etag)
      return failure('unreachable', '文件在读取中途被改动')
    return { ok: true, value: chunk }
  }

  async fetch(
    session: ChatSession,
    name: string,
    view: 'file' | 'preview',
  ): Promise<WorkResult<WorkDownload>> {
    const first = await this.#chunk(session, name, view, 0, undefined)
    if (!first.ok) return first
    const head = first.value
    let offset = head.data.byteLength
    let done = head.eof || offset >= head.size
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        if (!sent) {
          sent = true
          if (head.data.byteLength > 0) controller.enqueue(head.data)
          if (done) controller.close()
          return
        }
        if (done) {
          controller.close()
          return
        }
        const next = await this.#chunk(session, name, view, offset, head.etag)
        if (!next.ok) {
          // A broken body, never a file made of two versions (§4.3).
          controller.error(new Error(next.failure.message))
          return
        }
        if (next.value.size !== head.size) {
          controller.error(new Error('文件在读取中途被改动'))
          return
        }
        offset += next.value.data.byteLength
        done = next.value.eof || offset >= head.size
        if (next.value.data.byteLength > 0) controller.enqueue(next.value.data)
        if (done) controller.close()
      },
    })
    return {
      ok: true,
      value: { name, size: head.size, mime: head.mime, body },
    }
  }
}

/**
 * The node's `work.*` hub calls (§5.4). The caller is the node and agent the
 * control link authenticated, which the chat hub checks against the session.
 */
export function workHubCalls(chat: ConsoleChatHub): HubCallHandler {
  return async (op, args, ctx) => {
    const base = {
      node: ctx.node,
      agent: ctx.agent,
      contextId: args.contextId,
      taskId: args.taskId,
    }
    const result =
      op === 'work.deliver'
        ? chat.deliverFiles({ ...base, files: args.files })
        : op === 'work.activity'
          ? chat.reportActivity({
              ...base,
              ...(args.todo === undefined ? {} : { todo: args.todo }),
              context: args.context,
            })
          : null
    if (result === null)
      return { ok: false, code: 'unsupported', message: '不支持此调用' }
    return result.ok
      ? { ok: true, value: op === 'work.deliver' ? { delivered: true } : {} }
      : {
          ok: false,
          code: result.failure.code,
          message: result.failure.message,
        }
  }
}
