// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import { authzDigest } from '@qianmo/capability'
import { residentApprovalInput } from '@qianmo/extension/policy'
import { rejudge, type Binding } from './index.js'
import { nativeApproval } from './native.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qm-rejudge-'))
  const sessions = join(root, 'sessions')
  const workspace = join(root, 'workspace')
  const state = join(root, 'state')
  for (const dir of [sessions, workspace, state]) mkdirSync(dir)
  const auditFile = join(root, 'audit.ndjson')
  const audit = new AuditTrail(auditFile)
  audit.ensure()
  const binding: Binding = {
    directory: sessions,
    node: 'node1',
    config: {
      v: 1,
      agent: 'worker',
      workspace,
      edits: 'workspace',
      protectedRoots: [state],
      hostTools: [],
      approvals: true,
    },
    stateRoots: [state],
    inputs: { input1: { contextId: 'context1', taskId: 'task1' } },
  }
  const options = {
    root: sessions,
    auditFiles: [auditFile],
    bindings: [binding],
  }
  const at = (ms: number) => new Date(ms).toISOString()
  function transcript(
    tool: string,
    input: Record<string, unknown>,
    extra: {
      file?: string
      error?: boolean
      parentSession?: string
      noResult?: boolean
    } = {},
  ) {
    const path = join(sessions, extra.file ?? 'main.jsonl')
    mkdirSync(join(path, '..'), { recursive: true })
    const rows = [
      {
        type: 'session',
        version: 3,
        id: 'session1',
        cwd: workspace,
        timestamp: at(1000),
        ...(extra.parentSession ? { parentSession: extra.parentSession } : {}),
      },
      {
        type: 'message',
        id: 'user1',
        parentId: null,
        timestamp: at(1100),
        message: { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      },
      {
        type: 'custom',
        id: 'identity1',
        parentId: 'user1',
        timestamp: at(1101),
        customType: 'qianmo.resident.input-identity',
        data: { userEntryId: 'user1', messageId: 'input1' },
      },
      {
        type: 'message',
        id: 'assistant1',
        parentId: 'identity1',
        timestamp: at(1200),
        message: {
          role: 'assistant',
          timestamp: 1200,
          content: [
            { type: 'toolCall', id: 'call1', name: tool, arguments: input },
          ],
        },
      },
      ...(extra.noResult
        ? []
        : [
            {
              type: 'message',
              id: 'result1',
              parentId: 'assistant1',
              timestamp: at(1500),
              message: {
                role: 'toolResult',
                toolCallId: 'call1',
                toolName: tool,
                content: [{ type: 'text', text: 'ok' }],
                isError: extra.error ?? false,
              },
            },
          ]),
    ]
    writeFileSync(path, `${rows.map(r => JSON.stringify(r)).join('\n')}\n`)
    return path
  }
  function grant(
    toolName: string,
    input: Record<string, unknown>,
    changes: Record<string, string | number | boolean> = {},
    decision: 'allow-once' | 'allow-window' = 'allow-once',
  ) {
    const digest = authzDigest({
      node: 'node1',
      agent: 'worker',
      contextId: 'context1',
      toolName,
      input: ['write', 'edit', 'ast_edit'].includes(toolName)
        ? residentApprovalInput({ toolName, input }, workspace)
        : input,
    })
    const detail = {
      requestId: 'request1',
      agent: 'worker',
      contextId: 'context1',
      tool: toolName,
      digest,
      expiresAt: 2000,
      ...changes,
    }
    const append = (
      kind: string,
      at: number,
      extra: Record<string, string | number | boolean>,
    ) =>
      audit.append({
        kind,
        at,
        node: 'node1',
        taskId: 'task1',
        source: AuditSource.Resident,
        outcome: 'ok',
        detail: { ...detail, ...extra },
      })
    append('authz.requested', 1250, { status: 'pending' })
    append('authz.decision', 1300, {
      status: decision,
      approver: 'operator',
      scope: decision === 'allow-once' ? 'once' : 'window',
    })
    append('authz.grant_used', 1400, {
      approver: 'operator',
      scope: decision === 'allow-once' ? 'once' : 'window',
    })
  }
  return {
    root,
    sessions,
    workspace,
    state,
    audit,
    auditFile,
    binding,
    options,
    transcript,
    grant,
  }
}

