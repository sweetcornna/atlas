// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FileMemoryStore, MemoryEventType } from '../src/index.js'
const [root, oldId, operation] = process.argv.slice(2)
if (!root || !oldId) throw new Error('missing crash fixture arguments')
const scope = { layer: 'project' as const, projectKey: 'atlas' }
const store = new FileMemoryStore({
  root,
  now: () => new Date('2026-10-01T00:00:00Z'),
  newId: () => 'replacement',
  onEvent(event) {
    if (
      event.type ===
      (operation === 'undo'
        ? MemoryEventType.SupersessionUndone
        : MemoryEventType.SupersessionWritten)
    )
      process.kill(process.pid, 'SIGKILL')
  },
})
if (operation === 'undo')
  store.undoSupersedes(oldId, {
    scope,
    writer: 'operator',
    by: 'operator:crash',
    reason: 'mistaken replacement',
  })
else
  store.write(
    {
      scope,
      title: 'new',
      summary: 'new',
      body: 'new decision',
      source: { kind: 'user', id: 'local' },
      supersedes: [oldId],
    },
    'operator',
  )
throw new Error('fixture did not reach the crash point')
