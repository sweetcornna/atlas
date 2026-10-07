// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client's own account of a prompt-cache miss (P18.21 CH-8, design
 * `providers-console-m1.md` §5.11.5).
 *
 * P18.19's G-1 asks for an explanation of every mid-session zero-hit. The plan
 * was the vendor's diagnostics (CH-6), but the fleet's gateway accepts
 * `prompt_cache_options` and never returns `prompt_cache_diagnostics`
 * (measured 2026-10-07, §5.11.8 results). So the client answers the half of
 * the question it can answer by itself: did the request it put on the wire
 * change, in any part that decides cache reuse, compared with the previous
 * request of the same conversation? If not, the miss happened on the
 * provider's side.
 *
 * With `OPENAI_PROMPT_CACHE_SELFCHECK=1`, every generic `/responses` request
 * of a tracked lane is compared, at the moment its reply completes, with the
 * previous completed request of that lane, and the assistant message gets
 *
 *     _qmPromptCacheSelfCheck: { v: 1, prev, changed, inputPrev, inputNow, divergedAt? }
 *
 * - `prev`: `none` (nothing to compare with), `memory` (an earlier request of
 *   this process) or `sidecar` (the last request before this process took the
 *   session over — a replaced ACP child, a deploy).
 * - `changed`: the reasons, in OpenAI's diagnostics vocabulary where it has a
 *   word (`model_changed`, `prompt_cache_key_changed`, `service_tier_changed`,
 *   `tools_changed`, `text_format_changed`, `reasoning_effort_changed`,
 *   `verbosity_changed`, `context_compacted`, `input_changed`) plus
 *   `instructions_changed`. Empty = the previous request is a byte-identical
 *   prefix of this one in every compared part.
 * - `inputPrev` / `inputNow`: how many `input` items each request had;
 *   `divergedAt`: the first item that differs, when one does.
 *
 * Only counts, indices and reason words are recorded: no content, no hashes,
 * no key, no model name. The request body is never changed, on or off.
 *
 * What is compared is the body exactly as sent (the last attempt's, which is
 * the one that produced the reply), not the messages it was built from: a
 * conversion that drifts is exactly what this is for.
 *
 * Lanes follow the base's `promptCacheBreakDetection.ts` `getTrackingKey`:
 * the main loop (`repl_main_thread*`, `sdk*`) and each subagent
 * (`agent:custom|default|builtin*`, by agent id). One-shot forks (compaction,
 * session memory, suggestions) are not recorded. Only the main lane is kept
 * across processes, in `<projectDir>/<sessionId>/prompt-cache-selfcheck.json`
 * (0600), under the transcript's own persistence rules.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isEnvTruthy } from '../../../utils/config/envUtils.js'
import { logForDebugging } from '../../../utils/telemetry/debug.js'
import {
  persistenceDisabled,
  sessionSidecarPath,
} from './sessionPromptContext.js'

export const PROMPT_CACHE_SELFCHECK_FIELD = '_qmPromptCacheSelfCheck'
export const PROMPT_CACHE_SELFCHECK_SIDECAR_NAME = 'prompt-cache-selfcheck.json'

/** The compared parts of a request, in the order their reasons are listed. */
const PARTS = [
  ['model', 'model_changed'],
  ['prompt_cache_key', 'prompt_cache_key_changed'],
  ['service_tier', 'service_tier_changed'],
  ['tools', 'tools_changed'],
  ['text_format', 'text_format_changed'],
  ['reasoning_effort', 'reasoning_effort_changed'],
  ['verbosity', 'verbosity_changed'],
  ['instructions', 'instructions_changed'],
] as const

type PartName = (typeof PARTS)[number][0]
type Parts = Record<PartName, string>

/** Bytes kept per `input` item: a truncated rolling hash, not the item. */
const LINK_BYTES = 8
const MAX_LANES = 128
const TRACKED_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

