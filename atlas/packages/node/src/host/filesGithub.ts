// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import { z } from 'zod'
import { githubGit } from '../commands/githubRepoGit.js'
import { FileDirectory, FileFault, relativeFilePath } from './filesSafeFs.js'
import {
  FILE_LIMITS,
  manifestEntrySchema,
  manifestSha256,
  sha256,
  validateManifest,
} from './filesPolicy.js'

const oid = z.string().regex(/^[a-f0-9]{40}$/)
export const publishedSchema = z.object({
  commit: oid,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.number().int().min(1).max(FILE_LIMITS.maxFiles),
  bytes: z.number().int().min(0).max(FILE_LIMITS.maxTransferBytes),
})
const manifestSchema = z
  .object({
    path: z.string(),
    kind: z.enum(['file', 'dir']),
    entries: z.array(manifestEntrySchema).max(FILE_LIMITS.maxFiles),
    manifestSha256: publishedSchema.shape.manifestSha256,
  })
  .strict()
export type ExchangeManifest = z.infer<typeof manifestSchema>
export function exchangeArgs(args: Record<string, unknown>) {
  const exchange = z
    .object({ remoteUrl: z.string(), ref: z.string() })
    .strict()
    .parse(args.exchange)
  const credential = z
    .object({ kind: z.literal('github-token'), token: z.string().min(1) })
    .strict()
    .parse(args.credential)
  const url = new URL(exchange.remoteUrl)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'file:' ||
      (url.protocol === 'https:' &&
        url.hostname === 'github.com' &&
        url.port === '' &&
        /^\/[\w.-]+\/[\w.-]+\.git$/.test(url.pathname))
    ) ||
    exchange.ref !==
      `refs/heads/qianmo/files/${z.string().uuid().parse(args.transferId)}`
  )
    throw new FileFault('exchange-invalid')
  return {
    exchange,
    credential: { remoteUrl: exchange.remoteUrl, token: credential.token },
  }
}

/** Plumbing commits only the immutable host snapshot, never the workspace or its git config. */
export async function publishSnapshot(
  repo: string,
  snapshot: string,
  manifest: ExchangeManifest,
  args: Record<string, unknown>,
  beforePush: () => Promise<unknown>,
): Promise<z.infer<typeof publishedSchema>> {
  const { exchange, credential } = exchangeArgs(args)
  await githubGit(['init', '--quiet', '--template=', repo], snapshot)
  const stage = FileDirectory.root(snapshot)
  try {
    for (const [index, entry] of manifest.entries.entries()) {
      const fd = stage.open(String(index))
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
        throw new FileFault('snapshot-changed')
      const hash = oid.parse(
        (
          await githubGit(['hash-object', '-w', '--stdin'], repo, undefined, {
            input: bytes,
          })
        ).stdout
          .toString()
          .trim(),
      )
      await githubGit(
        [
          'update-index',
          '--add',
          '--cacheinfo',
          '100644',
          hash,
          `files/${entry.path}`,
        ],
        repo,
      )
    }
  } finally {
    stage.close()
  }
  const hash = oid.parse(
    (
      await githubGit(['hash-object', '-w', '--stdin'], repo, undefined, {
        input: JSON.stringify(manifest),
      })
    ).stdout
      .toString()
      .trim(),
  )
  await githubGit(
    ['update-index', '--add', '--cacheinfo', '100644', hash, 'MANIFEST.json'],
    repo,
  )
  const tree = oid.parse(
    (await githubGit(['write-tree'], repo)).stdout.toString().trim(),
  )
  const commit = oid.parse(
    (
      await githubGit(
        ['commit-tree', tree, '-m', 'Qianmo file exchange'],
        repo,
        undefined,
        {
          env: {
            GIT_AUTHOR_NAME: 'Qianmo',
            GIT_AUTHOR_EMAIL: 'files@qianmo.local',
            GIT_COMMITTER_NAME: 'Qianmo',
            GIT_COMMITTER_EMAIL: 'files@qianmo.local',
          },
        },
      )
    ).stdout
      .toString()
      .trim(),
  )
  await beforePush()
  await githubGit(
    ['push', exchange.remoteUrl, `${commit}:${exchange.ref}`],
    repo,
    credential,
  )
  return {
    commit,
    manifestSha256: manifest.manifestSha256,
    files: manifest.entries.length,
    bytes: manifest.entries.reduce((n, e) => n + e.size, 0),
  }
}

