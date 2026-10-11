// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type {
  ActionLedgerPort,
  AgentRef,
  ConsoleAction,
  ConsoleFailure,
  ConsoleResult,
  DirectionActor,
  FileEntryView,
  FileGrantView,
  FileGroupView,
  FileRequestView,
  FileScope,
  FilesPort,
  FilesSnapshot,
  FileTransferView,
} from '@qianmo/console'
import { LIMITS, parseAddress, type ControlOutcome } from '@qianmo/protocol'
import {
  readTextIfExists,
  writePrivateJson,
  ensurePrivateDir,
} from '../providers/store.js'
import {
  bindingSchema,
  filePathSchema,
  FILE_CHUNK_BYTES,
  FILE_LIMITS,
  FILE_PAGE_SIZE,
  manifestEntrySchema,
  manifestSha256,
  refSchema,
  scopeContains,
  scopeSchema,
  sha256,
  validateManifest,
  type FileBinding,
  type FileManifestEntry,
} from '../host/filesPolicy.js'
import { FileFault, relativeFilePath } from '../host/filesSafeFs.js'
import type { ControlLinks, HubCallHandler } from './consoleControl.js'

interface StoredGrant extends FileGrantView {
  readonly sourceGeneration: string
  readonly targetGeneration: string
}
interface FilesBook {
  requests: FileRequestView[]
  grants: StoredGrant[]
  transfers: FileTransferView[]
  groups: FileGroupView[]
}
export interface ConsoleFilesOptions {
  readonly directory: string
  readonly control: Pick<ControlLinks, 'request' | 'status' | 'onHubCall'>
  readonly agents: () => Promise<readonly AgentRef[]>
  /** Always reads current account and tenant policy, including during a transfer. */
  readonly requestAllowed?: (source: AgentRef, target: AgentRef) => boolean
  readonly authorized: (
    subject: string,
    source: AgentRef,
    target: AgentRef,
  ) => boolean
  readonly actions?: ActionLedgerPort
  readonly stopped?: () => boolean
  readonly now?: () => number
  readonly pacing?: {
    readonly now: () => number
    readonly wait: (milliseconds: number) => Promise<void>
  }
  readonly onError?: (message: string) => void
}
const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value })
const fail = <T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> => ({ ok: false, failure: { code, message } })
const refEqual = (a: AgentRef, b: AgentRef) =>
  a.node === b.node && a.agent === b.agent
