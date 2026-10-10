// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a Qianmo node keeps its state, and how the omp agent child is kept
 * inside it.
 *
 * Every function reads the environment on each call: tests and the resident
 * host both change `QIANMO_CONFIG_DIR` at runtime, and a memoized value would
 * silently keep pointing at the old root.
 */

import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

/** The node identity. Names the config root, the CA directory and the CA CN prefix. */
export const IDENTITY = 'qianmo'

/** Basename of the default config root under the home directory. */
export const CONFIG_DIR_BASENAME = '.qianmo'

/** Environment variable that overrides the config root. */
export const CONFIG_DIR_ENV = 'QIANMO_CONFIG_DIR'

function fromEnv(name: string, fallback: string): string {
  const configured = process.env[name]
  return (configured ? resolve(configured) : fallback).normalize('NFC')
}

/** OS home used by node policy and its immutable replay environment. */
export function nodeHomeDir(): string {
  return homedir().normalize('NFC')
}

/** The node's config root: `QIANMO_CONFIG_DIR`, else `~/.qianmo`. */
export function qianmoConfigDir(): string {
  return fromEnv(CONFIG_DIR_ENV, join(homedir(), CONFIG_DIR_BASENAME))
}

/** A path inside the config root. */
export function qianmoConfigPath(...segments: string[]): string {
  return join(qianmoConfigDir(), ...segments)
}

/** Root of the omp agent's own state, nested inside the Qianmo root. */
export function ompConfigRoot(): string {
  return qianmoConfigPath('omp')
}

/** The omp agent directory (sessions, config.yml, models.yml, agent.db). */
export function ompAgentDir(): string {
  return join(ompConfigRoot(), 'agent')
}

/**
 * Variables that would move omp's state out of the Qianmo root: a named
 * profile overrides the agent dir, the XDG variables redirect it on darwin and
 * linux, `PI_CODING_AGENT_DIR` splits it from user-config discovery, and omp
 * reads `CLAUDE_CONFIG_DIR` as the Claude config directory.
 */
export const OMP_ENV_SCRUB: Readonly<Record<string, true>> = {
  PI_CONFIG_DIR: true,
  PI_NATIVES_DIR: true,
  OMP_PROFILE: true,
  PI_PROFILE: true,
  PI_CODING_AGENT_DIR: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  CLAUDE_CONFIG_DIR: true,
}

/**
 * Environment for an omp child process. omp only accepts `PI_CONFIG_DIR` as a
 * path relative to the home directory and joins it back onto `homedir()`, so a
 * relative path (possibly with `..` segments) lands every omp state file under
 * {@link ompConfigRoot}.
 */
export function ompChildEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !OMP_ENV_SCRUB[key.toUpperCase()])
      env[key] = value
  }
  // Derive from the child environment, not the caller's process-global roots.
  // Tests and hosts may give a child both a different HOME and config directory.
  const childHome = resolve(base.HOME || base.USERPROFILE || homedir())
  const configRoot = (
    base[CONFIG_DIR_ENV]
      ? resolve(base[CONFIG_DIR_ENV])
      : join(childHome, CONFIG_DIR_BASENAME)
  ).normalize('NFC')
  const ompRoot = join(configRoot, 'omp')
  env.PI_CONFIG_DIR = relative(childHome, ompRoot)
  env.PI_NATIVES_DIR = join(ompRoot, 'natives')
  return env
}

/** Base directory of the Qianmo project memory: `QIANMO_MEMORY_DIR`, else the config root. */
export function memoryBaseDir(): string {
  return fromEnv('QIANMO_MEMORY_DIR', qianmoConfigDir())
}

/** CA directory: `QIANMO_CA_DIR`, else `~/.qianmo-ca`. Must stay outside every config root. */
export function caDir(): string {
  return fromEnv('QIANMO_CA_DIR', join(homedir(), `${CONFIG_DIR_BASENAME}-ca`))
}

/** State root of the Qianmo Codex fork (`qmcode`); read-only from here. */
export function qmcodeHome(): string {
  return fromEnv('QMCODE_HOME', join(homedir(), '.qmcode'))
}

/** User-level config roots that agents and sandboxed commands must never modify. */
export function protectedConfigRoots(): string[] {
  const home = nodeHomeDir()
  return [
    ...new Set(
      [
        qianmoConfigDir(),
        join(home, CONFIG_DIR_BASENAME),
        join(home, '.omp'),
        join(home, '.claude'),
        join(home, '.codex'),
        qmcodeHome(),
      ].map(p => p.normalize('NFC')),
    ),
  ]
}
