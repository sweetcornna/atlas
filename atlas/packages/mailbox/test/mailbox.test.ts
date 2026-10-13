// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'

import {
  MAX_MAILBOX_FILE_BYTES,
  MAX_MAILBOX_MESSAGES,
  MAX_MAILBOX_MESSAGE_TEXT_BYTES,
  MAX_READ_MAILBOX_MESSAGES,
  TEAM_LEAD_NAME,
  formatTeammateMessages,
  getInboxPath,
  isStructuredProtocolMessage,
  markMessageAsReadByIdentity,
  markMessagesAsRead,
  markMessagesAsReadBySnapshot,
  readMailbox,
  readUnreadMessages,
  sanitizeName,
  sanitizePathComponent,
  writeToMailbox,
} from '../src/index.js'
import { message, readRaw, seed, seedRaw, useTempConfigDir } from './helpers.js'

const configDir = useTempConfigDir()

function send(text: string, ms = 1) {
  return writeToMailbox(
    'worker',
    { from: TEAM_LEAD_NAME, text, timestamp: new Date(ms).toISOString() },
    'alpha',
  )
}

describe('layout', () => {
  test('inbox lives at teams/<team>/inboxes/<agent>.json under the config root', () => {
    expect(getInboxPath('worker', 'alpha')).toBe(
      join(configDir(), 'teams', 'alpha', 'inboxes', 'worker.json'),
    )
    expect(getInboxPath('a.b', 'my team')).toBe(
      join(configDir(), 'teams', 'my-team', 'inboxes', 'a-b.json'),
    )
    expect(getInboxPath('worker')).toBe(
      join(configDir(), 'teams', 'default', 'inboxes', 'worker.json'),
    )
  })

  test('writes a pretty-printed JSON array with the stored fields only', async () => {
    await writeToMailbox(
      'worker',
      {
        from: 'peer',
        text: 'hi',
        timestamp: 't0',
        color: 'red',
        summary: 'greeting',
      },
      'alpha',
    )
    const raw = await readFile(getInboxPath('worker', 'alpha'), 'utf-8')
    expect(raw).toBe(
      JSON.stringify(
        [
          {
            from: 'peer',
            text: 'hi',
            timestamp: 't0',
            read: false,
            color: 'red',
            summary: 'greeting',
          },
        ],
        null,
        2,
      ),
    )
  })

  test('readMailbox of a missing inbox is empty', async () => {
    expect(await readMailbox('nobody', 'alpha')).toEqual([])
  })
})

