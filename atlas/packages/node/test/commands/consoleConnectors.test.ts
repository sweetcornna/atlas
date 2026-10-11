// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import {
  AccountBook,
  type ConsolePrincipal,
  type LedgerPort,
  type DirectionActor,
} from '@qianmo/console'
import { ResidentEstop } from '@qianmo/resident'
import {
  createMessage,
  MessageType,
  type ControlOutcome,
} from '@qianmo/protocol'
import { startTransportServer, type TransportChannel } from '@qianmo/transport'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { ConsoleApprovals } from '../../src/commands/consoleApprovals.js'
import {
  ConsoleConnectors,
  type ConsoleConnectorsOptions,
} from '../../src/commands/consoleConnectors.js'
import { ResidentAuthorization } from '../../src/host/residentAuthorization.js'
import { connectorTools } from '../../src/host/connectorTools.js'
import { ConnectorVault } from '../../src/connectors/secrets.js'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import { createIcs } from '../../src/connectors/calendar.js'
import { mailFixture } from '../connectors/mailFixture.js'
import { CERT, KEY } from '../connectors/fixtures.js'

function value<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T {
  if (!result.ok) throw new Error('fixture operation refused')
  return result.value
}
function ledger(): LedgerPort {
  let text = ''
  return {
    path: 'memory://p25',
    read: () => text,
    append: line => {
      text += line
    },
  }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture timeout')
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 5)
    await promise
  }
}
const actor: DirectionActor = {
  subject: 'u:0123456789abcdef',
  role: 'ops',
  requestId: 'request',
}

