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
import { parseAddress, type ControlOutcome } from '@qianmo/protocol'
import {
  readTextIfExists,
  writePrivateJson,
  ensurePrivateDir,
} from '../providers/store.js'
import {
  bindingSchema,
  filePathSchema,
  FILE_LIMITS,
  refSchema,
  scopeContains,
  scopeSchema,
  type FileBinding,
} from '../host/filesPolicy.js'
import { FileFault, relativeFilePath } from '../host/filesSafeFs.js'
import { isHandoffRepo } from '@qianmo/handoff'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import { publishedSchema } from '../host/filesGithub.js'
import {
  githubRemoteRefs,
  deleteGithubRefs,
  tokenLinkAllowed,
} from './githubRepoGit.js'
import {
  probePrivateFilesRepo,
  type FilesExchangeCredentials,
  type FilesRepoProbe,
} from './filesExchangeRepo.js'
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
  readonly exchangeRepo?: string
  readonly credentials?: FilesExchangeCredentials
  readonly probe?: FilesRepoProbe
  readonly retentionMs?: number
  readonly controlUrl: (node: string) => string | undefined
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
  readonly #discovered = new Map<
    string,
    { connectedAt: number | null; refs: readonly AgentRef[] }
  >()
  #queue: Promise<unknown> = Promise.resolve()
  readonly #trail: AuditTrail
  #private: boolean | null = null
  readonly #orphanSince = new Map<string, number>()
  #closed = false
  #cleanupTimer: NodeJS.Timeout | null = null
  readonly #cleanupPending = new Set<string>()
  #cleanupFlight = false
  constructor(options: ConsoleFilesOptions) {
    if (
      !options.exchangeRepo ||
      !isHandoffRepo(options.exchangeRepo) ||
      !options.credentials
    )
      throw new Error(
        '--files needs --files-exchange-repo (or an injected credential port)',
      )
    if (
      !Number.isSafeInteger(options.retentionMs ?? 0) ||
      (options.retentionMs ?? 0) < 0
    )
      throw new Error('交换仓库保留期无效')
    this.#options = options
    this.#bookPath = path.join(options.directory, 'files.json')
    ensurePrivateDir(options.directory)
    this.#trail = new AuditTrail(path.join(options.directory, 'files.ndjson'))
    this.#trail.ensure()
    const text = readTextIfExists(this.#bookPath)
    this.#book = text
      ? (JSON.parse(text) as FilesBook)
      : { requests: [], grants: [], transfers: [], groups: [] }
    for (let i = 0; i < this.#book.transfers.length; i++) {
      const transfer = this.#book.transfers[i]!
      idSchema.parse(transfer.transferId)
      // Discard legacy P20 relay staging on upgrade; never read or recreate it.
      fs.rmSync(path.join(options.directory, transfer.transferId), {
        recursive: true,
        force: true,
      })
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
  async #credential(): Promise<{ remoteUrl: string; token: string }> {
    try {
      const value = await this.#options.credentials!.resolve(
        this.#options.exchangeRepo!,
      )
      if (value) return value
    } catch {
      /* Connection errors may contain secrets. */
    }
    throw new FileFault('connection-revoked')
  }
  async initialize(): Promise<void> {
    const credential = await this.#credential()
    try {
      this.#private = await (this.#options.probe ?? probePrivateFilesRepo)(
        this.#options.exchangeRepo!,
        credential,
      )
    } catch {
      this.#private = null
    }
    if (this.#private !== true) throw new FileFault('repo-private')
  }
  async #send(
    ref: AgentRef,
    op: string,
    args: Record<string, unknown>,
    grant: StoredGrant,
  ): Promise<unknown> {
    const url = this.#options.controlUrl(ref.node)
    if (!url || !tokenLinkAllowed(url)) throw new FileFault('token-link')
    await this.initialize()
    await this.#valid(grant.grantId)
    const credential = await this.#credential()
    this.#grant(grant.grantId)
    return this.#call(
      ref.node,
      op,
      {
        ...args,
        exchange: {
          remoteUrl: credential.remoteUrl,
          ref: `refs/heads/qianmo/files/${args.transferId}`,
        },
        credential: { kind: 'github-token', token: credential.token },
        operationId: crypto.randomUUID(),
      },
      grant.grantedBy,
    )
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
  async #call(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
  ): Promise<unknown> {
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
            : error instanceof FileFault
              ? this.#reason(error.code)
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
        exchange: { repo: this.#options.exchangeRepo!, private: this.#private },
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
    const transferId = crypto.randomUUID()
    const transfer: FileTransferView = {
      transferId,
      exchange: {
        ref: `refs/heads/qianmo/files/${transferId}`,
        commit: null,
        cleaned: false,
      },
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
        await this.initialize()
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
      await this.initialize()
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
  #reason(code: string): string {
    if (code === 'repo-private') return '交换仓库必须是私有仓库'
    if (code === 'connection-revoked') return '交换仓库连接已撤销'
    if (code === 'token-link') return '令牌只经加密链路下发'
    if (code === 'result-unknown') return '结果未知，不自动重发提交，可人工重试'
    return '文件传输拒绝或校验失败'
  }
  async #execute(id: string): Promise<void> {
    const transfer = this.#book.transfers.find(one => one.transferId === id)!
    try {
      const grant = await this.#valid(transfer.grantId)
      const args = {
        transferId: id,
        grantId: grant.grantId,
        path: transfer.source.path,
      }
      this.#update(id, { state: 'reading' })
      const published = publishedSchema.parse(
        await this.#send(
          grant.source,
          'files.publish',
          { ...args, agent: grant.source.agent },
          grant,
        ),
      )
      this.#update(id, {
        files: published.files,
        bytes: published.bytes,
        manifestSha256: published.manifestSha256,
        exchange: {
          ref: transfer.exchange!.ref,
          commit: published.commit,
          cleaned: false,
        },
        state: 'delivering',
      })
      const result = z
        .object({ path: z.string(), verified: z.literal(true) })
        .parse(
          await this.#send(
            grant.target,
            'files.fetch',
            {
              ...args,
              agent: grant.target.agent,
              commit: published.commit,
              manifestSha256: published.manifestSha256,
            },
            grant,
          ),
        )
      this.#update(id, {
        state: 'done',
        verified: true,
        doneBytes: published.bytes,
        target: { ...transfer.target, path: result.path },
        finishedAt: this.#now(),
      })
    } catch (error) {
      this.#update(id, {
        state: 'failed',
        reason:
          error instanceof FileFault
            ? this.#reason(error.code)
            : '文件传输拒绝或校验失败',
        verified:
          error instanceof FileFault && /digest|tree|branch/.test(error.code)
            ? false
            : null,
        finishedAt: this.#now(),
      })
    } finally {
      this.#cleanupPending.add(id)
      await this.cleanup()
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
      for (const id of [...this.#cleanupPending]) {
        const transfer = this.#book.transfers.find(one => one.transferId === id)
        const grant = this.#book.grants.find(
          one => one.grantId === transfer?.grantId,
        )
        let cleaned = true
        if (grant)
          for (const ref of [grant.source, grant.target]) {
            try {
              await this.#call(
                ref.node,
                'files.abort',
                { transferId: id, operationId: crypto.randomUUID() },
                grant.grantedBy,
              )
            } catch {
              cleaned = false
            }
          }
        if (cleaned) this.#cleanupPending.delete(id)
      }
      // Ref-only enumeration and deletion, including a late push after a timed-out call.
      const credential = await this.#credential()
      const refs = await githubRemoteRefs(
        this.#options.directory,
        credential.remoteUrl,
        ['refs/heads/qianmo/files/*'],
        credential,
      )
      const deleted = new Set<string>()
      for (const [ref, commit] of refs) {
        const id = ref.slice('refs/heads/qianmo/files/'.length)
        if (!idSchema.safeParse(id).success) continue
        const transfer = this.#book.transfers.find(one => one.transferId === id)
        if (
          transfer &&
          transfer.state !== 'done' &&
          transfer.state !== 'failed'
        )
          continue
        if (!transfer && !this.#orphanSince.has(id))
          this.#orphanSince.set(id, this.#now())
        const since =
          transfer?.finishedAt ?? this.#orphanSince.get(id) ?? this.#now()
        if (this.#now() - since < (this.#options.retentionMs ?? 0)) continue
        await deleteGithubRefs(
          this.#options.directory,
          credential.remoteUrl,
          [ref],
          credential,
        )
        this.#trail.append({
          at: this.#now(),
          source: AuditSource.Control,
          kind: 'files.cleaned',
          outcome: 'ok',
          taskId: id,
          detail: { ref, commit },
        })
        deleted.add(ref)
        this.#orphanSince.delete(id)
      }
      for (const transfer of this.#book.transfers) {
        if (
          !transfer.exchange ||
          (transfer.state !== 'done' && transfer.state !== 'failed')
        )
          continue
        const cleaned =
          !refs.has(transfer.exchange.ref) || deleted.has(transfer.exchange.ref)
        if (transfer.exchange.cleaned !== cleaned)
          this.#update(transfer.transferId, {
            exchange: { ...transfer.exchange, cleaned },
          })
      }
    } catch {
      this.#options.onError?.('交换仓库或节点清理暂不可用')
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
