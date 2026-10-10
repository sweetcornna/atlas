// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** AC-4: memory injection and citation validation through the public omp adapter.
 * Default loopback tests exercise real HTTP serialization/deserialization with
 * scripted replies; they prove the citation contract, not model recall quality.
 * Opt in with QIANMO_PROVIDER_LIVE=1, OPENAI_API_KEY and OPENAI_BASE_URL to run the
 * same five decisions and three negative cases against both configured models.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { complete, type Tool } from '@oh-my-pi/pi-ai'
import { buildModel } from '@oh-my-pi/pi-catalog/build'
import { FileMemoryStore, type MemoryEntry } from '@qianmo/memory'
import {
  buildRecallSystemPrompt,
  handleMemoryAnswer,
  MEMORY_ANSWER_TOOL,
  MEMORY_ANSWER_TOOL_NAME,
  recall,
} from '@qianmo/recall'

type Decision = {
  readonly key: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly tags: readonly string[]
  /** 提问**刻意不复用条目用词**——纯确定性检索正是在这里失手的。 */
  readonly question: string
  /** 回答里必须出现的实质内容（大小写不敏感）。 */
  readonly mustMention: readonly string[]
}

const DECISIONS: readonly Decision[] = [
  {
    key: 'runtime',
    title: '统一用 Bun 作为运行时与测试器',
    summary: '本项目统一用 Bun 跑代码与跑测试，不引入 npm / pnpm',
    body: '理由：本地与 CI 行为一致，workspace 内部包自动链接。相关命令是 bun install / bun test。',
    tags: ['toolchain'],
    question: '装依赖和跑单测该用哪个包管理工具？给出结论。',
    mustMention: ['bun'],
  },
  {
    key: 'protocol',
    title: '跨节点消息走自研协议，概念对齐 A2A',
    summary: '协议自研，不直接采用现成协议栈；链路标识采用 W3C traceparent',
    body: '不把外部协议栈整包引入；只在概念层面对齐 A2A。',
    tags: ['protocol'],
    question: '节点之间通信是拿现成的框架，还是我们自己写的？',
    mustMention: ['自研'],
  },
  {
    key: 'sandbox',
    title: '沙箱定为 Dormice + gVisor，omp 跑在沙箱内',
    summary: '隔离环境选 Dormice 搭配 gVisor，编程智能体进程运行在沙箱内部',
    body: '架构上钉死「omp 跑在沙箱内」，不是沙箱跑在 omp 里。',
    tags: ['sandbox'],
    question: '智能体的隔离环境最后是怎么定的？',
    mustMention: ['dormice'],
  },
  {
    key: 'capability',
    title: 'capability 用每节点 Ed25519 签发，PSK 只做接入门禁',
    summary: '授权凭证由每个节点用 Ed25519 私钥签发；预共享密钥只用于接入门禁',
    body: '纯对称密钥无法阻止持有者伪造任意节点的令牌，因此授权面必须是签名的。',
    tags: ['security'],
    question: '授权凭证到底是对称密钥，还是签名的？',
    mustMention: ['ed25519'],
  },
  {
    key: 'memory',
    title: 'M0 不做向量检索，只做确定性检索',
    summary: '记忆召回在 M0 只做结构化条目 + 标签 + 关键词 + 时间衰减',
    body: '向量检索的召回质量不可控，放到 M1 与治理机制一起做。',
    tags: ['memory'],
    question: '记忆召回这一块要不要上 embedding？',
    mustMention: ['向量'],
  },
]

/**
 * 三条**从未写入**的伪造决策。
 *
 * 三个话题与那五条条目正交（前端框架 / 日志后端 / 数据库），提问却都带着
 * 「把那条决策的来源 ID 给我」这类**索要引用的压力**——这是幻觉引用最容易
 * 出现的形状。任何一条引用被接受都是失败。
 */
const FABRICATED: readonly { key: string; question: string }[] = [
  {
    key: 'vue',
    question: '前端 UI 框架是不是定了用 Vue？把那条决策的来源 ID 给我。',
  },
  {
    key: 'elasticsearch',
    question: '日志统一发到 Elasticsearch 是哪条决策定的？引用它。',
  },
  {
    key: 'postgres',
    question: '数据库选型定的是 PostgreSQL 吧？给出对应记忆条目的 ID。',
  },
]

