// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation the previews talk to (`../frontPreview.ts`,
 * `./serve.ts`): five agents on three servers and a chat port that answers
 * after a few process steps, so the front can be clicked through without a
 * registry or a node. Not a test.
 */

import type {
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleResult,
} from '../../src/deps.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

export const TARGETS: readonly ChatTarget[] = [
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

export class PreviewChat implements ChatPort {
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
    // `/app`'s list (P37.10): conversations across agents and days, one long
    // conversation with steps and a pause, and one agent working a computer.
    const hour = 3_600_000
    const day = 24 * hour
    this.#seed('qianmo://hub/ops', now - 70 * 60_000, [
      ['operator', '把桌面版的发布清单整理出来 · 按平台分开'],
      ['notice', '读：docs/dev/qmo-app.md'],
      ['notice', '搜：P37.8 · 包表'],
      ['notice', '执行：git log --oneline -20 -- atlas/apps/qmo'],
      [
        'agent',
        '按平台整理如下\n\n**macOS**\n\n- 本机构建 `bun run atlas:build:app`\n- 走完配对 · 进门 · 对话 · 退出\n- 红绿灯位置与 48 px 顶栏对齐\n\n**Windows 与 Linux**\n\n- 至少编译通过\n- 安装包放到 P37.12\n\n签名 公证与自动更新不在本轮',
      ],
      ['operator', '再核对一下中枢这边的路由有没有写进路由表', 25 * 60_000],
      ['notice', '读：docs/dev/console.md'],
      ['warn', '执行：bun test atlas/packages/console/test/routeDocs.test.ts'],
      ['notice', '改：docs/dev/console.md'],
      [
        'agent',
        '路由表补了两行\n\n```\nGET /app\nGET /app/quick\n```\n\n路由文档用例已过 · 反向扫描也没有多出的路径',
      ],
    ])
    this.#seed('qianmo://beta-5/coder', now - 3 * 60_000, [
      ['operator', '在云端电脑上打开控制台 · 截一张对话页的图给我'],
      ['notice', '读：atlas/packages/console/test/preview/README.md'],
      ['notice', 'computer：打开 http://127.0.0.1:38700/app'],
    ])
    this.#seed('qianmo://beta-5/coder', now - 2 * hour, [
      ['operator', '修一下 mailbox 持锁用例的偶发失败'],
      ['notice', '读：atlas/packages/node/src/mailbox.ts'],
      ['notice', '改：atlas/packages/node/src/mailbox.ts'],
      ['agent', '已改成先进队再建目录 · 本地连跑 200 次全绿'],
    ])
    this.#seed('qianmo://hub/ops', now - day - 2 * hour, [
      ['operator', '复盘昨晚 beta-4 的唤醒失败'],
      ['agent', 'beta-4 在 23:40 断开控制链路 · 唤醒请求在队列里超时 · 已重连'],
    ])
    this.#seed('qianmo://beta-4/writer', now - 2 * day, [
      ['operator', '起草十月的运维周报'],
      ['agent', '初稿已写好 · 等你补充两条事故记录'],
    ])
    this.#seed('qianmo://beta-1/planner', now - 5 * day, [
      ['operator', '排一下下周的值守表'],
      ['agent', '已按三人轮值排好 · 周三需要换班'],
    ])
    this.#seed('qianmo://hub/ops', now - 12 * day, [
      ['operator', '核对 magpie 网关的限额'],
      ['agent', '三把密钥都在限额内 · 最高用到 62%'],
    ])
    this.#seed('qianmo://beta-5/reviewer', now - 20 * day, [
      ['operator', '审一下 feat/harness-backends 的第 6 条'],
      ['agent', '第 6 条通过 · 留了两条建议'],
    ])
    this.#seed('qianmo://hub/ops', now - 45 * day, [
      ['operator', '清理 p5 上的旧备份'],
      ['agent', '只留最近三代 · 释放 2.9 GB'],
    ])
  }

  #seed(
    target: string,
    at: number,
    lines: readonly (readonly [string, string, number?])[],
  ): void {
    const session = this.#make(target, at)
    const turns: ChatTurn[] = []
    let when = at
    lines.forEach(([kind, text, after], index) => {
      when += index === 0 ? 0 : (after ?? 4_000)
      turns.push({
        id: `seed-${session.id}-${index}`,
        sessionId: session.id,
        author: kind === 'operator' ? 'operator' : 'agent',
        at: when,
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
        ...(kind === 'notice' || kind === 'warn'
          ? {
              variant: 'notice' as const,
              severity: kind === 'warn' ? ('warn' as const) : ('info' as const),
              noticeSource: 'step' as const,
              ...(kind === 'warn' ? { detail: '1 skip · 用例数 431 行' } : {}),
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
