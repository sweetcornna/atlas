// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import { ImapClient, mailHeaders } from '../../src/connectors/imap.js'
import {
  SmtpClient,
  dotEscape,
  encodedHeader,
} from '../../src/connectors/smtp.js'
import {
  CaldavClient,
  createIcs,
  icsEvents,
} from '../../src/connectors/calendar.js'
import { LIMITS } from '@qianmo/protocol'
import { mailFixture } from './mailFixture.js'
import { CERT, KEY } from './fixtures.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

test('TLS IMAP retrieves bounded plaintext, decoded headers and attachment metadata without attachment fetches', async () => {
  const f = await mailFixture()
  cleanups.push(f.close)
  const imap = await ImapClient.login(f.policy, f.settings, 'fixture-password')
  expect(await imap.select('INBOX')).toBe('42')
  const results = await imap.search({ query: 'hello', since: '2026-10-10' })
  expect(results).toEqual([
    { uid: '7', headers: { subject: '测试', from: 'sender@example.com' } },
  ])
  const read = await imap.read('7')
  expect(Buffer.byteLength(read.body)).toBe(65536)
  expect(read.truncated).toBe(true)
  expect(read.attachments).toEqual([{ name: 'report.pdf', size: 9999999 }])
  expect(f.commands.some(v => /BODY\.PEEK\[2\]/.test(v))).toBe(false)
  expect(f.commands.some(v => v.includes('BODY.PEEK[1]<0.65536>'))).toBe(true)
  await imap.logout()
})
test('IMAP refuses a server that exceeds the requested literal and an overlong protocol line', async () => {
  for (const options of [{ oversized: true }, { longLine: true }]) {
    const f = await mailFixture(options)
    cleanups.push(f.close)
    const imap = await ImapClient.login(f.policy, f.settings, 'hidden-password')
    await imap.select('INBOX')
    await expect(
      options.oversized ? imap.read('7') : imap.search({}),
    ).rejects.toThrow()
    imap.close()
  }
})
test('SMTP supports PLAIN and STARTTLS/LOGIN, UTF-8 headers and one DATA; header injection sends no DATA', async () => {
  for (const opts of [{}, { starttls: true, authLogin: true }]) {
    const f = await mailFixture(opts)
    cleanups.push(f.close)
    const smtp = await SmtpClient.login(
      f.policy,
      f.settings,
      'fixture-password',
    )
    await expect(
      smtp.send(
        'sender@example.com',
        ['to@example.com'],
        'a\r\nBcc: leaked@example.com',
        'body',
      ),
    ).rejects.toThrow()
    expect(f.messages).toHaveLength(0)
    await smtp.send(
      'sender@example.com',
      ['to@example.com'],
      '中文标题'.repeat(20),
      '.hello\nend',
    )
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0]).toContain('Subject: =?UTF-8?B?')
    expect(mailHeaders(f.messages[0]!)['subject']).toBe('中文标题'.repeat(20))
    expect(
      Buffer.from(f.messages[0]!.split('\r\n\r\n')[1]!, 'base64').toString(),
    ).toBe('.hello\nend')
    await smtp.quit()
  }
  expect(dotEscape('.first\n..second')).toBe('..first\r\n...second')
  expect(
    encodedHeader('中文'.repeat(60))
      .split('\r\n')
      .every(v => Buffer.byteLength(v) <= 75),
  ).toBe(true)
})