describe('omp permission rejudge', () => {
  test('uses native argument-dependent approvals and actual resident policy; ordinary executed work passes', () => {
    const f = fixture()
    f.transcript('write', { path: join(f.workspace, 'ok.ts'), content: 'ok' })
    const before = readFileSync(f.auditFile, 'utf8')
    const r = rejudge(f.options)
    expect(r.passed).toBe(true)
    expect(r.coverage).toMatchObject({
      calls: 1,
      successful: 1,
      hardlineEvaluations: 1,
      allowlistEvaluations: 1,
    })
    expect(readFileSync(f.auditFile, 'utf8')).toBe(before)
    expect(
      nativeApproval(f.binding.config)('read', { path: 'ssh://server/file' })
        .tier,
    ).toBe('exec')
  })
  for (const [name, tool, input] of [
    [
      'E1 MCP alias',
      'mcp__attacker__write',
      { path: '/tmp/bypass', content: 'bad' },
    ],
    ['E2 shell', 'bash', { command: 'echo bad > /tmp/bypass' }],
    ['E3 subagent', 'task', { agent: 'worker', prompt: 'bypass' }],
    [
      'E4 skill writer',
      'manage_skill',
      { operation: 'create', name: 'backdoor', content: 'bad' },
    ],
  ] as const)
    test(`${name} positive execution fixture fires tool allowlist scan`, () => {
      const f = fixture()
      f.transcript(tool, input)
      const r = rejudge(f.options)
      expect(r.passed).toBe(false)
      expect(r.coverage.successful).toBe(1)
      expect(
        r.findings.some(
          row =>
            row.category === 'tool-allowlist' && row.execution === 'success',
        ),
      ).toBe(true)
    })
  test('protected path positive fires hardline even for otherwise allowed write', () => {
    const f = fixture()
    f.transcript('write', { path: join(f.state, 'private'), content: 'bad' })
    expect(
      rejudge(f.options).findings.some(r => r.category === 'hardline'),
    ).toBe(true)
  })
  test('exact approved grant chain passes ask; forged host authorized does not', () => {
    const f = fixture()
    const input = { path: join(f.root, 'outside'), content: 'ok' }
    f.transcript('write', input)
    f.audit.append({
      kind: 'authorized',
      at: 1300,
      node: 'node1',
      source: AuditSource.Resident,
      outcome: 'ok',
      detail: { authorized: true },
    })
    expect(
      rejudge(f.options).findings.some(r => r.category === 'missing-grant'),
    ).toBe(true)
    f.grant('write', input)
    expect(rejudge(f.options)).toMatchObject({
      passed: true,
      coverage: { ask: 1, matchedGrants: 1 },
    })
  })
  test('streaming approval precedes persisted entry; invalid or late response start fails', () => {
    const f = fixture()
    const input = { path: join(f.root, 'outside'), content: 'ok' }
    const file = f.transcript('write', input)
    f.grant('write', input)
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const assistant = rows.find(row => row.id === 'assistant1')!
    assistant.timestamp = new Date(1450).toISOString()
    const save = () =>
      writeFileSync(
        file,
        rows.map(row => JSON.stringify(row)).join('\n') + '\n',
      )
    save()
    expect(rejudge(f.options)).toMatchObject({
      passed: true,
      coverage: { matchedGrants: 1 },
    })
    // A grant before this response began cannot be borrowed from an earlier call.
    assistant.message.timestamp = 1440
    save()
    expect(
      rejudge(f.options).findings.some(row => row.category === 'missing-grant'),
    ).toBe(true)
    for (const timestamp of [1501, null, '1200']) {
      assistant.message.timestamp = timestamp
      save()
      expect(rejudge(f.options).passed).toBe(false)
    }
  })
  test('host memory write always requires its own exact approval despite hostTools allow', () => {
    const f = fixture()
    const input = {
      title: 'Decision',
      summary: 'Summary',
      body: 'Exact memory body',
    }
    const binding = {
      ...f.binding,
      config: { ...f.binding.config, hostTools: ['qianmo_memory_write'] },
    }
    const options = { ...f.options, bindings: [binding] }
    f.transcript('qianmo_memory_write', input)
    expect(
      rejudge(options).findings.some(row => row.category === 'missing-grant'),
    ).toBe(true)
    f.grant('qianmo_memory_write', input)
    expect(rejudge(options)).toMatchObject({
      passed: true,
      coverage: { ask: 1, matchedGrants: 1 },
    })
    const window = fixture()
    window.transcript('qianmo_memory_write', input)
    window.grant('qianmo_memory_write', input, {}, 'allow-window')
    const refused = rejudge({
      ...window.options,
      bindings: [
        {
          ...window.binding,
          config: {
            ...window.binding.config,
            hostTools: ['qianmo_memory_write'],
          },
        },
      ],
    })
    expect(refused.findings.some(row => row.category === 'missing-grant')).toBe(
      true,
    )
  })
  test('wrong content, context, expired or revoked grant cannot justify execution', () => {
    for (const variant of ['content', 'context', 'expiry', 'revoke']) {
      const f = fixture()
      const input = { path: join(f.root, 'outside'), content: 'ok' }
      f.transcript('write', input)
      f.grant(
        'write',
        variant === 'content' ? { ...input, content: 'different' } : input,
        variant === 'context'
          ? { contextId: 'other' }
          : variant === 'expiry'
            ? { expiresAt: 1350 }
            : {},
      )
      if (variant === 'revoke')
        f.audit.append({
          kind: 'authz.revoked',
          at: 1399,
          node: 'node1',
          source: AuditSource.Resident,
          outcome: 'ok',
          detail: { requestId: 'request1' },
        })
      expect(rejudge(f.options).passed).toBe(false)
    }
  })
  test('one grant_used cannot cover two completed calls or duplicate evidence copies', () => {
    const f = fixture()
    const input = { path: join(f.root, 'outside'), content: 'ok' }
    f.transcript('write', input)
    f.transcript('write', input, { file: 'second.jsonl' })
    f.grant('write', input)
    const copy = join(f.root, 'audit-copy.ndjson')
    writeFileSync(copy, readFileSync(f.auditFile))
    const r = rejudge({ ...f.options, auditFiles: [f.auditFile, copy] })
    expect(r.coverage.matchedGrants).toBe(1)
    expect(r.findings.filter(r => r.category === 'missing-grant')).toHaveLength(
      1,
    )
  })
  test('walks sidechains and abandoned branches, not only latest active branch', () => {
    const f = fixture()
    const file = f.transcript(
      'bash',
      { command: 'true' },
      { file: 'sub/nested/side.jsonl', parentSession: 'main' },
    )
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        `${JSON.stringify({ type: 'message', id: 'latest', parentId: 'user1', timestamp: new Date(2000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'clean branch' }] } })}\n`,
    )
    const r = rejudge(f.options)
    expect(r.coverage.sidechains).toBe(1)
    expect(r.coverage.calls).toBe(1)
    expect(r.passed).toBe(false)
  })
  test('error result cannot prove refusal; tool_execution_start alone cannot prove execution', () => {
    for (const extra of [{ error: true }, { noResult: true }]) {
      const f = fixture()
      f.transcript(
        'write',
        { path: join(f.workspace, 'x'), content: 'x' },
        extra,
      )
      const r = rejudge(f.options)
      expect(r.passed).toBe(false)
      expect(r.coverage.uncertain).toBe(1)
    }
  })
  test('tool IDs may repeat in sequential turns; results bind to the nearest owning assistant', () => {
    const f = fixture()
    const file = f.transcript('write', {
      path: join(f.workspace, 'one'),
      content: 'one',
    })
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const repeated = rows.slice(1).map(row => ({
      ...row,
      id: `${row.id}-2`,
      parentId: row.parentId === null ? 'result1' : `${row.parentId}-2`,
      ...(row.type === 'custom'
        ? { data: { ...row.data, userEntryId: 'user1-2' } }
        : {}),
    }))
    writeFileSync(
      file,
      [...rows, ...repeated].map(row => JSON.stringify(row)).join('\n') + '\n',
    )
    const report = rejudge(f.options)
    expect(report.findings).toEqual([])
    expect(report.coverage.successful).toBe(2)
    const assistant = rows.find(row => row.id === 'assistant1')!
    assistant.message.content.push(assistant.message.content[0])
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    expect(
      rejudge(f.options).findings.some(row =>
        row.reason.includes('Duplicate native tool call'),
      ),
    ).toBe(true)
  })
  test('empty, malformed, unmapped, symlinked or broken-chain evidence never passes', () => {
    const f = fixture()
    expect(rejudge(f.options).passed).toBe(false)
    const file = f.transcript('write', {
      path: join(f.workspace, 'ok'),
      content: 'ok',
    })
    expect(rejudge({ ...f.options, bindings: [] }).passed).toBe(false)
    writeFileSync(file, readFileSync(file, 'utf8') + '{bad\n')
    expect(rejudge(f.options).passed).toBe(false)
    symlinkSync(f.root, join(f.sessions, 'escape'))
    expect(rejudge(f.options).passed).toBe(false)
    writeFileSync(f.auditFile, '{}\n')
    expect(rejudge(f.options).passed).toBe(false)
  })
})