/** Never checkout: inspect every tree entry before reading any payload blob. */
export async function fetchSnapshot(
  repo: string,
  snapshot: string,
  args: Record<string, unknown>,
): Promise<ExchangeManifest> {
  const { exchange, credential } = exchangeArgs(args)
  const commit = oid.parse(args.commit)
  await githubGit(['init', '--quiet', '--template=', repo], snapshot)
  await githubGit(
    ['fetch', '--depth=1', '--no-tags', exchange.remoteUrl, exchange.ref],
    repo,
    credential,
  )
  if (
    (await githubGit(['rev-parse', 'FETCH_HEAD'], repo)).stdout
      .toString()
      .trim() !== commit
  )
    throw new FileFault('branch-commit')
  const raw = (await githubGit(['ls-tree', '-r', '-z', commit], repo)).stdout
  const rows = new TextDecoder('utf-8', { fatal: true })
    .decode(raw)
    .split('\0')
    .filter(Boolean)
  if (rows.length > FILE_LIMITS.maxFiles + 1)
    throw new FileFault('transfer-too-large')
  const blobs = new Map<string, string>()
  for (const row of rows) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row)
    if (!match) throw new FileFault('unsafe-tree')
    const name = match[3]!
    if (
      name !== 'MANIFEST.json' &&
      (!name.startsWith('files/') ||
        relativeFilePath(name.slice(6)) !== name.slice(6))
    )
      throw new FileFault('unsafe-tree')
    if (blobs.has(name)) throw new FileFault('unsafe-tree')
    blobs.set(name, match[2]!)
  }
  const read = async (
    hash: string,
    limit: number,
    sizeFault: 'file-too-large' | 'content-digest' = 'file-too-large',
  ): Promise<Buffer> => {
    const size = Number(
      (await githubGit(['cat-file', '-s', hash], repo)).stdout
        .toString()
        .trim(),
    )
    if (!Number.isSafeInteger(size) || size < 0 || size > limit)
      throw new FileFault(sizeFault)
    const bytes = (await githubGit(['cat-file', 'blob', hash], repo)).stdout
    if (bytes.length !== size) throw new FileFault('content-digest')
    return bytes
  }
  const manifestBlob = blobs.get('MANIFEST.json')
  if (!manifestBlob) throw new FileFault('unsafe-tree')
  const manifest = manifestSchema.parse(
    JSON.parse(
      (await read(manifestBlob, FILE_LIMITS.maxFileBytes)).toString('utf8'),
    ),
  )
  validateManifest(manifest.entries)
  if (
    relativeFilePath(manifest.path) !== manifest.path ||
    manifest.path !== args.path ||
    manifestSha256(manifest.entries) !== manifest.manifestSha256 ||
    manifest.manifestSha256 !== args.manifestSha256
  )
    throw new FileFault('manifest-digest')
  if (blobs.size !== manifest.entries.length + 1)
    throw new FileFault('unsafe-tree')
  const stage = FileDirectory.root(snapshot)
  try {
    for (const [index, entry] of manifest.entries.entries()) {
      const hash = blobs.get(`files/${entry.path}`)
      if (!hash) throw new FileFault('unsafe-tree')
      const bytes = await read(hash, entry.size, 'content-digest')
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
        throw new FileFault('content-digest')
      const fd = stage.open(String(index), true)
      try {
        fs.writeFileSync(fd, bytes)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
  } finally {
    stage.close()
  }
  return manifest
}
