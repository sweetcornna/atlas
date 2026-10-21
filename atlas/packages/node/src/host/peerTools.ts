// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The roster and synchronous questions between agents (P36.6,
 * `harness-backends.md` §6.2). `qianmo_agents` lists who the caller may dial;
 * `qianmo_ask` asks one to four of them and waits, in the calling turn, for
 * their answers. Every runtime gets both, next to the task tools, in a fixed
 * order and on every turn (P30's stable tool face).
 *
 * Like the task tools these only forward to the hub (`peers.*` hub calls) with
 * the console conversation and turn they were called from. The hub checks
 * that turn, dispatches as the conversation's owner, and signs the call chain
 * that lets the asked agent's turn nest inside this one when both run on the
 * same node (`NodeTurnGate`); nothing here decides who may ask whom.
 */

import { verifiedChain, verifiedTaskOwner } from '@qianmo/capability'
import type { ControlOutcome, QianmoMessage } from '@qianmo/protocol'
import type { ResidentTurnReentry } from '@qianmo/resident'
import type { HostToolDefinition } from './notifyTool.js'
import type { TaskToolOrigin } from './taskTools.js'

/** The bounds of one question; the hub enforces the same ones. */
export const PEER_ASK = {
  maxTargets: 4,
  maxMessageBytes: 16 * 1024,
  defaultTimeoutSec: 300,
  maxTimeoutSec: 1_800,
} as const

/**
 * How a node's answer to a question starts when it had no process to run it
 * in: every one `--omp-max-children` allows is held by the turns it would
 * nest in. The hub reads it as `busy` (`consolePeers.ts`).
 */
export const NESTED_NO_ROOM_REASON = 'no room for a nested answer turn'

/**
 * The asker keeps this long of its own turn for using the answer: a question
 * never waits right up to the asking turn's deadline.
 */
const REPLY_MARGIN_MS = 30_000
/** A turn with less than this left (after the margin) does not ask at all. */
const MIN_TIMEOUT_SEC = 10
/**
 * How much longer than the question's own timeout the hub call may take: the
 * hub stops a late target (`turn.stop`, up to 10 s) before it answers.
 */
const HUB_SLACK_MS = 60_000
/** Well inside the resident's 120 s inactivity budget. */
const KEEP_ALIVE_MS = 20_000

export interface PeerToolOrigin extends TaskToolOrigin {
  /** Time left before the asking turn's own task deadline; Infinity when none. */
  readonly remainingMs: number
  /**
   * Counts the wait as activity of the asking turn. The runtime sends nothing
   * while a host tool runs, and the node's inactivity watchdog would end a
   * turn that waits minutes on another agent.
   */
  readonly keepAlive: () => void
}

export interface PeerToolsOptions {
  readonly call: (
    op: string,
    args: Record<string, unknown>,
    options: { agent: string; timeoutMs?: number },
  ) => Promise<ControlOutcome>
  /** The running turn behind a tool call, or null when it has none. */
  readonly origin: (ctx: {
    readonly agent: string
    readonly sessionId: string
  }) => PeerToolOrigin | null
  /** How often a waiting question counts as activity; tests shorten it. */
  readonly keepAliveMs?: number
}

const AGENTS_DESCRIPTION =
  'List the agents you can ask with qianmo_ask: each one’s qianmo://node/agent address, runtime, model, whether it is online and busy, and a one-line description.'

const ASK_DESCRIPTION = `Ask another agent (agent) or up to ${PEER_ASK.maxTargets} at once (agents), by qianmo://node/agent address, and wait in this turn for their answers; several targets work in parallel. Each keeps one running conversation with this conversation, so it remembers what you asked it before. Use it for what can be answered within minutes (review a snippet, check a fact, get an opinion); hand long work to qianmo_task_start instead. timeoutSec defaults to ${PEER_ASK.defaultTimeoutSec}, at most ${PEER_ASK.maxTimeoutSec}; a target that has not answered by then is stopped and reported as timed out.`

const OUTSIDE =
  'Asking other agents is only available in a console or chat-channel conversation.'

interface AskArguments {
  readonly agents: readonly string[]
  readonly message: string
  readonly timeoutSec: number
}

/** The question as asked, or why it cannot be sent. */
function askArguments(raw: unknown): AskArguments | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return 'Invalid arguments.'
  const params = raw as Record<string, unknown>
  const known = new Set(['agent', 'agents', 'message', 'timeoutSec'])
  if (Object.keys(params).some(key => !known.has(key)))
    return 'Invalid arguments.'
  // A provider's strict mode makes every field required: a model fills the
  // ones it does not mean with null or '', or repeats agent inside agents.
  const message = params['message']
  const timeoutSec = params['timeoutSec'] ?? undefined
  const agent =
    params['agent'] === '' ? undefined : (params['agent'] ?? undefined)
  let agents =
    Array.isArray(params['agents']) && params['agents'].length === 0
      ? undefined
      : (params['agents'] ?? undefined)
  if (
    typeof agent === 'string' &&
    Array.isArray(agents) &&
    agents.length === 1 &&
    agents[0] === agent
  )
    agents = undefined
  let targets: string[]
  if (agent !== undefined && agents !== undefined)
    return 'Give either agent or agents, not both.'
  if (typeof agent === 'string') targets = [agent.trim()]
  else if (
    Array.isArray(agents) &&
    agents.every((one): one is string => typeof one === 'string')
  )
    targets = agents.map(one => one.trim())
  else return 'Give agent (one address) or agents (a list of addresses).'
  if (
    targets.length === 0 ||
    targets.length > PEER_ASK.maxTargets ||
    targets.some(one => one === '') ||
    new Set(targets).size !== targets.length
  )
    return `Give 1 to ${PEER_ASK.maxTargets} different agent addresses.`
  if (typeof message !== 'string' || message.trim() === '')
    return 'The message is empty.'
  if (Buffer.byteLength(message) > PEER_ASK.maxMessageBytes)
    return `The message is longer than ${PEER_ASK.maxMessageBytes / 1024} KiB; send a summary and point to the details.`
  if (
    timeoutSec !== undefined &&
    (typeof timeoutSec !== 'number' ||
      !Number.isInteger(timeoutSec) ||
      timeoutSec < 1 ||
      timeoutSec > PEER_ASK.maxTimeoutSec)
  )
    return `timeoutSec is a whole number of seconds from 1 to ${PEER_ASK.maxTimeoutSec}.`
  return {
    agents: targets,
    message,
    timeoutSec:
      typeof timeoutSec === 'number' ? timeoutSec : PEER_ASK.defaultTimeoutSec,
  }
}

