// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateNodeKeyPair } from '@qianmo/capability'
import { expect, test } from 'bun:test'
import type {
  ActionLedgerPort,
  ConsoleAction,
  ElevationNodeView,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { ConsoleElevation } from '../../src/commands/consoleElevation.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'

const view: ElevationNodeView = {
  node: 'worker',
  agent: 'main',
  reachable: true,
  tier: 'auto',
  epoch: 2,
  expiresAt: 10,
  maxCalls: 200,
  usedCalls: 0,
  sandbox: false,
  sandboxReason: 'no sandbox',
  enabledAt: 1,
  enabledBy: 'u:ops',
  actions24h: 0,
}

function harness(answer: (op: string) => ControlOutcome) {
  const calls: { op: string; args: Record<string, unknown>; actor: string }[] =
    []
  const entries: ConsoleAction[] = []
  let allowed = true
  const ledger: ActionLedgerPort = {
    async record(entry) {
      entries.push(entry)
      return { ok: true, value: undefined }
    },
    async list() {
      return { ok: true, value: { entries: [], nextBeforeSeq: null } }
    },
  }
  const port = new ConsoleElevation(
    {
      status: () => [
        {
          node: 'worker',
          connected: true,
          lastConnectedAt: 1,
          lastError: null,
        },
      ],
      async request(_node, op, args, actor, options) {
        try {
          options?.beforeDispatch?.()
        } catch {
          return { ok: false, code: 'refused', message: 'revoked' }
        }
        calls.push({ op, args, actor })
        return answer(op)
      },
    },
    ledger,
  )
  const actor = {
    subject: 'u:ops',
    role: 'ops' as const,
    requestId: '0b8c0f8e-1111-4222-8333-944455556666',
    beforeDispatch: () => {
      if (!allowed) throw new Error('E_AUTH_REVOKED')
    },
  }
  return {
    port,
    calls,
    entries,
    actor,
    revoke: () => {
      allowed = false
    },
  }
}

test('set translates tiers to node operations, carries the request id and records the ledger', async () => {
  const h = harness(op =>
    op === 'elevation.disable'
      ? { ok: true, value: { ...view, tier: 'off' } }
      : { ok: true, value: view },
  )
  const ref = { node: 'worker', agent: 'main' }
  const on = await h.port.set(ref, { tier: 'auto', ttlMs: 600_000 }, h.actor)
  expect(on.ok).toBe(true)
  expect(h.calls[0]).toEqual({
    op: 'elevation.enable',
    args: {
      tier: 'auto',
      ttlMs: 600_000,
      agent: 'main',
      operationId: h.actor.requestId,
    },
    actor: 'u:ops',
  })
  const off = await h.port.set(ref, { tier: 'off' }, h.actor)
  expect(off.ok && off.value.tier).toBe('off')
  expect(h.calls[1]?.op).toBe('elevation.disable')
  await h.port.revoke(ref, h.actor)
  expect(h.calls[2]?.op).toBe('elevation.revoke')
  expect(h.entries.map(e => [e.action, e.target, e.outcome])).toEqual([
    ['elevation.enable', 'qianmo://worker/main', 'ok'],
    ['elevation.disable', 'qianmo://worker/main', 'ok'],
    ['elevation.revoke', 'qianmo://worker/main', 'ok'],
  ])
})

test('a revoked permission refuses before dispatch; a node refusal is recorded with its code', async () => {
  const h = harness(() => ({
    ok: false,
    code: 'rejected',
    message: '该智能体运行在外部底层 dsh 上',
  }))
  const ref = { node: 'worker', agent: 'main' }
  const refused = await h.port.set(ref, { tier: 'auto' }, h.actor)
  expect(refused.ok).toBe(false)
  expect(refused.ok ? '' : refused.failure.message).toContain('dsh')
  expect(h.entries[0]).toMatchObject({ outcome: 'failed', code: 'rejected' })
  h.revoke()
  const blocked = await h.port.set(ref, { tier: 'auto' }, h.actor)
  expect(blocked.ok).toBe(false)
  expect(h.calls.length).toBe(1)
})

test('a node answer for another agent is not trusted', async () => {
  const h = harness(() => ({ ok: true, value: { ...view, agent: 'other' } }))
  const r = await h.port.set(
    { node: 'worker', agent: 'main' },
    { tier: 'auto' },
    h.actor,
  )
  expect(r.ok).toBe(false)
})

test('list and actions read status over the control link', async () => {
  const h = harness(op =>
    op === 'elevation.status'
      ? { ok: true, value: [view] }
      : {
          ok: true,
          value: [
            {
              at: 5,
              node: 'worker',
              agent: 'main',
              tool: 'web_search',
              cls: 'read-out',
              op: null,
              host: null,
              approved: false,
              outcome: 'allowed',
              epoch: 2,
            },
          ],
        },
  )
  const list = await h.port.list()
  expect(list.ok && list.value[0]?.tier).toBe('auto')
  const actions = await h.port.actions({ node: 'worker', agent: 'main' }, 10)
  expect(actions.ok && actions.value.length).toBe(1)
})

test('--elevation needs --approvals and --control', () => {
  const key = generateNodeKeyPair().publicKey
  expect(parseConsoleArgs([]).elevation).toBeUndefined()
  expect(() => parseConsoleArgs(['--elevation'])).toThrow(
    '--elevation needs --approvals and --control',
  )
  const config = parseConsoleArgs([
    '--elevation',
    '--approvals',
    '--accounts',
    '--chat-sign',
    '--chat-url',
    'worker=ws://127.0.0.1:39999',
    '--control',
    'worker=ws://127.0.0.1:1234',
    '--trust',
    `worker=${key}`,
  ])
  expect(config.elevation).toBe(true)
})