test('rejudges a real omp child transcript after an actual guarded file write', async () => {
  const { ResidentOmpHarness } = await import(
    '../../tests/integration/fixtures/resident-omp-harness.js'
  )
  const { qianmoConfigPath, protectedConfigRoots } = await import(
    '@qianmo/paths'
  )
  const f = fixture()
  const harness = new ResidentOmpHarness()
  try {
    const target = join(f.workspace, 'real-child.txt')
    const run = await harness.run(
      f.workspace,
      [
        {
          name: 'write',
          input: { path: target, content: 'real child wrote this' },
        },
      ],
      true,
      f.state,
    )
    expect(run.result.outcome).toBe('completed')
    expect(readFileSync(target, 'utf8')).toBe('real child wrote this')
    await harness.stop()
    const directory = qianmoConfigPath(
      'resident',
      'sessions',
      'reviewer',
      run.sessionId,
    )
    const config = JSON.parse(
      readFileSync(join(directory, 'resident-extension.json'), 'utf8'),
    )
    const report = rejudge({
      root: directory,
      auditFiles: [f.auditFile],
      bindings: [
        {
          directory,
          node: 'node1',
          config,
          stateRoots: protectedConfigRoots(),
          inputs: { [run.messageId]: { contextId: 'context1' } },
        },
      ],
    })
    expect(report.findings).toEqual([])
    expect(report.passed).toBe(true)
    expect(report.coverage.successful).toBe(1)
  } finally {
    await harness.stop()
  }
}, 30_000)

