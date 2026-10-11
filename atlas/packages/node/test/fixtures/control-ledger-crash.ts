// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ControlRegistry } from '../../src/host/control.js'

const [ledgerPath, operationId, marker] = process.argv.slice(2)
if (!ledgerPath || !operationId || !marker)
  throw new Error('missing fixture arguments')
const registry = new ControlRegistry({ ledgerPath })
registry.register(
  'files',
  async () => {
    await Bun.write(marker, 'executed')
    // The receiving process dies after the effect, before result persistence.
    process.exit(0)
  },
  { sideEffects: () => true },
)
await registry.handle(
  'files.write',
  { path: 'a' },
  { peer: 'hub', actor: 'alice', taskId: 'old', operationId },
)
