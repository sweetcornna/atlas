// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileMemoryStore } from '@qianmo/memory'
import {
  ResidentMemorySidecar,
  parseMemoryPartition,
  resolveMemoryPartition,
  requireMemoryPartition,
  writeResidentMemory,
  sessionKeyOf,
  contextOfSessionKey,
  isSessionKey,
} from '../src/index.js'

let root: string, store: FileMemoryStore
const ALICE = 'u:0123456789abcdef',
  BOB = 'u:abcdef0123456789'
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-p23-recall-'))
  store = new FileMemoryStore({ root })
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('a preference approved in one conversation is recalled in another for its account, never for another account or an anonymous task', () => {
  const written = writeResidentMemory(store, {
    agent: 'helper',
    contextId: 'chat-1',
    scope: 'long',
    owner: ALICE,
    kind: 'preference',
    title: '先给结论',
    summary: '回复先给结论',
    body: '再说原因',
    source: { kind: 'agent', id: 'one-approval' },
  })
  const sidecar = new ResidentMemorySidecar({ store })
  const first = sidecar.renderFrozen({
    agent: 'helper',
    contextId: 'chat-1',
    owner: ALICE,
  })
  const second = sidecar.renderFrozen({
    agent: 'helper',
    contextId: 'chat-2',
    owner: ALICE,
  })
  expect(first.memoryIds).toEqual([written.id])
  expect(second.memoryIds).toEqual([written.id])
  expect(
    sidecar.render({ agent: 'helper', contextId: 'chat-2', owner: BOB }),
  ).toBe('')
  expect(sidecar.render({ agent: 'helper', contextId: 'chat-1' })).toBe('')
  expect(
    sidecar.render({ agent: 'other', contextId: 'chat-2', owner: ALICE }),
  ).toBe('')
  expect(() =>
    writeResidentMemory(store, {
      agent: 'helper',
      contextId: 'chat-1',
      scope: 'long',
      title: 'x',
      summary: 'x',
      body: '',
      source: { kind: 'agent', id: 'approval' },
    }),
  ).toThrow('verified account')
  store.revoke(written.id, { by: ALICE, reason: '不要了' })
  expect(first.block).toContain(written.id) // A frozen turn does not change mid-flight.
  expect(
    sidecar.render({ agent: 'helper', contextId: 'chat-3', owner: ALICE }),
  ).toBe('')
})

test('long memory wins a shared budget even when the conversation has a stronger keyword match', () => {
  const long = writeResidentMemory(store, {
    agent: 'helper',
    contextId: 'chat',
    scope: 'long',
    owner: ALICE,
    title: '偏好',
    summary: '偏好',
    body: '',
    source: { kind: 'agent', id: 'approval' },
  })
  writeResidentMemory(store, {
    agent: 'helper',
    contextId: 'chat',
    owner: ALICE,
    title: 'deploy',
    summary: 'deploy deploy',
    body: '',
    source: { kind: 'agent', id: 'approval2' },
  })
  const capped = new ResidentMemorySidecar({
    store,
    budget: { maxEntries: 1, maxChars: 20000 },
  })
  expect(
    capped.renderFrozen(
      { agent: 'helper', contextId: 'chat', owner: ALICE },
      'deploy',
    ).memoryIds,
  ).toEqual([long.id])
  const both = new ResidentMemorySidecar({ store }).renderFrozen(
    { agent: 'helper', contextId: 'chat', owner: ALICE },
    'deploy',
  )
  expect(both.memoryIds).toHaveLength(2)
  expect(both.memoryIds![0]).toBe(long.id)
})

test('a raw context equal to a long directory cannot reach it; typed parsing and membership use the same namespace', () => {
  const long = resolveMemoryPartition({
    scope: 'long',
    agent: 'helper',
    owner: ALICE,
  })
  expect(parseMemoryPartition(long)).toEqual({
    scope: 'long',
    agentKey: 'v-helper',
    owner: ALICE,
  })
  for (const contextId of [
    long.taskId,
    'lt',
    '../bad',
    `l-${BOB.slice(2)}`,
    'legacy:admin',
  ]) {
    const conversation = resolveMemoryPartition({
      scope: 'conversation',
      agent: 'helper',
      contextId,
    })
    expect(conversation.taskId).not.toBe(long.taskId)
    expect(parseMemoryPartition(conversation)?.scope).toBe('conversation')
  }
  const entry = store.write({
    scope: long,
    title: 't',
    summary: 's',
    body: '',
    source: { kind: 'user', id: ALICE },
  })
  expect(() =>
    requireMemoryPartition(
      store,
      { scope: 'long', agent: 'helper', owner: BOB },
      entry.id,
    ),
  ).toThrow('this partition')
  expect(() =>
    resolveMemoryPartition({ scope: 'long', agent: '../helper', owner: ALICE }),
  ).toThrow('agent')
  expect(() =>
    resolveMemoryPartition({
      scope: 'long',
      agent: 'helper',
      owner: 'legacy:view',
    }),
  ).toThrow('verified account')
})

test('verified account RPC keys survive persistence and cannot be spelled by a raw context or another account', () => {
  const owned = sessionKeyOf('helper', 'chat', ALICE)
  expect(isSessionKey(owned)).toBe(true)
  expect(owned).not.toBe(sessionKeyOf('helper', 'chat', BOB))
  expect(owned).not.toBe(sessionKeyOf('helper', 'chat'))
  expect(owned).not.toBe(sessionKeyOf('helper', contextOfSessionKey(owned)))
  const conversation = resolveMemoryPartition({
    scope: 'conversation',
    agent: 'helper',
    contextId: 'chat',
    owner: ALICE,
  })
  expect(conversation).not.toEqual(
    resolveMemoryPartition({
      scope: 'conversation',
      agent: 'helper',
      contextId: 'chat',
    }),
  )
  expect(() => sessionKeyOf('helper', 'chat', 'legacy:view')).toThrow('owner')
})