describe('limits and compaction on write', () => {
  test('writeToMailbox compacts an oversized unread inbox', async () => {
    await seed(
      'worker',
      'alpha',
      Array.from({ length: MAX_MAILBOX_MESSAGES + 20 }, (_, i) =>
        message(`old-${i}`, false),
      ),
    )
    await send('newest')

    const after = await readMailbox('worker', 'alpha')
    expect(after).toHaveLength(MAX_MAILBOX_MESSAGES)
    expect(after[0]?.text).toBe('old-21')
    expect(after.at(-1)?.text).toBe('newest')
  })

  test('markMessagesAsRead trims read history after consumption', async () => {
    await seed(
      'worker',
      'alpha',
      Array.from({ length: MAX_MAILBOX_MESSAGES + 20 }, (_, i) =>
        message(`msg-${i}`, false),
      ),
    )
    await markMessagesAsRead('worker', 'alpha')

    const after = await readRaw('worker', 'alpha')
    expect(after).toHaveLength(MAX_READ_MAILBOX_MESSAGES)
    expect(after.every(m => m.read)).toBe(true)
    expect(after[0]?.text).toBe(
      `msg-${MAX_MAILBOX_MESSAGES + 20 - MAX_READ_MAILBOX_MESSAGES}`,
    )
  })

  test('text over 64 KiB is rejected, not stored', async () => {
    await expect(
      send('x'.repeat(MAX_MAILBOX_MESSAGE_TEXT_BYTES + 1)),
    ).rejects.toThrow('Mailbox message text exceeds')
    expect(await readRaw('worker', 'alpha')).toEqual([])
  })

  test('text of exactly 64 KiB is accepted (bytes, not characters)', async () => {
    await send('x'.repeat(MAX_MAILBOX_MESSAGE_TEXT_BYTES))
    await expect(
      send('é'.repeat(MAX_MAILBOX_MESSAGE_TEXT_BYTES / 2 + 1)),
    ).rejects.toThrow('Mailbox message text exceeds')
    expect(await readRaw('worker', 'alpha')).toHaveLength(1)
  })

  test('a corrupt existing inbox fails closed and is left untouched', async () => {
    const path = await seedRaw('worker', 'alpha', '{not-json')
    await expect(send('new')).rejects.toThrow()
    expect(await readFile(path, 'utf-8')).toBe('{not-json')
  })

  test('an inbox path that is a directory surfaces EISDIR', async () => {
    const path = getInboxPath('worker', 'alpha')
    await mkdir(path, { recursive: true })
    const error = await send('new').then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toMatchObject({ code: 'EISDIR' })
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  test('writes leave no temp files or lock behind', async () => {
    await send('one')
    await send('two', 2)
    const entries = await readdir(dirname(getInboxPath('worker', 'alpha')))
    expect(entries).toEqual(['worker.json'])
  })
})

describe('readMailbox validation', () => {
  test('corrupt JSON throws', async () => {
    await seedRaw('worker', 'alpha', '{not-json')
    await expect(readMailbox('worker', 'alpha')).rejects.toThrow()
  })

  test('non-array file throws', async () => {
    await seedRaw('worker', 'alpha', JSON.stringify({ text: 'x' }))
    await expect(readMailbox('worker', 'alpha')).rejects.toThrow(
      'expected message array',
    )
  })

  test('malformed message shape throws', async () => {
    await seedRaw(
      'worker',
      'alpha',
      JSON.stringify([{ from: 'lead', text: 'missing timestamp' }]),
    )
    await expect(readMailbox('worker', 'alpha')).rejects.toThrow(
      'Invalid mailbox message shape',
    )
  })

  test('non-object entry throws', async () => {
    await seedRaw('worker', 'alpha', JSON.stringify(['nope']))
    await expect(readMailbox('worker', 'alpha')).rejects.toThrow(
      'expected object',
    )
  })

  test('an oversized file is refused before parsing', async () => {
    await seedRaw('worker', 'alpha', `[${' '.repeat(MAX_MAILBOX_FILE_BYTES)}]`)
    await expect(readMailbox('worker', 'alpha')).rejects.toThrow(
      'Mailbox file exceeds',
    )
  })

  test('unknown fields are dropped, optional string fields kept', async () => {
    await seedRaw(
      'worker',
      'alpha',
      JSON.stringify([
        { ...message('a', false), color: 'blue', summary: 3, extra: true },
      ]),
    )
    expect(await readMailbox('worker', 'alpha')).toEqual([
      { ...message('a', false), color: 'blue' },
    ])
  })
})

describe('locking', () => {
  test('64 concurrent writers all succeed without losing or duplicating messages', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 64 }, (_, i) => send(`m-${i}`, i)),
    )
    expect(results.filter(result => result.status === 'rejected')).toEqual([])
    expect(await readMailbox('worker', 'alpha')).toEqual(
      expect.arrayContaining(
        Array.from({ length: 64 }, (_, i) =>
          message(`m-${i}`, false, new Date(i).toISOString()),
        ),
      ),
    )
    expect(await readMailbox('worker', 'alpha')).toHaveLength(64)
  })

  test('writers wait on <inbox>.lock held by another party', async () => {
    await send('first')
    const path = getInboxPath('worker', 'alpha')
    const release = await lock(path, { lockfilePath: `${path}.lock` })
    let done = false
    const pending = Promise.allSettled([
      send('second', 2).finally(() => {
        done = true
      }),
    ])
    try {
      // Hold past the old 655 ms retry budget with a real independent holder.
      await Bun.sleep(1_200)
      expect(done).toBe(false)
      expect((await readMailbox('worker', 'alpha')).map(m => m.text)).toEqual([
        'first',
      ])
      // A blocked inbox must not block a different path's queue.
      await writeToMailbox(
        'other-worker',
        message('independent', false),
        'alpha',
      )
      expect((await readMailbox('other-worker', 'alpha'))[0]?.text).toBe(
        'independent',
      )
    } finally {
      await release()
      await pending
    }
    expect(await pending).toEqual([{ status: 'fulfilled', value: undefined }])
    expect((await readMailbox('worker', 'alpha')).map(m => m.text)).toEqual([
      'first',
      'second',
    ])
  })

  test('a held lock times out explicitly and queued writes recover after release', async () => {
    await send('first')
    const path = getInboxPath('worker', 'alpha')
    // Hold <inbox>.lock the way another process does and keep its mtime fresh.
    // A proper-lockfile holder refreshes only every 5 s, inside the very wait
    // measured here: on a loaded machine the waiters then judged it stale,
    // took it over and compromised the holder.
    const lockDir = `${path}.lock`
    await mkdir(lockDir)
    const refresh = setInterval(() => {
      const now = new Date()
      utimes(lockDir, now, now).catch(() => {})
    }, 250)
    const started = performance.now()
    const blocked = send('blocked', 2).then(
      () => undefined,
      (error: unknown) => error,
    )
    const queued = Promise.allSettled([send('after-release', 3)])
    try {
      expect(await blocked).toMatchObject({
        code: 'ELOCKED',
        message: `Mailbox lock acquisition timed out after 5000 ms: ${path}`,
        cause: { code: 'ELOCKED' },
      })
      // The budget, not a hang: generous above for a loaded runner.
      expect(performance.now() - started).toBeGreaterThanOrEqual(4_900)
      expect(performance.now() - started).toBeLessThan(15_000)
      expect((await readMailbox('worker', 'alpha')).map(m => m.text)).toEqual([
        'first',
      ])
    } finally {
      clearInterval(refresh)
      await rm(lockDir, { recursive: true, force: true })
      await queued
    }
    expect(await queued).toEqual([{ status: 'fulfilled', value: undefined }])
    expect((await readMailbox('worker', 'alpha')).map(m => m.text)).toEqual([
      'first',
      'after-release',
    ])
  }, 30_000)

  test('a failed mutation does not poison the queue for the next write or read acknowledgement', async () => {
    await send('first')
    const [first] = await readMailbox('worker', 'alpha')
    const results = await Promise.allSettled([
      send('x'.repeat(MAX_MAILBOX_MESSAGE_TEXT_BYTES + 1)),
      markMessageAsReadByIdentity('worker', 'alpha', first!),
      send('second', 2),
    ])
    expect(results[0]).toMatchObject({ status: 'rejected' })
    expect(results[1]).toEqual({ status: 'fulfilled', value: true })
    expect(results[2]).toEqual({ status: 'fulfilled', value: undefined })
    expect(await readMailbox('worker', 'alpha')).toEqual([
      { ...first!, read: true },
      message('second', false, new Date(2).toISOString()),
    ])
  })

  test('concurrent snapshot acknowledgement and writes keep later messages unread', async () => {
    await send('a', 1)
    const snapshot = await readUnreadMessages('worker', 'alpha')
    const [marked] = await Promise.all([
      markMessagesAsReadBySnapshot('worker', 'alpha', snapshot),
      ...Array.from({ length: 10 }, (_, i) => send(`late-${i}`, 100 + i)),
    ])
    expect(marked).toBe(1)
    const after = await readMailbox('worker', 'alpha')
    expect(after.filter(m => m.read).map(m => m.text)).toEqual(['a'])
    expect(after.filter(m => !m.read)).toHaveLength(10)
  })
})

