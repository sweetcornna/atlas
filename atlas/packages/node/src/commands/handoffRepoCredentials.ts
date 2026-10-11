// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Replaceable by the repo-kind app connection (P26b). Never returns objects. */
export interface HandoffRepoCredentials {
  resolve(repo: string): Promise<{ remoteUrl: string; token: string } | null>
}

/** Connection adapters may report secret-bearing errors; never propagate them. */
export async function resolveHandoffRepo(
  credentials: HandoffRepoCredentials | undefined,
  repo: string,
): Promise<{ remoteUrl: string; token: string } | null> {
  try {
    return (await credentials?.resolve(repo)) ?? null
  } catch {
    throw new Error('读取仓库连接失败')
  }
}
