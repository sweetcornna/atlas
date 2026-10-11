// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as tls from 'node:tls'
import * as net from 'node:net'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import { LIMITS } from '@qianmo/protocol'
import { CERT, KEY } from './fixtures.js'

export async function mailFixture(
  options: {
    onData?: () => void
    invalidUtf8?: boolean
    oversized?: boolean
    longLine?: boolean
    validity?: string
    authLogin?: boolean
    starttls?: boolean
    unknown?: boolean
  } = {},
) {
  const commands: string[] = [],
    messages: string[] = []
  const connections = new Set<net.Socket>()
  const body = options.invalidUtf8
    ? Buffer.alloc(LIMITS.connectorTextBytes, 0xff)
    : Buffer.from('a'.repeat(LIMITS.connectorTextBytes))
  const headers =
    'Subject: =?UTF-8?B?5rWL6K+V?=\r\nFrom: sender@example.com\r\n\r\n'
  const attach = (socket: net.Socket, smtp: boolean, greeting = true) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => {})
    if (greeting) socket.write(smtp ? '220 fixture\r\n' : '* OK fixture\r\n')
    let input = '',
      data = false,
      authStep = 0,
      packet = ''
    const receive = (chunk: Buffer) => {
      input += chunk.toString()
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n'),
          line = input.slice(0, end)
        input = input.slice(end + 2)
        if (data) {
          if (line === '.') {
            messages.push(packet)
            packet = ''
            data = false
            if (options.unknown) socket.destroy()
            else socket.write('250 queued\r\n')
          } else packet += `${line.replace(/^\.\./, '.')}\r\n`
          continue
        }
        commands.push(line)
        if (smtp) {
          if (line.startsWith('EHLO'))
            socket.write(
              `250-fixture\r\n${options.starttls && !(socket instanceof tls.TLSSocket) ? '250-STARTTLS\r\n' : ''}250 AUTH ${options.authLogin ? 'LOGIN' : 'PLAIN'}\r\n`,
            )
          else if (line === 'STARTTLS') {
            socket.write('220 TLS\r\n')
            socket.off('data', receive)
            attach(
              new tls.TLSSocket(socket, {
                isServer: true,
                secureContext: tls.createSecureContext({
                  key: KEY,
                  cert: CERT,
                }),
              }),
              true,
              false,
            )
            return
          } else if (line === 'AUTH LOGIN') {
            authStep = 1
            socket.write('334 VXNlcg==\r\n')
          } else if (authStep === 1) {
            authStep = 2
            socket.write('334 UGFzcw==\r\n')
          } else if (authStep === 2 || line.startsWith('AUTH PLAIN')) {
            authStep = 0
            socket.write('235 authenticated\r\n')
          } else if (line.startsWith('MAIL') || line.startsWith('RCPT'))
            socket.write('250 ok\r\n')
          else if (line === 'DATA') {
            data = true
            options.onData?.()
            socket.write('354 data\r\n')
          } else if (line === 'QUIT') {
            socket.write('221 bye\r\n')
            socket.end()
          }
        } else {
          const tag = line.split(' ')[0]!
          if (options.longLine && line.includes('SEARCH')) {
            socket.write('x'.repeat(LIMITS.connectorLineBytes + 1) + '\r\n')
            continue
          }
          if (line.includes('EXAMINE'))
            socket.write(`* OK [UIDVALIDITY ${options.validity ?? '42'}]\r\n`)
          else if (line.includes('UID SEARCH')) socket.write('* SEARCH 7\r\n')
          else if (line.includes('BODYSTRUCTURE')) {
            const structure =
              '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" 100000 200 NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 9999999 NIL ("ATTACHMENT" ("FILENAME" "report.pdf")) NIL) "MIXED")'
            socket.write(
              `* 1 FETCH (UID 7 BODYSTRUCTURE ${structure} BODY[HEADER] {${headers.length}}\r\n${headers})\r\n`,
            )
          } else if (line.includes('HEADER.FIELDS'))
            socket.write(
              `* 1 FETCH (UID 7 BODY[HEADER] {${headers.length}}\r\n${headers})\r\n`,
            )
          else if (line.includes('BODY.PEEK[1]')) {
            socket.write(
              `* 1 FETCH (UID 7 BODY[1] {${options.oversized ? LIMITS.connectorTextBytes + 1 : body.length}}\r\n`,
            )
            socket.write(body)
            socket.write(')\r\n')
          } else if (line.includes('LOGOUT')) socket.write('* BYE bye\r\n')
          socket.write(`${tag} OK success\r\n`)
        }
      }
    }
    socket.on('data', receive)
  }
  const imap = tls.createServer({ key: KEY, cert: CERT }, socket =>
    attach(socket, false),
  )
  const smtp = options.starttls
    ? net.createServer(socket => attach(socket, true))
    : tls.createServer({ key: KEY, cert: CERT }, socket => attach(socket, true))
  const listen = async (server: net.Server) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', resolve)
    await promise
    return (server.address() as net.AddressInfo).port
  }
  const imapPort = await listen(imap),
    smtpPort = await listen(smtp)
  const close = () => {
    for (const socket of connections) socket.destroy()
    imap.close()
    smtp.close()
  }
  const policy = new OutboundPolicy({
    ca: CERT,
    allowAddresses: ['127.0.0.1'],
    allowPorts: [
      { protocol: 'imaps', port: imapPort },
      { protocol: options.starttls ? 'starttls' : 'smtps', port: smtpPort },
    ],
  })
  return {
    close,
    commands,
    messages,
    policy,
    settings: {
      imapHost: '127.0.0.1',
      imapPort,
      smtpHost: '127.0.0.1',
      smtpPort,
      smtpTls: options.starttls ? ('starttls' as const) : ('smtps' as const),
      username: 'sender@example.com',
    },
  }
}