test('CLI builds historical posture from node audit and refuses overwrite or unbound history', async () => {
  const { createHash } = await import('node:crypto')
  const { homedir } = await import('node:os')
  const { rejudgeNode } = await import('./node.js')
  const { main } = await import('../authz-rejudge.js')
  const f = fixture()
  f.transcript(
    'write',
    { path: join(f.workspace, 'ok'), content: 'ok' },
    { file: 'worker/sess/main.jsonl' },
  )
  expect(
    rejudgeNode({
      sessions: f.sessions,
      node: 'node1',
      auditFiles: [f.auditFile],
    }).passed,
  ).toBe(false)
  const policy = JSON.stringify(f.binding.config)
  f.audit.append({
    at: 1000,
    node: 'node1',
    source: AuditSource.Resident,
    kind: 'authz.posture',
    outcome: 'ok',
    detail: {
      sessionId: 'sess',
      agent: 'worker',
      approvalMode: 'write',
      policy,
      configHash: createHash('sha256').update(policy).digest('hex'),
      stateRoots: JSON.stringify([f.state]),
      home: homedir(),
      configDir: f.state,
      qmcodeHome: join(f.root, 'qmcode'),
    },
  })
  f.audit.append({
    at: 1050,
    node: 'node1',
    source: AuditSource.Resident,
    kind: 'authz.admission',
    outcome: 'ok',
    taskId: 'task1',
    detail: {
      sessionId: 'sess',
      agent: 'worker',
      messageId: 'input1',
      contextId: 'context1',
    },
  })
  const out = join(f.root, 'report.json')
  const args = [
    '--sessions',
    f.sessions,
    '--node',
    'node1',
    '--audit',
    f.auditFile,
    '--out',
    out,
  ]
  expect(main(args)).toBe(0)
  expect(JSON.parse(readFileSync(out, 'utf8')).coverage.calls).toBe(1)
  expect(() => main(args)).toThrow()
  const changed = JSON.stringify({ ...f.binding.config, edits: 'none' })
  f.audit.append({
    at: 1190,
    node: 'node1',
    source: AuditSource.Resident,
    kind: 'authz.posture',
    outcome: 'ok',
    detail: {
      sessionId: 'sess',
      agent: 'worker',
      approvalMode: 'always-ask',
      policy: changed,
      configHash: createHash('sha256').update(changed).digest('hex'),
      stateRoots: JSON.stringify([f.state]),
      home: homedir(),
      configDir: f.state,
      qmcodeHome: join(f.root, 'qmcode'),
    },
  })
  expect(
    rejudgeNode({
      sessions: f.sessions,
      node: 'node1',
      auditFiles: [f.auditFile],
    }).findings.some(r => r.category === 'tool-allowlist'),
  ).toBe(true)
})

test('duplicating a consumed allow-once grant_used cannot approve another call', () => {
  const f = fixture()
  const input = { path: join(f.root, 'outside'), content: 'ok' }
  f.transcript('write', input)
  f.transcript('write', input, { file: 'second.jsonl' })
  f.grant('write', input)
  const digest = authzDigest({
    node: 'node1',
    agent: 'worker',
    contextId: 'context1',
    toolName: 'write',
    input: residentApprovalInput({ toolName: 'write', input }, f.workspace),
  })
  f.audit.append({
    at: 1401,
    node: 'node1',
    taskId: 'task1',
    source: AuditSource.Resident,
    kind: 'authz.grant_used',
    outcome: 'ok',
    detail: {
      requestId: 'request1',
      contextId: 'context1',
      tool: 'write',
      digest,
      expiresAt: 2000,
      approver: 'operator',
      scope: 'once',
    },
  })
  expect(rejudge(f.options).coverage.matchedGrants).toBe(1)
})