const idSchema = z.string().uuid()
const inspectSchema = z.object({
  generation: z.string(),
  kind: z.enum(['file', 'dir']),
})
const pageSchema = z.object({
  kind: z.enum(['file', 'dir']),
  entries: z.array(manifestEntrySchema).max(FILE_PAGE_SIZE),
  total: z.number().int().min(1).max(FILE_LIMITS.maxFiles),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string(),
})
const decisionSchema = z
  .object({
    approve: z.boolean(),
    scope: scopeSchema.optional(),
    ttlMs: z.number().int().positive().max(FILE_LIMITS.maxTtlMs).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict()

/** The hub owns grants and books; nodes independently validate every use over hub.call. */
export class ConsoleFiles implements FilesPort {
  readonly #options: ConsoleFilesOptions
  readonly #bookPath: string
  readonly #book: FilesBook
  readonly #background = new Set<Promise<void>>()
  #execution: Promise<unknown> = Promise.resolve()
  readonly #pace = new Map<string, Promise<unknown>>()
  readonly #discovered = new Map<
    string,
    { connectedAt: number | null; refs: readonly AgentRef[] }
  >()
  readonly #nextCall = new Map<string, number>()
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  #cleanupTimer: NodeJS.Timeout | null = null
  readonly #cleanupPending = new Set<string>()
  #cleanupFlight = false
  constructor(options: ConsoleFilesOptions) {
    this.#options = options
    this.#bookPath = path.join(options.directory, 'files.json')
    ensurePrivateDir(options.directory)
    const text = readTextIfExists(this.#bookPath)
    this.#book = text
      ? (JSON.parse(text) as FilesBook)
      : { requests: [], grants: [], transfers: [], groups: [] }
    for (let i = 0; i < this.#book.transfers.length; i++) {
      const transfer = this.#book.transfers[i]!
      idSchema.parse(transfer.transferId)
      if (transfer.state !== 'done')
        this.#cleanupPending.add(transfer.transferId)
      if (transfer.state !== 'done' && transfer.state !== 'failed') {
        this.#book.transfers[i] = {
          ...transfer,
          state: 'failed',
          reason: '中枢重启：结果未知，可人工重试',
          finishedAt: this.#now(),
        }
        this.#cleanupPending.add(transfer.transferId)
        // Only local hub staging is safe to remove before the links are started.
        fs.rmSync(this.#stage(transfer.transferId), {
          recursive: true,
          force: true,
        })
      }
    }
    this.#persist()
    options.control.onHubCall('files', this.hubHandler)
  }
  #now(): number {
    return (this.#options.now ?? Date.now)()
  }
  #persist(): void {
    writePrivateJson(this.#bookPath, this.#book, { syncDirectory: true })
  }
  #stage(id: string): string {
    return path.join(this.#options.directory, id)
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const flight = this.#queue.then(run)
    this.#queue = flight.catch(() => {})
    return flight
  }
  #allowed(subject: string, source: AgentRef, target: AgentRef): boolean {
    try {
      return (
        !this.#closed &&
        !this.#options.stopped?.() &&
        this.#options.authorized(subject, source, target)
      )
    } catch {
      return false
    }
  }
  #grant(id: string): StoredGrant {
    const grant = this.#book.grants.find(one => one.grantId === id)
    if (
      !grant ||
      grant.revokedAt !== null ||
      grant.expiresAt <= this.#now() ||
      !this.#allowed(grant.grantedBy, grant.source, grant.target)
    )
      throw new FileFault('grant-invalid')
    return grant
  }
  // Window one, paced per node. Allow room for ACKs, grant callbacks, other
  // control features, and heartbeat traffic under the 600-message limit.
  async #call(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
  ): Promise<unknown> {
    const previous = this.#pace.get(node) ?? Promise.resolve()
    const reservation = previous
      .catch(() => {})
      .then(async () => {
        const now = this.#options.pacing?.now ?? Date.now
        const delay = Math.max(0, (this.#nextCall.get(node) ?? 0) - now())
        if (delay) {
          if (this.#options.pacing) await this.#options.pacing.wait(delay)
          else {
            const pending = Promise.withResolvers<void>()
            setTimeout(pending.resolve, delay)
            await pending.promise
          }
        }
        this.#nextCall.set(
          node,
          now() + Math.ceil(60_000 / (LIMITS.ratePerMinute / 12)),
        )
      })
    // Reserve the rate slot, not the response. Grant callbacks must be able to
    // inspect a node while a file handler there awaits that callback.
    this.#pace.set(node, reservation)
    await reservation
    if (this.#closed && op !== 'files.abort') throw new FileFault('closed')
    if (this.#options.stopped?.() && op !== 'files.abort')
      throw new FileFault('estop')
    const outcome = await this.#options.control.request(node, op, args, actor)
    if (!outcome.ok)
      throw new FileFault(
        outcome.code === 'timeout' || outcome.code === 'unreachable'
          ? 'result-unknown'
          : outcome.code,
      )
    return outcome.value
  }
  async #agents(
    refresh = false,
    nodes?: readonly string[],
  ): Promise<readonly AgentRef[]> {
    const refs = new Map(
      (await this.#options.agents()).map(ref => [
        `${ref.node}/${ref.agent}`,
        ref,
      ]),
    )
    for (const status of this.#options.control.status()) {
      let cached = this.#discovered.get(status.node)
      if (
        refresh &&
        status.connected &&
        (nodes === undefined || nodes.includes(status.node)) &&
        (!cached || cached.connectedAt !== status.lastConnectedAt)
      ) {
        try {
          const value = z
            .object({
              node: refSchema.shape.node,
              agents: z.array(refSchema.shape.agent).max(1000),
            })
            .parse(
              await this.#call(status.node, 'node.ping', {}, 'system:files'),
            )
          if (value.node !== status.node) throw new FileFault('node-identity')
          cached = {
            connectedAt: status.lastConnectedAt,
            refs: value.agents.map(agent => ({ node: status.node, agent })),
          }
          this.#discovered.set(status.node, cached)
        } catch {
          this.#options.onError?.('文件智能体发现暂不可用')
        }
      }
      for (const ref of cached?.refs ?? [])
        refs.set(`${ref.node}/${ref.agent}`, ref)
    }
    return [...refs.values()]
  }
  async #inspect(
    ref: AgentRef,
    file: string,
    actor: string,
  ): Promise<z.infer<typeof inspectSchema>> {
    return inspectSchema.parse(
      await this.#call(
        ref.node,
        'files.stat',
        { agent: ref.agent, path: file, inspect: true },
        actor,
      ),
    )
  }
  async #valid(id: string): Promise<StoredGrant> {
    const grant = this.#grant(id)
    const source = await this.#inspect(grant.source, '', grant.grantedBy),
      target = await this.#inspect(grant.target, '', grant.grantedBy)
    if (
      source.generation !== grant.sourceGeneration ||
      target.generation !== grant.targetGeneration
    )
      throw new FileFault('workspace-changed')
    return this.#grant(id)
  }
  readonly hubHandler: HubCallHandler = async (
    op,
    args,
    ctx,
  ): Promise<ControlOutcome> => {
    try {
      if (op === 'files.request') {
        if (!ctx.agent || this.#closed || this.#options.stopped?.())
          throw new FileFault('invalid-request')
        const source = parseAddress(z.string().parse(args.from))
        if (!source) throw new FileFault('invalid-source')
        const row = z
          .object({
            path: filePathSchema,
            reason: z.string().trim().min(1).max(2000),
          })
          .parse(args)
        const target = { node: ctx.node, agent: ctx.agent }
        if (this.#options.requestAllowed?.(source, target) === false)
          throw new FileFault('request-forbidden')
        const known = await this.#agents(true, [source.node, target.node])
        if (
          !known.some(one => refEqual(one, source)) ||
          !known.some(one => refEqual(one, target))
        )
          throw new FileFault('unknown-agent')
        const request: FileRequestView = {
          requestId: crypto.randomUUID(),
          source: { node: source.node, agent: source.agent },
          target,
          path: row.path,
          reason: row.reason,
          requestedBy: 'agent',
          at: this.#now(),
          state: 'pending',
          grantId: null,
          note: null,
        }
        await this.#serial(async () => {
          this.#book.requests.push(request)
          this.#persist()
        })
        return { ok: true, value: request }
      }
      if (op !== 'files.validate' || !ctx.agent)
        throw new FileFault('unsupported')
      const grant = this.#grant(idSchema.parse(args.grantId)),
        transfer = this.#book.transfers.find(
          one => one.transferId === args.transferId,
        )
      const side = z.enum(['source', 'target']).parse(args.side),
        endpoint = grant[side]
      if (
        !transfer ||
        transfer.grantId !== grant.grantId ||
        !['queued', 'reading', 'verifying', 'delivering'].includes(
          transfer.state,
        ) ||
        endpoint.node !== ctx.node ||
        endpoint.agent !== ctx.agent ||
        !scopeContains(grant.scope, transfer.source.path)
      )
        throw new FileFault('grant-invalid')
      // The local host checks its own generation. The callback checks the other
      // endpoint, so changing either workspace invalidates even the next read.
      const other = side === 'source' ? 'target' : 'source'
      const generation = await this.#inspect(grant[other], '', grant.grantedBy)
      if (generation.generation !== grant[`${other}Generation`])
        throw new FileFault('workspace-changed')
      return {
        ok: true,
        value: bindingSchema.parse(this.#grant(grant.grantId)),
      }
    } catch (error) {
      return {
        ok: false,
        code: error instanceof FileFault ? error.code : 'invalid',
        message: '文件申请或授权复核失败',
      }
    }
  }
  async #write<T>(
    action: ConsoleAction['action'],
    target: string,
    actor: DirectionActor,
    run: () => Promise<ConsoleResult<T>>,
    permitted?: () => boolean,
  ): Promise<ConsoleResult<T>> {
    return this.#serial(async () => {
      if (
        !(
          actor.role === 'member' ||
          actor.role === 'ops' ||
          actor.subject === 'legacy:admin'
        )
      )
        return fail('refused', '成员身份必需')
      if (this.#closed || this.#options.stopped?.())
        return fail('rejected', '文件互通已停止')
      const row =
        action === 'files.decide'
          ? this.#book.requests.find(one => one.requestId === target)
          : action === 'files.grant.revoke'
            ? this.#book.grants.find(one => one.grantId === target)
            : action === 'files.retry'
              ? this.#book.transfers.find(one => one.transferId === target)
              : undefined
      const visible = () =>
        permitted
          ? permitted()
          : row !== undefined &&
            this.#allowed(actor.subject, row.source, row.target)
      if (!visible()) return fail('not_found', '资源不存在')
      const admitted = await this.#options.actions?.admit?.()
      if (admitted && !admitted.ok) return admitted
      if (!visible()) return fail('not_found', '资源不存在')
      let result: ConsoleResult<T>
      try {
        result = await run()
      } catch (error) {
        result = fail(
          error instanceof FileFault && error.code === 'result-unknown'
            ? 'unreachable'
            : 'rejected',
          error instanceof FileFault && error.code === 'result-unknown'
            ? '结果未知，不自动重发提交'
            : '文件操作拒绝',
        )
      }
      const record = await this.#options.actions?.record({
        at: this.#now(),
        requestId: actor.requestId,
        subject: actor.subject,
        action,
        target,
        outcome: result.ok ? 'ok' : 'failed',
        ...(result.ok ? {} : { code: result.failure.code }),
      })
      if (record && !record.ok) this.#options.onError?.('文件动作账本记录失败')
      return result
    })
  }
  async snapshot(): Promise<ConsoleResult<FilesSnapshot>> {
    const known = await this.#agents(),
      statuses = new Map(
        this.#options.control.status().map(one => [one.node, one.connected]),
      )
    return ok(
      structuredClone({
        ...this.#book,
        grants: this.#book.grants.map(
          ({
            sourceGeneration: _source,
            targetGeneration: _target,
            ...grant
          }) => grant,
        ),
        requests: this.#book.requests.map(request =>
          request.state === 'granted' &&
          request.grantId &&
          (this.#book.grants.find(one => one.grantId === request.grantId)
            ?.expiresAt ?? Infinity) <= this.#now()
            ? { ...request, state: 'expired' as const }
            : request,
        ),
        agents: known.map(ref => ({
          ...ref,
          reachable: statuses.get(ref.node) ?? false,
        })),
        limits: FILE_LIMITS,
      }),
    )
  }
  async browse(
    ref: AgentRef,
    file: string,
  ): Promise<ConsoleResult<readonly FileEntryView[]>> {
    try {
      refSchema.parse(ref)
      const entries = await this.#call(
        ref.node,
        'files.browse',
        { agent: ref.agent, path: relativeFilePath(file, true) },
        'console:browse',
      )
      return ok(
        z
          .array(
            z.object({
              name: z.string(),
              kind: z.enum(['file', 'dir']),
              size: z.number().nullable(),
              mtime: z.number().nullable(),
            }),
          )
          .max(FILE_LIMITS.maxFiles)
          .parse(entries),
      )
    } catch {
      return fail('rejected', '目录不可浏览')
    }
  }
  decide(
    id: string,
    decision: {
      readonly approve: boolean
      readonly scope?: FileScope
      readonly ttlMs?: number
      readonly note?: string
    },
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileRequestView>> {
    return this.#write('files.decide', id, actor, async () => {
      const request = this.#book.requests.find(one => one.requestId === id)
      if (
        !request ||
        !this.#allowed(actor.subject, request.source, request.target)
      )
        return fail('not_found', '资源不存在')
      const parsed = decisionSchema.safeParse(decision)
      if (!parsed.success) return fail('invalid', '决定参数无效')
      if (request.state !== 'pending') return fail('rejected', '申请已处理')
      let grantId: string | null = null
      if (parsed.data.approve) {
        const scope = parsed.data.scope ?? {
          kind: 'file' as const,
          path: request.path,
        }
        if (!scopeContains(scope, request.path))
          return fail('rejected', '范围未包含申请路径')
        const grant = await this.#issue(
          request.source,
          request.target,
          scope,
          actor.subject,
          id,
          parsed.data.ttlMs,
        )
        grantId = grant.grantId
      }
      const next: FileRequestView = {
        ...request,
        state: parsed.data.approve ? 'granted' : 'denied',
        grantId,
        note: parsed.data.note ?? null,
      }
      this.#book.requests[this.#book.requests.indexOf(request)] = next
      this.#persist()
      if (!parsed.data.approve)
        await this.#call(
          request.source.node,
          'files.stat',
          {
            agent: request.source.agent,
            path: '',
            inspect: true,
            auditEvent: parsed.data.approve ? 'granted' : 'denied',
            requestId: id,
          },
          actor.subject,
        )
      return ok(next)
    })
  }
  revokeGrant(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileGrantView>> {
    return this.#write('files.grant.revoke', id, actor, async () => {
      const grant = this.#book.grants.find(one => one.grantId === id)
      if (!grant || !this.#allowed(actor.subject, grant.source, grant.target))
        return fail('not_found', '资源不存在')
      const next = { ...grant, revokedAt: this.#now() }
      this.#book.grants[this.#book.grants.indexOf(grant)] = next
      for (let i = 0; i < this.#book.requests.length; i++)
        if (this.#book.requests[i]!.grantId === id)
          this.#book.requests[i] = {
            ...this.#book.requests[i]!,
            state: 'revoked',
          }
      this.#persist()
      const {
        sourceGeneration: _source,
        targetGeneration: _target,
        ...view
      } = next
      return ok(view)
    })
  }
  async #issue(
    source: AgentRef,
    target: AgentRef,
    scope: FileScope,
    by: string,
    requestId: string | null,
    ttlMs = 60 * 60_000,
  ): Promise<StoredGrant> {
    if (!this.#allowed(by, source, target)) throw new FileFault('unauthorized')
    scopeSchema.parse(scope)
    const src = await this.#inspect(source, scope.path, by),
      dest = await this.#inspect(target, '', by)
    if (src.kind !== scope.kind || !this.#allowed(by, source, target))
      throw new FileFault('grant-invalid')
    const grant: StoredGrant = {
      grantId: crypto.randomUUID(),
      requestId,
      source,
      target,
      scope,
      grantedBy: by,
      grantedAt: this.#now(),
      expiresAt: this.#now() + ttlMs,
      revokedAt: null,
      sourceGeneration: src.generation,
      targetGeneration: dest.generation,
    }
    this.#book.grants.push(grant)
    this.#persist()
    await this.#call(
      source.node,
      'files.stat',
      {
        agent: source.agent,
        path: '',
        inspect: true,
        auditEvent: 'granted',
        grantId: grant.grantId,
      },
      by,
    )
    return grant
  }
  #reserve(
    grant: StoredGrant,
    file: string,
    groupId: string,
  ): FileTransferView {
    const transfer: FileTransferView = {
      transferId: crypto.randomUUID(),
      grantId: grant.grantId,
      groupId,
      source: { ...grant.source, path: file },
      target: { ...grant.target, path: null },
      files: 0,
      bytes: 0,
      doneBytes: 0,
      manifestSha256: null,
      verified: null,
      state: 'queued',
      reason: null,
      startedAt: this.#now(),
      finishedAt: null,
    }
    this.#book.transfers.push(transfer)
    return transfer
  }
  transfer(
    input: {
      readonly sources: readonly (AgentRef & { readonly path: string })[]
      readonly target: AgentRef
    },
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileGroupView>> {
    const groupId = crypto.randomUUID()
    return this.#write(
      'files.transfer',
      groupId,
      actor,
      async () => {
        const parsed = z
          .object({
            sources: z
              .array(refSchema.extend({ path: filePathSchema }))
              .min(1)
              .max(100),
            target: refSchema,
          })
          .safeParse(input)
        if (!parsed.success) return fail('invalid', '来源与目标无效')
        const { sources, target } = parsed.data
        if (
          sources.some(source => !this.#allowed(actor.subject, source, target))
        )
          return fail('not_found', '资源不存在')
        const transfers: FileTransferView[] = []
        // Reserve each source independently: an offline or refused source becomes
        // its own failed transfer and does not cancel successful siblings.
        for (const source of sources) {
          let grant = this.#book.grants.find(
            one =>
              refEqual(one.source, source) &&
              refEqual(one.target, target) &&
              scopeContains(one.scope, source.path) &&
              one.grantedBy === actor.subject &&
              one.revokedAt === null &&
              one.expiresAt > this.#now(),
          )
          try {
            if (grant) await this.#valid(grant.grantId)
            else {
              const info = await this.#inspect(
                source,
                source.path,
                actor.subject,
              )
              grant = await this.#issue(
                source,
                target,
                { kind: info.kind, path: source.path },
                actor.subject,
                null,
              )
            }
            transfers.push(this.#reserve(grant, source.path, groupId))
          } catch {
            if (!grant) {
              grant = {
                grantId: crypto.randomUUID(),
                requestId: null,
                source: { node: source.node, agent: source.agent },
                target,
                scope: { kind: 'file', path: source.path },
                grantedBy: actor.subject,
                grantedAt: this.#now(),
                expiresAt: this.#now(),
                revokedAt: null,
                sourceGeneration: '',
                targetGeneration: '',
              }
            }
            const failed = {
              ...this.#reserve(grant, source.path, groupId),
              state: 'failed' as const,
              reason: '来源不可用或授权无效',
              finishedAt: this.#now(),
            }
            this.#book.transfers[this.#book.transfers.length - 1] = failed
            transfers.push(failed)
          }
        }
        const group: FileGroupView = {
          groupId,
          target,
          transfers: transfers.map(one => one.transferId),
          createdBy: actor.subject,
          createdAt: this.#now(),
        }
        this.#book.groups.push(group)
        this.#persist()
        for (const one of transfers)
          if (one.state === 'queued') this.#launch(one.transferId)
        return ok(group)
      },
      () => {
        const parsed = z
          .object({
            sources: z
              .array(refSchema.extend({ path: filePathSchema }))
              .min(1)
              .max(100),
            target: refSchema,
          })
          .safeParse(input)
        return (
          !parsed.success ||
          parsed.data.sources.every(source =>
            this.#allowed(actor.subject, source, parsed.data.target),
          )
        )
      },
    )
  }
  retry(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileTransferView>> {
    return this.#write('files.retry', id, actor, async () => {
      const old = this.#book.transfers.find(one => one.transferId === id)
      if (!old || !this.#allowed(actor.subject, old.source, old.target))
        return fail('not_found', '资源不存在')
      if (old.state !== 'failed') return fail('rejected', '只能重试失败的传输')
      const previous = this.#book.grants.find(
        one => one.grantId === old.grantId,
      )
      const grant =
        !previous || (!previous.sourceGeneration && !previous.targetGeneration)
          ? await this.#issue(
              old.source,
              old.target,
              {
                kind: (
                  await this.#inspect(
                    old.source,
                    old.source.path,
                    actor.subject,
                  )
                ).kind,
                path: old.source.path,
              },
              actor.subject,
              null,
            )
          : await this.#valid(old.grantId)
      const transfer = this.#reserve(grant, old.source.path, old.groupId!)
      const group = this.#book.groups.find(one => one.groupId === old.groupId)
      if (group)
        this.#book.groups[this.#book.groups.indexOf(group)] = {
          ...group,
          transfers: [...group.transfers, transfer.transferId],
        }
      this.#persist()
      this.#launch(transfer.transferId)
      return ok(transfer)
    })
  }
  #update(id: string, fields: Partial<FileTransferView>): void {
    const index = this.#book.transfers.findIndex(one => one.transferId === id)
    this.#book.transfers[index] = { ...this.#book.transfers[index]!, ...fields }
    this.#persist()
  }
  #launch(id: string): void {
    const task = this.#execution
      .then(() => this.#execute(id))
      .catch(() => this.#options.onError?.('文件传输记录失败'))
    this.#execution = task
    this.#background.add(task)
    void task.finally(() => this.#background.delete(task))
  }
  async #execute(id: string): Promise<void> {
    const transfer = this.#book.transfers.find(one => one.transferId === id)!
    let grant: StoredGrant | undefined
    try {
      grant = await this.#valid(transfer.grantId)
      const src = {
        agent: grant.source.agent,
        transferId: id,
        grantId: grant.grantId,
        path: transfer.source.path,
      }
      const dst = {
        agent: grant.target.agent,
        transferId: id,
        grantId: grant.grantId,
        path: transfer.source.path,
      }
      const call = async (
        ref: AgentRef,
        op: string,
        args: Record<string, unknown>,
      ) => {
        this.#grant(grant!.grantId)
        return this.#call(ref.node, op, args, grant!.grantedBy)
      }
      this.#update(id, { state: 'reading' })
      const first = pageSchema.parse(
          await call(grant.source, 'files.stat', { ...src, page: 0 }),
        ),
        entries = [...first.entries]
      for (let page = 1; entries.length < first.total; page++) {
        const next = pageSchema.parse(
          await call(grant.source, 'files.stat', { ...src, page }),
        )
        if (
          !next.entries.length ||
          next.total !== first.total ||
          next.manifestSha256 !== first.manifestSha256 ||
          next.kind !== first.kind ||
          next.generation !== grant.sourceGeneration
        )
          throw new FileFault('manifest-digest')
        entries.push(...next.entries)
      }
      validateManifest(entries)
      if (
        entries.length !== first.total ||
        first.generation !== grant.sourceGeneration ||
        manifestSha256(entries) !== first.manifestSha256 ||
        entries.some(one => !scopeContains(grant!.scope, one.path))
      )
        throw new FileFault('manifest-digest')
      this.#update(id, {
        files: entries.length,
        bytes: entries.reduce((total, one) => total + one.size, 0),
        manifestSha256: first.manifestSha256,
      })
      ensurePrivateDir(this.#stage(id))
      let done = 0
      for (const [index, entry] of entries.entries()) {
        const local = path.join(this.#stage(id), `${index}`),
          fd = fs.openSync(local, 'wx', 0o600)
        try {
          for (
            let offset = 0;
            offset < entry.size;
            offset += FILE_CHUNK_BYTES
          ) {
            const result = z
              .object({ data: z.string(), offset: z.number() })
              .parse(
                await call(grant.source, 'files.read', {
                  ...src,
                  index,
                  offset,
                }),
              )
            const bytes = Buffer.from(result.data, 'base64')
            if (
              result.offset !== offset ||
              bytes.toString('base64') !== result.data ||
              bytes.length !== Math.min(FILE_CHUNK_BYTES, entry.size - offset)
            )
              throw new FileFault('chunk-invalid')
            fs.writeSync(fd, bytes)
            done += bytes.length
            this.#update(id, { doneBytes: done })
          }
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      }
      this.#update(id, { state: 'verifying' })
      for (const [index, entry] of entries.entries()) {
        const bytes = await Bun.file(
          path.join(this.#stage(id), `${index}`),
        ).bytes()
        if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
          throw new FileFault('content-digest')
      }
      this.#update(id, { state: 'delivering' })
      for (let page = 0; page * FILE_PAGE_SIZE < entries.length; page++)
        await call(grant.target, 'files.write', {
          ...dst,
          operationId: crypto.randomUUID(),
          kind: first.kind,
          page,
          manifest: entries.slice(
            page * FILE_PAGE_SIZE,
            (page + 1) * FILE_PAGE_SIZE,
          ),
          last: (page + 1) * FILE_PAGE_SIZE >= entries.length,
          manifestSha256: first.manifestSha256,
        })
      for (const [index, entry] of entries.entries()) {
        const bytes = await Bun.file(
          path.join(this.#stage(id), `${index}`),
        ).bytes()
        for (
          let offset = 0;
          offset < entry.size || (entry.size === 0 && offset === 0);
          offset += FILE_CHUNK_BYTES
        )
          await call(grant.target, 'files.write', {
            ...dst,
            operationId: crypto.randomUUID(),
            index,
            offset,
            data: Buffer.from(
              bytes.subarray(offset, offset + FILE_CHUNK_BYTES),
            ).toString('base64'),
          })
      }
      await this.#valid(grant.grantId)
      const result = z
        .object({ path: z.string(), verified: z.literal(true) })
        .parse(
          await call(grant.target, 'files.commit', {
            ...dst,
            operationId: crypto.randomUUID(),
            manifestSha256: first.manifestSha256,
          }),
        )
      this.#update(id, {
        state: 'done',
        verified: true,
        target: { ...transfer.target, path: result.path },
        finishedAt: this.#now(),
      })
    } catch (error) {
      this.#update(id, {
        state: 'failed',
        reason:
          error instanceof FileFault && error.code === 'result-unknown'
            ? '结果未知，不自动重发提交，可人工重试'
            : '文件传输拒绝或校验失败',
        verified:
          error instanceof FileFault && /digest|chunk/.test(error.code)
            ? false
            : null,
        finishedAt: this.#now(),
      })
    } finally {
      fs.rmSync(this.#stage(id), { recursive: true, force: true })
      const binding =
        grant ?? this.#book.grants.find(one => one.grantId === transfer.grantId)
      let cleaned = true
      if (binding)
        for (const ref of [binding.source, binding.target]) {
          try {
            await this.#call(
              ref.node,
              'files.abort',
              { transferId: id, operationId: crypto.randomUUID() },
              binding.grantedBy,
            )
          } catch {
            cleaned = false
            this.#options.onError?.('节点暂存清理结果未知')
          }
        }
      if (!cleaned) this.#cleanupPending.add(id)
    }
  }
  async idle(): Promise<void> {
    await this.#queue
    await Promise.all([...this.#background])
  }
  async cleanup(): Promise<void> {
    if (this.#cleanupFlight) return
    this.#cleanupFlight = true
    try {
      const connected = new Set(
        this.#options.control
          .status()
          .filter(one => one.connected)
          .map(one => one.node),
      )
      for (const id of [...this.#cleanupPending]) {
        const transfer = this.#book.transfers.find(one => one.transferId === id)
        const grant = this.#book.grants.find(
          one => one.grantId === transfer?.grantId,
        )
        if (
          !grant ||
          !connected.has(grant.source.node) ||
          !connected.has(grant.target.node)
        )
          continue
        try {
          for (const ref of [grant.source, grant.target])
            await this.#call(
              ref.node,
              'files.abort',
              { transferId: id, operationId: crypto.randomUUID() },
              grant.grantedBy,
            )
          this.#cleanupPending.delete(id)
        } catch {
          this.#options.onError?.('节点暂存清理结果未知')
        }
      }
    } finally {
      this.#cleanupFlight = false
    }
  }
  async discover(): Promise<void> {
    await this.#agents(true)
  }
  start(): void {
    if (this.#cleanupTimer || this.#closed) return
    void this.discover()
      .then(() => this.cleanup())
      .catch(() => this.#options.onError?.('文件暂存清理失败'))
    this.#cleanupTimer = setInterval(() => {
      void this.discover()
        .then(() => this.cleanup())
        .catch(() => this.#options.onError?.('文件暂存清理失败'))
    }, 5_000)
    this.#cleanupTimer.unref()
  }
  close(): void {
    this.#closed = true
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer)
  }
}
