// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditTrail, AuditSource } from '@qianmo/audit'
import type { ResidentAuthzEvent } from '../../src/host/residentAuthorization.js'
import { rejudgeNode } from '../../../../scripts/authz-rejudge/node.js'
import { FileMemoryStore } from '@qianmo/memory'
import { residentMemoryScope } from '@qianmo/resident'
import { AccountBook, type ApprovalItem } from '@qianmo/console'
import {
  generateNodeKeyPair,
  issueCapability,
  NodeCapabilities,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import {
  CapabilityLevel,
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { QianmoResident } from '../../src/host/resident.js'
import { ConsoleApprovals } from '../../src/commands/consoleApprovals.js'
import { FileLedger } from '../../src/commands/consoleAccountsStore.js'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'

async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 20_000
  while (!(await predicate())) {
    if (Date.now() >= end)
      throw new Error('resident approval condition timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('real omp outside write waits for personal approval on a separate signed console link; protected paths remain denied', async () => {
  const previous = process.env.QIANMO_CONFIG_DIR
  const root = mkdtempSync(join(tmpdir(), 'qm-approval-e2e-'))
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const workspace = join(root, 'workspace'),
    outside = join(root, 'approved.txt')
  mkdirSync(workspace)
  const harness = new ResidentOmpHarness()
  harness.script([
    {
      name: 'write',
      input: { path: outside, content: 'approved exact content' },
    },
  ])
  const commandKeys = generateNodeKeyPair(),
    nodeKeys = generateNodeKeyPair(),
    approvalKeys = generateNodeKeyPair()
  const directory = new StaticPublicKeyDirectory([
    ['hub', commandKeys.publicKey],
    ['worker', nodeKeys.publicKey],
  ])
  const book = new AccountBook({
    accounts: new FileLedger(join(root, 'accounts.ndjson')),
    sessions: new FileLedger(join(root, 'sessions.ndjson')),
  })
  const account = book.registerMember(10)
  if (!account.ok) throw new Error('could not create test account')
  const login = book.bearerPrincipal(account.value.credential)
  if (!login.ok) throw new Error('could not authenticate test account')
  expect(book.recordOwner('approval-chat', account.value.subject).ok).toBe(true)
  let url: string | undefined
  const errors: unknown[] = []
  const trail = new AuditTrail(join(root, 'node-audit.ndjson'))
  const audit = (event: ResidentAuthzEvent) => {
    trail.append({
      at: Date.now(),
      node: 'worker',
      source: AuditSource.Resident,
      kind: event.kind,
      outcome: event.kind === 'authz.refused' ? 'refused' : 'ok',
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
      detail: event.detail,
    })
  }
  const resident = new QianmoResident({
    node: 'worker',
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: workspace }],
    allowWorkspaceEdits: true,
    psk: 'approval-e2e-local-psk-00000000000',
    listen: { hostname: '127.0.0.1', port: 0 },
    pollIntervalMs: 20,
    inactivityMs: 30_000,
    handshakeSigning: {
      node: 'worker',
      keys: nodeKeys,
      directory,
      required: true,
    },
    capability: new NodeCapabilities({
      node: 'worker',
      directory,
      keys: nodeKeys,
      trustedIssuers: ['hub'],
    }),
    runtimeAudit: audit,
    authorization: {
      audit,
      keys: nodeKeys,
      approvers: new Map([['hub', approvalKeys.publicKey]]),
      commanderKeys: () => [commandKeys.publicKey],
    },
    onReady: address => {
      url = address.url
    },
    onError: error => errors.push(error),
  })
  const running = resident.run()
  let hub: ConsoleApprovals | undefined, client: TransportClient | undefined
  try {
    await until(() => url !== undefined)
    hub = new ConsoleApprovals({
      from: 'qianmo://hub/console',
      accounts: book,
      commandKeys,
      approvalKeys,
      targets: [
        {
          node: 'worker',
          url: url!,
          psk: 'approval-e2e-local-psk-00000000000',
          publicKey: nodeKeys.publicKey,
        },
      ],
      ledger: new FileLedger(join(root, 'approvals.ndjson')),
      onError: error => errors.push(error),
    })
    hub.start()
    const received: QianmoMessage[] = []
    client = new TransportClient({
      endpoint: { url: url! },
      node: 'hub',
      peerNode: 'worker',
      psk: 'approval-e2e-local-psk-00000000000',
      signing: { keys: commandKeys, directory, required: true },
      onMessage: message => {
        received.push(message)
      },
    })
    await client.connect()
    const send = async () => {
      const taskId = randomUUID(),
        now = Date.now()
      const cap = issueCapability('hub', commandKeys, {
        sub: 'qianmo://worker/reviewer',
        aud: 'worker',
        act: CapabilityLevel.WriteLimited,
        taskId,
        nbf: now - 100,
        exp: now + 60_000,
      })
      await client!.sendAndWait(
        createMessage({
          type: MessageType.TaskRequest,
          from: 'qianmo://hub/console',
          to: 'qianmo://worker/reviewer',
          contextId: 'approval-chat',
          payload: { prompt: 'Execute the scripted file operation.' },
          taskId,
          cap,
          createdAt: now,
          hops: ['hub'],
        }),
      )
      return taskId
    }
    const taskId = await send()
    let pending: ApprovalItem | undefined
    await until(async () => {
      const list = await hub!.list(login.value)
      pending = list.ok
        ? list.value.find(row => row.status === 'pending')
        : undefined
      return pending !== undefined
    })
    expect(existsSync(outside)).toBe(false)
    expect(pending!.toolName).toBe('write')
    expect(pending!.input).toMatchObject({
      path: outside,
      content: 'approved exact content',
    })
    expect(
      await hub.decide(login.value, {
        requestId: pending!.requestId,
        digest: pending!.digest,
        decision: 'allow-once',
      }),
    ).toEqual({ ok: true, value: { delivered: true } })
    await until(() =>
      received.some(
        row => row.type === MessageType.TaskResult && row.taskId === taskId,
      ),
    )
    expect(readFileSync(outside, 'utf8')).toBe('approved exact content')
    expect(
      received.find(
        row => row.type === MessageType.TaskResult && row.taskId === taskId,
      )?.payload,
    ).toMatchObject({ outcome: 'completed', content: 'pong' })
    // Freeze the approved turn before the deliberately denied turn appends.
    const acquisition = join(root, 'rejudge-acquisition')
    mkdirSync(acquisition)
    cpSync(
      join(root, 'config', 'resident', 'sessions'),
      join(acquisition, 'sessions'),
      { recursive: true },
    )
    cpSync(trail.path, join(acquisition, 'node-audit.ndjson'))
    const report = rejudgeNode({
      sessions: join(acquisition, 'sessions'),
      node: 'worker',
      auditFiles: [join(acquisition, 'node-audit.ndjson')],
    })
    writeFileSync(
      join(acquisition, 'rejudge.json'),
      JSON.stringify(report, null, 2),
    )
    console.info(`Real approval replay acquisition: ${acquisition}`)
    expect(report.findings).toEqual([])
    expect(report.passed).toBe(true)
    expect(report.coverage).toMatchObject({
      ask: 1,
      matchedGrants: 1,
      successful: 1,
    })
    const protectedPath = join(root, 'config', 'secret.txt')
    harness.script([
      { name: 'write', input: { path: protectedPath, content: 'forbidden' } },
    ])
    const blockedTask = await send()
    await until(() =>
      received.some(
        row =>
          row.type === MessageType.TaskResult && row.taskId === blockedTask,
      ),
    )
    expect(existsSync(protectedPath)).toBe(false)
    const final = await hub.list(login.value)
    expect(final.ok && final.value.length).toBe(1)
    const memory = new FileMemoryStore({
      root: join(root, 'config', 'memory'),
      readOnly: true,
    })
    const proposal = {
      title: 'approved fact',
      summary: 'only for this context',
      body: 'approved durable memory',
      tags: ['test'],
    }
    harness.script([{ name: 'qianmo_memory_write', input: proposal }])
    const memoryTask = await send()
    let memoryRequest: ApprovalItem | undefined
    await until(async () => {
      const list = await hub!.list(login.value)
      memoryRequest = list.ok
        ? list.value.find(
            row =>
              row.status === 'pending' &&
              row.toolName === 'qianmo_memory_write',
          )
        : undefined
      return memoryRequest !== undefined
    })
    expect(memory.query()).toHaveLength(0)
    expect(
      (
        await hub.decide(login.value, {
          requestId: memoryRequest!.requestId,
          digest: memoryRequest!.digest,
          decision: 'allow-window',
          windowMs: 60_000,
        })
      ).ok,
    ).toBe(false)
    expect(memory.query()).toHaveLength(0)
    expect(
      (
        await hub.decide(login.value, {
          requestId: memoryRequest!.requestId,
          digest: memoryRequest!.digest,
          decision: 'allow-once',
        })
      ).ok,
    ).toBe(true)
    await until(() =>
      received.some(
        row => row.type === MessageType.TaskResult && row.taskId === memoryTask,
      ),
    )
    const written = memory.query()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      body: proposal.body,
      scope: residentMemoryScope({
        agent: 'reviewer',
        contextId: 'approval-chat',
      }),
      source: { kind: 'agent', id: memoryRequest!.requestId },
    })
    // The same tool arguments still require a new approval for another write.
    harness.script([{ name: 'qianmo_memory_write', input: proposal }])
    const deniedMemoryTask = await send()
    let another: ApprovalItem | undefined
    await until(async () => {
      const list = await hub!.list(login.value)
      another = list.ok
        ? list.value.find(
            row =>
              row.status === 'pending' &&
              row.toolName === 'qianmo_memory_write',
          )
        : undefined
      return another !== undefined
    })
    expect(another!.requestId).not.toBe(memoryRequest!.requestId)
    expect(memory.query()).toHaveLength(1)
    expect(
      (
        await hub.decide(login.value, {
          requestId: another!.requestId,
          digest: another!.digest,
          decision: 'deny',
        })
      ).ok,
    ).toBe(true)
    await until(() =>
      received.some(
        row =>
          row.type === MessageType.TaskResult &&
          row.taskId === deniedMemoryTask,
      ),
    )
    expect(memory.query()).toHaveLength(1)
    expect(errors).toEqual([])
  } finally {
    await hub?.close()
    await client?.close()
    resident.stop()
    await running
    await harness.stop()
    trail.close()
    if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = previous
  }
}, 60_000)
