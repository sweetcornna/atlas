// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileResidentSessionStore } from '../src/session-store.js'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let directory: string
let path: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-sessions-'))
  path = join(directory, 'resident', 'sessions.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('resident session store', () => {
  test('atomically persists identity-scoped agent sessions', () => {
    const store = new FileResidentSessionStore(path)
    store.set('reviewer', SESSION_ID)

    const reopened = new FileResidentSessionStore(path)
    expect(reopened.entries()).toEqual({ reviewer: SESSION_ID })
    expect(statSync(join(directory, 'resident')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('fails closed on corrupt or invalid content', () => {
    mkdirSync(join(directory, 'resident'), { recursive: true })
    writeFileSync(path, 'not-json')
    expect(() => new FileResidentSessionStore(path)).toThrow('corrupt')

    writeFileSync(path, JSON.stringify({ '../escape': SESSION_ID }))
    expect(() => new FileResidentSessionStore(path)).toThrow('invalid')
  })
})
