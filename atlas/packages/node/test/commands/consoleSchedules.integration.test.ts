// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Real qm console + resident + omp RPC, with a loopback model fixture.
 * The API head is deliberately not attached here (the page owner does that).
 * runNow exercises the real host/chat port first; console startup then recovers
 * the same book and dispatches its due interval without recalculating it.
 */
import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { startRegistryServer } from '@qianmo/registry'
import type { ConsoleResult, ScheduleRunView } from '@qianmo/console'
import { ompChildEnv } from '@qianmo/paths'
import { createRegistryPort } from '../../src/commands/consolePorts.js'
import {
  createConsoleChatPort,
  type ConsoleChatHub,
} from '../../src/commands/consoleChat.js'
import { ConsoleSchedules } from '../../src/commands/consoleSchedules.js'
import { transportPskEnvVarForNode } from '../../src/commands/consoleArgs.js'
import { freePort } from '../../../../tests/integration/fixtures/handoff-processes.js'

function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

const PHASE_TIMEOUT_MS = 60_000
// Boot, manual reply, recovered console reply, then bounded process cleanup.
const FILE_TIMEOUT_MS = 3 * PHASE_TIMEOUT_MS + 5000

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('real schedules integration timed out')
    await Bun.sleep(20)
  }
}

test(
  'real resident replies reach both manual host runs and a qm console recovered due schedule',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-processes-'))
    const nodeRoot = path.join(root, 'node-config')
    const hubRoot = path.join(root, 'hub-config')
    const workspace = path.join(root, 'workspace')
    const state = path.join(hubRoot, 'qianmo', 'console', 'schedules')
    const psk = 'schedules-integration-fixture-psk-000000'
    const target = 'qianmo://node-b/reviewer'
    const entry = path.resolve(import.meta.dir, '../../src/cli.ts')
    const children: Bun.Subprocess[] = []
    const outputs: Promise<string>[] = []
    const registry = startRegistryServer(0)
    const modelInputs: { messages?: { role: string; content: unknown }[] }[] =
      []
    const model = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'POST') return new Response('fixture ready')
        modelInputs.push(
          (await request.json()) as {
            messages?: { role: string; content: unknown }[]
          },
        )
        const base = {
          id: 'schedule-model-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake-model',
        }
        const chunks = [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: '真实回复正文：今天最重要的三件事',
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
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
    let chat: ConsoleChatHub | undefined
    let schedules: ConsoleSchedules | undefined
    function env(config: string) {
      const environment = ompChildEnv({
        ...process.env,
        QIANMO_CONFIG_DIR: config,
        NODE_ENV: 'production',
        NO_COLOR: '1',
        QIANMO_TRANSPORT_PSK: psk,
        [transportPskEnvVarForNode('node-b', '--chat-url')]: psk,
      })
      for (const key of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'QIANMO_API_KEY',
        'QIANMO_API_BASE_URL',
        'QIANMO_OMP_ENTRY',
      ])
        delete environment[key]
      return environment
    }
    function start(args: string[], config: string) {
      const child = Bun.spawn([process.execPath, 'run', entry, ...args], {
        cwd: workspace,
        env: env(config),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      children.push(child)
      outputs.push(
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      )
      return child
    }
    try {
      fs.mkdirSync(workspace, { recursive: true })
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
      const port = await freePort()
      const timings = path.join(root, 'timings.ndjson')
      const resident = start(
        [
          'resident',
          '--node',
          'node-b',
          '--team',
          'nest',
          '--agent',
          `reviewer=${workspace}`,
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
          '--open-policy',
          '--timings',
          timings,
        ],
        nodeRoot,
      )
      await until(
        () =>
          resident.exitCode !== null ||
          (fs.existsSync(timings) &&
            fs.readFileSync(timings, 'utf8').includes('runtime_ready')),
      )
      expect(resident.exitCode).toBeNull()
      const registered = await fetch(`${registry.url}/v0/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: target,
          endpoint: `ws://127.0.0.1:${port}`,
          capabilities: [],
        }),
      })
      expect(registered.ok).toBe(true)
      chat = createConsoleChatPort({
        from: 'qianmo://console/operator',
        registry: createRegistryPort({ baseUrl: registry.url }),
        endpoints: [{ node: 'node-b', url: `ws://127.0.0.1:${port}`, psk }],
        storePath: path.join(hubRoot, 'qianmo', 'console', 'chat.ndjson'),
      })
      let now = Date.now() - 15 * 60_000
      schedules = new ConsoleSchedules({
        directory: state,
        estopPath: path.join(root, 'ESTOP'),
        chat,
        now: () => now,
      })
      const actor = {
        subject: 'legacy:admin',
        role: null,
        requestId: 'integration-manual',
      } as const
      const saved = value(
        await schedules.save(
          {
            title: '进程简报',
            target,
            template: 'custom',
            prompt: '写一份今天的简报',
            when: { kind: 'interval', everyMinutes: 15 },
            timezone: 'Asia/Shanghai',
            direction: 'chat',
            channels: [],
            notifyOnlyAgent: false,
            enabled: true,
            timeoutMs: 600_000,
          },
          actor,
        ),
      )
      now = Date.now()
      const manual = value(await schedules.runNow(saved.id, actor))
      await until(async () =>
        value(await schedules!.snapshot()).runs.some(
          run => run.runId === manual.runId && run.outcome !== 'running',
        ),
      )
      const completed = value(await schedules.snapshot()).runs.find(
        run => run.runId === manual.runId,
      )!
      expect(completed.outcome).toBe('completed')
      expect(completed.excerpt).toBe('真实回复正文：今天最重要的三件事')
      expect(
        value(await chat.transcript(completed.sessionId!)).turns.some(
          turn => turn.author === 'agent' && turn.text === completed.excerpt,
        ),
      ).toBe(true)
      expect(value(await schedules.snapshot()).schedules[0]!.nextRunAt).toBe(
        saved.nextRunAt,
      )
      schedules.close()
      await chat.close()
      fs.writeFileSync(
        path.join(root, 'admin.token'),
        'schedules-fixture-admin-000000000000',
        { mode: 0o600 },
      )
      fs.writeFileSync(
        path.join(root, 'view.token'),
        'schedules-fixture-view-0000000000000',
        { mode: 0o600 },
      )
      const console = start(
        [
          'console',
          '--port',
          '0',
          '--registry',
          registry.url,
          '--chat-url',
          `node-b=ws://127.0.0.1:${port}`,
          '--schedules',
          '--admin-token-file',
          path.join(root, 'admin.token'),
          '--view-token-file',
          path.join(root, 'view.token'),
        ],
        hubRoot,
      )
      const runFile = path.join(state, 'runs.ndjson')
      await until(
        () =>
          console.exitCode !== null ||
          fs.readFileSync(runFile, 'utf8').trim().split('\n').length === 2,
      )
      expect(console.exitCode).toBeNull()
      const runs = fs
        .readFileSync(runFile, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as ScheduleRunView)
      expect(runs.map(run => run.trigger)).toEqual(['manual', 'schedule'])
      expect(
        runs.every(
          run =>
            run.outcome === 'completed' && run.excerpt === completed.excerpt,
        ),
      ).toBe(true)
      expect(runs[1]!.sessionId).toBe(completed.sessionId)
      expect(
        fs.readFileSync(
          path.join(hubRoot, 'qianmo', 'console', 'chat.ndjson'),
          'utf8',
        ),
      ).toContain(completed.excerpt!)
      // The resident also probes the provider at startup; count task prompts,
      // not every POST that happens to reach the model fixture.
      expect(
        modelInputs.filter(input =>
          input.messages?.some(
            message =>
              message.role === 'user' &&
              JSON.stringify(message.content).includes('写一份今天的简报'),
          ),
        ),
      ).toHaveLength(2)
    } finally {
      schedules?.close()
      await chat?.close()
      for (const child of children) child.kill('SIGTERM')
      const killer = setTimeout(() => {
        for (const child of children) child.kill('SIGKILL')
      }, 5000)
      await Promise.all(children.map(child => child.exited))
      clearTimeout(killer)
      const logs = await Promise.all(outputs)
      await registry.stop()
      model.stop(true)
      fs.rmSync(root, { recursive: true, force: true })
      expect(logs.join('\n')).not.toContain(psk)
    }
  },
  FILE_TIMEOUT_MS,
)
