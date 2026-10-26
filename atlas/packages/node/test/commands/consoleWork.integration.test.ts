// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P37.17 B end to end (`docs/dev/work-tasks.md` §8): a real `qm console`
 * hub, a real `qm resident` node behind a signed control link, a qianmopi
 * child and a loopback model fixture. Open a work session with the slides
 * workflow → the line reaching the model names `qmo-slides`, which the
 * node's qianmopi discovered in the shipped plugin and lists in its system
 * prompt → the agent reads the skill and its reference by name through
 * `skill://`, keeps a todo list, makes a deck and delivers it → the
 * transcript has the file card and the activity → the hub lists the output,
 * serves a script-free preview and a download that opens in a reader
 * library.
 *
 * Everything lives under one temporary root: HOME, both config roots and
 * the agent workspace. Nothing here starts a real local agent or dials out.
 */

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Markit } from '@oh-my-pi/pi-coding-agent/markit'
import { ZipPackage } from '@oh-my-pi/pi-utils/ar'
import type { ChatTranscript, WorkOutput } from '@qianmo/console'
import { ompChildEnv } from '@qianmo/paths'
import { startRegistryServer } from '@qianmo/registry'
import {
  freePort,
  INHERITED_KEYS_TO_DROP,
} from '../../../../tests/integration/fixtures/handoff-processes.js'
import { transportPskEnvVarForNode } from '../../src/commands/consoleArgs.js'

const PHASE_TIMEOUT_MS = 90_000
const FILE_TIMEOUT_MS = 4 * PHASE_TIMEOUT_MS
const MARKER = 'E2E-WORK-第三季度'
const DECK = {
  title: '第三季度经营汇报',
  theme: 'ocean',
  slides: [
    { layout: 'title', title: '第三季度经营汇报', subtitle: '2026 年 7–9 月' },
    {
      layout: 'bullets',
      title: '三件事',
      bullets: ['收入同比增长 **12%**', '新增客户 340 家', '毛利率 41%'],
    },
    {
      layout: 'chart',
      title: '月度收入（万元）',
      chart: {
        type: 'bar',
        categories: ['7 月', '8 月', '9 月'],
        series: [{ name: '收入', values: [120, 135, 150] }],
      },
    },
    { layout: 'closing', title: '谢谢' },
  ],
}

type ModelMessage = { role: string; content: unknown; tool_calls?: unknown }

/** What the agent does, one step per tool result already in the request. */
const SCRIPT: readonly { name: string; input: Record<string, unknown> }[] = [
  { name: 'read', input: { path: 'skill://qmo-slides' } },
  { name: 'read', input: { path: 'skill://qmo-slides/reference.md' } },
  {
    name: 'todo',
    input: {
      op: 'init',
      list: [{ phase: '制作', items: ['读参考', '生成演示文稿', '交付'] }],
    },
  },
  {
    name: 'qianmo_make_document',
    input: { kind: 'slides', file: '季度汇报.pptx', spec: DECK },
  },
  {
    name: 'qianmo_deliver_files',
    input: { files: [{ name: '季度汇报.pptx', title: '季度汇报' }] },
  },
  { name: 'todo', input: { op: 'done', phase: '制作' } },
]
const REPLY = '做好了：季度汇报.pptx 已经交给你。'
const WORKFLOW_SKILLS = [
  'qmo-slides',
  'qmo-document',
  'qmo-sheet',
  'qmo-research',
  'qmo-webpage',
  'qmo-analysis',
]

