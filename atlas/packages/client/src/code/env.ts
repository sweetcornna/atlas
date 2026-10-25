// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The environment a local agent starts with (qmo-local.md §4.3.4): the
 * runner's own, plus what the login shell exports, as a terminal would give
 * it, without 阡陌's and the shell app's own variables. The login shell's
 * answer is kept in memory for ten minutes and nowhere else: not in
 * `agents.json`, not in a log, not on disk.
 */

import {
  type AskLoginEnv,
  type LoginEnv,
  loginEnvAsker,
  stringEnv,
} from '../computer.js'

/** The login shell is asked again after this long (as `qmo agents` does). */
export const LOGIN_ENV_KEEP_MS = 10 * 60 * 1000
/** How long the login shell may take to answer (as `qmo agents`). */
const LOGIN_ENV_WAIT_MS = 2_000

/** Prefixes of variables that are 阡陌's or the shell app's. */
const DROPPED_PREFIXES = ['QMO_', 'QIANMO_', 'TAURI_']
/**
 * Variables an agent must not inherit: the macOS app's own, the two that make
 * Claude Code think it runs inside another Claude Code, and the login
 * shell's own session state (its working folder is the probe's, not the
 * session's).
 */
const DROPPED = new Set([
  '__CFBundleIdentifier',
  'XPC_SERVICE_NAME',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
])

function dropped(name: string): boolean {
  return (
    DROPPED.has(name) ||
    DROPPED_PREFIXES.some(prefix => name.toUpperCase().startsWith(prefix))
  )
}

/** The runner's environment with the login shell's over it, without the dropped ones. */
export function agentEnv(
  own: NodeJS.ProcessEnv,
  login: Readonly<Record<string, string>> | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries({
    ...stringEnv(own),
    ...(login ?? {}),
  }))
    if (!dropped(name)) out[name] = value
  return out
}

/** The login shell's PATH and `names`, from its whole environment (for `scanAgents`). */
export function loginEnvFor(
  login: Readonly<Record<string, string>> | null,
  names: readonly string[],
): LoginEnv | null {
  if (login === null) return null
  const vars: Record<string, string> = {}
  for (const name of names) {
    const value = login[name]
    if (value !== undefined && value !== '') vars[name] = value
  }
  return {
    path: [
      ...new Set(
        (login.PATH ?? '').split(':').filter(dir => dir.startsWith('/')),
      ),
    ],
    vars,
  }
}

export interface LoginEnvironmentOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** `null`: never asked (Windows). */
  readonly ask?: AskLoginEnv | null
  readonly now?: () => number
}

/** The login shell's environment, asked at most once per ten minutes and kept in memory. */
export class LoginEnvironment {
  readonly #ask: AskLoginEnv | null
  readonly #shell: string
  readonly #now: () => number
  #kept:
    | {
        readonly at: number
        readonly shell: string
        readonly vars: Record<string, string> | null
      }
    | undefined
  #asking: Promise<Record<string, string> | null> | undefined

  constructor(options: LoginEnvironmentOptions = {}) {
    const env = options.env ?? process.env
    const platform = options.platform ?? process.platform
    this.#ask =
      options.ask !== undefined
        ? options.ask
        : platform === 'win32'
          ? null
          : loginEnvAsker(env)
    this.#shell = env.SHELL ?? ''
    this.#now = options.now ?? Date.now
  }

  /** What the login shell exports; `null` when it is not asked or did not say in time. */
  async get(): Promise<Record<string, string> | null> {
    if (this.#ask === null) return null
    const kept = this.#kept
    if (kept !== undefined && kept.shell === this.#shell) {
      const age = this.#now() - kept.at
      if (age >= 0 && age < LOGIN_ENV_KEEP_MS) return kept.vars
    }
    this.#asking ??= this.#ask(LOGIN_ENV_WAIT_MS)
      .catch(() => null)
      .then(vars => {
        this.#kept = { at: this.#now(), shell: this.#shell, vars }
        this.#asking = undefined
        return vars
      })
    return this.#asking
  }
}
