// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fresh process asking the node's key pool for a session's key — the
 * "after a restart" half of `credentialPool.test.ts` (P18.18 completion
 * standard 6). The spawning test owns the config root (`CLAUDE_CONFIG_DIR`)
 * and the provider env; this prints one marked JSON line with the key id the
 * pool chose (never its value) and the per-key status.
 */

import { activeCredentialPool, keyPoolStatus } from '../../credentialPool.js'

const sessionId = process.argv[2] ?? 'restart-session'
const pool = activeCredentialPool()
let key: string | null = null
let error: string | null = null
try {
  key = pool === null ? null : pool.keyFor(sessionId).id
} catch (caught) {
  error = caught instanceof Error ? caught.name : 'error'
}
process.stdout.write(
  `QIANMO_POOL ${JSON.stringify({
    pool: pool !== null,
    key,
    error,
    status: keyPoolStatus(),
  })}\n`,
)
