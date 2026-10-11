// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { type WireProfile } from '@qianmo/providers'
import { QianmoResident } from '../../src/host/resident.js'
import { applyRequest } from '../providers/helpers.js'
import {
  stageProviderApply,
  commitPendingProviderConfig,
} from '../../src/providers/node.js'

const realKey = process.env.QIANMO_API_KEY
const realBase = process.env.QIANMO_API_BASE_URL
async function until(predicate: () => boolean, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('resident routing integration timed out')
    await Bun.sleep(20)
  }
}
async function runRouting(real = false) {
  if (real && !realBase)
    throw new Error('QIANMO_API_BASE_URL is required for the live routing test')
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'p22-live-')),
  )
  const previous = process.env.QIANMO_CONFIG_DIR
  const config = path.join(root, 'config')
  fs.mkdirSync(config, { mode: 0o700 })
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  process.env.QIANMO_CONFIG_DIR = config
  const calls: { marker: string; effort: unknown; model: unknown }[] = []
  const key = real ? realKey! : 'sk-test-canary-routing'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      const text = JSON.stringify(body.messages)
      const marker = text.includes('P22_CHAT_MARKER')
        ? 'chat'
        : text.includes('P22_CODE_MARKER')
          ? 'code'
          : ''
      if (body.stream && marker)
        calls.push({ marker, effort: body.reasoning_effort, model: body.model })
      if (real) {
        const base = new URL(realBase!)
        const incoming = new URL(request.url)
        const prefix =
          base.pathname === '/'
            ? `${base.origin}/v1`
            : base.href.replace(/\/$/, '')
        const url = new URL(
          `${prefix}/${incoming.pathname.replace(/^\/v1\//, '')}`,
        )
        try {
          return await fetch(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${key}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: request.signal,
          })
        } catch {
          return Response.json(
            { error: { message: 'gateway connection interrupted' } },
            { status: 502 },
          )
        }
      }
      const payload = {
        id: 'p22-fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
      }
      return new Response(
        `data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const profile = (id: string, level: 'low' | 'high'): WireProfile => ({
    id,
    revision: 1,
    lane: 'openai-chat',
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: key }] },
    models: [
      {
        id: 'gpt-6-luna',
        role: 'main',
        tiers: ['sonnet'],
        capabilities: {
          mode: 'explicit',
          thinking: true,
          adaptive_thinking: false,
          interleaved_thinking: false,
        },
        effort: { send: 'always', levels: ['low', 'high'], level },
      },
    ],
    compat: { supportsReasoningEffort: 'true' },
  })
  let resident: QianmoResident | undefined
  let running: Promise<void> | undefined
  let client: TransportClient | undefined
  const received: QianmoMessage[] = []
  const events: {
    kind: string
    detail: Readonly<Record<string, string | number | boolean>>
  }[] = []
  const auditPath = path.join(config, 'audit.ndjson')
  const audit = new AuditTrail(auditPath)
  try {
    const primary = profile('route-code', 'high')
    const staged = stageProviderApply(
      applyRequest({
        node: 'node-b',
        profile: primary,
        profiles: [profile('route-chat', 'low')],
        routing: {
          auto: true,
          routes: {
            code: { profileId: 'route-code', modelId: 'gpt-6-luna' },
            chat: { profileId: 'route-chat', modelId: 'gpt-6-luna' },
          },
        },
      }),
    )
    expect(staged.ok).toBe(true)
    expect((await commitPendingProviderConfig()).status).toBe('committed')
    const unix = path.join(root, 'node.sock')
    const errors: unknown[] = []
    let ready = false
    resident = new QianmoResident({
      node: 'node-b',
      team: 'nest',
      agents: [{ agent: 'main', cwd: workspace }],
      psk: 'p22-routing-test-psk',
      listen: { unix },
      pollIntervalMs: 20,
      onTiming: event => {
        if (event.stage === 'runtime_ready') ready = true
      },
      onError: error => errors.push(error),
      runtimeAudit: event => {
        events.push(event)
        audit.append({
          at: Date.now(),
          source: AuditSource.Resident,
          node: 'node-b',
          kind: event.kind,
          outcome: 'ok',
          detail: event.detail,
        })
      },
    })
    running = resident.run()
    await until(() => fs.existsSync(unix) && ready)
    client = new TransportClient({
      endpoint: { unix },
      node: 'hub',
      psk: 'p22-routing-test-psk',
      onMessage: message => {
        received.push(message)
      },
    })
    await client.connect()
    for (const [marker, prompt] of [
      ['code', 'P22_CODE_MARKER 修复代码：只回复 pong，不使用工具。'],
      ['chat', 'P22_CHAT_MARKER 你好：只回复 pong。'],
    ] as const) {
      const message = createMessage({
        type: MessageType.TaskRequest,
        from: 'qianmo://hub/operator',
        to: 'qianmo://node-b/main',
        contextId: 'same-session',
        payload: { prompt },
        taskTtlMs: 120000,
      })
      await client.send(message)
      await until(() =>
        received.some(
          r => r.taskId === message.taskId && r.type === MessageType.TaskResult,
        ),
      )
      expect(
        received.find(
          r => r.taskId === message.taskId && r.type === MessageType.TaskResult,
        )?.payload,
      ).toMatchObject({ outcome: 'completed' })
      const route = events.filter(e => e.kind === 'model.route').at(-1)!
      expect(route.detail).toMatchObject({
        direction: marker,
        source: 'auto',
        thinkingLevel: marker === 'code' ? 'high' : 'low',
      })
      expect(route.detail.model).toStartWith(`qm-route-${marker}-`)
      expect(calls.filter(c => c.marker === marker).at(-1)).toMatchObject({
        effort: marker === 'code' ? 'high' : 'low',
        model: 'gpt-6-luna',
      })
    }
    expect(fs.readFileSync(auditPath, 'utf8')).not.toContain('P22_CODE_MARKER')
    expect(fs.readFileSync(auditPath, 'utf8')).not.toContain(key)
    expect(errors).toEqual([])
    // Safe evidence only: no endpoints, prompts or key values.
    if (real)
      process.stdout.write(
        `P22 real-key evidence: ${JSON.stringify({ routes: events.filter(e => e.kind === 'model.route').map(e => e.detail), calls })}\n`,
      )
  } finally {
    resident?.stop()
    await running
    await client?.close()
    await server.stop(true)
    audit.close()
    if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
}
test(
  'real resident RPC switches same-session code/chat providers and actual wire efforts',
  () => runRouting(),
  180000,
)
test.skipIf(!realKey)(
  'api2 real-key resident matches code/high and chat/low audit to wire',
  () => runRouting(true),
  300000,
)