function textOf(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}\n${logs()}`)
    await Bun.sleep(50)
  }
}

test(
  'open work → slides → file card → preview → download opens, over a real hub and node',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-work-e2e-'))
    const home = path.join(root, 'home')
    const nodeRoot = path.join(root, 'node-config')
    const hubRoot = path.join(root, 'hub-config')
    const workspace = path.join(root, 'workspace')
    for (const dir of [home, nodeRoot, hubRoot, workspace])
      fs.mkdirSync(dir, { recursive: true })
    const psk = 'work-integration-fixture-psk-0000000000'
    const admin = 'work-e2e-admin-token-000000000000000'
    const entry = path.resolve(import.meta.dir, '../../src/cli.ts')
    const children: Bun.Subprocess[] = []
    const streams: { name: string; text: string }[] = []
    const registry = startRegistryServer(0)
    const workRequests: ModelMessage[][] = []
    const model = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'POST') return new Response('fixture ready')
        const body = (await request.json()) as { messages?: ModelMessage[] }
        const messages = body.messages ?? []
        const work = messages.some(
          message =>
            message.role === 'user' && textOf(message.content).includes(MARKER),
        )
        let delta: Record<string, unknown> = {
          role: 'assistant',
          content: 'pong',
        }
        if (work) {
          workRequests.push(messages)
          const step = messages.filter(
            message => message.role === 'tool',
          ).length
          const call = SCRIPT[step]
          delta =
            call === undefined
              ? { role: 'assistant', content: REPLY }
              : {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${step}`,
                      type: 'function',
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input),
                      },
                    },
                  ],
                }
        }
        const base = {
          id: 'work-model-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake-model',
        }
        const chunks = [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop',
              },
            ],
          },
          {
            ...base,
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        ]
        return new Response(
          `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    function env(config: string): Record<string, string> {
      const environment = ompChildEnv({
        ...process.env,
        HOME: home,
        QIANMO_CONFIG_DIR: config,
        NODE_ENV: 'production',
        NO_COLOR: '1',
        QIANMO_TRANSPORT_PSK: psk,
        [transportPskEnvVarForNode('node-b', '--chat-url')]: psk,
      }) as Record<string, string>
      for (const key of [
        ...INHERITED_KEYS_TO_DROP.filter(key => key !== 'QIANMO_CONFIG_DIR'),
        'QIANMO_API_KEY',
        'QIANMO_API_BASE_URL',
        'QIANMO_OMP_ENTRY',
      ])
        delete environment[key]
      return environment
    }
    async function run(args: string[], config: string): Promise<string> {
      const child = Bun.spawn([process.execPath, 'run', entry, ...args], {
        cwd: root,
        env: env(config),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(`qm ${args[0]} exited ${code}: ${err}`)
      return out.trim()
    }
    function start(name: string, args: string[], config: string) {
      const child = Bun.spawn([process.execPath, 'run', entry, ...args], {
        cwd: workspace,
        env: env(config),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      children.push(child)
      for (const [stream, label] of [
        [child.stdout, 'stdout'],
        [child.stderr, 'stderr'],
      ] as const) {
        const record = { name: `${name} ${label}`, text: '' }
        streams.push(record)
        void (async () => {
          const decoder = new TextDecoder()
          for await (const chunk of stream as ReadableStream<Uint8Array>)
            record.text += decoder.decode(chunk, { stream: true })
        })()
      }
      return child
    }
    const logs = () =>
      streams.map(s => `--- ${s.name} ---\n${s.text.slice(-4000)}`).join('\n')
    try {
      const ompState = path.join(nodeRoot, 'omp', 'agent')
      fs.mkdirSync(ompState, { recursive: true })
      fs.writeFileSync(
        path.join(ompState, 'models.yml'),
        `providers:\n  fake:\n    baseUrl: http://127.0.0.1:${model.port}/v1\n    api: openai-completions\n    apiKey: test-no-secret\n    models:\n      - id: fake-model\n        name: Fake\n        contextWindow: 65536\n        maxTokens: 4096\n`,
      )
      fs.writeFileSync(
        path.join(ompState, 'config.yml'),
        'modelRoles:\n  default: fake/fake-model\ndefaultThinkingLevel: off\nproviders:\n  cacheWarming: off\nretry:\n  enabled: false\n  fallbackChains: {}\n',
      )
      // The two identities: the hub's signing key, the node's own key.
      const hubKey = await run(['console', '--print-wake-identity'], hubRoot)
      expect(hubKey).toMatch(/^console=\S+$/)
      const nodeKey = await run(
        [
          'resident-wake',
          '--print-identity',
          '--from',
          'qianmo://node-b/writer',
        ],
        nodeRoot,
      )
      expect(nodeKey).toMatch(/^node-b=\S+$/)

      const nodePort = await freePort()
      const timings = path.join(root, 'timings.ndjson')
      const resident = start(
        'resident',
        [
          'resident',
          '--node',
          'node-b',
          '--team',
          'nest',
          '--agent',
          `writer=${workspace}`,
          '--hostname',
          '127.0.0.1',
          '--port',
          String(nodePort),
          '--controller',
          hubKey,
          '--trust',
          hubKey,
          '--require-signed-tasks',
          '--timings',
          timings,
        ],
        nodeRoot,
      )
      await until(
        'the node to be ready',
        () =>
          resident.exitCode !== null ||
          (fs.existsSync(timings) &&
            fs.readFileSync(timings, 'utf8').includes('runtime_ready')),
        logs,
      )
      expect(resident.exitCode).toBeNull()
      // The six skills are on the node's disk before any child starts.
      const skills = path.join(nodeRoot, 'qianmo', 'work-skills')
      expect(fs.readdirSync(path.join(skills, 'skills')).sort()).toEqual([
        'qmo-analysis',
        'qmo-document',
        'qmo-research',
        'qmo-sheet',
        'qmo-slides',
        'qmo-webpage',
      ])
      const registered = await fetch(`${registry.url}/v0/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: 'qianmo://node-b/writer',
          endpoint: `ws://127.0.0.1:${nodePort}`,
          capabilities: [],
        }),
      })
      expect(registered.ok).toBe(true)

      fs.writeFileSync(path.join(root, 'admin.token'), admin, { mode: 0o600 })
      fs.writeFileSync(
        path.join(root, 'view.token'),
        'work-e2e-view-token-0000000000000000',
        { mode: 0o600 },
      )
      const hubPort = await freePort()
      const link = `node-b=ws://127.0.0.1:${nodePort}`
      const hub = start(
        'console',
        [
          'console',
          '--port',
          String(hubPort),
          '--registry',
          registry.url,
          '--chat-url',
          link,
          '--control',
          link,
          '--trust',
          nodeKey,
          '--chat-sign',
          '--admin-token-file',
          path.join(root, 'admin.token'),
          '--view-token-file',
          path.join(root, 'view.token'),
        ],
        hubRoot,
      )
      const url = `http://127.0.0.1:${hubPort}`
      const headers = {
        authorization: `Bearer ${admin}`,
        'x-qianmo-console': '1',
      }
      const api = (route: string, init: RequestInit = {}) =>
        fetch(`${url}${route}`, {
          ...init,
          headers: { ...headers, ...(init.headers ?? {}) },
        })
      await until(
        'the hub to list the agent as dialable',
        async () => {
          if (hub.exitCode !== null) return true
          try {
            const answer = await api('/v0/chat/targets')
            if (answer.status !== 200) return false
            const body = (await answer.json()) as {
              targets?: { address: string; dialable: boolean }[]
            }
            return (
              body.targets?.some(
                t => t.address === 'qianmo://node-b/writer' && t.dialable,
              ) ?? false
            )
          } catch {
            return false
          }
        },
        logs,
      )
      expect(hub.exitCode).toBeNull()

      // Workflows, then open the work session with its first line.
      const workflows = (await (await api('/v0/work/workflows')).json()) as {
        workflows: { id: string; skill: string }[]
      }
      expect(workflows.workflows.map(w => w.id)).toEqual([
        'slides',
        'document',
        'sheet',
        'research',
        'webpage',
        'analysis',
      ])
      const opened = await api('/v0/work/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: 'qianmo://node-b/writer',
          workflow: 'slides',
          text: `做一份季度汇报 ${MARKER}`,
        }),
      })
      expect(opened.status).toBe(200)
      const { session, turn } = (await opened.json()) as {
        session: { id: string; work?: true; workflow?: string; target: string }
        turn: { text: string; workflow?: string } | null
      }
      expect(session.work).toBe(true)
      expect(session.workflow).toBe('slides')
      expect(session.target).toBe('qianmo://node-b/writer')
      expect(turn?.text).toBe(`做一份季度汇报 ${MARKER}`)
      expect(turn?.workflow).toBe('slides')
      const id = encodeURIComponent(session.id)

      let transcript: ChatTranscript | undefined
      await until(
        'the agent’s reply after the file card',
        async () => {
          const answer = await api(`/v0/chat/sessions/${id}`)
          if (answer.status !== 200) return false
          transcript = (await answer.json()) as ChatTranscript
          return transcript.turns.some(
            t => t.author === 'agent' && t.text === REPLY,
          )
        },
        logs,
      )
      const turns = transcript!.turns
      // The operator line keeps what the person typed.
      expect(turns[0]).toMatchObject({
        author: 'operator',
        text: `做一份季度汇报 ${MARKER}`,
        workflow: 'slides',
      })
      const card = turns.find(t => t.noticeSource === 'files')
      expect(card).toMatchObject({
        variant: 'notice',
        author: 'agent',
        severity: 'info',
      })
      expect(card!.files).toHaveLength(1)
      expect(card!.files![0]).toMatchObject({
        name: '季度汇报.pptx',
        kind: 'presentation',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        preview: true,
        title: '季度汇报',
      })
      // The card came before the reply, and the reply is the turn’s end.
      expect(turns.indexOf(card!)).toBeLessThan(
        turns.findIndex(t => t.author === 'agent' && t.text === REPLY),
      )

      // On the node: qianmopi discovered the six skills in the shipped
      // plugin and lists them to the model; the line names the workflow's.
      const first = workRequests[0]!
      const system = first
        .filter(m => m.role === 'system' || m.role === 'developer')
        .map(m => textOf(m.content))
        .join('\n')
      for (const skill of WORKFLOW_SKILLS) expect(system).toContain(skill)
      const asked = first
        .filter(message => message.role === 'user')
        .map(message => textOf(message.content))
        .join('\n')
      expect(asked).toContain(
        '[工作流 qmo-slides] 先读 skill://qmo-slides，按里面的步骤做。',
      )
      // The skill and its reference, read by name through skill:// (omp's
      // own skill directory; the readable root lets the guard pass it).
      const results = workRequests
        .at(-1)!
        .filter(message => message.role === 'tool')
        .map(message => textOf(message.content))
      expect(results).toHaveLength(SCRIPT.length)
      expect(results[0]).toContain('演示文稿工作流')
      expect(results[1]).toContain('的描述格式')
      expect(results[3]).toContain('季度汇报.pptx')
      expect(results[4]).not.toContain('rror')

      // Activity: progress from the todo list, context from the turn.
      await until(
        'the activity of the turn',
        async () => {
          const answer = await api(`/v0/work/sessions/${id}/activity`)
          const body = (await answer.json()) as {
            context: { tools: { name: string }[] } | null
          }
          return (
            body.context?.tools.some(t => t.name === 'qianmo_deliver_files') ??
            false
          )
        },
        logs,
      )
      const activity = (await (
        await api(`/v0/work/sessions/${id}/activity`)
      ).json()) as {
        work: boolean
        workflow: string
        progress: {
          total: number
          done: number
          items: { content: string }[]
        } | null
        context: {
          workflows: string[]
          skills: string[]
          tools: { name: string; count: number }[]
        } | null
        delivered: { name: string }[]
      }
      expect(activity.work).toBe(true)
      expect(activity.workflow).toBe('slides')
      expect(activity.progress?.items.map(item => item.content)).toEqual([
        '读参考',
        '生成演示文稿',
        '交付',
      ])
      expect(activity.progress?.total).toBe(3)
      expect(activity.progress?.done).toBe(3)
      expect(activity.context?.workflows).toEqual(['slides'])
      expect(activity.context?.skills).toEqual(['qmo-slides'])
      expect(activity.context?.tools).toEqual([
        { name: 'read', count: 2 },
        { name: 'todo', count: 2 },
        { name: 'qianmo_make_document', count: 1 },
        { name: 'qianmo_deliver_files', count: 1 },
      ])
      expect(activity.delivered.map(file => file.name)).toEqual([
        '季度汇报.pptx',
      ])

      // Outputs, listed live from the node over the control link.
      const listed = (await (
        await api(`/v0/work/sessions/${id}/outputs`)
      ).json()) as { files: WorkOutput[]; truncated: boolean }
      expect(listed.truncated).toBe(false)
      expect(
        listed.files.map(file => [file.name, file.kind, file.preview]),
      ).toEqual([['季度汇报.pptx', 'presentation', true]])
      const name = encodeURIComponent('季度汇报.pptx')

      // Preview: no script, sandboxed, every slide's words.
      const preview = await api(`/v0/work/sessions/${id}/preview?name=${name}`)
      expect(preview.status).toBe(200)
      expect(preview.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      )
      const csp = preview.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("script-src 'none'")
      expect(csp).toContain('sandbox')
      expect(preview.headers.get('content-disposition')).toBe('inline')
      const html = await preview.text()
      expect(html).not.toMatch(/<script/i)
      for (const words of [
        '第三季度经营汇报',
        '新增客户 340 家',
        '月度收入',
        '谢谢',
      ])
        expect(html).toContain(words)

      // Download: the bytes the node wrote, and they open as a deck.
      const download = await api(`/v0/work/sessions/${id}/file?name=${name}`)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-disposition')).toContain(
        "filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%B1%87%E6%8A%A5.pptx",
      )
      expect(download.headers.get('cache-control')).toContain('no-store')
      const bytes = new Uint8Array(await download.arrayBuffer())
      // Bun's server answers a streamed body chunked and drops the
      // content-length the route sets; the size the page has is the card's.
      expect(bytes.byteLength).toBe(card!.files![0]!.size)
      const onDisk = fs.readFileSync(
        path.join(
          workspace,
          'qmo-work',
          session.id,
          'outputs',
          '季度汇报.pptx',
        ),
      )
      expect(Buffer.from(bytes).equals(onDisk)).toBe(true)
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(
        card!.files![0]!.sha256,
      )
      const zip = await ZipPackage.open(bytes)
      expect(await zip.readBytes('ppt/slides/slide4.xml')).toBeDefined()
      const read = await new Markit().convert(Buffer.from(bytes), {
        extension: '.pptx',
        filename: '季度汇报.pptx',
      })
      for (const words of [
        '第三季度经营汇报',
        '收入同比增长',
        '新增客户 340 家',
        '谢谢',
      ])
        expect(read.markdown).toContain(words)

      // Optional record of the run, for review outside the test.
      const evidence = process.env.WORK_E2E_EVIDENCE
      if (evidence !== undefined && path.isAbsolute(evidence)) {
        fs.mkdirSync(evidence, { recursive: true })
        const headersOf = (answer: Response) =>
          [...answer.headers].map(([k, v]) => `${k}: ${v}`).join('\n')
        fs.writeFileSync(path.join(evidence, '季度汇报.pptx'), bytes)
        fs.writeFileSync(path.join(evidence, 'preview.html'), html)
        fs.writeFileSync(path.join(evidence, 'reader.md'), read.markdown)
        fs.writeFileSync(
          path.join(evidence, 'run.json'),
          JSON.stringify(
            {
              session,
              turns,
              activity,
              outputs: listed,
              previewHeaders: headersOf(preview),
              downloadHeaders: headersOf(download),
              modelSteps: workRequests.length,
            },
            null,
            2,
          ),
        )
      }

      // A name outside the outputs folder never reaches the node.
      const escape = await api(
        `/v0/work/sessions/${id}/file?name=${encodeURIComponent('../sources/季度汇报.pptx.json')}`,
      )
      expect(escape.status).toBe(400)
    } finally {
      for (const child of children) child.kill('SIGTERM')
      const killer = setTimeout(() => {
        for (const child of children) child.kill('SIGKILL')
      }, 5000)
      await Promise.all(children.map(child => child.exited))
      clearTimeout(killer)
      await registry.stop()
      model.stop(true)
      const printed = streams.map(s => s.text).join('\n')
      fs.rmSync(root, { recursive: true, force: true })
      expect(printed).not.toContain(psk)
      expect(printed).not.toContain(admin)
    }
  },
  FILE_TIMEOUT_MS,
)