function answer(result: ControlOutcome): {
  ok: boolean
  text: string
  details: ControlOutcome
} {
  return {
    ok: result.ok,
    text: JSON.stringify(result.ok ? result.value : { error: result.message }),
    details: result,
  }
}

export function peerTools(options: PeerToolsOptions): HostToolDefinition[] {
  const keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS
  return [
    {
      name: 'qianmo_agents',
      description: AGENTS_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      async handler(raw, ctx) {
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          Object.keys(raw).length > 0
        )
          return { ok: false, text: 'Invalid arguments.' }
        const origin = options.origin(ctx)
        if (origin === null) return { ok: false, text: OUTSIDE }
        try {
          return answer(
            await options.call(
              'peers.list',
              { contextId: origin.contextId, taskId: origin.taskId },
              { agent: ctx.agent },
            ),
          )
        } catch {
          return {
            ok: false,
            text: 'The roster service did not answer. Try again in a moment.',
          }
        }
      },
    },
    {
      name: 'qianmo_ask',
      description: ASK_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent: { type: 'string' },
          agents: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: PEER_ASK.maxTargets,
          },
          message: { type: 'string' },
          timeoutSec: {
            type: 'integer',
            minimum: 1,
            maximum: PEER_ASK.maxTimeoutSec,
          },
        },
        required: ['message'],
      },
      async handler(raw, ctx) {
        const ask = askArguments(raw)
        if (typeof ask === 'string') return { ok: false, text: ask }
        const origin = options.origin(ctx)
        if (origin === null) return { ok: false, text: OUTSIDE }
        // The answer has to come back while this turn can still use it.
        const left = Math.floor((origin.remainingMs - REPLY_MARGIN_MS) / 1000)
        const timeoutSec = Math.min(ask.timeoutSec, left)
        if (left < Math.min(ask.timeoutSec, MIN_TIMEOUT_SEC))
          return {
            ok: false,
            text: 'Not enough time is left in this turn to wait for an answer. Answer without asking, or hand the question over with qianmo_task_start.',
          }
        origin.keepAlive()
        const timer = setInterval(origin.keepAlive, keepAliveMs)
        timer.unref?.()
        try {
          return answer(
            await options.call(
              'peers.ask',
              {
                agents: ask.agents,
                message: ask.message,
                timeoutSec,
                contextId: origin.contextId,
                taskId: origin.taskId,
              },
              { agent: ctx.agent, timeoutMs: timeoutSec * 1000 + HUB_SLACK_MS },
            ),
          )
        } catch {
          return {
            ok: false,
            text: 'The peer service did not answer; whether the question reached the other agents is unknown. Ask again only if you still need the answer.',
          }
        } finally {
          clearInterval(timer)
        }
      },
    },
  ]
}

/**
 * A turn's place in the gate's call-chain re-entry (P36.6), read from the
 * request behind it. Only a request whose owner proof verifies against a
 * controller key gets a key — the hub's own turns are the only ones a chain
 * can name — and only the verified chain's links on this node are passed:
 * those are the turns here that may be blocked waiting on this one.
 */
export function askReentry(
  envelope: QianmoMessage,
  node: string,
  controllers: ReadonlyMap<string, string>,
): ResidentTurnReentry | undefined {
  if (verifiedTaskOwner(envelope, controllers) === undefined) return undefined
  const chain = (verifiedChain(envelope, controllers) ?? [])
    .filter(link => link.node === node)
    .map(link => link.taskId)
  return { key: envelope.taskId, ...(chain.length > 0 ? { chain } : {}) }
}
