// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeFileSync } from 'node:fs'

// Runs before the actual entry, with no omp import or environment mutation.
// The snapshot contains only test-owned variables, never ambient credentials.
process.on('exit', () => {
  const path = process.env.QIANMO_TEST_ENV_SNAPSHOT
  if (!path) return
  const names = [
    'HOME',
    'QIANMO_CONFIG_DIR',
    'QIANMO_MEMORY_DIR',
    'QIANMO_OMP_ENTRY',
    'PI_CONFIG_DIR',
    'PI_NATIVES_DIR',
    'pi_config_dir',
    'Pi_Natives_Dir',
    'OMP_PROFILE',
    'PI_CODING_AGENT_DIR',
    'XDG_CONFIG_HOME',
    'CLAUDE_CONFIG_DIR',
    'ENTRY_LITERAL_KEY',
    'entry_literal_header',
    'ENTRY_UNRELATED',
  ]
  writeFileSync(
    path,
    JSON.stringify(
      Object.fromEntries(names.map(name => [name, process.env[name]])),
    ),
  )
})
