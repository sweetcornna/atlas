// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { qianmoConfigDir } from '@qianmo/paths'
import { defaultMemoryRoot, FileMemoryStore } from '@qianmo/memory'
import {
  FileEmbeddingUsageMeter,
  FileVectorIndex,
  backfillVectors,
} from '@qianmo/recall'
import {
  createMemoryEmbedder,
  readEmbeddingConfig,
} from '../host/memoryEmbedding.js'
import { residentModelProbeInputs } from './resident.js'

/** Explicit local operator action: never reachable from an agent tool. */
export async function runMemoryIndex(args: readonly string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: qm memory backfill|rebuild --max-chars <integer>\nUses <config>/memory/embedding.json and its dailyTokenLimit. Rebuild clears only disposable vectors.\n',
    )
    return 0
  }
  try {
    if (
      args.length !== 3 ||
      args[1] !== '--max-chars' ||
      !/^\d+$/.test(args[2] ?? '')
    )
      throw new Error(
        'backfill/rebuild requires explicit --max-chars <integer>',
      )
    const config = readEmbeddingConfig(residentModelProbeInputs()?.baseUrl)
    if (config === null) throw new Error('memory embedding is disabled')
    const root = defaultMemoryRoot()
    if (!isAbsolute(root)) throw new Error('memory root must be absolute')
    for (const path of [root, qianmoConfigDir()]) {
      if (
        process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        statSync(path).uid !== process.getuid()
      )
        throw new Error('run memory index as the node state owner')
    }
    const store = new FileMemoryStore({ root, readOnly: true })
    const index = new FileVectorIndex(store.root)
    try {
      if (args[0] === 'rebuild') index.clear()
      index.prune(store)
      const result = await backfillVectors({
        entries: store.query(),
        index,
        embedder: createMemoryEmbedder(config),
        meter: new FileEmbeddingUsageMeter({
          dailyTokenLimit: config.dailyTokenLimit ?? 0,
        }),
        maxChars: Number(args[2]),
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } finally {
      index.close()
    }
    return 0
  } catch (error) {
    process.stderr.write(
      `memory index: ${error instanceof Error ? error.message : 'failed'}\n`,
    )
    return 1
  }
}
