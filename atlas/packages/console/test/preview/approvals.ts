// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Approvals for the preview (`./serve.ts`), so the front's cards can be
 * looked at: a settings change in the conversation `/` opens (hub/ops,
 * `s1`), another in the reviewer's (`s2`) and a mail in the planner's
 * (`s3`). Every request waits on whoever is signed in; a decision takes it
 * off the list. Not a test.
 */

import type {
  ApprovalDecisionInput,
  ApprovalItem,
  ApprovalPort,
} from '../../src/governance.js'
import type { ConsoleResult } from '../../src/deps.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

function pending(
  requestId: string,
  contextId: string,
  agent: string,
  toolName: string,
  input: Record<string, unknown>,
  at: number,
): ApprovalItem {
  return {
    requestId,
    node: agent.replace(/^qianmo:\/\//, '').split('/')[0] ?? 'hub',
    agent,
    contextId,
    owner: null,
    toolName,
    input,
    digest: `preview-${requestId}`,
    createdAt: at,
    expiresAt: at + 3_600_000,
    status: 'pending',
  }
}

export class PreviewApprovals implements ApprovalPort {
  readonly #items: ApprovalItem[]

  constructor(now: number) {
    this.#items = [
      pending(
        'preview-settings-1',
        's1',
        'qianmo://hub/ops',
        'qianmo_settings_change',
        {
          id: 'providers.default',
          target: null,
          input: {
            profileId: 'claude-gateway',
            key: { $secret: '…7f3a', sha256: '0'.repeat(64) },
          },
          card: {
            area: '模型',
            label: '默认模型服务',
            title: '把默认模型服务改成 Claude 网关',
            current: 'DeepSeek',
            next: 'Claude 网关',
            role: 'ops',
            page: '/admin/providers#routing',
          },
        },
        now - 40_000,
      ),
      pending(
        'preview-settings-2',
        's2',
        'qianmo://beta-5/reviewer',
        'qianmo_settings_change',
        {
          id: 'im.bot.create',
          target: null,
          input: { platform: 'feishu', name: 'qianmo-dev' },
          card: {
            area: '渠道',
            label: '飞书机器人',
            title: '新建飞书机器人 qianmo-dev',
            current: null,
            next: '启用 · 群 qianmo-dev',
            role: 'member',
            page: '/admin/im',
          },
        },
        now - 30_000,
      ),
      pending(
        'preview-mail-1',
        's3',
        'qianmo://beta-1/planner',
        'qianmo_mail_send',
        {
          connectorId: 'work-mail',
          to: ['release@example.com'],
          subject: '下周发版计划',
          body: '冻结分支 · 跑全量门禁 · 灰度两台节点',
        },
        now - 20_000,
      ),
    ]
  }

  list(principal: {
    readonly subject: string
  }): Promise<ConsoleResult<readonly ApprovalItem[]>> {
    return Promise.resolve(
      ok(this.#items.map(item => ({ ...item, owner: principal.subject }))),
    )
  }

  decide(
    _principal: unknown,
    input: ApprovalDecisionInput,
  ): Promise<ConsoleResult<{ readonly delivered: boolean }>> {
    const at = this.#items.findIndex(item => item.requestId === input.requestId)
    const found = this.#items[at]
    if (found !== undefined)
      this.#items[at] = {
        ...found,
        status: input.decision === 'deny' ? 'denied' : 'allowed',
      }
    return Promise.resolve(ok({ delivered: true }))
  }

  revoke(): Promise<ConsoleResult<{ readonly delivered: boolean }>> {
    return Promise.resolve(ok({ delivered: true }))
  }
}
