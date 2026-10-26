// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation the previews talk to (`../frontPreview.ts`,
 * `./serve.ts`): five agents on three servers and a chat port that answers
 * after a few process steps, so the front can be clicked through without a
 * registry or a node. Not a test.
 */

import type { AccountBook } from '../../src/accounts.js'
import type {
  ChatOpenOptions,
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleResult,
} from '../../src/deps.js'
import type { WorkActivity, WorkFileRef, WorkflowId } from '../../src/work.js'
import type { FakeOutput } from '../workFake.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

const RESIDENT = true
const OLDER = false

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

/**
 * Make the seeded resident conversations and work sessions the person's
 * with `credential`, as if they had opened them: a console with personal
 * accounts keeps whose a conversation is in the account book (P37.17).
 */
export function ownResidents(
  chat: PreviewChat,
  book: AccountBook,
  credential: string,
): void {
  const principal = book.bearerPrincipal(credential)
  if (!principal.ok || principal.value.kind !== 'user') {
    throw new Error('the preview could not find its ops person')
  }
  for (const id of chat.residentIds()) {
    const owned = book.recordOwner(id, principal.value.subject)
    if (!owned.ok) throw new Error(owned.refusal.message)
  }
}

/** A delivered file of the preview's work sessions. */
function delivered(
  name: string,
  kind: WorkFileRef['kind'],
  size: number,
  preview = true,
): WorkFileRef {
  return {
    name,
    size,
    kind,
    mime: 'application/octet-stream',
    sha256: '5f'.repeat(32),
    preview,
  }
}

/** The preview's slides, drawn the way a node's preview HTML is: no script. */
const SLIDES_PREVIEW =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>季度经营汇报</title>' +
  '<style>body{margin:0;background:#e9e8e3;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2420}' +
  '.slide{aspect-ratio:16/9;max-width:860px;margin:24px auto;background:#fff;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.12);padding:48px 56px;box-sizing:border-box;display:flex;flex-direction:column;gap:18px}' +
  'h1{margin:auto 0 0;font-size:40px}h2{margin:0;font-size:28px}p{margin:0;font-size:18px;color:#555}' +
  '.bars{display:flex;align-items:flex-end;gap:22px;height:180px;margin-top:auto}.bars i{flex:1;background:#2f6f5e;border-radius:3px 3px 0 0}' +
  '@media (prefers-color-scheme:dark){body{background:#1d1f1e}.slide{background:#2a2d2b;color:#e6ebe7}p{color:#aab2ad}}</style>' +
  '<section class="slide"><h1>三季度经营汇报</h1><p>管理层例会 · 2026 年 10 月</p></section>' +
  '<section class="slide"><h2>结论</h2><p>营收同比 +18% · 毛利率回到 41% · 第四季度三项重点</p>' +
  '<div class="bars"><i style="height:48%"></i><i style="height:62%"></i><i style="height:71%"></i><i style="height:86%"></i></div></section>' +
  '<script>document.body.textContent = "脚本跑了"</script></html>'

export class PreviewChat implements ChatPort {
  readonly #sessions = new Map<string, ChatSession>()
  readonly #turns = new Map<string, ChatTurn[]>()
  readonly #activity = new Map<string, WorkActivity>()
  /** The outputs folder of each work session, newest first. */
  readonly outputs = new Map<string, FakeOutput[]>()
  readonly #listeners = new Set<(update: ChatUpdate) => void>()
  #next = 0
  #revision = 0

