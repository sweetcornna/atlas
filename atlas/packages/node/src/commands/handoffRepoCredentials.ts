// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The task owner's scope, re-evaluated on every credential read. */
export interface HandoffRepoScope {
  readonly tenant?: string | null
  readonly ownerSubject?: string | null
}

/** Repo-kind app connection (P26c), with CLI credentials as a legacy fallback. */
export interface HandoffRepoCredentials {
  resolve(
    repo: string,
    scope?: HandoffRepoScope,
  ): Promise<{ remoteUrl: string; token: string } | null>
}

/** Connection adapters may report secret-bearing errors; never propagate them. */
export async function resolveHandoffRepo(
  credentials: HandoffRepoCredentials | undefined,
  repo: string,
  scope?: HandoffRepoScope,
): Promise<{ remoteUrl: string; token: string } | null> {
  try {
    return (await credentials?.resolve(repo, scope)) ?? null
  } catch {
    throw new Error('读取仓库连接失败')
  }
}