test('signed P14 + host tools + TLS fixtures: no approval means zero sends; exact single approval, tampering, replay and unknown outcomes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-'))
  const fixtureOptions = { validity: '42', unknown: false },
    mail = await mailFixture(fixtureOptions)
  const nodeKeys = generateNodeKeyPair(),
    commandKeys = generateNodeKeyPair(),
    approvalKeys = generateNodeKeyPair()
  const accounts = new AccountBook({ accounts: ledger(), sessions: ledger() })
  const registered = value(accounts.registerMember(5))
  const alice = value(
    accounts.bearerPrincipal(registered.credential),
  ) as Extract<ConsolePrincipal, { kind: 'user' }>
  value(accounts.recordOwner('owned-context', alice.subject))
  let channel: TransportChannel | undefined
  const nodeAuth = new ResidentAuthorization({
    node: 'worker',
    keys: nodeKeys,
    approvers: new Map([['hub', approvalKeys.publicKey]]),
    commanderKeys: () => [commandKeys.publicKey],
    memoryRoot: path.join(root, 'memory'),
    estop: new ResidentEstop({ path: path.join(root, 'ESTOP') }),
  })
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: 'p25-approval-fixture-0000000000000',
    signing: {
      node: 'worker',
      keys: nodeKeys,
      directory: new StaticPublicKeyDirectory([['hub', commandKeys.publicKey]]),
      required: true,
    },
    supportedTypes: [
      MessageType.AuthzRequest,
      MessageType.AuthzDecision,
      MessageType.AuthzRevoke,
    ],
    onMessage(message, ctx) {
      channel = ctx.channel
      const payload = message.payload as Record<string, unknown>
      if (
        message.type === MessageType.AuthzDecision &&
        !nodeAuth.decision(payload['decision'])
      )
        throw new Error('node refused decision')
      if (
        message.type === MessageType.AuthzRevoke &&
        !nodeAuth.revoke(payload['revoke'])
      )
        throw new Error('node refused revoke')
    },
  })
  const approvalLedger = ledger()
  const approvals = new ConsoleApprovals({
    from: 'qianmo://hub/console',
    accounts,
    commandKeys,
    approvalKeys,
    ledger: approvalLedger,
    targets: [
      {
        node: 'worker',
        url: server.url!,
        psk: 'p25-approval-fixture-0000000000000',
        publicKey: nodeKeys.publicKey,
      },
    ],
  })
  const options: ConsoleConnectorsOptions = {
    directory: path.join(root, 'connections'),
    policy: mail.policy,
    agents: async () => ['qianmo://worker/main'],
    approvals,
  }
  let book = new ConsoleConnectors(options)
  const calendarWrites: string[] = []
  const calendar = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: KEY, cert: CERT },
    async fetch(request) {
      if (request.method === 'PUT') {
        calendarWrites.push(await request.text())
        return new Response(null, { status: 201 })
      }
      if (new URL(request.url).pathname === '/ics')
        return new Response(
          createIcs('existing', {
            title: 'Read-only',
            start: '2026-10-11T12:00:00Z',
            end: '2026-10-11T13:00:00Z',
          }),
        )
      return new Response(
        '<d:response><d:href>/calendar/</d:href><d:resourcetype><c:calendar/></d:resourcetype></d:response>',
        { status: 207 },
      )
    },
  })
  let allow = false,
    windowRefused = false,
    tamper = false
  const captured: {
    op: string
    args: Record<string, unknown>
    callId: string
  }[] = []
  const tools = connectorTools({
    call: async (op, args, ctx) => {
      if (ctx.callId) captured.push({ op, args, callId: ctx.callId })
      return book.handle(
        op,
        tamper && op === 'connector.mail.send'
          ? { ...args, subject: 'changed after approval' }
          : args,
        {
          node: 'worker',
          agent: ctx.agent,
          callId: ctx.callId ?? crypto.randomUUID(),
        },
      )
    },
    approve: async (ctx, toolName, input) => {
      let requestId: string | undefined
      const approved = await nodeAuth.request(
        { agent: ctx.agent, contextId: 'owned-context', toolName, input },
        {
          from: 'qianmo://hub/console',
          taskId: null,
          traceId: null,
          trust: 'verified-capability',
        },
        Date.now() + 3000,
        30000,
        (request, wire) => {
          requestId = request.requestId
          void channel!
            .sendAndWait(
              createMessage({
                from: request.sub,
                to: 'qianmo://hub/console',
                type: MessageType.AuthzRequest,
                payload: { request: wire },
                contextId: request.contextId,
                hops: ['worker'],
              }),
            )
            .then(async () => {
              const rejected = await approvals.decide(alice, {
                requestId: request.requestId,
                digest: request.digest,
                decision: 'allow-window',
                windowMs: 1000,
              })
              windowRefused = !rejected.ok
              await approvals.decide(alice, {
                requestId: request.requestId,
                digest: request.digest,
                decision: allow ? 'allow-once' : 'deny',
              })
            })
        },
      )
      return approved && requestId
        ? { contextId: 'owned-context', requestId }
        : null
    },
  })
  const run = async (name: string, args: Record<string, unknown>) =>
    tools
      .find(v => v.name === name)!
      .handler(args, { agent: 'main', sessionId: 'fixture' })
  try {
    approvals.start()
    await until(() => channel !== undefined)
    const connector = value(
      await book.save(
        {
          name: 'Fixture Mail',
          kind: 'mail',
          preset: 'custom-mail',
          settings: mail.settings,
          secret: 'fixture-hidden-password',
          agents: ['qianmo://worker/main'],
        },
        actor,
      ),
    )
    expect(value(await book.probe(connector.id, actor)).lastProbe?.ok).toBe(
      true,
    )
    expect(mail.messages).toHaveLength(0)
    const payload = {
      connectorId: connector.id,
      to: ['recipient@example.net'],
      subject: 'Hello',
      body: 'private body',
    }
    const deniedCommandCount = mail.commands.length
    expect((await run('qianmo_mail_send', payload)).ok).toBe(false)
    expect(mail.commands).toHaveLength(deniedCommandCount)
    expect(mail.messages).toHaveLength(0)
    expect(windowRefused).toBe(true)
    allow = true
    expect((await run('qianmo_mail_send', payload)).ok).toBe(true)
    expect(mail.messages).toHaveLength(1)
    const sent = captured.at(-1)!
    expect(
      (
        await book.handle(sent.op, sent.args, {
          node: 'worker',
          agent: 'main',
          callId: sent.callId,
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await book.handle(sent.op, sent.args, {
          node: 'foreign',
          agent: 'main',
          callId: sent.callId,
        })
      ).ok,
    ).toBe(false)
    expect(mail.messages).toHaveLength(1)
    tamper = true
    expect((await run('qianmo_mail_send', payload)).ok).toBe(false)
    expect(mail.messages).toHaveLength(1)
    const unusedApproval = captured.at(-1)!
    tamper = false
    expect(
      (
        await run('qianmo_mail_send', {
          ...payload,
          subject: 'valid\r\nBcc: evil@example.net',
        })
      ).ok,
    ).toBe(false)
    expect(mail.messages).toHaveLength(1)
    const search = await book.handle(
      'connector.mail.search',
      { connectorId: connector.id },
      { node: 'worker', agent: 'main', callId: crypto.randomUUID() },
    )
    expect(search.ok).toBe(true)
    const handle = (
      (search as Extract<ControlOutcome, { ok: true }>).value as {
        id: string
      }[]
    )[0]!.id
    expect(
      (
        await book.handle(
          'connector.mail.read',
          { connectorId: connector.id, id: handle },
          { node: 'worker', agent: 'main', callId: crypto.randomUUID() },
        )
      ).ok,
    ).toBe(true)
    fixtureOptions.validity = '43'
    expect(
      (
        await book.handle(
          'connector.mail.read',
          { connectorId: connector.id, id: handle },
          { node: 'worker', agent: 'main', callId: crypto.randomUUID() },
        )
      ).ok,
    ).toBe(false)
    value(
      await book.save(
        {
          id: connector.id,
          name: 'Renamed',
          kind: 'mail',
          preset: 'custom-mail',
          settings: {},
          agents: ['qianmo://worker/main'],
        },
        actor,
      ),
    )
    expect(
      (
        await book.handle(
          'connector.mail.read',
          { connectorId: connector.id, id: handle },
          { node: 'worker', agent: 'main', callId: crypto.randomUUID() },
        )
      ).ok,
    ).toBe(false)
    expect(
      (
        await book.handle(unusedApproval.op, unusedApproval.args, {
          node: 'worker',
          agent: 'main',
          callId: unusedApproval.callId,
        })
      ).ok,
    ).toBe(false)
    expect(mail.messages).toHaveLength(1)
    fixtureOptions.unknown = true
    expect((await run('qianmo_mail_send', payload)).ok).toBe(false)
    expect(mail.messages).toHaveLength(2)
    const unknown = captured.at(-1)!
    expect(
      (
        await book.handle(unknown.op, unknown.args, {
          node: 'worker',
          agent: 'main',
          callId: unknown.callId,
        })
      ).ok,
    ).toBe(false)
    expect(mail.messages).toHaveLength(2)
    const secrets = fs.readFileSync(
      path.join(root, 'connections', 'connectors.json'),
      'utf8',
    )
    expect(secrets).not.toContain('fixture-hidden-password')
    expect(
      fs.statSync(path.join(root, 'connections', 'connectors.json')).mode &
        0o777,
    ).toBe(0o600)
    const audit = fs.readFileSync(
      path.join(root, 'connections', 'connector-audit.ndjson'),
      'utf8',
    )
    expect(audit).toContain('connector.mail.send')
    expect(audit).toContain('example.net')
    expect(audit).not.toContain('recipient@example.net')
    expect(audit).not.toContain('private body')
    expect(audit).not.toContain('fixture-hidden-password')
    book.close()
    book = new ConsoleConnectors(options)
    expect(
      (
        await book.handle(sent.op, sent.args, {
          node: 'worker',
          agent: 'main',
          callId: sent.callId,
        })
      ).ok,
    ).toBe(false)
    const calPolicy = new OutboundPolicy({
      ca: CERT,
      allowAddresses: ['127.0.0.1'],
      allowPorts: [{ protocol: 'https', port: calendar.port! }],
    })
    book.close()
    book = new ConsoleConnectors({ ...options, policy: calPolicy })
    const cal = value(
      await book.save(
        {
          name: 'Calendar',
          kind: 'calendar',
          preset: 'custom-caldav',
          settings: {
            caldavUrl: calendar.url.toString(),
            username: 'fixture-user',
          },
          secret: 'calendar-hidden-password',
          agents: ['qianmo://worker/main'],
        },
        actor,
      ),
    )
    const event = {
      connectorId: cal.id,
      title: 'Approved',
      start: '2026-10-11T12:00:00Z',
      end: '2026-10-11T13:00:00Z',
    }
    allow = false
    expect((await run('qianmo_calendar_create', event)).ok).toBe(false)
    expect(calendarWrites).toHaveLength(0)
    allow = true
    expect((await run('qianmo_calendar_create', event)).ok).toBe(true)
    expect(calendarWrites).toHaveLength(1)
    const created = captured.at(-1)!
    expect(
      (
        await book.handle(created.op, created.args, {
          node: 'worker',
          agent: 'main',
          callId: created.callId,
        })
      ).ok,
    ).toBe(false)
    expect(calendarWrites).toHaveLength(1)
    const feedUrl = new URL(
      '/ics?token=whole-secret-url',
      calendar.url,
    ).toString()
    const feed = value(
      await book.save(
        {
          name: 'Feed',
          kind: 'calendar',
          preset: 'ics',
          settings: {},
          secret: feedUrl,
          agents: ['qianmo://worker/main'],
        },
        actor,
      ),
    )
    expect(
      (
        await run('qianmo_calendar_events', {
          connectorId: feed.id,
          from: event.start,
          to: '2026-10-12T00:00:00Z',
        })
      ).ok,
    ).toBe(true)
    expect(
      (await run('qianmo_calendar_create', { ...event, connectorId: feed.id }))
        .ok,
    ).toBe(false)
    expect(
      (
        await book.handle(
          'connector.calendar.create',
          { ...event, connectorId: feed.id },
          { node: 'worker', agent: 'main', callId: crypto.randomUUID() },
        )
      ).ok,
    ).toBe(false)
    expect(calendarWrites).toHaveLength(1)
    expect(JSON.stringify(value(await book.snapshot()))).not.toContain(
      'whole-secret-url',
    )
    expect(
      fs.readFileSync(
        path.join(root, 'connections', 'connectors.json'),
        'utf8',
      ),
    ).not.toContain(feedUrl)
    value(await book.remove(feed.id, actor))
    expect(
      value(await book.snapshot()).connectors.some(v => v.id === feed.id),
    ).toBe(false)
    expect(
      JSON.stringify(
        await book.handle(
          'connector.mail.read',
          { connectorId: connector.id, id: 'bad' },
          { node: 'worker', agent: 'main', callId: crypto.randomUUID() },
        ),
      ),
    ).not.toContain('fixture-hidden-password')
    expect(
      (
        await book.handle(
          'connector.mail.read',
          { connectorId: 'secret-url-not-a-connector', id: 'bad' },
          { node: 'worker', agent: 'main', callId: crypto.randomUUID() },
        )
      ).ok,
    ).toBe(false)
    const refusalAudit = fs.readFileSync(
      path.join(root, 'connections', 'connector-audit.ndjson'),
      'utf8',
    )
    expect(refusalAudit).not.toContain('secret-url-not-a-connector')
    expect(
      JSON.parse(refusalAudit.trim().split('\n').at(-1)!).detail.result,
    ).toBe('refused')
  } finally {
    book.close()
    await approvals.close()
    nodeAuth.close()
    await server.stop()
    mail.close()
    calendar.stop(true)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('connector vault refuses slot, id, revision swaps and missing/wide master keys; connection writes enforce actor and tenant', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-vault-'))
  const key = path.join(root, 'keys', 'master')
  const vault = new ConnectorVault(key, []),
    sealed = vault.seal('one', 'password', 1, 'hidden-password', 1)
  expect(vault.reveal('one', sealed, 1)).toBe('hidden-password')
  for (const [id, entry, revision] of [
    ['two', sealed, 1],
    ['one', { ...sealed, slot: 'ics-url' }, 1],
    ['one', sealed, 2],
  ] as const)
    expect(() => vault.reveal(id, entry, revision)).toThrow()
  fs.chmodSync(key, 0o644)
  expect(
    () => new ConnectorVault(key, [{ id: 'one', secret: sealed }]),
  ).toThrow()
  fs.chmodSync(key, 0o600)
  expect(
    () =>
      new ConnectorVault(path.join(root, 'missing'), [
        { id: 'one', secret: sealed },
      ]),
  ).toThrow()
  const tenancy = {
    read: () => ({
      revision: '1',
      config: {
        version: 1 as const,
        hubServer: 'hub',
        tenants: [{ id: 'a' }, { id: 'b' }],
        subjects: [{ subject: actor.subject, tenant: 'a' }],
        platformSubjects: [],
        nodes: [
          { nodeId: 'worker', tenant: 'a', server: 'a', memoryRoot: '/a' },
          { nodeId: 'other', tenant: 'b', server: 'b', memoryRoot: '/b' },
        ],
        jobs: [],
      },
    }),
    subscribe: () => () => {},
  }
  const book = new ConsoleConnectors({
    directory: path.join(root, 'book'),
    agents: async () => ['qianmo://worker/main', 'qianmo://other/main'],
    tenancy,
  })
  const draft = {
    name: 'Tenant connection',
    kind: 'calendar' as const,
    preset: 'ics',
    settings: {},
    secret: 'https://example.com/hidden-feed',
    agents: ['qianmo://worker/main'],
  }
  try {
    expect(
      (
        await book.save(draft, {
          ...actor,
          role: null,
          subject: 'legacy:admin',
        })
      ).ok,
    ).toBe(false)
    expect(
      (await book.save({ ...draft, agents: ['qianmo://other/main'] }, actor))
        .ok,
    ).toBe(false)
    const saved = value(await book.save(draft, actor))
    expect(saved.tenant).toBe('a')
    expect(
      (
        await book.handle(
          'connector.calendar.events',
          {
            connectorId: saved.id,
            from: '2026-10-11T00:00:00Z',
            to: '2026-10-12T00:00:00Z',
          },
          { node: 'other', agent: 'main', callId: crypto.randomUUID() },
        )
      ).ok,
    ).toBe(false)
    expect((await book.probe(saved.id, { ...actor, role: 'member' })).ok).toBe(
      false,
    )
    expect(
      () =>
        new ConsoleConnectors({
          directory: path.join(root, 'book'),
          agents: async () => [],
        }),
    ).toThrow()
  } finally {
    book.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('connector CLI flag requires personal accounts, approval links and authenticated control targets', () => {
  const publicKey = generateNodeKeyPair().publicKey
  for (const args of [
    [],
    ['--accounts'],
    [
      '--accounts',
      '--approvals',
      '--chat-sign',
      '--chat-url',
      'worker=ws://127.0.0.1:12345',
      '--trust',
      `worker=${publicKey}`,
    ],
  ])
    expect(() => parseConsoleArgs(['--connectors', ...args])).toThrow()
  expect(
    parseConsoleArgs([
      '--connectors',
      '--accounts',
      '--approvals',
      '--chat-sign',
      '--chat-url',
      'worker=ws://127.0.0.1:12345',
      '--control',
      'worker=ws://127.0.0.1:12345',
      '--trust',
      `worker=${publicKey}`,
    ]).connectors,
  ).toBe(true)
})

test('policy changes preserve credential-safe metadata and removal while probes remain blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-policy-view-'))
  const agents = async () => ['qianmo://worker/main']
  let book = new ConsoleConnectors({
    directory: root,
    agents,
    policy: new OutboundPolicy({
      allowPorts: [{ protocol: 'https', port: 8443 }],
    }),
  })
  try {
    const saved = value(
      await book.save(
        {
          name: 'Blocked feed',
          kind: 'calendar',
          preset: 'ics',
          settings: {},
          secret: 'https://example.com:8443/feed?token=private-fixture-token',
          agents: ['qianmo://worker/main'],
        },
        actor,
      ),
    )
    book.close()
    let lookups = 0
    book = new ConsoleConnectors({
      directory: root,
      agents,
      policy: new OutboundPolicy({
        lookup: async () => {
          lookups++
          return [{ address: '8.8.8.8', family: 4 }]
        },
      }),
    })
    const snapshot = value(await book.snapshot())
    expect(snapshot.connectors[0]?.summary['host']).toBe('example.com')
    expect(JSON.stringify(snapshot)).not.toContain('private-fixture-token')
    expect(value(await book.probe(saved.id, actor)).lastProbe?.ok).toBe(false)
    expect(lookups).toBe(0)
    value(await book.remove(saved.id, actor))
    expect(
      value(await book.snapshot()).connectors.some(row => row.id === saved.id),
    ).toBe(false)
  } finally {
    book.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
