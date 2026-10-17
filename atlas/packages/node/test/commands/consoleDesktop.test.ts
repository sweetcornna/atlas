// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateNodeKeyPair } from '@qianmo/capability'
import { expect, test } from 'bun:test'
import type {
  ActionLedgerPort,
  ConsoleAction,
  DesktopNodeView,
  DesktopScreenView,
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

function recorder(answer: (op: string) => ControlOutcome) {
  const calls: { op: string; args: Record<string, unknown>; actor: string }[] =
    []
  const port = new ConsoleDesktop({
    status: () => [
      { node: 'worker', connected: true, lastConnectedAt: 1, lastError: null },
    ],
    async request(_node, op, args, actor) {
      calls.push({ op, args, actor })
      return answer(op)
    },
  })
  return { port, calls }
}

test('policy changes go out as desktop.enable with the new fields; only false unit flags disable', async () => {
  const { port, calls } = recorder(() => ({ ok: true, value: view }))
  const actor = { subject: 'u:7f3a0c1d2e4b5a69', role: 'ops' as const }
  await port.set(
    view,
    { confirm: 'autonomous', apps: ['org.gnome.TextEditor'], terminal: true },
    { ...actor, requestId: 'a1' },
  )
  await port.set(view, { terminal: false }, { ...actor, requestId: 'a2' })
  await port.set(view, { apps: 'none' }, { ...actor, requestId: 'a3' })
  await port.set(
    view,
    { computer: false, apps: 'all' },
    { ...actor, requestId: 'a4' },
  )
  await port.set(view, { computer: false }, { ...actor, requestId: 'a5' })
  expect(calls.map(c => c.op)).toEqual([
    'desktop.enable',
    'desktop.enable',
    'desktop.enable',
    'desktop.enable',
    'desktop.disable',
  ])
  expect(calls[0]?.args).toEqual({
    confirm: 'autonomous',
    apps: ['org.gnome.TextEditor'],
    terminal: true,
    agent: 'main',
    operationId: 'a1',
  })
  expect(calls[1]?.args).toEqual({
    terminal: false,
    agent: 'main',
    operationId: 'a2',
  })
})

test('status passes the private desktop fields through and tolerates a node that sends none', async () => {
  const fresh: DesktopNodeView = {
    ...view,
    platform: 'linux',
    computer: {
      ...view.computer,
      supported: true,
      mode: 'private',
      windowManager: 'openbox',
      accessibility: true,
      confined: false,
      apps: 'all',
      terminal: false,
      memoryBytes: 1,
      memoryLimitBytes: 2,
    },
  }
  const { port } = recorder(op =>
    op === 'desktop.status'
      ? { ok: true, value: [fresh, { ...view, agent: 'old' }] }
      : { ok: true, value: [] },
  )
  expect(await port.list()).toMatchObject({
    ok: true,
    value: [
      {
        agent: 'main',
        computer: { mode: 'private', confined: false, memoryLimitBytes: 2 },
      },
      { agent: 'old', computer: { supported: false } },
    ],
  })
})

test('the latest screenshot is read over desktop.view and checked before the page sees it', async () => {
  const shot: DesktopScreenView = {
    at: 9,
    mimeType: 'image/png',
    data: 'iVBORw0KGgo=',
  }
  let answer: ControlOutcome = { ok: true, value: shot }
  const { port, calls } = recorder(() => answer)
  expect(await port.view(view)).toEqual({ ok: true, value: shot })
  expect(calls).toEqual([
    { op: 'desktop.view', args: { agent: 'main' }, actor: 'console:read' },
  ])
  answer = { ok: true, value: null }
  expect(await port.view(view)).toEqual({ ok: true, value: null })
  for (const bad of [
    { ...shot, mimeType: 'image/svg+xml' },
    { ...shot, mimeType: 'text/html' },
    { ...shot, data: 'not base64!' },
    { ...shot, data: 'abc' },
    { ...shot, data: '' },
    { ...shot, at: 'yesterday' },
    { ...shot, data: 'A'.repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4) },
    'image',
    [],
  ]) {
    answer = { ok: true, value: bad }
    expect(await port.view(view)).toMatchObject({
      ok: false,
      failure: { code: 'rejected', message: '节点返回了无效画面' },
    })
  }
  // Exactly 4 MiB of image, as base64, is still a picture.
  answer = {
    ok: true,
    value: { ...shot, data: 'A'.repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4) },
  }
  expect((await port.view(view)).ok).toBe(true)
})

test('a node too old for desktop.view, an oversized answer and an unreachable node each say so', async () => {
  let answer: ControlOutcome = {
    ok: false,
    code: 'invalid',
    message: 'Invalid desktop operation',
  }
  const { port } = recorder(() => answer)
  const old = {
    ok: false,
    failure: { code: 'unsupported', message: '节点版本过旧 · 不能查看画面' },
  } as const
  expect(await port.view(view)).toEqual(old)
  answer = { ok: false, code: 'unsupported', message: '不支持此控制操作' }
  expect(await port.view(view)).toEqual(old)
  answer = {
    ok: false,
    code: 'invalid',
    message: '控制回执超过 UTF-8 字节上限',
  }
  expect(await port.view(view)).toEqual({
    ok: false,
    failure: { code: 'rejected', message: '画面超过控制链路的大小上限' },
  })
  answer = { ok: false, code: 'unreachable', message: 'offline' }
  expect(await port.view(view)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  answer = { ok: false, code: 'timeout', message: 'late' }
  expect(await port.view(view)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  answer = { ok: false, code: 'E_BUSY', message: 'halted' }
  expect(await port.view(view)).toMatchObject({
    ok: false,
    failure: { code: 'refused', message: 'halted' },
  })
  answer = { ok: false, code: 'invalid', message: 'Invalid view query' }
  expect(await port.view(view)).toMatchObject({
    ok: false,
    failure: { code: 'invalid', message: 'Invalid view query' },
  })
})
