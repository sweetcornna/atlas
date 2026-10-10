// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { CHAT_LOCAL_COMMANDS } from '@qianmo/console'
import {
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  TRUST_UNTRUSTED,
  createMessage,
  validateMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import { RESIDENT_LOCAL_COMMANDS } from '../../src/host/residentLocalCommand.js'
import { residentLocalCommand } from '../../src/host/residentLocalCommand.js'

const CONSOLE = new Set(['console'])
const SIGNED_BY_CONSOLE = {
  trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
  issuer: 'console',
} as const

function task(
  payload: unknown,
  type: MessageType = MessageType.TaskRequest,
): QianmoMessage {
  return createMessage({
    from: 'qianmo://console/operator',
    to: 'qianmo://node-b/reviewer',
    type,
    payload,
  })
}

function marked(prompt: string, name: string = 'autocompact'): QianmoMessage {
  return task({ prompt, command: { name } })
}

describe('residentLocalCommand', () => {
  test('a console-signed, marked command comes back verbatim, arguments and all', () => {
    for (const prompt of [
      '/autocompact 150k',
      '/autocompact',
      '/autocompact\tauto',
    ]) {
      expect(
        residentLocalCommand(marked(prompt), SIGNED_BY_CONSOLE, CONSOLE),
      ).toBe(prompt)
    }
    expect(
      residentLocalCommand(
        marked('/compact keep the API notes', 'compact'),
        SIGNED_BY_CONSOLE,
        CONSOLE,
      ),
    ).toBe('/compact keep the API notes')
    expect(
      residentLocalCommand(
        marked('/context', 'context'),
        SIGNED_BY_CONSOLE,
        CONSOLE,
      ),
    ).toBe('/context')
  })

  test('nothing unsigned, unverified or signed by anyone but the console', () => {
    const message = marked('/autocompact 150k')
    // Unsigned (open policy), or signed by an issuer this node does not trust:
    // the routing layer leaves both on the floor tier.
    expect(
      residentLocalCommand(message, { trust: TRUST_UNTRUSTED }, CONSOLE),
    ).toBeUndefined()
    expect(
      residentLocalCommand(
        message,
        { trust: TRUST_UNTRUSTED, issuer: 'console' },
        CONSOLE,
      ),
    ).toBeUndefined()
    // A trusted peer: authorized work, and still not a local command.
    expect(
      residentLocalCommand(
        message,
        { trust: NOTICE_TRUST_VERIFIED_CAPABILITY, issuer: 'node-a' },
        CONSOLE,
      ),
    ).toBeUndefined()
    // A node told about no console: nobody.
    expect(
      residentLocalCommand(message, SIGNED_BY_CONSOLE, new Set()),
    ).toBeUndefined()
  })

  test('nothing that is not a marked task.request whose text is the command', () => {
    const cases: readonly QianmoMessage[] = [
      task({ prompt: '/autocompact 150k' }),
      task({ prompt: '/autocompact 150k', command: 'autocompact' }),
      task({ prompt: '/autocompact 150k', command: { name: 7 } }),
      task('/autocompact 150k'),
      task(null),
      task(
        { prompt: '/autocompact 150k', command: { name: 'autocompact' } },
        MessageType.Wake,
      ),
      // Outside the list: a local command the base would also run, and a
      // prompt command. Both stay messages.
      marked('/version', 'version'),
      marked('/init', 'init'),
      // The marker and the text disagree, or the text only starts like one.
      marked('/compact', 'autocompact'),
      marked('/autocompactx 1'),
      marked(' /autocompact 150k'),
      marked('please run /autocompact 150k'),
    ]
    for (const message of cases) {
      expect(
        residentLocalCommand(message, SIGNED_BY_CONSOLE, CONSOLE),
      ).toBeUndefined()
    }
  })

  test('the marker is an additive payload field: the envelope validates as it always did', () => {
    // `task.request` has no closed payload shape, so a node from before
    // P18.20 accepts the field and, knowing nothing of it, treats the turn as a
    // message — what `residentLocalCommand` answers for a node without
    // `--local-commands-from`.
    const message = marked('/autocompact 150k')
    const validation = validateMessage(JSON.parse(JSON.stringify(message)), {
      now: message.createdAt,
    })
    expect(validation.ok).toBe(true)
    expect(validation.ok && validation.message.payload).toEqual({
      prompt: '/autocompact 150k',
      command: { name: 'autocompact' },
    })
  })

  test('the console sends exactly the commands a node runs', () => {
    const sent: readonly string[] = CHAT_LOCAL_COMMANDS
    expect([...sent]).toEqual([...RESIDENT_LOCAL_COMMANDS])
  })
})
