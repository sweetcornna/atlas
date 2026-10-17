// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  generateNodeKeyPair,
  signAuthzDecision,
  type AuthzRequest,
} from '@qianmo/capability'
import { ResidentEstop } from '@qianmo/resident'
import {
  approvalWaitBudget,
  ResidentAuthorization,
  withDesktopSummary,
} from '../../src/host/residentAuthorization.js'

test('approval wait preserves ten seconds of watchdog and respects task TTL', () => {
  expect(approvalWaitBudget(120_000, 120_000)).toBe(60_000)
  expect(approvalWaitBudget(120_000, 40_000)).toBe(30_000)
  expect(approvalWaitBudget(5_000, 40_000)).toBe(5_000)
  expect(approvalWaitBudget(120_000, 9_999)).toBe(0)
  expect(approvalWaitBudget(-1, 120_000)).toBe(0)
})

test('connector tools reject signed windows and never fast-hit an older once approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-node-once-'))
  const nodeKeys = generateNodeKeyPair(),
    approver = generateNodeKeyPair()
  const auth = new ResidentAuthorization({
    node: 'worker',
    keys: nodeKeys,
    approvers: new Map([['hub', approver.publicKey]]),
    commanderKeys: () => [],
    memoryRoot: root,
    estop: new ResidentEstop({ path: path.join(root, 'ESTOP') }),
  })
  const origin = {
    from: 'qianmo://hub/console',
    taskId: null,
    traceId: null,
    trust: 'verified-capability' as const,
  }
  const decision = (
    request: AuthzRequest,
    kind: 'allow-once' | 'allow-window' | 'deny',
  ) =>
    signAuthzDecision(approver, {
      v: 1,
      requestId: request.requestId,
      aud: request.iss,
      sub: request.sub,
      digest: request.digest,
      decision: kind,
      windowMs: kind === 'allow-window' ? 1000 : 0,
      approver: 'hub/u:0123456789abcdef',
      nbf: Date.now(),
      exp: Date.now() + 10000,
      nonce: crypto.randomUUID(),
    })
  try {
    for (const toolName of ['qianmo_mail_send', 'qianmo_calendar_create']) {
      const call = {
        toolName,
        agent: 'main',
        contextId: 'fresh-only',
        input: {
          connectorId: 'connection',
          operationId: crypto.randomUUID(),
          revision: 1,
          title: 'exact',
        },
      }
      const asked = auth.store.ask({ ...call, origin })
      if (asked.kind !== 'pending') throw new Error('fixture request refused')
      expect(auth.decision(decision(asked.request, 'allow-window'))).toBe(false)
      expect(
        auth.store.applyDecision(decision(asked.request, 'allow-once')).ok,
      ).toBe(true)
      let askedAgain = false
      const allowed = await auth.request(
        call,
        origin,
        Date.now() + 1000,
        30000,
        request => {
          askedAgain = true
          auth.decision(decision(request, 'deny'))
        },
      )
      expect(askedAgain).toBe(true)
      expect(allowed).toBe(false)
    }
  } finally {
    auth.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a desktop approval carries a readable summary, signed with the arguments, and still consumes once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-summary-'))
  const nodeKeys = generateNodeKeyPair(),
    approver = generateNodeKeyPair()
  const auth = new ResidentAuthorization({
    node: 'worker',
    keys: nodeKeys,
    approvers: new Map([['hub', approver.publicKey]]),
    commanderKeys: () => [],
    memoryRoot: root,
    estop: new ResidentEstop({ path: path.join(root, 'ESTOP') }),
  })
  const origin = {
    from: 'qianmo://hub/console',
    taskId: 't',
    traceId: null,
    trust: 'verified-capability' as const,
  }
  // The shape NodeDesktop.decide binds: canonical args beside the lease.
  const args = {
    actions: [
      { type: 'click', x: 1, y: 2 },
      { text: '不该出现在摘要里', type: 'type' },
      { keys: ['ctrl', 's'], type: 'keypress' },
    ],
    confirm: '覆盖已有文件',
  }
  const call = {
    toolName: 'qianmo_computer_actions',
    agent: 'main',
    contextId: 'ctx',
    input: {
      node: 'worker',
      agent: 'main',
      contextId: 'ctx',
      taskId: 't',
      invocationId: 'call_1',
      resourceId: 'r',
      resourceEpoch: 1,
      op: 'actions',
      canonicalArgsDigest: 'a'.repeat(64),
      args,
    },
  }
  try {
    const sent: AuthzRequest[] = []
    const allowed = await auth.request(
      call,
      origin,
      Date.now() + 10000,
      30000,
      request => {
        sent.push(request)
        auth.decision(
          signAuthzDecision(approver, {
            v: 1,
            requestId: request.requestId,
            aud: request.iss,
            sub: request.sub,
            digest: request.digest,
            decision: 'allow-once',
            windowMs: 0,
            approver: 'hub/u:0123456789abcdef',
            nbf: Date.now(),
            exp: Date.now() + 10000,
            nonce: crypto.randomUUID(),
          }),
        )
      },
    )
    expect(allowed).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.input.summary).toBe(
      '批量 3 步：点击、输入 8 个字符、按键 ctrl+s；智能体的确认理由：覆盖已有文件',
    )
    expect(String(sent[0]!.input.summary)).not.toContain('摘要里')
    expect(sent[0]!.input.args).toEqual(args)
  } finally {
    auth.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
  // Other tools, and arguments that do not check, pass through untouched.
  const mail = {
    toolName: 'qianmo_mail_send',
    agent: 'a',
    contextId: 'c',
    input: { x: 1 },
  }
  expect(withDesktopSummary(mail)).toBe(mail)
  const odd = {
    toolName: 'qianmo_computer_open_app',
    agent: 'a',
    contextId: 'c',
    input: { args: { app: 'a b' } },
  }
  expect(withDesktopSummary(odd)).toBe(odd)
  expect(
    withDesktopSummary({
      ...odd,
      input: { args: { app: 'xterm' } },
    }).input.summary,
  ).toBe('打开应用 xterm')
})
