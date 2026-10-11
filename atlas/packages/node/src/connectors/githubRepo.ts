// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from 'zod'
import { isHandoffRepo } from '@qianmo/handoff'
import { OutboundPolicy, boundedText } from '../commands/outboundPolicy.js'

const factsSchema = z.object({
  private: z.boolean(),
  permissions: z.object({ push: z.boolean() }).optional(),
})

export interface RepoProbe {
  readonly ok: boolean
  readonly detail: string
  readonly private: boolean | null
  readonly push: boolean | null
}

/** Fixed GitHub origin, no redirects, bounded response; never expose remote text. */
export async function probeGithubRepo(
  policy: OutboundPolicy,
  repo: string,
  exchange: boolean,
  token: string,
  beforeDispatch?: () => void,
): Promise<RepoProbe> {
  const failed = (detail: string): RepoProbe => ({
    ok: false,
    detail,
    private: null,
    push: null,
  })
  try {
    if (!isHandoffRepo(repo)) return failed('仓库名不合法')
    const response = await policy.request(
      `https://api.github.com/repos/${repo}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'qianmo-agentnest',
        },
      },
      false,
      beforeDispatch,
    )
    if (!response.ok) {
      await response.body?.cancel()
      return failed(
        [401, 403].includes(response.status)
          ? '令牌无效或没有权限'
          : response.status === 404
            ? '仓库不存在或令牌看不到它'
            : '仓库探测失败；请核对出站策略与网络',
      )
    }
    const facts = factsSchema.parse(JSON.parse(await boundedText(response)))
    const push = facts.permissions?.push ?? false
    const detail = !push
      ? '令牌没有写权限'
      : exchange && !facts.private
        ? '文件交换仓库必须私有'
        : '仓库可读写（未评估）'
    return {
      ok: push && (!exchange || facts.private),
      detail,
      private: facts.private,
      push,
    }
  } catch {
    return failed('仓库探测失败；请核对出站策略与网络')
  }
}
