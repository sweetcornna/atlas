// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsoleResult } from './contracts.js'
import type { AgentRef, FilesPort, FilesSnapshot } from './directionPorts.js'

const hidden = <T>(): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'not_found', message: '资源不存在' },
})
/** Both endpoints must remain visible, including after async snapshot reads. */
export function scopedFiles(
  port: FilesPort,
  allowed: (ref: AgentRef) => boolean,
): FilesPort {
  const pair = (row: { source: AgentRef; target: AgentRef }) =>
    allowed(row.source) && allowed(row.target)
  const snapshot = async (): Promise<ConsoleResult<FilesSnapshot>> => {
    const result = await port.snapshot()
    if (!result.ok) return result
    const transfers = result.value.transfers.filter(pair),
      ids = new Set(transfers.map(one => one.transferId))
    return {
      ok: true,
      value: {
        ...result.value,
        requests: result.value.requests.filter(pair),
        grants: result.value.grants.filter(pair),
        transfers,
        groups: result.value.groups.filter(
          one => allowed(one.target) && one.transfers.every(id => ids.has(id)),
        ),
        agents: result.value.agents.filter(allowed),
      },
    }
  }
  return {
    snapshot,
    async browse(ref, path) {
      if (!allowed(ref)) return hidden()
      const result = await port.browse(ref, path)
      return allowed(ref) ? result : hidden()
    },
    async transfer(input, actor) {
      return allowed(input.target) && input.sources.every(allowed)
        ? port.transfer(input, actor)
        : hidden()
    },
    async decide(id, decision, actor) {
      const rows = await snapshot()
      return rows.ok &&
        rows.value.requests.some(one => one.requestId === id && pair(one))
        ? port.decide(id, decision, actor)
        : hidden()
    },
    async revokeGrant(id, actor) {
      const rows = await snapshot()
      return rows.ok &&
        rows.value.grants.some(one => one.grantId === id && pair(one))
        ? port.revokeGrant(id, actor)
        : hidden()
    },
    async retry(id, actor) {
      const rows = await snapshot()
      return rows.ok &&
        rows.value.transfers.some(one => one.transferId === id && pair(one))
        ? port.retry(id, actor)
        : hidden()
    },
  }
}
