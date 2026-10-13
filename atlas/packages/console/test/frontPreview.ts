// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A local preview of the conversation front, with a fleet that answers.
 *
 * Not a test: `bun atlas/packages/console/test/frontPreview.ts [port]` serves
 * the console on loopback with three servers, five agents and a chat port
 * that replies after a few process steps, so the front can be looked at and
 * clicked through without a registry or a node. The admin token is printed.
 */

import type {
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleDeps,
  ConsoleResult,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import {
  agentAt,
  LIMITS,
  PageAudit,
  PageRegistry,
  TOKENS,
} from './pageHarness.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

const TARGETS: readonly ChatTarget[] = [
  ['hub', 'ops', 'online', true],
  ['beta-5', 'reviewer', 'online', true],
  ['beta-5', 'coder', 'online', true],
  ['beta-1', 'planner', 'online', true],
  ['beta-4', 'writer', 'dormant', false],
].map(([node, agent, status, dialable]) => ({
  address: `qianmo://${String(node)}/${String(agent)}`,
  node: String(node),
  agent: String(agent),
  endpoint: 'ws://127.0.0.1:38625/',
  status: String(status),
  dialable: dialable === true,
}))

class PreviewChat implements ChatPort {
  readonly #sessions = new Map<string, ChatSession>()
  readonly #turns = new Map<string, ChatTurn[]>()
  readonly #listeners = new Set<(update: ChatUpdate) => void>()
  #next = 0
  #revision = 0

  constructor() {
    const now = Date.now()
    this.#seed('qianmo://hub/ops', now - 3_600_000, [
      ['operator', '检查一下各节点的内存余量'],
      ['notice', '读：/proc/meminfo'],
      ['notice', '执行：ssh beta-5 free -m'],
      [
        'agent',
        '三台节点的可用内存如下\n\n- hub 可用 **402 MB**\n- beta-5 可用 **630 MB**\n- beta-1 可用 **384 MB** · 偏紧\n\n建议先把 beta-1 的空闲回收时长调到 `60000`',
      ],
    ])
    this.#seed('qianmo://beta-5/reviewer', now - 600_000, [
      ['operator', '复核 feat/console-agent-front 分支的改动'],
      ['notice', '读：atlas/packages/console/src/view/front.ts'],
    ])
    this.#seed('qianmo://beta-1/planner', now - 86_400_000 * 3, [
      ['operator', '整理下周的发版计划'],
      [
        'agent',
        '已整理成三步 · 见下\n\n1. 冻结分支\n2. 跑全量门禁\n3. 灰度两台节点',
      ],
    ])
  }

  #seed(
    target: string,
    at: number,
    lines: readonly (readonly [string, string])[],
  ): void {
    const session = this.#make(target, at)
    const turns: ChatTurn[] = []
    lines.forEach(([kind, text], index) => {
      turns.push({
        id: `seed-${session.id}-${index}`,
        sessionId: session.id,
        author: kind === 'operator' ? 'operator' : 'agent',
        at: at + index * 4_000,
        text,
        state: kind === 'operator' ? 'read' : 'done',
        ...(kind === 'operator'
          ? { receipt: 'accepted', receiptMs: 38, readMs: 412 }
          : {}),
        ...(kind === 'agent'
          ? {
              elapsedMs: 9_400,
              taskId: 'f3c1a9e2b7d04411',
              traceId:
                '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            }
          : {}),
        ...(kind === 'notice'
          ? {
              variant: 'notice' as const,
              severity: 'info' as const,
              noticeSource: 'step' as const,
            }
          : {}),
      })
    })
    this.#turns.set(session.id, turns)
  }

  #make(target: string, at: number): ChatSession {
    const found = TARGETS.find(one => one.address === target)
    this.#next += 1
    const session: ChatSession = {
      id: `s${this.#next}`,
      target,
      node: found?.node ?? 'unknown',
      agent: found?.agent ?? 'unknown',
      createdAt: at,
      updatedAt: at,
      turnCount: 0,
      preview: '',
    }
    this.#sessions.set(session.id, session)
    this.#turns.set(session.id, [])
    return session
  }

  #view(id: string): ChatSession | undefined {
    const session = this.#sessions.get(id)
    if (session === undefined) return undefined
    const turns = this.#turns.get(id) ?? []
    const messages = turns.filter(turn => turn.variant !== 'notice')
    const last = messages[messages.length - 1]
    const first = messages.find(turn => turn.author === 'operator')
    return {
      ...session,
      updatedAt: turns[turns.length - 1]?.at ?? session.createdAt,
      turnCount: messages.length,
      preview: last?.text ?? '',
      ...(first === undefined ? {} : { title: first.text }),
      ...(last !== undefined &&
      last.author === 'operator' &&
      last.state !== 'failed'
        ? { running: true as const }
        : {}),
    }
  }

  #emit(sessionId: string): void {
    this.#revision += 1
    for (const listener of this.#listeners)
      listener({ sessionId, revision: this.#revision })
  }

  targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return Promise.resolve(ok(TARGETS))
  }

  sessions(): Promise<ConsoleResult<readonly ChatSession[]>> {
    return Promise.resolve(
      ok([...this.#sessions.keys()].flatMap(id => this.#view(id) ?? [])),
    )
  }

  open(target: string): Promise<ConsoleResult<ChatSession>> {
    const session = this.#make(target, Date.now())
    this.#emit(session.id)
    return Promise.resolve(ok(session))
  }

  transcript(sessionId: string): Promise<ConsoleResult<ChatTranscript>> {
    const session = this.#view(sessionId)
    if (session === undefined) {
      return Promise.resolve({
        ok: false,
        failure: { code: 'not_found', message: '这条会话不在本控制台的记录里' },
      })
    }
    return Promise.resolve(
      ok({ session, turns: [...(this.#turns.get(sessionId) ?? [])] }),
    )
  }

  send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    const turns = this.#turns.get(input.sessionId)
    if (turns === undefined) {
      return Promise.resolve({
        ok: false,
        failure: { code: 'not_found', message: '这条会话不在本控制台的记录里' },
      })
    }
    const sent = Date.now()
    const turn: ChatTurn = {
      id: `t${sent}`,
      sessionId: input.sessionId,
      author: 'operator',
      at: sent,
      text: input.text,
      state: 'pending',
    }
    turns.push(turn)
    const index = turns.length - 1
    const later = (ms: number, run: () => void): void => {
      setTimeout(() => {
        run()
        this.#emit(input.sessionId)
      }, ms)
    }
    later(300, () => {
      turns[index] = {
        ...turn,
        state: 'delivered',
        receipt: 'accepted',
        receiptMs: 41,
      }
    })
    later(900, () => {
      turns[index] = {
        ...turn,
        state: 'read',
        receipt: 'accepted',
        receiptMs: 41,
        readMs: 880,
      }
    })
    const steps = [
      '读：docs/dev/console.md',
      '执行：bun run atlas:typecheck',
      '改：atlas/packages/console/src/view/front.ts',
    ]
    steps.forEach((text, step) => {
      later(1_800 + step * 1_400, () => {
        turns.push({
          id: `n${Date.now()}-${step}`,
          sessionId: input.sessionId,
          author: 'agent',
          at: Date.now(),
          text,
          state: 'done',
          variant: 'notice',
          severity: step === 1 ? 'warn' : 'info',
          noticeSource: 'step',
          ...(step === 1 ? { detail: 'tsgo: 0 errors · 2 warnings' } : {}),
        })
      })
    })
    later(6_500, () => {
      turns.push({
        id: `a${Date.now()}`,
        sessionId: input.sessionId,
        author: 'agent',
        at: Date.now(),
        text: `收到 · 已处理「${input.text.slice(0, 30)}」\n\n结果：\n\n\`\`\`\nbun run atlas:typecheck\n0 errors\n\`\`\`\n\n下一步可以跑 \`bun run precheck\``,
        state: 'done',
        elapsedMs: Date.now() - sent,
        taskId: `task${sent}`,
      })
    })
    this.#emit(input.sessionId)
    return Promise.resolve(ok(turn))
  }

  subscribe(listener: (update: ChatUpdate) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}

const registry = new PageRegistry()
registry.listResult = ok(TARGETS.map(target => agentAt(target.address)))
const deps: ConsoleDeps = {
  registry,
  audit: new PageAudit(),
  limits: LIMITS,
  label: 'preview-hub',
  identity: 'qianmo://hub/console',
  chat: new PreviewChat(),
  chatDefault: 'qianmo://hub/ops',
}
const handle = createConsoleHandler(deps, TOKENS)
const port = Number(process.argv[2] ?? 38690)
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: request => handle(request),
  idleTimeout: 0,
})
process.stdout.write(
  `front preview on http://127.0.0.1:${port}/?token=${TOKENS.admin}\n`,
)