test('HTTPS CalDAV discovers principal/home/calendar, REPORT reads events and PUT creates once; ICS explains recurrence and refuses huge lines', async () => {
  const original = createIcs('existing', {
    title: '工作',
    start: '2026-10-11T10:00:00Z',
    end: '2026-10-11T11:00:00Z',
  })
  const requests: { method: string; path: string; body: string }[] = [],
    puts: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: KEY, cert: CERT },
    async fetch(request) {
      const path = new URL(request.url).pathname,
        body = await request.text()
      requests.push({ method: request.method, path, body })
      if (path === '/feed')
        return new Response(
          original.replace('END:VEVENT', 'RRULE:FREQ=DAILY\r\nEND:VEVENT'),
        )
      if (path === '/huge')
        return new Response(
          `BEGIN:VCALENDAR\r\n${'x'.repeat(8193)}\r\nEND:VCALENDAR`,
        )
      if (request.method === 'PUT') {
        expect(request.headers.get('if-none-match')).toBe('*')
        puts.push(body)
        return new Response(null, { status: 201 })
      }
      const xml =
        request.method === 'REPORT'
          ? `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><c:calendar-data><![CDATA[${original}]]></c:calendar-data></d:response></d:multistatus>`
          : path === '/'
            ? '<d:current-user-principal><d:href>/principal</d:href></d:current-user-principal>'
            : path === '/principal'
              ? '<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>'
              : '<d:response><d:href>/home/calendar/</d:href><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:response>'
      return new Response(xml, { status: 207 })
    },
  })
  cleanups.push(() => server.stop(true))
  const policy = new OutboundPolicy({
    ca: CERT,
    allowAddresses: ['127.0.0.1'],
    allowPorts: [{ protocol: 'https', port: server.port! }],
  })
  const client = new CaldavClient(
    policy,
    server.url.toString(),
    'user@example.com',
    'hidden',
  )
  const events = await client.events(
    '2026-10-11T00:00:00Z',
    '2026-10-12T00:00:00Z',
  )
  expect(events.events[0]?.title).toBe('工作')
  await client.create('new-event', {
    title: '测试,事件',
    start: '2026-10-11T12:00:00Z',
    end: '2026-10-11T13:00:00Z',
    notes: 'line1\nline2',
  })
  expect(puts).toHaveLength(1)
  expect(puts[0]).toContain('SUMMARY:测试\\,事件')
  expect(requests.find(v => v.method === 'REPORT')?.body).toContain(
    '20261011T000000Z',
  )
  const feed = await icsEvents(
    policy,
    new URL('/feed', server.url).toString(),
    '2026-10-11T00:00:00Z',
    '2026-10-12T00:00:00Z',
  )
  expect(feed.events[0]?.recurring).toBe(true)
  expect(feed.warnings.join('')).toContain('RRULE 未展开')
  await expect(
    icsEvents(
      policy,
      new URL('/huge', server.url).toString(),
      '2026-10-11T00:00:00Z',
      '2026-10-12T00:00:00Z',
    ),
  ).rejects.toThrow('行超过')
})

test('malformed UTF-8 mail cannot expand returned plaintext past the 64 KiB budget', async () => {
  const fixture = await mailFixture({ invalidUtf8: true })
  cleanups.push(fixture.close)
  const client = await ImapClient.login(
    fixture.policy,
    fixture.settings,
    'fixture-password',
  )
  try {
    await client.select('INBOX')
    const read = await client.read('7')
    expect(Buffer.byteLength(read.body)).toBeLessThanOrEqual(
      LIMITS.connectorTextBytes,
    )
    expect(read.body).toContain('�')
  } finally {
    client.close()
  }
})

test('revocation while SMTP awaits DATA acceptance aborts before transmitting the message', async () => {
  let authorized = true
  const fixture = await mailFixture({
    onData: () => {
      authorized = false
    },
  })
  cleanups.push(fixture.close)
  const client = await SmtpClient.login(
    fixture.policy,
    fixture.settings,
    'fixture-password',
  )
  try {
    await expect(
      client.send(
        'sender@example.com',
        ['recipient@example.com'],
        'Subject',
        'Private body',
        () => {
          if (!authorized) throw new Error('revoked')
        },
      ),
    ).rejects.toThrow('revoked')
    expect(fixture.messages).toHaveLength(0)
  } finally {
    client.close()
  }
})

test('CalDAV rechecks authorization after PUT DNS resolution and emits zero writes on revocation', async () => {
  let allowed = true,
    lookups = 0,
    puts = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: KEY, cert: CERT },
    fetch(request) {
      if (request.method === 'PUT') puts++
      return new Response(
        '<d:response><d:href>/calendar/</d:href><d:resourcetype><c:calendar/></d:resourcetype></d:response>',
        { status: 207 },
      )
    },
  })
  cleanups.push(() => server.stop(true))
  const policy = new OutboundPolicy({
    ca: CERT,
    allowAddresses: ['127.0.0.1'],
    allowPorts: [{ protocol: 'https', port: server.port! }],
    lookup: async () => {
      if (++lookups === 3) allowed = false
      return [{ address: '127.0.0.1', family: 4 }]
    },
  })
  const client = new CaldavClient(
    policy,
    `https://localhost:${server.port}/`,
    'fixture-user',
    'fixture-password',
  )
  await expect(
    client.create(
      'refused',
      {
        title: 'private',
        start: '2026-10-11T12:00:00Z',
        end: '2026-10-11T13:00:00Z',
      },
      () => {
        if (!allowed) throw new Error('revoked')
      },
    ),
  ).rejects.toThrow('revoked')
  expect(puts).toBe(0)
})
