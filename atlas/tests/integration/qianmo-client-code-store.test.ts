// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A local session's `events.ndjson` (`@qianmo/client`, qmo-local.md §4.3.6)
 * is the hub console's chat store (`@qianmo/node`'s `ChatStore`) with a
 * `seq` and three local fields: the store reads it as it reads its own, the
 * local fields and `seq` dropped, the rest the same turn for turn, the last
 * write of each in place of its first. P37.15 pushes these lines up as they
 * are; this test keeps the two formats together.
 */

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CodeTurn } from '@qianmo/client/code/protocol.ts'
import {
  CodeStore,
  newSessionId,
  newTurnId,
  Transcript,
} from '@qianmo/client/code/store.ts'
import { ChatStore } from '@qianmo/node/commands/consoleChatStore.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

test('the chat store reads a local session as its own', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-code-store-')),
  )
  roots.push(root)
  const store = new CodeStore(path.join(root, 'code'))
  store.ensure()
  const id = newSessionId()
  const envelope = {
    id,
    target: 'local',
    node: 'local',
    agent: 'Claude Code',
    createdAt: 1_000,
  }
  const log = Transcript.create(store, envelope)
  const at = 1_001
  const said: CodeTurn = {
    id: newTurnId(),
    sessionId: id,
    author: 'operator',
    at,
    text: '改一下 app.ts',
    state: 'pending',
    clientId: 'c-1',
  }
  const tool: CodeTurn = {
    id: newTurnId(),
    sessionId: id,
    author: 'agent',
    at,
    text: '编辑 src/app.ts',
    state: 'done',
    variant: 'notice',
    noticeSource: 'step',
    severity: 'info',
    detail: '@@ -1,1 +1,1 @@\n-a\n+b',
    tool: {
      id: 'tu_1',
      name: '编辑',
      status: 'running',
      paths: ['src/app.ts'],
      detailKind: 'diff',
      added: 1,
      removed: 1,
    },
  }
  const ask: CodeTurn = {
    id: newTurnId(),
    sessionId: id,
    author: 'agent',
    at,
    text: '要运行 rm -rf build',
    state: 'done',
    variant: 'notice',
    noticeSource: 'step',
    severity: 'warn',
    ask: {
      id: 'ask_1',
      tool: '运行',
      title: '要运行 rm -rf build',
      options: ['once', 'deny'],
    },
  }
  const message: CodeTurn = {
    id: newTurnId(),
    sessionId: id,
    author: 'agent',
    at,
    text: '改好了。',
    state: 'done',
  }
  const failed: CodeTurn = {
    id: newTurnId(),
    sessionId: id,
    author: 'agent',
    at,
    text: 'Claude Code exited during the turn',
    state: 'failed',
    code: 'E_AGENT',
  }
  log.write(said)
  log.write(tool)
  log.write({ ...said, state: 'read' })
  log.write(ask)
  log.write({
    ...ask,
    ask: { ...ask.ask!, decision: 'deny', by: 'user', at: 1_002 },
  })
  log.write({
    ...tool,
    tool: { ...tool.tool!, status: 'done', approvedBy: 'mode' },
  })
  log.write(message)
  log.write(failed)

  const read = new ChatStore(store.eventsFile(id)).load()
  expect(read.sessions).toEqual([envelope])
  const local = (turn: CodeTurn) => {
    const { tool: _tool, ask: _ask, clientId: _clientId, ...shared } = turn
    return shared
  }
  // Each turn's last write, at the place of its first; the local fields dropped.
  const expected = Transcript.load(store, id).turns().map(local)
  expect(expected.map(one => one.text)).toEqual([
    '改一下 app.ts',
    '编辑 src/app.ts',
    '要运行 rm -rf build',
    '改好了。',
    'Claude Code exited during the turn',
  ])
  expect(expected[0]!.state).toBe('read')
  expect(read.turns).toEqual(expected)
})
