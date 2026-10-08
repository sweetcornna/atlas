// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The developer's credentials and subscription login, kept out of every test
 * (P18.12, hermes #33; design `providers-console-m1.md` §5.9 item 1).
 *
 * `tests/preload.ts` used to delete two variables. Everything else the dev
 * shell carries reached the suite: an exported `OPENAI_API_KEY`, an
 * `OPENAI_AUTH_MODE=chatgpt`, and — read from disk rather than the env — the
 * Codex CLI's ChatGPT login at `~/.codex/auth.json`, which the ChatGPT chain
 * (`chatgptAuth.ts` `codexAuthFilePath`) falls back to. That is how
 * `codexPinnedSearch.test.ts` went red on a machine with a subscription login
 * and green in CI (2026-08-18; memory note "verify 的 codex 存量红点").
 *
 * Applied once per test process, before any test file loads. A test that
 * needs one of these sets it itself, as the existing ones already do.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `tests/conftest.py:132-248` — every variable whose name ends in one of the
 * credential suffixes, or is on an explicit list, is unset for every test.
 * The suffix list is hermes's; the explicit list is this repository's own
 * (provider selection, subscription mode, base URLs, AWS key id). Only the
 * rule is taken; the code is ours.
 *
 * Qianmo addition: `CODEX_HOME` is pointed at a directory that does not
 * exist instead of being deleted — deleting it makes the chain read
 * `~/.codex/auth.json`, the very login this exists to keep out.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** hermes `tests/conftest.py:139-155`. */
const CREDENTIAL_ENV_SUFFIXES = [
  '_API_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
  '_ACCESS_KEY',
  '_SECRET_ACCESS_KEY',
  '_PRIVATE_KEY',
  '_OAUTH_TOKEN',
  '_WEBHOOK_SECRET',
  '_ENCRYPT_KEY',
  '_APP_SECRET',
  '_CLIENT_SECRET',
  '_CORP_SECRET',
  '_AES_KEY',
] as const

/**
 * Names the suffixes miss: a key id, file-descriptor handles, and the switches
 * that turn a login on disk or a provider endpoint into the session's route.
 */
const CREDENTIAL_ENV_NAMES = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'OPENAI_AUTH_MODE',
  'OPENCODE_AUTH_MODE',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'GEMINI_BASE_URL',
  'GROK_BASE_URL',
  'OPENCODE_BASE_URL',
])

/** Whether `name` is a credential, or turns one on (hermes `:242-246`). */
export function isCredentialEnvName(name: string): boolean {
  return (
    CREDENTIAL_ENV_NAMES.has(name) ||
    CREDENTIAL_ENV_SUFFIXES.some(suffix => name.endsWith(suffix))
  )
}

/**
 * Delete every credential-shaped variable from `env` and point `CODEX_HOME`
 * at a path with nothing in it. Returns the names it deleted.
 */
export function isolateCredentialEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const cleared = Object.keys(env).filter(isCredentialEnvName)
  for (const name of cleared) delete env[name]
  env.CODEX_HOME = join(tmpdir(), `occ-test-no-codex-home-${process.pid}`)
  return cleared
}
