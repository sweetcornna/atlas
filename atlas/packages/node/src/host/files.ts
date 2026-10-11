// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlOutcome } from '@qianmo/protocol'
import { parseAddress } from '@qianmo/protocol'
import {
  writePrivateJson,
  readTextIfExists,
  ensurePrivateDir,
} from '../providers/store.js'
import type {
  ControlContext,
  ControlRegistry,
  HubCallClient,
} from './control.js'
import type { HostToolDefinition } from './notifyTool.js'
import { publishSnapshot, fetchSnapshot } from './filesGithub.js'
import {
  FileDirectory,
  FileFault,
  nameKey,
  relativeFilePath,
} from './filesSafeFs.js'
import {
  bindingSchema,
  exportContentRules,
  exportPathRules,
  FILE_LIMITS,
  manifestSha256,
  scopeContains,
  sha256,
  validateManifest,
  type FileBinding,
  type FileManifestEntry,
} from './filesPolicy.js'

interface StoredTransfer {
  readonly grantId: string
  readonly agent: string
  readonly generation: string
  readonly side: 'source' | 'target'
  readonly path: string
  readonly kind: 'file' | 'dir'
  entries: FileManifestEntry[]
  ready: boolean
  aborted: boolean
  delivered: string | null
  planned: string | null
}
interface FileOperation {
  readonly digest: string
  outcome: ControlOutcome | null
}
interface FileBook {
  generations: Record<string, { identity: string; epoch: string }>
  transfers: Record<string, StoredTransfer>
  operations: Record<string, FileOperation>
}
export interface NodeFilesOptions {
  readonly node: string
  readonly agents: () => readonly {
    readonly agent: string
    readonly cwd: string
  }[]
  readonly hub: Pick<HubCallClient, 'call'>
  readonly stopped: () => boolean
  readonly directory?: string
  /** Test-only: accept a `file:` remote in place of github.com. */
  readonly localExchangeRemote?: boolean
  readonly audit?: (
    kind: string,
    detail: Record<string, string | number | boolean>,
  ) => void
}
const idSchema = z.string().uuid()
const rejected = (code: string): ControlOutcome => ({
  ok: false,
  code,
  message: `文件操作拒绝：${code}`,
})

