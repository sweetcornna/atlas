// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HANDOFF_GIT_IDENTITY } from '../src/shadow.js'
import { sessionCommit } from '../src/session.js'
import {
  cleanupTemporaries,
  commitAll,
  FAKE_GITHUB_PAT,
  git,
  initRepo,
  tempDir,
  userState,
  write,
} from './helpers.js'

afterAll(cleanupTemporaries)

const NAME = 'rollout-2026-10-03T01-00-00-0199a3b2.jsonl'

function transcript(): string {
  const file = join(tempDir(), NAME)
  writeFileSync(file, '{"type":"session_meta"}\r\n{"type":"turn"}\n')
  return file
}

describe('sessionCommit', () => {
  test('one file, one tree entry, bytes unchanged, no ref touched', async () => {
    const repo = initRepo()
    write(repo, '.gitattributes', '* text=auto eol=lf\n')
    write(repo, 'a.txt', 'a\n')
    commitAll(repo)
    const file = transcript()
    const before = userState(repo)

    const first = await sessionCommit({ cwd: repo, file })
    expect(first.name).toBe(NAME)
    expect(git(repo, 'ls-tree', first.commit)).toBe(
      `100644 blob ${first.blob}\t${NAME}`,
    )
    expect(git(repo, 'rev-parse', `${first.commit}^{tree}`)).toBe(first.tree)
    // CRLF survives: no attribute conversion on the way in.
    const stored = Bun.spawnSync(['git', 'cat-file', 'blob', first.blob], {
      cwd: repo,
    }).stdout
    expect(Buffer.from(stored).equals(readFileSync(file))).toBe(true)
    expect(git(repo, 'rev-list', '--parents', '-n', '1', first.commit)).toBe(
      first.commit,
    )
    expect(git(repo, 'log', '-1', '--format=%an <%ae>', first.commit)).toBe(
      `${HANDOFF_GIT_IDENTITY.name} <${HANDOFF_GIT_IDENTITY.email}>`,
    )
    expect(userState(repo)).toEqual(before)
  })

  test('the second sync is a child of the first', async () => {
    const repo = initRepo()
    const file = transcript()
    const first = await sessionCommit({ cwd: repo, file })
    appendFileSync(file, '{"type":"turn","n":2}\n')
    const second = await sessionCommit({
      cwd: repo,
      file,
      parent: first.commit,
    })
    expect(second.commit).not.toBe(first.commit)
    expect(git(repo, 'rev-parse', `${second.commit}^`)).toBe(first.commit)
    expect(git(repo, 'rev-list', '--count', second.commit)).toBe('2')
    expect(git(repo, 'show', `${second.commit}:${NAME}`)).toContain('"n":2')
  })

  test('works in an unborn repository and with an explicit entry name', async () => {
    const repo = initRepo()
    const result = await sessionCommit({
      cwd: repo,
      file: transcript(),
      name: 'session.jsonl',
    })
    expect(git(repo, 'ls-tree', '--name-only', result.commit)).toBe(
      'session.jsonl',
    )
  })

  test('rejects unusable names and malformed parents before touching git', async () => {
    const repo = initRepo()
    const file = transcript()
    for (const name of ['', '.', '..', '.git', 'a/b', 'a\\b', 'a\nb']) {
      await expect(sessionCommit({ cwd: repo, file, name })).rejects.toThrow(
        TypeError,
      )
    }
    await expect(
      sessionCommit({ cwd: repo, file, parent: 'HEAD' }),
    ).rejects.toThrow(TypeError)
  })

  test('a parent that does not exist is a git error, not a root commit', async () => {
    const repo = initRepo()
    await expect(
      sessionCommit({ cwd: repo, file: transcript(), parent: 'f'.repeat(40) }),
    ).rejects.toThrow('commit-tree')
  })
})

describe('sessionCommit: redaction, given bytes, unchanged parent', () => {
  test('secrets are replaced before hashing; counts and rule ids come back', async () => {
    const repo = initRepo()
    const file = join(tempDir(), 'transcript.jsonl')
    writeFileSync(
      file,
      `{"type":"user","text":"token ${FAKE_GITHUB_PAT} here"}\n` +
        `{"type":"tool","out":"again ${FAKE_GITHUB_PAT}"}\n`,
    )
    const result = await sessionCommit({ cwd: repo, file, redact: true })
    const stored = git(repo, 'cat-file', 'blob', result.blob)
    expect(stored).not.toContain(FAKE_GITHUB_PAT)
    expect(stored).toContain('[REDACTED]')
    expect(result.redactions).toEqual({ count: 2, ruleIds: ['github-pat'] })
    // The file itself is not touched.
    expect(readFileSync(file, 'utf8')).toContain(FAKE_GITHUB_PAT)
  })

  test('without a hit the bytes are committed exactly; redactions report zero', async () => {
    const repo = initRepo()
    const file = transcript()
    const result = await sessionCommit({ cwd: repo, file, redact: true })
    const stored = Bun.spawnSync(['git', 'cat-file', 'blob', result.blob], {
      cwd: repo,
    }).stdout
    expect(Buffer.from(stored).equals(readFileSync(file))).toBe(true)
    expect(result.redactions).toEqual({ count: 0, ruleIds: [] })
  })

  test('content commits only the given prefix; the file still names the entry', async () => {
    const repo = initRepo()
    const file = transcript()
    const prefix = readFileSync(file).subarray(0, 24)
    appendFileSync(file, '{"type":"half')
    const result = await sessionCommit({ cwd: repo, file, content: prefix })
    expect(result.name).toBe(NAME)
    const stored = Bun.spawnSync(['git', 'cat-file', 'blob', result.blob], {
      cwd: repo,
    }).stdout
    expect(Buffer.from(stored).equals(prefix)).toBe(true)
  })

  test('the same tree as the parent returns the parent', async () => {
    const repo = initRepo()
    const file = transcript()
    const first = await sessionCommit({ cwd: repo, file })
    const again = await sessionCommit({ cwd: repo, file, parent: first.commit })
    expect(again.reused).toBe(true)
    expect(again.commit).toBe(first.commit)
    appendFileSync(file, '{"type":"turn","n":2}\n')
    const next = await sessionCommit({ cwd: repo, file, parent: first.commit })
    expect(next.reused).toBe(false)
    expect(git(repo, 'rev-parse', `${next.commit}^`)).toBe(first.commit)
  })
})
