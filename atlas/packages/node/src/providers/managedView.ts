// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Stable hashes of the owned YAML fields, with credentials fingerprinted. */
import { createHash } from 'node:crypto'
import { secretFingerprint } from '@qianmo/providers'
export type ManagedView = Record<string, unknown>
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function canonical(value: unknown, key = ''): unknown {
  if (
    typeof value === 'string' &&
    (key === 'apiKey' ||
      ['authorization', 'x-api-key'].includes(key.toLowerCase()))
  )
    return secretFingerprint(value)
  if (Array.isArray(value)) return value.map(v => canonical(v))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(k => [k, canonical(value[k], k)]),
  )
}
export function hashManagedView(view: ManagedView): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(view)))
    .digest('hex')}`
}
export function keyHashesOf(view: ManagedView): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (v: unknown, path: string) => {
    if (isRecord(v) && Object.keys(v).length)
      for (const [k, child] of Object.entries(v))
        visit(child, path ? `${path}.${k}` : k)
    else
      out[path] = hashManagedView({
        value: canonical(v, path.split('.').at(-1)),
      })
  }
  visit(view, '')
  return out
}
export function diffKeyHashes(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(k => before[k] !== after[k])
    .sort()
}
