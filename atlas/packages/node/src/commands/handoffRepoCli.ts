// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isAbsolute } from 'node:path'
import { isHandoffRepo } from '@qianmo/handoff'
import type { HandoffRepoCredentials } from './handoffRepoCredentials.js'
import { readTokenFile } from './handoffStore.js'

export function parseHandoffRepo(value: string): readonly [string, string] {
  const eq = value.indexOf('=')
  const repo = value.slice(0, eq)
  const file = value.slice(eq + 1)
  if (eq < 1 || !isHandoffRepo(repo) || !isAbsolute(file))
    throw new Error('--handoff-repo 要 owner/name=<令牌文件绝对路径>')
  return [repo, file]
}

export function cliHandoffRepoCredentials(
  entries: readonly (readonly [string, string])[],
): HandoffRepoCredentials {
  const files = new Map(entries)
  // Validate before opening the console, and re-read on every dispatch so rotation
  // and revocation never depend on a token retained by the dispatcher.
  for (const [repo, file] of files) {
    if (!isHandoffRepo(repo)) throw new Error('仓库名不合法')
    readTokenFile(file)
  }
  return {
    async resolve(repo) {
      if (!isHandoffRepo(repo)) return null
      const file = files.get(repo)
      if (file === undefined) return null
      try {
        return {
          remoteUrl: `https://github.com/${repo}.git`,
          token: readTokenFile(file),
        }
      } catch {
        return null
      }
    },
  }
}
