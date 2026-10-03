// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Running this CLI from source for the `qm provider` suites: the entrypoint
 * with the shipped defines and feature list, the way the resident suites start
 * `--acp` and `qm resident` — so what runs is the code under test, not a
 * build.
 */

import { join } from 'node:path'
import {
  macroDefineArgs,
  resolveBuildFeatures,
} from '../../../../scripts/defines.js'
import { inheritedProviderKeyNames } from '../../../services/qianmo/providers/whitelist.js'
import type { CliLaunchSpec } from '../../../utils/process/cliLaunch.js'

const CLI_ENTRYPOINT = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'entrypoints',
  'cli.tsx',
)

/** `bun run <defines> <features> src/entrypoints/cli.tsx <cliArgs>` */
export function sourceArgs(cliArgs: readonly string[]): string[] {
  return [
    'run',
    ...macroDefineArgs(),
    '-d',
    `process.env.NODE_ENV:${JSON.stringify('production')}`,
    ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
    CLI_ENTRYPOINT,
    ...cliArgs,
  ]
}

/** A launch for the code's own child processes, from source. */
export function sourceLaunch(
  cliArgs: string[],
  env: NodeJS.ProcessEnv,
): CliLaunchSpec {
  return {
    execPath: process.execPath,
    args: sourceArgs(cliArgs),
    env,
    windowsHide: false,
  }
}

/**
 * The environment a test child gets: this process's, minus whatever a
 * developer's shell set for running occ or naming a model, plus the given
 * overrides.
 */
export function childEnv(
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.OCC_CONFIG_DIR
  delete env.CLAUDE_CONFIG_DIR
  for (const key of inheritedProviderKeyNames(env)) delete env[key]
  return { ...env, NODE_ENV: 'production', NO_COLOR: '1', ...overrides }
}
