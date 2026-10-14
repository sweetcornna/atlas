// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsoleResult } from './contracts.js'
import type { SchedulesPort } from './directionPorts.js'

const hidden = <T>(): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'not_found', message: '资源不存在' },
})

interface ScheduleScopeRule {
  /** The tenant policy revision that granted this scope is still current. */
  readonly current: () => boolean
  readonly address: (address: string) => boolean
  /** Platform scope sees every channel; it never stamps a tenant itself. */
  readonly platform: boolean
  readonly tenant: string | null
}

/**
 * A schedule is in scope by its target agent, a run by the agent it went to
 * and a channel by its owner tenant. Account ownership stays with the port.
 */
export function scopedSchedules(
  port: SchedulesPort,
  rule: ScheduleScopeRule,
): SchedulesPort {
  const target = (address: string | undefined) =>
    rule.current() &&
    (rule.platform || (address !== undefined && rule.address(address)))
  const channel = (id: string) => {
    if (!rule.current()) return false
    const owner = port.channelTenant(id)
    return (
      owner !== undefined &&
      (rule.platform || (rule.tenant !== null && owner === rule.tenant))
    )
  }
  const visible: SchedulesPort['visible'] = (id, actor) =>
    port.visible(id, actor) && target(port.targetOf(id))
  const after = async <T>(
    effect: Promise<ConsoleResult<T>>,
  ): Promise<ConsoleResult<T>> => {
    const result = await effect
    return rule.current() ? result : hidden()
  }
  return {
    visible,
    targetOf(id) {
      const address = port.targetOf(id)
      return target(address) ? address : undefined
    },
    channelTenant(id) {
      return channel(id) ? port.channelTenant(id) : undefined
    },
    async snapshot(actor) {
      if (!rule.current()) return hidden()
      const result = await port.snapshot(actor)
      if (!result.ok) return result
      if (!rule.current()) return hidden()
      const targets = new Map(
        result.value.schedules.map(row => [row.id, row.target] as const),
      )
      return {
        ok: true,
        value: {
          ...result.value,
          schedules: result.value.schedules
            .filter(row => target(row.target))
            .map(row =>
              row.lastRun === null || target(row.lastRun.target ?? row.target)
                ? row
                : { ...row, lastRun: null },
            ),
          runs: result.value.runs.filter(run =>
            target(run.target ?? targets.get(run.scheduleId)),
          ),
          channels: result.value.channels.filter(row => channel(row.id)),
          targets: result.value.targets.filter(target),
        },
      }
    },
    async save(draft, actor) {
      if (!rule.current()) return hidden()
      // Platform scope keeps the port's own answers for malformed drafts.
      if (
        !rule.platform &&
        (typeof draft?.target !== 'string' ||
          !target(draft.target) ||
          (draft.id !== undefined && !visible(draft.id, actor)) ||
          (Array.isArray(draft.channels) &&
            draft.channels.some(id => typeof id !== 'string' || !channel(id))))
      )
        return hidden()
      return after(port.save(draft, actor))
    },
    async setEnabled(id, enabled, actor) {
      return visible(id, actor)
        ? after(port.setEnabled(id, enabled, actor))
        : hidden()
    },
    async remove(id, actor) {
      return visible(id, actor) ? after(port.remove(id, actor)) : hidden()
    },
    async runNow(id, actor) {
      return visible(id, actor) ? after(port.runNow(id, actor)) : hidden()
    },
    async resolve(id, runId, outcome, actor) {
      return visible(id, actor)
        ? after(port.resolve(id, runId, outcome, actor))
        : hidden()
    },
    async saveChannel(draft, actor) {
      if (!rule.current()) return hidden()
      if (rule.platform) return after(port.saveChannel(draft, actor))
      if (
        rule.tenant === null ||
        (draft?.tenant !== undefined && draft.tenant !== rule.tenant) ||
        (draft?.id !== undefined && !channel(draft.id))
      )
        return hidden()
      return after(port.saveChannel({ ...draft, tenant: rule.tenant }, actor))
    },
    async removeChannel(id, actor) {
      return channel(id) ? after(port.removeChannel(id, actor)) : hidden()
    },
    async testChannel(id, actor) {
      return channel(id) ? after(port.testChannel(id, actor)) : hidden()
    },
  }
}
