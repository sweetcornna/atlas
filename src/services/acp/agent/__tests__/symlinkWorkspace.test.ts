// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A workspace reached through a symlink (P18.3 finding). An ACP session's
// transcript was written under the cwd as given and looked up on resume under
// its realpath, so every resume of such a session started empty.
//
// The end-to-end case — a real `--acp` child writes a turn, is stopped, and
// a second one resumes it — is in tests/integration/acp-exit-transcript.test.ts.
// These pin the contract that makes it hold: the write key IS the lookup key,
// and the key older builds wrote is still found.
//
// Deliberately nothing here goes through the process-global session
// (`switchSession`, `getSessionId`, the transcript writer): several suites
// install a `bootstrap/state` mock with no teardown that pins those for every
// later file in the shard (see tests/mocks/state.ts), so a case built on them
// passes or fails by file order. The child process in the integration test is
// out of their reach.
//
// No mock.module; isolation comes from CLAUDE_CONFIG_DIR and real temp
// directories.

const { projectDirForSessionCwd, resolveAcpSessionFile } = await import(
  '../sessionWorkspace.js'
)
const { canonicalizePath, getProjectDir } = await import(
  '../../../../utils/session/sessionStoragePortable.js'
)

const SESSION = '33333333-3333-4333-8333-333333333333'

let configDir: string
let root: string
let real: string
let link: string
let originalConfigDir: string | undefined

/** A transcript file with one user line, written straight to `projectDir`. */
function writeTranscriptAt(projectDir: string, text: string): string {
  mkdirSync(projectDir, { recursive: true })
  const file = join(projectDir, `${SESSION}.jsonl`)
  writeFileSync(
    file,
    `${JSON.stringify({
      type: 'user',
      uuid: 'cccccccc-3333-4333-8333-cccccccccccc',
      parentUuid: null,
      sessionId: SESSION,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: text },
    })}\n`,
  )
  return file
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-acp-symlink-config-'))
  // Resolved, so the only link in play is the one made below.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'occ-acp-symlink-')))
  real = join(root, 'workspace')
  link = join(root, 'workspace-link')
  mkdirSync(real)
  symlinkSync(real, link, 'dir')

  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir

  rmSync(configDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('ACP session at a symlinked cwd', () => {
  test('the write key is the key resume looks under', async () => {
    expect(projectDirForSessionCwd(link)).toBe(
      getProjectDir(await canonicalizePath(link)),
    )
    expect(projectDirForSessionCwd(link)).toBe(projectDirForSessionCwd(real))
  })

  test('a cwd that does not resolve keys the same on both sides', async () => {
    const missing = join(root, 'not-created-yet')
    expect(projectDirForSessionCwd(missing)).toBe(
      getProjectDir(await canonicalizePath(missing)),
    )
  })

  test('a transcript an older build wrote under the cwd as given is found', async () => {
    const legacy = writeTranscriptAt(
      getProjectDir(link.normalize('NFC')),
      'written by an older build',
    )

    const resolved = await resolveAcpSessionFile(SESSION, link)
    expect(resolved?.filePath).toBe(legacy)
  })

  test('the canonical transcript wins when both keys hold one', async () => {
    writeTranscriptAt(getProjectDir(link.normalize('NFC')), 'older')
    const canonical = writeTranscriptAt(projectDirForSessionCwd(link), 'newer')

    const resolved = await resolveAcpSessionFile(SESSION, link)
    expect(resolved?.filePath).toBe(canonical)
  })

  test('an empty legacy file is not a session', async () => {
    const dir = getProjectDir(link.normalize('NFC'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SESSION}.jsonl`), '')

    expect(await resolveAcpSessionFile(SESSION, link)).toBeUndefined()
  })

  test('a cwd without a symlink has one key and no second look', async () => {
    writeTranscriptAt(getProjectDir(link.normalize('NFC')), 'other key')

    // `real` is already canonical: the legacy key is the canonical one, so a
    // transcript under some other key is not this cwd's.
    expect(await resolveAcpSessionFile(SESSION, real)).toBeUndefined()
  })
})