describe('mark read', () => {
  test('by identity survives compaction shifting indexes', async () => {
    const response = message(
      JSON.stringify({ type: 'permission_response', request_id: 'req-1' }),
      false,
    )
    await seed('worker', 'alpha', [
      response,
      ...Array.from({ length: MAX_MAILBOX_MESSAGES + 20 }, (_, i) =>
        message(`regular-${i}`, false),
      ),
    ])
    await send('newest', 2)

    expect(await markMessageAsReadByIdentity('worker', 'alpha', response)).toBe(
      true,
    )
    const after = await readRaw('worker', 'alpha')
    expect(after.some(m => m.text === response.text && !m.read)).toBe(false)
  })

  test('by identity: false for a missing inbox, a missing message, or corruption', async () => {
    expect(
      await markMessageAsReadByIdentity('worker', 'alpha', message('x', false)),
    ).toBe(false)
    await seed('worker', 'alpha', [message('other', false)])
    expect(
      await markMessageAsReadByIdentity('worker', 'alpha', message('x', false)),
    ).toBe(false)
    expect((await readRaw('worker', 'alpha'))[0]?.read).toBe(false)
    await seedRaw('worker', 'alpha', '{not-json')
    expect(
      await markMessageAsReadByIdentity('worker', 'alpha', message('x', false)),
    ).toBe(false)
  })

  test('identity is [from, timestamp, text]: color and summary do not matter', async () => {
    await seed('worker', 'alpha', [{ ...message('x', false), color: 'red' }])
    expect(
      await markMessageAsReadByIdentity('worker', 'alpha', {
        ...message('x', false),
        summary: 's',
      }),
    ).toBe(true)
  })

  test('snapshot leaves messages appended after the read unread', async () => {
    await seed('worker', 'alpha', [
      message('snapshot-message', false, new Date(10).toISOString()),
    ])
    const snapshot = await readUnreadMessages('worker', 'alpha')
    await send('later-message', 11)

    expect(
      await markMessagesAsReadBySnapshot('worker', 'alpha', snapshot),
    ).toBe(1)
    expect(
      (await readRaw('worker', 'alpha')).map(m => [m.text, m.read]),
    ).toEqual([
      ['snapshot-message', true],
      ['later-message', false],
    ])
  })

  test('snapshot does not over-confirm duplicate identities', async () => {
    const dup = message('duplicate', false, new Date(12).toISOString())
    await seed('worker', 'alpha', [dup])
    const snapshot = await readUnreadMessages('worker', 'alpha')
    await writeToMailbox(
      'worker',
      { from: dup.from, text: dup.text, timestamp: dup.timestamp },
      'alpha',
    )

    await markMessagesAsReadBySnapshot('worker', 'alpha', snapshot)
    expect((await readRaw('worker', 'alpha')).map(m => m.read)).toEqual([
      true,
      false,
    ])
  })

  test('snapshot with readBefore counts an externally read copy without marking a later duplicate', async () => {
    const dup = message('duplicate', false, new Date(13).toISOString())
    await seed('worker', 'alpha', [dup])
    const snapshot = await readUnreadMessages('worker', 'alpha')
    const identity = JSON.stringify([dup.from, dup.timestamp, dup.text])

    await seed('worker', 'alpha', [{ ...dup, read: true }, dup])
    expect(
      await markMessagesAsReadBySnapshot('worker', 'alpha', snapshot, {
        [identity]: 0,
      }),
    ).toBe(1)
    expect((await readRaw('worker', 'alpha')).map(m => m.read)).toEqual([
      true,
      false,
    ])
  })

  test('snapshot with readBefore still marks what is unread', async () => {
    await seed('worker', 'alpha', [message('a', false), message('b', false)])
    const snapshot = await readUnreadMessages('worker', 'alpha')
    expect(
      await markMessagesAsReadBySnapshot('worker', 'alpha', snapshot, {}),
    ).toBe(2)
    expect((await readRaw('worker', 'alpha')).every(m => m.read)).toBe(true)
  })

  test('snapshot: empty, all-read, missing inbox and corruption return 0', async () => {
    expect(await markMessagesAsReadBySnapshot('worker', 'alpha', [])).toBe(0)
    expect(
      await markMessagesAsReadBySnapshot('worker', 'alpha', [
        message('r', true),
      ]),
    ).toBe(0)
    expect(
      await markMessagesAsReadBySnapshot('worker', 'alpha', [
        message('u', false),
      ]),
    ).toBe(0)
    await seedRaw('worker', 'alpha', '{not-json')
    expect(
      await markMessagesAsReadBySnapshot('worker', 'alpha', [
        message('u', false),
      ]),
    ).toBe(0)
  })

  test('markMessagesAsRead of a missing inbox is a no-op', async () => {
    await markMessagesAsRead('nobody', 'alpha')
    expect(await readMailbox('nobody', 'alpha')).toEqual([])
  })
})

