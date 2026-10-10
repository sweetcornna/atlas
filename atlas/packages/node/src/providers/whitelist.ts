// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { CONFIG_DIR_BASENAME } from '@qianmo/paths'

/** Ambient credentials must not override node-managed custom providers. */
const KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'GEMINI_BASE_URL',
  'GROK_BASE_URL',
])
export function inheritedProviderKeyNames(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.keys(env)
    .filter(
      key =>
        env[key] !== undefined &&
        (KEYS.has(key.toUpperCase()) ||
          key.toUpperCase().startsWith('CLAUDE_CODE_')),
    )
    .sort()
}

/** These names must remain available for process and isolation invariants. */
export function isRuntimeEnvironmentName(value: string): boolean {
  const name = value.toUpperCase()
  return (
    /^(?:PI_|QIANMO_|OMP_|BUN_|NODE_|LD_|DYLD_)/.test(name) ||
    new Set([
      'PATH',
      'PATHEXT',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'SYSTEMROOT',
      'SYSTEMDRIVE',
      'TEMP',
      'TMP',
      'TMPDIR',
    ]).has(name)
  )
}

/** omp resolves config strings as env-variable names before treating them as literals.
 * Remove colliding names so a profile cannot read an unrelated inherited credential.
 * Case folding also protects Windows, where environment names are case insensitive.
 */
export function withoutModelConfigEnvironment<T extends NodeJS.ProcessEnv>(
  parent: T,
  models: unknown,
): T {
  const names = new Set<string>()
  const record = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  const collect = (p: Record<string, unknown>) => {
    if (typeof p.apiKey === 'string') names.add(p.apiKey.toUpperCase())
    if (record(p.headers))
      for (const value of Object.values(p.headers))
        if (typeof value === 'string') names.add(value.toUpperCase())
  }
  if (record(models) && record(models.providers))
    for (const [id, p] of Object.entries(models.providers)) {
      if (!id.startsWith('qm-') || !record(p)) continue
      collect(p)
      if (Array.isArray(p.models))
        for (const model of p.models) if (record(model)) collect(model)
    }
  const env = { ...parent }
  for (const name of Object.keys(env))
    if (names.has(name.toUpperCase())) delete env[name]
  return env
}

/** A current-node wrapper for resident, standalone qm agent, and compiled entry. */
export function withoutManagedConfigEnvironment<T extends NodeJS.ProcessEnv>(
  parent: T,
): T {
  let models: unknown
  const childHome = resolve(parent.HOME || parent.USERPROFILE || homedir())
  const root = (
    parent.QIANMO_CONFIG_DIR
      ? resolve(parent.QIANMO_CONFIG_DIR)
      : join(childHome, CONFIG_DIR_BASENAME)
  ).normalize('NFC')
  try {
    models = Bun.YAML.parse(
      readFileSync(join(root, 'omp', 'agent', 'models.yml'), 'utf8'),
    )
  } catch {
    return { ...parent }
  }
  return withoutModelConfigEnvironment(parent, models)
}
