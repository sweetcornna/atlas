// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, writeFileSync } from 'node:fs'
import { FileMemoryStore } from '../src/index.js'
const [root, oldId, id, go] = process.argv.slice(2)
if (!root || !oldId || !id || !go)
  throw new Error('missing race fixture arguments')
const store = new FileMemoryStore({ root, newId: () => id })
writeFileSync(`${go}.${id}.ready`, '')
while (!existsSync(go)) await new Promise(resolve => setTimeout(resolve, 5))
try {
  store.write(
    {
      scope: { layer: 'project', projectKey: 'atlas' },
      title: id,
      summary: id,
      body: id,
      source: { kind: 'user', id: 'local' },
      supersedes: [oldId],
    },
    'operator',
  )
  process.stdout.write(JSON.stringify({ ok: true, id }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }))
}