export type PromptCacheSelfCheckRecord = {
  v: 1
  prev: 'none' | 'memory' | 'sidecar'
  changed: string[]
  inputPrev: number
  inputNow: number
  divergedAt?: number
}

/** What a lane remembers of its last completed request. */
type LaneState = {
  parts: Parts
  /** `LINK_BYTES` per input item, item i at `i * LINK_BYTES`. */
  chain: Buffer
  /** uuid of the earliest assistant message the request was built from. */
  anchor?: string
}

type Sidecar = {
  format: 1
  sessionId: string
  lane: 'main'
  parts: Parts
  count: number
  chain: string
  anchor?: string
}

const lanes = new Map<string, LaneState>()

function isPromptCacheSelfCheckEnabled(): boolean {
  return isEnvTruthy(process.env.OPENAI_PROMPT_CACHE_SELFCHECK)
}

function laneOf(
  querySource: string | undefined,
  agentId: string | undefined,
): string | undefined {
  if (querySource === undefined) return undefined
  if (!TRACKED_PREFIXES.some(p => querySource.startsWith(p))) return undefined
  return agentId ? `agent:${agentId}` : 'main'
}

/** JSON with every object's keys sorted, so key order never reads as a change. */
function canonical(value: unknown): string {
  if (value === undefined) return '\u0000absent'
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k]
    }
    return sorted
  })
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(canonical(value))
    .digest('hex')
    .slice(0, 16)
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function partsOf(body: Record<string, unknown>): Parts {
  const text = body.text
  return {
    model: digest(body.model),
    prompt_cache_key: digest(body.prompt_cache_key),
    service_tier: digest(body.service_tier),
    tools: digest([body.tools, body.parallel_tool_calls]),
    text_format: digest(field(text, 'format')),
    reasoning_effort: digest(field(body.reasoning, 'effort')),
    verbosity: digest(field(text, 'verbosity')),
    instructions: digest(body.instructions),
  }
}

function chainOf(input: unknown): Buffer {
  const items = Array.isArray(input)
    ? input
    : input === undefined
      ? []
      : [input]
  const chain = Buffer.alloc(items.length * LINK_BYTES)
  let link = Buffer.alloc(32)
  items.forEach((item, i) => {
    link = createHash('sha256').update(link).update(canonical(item)).digest()
    link.copy(chain, i * LINK_BYTES, 0, LINK_BYTES)
  })
  return chain
}

/** First item where two chains differ, or where the shorter one ends. */
function divergence(prev: Buffer, now: Buffer): number | undefined {
  const n = prev.length / LINK_BYTES
  const m = now.length / LINK_BYTES
  for (let i = 0; i < Math.min(n, m); i++) {
    const a = i * LINK_BYTES
    if (prev.compare(now, a, a + LINK_BYTES, a, a + LINK_BYTES) !== 0) return i
  }
  return m < n ? m : undefined
}

function remember(key: string, state: LaneState): void {
  lanes.delete(key)
  lanes.set(key, state)
  while (lanes.size > MAX_LANES) {
    const oldest = lanes.keys().next().value
    if (oldest === undefined) break
    lanes.delete(oldest)
  }
}

function isParts(value: unknown): value is Parts {
  return (
    value !== null &&
    typeof value === 'object' &&
    PARTS.every(
      ([name]) => typeof (value as Record<string, unknown>)[name] === 'string',
    )
  )
}

function readSidecar(path: string, sessionId: string): LaneState | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  const s = raw as Partial<Sidecar>
  if (
    s?.format !== 1 ||
    s.sessionId !== sessionId ||
    s.lane !== 'main' ||
    !isParts(s.parts) ||
    typeof s.count !== 'number' ||
    typeof s.chain !== 'string'
  ) {
    return undefined
  }
  const chain = Buffer.from(s.chain, 'base64')
  if (chain.length !== s.count * LINK_BYTES) return undefined
  return {
    parts: s.parts,
    chain,
    ...(typeof s.anchor === 'string' && { anchor: s.anchor }),
  }
}

