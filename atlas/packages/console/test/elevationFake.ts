// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A working fake of the 权限模式 port (P39), for the page tests and
 * `test/preview.ts`: tokyo-1/planner is on 自动审批 with a sandbox,
 * osaka-1/writer is off on a macOS node, berlin-1/helper runs on an external
 * runtime the mode cannot reach.
 */

import type { ConsoleResult } from '../src/contracts.js'
import type {
  AgentRef,
  ElevationActionView,
  ElevationActor,
  ElevationNodeView,
  ElevationPort,
  ElevationTierName,
} from '../src/directionPorts.js'

export class FakeElevation implements ElevationPort {
  readonly calls: string[] = []
  agents: ElevationNodeView[]
  readonly log: ElevationActionView[]

  constructor(private readonly now: () => number) {
    const at = now()
    this.agents = [
      {
        node: 'tokyo-1',
        agent: 'planner',
        reachable: true,
        tier: 'auto',
        epoch: 4,
        expiresAt: at + 90 * 60_000,
        maxCalls: 200,
        usedCalls: 12,
        sandbox: true,
        sandboxReason: null,
        unsupportedReason: null,
        enabledAt: at - 30 * 60_000,
        enabledBy: 'u:ops-1',
        actions24h: 12,
      },
      {
        node: 'osaka-1',
        agent: 'writer',
        reachable: true,
        tier: 'off',
        epoch: 1,
        expiresAt: null,
        maxCalls: 200,
        usedCalls: 0,
        sandbox: false,
        sandboxReason: '这台节点没有可用的命令沙箱',
        unsupportedReason: null,
        enabledAt: null,
        enabledBy: null,
        actions24h: 0,
      },
      {
        node: 'berlin-1',
        agent: 'helper',
        reachable: true,
        tier: 'off',
        epoch: 1,
        expiresAt: null,
        maxCalls: 200,
        usedCalls: 0,
        sandbox: true,
        sandboxReason: null,
        unsupportedReason:
          '该智能体运行在外部底层 dsh 上：高权限模式只对 qianmopi 底层生效',
        enabledAt: null,
        enabledBy: null,
        actions24h: 0,
      },
    ]
    this.log = [
      {
        at: at - 60_000,
        node: 'tokyo-1',
        agent: 'planner',
        tool: 'github',
        cls: 'act-out',
        op: 'pr_create',
        host: null,
        approved: true,
        outcome: 'allowed',
        epoch: 4,
      },
      {
        at: at - 120_000,
        node: 'tokyo-1',
        agent: 'planner',
        tool: 'bash',
        cls: 'local',
        op: null,
        host: null,
        approved: false,
        outcome: 'completed',
        epoch: 4,
      },
    ]
  }

  #find(ref: AgentRef): ElevationNodeView | undefined {
    return this.agents.find(a => a.node === ref.node && a.agent === ref.agent)
  }

  async list(): Promise<ConsoleResult<readonly ElevationNodeView[]>> {
    return { ok: true, value: this.agents }
  }

  async set(
    ref: AgentRef,
    change: {
      readonly tier: ElevationTierName
      readonly ttlMs?: number
      readonly maxCalls?: number
    },
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    actor.beforeDispatch?.()
    this.calls.push(`set ${ref.node}/${ref.agent} ${change.tier}`)
    const one = this.#find(ref)
    if (!one)
      return {
        ok: false,
        failure: { code: 'not_found', message: '资源不存在' },
      }
    if (change.tier !== 'off' && one.unsupportedReason)
      return {
        ok: false,
        failure: { code: 'refused', message: one.unsupportedReason },
      }
    const next: ElevationNodeView = {
      ...one,
      tier: change.tier,
      epoch: one.epoch + 1,
      expiresAt:
        change.tier === 'off'
          ? null
          : this.now() + (change.ttlMs ?? 2 * 60 * 60_000),
      maxCalls: change.maxCalls ?? 200,
      usedCalls: 0,
      enabledAt: change.tier === 'off' ? null : this.now(),
      enabledBy: change.tier === 'off' ? null : actor.subject,
    }
    this.agents = this.agents.map(a => (a === one ? next : a))
    return { ok: true, value: next }
  }

  revoke(
    ref: AgentRef,
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    this.calls.push(`revoke ${ref.node}/${ref.agent}`)
    return this.set(ref, { tier: 'off' }, actor)
  }

  async actions(
    ref: AgentRef | null,
    limit: number,
  ): Promise<ConsoleResult<readonly ElevationActionView[]>> {
    return {
      ok: true,
      value: this.log
        .filter(a => !ref || (a.node === ref.node && a.agent === ref.agent))
        .slice(0, limit),
    }
  }
}
