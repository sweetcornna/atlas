// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 「变更」 panel of a folder that is not Git (qmo-local.md §4.3.7): what
 * the session's own tool lines say it changed, never the disk.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { unifiedDiff } from '../../src/code/diff.ts'
import type { CodeTurn, ToolInfo } from '../../src/code/protocol.ts'
import { recordedChanges, recordedDiff } from '../../src/code/recorded.ts'
import { CodeError } from '../../src/code/protocol.ts'
import { clipDetail, DIFF_CUT } from '../../src/code/store.ts'
import {
  begin,
  box,
  cleanBoxes,
  type Message,
  pick,
  startRunner,
  type TestRunner,
} from './helpers.ts'

let n = 0
function line(
  tool: Partial<ToolInfo> & { readonly paths?: readonly string[] },
  before: string,
  after: string,
): CodeTurn {
  const diff = unifiedDiff(before, after)
  n += 1
  return {
    id: `t_${n}`,
    sessionId: 'cs_AAAAAAAAAAAAAAAAAAAAAA',
    author: 'agent',
    at: n,
    text: '编辑',
    state: 'done',
    variant: 'notice',
    noticeSource: 'step',
    severity: 'info',
    ...(diff.text === '' ? {} : { detail: clipDetail(diff.text, 'diff') }),
    tool: {
      id: `tool_${n}`,
      name: 'Edit',
      status: 'done',
      detailKind: 'diff',
      added: diff.added,
      removed: diff.removed,
      ...tool,
    },
  }
}

describe('changes from a session’s records', () => {
  test('one file a line at a time, new, changed and emptied; what did not finish or is elsewhere is not listed', () => {
    const turns = [
      line({ paths: ['src/new.ts'] }, '', 'a\nb\n'),
      line({ paths: ['src/new.ts'] }, 'a\nb\n', 'a\nB\nc\n'),
      line({ paths: ['notes.md'] }, 'one\ntwo\n', 'one\n2\n'),
      line({ paths: ['gone.txt'] }, 'x\ny\n', ''),
      line({ paths: ['denied.ts'], status: 'denied' }, '', 'no\n'),
      line({ paths: ['failed.ts'], status: 'failed' }, '', 'no\n'),
      line({ paths: ['running.ts'], status: 'running' }, '', 'no\n'),
      line({ paths: ['/etc/hosts'] }, '', 'no\n'),
      line({ paths: ['../up.txt'] }, '', 'no\n'),
      line({ paths: ['out.txt'], detailKind: 'output' }, '', 'no\n'),
      line({}, '', 'no paths\n'),
    ]
    expect(recordedChanges(turns)).toEqual({
      source: 'session',
      files: [
        {
          path: 'src/new.ts',
          status: 'added',
          added: 4,
          removed: 1,
          binary: false,
        },
        {
          path: 'notes.md',
          status: 'modified',
          added: 1,
          removed: 1,
          binary: false,
        },
        {
          path: 'gone.txt',
          status: 'deleted',
          added: 0,
          removed: 2,
          binary: false,
        },
      ],
      truncated: false,
    })
    const both = recordedDiff(turns, 'src/new.ts')
    expect(both).toEqual({
      path: 'src/new.ts',
      text: `${unifiedDiff('', 'a\nb\n').text}\n${unifiedDiff('a\nb\n', 'a\nB\nc\n').text}`,
      truncated: false,
      binary: false,
    })
    expect(() => recordedDiff(turns, 'denied.ts')).toThrow(CodeError)
    expect(() => recordedDiff(turns, 'nowhere')).toThrow(CodeError)
  })

  test('a detail cut at 16 KiB keeps its exact counts and says it was cut; past 256 KiB only the counts', () => {
    const big = Array.from({ length: 3_000 }, (_, i) => `line ${i}\n`).join('')
    const cut = line({ paths: ['big.txt'] }, '', big)
    expect(String(cut.detail).endsWith(DIFF_CUT)).toBe(true)
    expect(recordedChanges([cut]).files[0]).toMatchObject({ added: 3_000 })
    expect(recordedDiff([cut], 'big.txt').truncated).toBe(true)
    // Twenty lines of 15 KiB each are 300 KiB of diff.
    const many = Array.from({ length: 20 }, () =>
      line({ paths: ['many.txt'] }, '', `${'y'.repeat(15 * 1024)}\n`),
    )
    expect(recordedDiff(many, 'many.txt')).toEqual({
      path: 'many.txt',
      text: '',
      truncated: true,
      binary: false,
      large: true,
    })
  })

  test('one tool line over several files lists each, with its whole diff and no counts', () => {
    const turns = [line({ paths: ['a.ts', 'b.ts'] }, 'x\n', 'y\n')]
    expect(recordedChanges(turns).files).toEqual([
      { path: 'a.ts', status: 'modified', added: 0, removed: 0, binary: false },
      { path: 'b.ts', status: 'modified', added: 0, removed: 0, binary: false },
    ])
    expect(recordedDiff(turns, 'b.ts').text).toContain('+y')
  })

  test('past a thousand files the rest are counted', () => {
    const turns = Array.from({ length: 1_003 }, (_, i) =>
      line({ paths: [`f${i}.txt`] }, '', 'x\n'),
    )
    const changes = recordedChanges(turns)
    expect(changes.files).toHaveLength(1_000)
    expect(changes).toMatchObject({ truncated: true, omitted: 3 })
  })
})

const posix = process.platform !== 'win32'
const running: TestRunner[] = []
afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stop()
  cleanBoxes()
})

describe.skipIf(!posix)('the runner, in a folder that is not Git', () => {
  test('lists what the agent wrote and edited, from its records, and shows their diffs', async () => {
    const at = box()
    const r = startRunner(at)
    running.push(r)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'edit a.txt', 'accept-edits')
    await r.say(id, 'edit a.txt')
    // The disk changing afterwards is not what the panel reads.
    fs.writeFileSync(path.join(at.work, 'a.txt'), 'something else\n')
    const changes = await r.call('session.changes', { session: id })
    expect(changes).toEqual({
      source: 'session',
      files: [
        {
          path: 'a.txt',
          status: 'added',
          added: 2,
          removed: 0,
          binary: false,
        },
      ],
      truncated: false,
    })
    const diff = (await r.call('session.diff', {
      session: id,
      path: 'a.txt',
    })) as Message
    expect(diff).toMatchObject({
      path: 'a.txt',
      truncated: false,
      binary: false,
    })
    expect(String(diff.text)).toContain('+created by fake')
    expect(String(diff.text)).toContain('+edited')
    expect(String(diff.text)).not.toContain('something else')
  }, 30_000)
})
