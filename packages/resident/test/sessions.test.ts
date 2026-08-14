// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, mock, test } from 'bun:test'
import { MemoryResidentSessionStore } from '../src/session-store.js'
import { ResidentSessionManager } from '../src/sessions.js'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('resident session manager', () => {
  test('creates and durably maps a first session', async () => {
    const store = new MemoryResidentSessionStore()
    const connection = {
      initialize: mock(async () => {}),
      newSession: mock(async () => SESSION_ID),
      resumeSession: mock(async () => {}),
    }
    const manager = new ResidentSessionManager({
      connection,
      store,
      agents: [{ agent: 'reviewer', cwd: '/workspace' }],
    })

    await manager.start()

    expect(store.get('reviewer')).toBe(SESSION_ID)
    expect(manager.sessionOf('reviewer')).toBe(SESSION_ID)
    expect(connection.resumeSession).not.toHaveBeenCalled()
  })

  test('resumes a stored session after ACP process restart', async () => {
    const store = new MemoryResidentSessionStore()
    store.set('reviewer', SESSION_ID)
    const connection = {
      initialize: mock(async () => {}),
      newSession: mock(async () => 'unused'),
      resumeSession: mock(async () => {}),
    }
    const manager = new ResidentSessionManager({
      connection,
      store,
      agents: [{ agent: 'reviewer', cwd: '/workspace' }],
    })

    await manager.start()

    expect(connection.resumeSession).toHaveBeenCalledWith({
      agent: 'reviewer',
      cwd: '/workspace',
      sessionId: SESSION_ID,
    })
    expect(connection.newSession).not.toHaveBeenCalled()
  })

  test('rejects duplicate agent mappings before opening ACP', () => {
    expect(
      () =>
        new ResidentSessionManager({
          connection: {
            initialize: async () => {},
            newSession: async () => SESSION_ID,
            resumeSession: async () => {},
          },
          store: new MemoryResidentSessionStore(),
          agents: [
            { agent: 'reviewer', cwd: '/one' },
            { agent: 'reviewer', cwd: '/two' },
          ],
        }),
    ).toThrow('duplicate resident agent')
  })
})