/** Host-only staging. Resident tools cannot access protected config roots or execute code. */
export class NodeFiles {
  readonly #options: NodeFilesOptions
  readonly #directory: string
  readonly #bookPath: string
  readonly #book: FileBook
  #queue: Promise<unknown> = Promise.resolve()
  constructor(options: NodeFilesOptions) {
    this.#options = options
    this.#directory = options.directory ?? qianmoConfigPath('qianmo', 'files')
    this.#bookPath = path.join(this.#directory, 'operations.json')
    ensurePrivateDir(this.#directory)
    const text = readTextIfExists(this.#bookPath)
    this.#book = text
      ? (JSON.parse(text) as FileBook)
      : { generations: {}, transfers: {}, operations: {} }
    // Pending mutations have no success receipt. Never execute them again.
    for (const op of Object.values(this.#book.operations))
      if (!op.outcome) op.outcome = rejected('result-unknown')
    for (const key of Object.keys(this.#book.transfers)) {
      idSchema.parse(key.split(':')[0])
    }
    // A crash can leave a snapshot before its transfer row was persisted.
    for (const name of fs.readdirSync(this.#directory))
      if (idSchema.safeParse(name).success)
        fs.rmSync(this.#stage(name), { recursive: true, force: true })
    this.#persist()
  }
  #persist(): void {
    writePrivateJson(this.#bookPath, this.#book, { syncDirectory: true })
  }
  #stage(id: string, side?: 'source' | 'target'): string {
    return path.join(this.#directory, id, ...(side ? [side] : []))
  }
  #audit(
    kind: string,
    detail: Record<string, string | number | boolean>,
  ): void {
    this.#options.audit?.(`files.${kind}`, detail)
  }
  #workspace(agent: string): { root: FileDirectory; generation: string } {
    const row = this.#options.agents().find(one => one.agent === agent)
    if (!row) throw new FileFault('agent-not-found')
    const configured = path.resolve(row.cwd)
    const cwd = fs.realpathSync(configured)
    const stage = fs.realpathSync(this.#directory)
    const relativeStage = path.relative(cwd, stage)
    if (
      relativeStage !== '..' &&
      !relativeStage.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeStage)
    )
      throw new FileFault('staging-inside-workspace')
    const root = FileDirectory.root(cwd)
    const identity = JSON.stringify([configured, cwd, root.generation])
    let generation = this.#book.generations[agent]
    if (!generation || generation.identity !== identity) {
      generation = { identity, epoch: crypto.randomUUID() }
      this.#book.generations[agent] = generation
      this.#persist()
    }
    return { root, generation: generation.epoch }
  }
  async #binding(
    args: Record<string, unknown>,
    side: 'source' | 'target',
    ctx: ControlContext,
  ): Promise<FileBinding> {
    const grantId = idSchema.parse(args.grantId),
      transferId = idSchema.parse(args.transferId)
    const agent = z.string().parse(args.agent)
    const validated = await this.#options.hub.call(
      'files.validate',
      { grantId, transferId, side },
      { agent, peer: ctx.peer },
    )
    if (!validated.ok) throw new FileFault(validated.code)
    const grant = bindingSchema.parse(validated.value)
    const ref = grant[side]
    if (
      ref.node !== this.#options.node ||
      ref.agent !== agent ||
      ctx.actor !== grant.grantedBy ||
      grant.grantId !== grantId ||
      grant.revokedAt !== null ||
      grant.expiresAt <= Date.now()
    )
      throw new FileFault('grant-invalid')
    const local = this.#workspace(agent)
    try {
      if (local.generation !== grant[`${side}Generation`])
        throw new FileFault('workspace-changed')
    } finally {
      local.root.close()
    }
    if (this.#options.stopped()) throw new FileFault('estop')
    return grant
  }
  #readWorkspace(root: FileDirectory, relative: string): Buffer {
    const parts = relative.split('/'),
      name = parts.pop()!
    const parent = root.walk(parts.join('/'))
    let fd: number | undefined
    try {
      fd = parent.open(name)
      const before = fs.fstatSync(fd)
      if (!before.isFile() || before.size > FILE_LIMITS.maxFileBytes)
        throw new FileFault('file-too-large')
      // Bound the read independently of stat: a concurrently growing source cannot allocate unbounded memory.
      const bytes = Buffer.alloc(before.size)
      let done = 0
      while (done < bytes.length) {
        const count = fs.readSync(fd, bytes, done, bytes.length - done, done)
        if (!count) throw new FileFault('source-changed')
        done += count
      }
      const after = fs.fstatSync(fd)
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.nlink !== 1
      )
        throw new FileFault('source-changed')
      return bytes
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      parent.close()
    }
  }
  #snapshot(args: Record<string, unknown>, grant: FileBinding): StoredTransfer {
    const id = idSchema.parse(args.transferId),
      relative = relativeFilePath(args.path)
    if (!scopeContains(grant.scope, relative))
      throw new FileFault('scope-mismatch')
    if (exportPathRules(relative).length)
      throw new FileFault('file-path-protected')
    const existing = this.#book.transfers[`${id}:source`]
    if (existing) {
      if (
        existing.path !== relative ||
        existing.grantId !== grant.grantId ||
        existing.side !== 'source' ||
        existing.aborted
      )
        throw new FileFault('transfer-invalid')
      return existing
    }
    const { root, generation } = this.#workspace(grant.source.agent)
    if (generation !== grant.sourceGeneration) {
      root.close()
      throw new FileFault('workspace-changed')
    }
    const entries: FileManifestEntry[] = []
    ensurePrivateDir(this.#stage(id, 'source'))
    const stage = FileDirectory.root(this.#stage(id, 'source'))
    let total = 0
    const visit = (file: string): 'file' | 'dir' => {
      const rules = exportPathRules(file)
      if (rules.length) {
        this.#audit('rejected', { path: file, rules: rules.join(',') })
        throw new FileFault(rules[0]!)
      }
      const parts = file.split('/'),
        name = parts.pop()!,
        parent = root.walk(parts.join('/'))
      let fd: number
      try {
        fd = parent.open(name)
      } finally {
        parent.close()
      }
      const stat = fs.fstatSync(fd)
      if (stat.isDirectory()) {
        const dir = new FileDirectory(fd)
        try {
          for (const child of dir.names())
            visit(`${file}/${child.normalize('NFC')}`)
        } finally {
          dir.close()
        }
        return 'dir'
      }
      fs.closeSync(fd)
      if (stat.size > FILE_LIMITS.maxFileBytes)
        throw new FileFault('file-too-large')
      if (
        ++total > FILE_LIMITS.maxFiles ||
        entries.reduce((n, e) => n + e.size, 0) + stat.size >
          FILE_LIMITS.maxTransferBytes
      )
        throw new FileFault('transfer-too-large')
      const bytes = this.#readWorkspace(root, file)
      const out = stage.open(`${entries.length}`, true)
      try {
        fs.writeFileSync(out, bytes)
        fs.fsyncSync(out)
        fs.fchmodSync(out, 0o400)
      } finally {
        fs.closeSync(out)
      }
      // Scan the host-owned copy, never a later reopen of the mutable source.
      const snapshotFd = stage.open(`${entries.length}`)
      let snapshot: Buffer
      try {
        snapshot = fs.readFileSync(snapshotFd)
      } finally {
        fs.closeSync(snapshotFd)
      }
      const finding = exportContentRules(file, snapshot)
      if (finding.rules.length) {
        this.#audit('rejected', { path: file, rules: finding.rules.join(',') })
        throw new FileFault('file-secret')
      }
      this.#audit('read', { path: file, scan: finding.scan })
      entries.push({
        path: file,
        size: snapshot.length,
        sha256: sha256(snapshot),
      })
      return 'file'
    }
    try {
      const kind = visit(relative)
      validateManifest(entries)
      const transfer: StoredTransfer = {
        grantId: grant.grantId,
        agent: grant.source.agent,
        generation,
        side: 'source',
        path: relative,
        kind,
        entries,
        ready: true,
        aborted: false,
        delivered: null,
        planned: null,
      }
      this.#book.transfers[`${id}:source`] = transfer
      this.#persist()
      return transfer
    } catch (error) {
      fs.rmSync(this.#stage(id), { recursive: true, force: true })
      throw error
    } finally {
      root.close()
      stage.close()
    }
  }
  async #dispatch(
    op: string,
    args: Record<string, unknown>,
    ctx: ControlContext,
  ): Promise<ControlOutcome> {
    if (op === 'files.abort' || op === 'files.clean') {
      const id = idSchema.parse(args.transferId)
      for (const side of ['source', 'target']) {
        const transfer = this.#book.transfers[`${id}:${side}`]
        if (transfer) transfer.aborted = true
      }
      this.#persist()
      try {
        const target = this.#book.transfers[`${id}:target`]
        if (target?.planned && !target.delivered) {
          const { root } = this.#workspace(target.agent)
          try {
            const parentPath = target.planned.split('/').slice(0, -1).join('/')
            const parent = root.walk(parentPath)
            try {
              parent.remove(`.files-${id}`)
            } finally {
              parent.close()
            }
          } finally {
            root.close()
          }
        }
      } finally {
        fs.rmSync(this.#stage(id), { recursive: true, force: true })
      }
      return { ok: true, value: null }
    }
    if (this.#options.stopped()) throw new FileFault('estop')
    if (
      op === 'files.browse' ||
      (op === 'files.stat' && args.inspect === true)
    ) {
      const agent = z.string().parse(args.agent),
        relative = relativeFilePath(args.path ?? '', true)
      const { root, generation } = this.#workspace(agent)
      try {
        if (relative && exportPathRules(relative).length)
          throw new FileFault('file-path-protected')
        if (op === 'files.stat') {
          if (args.auditEvent === 'granted' || args.auditEvent === 'denied')
            this.#audit(args.auditEvent, {
              agent,
              path: relative,
              by: ctx.actor,
            })
          if (!relative) return { ok: true, value: { generation, kind: 'dir' } }
          const parts = relative.split('/'),
            name = parts.pop()!,
            parent = root.walk(parts.join('/'))
          try {
            const fd = parent.open(name)
            try {
              return {
                ok: true,
                value: {
                  generation,
                  kind: fs.fstatSync(fd).isDirectory() ? 'dir' : 'file',
                },
              }
            } finally {
              fs.closeSync(fd)
            }
          } finally {
            parent.close()
          }
        }
        const dir = root.walk(relative)
        try {
          const entries = dir
            .names()
            .filter(
              name =>
                !exportPathRules([relative, name].filter(Boolean).join('/'))
                  .length,
            )
            .map(name => {
              const fd = dir.open(name)
              try {
                const stat = fs.fstatSync(fd)
                return {
                  name,
                  kind: stat.isDirectory() ? 'dir' : 'file',
                  size: stat.isDirectory() ? null : stat.size,
                  mtime: stat.mtimeMs,
                }
              } finally {
                fs.closeSync(fd)
              }
            })
          if (entries.length > FILE_LIMITS.maxFiles)
            throw new FileFault('directory-too-large')
          return { ok: true, value: entries }
        } finally {
          dir.close()
        }
      } finally {
        root.close()
      }
    }
    if (op !== 'files.publish' && op !== 'files.fetch')
      return rejected('unsupported')
    const side = op === 'files.publish' ? 'source' : 'target'
    const id = idSchema.parse(args.transferId)
    const grant = await this.#binding(args, side, ctx)
    try {
      if (this.#book.transfers[`${id}:${side}`])
        throw new FileFault('transfer-invalid')
      if (op === 'files.publish') {
        const transfer = this.#snapshot(args, grant)
        const result = await publishSnapshot(
          path.join(this.#stage(id), 'repo'),
          this.#stage(id, 'source'),
          {
            path: transfer.path,
            kind: transfer.kind,
            entries: transfer.entries,
            manifestSha256: manifestSha256(transfer.entries),
          },
          args,
          () => this.#binding(args, 'source', ctx),
          this.#options.localExchangeRemote === true,
        )
        this.#audit('published', {
          transferId: id,
          commit: result.commit,
          manifestSha256: result.manifestSha256,
        })
        return { ok: true, value: result }
      }
      ensurePrivateDir(this.#stage(id, 'target'))
      const manifest = await fetchSnapshot(
        path.join(this.#stage(id), 'repo'),
        this.#stage(id, 'target'),
        args,
        this.#options.localExchangeRemote === true,
      )
      if (
        !scopeContains(grant.scope, manifest.path) ||
        manifest.entries.some(
          one =>
            !scopeContains(grant.scope, one.path) ||
            (manifest.kind === 'file'
              ? one.path !== manifest.path
              : !one.path.startsWith(`${manifest.path}/`)),
        ) ||
        (manifest.kind === 'file' && manifest.entries.length !== 1)
      )
        throw new FileFault('scope-mismatch')
      const transfer: StoredTransfer = {
        grantId: grant.grantId,
        agent: grant.target.agent,
        generation: grant.targetGeneration,
        side: 'target',
        path: manifest.path,
        kind: manifest.kind,
        entries: manifest.entries,
        ready: true,
        aborted: false,
        delivered: null,
        planned: null,
      }
      this.#book.transfers[`${id}:target`] = transfer
      this.#persist()
      const current = await this.#binding(args, 'target', ctx)
      return this.#commit(id, transfer, current)
    } finally {
      fs.rmSync(this.#stage(id), { recursive: true, force: true })
    }
  }
  #commit(
    id: string,
    transfer: StoredTransfer,
    grant: FileBinding,
  ): ControlOutcome {
    // No await between the last authorization check and the atomic publication.
    const { root, generation } = this.#workspace(grant.target.agent)
    if (generation !== grant.targetGeneration) {
      root.close()
      throw new FileFault('workspace-changed')
    }
    const destination = `inbox/${grant.source.node}/${transfer.path}`
    const parts = destination.split('/'),
      name = parts.pop()!
    let parent: FileDirectory
    try {
      parent = root.walk(parts.join('/'), true)
    } finally {
      root.close()
    }
    try {
      const names = parent.names()
      if (
        names.some(
          one =>
            nameKey(one) === nameKey(name) &&
            one.normalize('NFC') !== name.normalize('NFC'),
        )
      )
        throw new FileFault('name-alias')
      const landing = names.some(one => nameKey(one) === nameKey(name))
        ? `${name}.${id.slice(0, 8)}`
        : name
      const temporary = `.files-${id}`
      transfer.planned = [...parts, landing].join('/')
      this.#persist()
      if (transfer.kind === 'file') {
        const fd = parent.open(temporary, true)
        try {
          fs.writeFileSync(fd, this.#payload(id, 0, transfer.entries[0]!))
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      } else {
        const dir = parent.directory(temporary, true)
        try {
          for (const [index, entry] of transfer.entries.entries()) {
            const tail = entry.path.slice(transfer.path.length + 1).split('/'),
              leaf = tail.pop()!,
              nested = dir.walk(tail.join('/'), true)
            try {
              const fd = nested.open(leaf, true)
              try {
                fs.writeFileSync(fd, this.#payload(id, index, entry))
                fs.fsyncSync(fd)
              } finally {
                fs.closeSync(fd)
              }
            } finally {
              nested.close()
            }
          }
        } finally {
          dir.close()
        }
      }
      parent.renameExclusive(temporary, landing)
      transfer.delivered = transfer.planned
      this.#persist()
      this.#audit('verified', { transferId: id, path: transfer.path })
      this.#audit('delivered', { transferId: id, path: transfer.delivered })
      fs.rmSync(this.#stage(id, 'target'), { recursive: true, force: true })
      return { ok: true, value: { path: transfer.delivered, verified: true } }
    } finally {
      parent.close()
    }
  }
  #payload(id: string, index: number, entry: FileManifestEntry): Buffer {
    const stage = FileDirectory.root(this.#stage(id, 'target'))
    try {
      const fd = stage.open(String(index))
      try {
        const bytes = fs.readFileSync(fd)
        if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
          throw new FileFault('content-digest')
        return bytes
      } finally {
        fs.closeSync(fd)
      }
    } finally {
      stage.close()
    }
  }
  handle(
    op: string,
    args: Record<string, unknown>,
    ctx: ControlContext,
  ): Promise<ControlOutcome> {
    const invoke = async (): Promise<ControlOutcome> => {
      const mutation = [
        'files.publish',
        'files.fetch',
        'files.abort',
        'files.clean',
      ].includes(op)
      let operation: FileOperation | undefined
      try {
        if (
          this.#options.stopped() &&
          op !== 'files.abort' &&
          op !== 'files.clean'
        )
          throw new FileFault('estop')
        if (mutation) {
          const operationId = idSchema.parse(args.operationId)
          const key = `${ctx.peer}:${operationId}`,
            digest = sha256(
              JSON.stringify([
                op,
                {
                  ...args,
                  credential:
                    args.credential !== null &&
                    typeof args.credential === 'object' &&
                    !Array.isArray(args.credential)
                      ? Object.fromEntries(
                          Object.entries(args.credential).filter(
                            ([key]) => key !== 'token',
                          ),
                        )
                      : args.credential,
                },
                ctx.actor,
              ]),
            )
          const old = this.#book.operations[key]
          if (old)
            return old.digest === digest
              ? (old.outcome ?? rejected('result-unknown'))
              : rejected('operation-conflict')
          operation = { digest, outcome: null }
          this.#book.operations[key] = operation
          this.#persist()
        }
        const outcome = await this.#dispatch(op, args, ctx)
        if (operation) {
          operation.outcome = outcome
          this.#persist()
        }
        return outcome
      } catch (error) {
        const outcome = rejected(
          error instanceof FileFault ? error.code : 'invalid',
        )
        if (operation) {
          operation.outcome = outcome
          this.#persist()
        }
        this.#audit('rejected', { rules: outcome.ok ? '' : outcome.code })
        return outcome
      }
    }
    if (op === 'files.stat' && args.inspect === true) return invoke()
    const run = this.#queue.then(invoke)
    this.#queue = run.catch(() => {})
    return run
  }
  register(registry: ControlRegistry): void {
    // Under ESTOP only abort and staging cleanup may run (P20 §3.3, P26b).
    registry.register('files', (op, args, ctx) => this.handle(op, args, ctx), {
      estopAllowed: ['files.abort', 'files.clean'],
    })
  }
  tool(): HostToolDefinition {
    return {
      name: 'qianmo_file_request',
      description:
        'Request a file from another agent. The source owner must approve before any content is exported.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['from', 'path', 'reason'],
      },
      handler: async (input, ctx) => {
        try {
          if (this.#options.stopped()) throw new FileFault('estop')
          const row = z
            .object({
              from: z.string(),
              path: z.string(),
              reason: z.string().trim().min(1).max(2000),
            })
            .strict()
            .parse(input)
          if (!parseAddress(row.from)) throw new FileFault('invalid-source')
          const result = await this.#options.hub.call(
            'files.request',
            { ...row, path: relativeFilePath(row.path) },
            { agent: ctx.agent },
          )
          if (result.ok)
            this.#audit('requested', { agent: ctx.agent, path: row.path })
          return {
            ok: result.ok,
            text: result.ok
              ? 'File request recorded; waiting for source owner approval.'
              : 'File request refused.',
            details: result,
          }
        } catch {
          return { ok: false, text: 'Invalid file request.' }
        }
      },
    }
  }
}
