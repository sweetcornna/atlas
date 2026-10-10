#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A real compiled resident in a workspace with no source tree or node_modules.
 * The local fake provider deliberately requests native read/write actions; the
 * production extension must allow ordinary writes and block its protected root.
 * No paid provider, inherited credential, or remote deployment is involved. */
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import {
  createMessage,
  MessageType,
  newId,
  isTaskResultPayload,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { createConsoleWakeIssuer } from '../packages/node/src/commands/consoleWakeIdentity.js'

export async function checkResidentCompiled(
  binary: string,
  afterTurn?: (pid: number, root: string) => Promise<void>,
  fixture: { probeDelayMs?: number; probeStatus?: 200 | 401 } = {},
): Promise<{ root: string; passed: true }> {
  if (
    !Number.isInteger(fixture.probeDelayMs ?? 0) ||
    (fixture.probeDelayMs ?? 0) < 0 ||
    (fixture.probeDelayMs ?? 0) > 5000
  )
    throw new Error('fixture probe delay must be 0..5000 milliseconds')
  const root = mkdtempSync(join(tmpdir(), 'qm-compiled-resident-'))
  const home = join(root, 'home'),
    config = join(root, 'config'),
    workspace = join(root, 'workspace'),
    protectedRoot = join(workspace, 'hub-secrets'),
    socket = join(root, 'resident.sock'),
    timings = join(root, 'timings.ndjson')
  for (const dir of [
    home,
    protectedRoot,
    join(config, 'omp', 'agent'),
    join(config, 'qianmo', 'identity'),
  ])
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  const canary = `private-canary-${crypto.randomUUID()}`
  writeFileSync(join(protectedRoot, 'secret.txt'), canary)
  const hostKeys = generateNodeKeyPair(),
    probeKeys = generateNodeKeyPair()
  writeFileSync(
    join(config, 'qianmo', 'identity', 'compiled-worker.json'),
    JSON.stringify({
      version: 1,
      node: 'compiled-worker',
      ...hostKeys,
      createdAt: Date.now(),
    }),
    { mode: 0o600 },
  )
  const steps = [
    { name: 'read', input: { path: join(protectedRoot, 'secret.txt') } },
    {
      name: 'write',
      input: { path: join(protectedRoot, 'changed.txt'), content: 'forbidden' },
    },
    {
      name: 'write',
      input: {
        path: join(workspace, 'allowed.txt'),
        content: 'compiled extension positive control',
      },
    },
  ]
  let step = 0
  const toolResults: string[] = []
  const probeResponses: Array<{ at: number; status: number }> = []
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return Response.json({ ok: true })
      const data = (await request.json()) as {
        messages?: { role: string; content: unknown }[]
      }
      const active = JSON.stringify(data.messages ?? []).includes(
        'Perform the scripted read/write checks',
      )
      const isProbe = JSON.stringify(data.messages ?? []).includes(
        'Reply with the single word OK.',
      )
      if (isProbe) {
        if (fixture.probeDelayMs) await Bun.sleep(fixture.probeDelayMs)
        const status = fixture.probeStatus ?? 200
        probeResponses.push({ at: Date.now(), status })
        if (status !== 200)
          return Response.json(
            {
              error: {
                type: 'authentication_error',
                message: 'fixture credential refusal',
              },
            },
            { status },
          )
      }
      const last = active ? data.messages?.at(-1) : undefined
      if (last?.role === 'tool')
        toolResults.push(
          typeof last.content === 'string'
            ? last.content
            : JSON.stringify(last.content),
        )
      const call = active ? steps[step++] : undefined
      const base = {
        id: `compiled-${step}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake-model',
      }
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call-${step}`,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'COMPILED_RESIDENT_COMPLETE' }
      return new Response(
        [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: call ? 'tool_calls' : 'stop',
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
          .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    },
  })
  writeFileSync(
    join(config, 'omp', 'agent', 'models.yml'),
    `providers:\n  fake:\n    baseUrl: http://127.0.0.1:${provider.port}/v1\n    api: openai-completions\n    apiKey: fake-not-secret\n    models:\n      - id: fake-model\n        name: Fake\n        contextWindow: 65536\n        maxTokens: 4096\n`,
  )
  writeFileSync(
    join(config, 'omp', 'agent', 'config.yml'),
    'modelRoles:\n  default: fake/fake-model\ndefaultThinkingLevel: off\nproviders:\n  cacheWarming: off\nretry:\n  enabled: false\n  fallbackChains: {}\n',
  )
  const psk = 'compiled-resident-fixture-not-production'
  const startupAt = Date.now(),
    startupMonotonic = performance.now()
  const child = Bun.spawn(
    [
      resolve(binary),
      'resident',
      '--node',
      'compiled-worker',
      '--team',
      'fixture',
      '--agent',
      `dev=${workspace}`,
      '--unix',
      socket,
      '--timings',
      timings,
      '--allow-workspace-edits',
      '--protected-root',
      protectedRoot,
      '--trust',
      `compiled-probe=${probeKeys.publicKey}`,
      '--require-signed-handshake',
      '--require-signed-tasks',
    ],
    {
      cwd: workspace,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        QIANMO_CONFIG_DIR: config,
        QIANMO_TRANSPORT_PSK: psk,
      },
      stdout: Bun.file(join(root, 'resident.stdout')),
      stderr: Bun.file(join(root, 'resident.stderr')),
    },
  )
  const taskId = newId(),
    to = 'qianmo://compiled-worker/dev'
  let task: ReturnType<typeof createMessage>
  let phase = 'readiness'
  let startupWaitMs: number | undefined
  let observedResult: unknown
  let acked = false,
    finish!: (value: unknown) => void
  const terminal = new Promise<unknown>(resolve => {
    finish = resolve
  })
  const client = new TransportClient({
    endpoint: { unix: socket },
    node: 'compiled-probe',
    peerNode: 'compiled-worker',
    psk,
    signing: {
      keys: probeKeys,
      directory: new StaticPublicKeyDirectory([
        ['compiled-worker', hostKeys.publicKey],
      ]),
      required: true,
    },
    keepAliveIntervalMs: 0,
    onMessage(message, context) {
      if (
        context.channel.authenticatedPeerNode !== 'compiled-worker' ||
        message.taskId !== taskId ||
        message.traceId !== task.traceId ||
        message.contextId !== task.contextId ||
        message.from !== task.to ||
        message.to !== task.from
      )
        throw new Error('compiled resident reply identity/correlation mismatch')
      if (message.type === MessageType.Ack) acked = true
      if (message.type === MessageType.TaskResult) finish(message.payload)
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const currentGeneration = (): number | undefined => {
    try {
      const record = JSON.parse(
        readFileSync(
          join(config, 'qianmo', 'provider', 'generation.json'),
          'utf8',
        ),
      ) as { generation?: number; startedAt?: string }
      return typeof record.startedAt === 'string' &&
        Date.parse(record.startedAt) >= startupAt
        ? record.generation
        : undefined
    } catch {
      return undefined
    }
  }
  // Keep the evidence deliberately smaller than the messages being tested:
  // no prompt, raw payload, tool text, credential, capability or canary value.
  const diagnosticSnapshot = (status: 'passed' | 'failed') => {
    const result = isTaskResultPayload(observedResult)
      ? observedResult
      : undefined
    return {
      version: 1,
      status,
      phase,
      at: Date.now(),
      readiness: {
        generation: currentGeneration() ?? null,
        startupWaitMs: startupWaitMs ?? null,
      },
      conditions: {
        acked,
        probeStatusMatched: probeResponses.some(
          response => response.status === (fixture.probeStatus ?? 200),
        ),
        isTaskResultPayload: result !== undefined,
        outcomeCompleted: result?.outcome === 'completed',
        contentMatched:
          result?.outcome === 'completed' &&
          result.content.includes('COMPILED_RESIDENT_COMPLETE'),
      },
      expectedProbeStatus: fixture.probeStatus ?? 200,
      probeResponses: [...probeResponses],
      tools: {
        requestedNames: steps.slice(0, step).map(call => call.name),
        resultCount: toolResults.length,
        resultBytes: toolResults.map(text => Buffer.byteLength(text)),
        protectedReadDenied:
          toolResults.length >= 1 &&
          /blocked|protected|memory store/i.test(toolResults[0] as string),
        protectedWriteDenied:
          toolResults.length >= 2 &&
          /blocked|protected|memory store/i.test(toolResults[1] as string),
        canaryObserved: toolResults.join('\n').includes(canary),
      },
    }
  }
  const writeDiagnostics = (status: 'passed' | 'failed') => {
    writeFileSync(
      join(root, 'diagnostics.json'),
      JSON.stringify(diagnosticSnapshot(status), null, 2),
      { mode: 0o600 },
    )
  }
  try {
    const deadline = Date.now() + 30000
    let ready = false
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      if (existsSync(timings)) {
        const rows = readFileSync(timings, 'utf8').split('\n').filter(Boolean)
        ready = rows.some(line => {
          try {
            const row = JSON.parse(line) as Record<string, unknown>
            return (
              row.stage === 'runtime_ready' &&
              row.generation === 1 &&
              currentGeneration() === 1 &&
              row.agent === 'dev' &&
              typeof row.sessionId === 'string' &&
              row.sessionId.length > 0 &&
              typeof row.at === 'number' &&
              row.at >= startupAt
            )
          } catch {
            return false
          }
        })
      }
      if (ready) break
      await Bun.sleep(20)
    }
    if (!ready || !existsSync(socket))
      throw new Error(
        'compiled resident first generation did not become ready within 30 seconds',
      )
    startupWaitMs = performance.now() - startupMonotonic
    phase = 'connect'
    const createdAt = Date.now()
    task = createMessage({
      taskId,
      createdAt,
      from: 'qianmo://compiled-probe/operator',
      to,
      hops: ['compiled-probe'],
      type: MessageType.TaskRequest,
      payload: {
        prompt: 'Perform the scripted read/write checks, then finish.',
      },
      deliverTtlMs: 15000,
      taskTtlMs: 60000,
      cap: createConsoleWakeIssuer(
        'compiled-probe',
        probeKeys,
        90000,
      )({ aud: 'compiled-worker', sub: to, taskId, createdAt }),
    })
    await client.connect(5000)
    if (currentGeneration() !== 1 || child.exitCode !== null)
      throw new Error('compiled resident generation changed before dispatch')
    phase = 'dispatch'
    await client.sendAndWait(task, 15000)
    phase = 'result'
    const result = await Promise.race([
      terminal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('compiled resident result timeout')),
          60000,
        )
      }),
    ])
    observedResult = result
    if (
      !acked ||
      !probeResponses.some(
        response => response.status === (fixture.probeStatus ?? 200),
      ) ||
      !isTaskResultPayload(result) ||
      result.outcome !== 'completed' ||
      !result.content.includes('COMPILED_RESIDENT_COMPLETE')
    )
      throw new Error('compiled resident did not complete a real native turn')
    phase = 'guards'
    if (
      readFileSync(join(workspace, 'allowed.txt'), 'utf8') !==
        'compiled extension positive control' ||
      existsSync(join(protectedRoot, 'changed.txt')) ||
      readFileSync(join(protectedRoot, 'secret.txt'), 'utf8') !== canary ||
      toolResults.length !== 3 ||
      toolResults.join('\n').includes(canary) ||
      !toolResults
        .slice(0, 2)
        .every(text => /blocked|protected|memory store/i.test(text))
    )
      throw new Error(
        'compiled extension guard did not enforce the real positive/negative controls',
      )
    phase = 'home-isolation'
    if (readdirSync(home).length !== 0)
      throw new Error(
        'compiled resident populated the empty HOME outside the qianmo config root',
      )
    phase = 'after-turn'
    await afterTurn?.(child.pid, root)
    phase = 'complete'
    writeFileSync(
      join(root, 'report.json'),
      JSON.stringify(
        {
          passed: true,
          readiness: { generation: 1, startupWaitMs, evidence: timings },
          probeResponses,
          binary: resolve(binary),
          acked,
          result: result.outcome,
          diagnostics: diagnosticSnapshot('passed'),
          toolResults: toolResults.length,
          protectedReadDenied: true,
          protectedWriteDenied: true,
          ordinaryWriteSucceeded: true,
          scope:
            'local fake provider, actual compiled resident and native OMP extension, no physical freeze/production claim',
        },
        null,
        2,
      ),
    )
    writeDiagnostics('passed')
    return { root, passed: true }
  } catch (error) {
    try {
      writeDiagnostics('failed')
    } catch {
      // Evidence I/O must not replace the original failed acceptance check.
      console.error('compiled resident diagnostics could not be written')
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    await client.close()
    child.kill('SIGTERM')
    await child.exited
    await provider.stop(true)
  }
}
if (
  import.meta.main &&
  /check-resident-compiled\.(?:ts|js|mjs)$/.test(Bun.main)
) {
  const rssOutput = process.argv[3]
  const result = await checkResidentCompiled(
    process.argv[2] ?? `dist/qm-${process.platform}-${process.arch}`,
    rssOutput
      ? async (pid, root) => {
          if (process.platform !== 'linux' || !rssOutput.startsWith('/'))
            throw new Error(
              'RSS requires Linux and an absolute fresh output directory',
            )
          console.log(
            JSON.stringify({
              phase: 'rss-start',
              root,
              pid,
              durationSeconds: 600,
            }),
          )
          const sample = Bun.spawn(
            [
              'python3',
              '-B',
              join(import.meta.dir, 'field-acceptance', 'measure-linux.py'),
              '--pid',
              String(pid),
              '--duration',
              '600',
              '--interval',
              '1',
              '--out',
              rssOutput,
            ],
            { stdout: 'inherit', stderr: 'inherit' },
          )
          if ((await sample.exited) !== 0)
            throw new Error('RSS acquisition failed')
        }
      : undefined,
  )
  console.log(JSON.stringify(result))
}
