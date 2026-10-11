// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HandoffRepoCredentials } from './handoffRepoCredentials.js'
import {
  cliHandoffRepoCredentials,
  parseHandoffRepo,
} from './handoffRepoCli.js'

/** Shared resolve(repo) seam; P26c can replace the CLI adapter without changing transfers. */
export type FilesExchangeCredentials = HandoffRepoCredentials
export type FilesRepoProbe = (
  repo: string,
  credential: { remoteUrl: string; token: string },
) => Promise<boolean | null>
export function parseFilesExchangeRepo(
  value: string,
): readonly [string, string] {
  try {
    return parseHandoffRepo(value)
  } catch {
    throw new Error('--files-exchange-repo 要 owner/name=<令牌文件绝对路径>')
  }
}
export const cliFilesExchangeCredentials = cliHandoffRepoCredentials

/** Unknown visibility, errors and rate limits fail closed; never propagate response bodies. */
export const probePrivateFilesRepo: FilesRepoProbe = async (
  repo,
  credential,
) => {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || !('private' in value))
      return null
    return typeof value.private === 'boolean' ? value.private : null
  } catch {
    return null
  }
}

export function filesRetention(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value)
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  const milliseconds = match ? Number(match[1]) * units[match[2] ?? 'ms']! : NaN
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new Error('--files-exchange-retain 要非负时长，例如 0、30m、1h')
  return milliseconds
}
