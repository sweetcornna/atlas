// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { UUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Message } from '../../../../types/message.js'

// A workspace reached through a symlink (P18.3 finding). An ACP session's
// transcript was written under the cwd as given and looked up on resume under
// its realpath, so every resume of such a session started empty.
//
// The end-to-end case — a real `--acp` child, stopped and resumed — is in
// tests/integration/acp-exit-transcript.test.ts. These pin the contract that
// makes it hold: the write key IS the lookup key, and the key older builds
// wrote is still found.
//
// No mock.module, same as workspaceIsolation.test.ts next door: isolation
// comes from CLAUDE_CONFIG_DIR and real temp directories.

const {
  activateAcpSessionWorkspace,
  projectDirForSessionCwd,
  resolveAcpSessionFile,
} = await import('../sessionWorkspace.js')
const { resetStateForTests } = await import('../../../../bootstrap/state.js')
const {
  clearSessionMessagesCache,
  flushSessionStorage,
  getLastSessionLog,
  recordTranscript,
  resetProjectForTesting,
} = await import('../../../../utils/sessionStorage.js')
const { canonicalizePath, getProjectDir } = await import(
  '../../../../utils/session/sessionStoragePortable.js'
)

const SESSION = '33333333-3333-4333-8333-333333333333'

let configDir: string
let root: string
let real: string
let link: string
let originalConfigDir: string | undefined
let originalTestPersistence: string | undefined

function userMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid: uuid as UUID,
    message: { role: 'user', content: text },
  } as unknown as Message
}

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
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

  resetProjectForTesting()
  clearSessionMessagesCache()
})

afterEach(async () => {
  await flushSessionStorage()
  clearSessionMessagesCache()
  resetProjectForTesting()
  resetStateForTests()

  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTestPersistence === undefined)
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence

  rmSync(configDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  resetProjectForTesting()
  clearSessionMessagesCache()
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

  test('a turn written at the symlinked cwd is there on resume', async () => {
    // What createSession does, then a turn's transcript write.
    activateAcpSessionWorkspace({
      sessionId: SESSION,
      cwd: link,
      projectDir: projectDirForSessionCwd(link),
    })
    await recordTranscript([
      userMessage('aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'symlinked turn'),
    ])
    await flushSessionStorage()

    // What getOrCreateSession does in a fresh process.
    clearSessionMessagesCache()
    resetProjectForTesting()
    resetStateForTests()
    const resolved = await resolveAcpSessionFile(SESSION, link)
    expect(resolved).toBeDefined()
    activateAcpSessionWorkspace({
      sessionId: SESSION,
      cwd: link,
      projectDir: dirname(resolved!.filePath),
    })
    const log = await getLastSessionLog(SESSION as UUID)
    expect(JSON.stringify(log?.messages ?? [])).toContain('symlinked turn')
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
