// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import {
  FileUsageStore,
  type ConsoleAuditSource,
  type UsagePolicy,
  type UsagePort,
} from '@qianmo/console'
import { qianmoConfigPath } from '@qianmo/paths'

export function loadUsagePolicy(policyPath?: string): UsagePolicy {
  const policy: UsagePolicy =
    policyPath === undefined
      ? { mode: 'shadow', person: {}, job: {}, global: {} }
      : JSON.parse(readFileSync(policyPath, 'utf8'))
  if (
    !policy ||
    typeof policy !== 'object' ||
    !policy.person ||
    !policy.job ||
    !policy.global ||
    Object.keys(policy).some(
      key => !['mode', 'person', 'job', 'global', 'tenants'].includes(key),
    )
  )
    throw new Error('invalid usage policy')
  return policy
}

export function openConsoleUsage(policyPath?: string): FileUsageStore {
  return new FileUsageStore({
    path: qianmoConfigPath('console', 'usage.ndjson'),
    policy: loadUsagePolicy(policyPath),
  })
}

/** Only verified audit rows are observations. Restart replays are idempotent. */
export function startUsageCollection(
  usage: UsagePort,
  audits: readonly ConsoleAuditSource[],
  onError: (error: unknown) => void,
): { tick(): Promise<void>; stop(): void } {
  const cursors = new Map<string, number>()
  let running: Promise<void> | null = null
  const collect = async () => {
    try {
      for (const source of audits) {
        const result = await source.audit.read({
          since: cursors.get(source.node) ?? 0,
          limit: 1000,
        })
        if (
          !result.ok ||
          !result.value.intact ||
          result.value.witness?.tampered === true
        )
          continue
        // The port's paging is newest-first. Never advance beyond an omitted page.
        const page = result.value
        const records = [...page.records]
        let before = page.earlier
        while (before !== undefined && before !== null) {
          const older = await source.audit.read({
            since: cursors.get(source.node) ?? 0,
            before,
            limit: 1000,
          })
          if (
            !older.ok ||
            !older.value.intact ||
            older.value.witness?.tampered === true
          )
            throw new Error(`usage audit unavailable: ${source.node}`)
          records.push(...older.value.records)
          before = older.value.earlier
        }
        for (const row of records.sort((a, b) => a.seq - b.seq)) {
          if (
            row.kind === 'usage.turn_end' &&
            row.taskId !== undefined &&
            row.node === source.node
          ) {
            usage.finishTask(row.taskId, source.node)
            continue
          }
          if (
            row.kind !== 'usage.tokens' ||
            row.taskId === undefined ||
            row.node !== source.node
          )
            continue
          const detail = row.detail ?? {}
          const values = ['input', 'output', 'cacheWrite', 'cacheRead'].map(
            key => detail[key],
          )
          if (
            values.some(
              value =>
                typeof value !== 'number' ||
                !Number.isSafeInteger(value) ||
                value < 0,
            )
          )
            continue
          usage.recordTask(
            `${source.node}/${row.seq}/${row.prev}`,
            row.taskId,
            {
              input: values[0] as number,
              output: values[1] as number,
              cacheWrite: values[2] as number,
              cacheRead: values[3] as number,
            },
            row.at,
            source.node,
          )
        }
        cursors.set(source.node, page.head ?? cursors.get(source.node) ?? 0)
      }
    } catch (error) {
      onError(error)
    }
  }
  const tick = (): Promise<void> => {
    if (running) return running
    running = collect().finally(() => {
      running = null
    })
    return running
  }
  const timer = setInterval(() => {
    void tick()
  }, 30_000)
  timer.unref()
  void tick()
  return { tick, stop: () => clearInterval(timer) }
}
