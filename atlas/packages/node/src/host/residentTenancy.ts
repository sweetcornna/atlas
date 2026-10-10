// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TenantPort } from '@qianmo/console'
import { canonicalTenantRoot } from '../commands/consoleTenancy.js'

/** Identity comes solely from the verified connection, never envelope.from. */
export function residentTenantGate(
  tenancy: TenantPort,
  node: string,
  hubPeers: ReadonlySet<string>,
  memoryRoot?: string,
): (authenticatedPeer: string | null) => boolean {
  const initial = tenancy.read().config
  if (!initial.nodes.some(entry => entry.nodeId === node))
    throw new Error('resident node is absent from tenancy policy')
  if (
    memoryRoot !== undefined &&
    initial.nodes.find(entry => entry.nodeId === node)?.memoryRoot !==
      canonicalTenantRoot(memoryRoot)
  )
    throw new Error('resident memory root differs from tenant policy')
  if (hubPeers.size === 0)
    throw new Error('tenancy requires an explicitly trusted signed hub')
  return authenticatedPeer => {
    if (authenticatedPeer === null) return false
    try {
      const config = tenancy.read().config
      const own = config.nodes.find(entry => entry.nodeId === node)
      if (own === undefined) return false
      if (
        memoryRoot !== undefined &&
        own.memoryRoot !== canonicalTenantRoot(memoryRoot)
      )
        return false
      if (hubPeers.has(authenticatedPeer)) return true
      return (
        config.nodes.find(entry => entry.nodeId === authenticatedPeer)
          ?.tenant === own.tenant
      )
    } catch {
      return false
    }
  }
}
