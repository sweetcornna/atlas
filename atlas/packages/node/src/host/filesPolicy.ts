// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { CONFIG_DIR_BASENAME, protectedConfigRoots } from '@qianmo/paths'
import { z } from 'zod'
import { SECRET_PATH_PATTERNS, scanForSecrets } from '@qianmo/handoff'
import { FileFault, nameKey, relativeFilePath } from './filesSafeFs.js'

export const FILE_LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxTransferBytes: 256 * 1024 * 1024,
  maxFiles: 1000,
  maxTtlMs: 24 * 60 * 60_000,
} as const
export const FILE_CHUNK_BYTES = 128 * 1024
export const FILE_PAGE_SIZE = 32
export const refSchema = z.object({
  node: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  agent: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
})
export const filePathSchema = z.string().transform((value, ctx) => {
  try {
    return relativeFilePath(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid path' })
    return z.NEVER
  }
})
export const scopeSchema = z.object({
  kind: z.enum(['file', 'dir']),
  path: filePathSchema,
})
export const manifestEntrySchema = z.object({
  path: filePathSchema,
  size: z.number().int().min(0).max(FILE_LIMITS.maxFileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type FileManifestEntry = z.infer<typeof manifestEntrySchema>
export const bindingSchema = z.object({
  grantId: z.string().uuid(),
  source: refSchema,
  target: refSchema,
  scope: scopeSchema,
  grantedBy: z.string(),
  grantedAt: z.number(),
  expiresAt: z.number(),
  revokedAt: z.number().nullable(),
  sourceGeneration: z.string(),
  targetGeneration: z.string(),
})
export type FileBinding = z.infer<typeof bindingSchema>
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')
export function manifestSha256(entries: readonly FileManifestEntry[]): string {
  return sha256(
    JSON.stringify(
      [...entries]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(one => [one.path, one.size, one.sha256]),
    ),
  )
}
export function scopeContains(
  scope: FileBinding['scope'],
  file: string,
): boolean {
  const requested = relativeFilePath(file).split('/'),
    allowed = scope.path.split('/')
  return scope.kind === 'file'
    ? file === scope.path
    : allowed.every((part, i) => requested[i] === part)
}
const forbidden = new Set([
  '.git',
  CONFIG_DIR_BASENAME,
  ...protectedConfigRoots().map(root => path.basename(root)),
  '.ssh',
  'inbox',
])
const filenameRules = [
  ...SECRET_PATH_PATTERNS,
  'id_*',
  'credentials*',
  '*.ovpn',
  '.aws',
  '.azure',
  '.gnupg',
]
const patterns = filenameRules.map(
  pattern =>
    new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`,
      'i',
    ),
)
export function exportPathRules(relative: string): string[] {
  const parts = relativeFilePath(relative).split('/').map(nameKey)
  return parts.some(one => forbidden.has(one))
    ? ['file-path-protected']
    : parts.some(one => patterns.some(pattern => pattern.test(one)))
      ? ['file-name-secret']
      : []
}
/** Binary/archives get filename policy only. Never label them content-scanned. */
export function exportContentRules(
  relative: string,
  bytes: Uint8Array,
): { rules: string[]; scan: 'text' | 'filename-only' } {
  const names = exportPathRules(relative)
  const binary =
    /\.(zip|gz|tgz|bz2|xz|7z|rar|tar|pdf|png|jpe?g|gif|webp|docx|xlsx|pptx|wasm)$/i.test(
      relative,
    ) || bytes.includes(0)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { rules: names, scan: 'filename-only' }
  }
  if (binary) return { rules: names, scan: 'filename-only' }
  const rules = scanForSecrets(text).map(one => one.ruleId)
  if (/(?:qmd|qmu|qmi|qms)_[A-Za-z0-9_-]{40,}/.test(text))
    rules.push('qianmo-credential')
  return { rules: [...names, ...rules], scan: 'text' }
}
export function validateManifest(entries: readonly FileManifestEntry[]): void {
  const parsed = z
    .array(manifestEntrySchema)
    .min(1)
    .max(FILE_LIMITS.maxFiles)
    .parse(entries)
  if (
    parsed.reduce((total, one) => total + one.size, 0) >
    FILE_LIMITS.maxTransferBytes
  )
    throw new FileFault('transfer-too-large')
  const keys = new Set<string>()
  for (const one of parsed) {
    const key = nameKey(one.path)
    if (keys.has(key) || exportPathRules(one.path).length)
      throw new FileFault('unsafe-manifest')
    keys.add(key)
  }
}
