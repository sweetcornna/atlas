// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation on disk (qmo-local.md §4.3.6): the chat store's envelope
 * plus `seq`, a turn rewritten in place of its first write, pages from the
 * newest back, private files that refuse a link, and records cut to size
 * without splitting a character.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CodeTurn } from '../../src/code/protocol.ts'
import {
  CodeStore,
  clipDetail,
  clipMessage,
  MAX_DETAIL_BYTES,
  MAX_FOLDERS,
  MAX_MESSAGE_BYTES,
  newFolderId,
  newSessionId,
  newTurnId,
  Transcript,
} from '../../src/code/store.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function store(): CodeStore {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-store-')),
  )
  roots.push(root)
  const made = new CodeStore(path.join(root, 'code'))
  made.ensure()
  return made
}

function turn(
  session: string,
  text: string,
  extra: Partial<CodeTurn> = {},
): CodeTurn {
  return {
    id: newTurnId(),
    sessionId: session,
    author: 'agent',
    at: 1,
    text,
    state: 'done',
    ...extra,
  }
}

function envelope(id: string) {
  return {
    id,
    target: 'local',
    node: 'local',
    agent: 'Claude Code',
    createdAt: 1,
  }
}

const posix = process.platform !== 'win32'
const mode = (file: string) => fs.statSync(file).mode & 0o777

describe('the conversation file', () => {
  test('ids have their shapes', () => {
    expect(newSessionId()).toMatch(/^cs_[A-Za-z0-9_-]{22}$/)
    expect(newFolderId()).toMatch(/^[0-9a-f]{16}$/)
    expect(newTurnId()).toMatch(/^t_[A-Za-z0-9_-]{16}$/)
  })

  test('the session line is seq 0; each write is the next seq; a rewrite keeps its place', () => {
    const at = store()
    const id = newSessionId()
    const log = Transcript.create(at, envelope(id))
    const asked = turn(id, 'hello', {
      author: 'operator',
      state: 'pending',
      clientId: 'c1',
    })
    expect(log.write(asked).seq).toBe(1)
    const tool = turn(id, '运行 ls', {
      variant: 'notice',
      noticeSource: 'step',
      severity: 'info',
      tool: {
        id: 'tu1',
        name: '运行',
        status: 'running',
        detailKind: 'output',
      },
    })
    expect(log.write(tool).seq).toBe(2)
    expect(log.write({ ...asked, state: 'read' }).seq).toBe(3)
    expect(
      log.write({
        ...tool,
        detail: 'a\nb',
        tool: { ...tool.tool!, status: 'done' },
      }).seq,
    ).toBe(4)
    const lines = fs
      .readFileSync(at.eventsFile(id), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => [line.kind, line.seq])).toEqual([
      ['session', 0],
      ['turn', 1],
      ['turn', 2],
      ['turn', 3],
      ['turn', 4],
    ])
    expect(lines[0]!.session).toEqual(envelope(id))
    // Read back: the last write of each, at the place of its first.
    const again = Transcript.load(at, id)
    expect(again.lastSeq).toBe(4)
    expect(again.turns().map(one => [one.text, one.state])).toEqual([
      ['hello', 'read'],
      ['运行 ls', 'done'],
    ])
    expect(again.write(turn(id, 'next')).seq).toBe(5)
  })

  test('a last line cut by a power loss costs that line, not the next one', () => {
    const at = store()
    const id = newSessionId()
    const log = Transcript.create(at, envelope(id))
    log.write(turn(id, 'kept'))
    fs.appendFileSync(
      at.eventsFile(id),
      '{"kind":"turn","seq":2,"turn":{"id":"t_cu',
    )
    const again = Transcript.load(at, id)
    expect(again.lastSeq).toBe(1)
    again.write(turn(id, 'after'))
    expect(
      Transcript.load(at, id)
        .turns()
        .map(one => one.text),
    ).toEqual(['kept', 'after'])
  })

  test('pages from the newest back, by where each turn was first written', () => {
    const at = store()
    const id = newSessionId()
    const log = Transcript.create(at, envelope(id))
    const written = [1, 2, 3, 4, 5].map(n => log.write(turn(id, `t${n}`)))
    // t2 rewritten last: still second.
    log.write({ ...written[1]!.turn, text: 't2 again' })
    const newest = log.page(undefined, 2)
    expect(newest.records.map(one => one.turn.text)).toEqual(['t4', 't5'])
    expect(newest.more).toBe(true)
    const older = log.page(newest.records[0]!.seq, 10)
    expect(older.records.map(one => one.turn.text)).toEqual([
      't1',
      't2 again',
      't3',
    ])
    expect(older.more).toBe(false)
    expect(older.records[1]!.seq).toBe(6)
  })

  test.skipIf(!posix)(
    '0700 folders, 0600 files; a link where the log goes is refused',
    () => {
      const at = store()
      const id = newSessionId()
      Transcript.create(at, envelope(id))
      expect(mode(at.dir)).toBe(0o700)
      expect(mode(at.sessionDir(id))).toBe(0o700)
      expect(mode(at.eventsFile(id))).toBe(0o600)
      const other = newSessionId()
      fs.mkdirSync(at.sessionDir(other), { mode: 0o700 })
      const elsewhere = path.join(path.dirname(at.dir), 'elsewhere')
      fs.writeFileSync(elsewhere, '')
      fs.symlinkSync(elsewhere, at.eventsFile(other))
      expect(() => at.append(other, { kind: 'turn', seq: 1 })).toThrow()
      expect(fs.readFileSync(elsewhere, 'utf8')).toBe('')
    },
  )

  test('folders: a broken file reads as none; at most twenty kept', () => {
    const at = store()
    fs.writeFileSync(at.foldersFile, '{not json', { mode: 0o600 })
    expect(at.readFolders()).toEqual([])
    const many = Array.from({ length: MAX_FOLDERS + 5 }, (_, n) => ({
      id: newFolderId(),
      path: `/work/${n}`,
      name: String(n),
      pickedAt: n,
    }))
    at.writeFolders(many)
    expect(at.readFolders()).toEqual(many.slice(0, MAX_FOLDERS))
  })

  test('a message is cut at 256 KiB, a detail at 16 KiB, never inside a character', () => {
    expect(clipMessage('short')).toBe('short')
    const message = clipMessage('字'.repeat(MAX_MESSAGE_BYTES))
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES)
    expect(message).not.toContain('�')
    expect(message.endsWith('（超过 256 KiB，后面的截掉了）')).toBe(true)
    const output = clipDetail(`${'头'.repeat(10_000)}最后一行`, 'output')
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_DETAIL_BYTES)
    expect(output.startsWith('…（前面的截掉了）\n')).toBe(true)
    expect(output.endsWith('最后一行')).toBe(true)
    expect(output).not.toContain('�')
    const diff = clipDetail(`第一行\n${'差'.repeat(10_000)}`, 'diff')
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(MAX_DETAIL_BYTES)
    expect(diff.startsWith('第一行\n')).toBe(true)
    expect(diff.endsWith('…（差异太长，后面的截掉了）')).toBe(true)
  })
})
