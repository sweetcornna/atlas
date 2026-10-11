// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateNodeKeyPair } from '@qianmo/capability'
import { expect, test } from 'bun:test'
import type {
  ActionLedgerPort,
  ConsoleAction,
  DesktopNodeView,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { ConsoleDesktop } from '../../src/commands/consoleDesktop.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
const view: DesktopNodeView = {
  node: 'worker',
  agent: 'main',
  reachable: true,
  platform: 'darwin',
  browser: {
    enabled: true,
    state: 'running',
    profileBytes: 10,
    startedAt: 1,
    reason: null,
  },
  computer: {
    enabled: false,
    supported: false,
    state: 'off',
    display: null,
    reason: null,
  },
  confirm: 'sensitive',
  lastActionAt: 1,
  actions24h: 1,
  confirmed24h: 0,
}

test('hub desktop controls carry operation identity, action ledger and dispatch-time permission guard', async () => {
  const calls: { op: string; args: Record<string, unknown>; actor: string }[] =
      [],
    entries: ConsoleAction[] = []
  let result: ControlOutcome = { ok: true, value: view },
    allowed = true
  const ledger: ActionLedgerPort = {
    async record(e) {
      entries.push(e)
      return { ok: true, value: undefined }
    },
    async list() {
      return { ok: true, value: { entries: [], nextBeforeSeq: null } }
    },
  }
  const links = {
    status: () => [
      { node: 'worker', connected: true, lastConnectedAt: 1, lastError: null },
    ],
    async request(
      _node: string,
      op: string,
      args: Record<string, unknown>,
      actor: string,
      options?: { beforeDispatch?: () => void },
    ) {
      try {
        options?.beforeDispatch?.()
      } catch {
        return { ok: false as const, code: 'refused', message: 'revoked' }
      }
      calls.push({ op, args, actor })
      return result
    },
  }
  const port = new ConsoleDesktop(links, ledger)
  const actor = {
    subject: 'u:7f3a0c1d2e4b5a69',
    role: 'ops' as const,
    requestId: 'r1',
    beforeDispatch: () => {
      if (!allowed) throw new Error('revoked')
    },
  }
  expect((await port.set(view, { browser: true }, actor)).ok).toBe(true)
  expect(calls[0]).toEqual({
    op: 'desktop.enable',
    args: { browser: true, agent: 'main', operationId: 'r1' },
    actor: actor.subject,
  })
  expect(entries[0]).toMatchObject({
    action: 'desktop.set',
    requestId: 'r1',
    target: 'qianmo://worker/main',
    outcome: 'ok',
  })
  await port.set(
    view,
    { browser: false, computer: false },
    { ...actor, requestId: 'r2' },
  )
  expect(calls[1]?.op).toBe('desktop.disable')
  await port.recycle(view, { ...actor, requestId: 'r3' })
  expect(entries[2]?.action).toBe('desktop.recycle')
  allowed = false
  expect((await port.recycle(view, { ...actor, requestId: 'r4' })).ok).toBe(
    false,
  )
  expect(calls.length).toBe(3)
  result = { ok: false, code: 'timeout', message: 'unknown receipt' }
  allowed = true
  expect(await port.recycle(view, { ...actor, requestId: 'r5' })).toMatchObject(
    { ok: false, failure: { code: 'unreachable', deliveryUnknown: true } },
  )
})
test('status keeps last known state on disconnect and action queries cannot leak another node or agent', async () => {
  let connected = true
  const port = new ConsoleDesktop({
    status: () => [
      { node: 'worker', connected, lastConnectedAt: 1, lastError: null },
    ],
    async request(_node, op) {
      if (!connected)
        return { ok: false, code: 'unreachable', message: 'offline' }
      return {
        ok: true,
        value:
          op === 'desktop.status'
            ? [view]
            : [
                { at: 1, node: 'worker', agent: 'main', op: 'screenshot' },
                { at: 2, node: 'worker', agent: 'foreign', op: 'click' },
                { at: 3, node: 'foreign', agent: 'main', op: 'click' },
              ],
      }
    },
  })
  expect(await port.list()).toMatchObject({
    ok: true,
    value: [{ reachable: true }],
  })
  expect(await port.actions(view, 1)).toMatchObject({
    ok: true,
    value: [{ node: 'worker', agent: 'main', at: 1 }],
  })
  connected = false
  expect(await port.list()).toMatchObject({
    ok: true,
    value: [{ reachable: false, browser: { state: 'running' } }],
  })
})
test('console desktop switch requires signed control targets and is absent by default', () => {
  expect(parseConsoleArgs([]).desktop).toBeUndefined()
  expect(() => parseConsoleArgs(['--desktop'])).toThrow(
    '--desktop needs --control',
  )
  const config = parseConsoleArgs([
    '--desktop',
    '--control',
    'worker=ws://127.0.0.1:1234',
    '--trust',
    `worker=${generateNodeKeyPair().publicKey}`,
  ])
  expect(config.desktop).toBe(true)
  expect(config.controlTargets?.[0]?.node).toBe('worker')
})
