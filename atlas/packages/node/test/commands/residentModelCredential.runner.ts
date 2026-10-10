// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { nodeHasModelCredential } from '../../src/commands/resident.js'
import { isolatedRoot } from '../providers/fake.js'
import { applyRequest } from '../providers/helpers.js'
import {
  stageProviderApply,
  commitPendingProviderConfig,
} from '../../src/providers/node.js'
test('isolated startup credential check follows committed native model config', async () => {
  const f = isolatedRoot()
  try {
    expect(nodeHasModelCredential()).toBe(false)
    expect(stageProviderApply(applyRequest()).ok).toBe(true)
    expect(nodeHasModelCredential()).toBe(false)
    await commitPendingProviderConfig()
    expect(nodeHasModelCredential()).toBe(true)
  } finally {
    f.dispose()
  }
})
