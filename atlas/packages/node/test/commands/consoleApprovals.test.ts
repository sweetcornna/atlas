// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signAuthzRequest,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import {
  AccountBook,
  type ConsolePrincipal,
  type LedgerPort,
} from '@qianmo/console'
import {
  FileGrantStore,
  ResidentEstop,
  ResidentHardline,
} from '@qianmo/resident'
import { createMessage, MessageType } from '@qianmo/protocol'
import { startTransportServer, type TransportChannel } from '@qianmo/transport'
import { ConsoleApprovals } from '../../src/commands/consoleApprovals.js'
import { FileLedger } from '../../src/commands/consoleAccountsStore.js'
import {
  loadConsoleApproverIdentity,
  consoleApproverIdentityPath,
} from '../../src/commands/consoleApproverIdentity.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'

function ledger(): LedgerPort {
  let value = ''
  return {
    path: 'memory://test-ledger',
    read: () => value,
    append: line => {
      value += line
    },
  }
}
function person(
  book: AccountBook,
): Extract<ConsolePrincipal, { kind: 'user' }> {
  const created = book.registerMember(20)
  if (!created.ok) throw new Error('registration failed')
  const result = book.bearerPrincipal(created.value.credential)
  if (!result.ok || result.value.kind !== 'user')
    throw new Error('login failed')
  return result.value
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 3_000
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('approval flags require accounts, signed named targets and locally pinned keys', () => {
  const key = generateNodeKeyPair().publicKey
  expect(
    parseConsoleArgs(['--print-approver-identity']).printApproverIdentity,
  ).toBe(true)
  for (const args of [
    [],
    ['--accounts'],
    ['--accounts', '--chat-sign'],
    ['--accounts', '--chat-sign', '--chat-url', 'n=ws://127.0.0.1:39999'],
  ])
    expect(() => parseConsoleArgs(['--approvals', ...args])).toThrow()
  expect(
    parseConsoleArgs([
      '--approvals',
      '--accounts',
      '--chat-sign',
      '--chat-url',
      'n=ws://127.0.0.1:39999',
      '--trust',
      `n=${key}`,
    ]).approvals,
  ).toBe(true)
  expect(() =>
    parseConsoleArgs([
      '--open-registration',
      '--accounts',
      '--tenancy',
      '/tmp/tenants.json',
    ]),
  ).toThrow()
  expect(
    parseConsoleArgs([
      '--open-registration',
      '--accounts',
      '--tenancy',
      '/tmp/tenants.json',
      '--registration-max-accounts',
      '3',
      '--usage-policy',
      '/tmp/usage.json',
    ]).openRegistration,
  ).toEqual({ maxAccounts: 3 })
})

test('approval identity is separate, persistent, private and refuses corrupt or broad-permission files', () => {
  const from = `qianmo://k${Date.now().toString(36)}/console`
  const first = loadConsoleApproverIdentity(from)
  expect(loadConsoleApproverIdentity(from)).toEqual(first)
  const path = consoleApproverIdentityPath(first.node),
    raw = readFileSync(path, 'utf8')
  chmodSync(path, 0o644)
  expect(() => loadConsoleApproverIdentity(from)).toThrow('0600')
  chmodSync(path, 0o600)
  writeFileSync(path, '{broken')
  expect(() => loadConsoleApproverIdentity(from)).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('{broken')
  writeFileSync(path, raw)
})

test('real signed transport + FileGrantStore: ownership, digest, freshness, one-use and durable account revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-console-authz-'))
  const nodeKeys = generateNodeKeyPair(),
    commander = generateNodeKeyPair(),
    approvalKeys = generateNodeKeyPair()
  const book = new AccountBook({ accounts: ledger(), sessions: ledger() }),
    alice = person(book),
    bob = person(book)
  expect(book.recordOwner('owned-chat', alice.subject).ok).toBe(true)
  const grants = new FileGrantStore({
    path: join(root, 'protected', 'node-authz.ndjson'),
    node: 'worker',
    approvers: new Map([['hub', approvalKeys.publicKey]]),
    commanderKeys: () => [commander.publicKey],
    hardline: new ResidentHardline({ stateRoots: [join(root, 'protected')] }),
    estop: new ResidentEstop({ path: join(root, 'ESTOP') }),
  })
  const ask = (content: string, toolName = 'Write') => {
    const call = {
      agent: 'main',
      contextId: 'owned-chat',
      toolName,
      input: { file_path: join(root, 'outside.txt'), content },
    }
    const result = grants.ask({
      ...call,
      origin: {
        from: 'qianmo://hub/console',
        taskId: null,
        traceId: null,
        trust: 'untrusted',
      },
    })
    if (result.kind !== 'pending') throw new Error('not pending')
    return { call, request: result.request }
  }
  const first = ask('first')
  let channel: TransportChannel | undefined
  let decisions = 0,
    revocations = 0,
    refuseDecisions = false
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: 'approval-integration-psk-000000000000000',
    signing: {
      node: 'worker',
      keys: nodeKeys,
      directory: new StaticPublicKeyDirectory([['hub', commander.publicKey]]),
      required: true,
    },
    supportedTypes: [
      MessageType.AuthzRequest,
      MessageType.AuthzDecision,
      MessageType.AuthzRevoke,
    ],
    onMessage: (message, context) => {
      channel = context.channel
      const payload = message.payload as Record<string, unknown>
      if (message.type === MessageType.AuthzDecision) {
        if (refuseDecisions) throw new Error('forced unavailable')
        if (!grants.applyDecision(payload['decision']).ok)
          throw new Error('refused decision')
        decisions++
      } else if (message.type === MessageType.AuthzRevoke) {
        if (!grants.applyRevoke(payload['revoke']).ok)
          throw new Error('refused revoke')
        revocations++
      } else if (message.type === MessageType.AuthzRequest) {
        context.channel.send(
          createMessage({
            from: 'qianmo://worker/main',
            to: 'qianmo://hub/console',
            type: MessageType.AuthzRequest,
            payload: { request: signAuthzRequest(nodeKeys, first.request) },
            hops: ['worker'],
          }),
        )
      }
    },
  })
  const options = {
    from: 'qianmo://hub/console',
    accounts: book,
    commandKeys: commander,
    approvalKeys,
    targets: [
      {
        node: 'worker',
        url: server.url!,
        psk: 'approval-integration-psk-000000000000000',
        publicKey: nodeKeys.publicKey,
      },
    ],
    ledger: new FileLedger(join(root, 'console-authz.ndjson')),
  }
  let hub = new ConsoleApprovals(options)
  try {
    hub.start()
    await until(async () => {
      const list = await hub.list(alice)
      return list.ok && list.value.length === 1
    })
    expect(await hub.list(bob)).toEqual({ ok: true, value: [] })
    const forged = ask('forged')
    await expect(
      channel!.sendAndWait(
        createMessage({
          from: 'qianmo://worker/main',
          to: options.from,
          type: MessageType.AuthzRequest,
          payload: {
            request: signAuthzRequest(generateNodeKeyPair(), forged.request),
          },
          hops: ['worker'],
        }),
      ),
    ).rejects.toThrow()
    const afterForgery = await hub.list(alice)
    expect(afterForgery.ok && afterForgery.value.length).toBe(1)
    const input = {
      requestId: first.request.requestId,
      digest: first.request.digest,
      decision: 'allow-once' as const,
    }
    expect(
      (await hub.decide({ ...alice, credential: 'session' }, input)).ok,
    ).toBe(false)
    expect((await hub.decide(bob, input)).ok).toBe(false)
    expect(
      (
        await hub.decide(
          { ...alice, authenticatedAt: Date.now() - 1_800_001 },
          input,
        )
      ).ok,
    ).toBe(false)
    expect(
      (await hub.decide(alice, { ...input, digest: '0'.repeat(64) })).ok,
    ).toBe(false)
    expect(decisions).toBe(0)
    expect(await hub.decide(alice, input)).toEqual({
      ok: true,
      value: { delivered: true },
    })
    expect(grants.use(first.call).kind).toBe('hit')
    expect(grants.use(first.call).kind).toBe('miss')
    expect((await hub.decide(alice, input)).ok).toBe(false)
    const second = ask('second')
    await channel!.sendAndWait(
      createMessage({
        from: 'qianmo://worker/main',
        to: options.from,
        type: MessageType.AuthzRequest,
        payload: { request: signAuthzRequest(nodeKeys, second.request) },
        hops: ['worker'],
      }),
    )
    expect(
      (
        await hub.decide(alice, {
          requestId: second.request.requestId,
          digest: second.request.digest,
          decision: 'allow-window',
          windowMs: 300_000,
        })
      ).ok,
    ).toBe(true)
    expect(grants.use(second.call).kind).toBe('hit')
    // Conservative restart invalidates previous windows, even if an account reset
    // committed just before a crash interrupted its fanout.
    await hub.close()
    hub = new ConsoleApprovals({
      ...options,
      ledger: new FileLedger(join(root, 'console-authz.ndjson')),
    })
    hub.start()
    await until(() => revocations >= 2)
    expect(grants.use(second.call).kind).toBe('miss')
    expect(decisions).toBe(2)
    const third = ask('third')
    await channel!.sendAndWait(
      createMessage({
        from: 'qianmo://worker/main',
        to: options.from,
        type: MessageType.AuthzRequest,
        payload: { request: signAuthzRequest(nodeKeys, third.request) },
        hops: ['worker'],
      }),
    )
    expect(
      (
        await hub.decide(alice, {
          requestId: third.request.requestId,
          digest: third.request.digest,
          decision: 'allow-window',
          windowMs: 60_000,
        })
      ).ok,
    ).toBe(true)
    const failed = ask('failed-delivery')
    await channel!.sendAndWait(
      createMessage({
        from: 'qianmo://worker/main',
        to: options.from,
        type: MessageType.AuthzRequest,
        payload: { request: signAuthzRequest(nodeKeys, failed.request) },
        hops: ['worker'],
      }),
    )
    refuseDecisions = true
    expect(
      (
        await hub.decide(alice, {
          requestId: failed.request.requestId,
          digest: failed.request.digest,
          decision: 'allow-window',
          windowMs: 60_000,
        })
      ).ok,
    ).toBe(false)
    const unknown = await hub.list(alice)
    expect(
      unknown.ok &&
        unknown.value.find(row => row.requestId === failed.request.requestId)
          ?.status,
    ).toBe('delivery-unknown')
    expect(grants.use(failed.call).kind).toBe('miss')
    refuseDecisions = false
    const memory = ask('memory-once', 'qianmo_memory_write')
    await channel!.sendAndWait(
      createMessage({
        from: 'qianmo://worker/main',
        to: options.from,
        type: MessageType.AuthzRequest,
        payload: { request: signAuthzRequest(nodeKeys, memory.request) },
        hops: ['worker'],
      }),
    )
    const decisionsBefore = decisions
    const ledgerBefore = readFileSync(
      join(root, 'console-authz.ndjson'),
      'utf8',
    )
    const rejected = await hub.decide(alice, {
      requestId: memory.request.requestId,
      digest: memory.request.digest,
      decision: 'allow-window',
      windowMs: 60_000,
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.failure.message).toContain('逐次批准')
    expect(decisions).toBe(decisionsBefore)
    expect(readFileSync(join(root, 'console-authz.ndjson'), 'utf8')).toBe(
      ledgerBefore,
    )
    expect(grants.use(memory.call).kind).toBe('miss')
    const pendingMemory = await hub.list(alice)
    expect(
      pendingMemory.ok &&
        pendingMemory.value.find(
          row => row.requestId === memory.request.requestId,
        )?.status,
    ).toBe('pending')
    expect(
      (
        await hub.decide(alice, {
          requestId: memory.request.requestId,
          digest: memory.request.digest,
          decision: 'allow-once',
        })
      ).ok,
    ).toBe(true)
    expect(grants.use(memory.call).kind).toBe('hit')
    expect(grants.use(memory.call).kind).toBe('miss')
    expect(book.revoke(alice.subject, 'legacy:admin').ok).toBe(true)
    await until(() => revocations >= 4)
    expect(grants.use(third.call).kind).toBe('miss')
    expect(
      (
        await hub.decide(alice, {
          requestId: third.request.requestId,
          digest: third.request.digest,
          decision: 'deny',
        })
      ).ok,
    ).toBe(false)
  } finally {
    await hub.close()
    await server.stop()
    grants.close()
  }
}, 15_000)