function writeSidecar(path: string, sessionId: string, state: LaneState): void {
  const sidecar: Sidecar = {
    format: 1,
    sessionId,
    lane: 'main',
    parts: state.parts,
    count: state.chain.length / LINK_BYTES,
    chain: state.chain.toString('base64'),
    ...(state.anchor !== undefined && { anchor: state.anchor }),
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(sidecar), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    logForDebugging(
      `[promptCache] self-check sidecar not written for ${sessionId}: ${error}`,
    )
  }
}

type PromptCacheSelfCheck = {
  /** Hand it every body put on the wire; the last one is the reply's. */
  onRequestBody: (body: string) => void
  /**
   * At the reply's `message_stop`: compare, update the lane, return the
   * fields to stamp on the message (`{}` when there is nothing to say).
   * Idempotent.
   */
  settle: () => Record<string, unknown>
}

/**
 * Start the self-check for one model request. `undefined` when it is off or
 * the request belongs to no tracked lane — then nothing is recorded and the
 * caller passes nothing on.
 */
export function beginPromptCacheSelfCheck(params: {
  sessionId: string
  querySource: string | undefined
  agentId: string | undefined
  messages: readonly unknown[]
}): PromptCacheSelfCheck | undefined {
  if (!isPromptCacheSelfCheckEnabled()) return undefined
  const lane = laneOf(params.querySource, params.agentId)
  if (lane === undefined) return undefined
  const { sessionId } = params
  const key = `${sessionId}\u0000${lane}`

  // Read now, not at settle: a session switch mid-request must not redirect it.
  let sidecarPath: string | undefined
  if (lane === 'main' && !persistenceDisabled()) {
    try {
      sidecarPath = sessionSidecarPath(
        sessionId,
        PROMPT_CACHE_SELFCHECK_SIDECAR_NAME,
      )
    } catch {
      sidecarPath = undefined
    }
  }
  const uuids = new Set<string>()
  let anchor: string | undefined
  for (const m of params.messages) {
    const uuid = field(m, 'uuid')
    if (typeof uuid !== 'string') continue
    uuids.add(uuid)
    if (anchor === undefined && field(m, 'type') === 'assistant') anchor = uuid
  }

  let body: string | undefined
  let settled: Record<string, unknown> | undefined
  return {
    onRequestBody: text => {
      body = text
    },
    settle: () => {
      if (settled !== undefined) return settled
      settled = {}
      if (body === undefined) return settled
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        return settled
      }
      const now: LaneState = {
        parts: partsOf(parsed),
        chain: chainOf(parsed.input),
        ...(anchor !== undefined && { anchor }),
      }
      let prev: PromptCacheSelfCheckRecord['prev'] = 'none'
      let before = lanes.get(key)
      if (before !== undefined) prev = 'memory'
      else if (sidecarPath !== undefined) {
        before = readSidecar(sidecarPath, sessionId)
        if (before !== undefined) prev = 'sidecar'
      }
      const record: PromptCacheSelfCheckRecord = {
        v: 1,
        prev,
        changed: [],
        inputPrev: before === undefined ? 0 : before.chain.length / LINK_BYTES,
        inputNow: now.chain.length / LINK_BYTES,
      }
      if (before !== undefined) {
        for (const [name, reason] of PARTS) {
          if (before.parts[name] !== now.parts[name])
            record.changed.push(reason)
        }
        const at = divergence(before.chain, now.chain)
        if (at !== undefined) {
          const compacted =
            before.anchor !== undefined && !uuids.has(before.anchor)
          record.changed.push(compacted ? 'context_compacted' : 'input_changed')
          record.divergedAt = at
        }
      }
      remember(key, now)
      if (sidecarPath !== undefined) writeSidecar(sidecarPath, sessionId, now)
      settled = { [PROMPT_CACHE_SELFCHECK_FIELD]: record }
      return settled
    },
  }
}

/** Test seam. */
export function resetPromptCacheSelfCheckForTesting(): void {
  lanes.clear()
}
