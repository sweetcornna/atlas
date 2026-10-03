// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A console with a small, believable network behind it, for the tests that
 * look at whole pages: three agents on two nodes, a trail with one trace in
 * it, a wake channel, and optionally a chat channel and server attribution.
 *
 * Hand-written fakes, like every other suite here (`http.test.ts` on why
 * module mocking is not used). The registry's list is a field rather than a
 * constant so a test — the browser-level ones in particular — can change what
 * the next poll sees.
 */

import { AuditSource, type AuditRecord, type MessageChain } from '@qianmo/audit'
import type { ConsoleTokens } from '../src/auth.js'
import type {
  AuditFilter,
  AuditPage,
  AuditPort,
  ConsoleAgent,
  ConsoleDeps,
  ConsoleResult,
  LimitsSnapshot,
  NodeServer,
  RegisterAgentInput,
  RegistryPort,
  WakeInput,
  WakeOutcome,
  WakePort,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import { CountingChat } from './accountsHarness.js'

export const VIEW = 'view-token-000000000001'
export const ADMIN = 'admin-token-00000000001'
export const TOKENS: ConsoleTokens = { view: VIEW, admin: ADMIN }
export const NOW = 1_700_000_000_000
export const BASE = 'http://console.test'
export const LABEL = 'tokyo-hub'
export const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

export function agentAt(address: string, over: Partial<ConsoleAgent> = {}) {
  const agent: ConsoleAgent = {
    address,
    endpoint: 'ws://127.0.0.1:38611/',
    capabilities: ['task.request'],
    status: 'online',
    registeredAt: NOW - 60_000,
    lastHeartbeatAt: NOW - 1_000,
    expiresAt: NOW + 89_000,
    ...over,
  }
  return agent
}

/** Three agents, two nodes: the shape that tells an agent count from a node count. */
export const AGENTS: readonly ConsoleAgent[] = [
  agentAt('qianmo://tokyo-1/planner'),
  agentAt('qianmo://tokyo-1/reviewer'),
  agentAt('qianmo://osaka-1/writer'),
]

const RECORD: AuditRecord = {
  seq: 1,
  at: NOW - 5_000,
  source: AuditSource.Router,
  kind: 'forwarded',
  traceId: TRACE,
  outcome: 'ok',
  prev: '0'.repeat(64),
}

const PAGE: AuditPage = {
  records: [RECORD],
  chain: 'intact',
  intact: true,
  issueCount: 0,
  total: 1,
}

const CHAIN: MessageChain = {
  traceId: TRACE,
  records: [RECORD],
  taskIds: [],
  msgIds: [],
  sources: [AuditSource.Router],
  refused: 0,
  dropped: 0,
  firstAt: RECORD.at,
  lastAt: RECORD.at,
}

export const LIMITS: LimitsSnapshot = {
  protocol: {
    maxMessageBytes: 262_144,
    maxHops: 8,
    defaultTtlMs: 30_000,
    defaultTaskTtlMs: 600_000,
    ratePerMinute: 60,
  },
  runtime: { capacity: 20, windowMs: 1_000 },
  registryTtlMs: 90_000,
}

export class PageRegistry implements RegistryPort {
  listResult: ConsoleResult<readonly ConsoleAgent[]> = ok(AGENTS)
  listCalls = 0
  readonly registered: RegisterAgentInput[] = []
  readonly deregistered: string[] = []
  readonly beats: string[] = []

  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
    this.listCalls += 1
    return Promise.resolve(this.listResult)
  }

  register(input: RegisterAgentInput): Promise<ConsoleResult<ConsoleAgent>> {
    this.registered.push(input)
    return Promise.resolve(ok(agentAt(input.address)))
  }

  deregister(address: string): Promise<ConsoleResult<void>> {
    this.deregistered.push(address)
    return Promise.resolve(ok(undefined))
  }

  heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>> {
    this.beats.push(address)
    return Promise.resolve(ok(agentAt(address)))
  }
}

export class PageAudit implements AuditPort {
  readResult: ConsoleResult<AuditPage> = ok(PAGE)
  readonly filters: AuditFilter[] = []

  read(filter: AuditFilter): Promise<ConsoleResult<AuditPage>> {
    this.filters.push(filter)
    return Promise.resolve(this.readResult)
  }

  chain(traceId: string): Promise<ConsoleResult<MessageChain | null>> {
    return Promise.resolve(ok(traceId === TRACE ? CHAIN : null))
  }
}

export class PageWake implements WakePort {
  readonly sent: WakeInput[] = []
  send(input: WakeInput): Promise<ConsoleResult<WakeOutcome>> {
    this.sent.push(input)
    return Promise.resolve(
      ok({ msgId: 'msg-1', taskId: 'task-1', receipt: 'accepted' }),
    )
  }
}

export interface PageHarness {
  readonly registry: PageRegistry
  readonly audit: PageAudit
  readonly wake: PageWake
  readonly chat: CountingChat
  readonly deps: ConsoleDeps
  readonly handle: (request: Request) => Promise<Response>
}

export function pageHarness(
  options: {
    readonly chat?: boolean
    readonly wake?: boolean
    readonly nodeServers?: readonly NodeServer[]
  } = {},
): PageHarness {
  const registry = new PageRegistry()
  const audit = new PageAudit()
  const wake = new PageWake()
  const chat = new CountingChat()
  const deps: ConsoleDeps = {
    registry,
    audit,
    limits: LIMITS,
    now: () => NOW,
    label: LABEL,
    identity: 'qianmo://tokyo-hub/console',
    ...(options.wake === false ? {} : { wake }),
    ...(options.chat === true ? { chat } : {}),
    ...(options.nodeServers === undefined
      ? {}
      : { nodeServers: options.nodeServers }),
  }
  return {
    registry,
    audit,
    wake,
    chat,
    deps,
    handle: createConsoleHandler(deps, TOKENS),
  }
}

/** A browser navigation: `Accept: text/html`, the token as a Bearer if given. */
export function browse(path: string, token?: string, method = 'GET'): Request {
  const headers: Record<string, string> = { accept: 'text/html' }
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  return new Request(`${BASE}${path}`, { method, headers })
}

/** Visible text only: markup, attributes, the inline style and script out. */
export function visibleText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]*>/g, ' ')
}

/** The document with every inline script removed: what a no-script reader gets. */
export function withoutScripts(html: string): string {
  return html.replace(/<script>[\s\S]*?<\/script>/g, '')
}