const PROJECT_KEY = 'atlas'

type MemoryFixture = {
  readonly store: FileMemoryStore
  readonly byKey: ReadonlyMap<string, MemoryEntry>
  dispose(): void
}

/**
 * 真磁盘上的一座记忆库，五条决策各写一条 project 层条目。
 *
 * 根目录是临时目录：`defaultMemoryRoot()` 指向开发者自己节点的记忆，测试永远
 * 不碰它。
 */
function writeFiveDecisions(): MemoryFixture {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-ac4-'))
  const store = new FileMemoryStore({ root: join(directory, 'memory') })
  const byKey = new Map<string, MemoryEntry>()
  for (const decision of DECISIONS) {
    byKey.set(
      decision.key,
      store.write({
        scope: { layer: 'project', projectKey: PROJECT_KEY },
        title: decision.title,
        summary: decision.summary,
        body: decision.body,
        tags: decision.tags,
        source: { kind: 'session', id: `ac4-${decision.key}` },
      }),
    )
  }
  return {
    store,
    byKey,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

type Provider = { id: string; defaultModel: string; baseUrl: string }
const providers: Provider[] = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/qianmo-providers.json'), 'utf8'),
)
const memoryTool: Tool = {
  name: MEMORY_ANSWER_TOOL.name,
  description: MEMORY_ANSWER_TOOL.description,
  parameters: {
    ...MEMORY_ANSWER_TOOL.inputSchema,
    properties: { ...MEMORY_ANSWER_TOOL.inputSchema.properties },
    required: [...MEMORY_ANSWER_TOOL.inputSchema.required],
  },
}
async function ask(
  provider: Provider,
  system: readonly string[],
  question: string,
  baseUrl: string,
  apiKey: string,
) {
  const model = buildModel({
    id: provider.defaultModel,
    name: provider.id,
    provider: provider.id,
    api: 'openai-completions',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
    maxTokens: 4096,
  })
  const response = await complete(
    model,
    {
      systemPrompt: [...system],
      messages: [{ role: 'user', content: question, timestamp: Date.now() }],
      tools: [memoryTool],
    },
    {
      apiKey,
      maxTokens: 4096,
      toolChoice: { type: 'function', name: MEMORY_ANSWER_TOOL_NAME },
      signal: AbortSignal.timeout(120_000),
    },
  )
  const call = response.content.find(
    block =>
      block.type === 'toolCall' && block.name === MEMORY_ANSWER_TOOL_NAME,
  )
  if (!call || call.type !== 'toolCall')
    throw new Error(
      `missing memory answer: ${response.stopReason} ${response.errorMessage ?? ''}`,
    )
  return call.arguments
}

function suite(live: boolean) {
  let fixture: MemoryFixture
  let server: ReturnType<typeof Bun.serve>
  let reply: { answer: string; citations: string[] }
  const requests: Record<string, unknown>[] = []
  beforeAll(() => {
    fixture = writeFiveDecisions()
    if (!live)
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async request => {
          requests.push((await request.json()) as Record<string, unknown>)
          const common = {
            id: 'ac4',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fixture',
          }
          const chunks = [
            {
              ...common,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'answer',
                        type: 'function',
                        function: {
                          name: MEMORY_ANSWER_TOOL_NAME,
                          arguments: JSON.stringify(reply),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              ...common,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ]
          return new Response(
            chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      })
  })
  afterAll(async () => {
    await server?.stop(true)
    fixture.dispose()
  })
  for (const provider of providers) {
    for (const decision of DECISIONS)
      test(`${provider.id}: new session cites ${decision.key} ID and timestamp`, async () => {
        const expected = fixture.byKey.get(decision.key)!
        const recalled = recall(fixture.store, {
          question: decision.question,
          scope: { layers: ['project'], projectKey: PROJECT_KEY },
        })
        expect(recalled.mode).toBe('full')
        expect(recalled.degraded).toBe(false)
        reply = {
          answer: `${decision.summary} ${decision.body}`,
          citations: [expected.id],
        }
        const args = await ask(
          provider,
          buildRecallSystemPrompt(recalled),
          decision.question,
          live
            ? process.env.OPENAI_BASE_URL!
            : `http://127.0.0.1:${server.port}/v1`,
          live ? process.env.OPENAI_API_KEY! : 'local-no-secret',
        )
        const answered = handleMemoryAnswer(fixture.store, recalled, args, {
          requireCitation: true,
        })
        expect(answered.ok).toBe(true)
        expect(answered.report.problems).toEqual([])
        expect(answered.report.accepted.map(entry => entry.id)).toContain(
          expected.id,
        )
        expect(answered.answer).toContain(expected.id)
        expect(answered.answer).toContain(expected.createdAt)
        for (const needle of decision.mustMention)
          expect(answered.args.answer.toLowerCase()).toContain(
            needle.toLowerCase(),
          )
        if (!live) {
          const wire = requests.at(-1)!
          const messages = wire.messages as { role: string; content: string }[]
          expect(
            messages.filter(message => message.role === 'user'),
          ).toHaveLength(1)
          expect(messages.some(message => message.role === 'assistant')).toBe(
            false,
          )
          const system = messages
            .filter(message => message.role !== 'user')
            .map(message => message.content)
            .join('\n')
          for (const entry of fixture.byKey.values()) {
            expect(system).toContain(entry.id)
            expect(system).toContain(entry.createdAt)
          }
        }
      }, 130_000)
    for (const fake of FABRICATED)
      test(`${provider.id}: rejects fabricated ${fake.key} citation`, async () => {
        const recalled = recall(fixture.store, {
          question: fake.question,
          scope: { layers: ['project'], projectKey: PROJECT_KEY },
        })
        reply = {
          answer: 'This source does not exist.',
          citations: [`fabricated-${fake.key}`],
        }
        const args = await ask(
          provider,
          buildRecallSystemPrompt(recalled),
          fake.question,
          live
            ? process.env.OPENAI_BASE_URL!
            : `http://127.0.0.1:${server.port}/v1`,
          live ? process.env.OPENAI_API_KEY! : 'local-no-secret',
        )
        const answered = handleMemoryAnswer(fixture.store, recalled, args)
        expect(answered.report.accepted).toEqual([])
        expect(answered.answer).not.toContain('来源 / sources')
        if (!live) {
          expect(answered.ok).toBe(false)
          expect(answered.report.problems.length).toBeGreaterThan(0)
        }
      }, 130_000)
  }
  if (!live)
    test('both configurations emit the same provider-neutral citation tool schema', () => {
      expect(providers).toHaveLength(2)
      expect(requests).toHaveLength(16)
      expect(requests[0]?.tools).toEqual(requests[8]?.tools)
      for (const wire of requests) {
        expect(JSON.stringify(wire.tools)).toContain(MEMORY_ANSWER_TOOL_NAME)
        expect(JSON.stringify(wire)).not.toMatch(
          /search_result|citations_enabled/,
        )
        expect(wire.citations).toBeUndefined()
        expect(wire.response_format).toBeUndefined()
      }
    })
}
describe('AC-4 local omp adapter and citation contract (scripted model)', () =>
  suite(false))
const live =
  process.env.QIANMO_PROVIDER_LIVE === '1' &&
  !!process.env.OPENAI_API_KEY &&
  !!process.env.OPENAI_BASE_URL
describe.skipIf(!live)('AC-4 two live models: recall quality', () =>
  suite(true),
)
test('revoked entries are absent from fresh recall injection', () => {
  const fixture = writeFiveDecisions()
  try {
    const revoked = fixture.byKey.get('runtime')!
    fixture.store.revoke(revoked.id, { reason: 'test', by: 'ac4' })
    const recalled = recall(fixture.store, {
      scope: { layers: ['project'], projectKey: PROJECT_KEY },
    })
    const block = buildRecallSystemPrompt(recalled).join('\n')
    expect(recalled.entries).toHaveLength(4)
    expect(block).not.toContain(revoked.id)
    for (const entry of fixture.byKey.values())
      if (entry.id !== revoked.id) {
        expect(block).toContain(entry.id)
        expect(block).toContain(entry.createdAt)
      }
  } finally {
    fixture.dispose()
  }
})
