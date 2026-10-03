// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.20 (D-9) — local commands typed on the chat page: which text is one,
 * who may send which, what reaches the port, and what the ledger says.
 *
 * Judged at the port and the ledger: a refused command must have called
 * `ChatPort.send` zero times and written nothing.
 */

import { describe, expect, test } from 'bun:test'
import { renderChatThread } from '../src/view/chat.js'
import type { ChatTurn } from '../src/deps.js'
import {
  ADDRESS,
  START,
  accountsHarness,
  asAdmin,
  asSession,
  type AccountsHarness,
  type Person,
  person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'

interface Setup {
  readonly h: AccountsHarness
  readonly ledger: MemoryActionLedger
  readonly ops: Person
  readonly member: Person
}

async function setup(): Promise<Setup> {
  const ledger = new MemoryActionLedger()
  const h = accountsHarness({ deps: { actions: ledger } })
  const ops = await person(h.handle, 'ops')
  const member = await person(h.handle, 'member')
  return { h, ledger, ops, member }
}

async function openAs(h: AccountsHarness, who: Person): Promise<string> {
  const response = await h.handle(
    asSession('POST', '/v0/chat/sessions', who.sid, {
      body: { target: ADDRESS },
    }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

function say(who: Person, sessionId: string, text: string): Request {
  return asSession('POST', `/v0/chat/sessions/${sessionId}/messages`, who.sid, {
    body: { text },
  })
}

function chatLines(ledger: MemoryActionLedger): readonly string[] {
  return ledger
    .lines()
    .filter(
      line =>
        line.startsWith('chat.message.') || line.startsWith('chat.command.'),
    )
}

describe('local commands on the chat page (P18.20)', () => {
  test('ops: /autocompact goes out marked, under its own verb', async () => {
    const { h, ledger, ops } = await setup()
    const sid = await openAs(h, ops)

    const response = await h.handle(say(ops, sid, '/autocompact 150k'))

    expect(response.status).toBe(200)
    expect(h.chat.sent).toEqual([
      { sessionId: sid, text: '/autocompact 150k', command: 'autocompact' },
    ])
    expect(chatLines(ledger)).toEqual([`chat.command.autocompact ${sid} ok`])
  })

  test('the admin token may send /autocompact too', async () => {
    const { h, ledger } = await setup()
    const opened = await h.handle(
      asAdmin('POST', '/v0/chat/sessions', { target: ADDRESS }),
    )
    const sid = ((await opened.json()) as { id: string }).id

    const response = await h.handle(
      asAdmin('POST', `/v0/chat/sessions/${sid}/messages`, {
        text: '/autocompact auto',
      }),
    )

    expect(response.status).toBe(200)
    expect(h.chat.sent.at(-1)?.command).toBe('autocompact')
    expect(chatLines(ledger)).toEqual([`chat.command.autocompact ${sid} ok`])
  })

  test('member: /autocompact is refused with the reason, before the ledger and the port', async () => {
    const { h, ledger, member } = await setup()
    const sid = await openAs(h, member)
    const admitted = ledger.admitCalls

    for (const text of [
      '/autocompact 150k',
      '/autocompact',
      '  /autocompact auto',
    ]) {
      const response = await h.handle(say(member, sid, text))
      expect(response.status).toBe(403)
      const body = (await response.json()) as {
        error: { code: string; message: string }
      }
      expect(body.error.code).toBe('forbidden')
      expect(body.error.message).toContain('需要运维账号或管理令牌')
      // It may reach the page's status line: the page's copy rules hold.
      for (const banned of ['。', '，', '、', '！', '!']) {
        expect(body.error.message).not.toContain(banned)
      }
    }

    expect(h.chat.sends).toBe(0)
    expect(ledger.admitCalls).toBe(admitted)
    expect(chatLines(ledger)).toEqual([])
  })

  test('member: /compact and /context are anyone-who-may-talk-here commands', async () => {
    const { h, ledger, member } = await setup()
    const sid = await openAs(h, member)

    expect((await h.handle(say(member, sid, '/context'))).status).toBe(200)
    expect(
      (await h.handle(say(member, sid, '/compact keep the API notes'))).status,
    ).toBe(200)

    expect(h.chat.sent).toEqual([
      { sessionId: sid, text: '/context', command: 'context' },
      {
        sessionId: sid,
        text: '/compact keep the API notes',
        command: 'compact',
      },
    ])
    expect(chatLines(ledger)).toEqual([
      `chat.command.context ${sid} ok`,
      `chat.command.compact ${sid} ok`,
    ])
  })

  test('only the head counts: look-alikes and other commands are messages', async () => {
    const { h, ledger, member } = await setup()
    const sid = await openAs(h, member)
    const texts = [
      '/autocompactx 1',
      'please run /autocompact 150k',
      '/version',
      '/init',
      'autocompact 150k',
    ]

    for (const text of texts) {
      expect((await h.handle(say(member, sid, text))).status).toBe(200)
    }

    expect(h.chat.sent.map(input => input.command)).toEqual(
      texts.map(() => undefined),
    )
    expect(chatLines(ledger)).toEqual(
      texts.map(() => `chat.message.send ${sid} ok`),
    )
  })
})

describe('command output in the transcript (P18.20)', () => {
  const session = {
    id: 's-1',
    target: ADDRESS,
    node: 'tokyo-1',
    agent: 'planner',
    createdAt: START,
    updatedAt: START,
    turnCount: 2,
    preview: '',
  }
  const turn = (over: Partial<ChatTurn>): ChatTurn => ({
    id: 't',
    sessionId: 's-1',
    author: 'agent',
    at: START,
    text: '',
    state: 'done',
    ...over,
  })
  const render = (turns: readonly ChatTurn[]): string =>
    renderChatThread({
      transcript: { session, turns },
      failure: null,
      target: null,
      now: START,
    })

  test('is a labelled monospace block, not an agent bubble', () => {
    const html = render([
      turn({
        id: 'a',
        author: 'operator',
        text: '/context',
        command: 'context',
      }),
      turn({
        id: 'b',
        text: '## Context Usage\n\n| Category | Tokens |\n|  a  | <1k |',
        command: 'context',
        elapsedMs: 40,
      }),
    ])

    expect(html).toContain('<article class="turn turn-agent turn-command">')
    expect(html).toContain('<span class="turn-who">命令输出</span>')
    expect(html).toContain('<code class="mono">/context</code>')
    // Laid out as it was printed, escaped, and not run through the markdown
    // subset (which would have made a heading of the first line).
    expect(html).toContain(
      '<pre class="turn-code command-output"><code>## Context Usage\n\n| Category | Tokens |\n|  a  | &lt;1k |</code></pre>',
    )
    // The agent's name is not on it; the operator's own line is unchanged.
    expect(html).not.toContain('<span class="turn-who">planner</span>')
    expect(html).toContain('<span class="turn-who">你</span>')
  })

  test('/compact loses the blank lines it leads with, nothing else', () => {
    const html = render([
      turn({ text: '\n\n  Compacted. ctrl+o\n', command: 'compact' }),
    ])
    expect(html).toContain('<code>  Compacted. ctrl+o</code>')
  })

  test('a turn without the field renders as before', () => {
    const html = render([
      turn({ text: 'Auto-compact window set to 150k tokens' }),
    ])
    expect(html).not.toContain('turn-command')
    expect(html).toContain('<span class="turn-who">planner</span>')
  })
})