describe('formatting and classification', () => {
  test('formatTeammateMessages wraps each message', () => {
    expect(
      formatTeammateMessages([
        { from: 'a', text: 'one', timestamp: 't' },
        { from: 'b', text: 'two', timestamp: 't', color: 'red', summary: 's' },
      ]),
    ).toBe(
      '<teammate-message teammate_id="a">\none\n</teammate-message>\n\n' +
        '<teammate-message teammate_id="b" color="red" summary="s">\ntwo\n</teammate-message>',
    )
  })

  test('isStructuredProtocolMessage recognises the protocol types only', () => {
    for (const type of [
      'permission_request',
      'permission_response',
      'sandbox_permission_request',
      'sandbox_permission_response',
      'shutdown_request',
      'shutdown_approved',
      'team_permission_update',
      'mode_set_request',
      'plan_approval_request',
      'plan_approval_response',
    ]) {
      expect(isStructuredProtocolMessage(JSON.stringify({ type }))).toBe(true)
    }
    for (const text of [
      JSON.stringify({ type: 'shutdown_rejected' }),
      JSON.stringify({ type: 'constructor' }),
      JSON.stringify({ kind: 'permission_request' }),
      'permission_request',
      '{broken',
      'null',
    ]) {
      expect(isStructuredProtocolMessage(text)).toBe(false)
    }
  })

  test('sanitizers', () => {
    expect(sanitizePathComponent('a_b.c d')).toBe('a_b-c-d')
    expect(sanitizePathComponent('con')).toBe('con')
    expect(sanitizeName('My_Team.x')).toBe('my-team-x')
    expect(sanitizeName('con')).toBe('_con')
    expect(sanitizeName('LPT1')).toBe('_lpt1')
    expect(sanitizeName('nullable')).toBe('nullable')
  })
})
