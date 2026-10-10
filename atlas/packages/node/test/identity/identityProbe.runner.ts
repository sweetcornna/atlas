// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Out-of-process probe for identityIsolation.test.ts.
 *
 * Path resolution reads HOME and the environment, and omp's own directory
 * module fixes its roots when it loads, so each observation needs a fresh
 * process with the environment the test chose.
 *
 * Subcommands (argv[2]):
 *   qm      → the `@qianmo/paths` surface as JSON
 *   omp     → what an omp child started the way qm starts it resolves for its
 *             config root, agent dir and sessions dir (`@oh-my-pi/pi-utils/dirs`
 *             loaded under `ompSpawnEnv()`)
 *   omp-dirs <json env>  → internal: the omp half, run inside the child
 */

import { spawnSync } from 'node:child_process'
import {
  caDir,
  memoryBaseDir,
  ompAgentDir,
  ompConfigRoot,
  protectedConfigRoots,
  qianmoConfigDir,
} from '@qianmo/paths'
import { ompSpawnEnv } from '../../src/omp/launch.js'

const command = process.argv[2] ?? 'qm'

if (command === 'qm') {
  process.stdout.write(
    JSON.stringify({
      configDir: qianmoConfigDir(),
      ompConfigRoot: ompConfigRoot(),
      ompAgentDir: ompAgentDir(),
      caDir: caDir(),
      memoryBaseDir: memoryBaseDir(),
      protectedRoots: protectedConfigRoots(),
    }),
  )
} else if (command === 'omp') {
  const child = spawnSync(
    process.execPath,
    ['run', import.meta.path, 'omp-dirs'],
    { env: ompSpawnEnv(), encoding: 'utf8' },
  )
  if (child.status !== 0) {
    process.stderr.write(child.stderr)
    process.exit(child.status ?? 1)
  }
  process.stdout.write(child.stdout)
} else if (command === 'omp-dirs') {
  const dirs = await import('@oh-my-pi/pi-utils/dirs')
  process.stdout.write(
    JSON.stringify({
      configRoot: dirs.getConfigRootDir(),
      agentDir: dirs.getAgentDir(),
    }),
  )
} else {
  process.stderr.write(`unknown probe command: ${command}\n`)
  process.exit(2)
}