  constructor() {
    const now = Date.now()
    // The resident conversations (P37.17): one per agent, the rest are
    // older ones under each agent's 其他对话.
    this.#seed('qianmo://hub/ops', now - 3_600_000, RESIDENT, [
      ['operator', '检查一下各节点的内存余量'],
      ['notice', '读：/proc/meminfo'],
      ['notice', '执行：ssh beta-5 free -m'],
      [
        'agent',
        '三台节点的可用内存如下\n\n- hub 可用 **402 MB**\n- beta-5 可用 **630 MB**\n- beta-1 可用 **384 MB** · 偏紧\n\n建议先把 beta-1 的空闲回收时长调到 `60000`',
      ],
    ])
    this.#seed('qianmo://beta-5/reviewer', now - 600_000, RESIDENT, [
      ['operator', '复核 feat/console-agent-front 分支的改动'],
      ['notice', '读：atlas/packages/console/src/view/front.ts'],
    ])
    this.#seed('qianmo://beta-1/planner', now - 86_400_000 * 3, RESIDENT, [
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
    this.#seed('qianmo://hub/ops', now - 70 * 60_000, OLDER, [
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
        "路由表补了两行\n\n```\nGET /app\nGET /app/quick\ncurl -fsS -o /dev/null -w '%{http_code} %{time_total}' -H 'cookie: qianmo_shell=macos' http://127.0.0.1:38700/app/quick\n```\n\n路由文档用例已过 · 反向扫描也没有多出的路径",
      ],
    ])
    this.#seed('qianmo://beta-5/coder', now - 3 * 60_000, RESIDENT, [
      ['operator', '在云端电脑上打开控制台 · 截一张对话页的图给我'],
      ['notice', '读：atlas/packages/console/test/preview/README.md'],
      ['notice', 'computer：打开 http://127.0.0.1:38700/app'],
    ])
    this.#seed('qianmo://beta-5/coder', now - 2 * hour, OLDER, [
      ['operator', '修一下 mailbox 持锁用例的偶发失败'],
      ['notice', '读：atlas/packages/node/src/mailbox.ts'],
      ['notice', '改：atlas/packages/node/src/mailbox.ts'],
      ['agent', '已改成先进队再建目录 · 本地连跑 200 次全绿'],
    ])
    this.#seed('qianmo://hub/ops', now - day - 2 * hour, OLDER, [
      ['operator', '复盘昨晚 beta-4 的唤醒失败'],
      ['agent', 'beta-4 在 23:40 断开控制链路 · 唤醒请求在队列里超时 · 已重连'],
    ])
    this.#seed('qianmo://beta-4/writer', now - 2 * day, OLDER, [
      ['operator', '起草十月的运维周报'],
      ['agent', '初稿已写好 · 等你补充两条事故记录'],
    ])
    this.#seed('qianmo://beta-1/planner', now - 5 * day, OLDER, [
      ['operator', '排一下下周的值守表'],
      ['agent', '已按三人轮值排好 · 周三需要换班'],
    ])
    this.#seed('qianmo://hub/ops', now - 12 * day, OLDER, [
      ['operator', '核对 magpie 网关的限额'],
      ['agent', '三把密钥都在限额内 · 最高用到 62%'],
    ])
    this.#seed('qianmo://beta-5/reviewer', now - 20 * day, OLDER, [
      ['operator', '审一下 feat/harness-backends 的第 6 条'],
      ['agent', '第 6 条通过 · 留了两条建议'],
    ])
    this.#seed('qianmo://hub/ops', now - 45 * day, OLDER, [
      ['operator', '清理 p5 上的旧备份'],
      ['agent', '只留最近三代 · 释放 2.9 GB'],
    ])
    // 广泛性工作 (P37.17 B): work sessions by day, with what they delivered,
    // their progress and their context.
    const slides = this.#seed(
      'qianmo://hub/ops',
      now - 40 * 60_000,
      OLDER,
      [
        ['operator', '把三季度经营数据做成 8 页的汇报 · 给管理层看'],
        ['notice', '读：skill://qmo-slides'],
        ['notice', '读：资料/三季度经营数据.xlsx'],
        ['notice', 'qianmo_make_document：季度经营汇报.pptx'],
        [
          'agent',
          '汇报做好了 · 8 页 · 结论放在第 2 页\n\n- 营收同比 **+18%**\n- 毛利率回到 41%\n- 第四季度三项重点',
        ],
      ],
      'slides',
    )
    this.#deliver(slides, 3, [
      delivered('季度经营汇报.pptx', 'presentation', 812_344),
      delivered('季度经营汇报.pdf', 'pdf', 1_204_876, false),
    ])
    this.#activity.set(slides.id, {
      progress: {
        taskId: 'p1',
        at: now - 38 * 60_000,
        total: 4,
        done: 4,
        step: 4,
        current: null,
        items: [
          { phase: '准备', content: '读三季度数据', status: 'completed' },
          { phase: '准备', content: '定 8 页大纲', status: 'completed' },
          { phase: '成稿', content: '生成演示文稿', status: 'completed' },
          { phase: '成稿', content: '打 PDF 并交付', status: 'completed' },
        ],
      },
      context: {
        taskId: 'p1',
        at: now - 38 * 60_000,
        workflows: ['slides'],
        skills: ['qmo-slides'],
        tools: [
          { name: 'read', count: 4 },
          { name: 'qianmo_make_document', count: 1 },
          { name: 'qianmo_deliver_files', count: 1 },
        ],
        files: ['资料/三季度经营数据.xlsx'],
      },
    })
    this.outputs.set(slides.id, [
      {
        name: 'notes/大纲.md',
        size: 2_310,
        kind: 'text',
        mime: 'text/markdown; charset=utf-8',
        mtime: now - 37 * 60_000,
        preview: true,
        body: '<!doctype html><meta charset="utf-8"><pre>1. 封面\n2. 结论</pre>',
      },
      {
        name: '季度经营汇报.pdf',
        size: 1_204_876,
        kind: 'pdf',
        mime: 'application/pdf',
        mtime: now - 38 * 60_000,
        preview: false,
      },
      {
        name: '季度经营汇报.pptx',
        size: 812_344,
        kind: 'presentation',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        mtime: now - 38 * 60_000,
        preview: true,
        body: SLIDES_PREVIEW,
      },
    ])
    const research = this.#seed(
      'qianmo://beta-5/reviewer',
      now - 8 * 60_000,
      OLDER,
      [
        ['operator', '调研三家同类产品的定价 · 出一份带来源的报告'],
        ['notice', '读：skill://qmo-research'],
        ['notice', '搜：同类产品 定价 2026'],
      ],
      'research',
    )
    this.#activity.set(research.id, {
      progress: {
        taskId: 'r1',
        at: now - 6 * 60_000,
        total: 4,
        done: 1,
        step: 2,
        current: '逐家整理定价',
        items: [
          { phase: '', content: '列出三家产品', status: 'completed' },
          { phase: '', content: '逐家整理定价', status: 'in_progress' },
          { phase: '', content: '写对比与结论', status: 'pending' },
          { phase: '', content: '生成文档并交付', status: 'pending' },
        ],
      },
      context: {
        taskId: 'r1',
        at: now - 6 * 60_000,
        workflows: ['research'],
        skills: ['qmo-research'],
        tools: [
          { name: 'web_search', count: 3 },
          { name: 'read', count: 2 },
        ],
        files: [],
      },
    })
    const analysis = this.#seed(
      'qianmo://beta-5/coder',
      now - day - 3 * hour,
      OLDER,
      [
        ['operator', '分析十月的工单数据 · 给出表格和一页结论'],
        ['notice', '读：skill://qmo-analysis'],
        ['agent', '表格和结论都交付了 · 工单量环比下降 12%'],
      ],
      'analysis',
    )
    this.#deliver(analysis, 2, [
      delivered('十月工单分析.xlsx', 'spreadsheet', 48_220),
      delivered('十月工单结论.docx', 'document', 31_904),
    ])
    const page = this.#seed(
      'qianmo://hub/ops',
      now - 9 * day,
      OLDER,
      [
        ['operator', '做一个发版说明的单页网页'],
        ['agent', '单页做好了 · 自包含 · 没有外部资源'],
      ],
      'webpage',
    )
    this.#deliver(page, 1, [delivered('发版说明.html', 'webpage', 18_422)])
  }

  /** A delivery in a seeded session, after its `after`-th line. */
  #deliver(
    session: ChatSession,
    after: number,
    files: readonly WorkFileRef[],
  ): void {
    const turns = this.#turns.get(session.id) ?? []
    const at = (turns[after]?.at ?? session.createdAt) + 2_000
    turns.splice(after + 1, 0, {
      id: `files-${session.id}-${after}`,
      sessionId: session.id,
      author: 'agent',
      at,
      text: `交付了 ${files.length} 个文件`,
      state: 'done',
      variant: 'notice',
      noticeSource: 'files',
      severity: 'info',
      files,
    })
  }

  #seed(
    target: string,
    at: number,
    resident: boolean,
    lines: readonly (readonly [string, string, number?])[],
    workflow?: WorkflowId,
  ): ChatSession {
    const session = this.#make(target, at, resident, workflow)
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
    return session
  }

  /** `workflow` given makes it a work session (P37.17 B). */
  #make(
    target: string,
    at: number,
    resident: boolean,
    workflow?: WorkflowId | null,
  ): ChatSession {
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
      ...(resident ? { resident: true as const } : {}),
      ...(workflow === undefined ? {} : { work: true as const }),
      ...(workflow === undefined || workflow === null ? {} : { workflow }),
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

  /**
   * The seeded resident conversations: a preview with accounts on records
   * them as its ops person's, the way `POST /v0/chat/sessions` would have.
   */
  residentIds(): readonly string[] {
    return [...this.#sessions.values()]
      .filter(session => session.resident === true || session.work === true)
      .map(session => session.id)
  }

  targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return Promise.resolve(ok(TARGETS))
  }

  sessions(): Promise<ConsoleResult<readonly ChatSession[]>> {
    return Promise.resolve(
      ok([...this.#sessions.keys()].flatMap(id => this.#view(id) ?? [])),
    )
  }

  open(
    target: string,
    options?: ChatOpenOptions,
  ): Promise<ConsoleResult<ChatSession>> {
    const session = this.#make(
      target,
      Date.now(),
      options?.resident === true,
      options?.work === true ? (options.workflow ?? null) : undefined,
    )
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
    const activity = this.#activity.get(sessionId)
    return Promise.resolve(
      ok({
        session,
        turns: [...(this.#turns.get(sessionId) ?? [])],
        ...(activity === undefined ? {} : { activity }),
      }),
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
    // A work session (P37.17 B): its todo list moves, and a file is handed
    // over before the answer.
    if (this.#sessions.get(input.sessionId)?.work === true) {
      const items = ['读资料', '写初稿', '交付'].map(content => ({
        phase: '',
        content,
        status: 'pending' as const,
      }))
      ;[0, 1, 2].forEach(done => {
        later(2_000 + done * 1_500, () => {
          this.#activity.set(input.sessionId, {
            progress: {
              taskId: `task${sent}`,
              at: Date.now(),
              total: 3,
              done,
              step: done + 1,
              current: items[done]?.content ?? null,
              items: items.map((item, index) => ({
                ...item,
                status:
                  index < done
                    ? 'completed'
                    : index === done
                      ? 'in_progress'
                      : 'pending',
              })),
            },
            context: null,
          })
        })
      })
      later(6_000, () => {
        const file = delivered('初稿.docx', 'document', 24_576)
        turns.push({
          id: `f${Date.now()}`,
          sessionId: input.sessionId,
          author: 'agent',
          at: Date.now(),
          text: '交付了 1 个文件',
          state: 'done',
          variant: 'notice',
          noticeSource: 'files',
          severity: 'info',
          files: [file],
        })
        this.outputs.set(input.sessionId, [
          {
            name: file.name,
            size: file.size,
            kind: file.kind,
            mime: file.mime,
            mtime: Date.now(),
            preview: true,
          },
        ])
      })
    }
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
