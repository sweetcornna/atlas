// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canonicalJson } from '@qianmo/capability'
import {
  MEMORY_KINDS,
  type MemoryDraft,
  type MemoryEntryView,
  type MemoryKind,
} from '@qianmo/console'
import { FileMemoryStore, isRecallable, type MemoryEntry } from '@qianmo/memory'
import { LIMITS, isValidSegment, type ControlOutcome } from '@qianmo/protocol'
import {
  resolveMemoryPartition,
  requireMemoryPartition,
  validMemoryOwner,
  MemoryPartitionError,
} from '@qianmo/resident'
import type { ControlContext, ControlRegistry } from './control.js'

interface MemoryControlOptions {
  readonly node: string
  readonly agents: readonly string[]
  readonly root: string
  readonly ledgerPath: string
  readonly estop: { engaged(): boolean }
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}
interface OperationRow {
  digest: string
  at: number
  result: string | null
}
const fail = (code: string, message: string): ControlOutcome => ({
  ok: false,
  code,
  message,
})
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function kindOf(entry: MemoryEntry): MemoryKind | null {
  return MEMORY_KINDS.find(kind => entry.tags.includes(`kind:${kind}`)) ?? null
}

function view(
  entry: MemoryEntry,
  node: string,
  agent: string,
  owner: string,
  store: FileMemoryStore,
): MemoryEntryView {
  // The store retains the complete array; the port shows the most recent predecessor.
  const previous = [...(entry.supersedes ?? [])]
    .map(id => store.getEntry(id))
    .filter((one): one is MemoryEntry => one !== null)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    )
  return {
    node,
    agent,
    owner,
    id: entry.id,
    scope: 'long',
    contextId: null,
    kind: kindOf(entry),
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: entry.tags,
    source: entry.source,
    createdAt: Date.parse(entry.createdAt),
    validAt: Date.parse(entry.validAt),
    invalidAt: entry.invalidAt === null ? null : Date.parse(entry.invalidAt),
    retired: entry.retirement,
    supersedes: previous[0]?.id ?? null,
    supersededBy: entry.supersededBy ?? null,
  }
}

function draftOf(value: unknown): MemoryDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const draft = value as Record<string, unknown>
  if (
    Object.keys(draft).some(
      key => !['kind', 'title', 'summary', 'body'].includes(key),
    ) ||
    !MEMORY_KINDS.includes(draft.kind as MemoryKind) ||
    typeof draft.title !== 'string' ||
    !draft.title.trim() ||
    draft.title.length > 120 ||
    /[\r\n]/.test(draft.title) ||
    typeof draft.summary !== 'string' ||
    !draft.summary.trim() ||
    draft.summary.length > 400 ||
    /[\r\n]/.test(draft.summary) ||
    typeof draft.body !== 'string' ||
    draft.body.length > 4000
  )
    return null
  return {
    kind: draft.kind as MemoryKind,
    title: draft.title,
    summary: draft.summary,
    body: draft.body,
  }
}

/** A durable intent precedes filesystem effects. Fixed ids/times make interrupted effects recoverable. */
export class MemoryControl {
  readonly #options: MemoryControlOptions
  constructor(options: MemoryControlOptions) {
    this.#options = options
  }

  register(registry: ControlRegistry): void {
    registry.register('memory', (op, args, ctx) => this.handle(op, args, ctx))
  }

  #fits(value: ControlOutcome, ctx: ControlContext): boolean {
    // Production supplies the exact final envelope projection, including its hop.
    return (
      ctx.resultFits?.(value) ??
      Buffer.byteLength(JSON.stringify(value), 'utf8') <=
        LIMITS.maxMessageBytes - 4096
    )
  }

  async handle(
    op: string,
    args: Record<string, unknown>,
    ctx: ControlContext,
  ): Promise<ControlOutcome> {
    if (op === 'memory.agents') {
      const agents = this.#options.agents.map(agent => ({
        node: this.#options.node,
        agent,
        reachable: true,
      }))
      const offset = args.offset ?? 0,
        limit = args.limit ?? 60
      if (
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 200
      )
        return fail('invalid', '分页无效')
      const page = agents.slice(Number(offset), Number(offset) + Number(limit))
      while (
        page.length &&
        !this.#fits(
          {
            ok: true,
            value: {
              agents: page,
              total: agents.length,
              nextOffset:
                Number(offset) + page.length < agents.length
                  ? Number(offset) + page.length
                  : null,
            },
          },
          ctx,
        )
      )
        page.pop()
      if (page.length === 0 && Number(offset) < agents.length)
        return fail('invalid', '记忆名册条目超过信封字节上限')
      return {
        ok: true,
        value: {
          agents: page,
          total: agents.length,
          nextOffset:
            Number(offset) + page.length < agents.length
              ? Number(offset) + page.length
              : null,
        },
      }
    }
    if (
      ![
        'memory.list',
        'memory.add',
        'memory.edit',
        'memory.forget',
        'memory.invalidate',
      ].includes(op)
    )
      return fail('unsupported', '不支持此记忆操作')
    if (
      !validMemoryOwner(ctx.actor) ||
      (args.owner !== undefined && args.owner !== ctx.actor)
    )
      return fail('not_found', '记忆不存在')
    const agent = args.agent
    if (
      typeof agent !== 'string' ||
      !isValidSegment(agent) ||
      !this.#options.agents.includes(agent)
    )
      return fail('not_found', '智能体不存在')
    const target = { scope: 'long' as const, agent, owner: ctx.actor }
    if (op === 'memory.list') {
      if (
        (args.scope !== undefined &&
          !['long', 'all', 'conversation'].includes(String(args.scope))) ||
        (args.kind !== undefined &&
          !MEMORY_KINDS.includes(args.kind as MemoryKind)) ||
        (args.text !== undefined &&
          (typeof args.text !== 'string' || args.text.length > 200)) ||
        (args.includeRetired !== undefined &&
          typeof args.includeRetired !== 'boolean')
      )
        return fail('invalid', '记忆筛选参数无效')
      const offset = args.offset ?? 0,
        limit = args.limit ?? 60
      if (
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 200
      )
        return fail('invalid', '分页无效')
      const store = new FileMemoryStore({
        root: this.#options.root,
        readOnly: true,
      })
      const scope = resolveMemoryPartition(target)
      const own = store.query({
        layers: ['working'],
        projectKey: scope.projectKey,
        taskId: scope.taskId,
        includeRetired: true,
      })
      const at = new Date((this.#options.now ?? Date.now)()).toISOString()
      const live = (entry: MemoryEntry) =>
        isRecallable(entry, at) && entry.supersededBy === undefined
      const counts = Object.fromEntries(
        MEMORY_KINDS.map(kind => [
          kind,
          own.filter(entry => live(entry) && kindOf(entry) === kind).length,
        ]),
      ) as Record<MemoryKind, number>
      // No console-owned session directory index exists: fail closed rather than expose another person's conversations.
      const text = String(args.text ?? '').toLowerCase()
      const matched = (args.scope === 'conversation' ? [] : own)
        .filter(entry => args.includeRetired === true || live(entry))
        .filter(entry => args.kind === undefined || kindOf(entry) === args.kind)
        .filter(entry =>
          `${entry.title} ${entry.summary} ${entry.body}`
            .toLowerCase()
            .includes(text),
        )
      const entries = matched
        .slice(Number(offset), Number(offset) + Number(limit))
        .map(entry => view(entry, this.#options.node, agent, ctx.actor, store))
      const result = (): ControlOutcome => ({
        ok: true,
        value: {
          entries,
          total: matched.length,
          counts,
          nextOffset:
            Number(offset) + entries.length < matched.length
              ? Number(offset) + entries.length
              : null,
        },
      })
      while (entries.length && !this.#fits(result(), ctx)) entries.pop()
      if (entries.length === 0 && Number(offset) < matched.length)
        return fail('invalid', '记忆条目超过信封字节上限')
      return result()
    }
    const draft =
      op === 'memory.add' || op === 'memory.edit' ? draftOf(args.draft) : null
    if ((op === 'memory.add' || op === 'memory.edit') && draft === null)
      return fail('invalid', '记忆内容无效')
    if (
      op !== 'memory.add' &&
      (typeof args.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.id))
    )
      return fail('not_found', '记忆不存在')
    if (
      op === 'memory.forget' &&
      (typeof args.reason !== 'string' ||
        !args.reason.trim() ||
        args.reason.length > 200)
    )
      return fail('invalid', '忘记原因无效')
    const operationId = args.operationId
    if (typeof operationId !== 'string' || !UUID.test(operationId))
      return fail('invalid', '记忆写操作需要 operationId')
    const digest = createHash('sha256')
      .update(canonicalJson({ op, args, actor: ctx.actor, peer: ctx.peer }))
      .digest('hex')
    fs.mkdirSync(path.dirname(this.#options.ledgerPath), {
      recursive: true,
      mode: 0o700,
    })
    const fd = fs.openSync(
      this.#options.ledgerPath,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600,
    )
    try {
      const stat = fs.fstatSync(fd)
      if (
        !stat.isFile() ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        throw new Error('memory operations ledger must be owner-only')
    } finally {
      fs.closeSync(fd)
    }
    const db = new Database(this.#options.ledgerPath)
    try {
      db.exec(
        'PRAGMA busy_timeout = 2000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, at INTEGER NOT NULL, result TEXT)',
      )
      db.exec('BEGIN IMMEDIATE')
      const read = () =>
        db
          .query<OperationRow, [string]>(
            'SELECT digest, at, result FROM operations WHERE id = ?',
          )
          .get(operationId)
      let row = read()
      if (row && row.digest !== digest) {
        db.exec('COMMIT')
        return fail('rejected', 'operationId 已用于不同参数')
      }
      if (row?.result) {
        db.exec('COMMIT')
        return JSON.parse(row.result) as ControlOutcome
      }
      if (!row) {
        db.query('INSERT INTO operations VALUES (?, ?, ?, NULL)').run(
          operationId,
          digest,
          (this.#options.now ?? Date.now)(),
        )
        row = read()!
      }
      db.exec('COMMIT; BEGIN IMMEDIATE')
      // Another process can finish between transactions; always read back under the lock.
      row = read()!
      if (row.result) {
        db.exec('COMMIT')
        return JSON.parse(row.result) as ControlOutcome
      }
      const id = `qm-mem-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`
      const store = new FileMemoryStore({
        root: this.#options.root,
        readOnly: true,
      })
      let result: ControlOutcome
      let existing: MemoryEntry | null = null
      try {
        existing =
          op === 'memory.add'
            ? store.getEntry(id)
            : requireMemoryPartition(store, target, String(args.id))
      } catch (error) {
        if (!(error instanceof MemoryPartitionError)) throw error
        result = fail('not_found', '记忆不存在')
        db.query('UPDATE operations SET result = ? WHERE id = ?').run(
          JSON.stringify(result),
          operationId,
        )
        db.exec('COMMIT')
        return result
      }
      const made =
        op === 'memory.edit'
          ? store.getEntry(id)
          : op === 'memory.add'
            ? existing
            : null
      const iso = new Date(row.at).toISOString()
      const recovered =
        made ??
        (op === 'memory.forget' &&
        existing?.expiredAt === iso &&
        existing.retirement?.by === ctx.actor &&
        existing.retirement.reason === args.reason
          ? existing
          : op === 'memory.invalidate' && existing?.invalidAt === iso
            ? existing
            : null)
      if (recovered) {
        const checked = requireMemoryPartition(store, target, recovered.id)
        const repaired =
          op === 'memory.edit'
            ? new FileMemoryStore({ root: this.#options.root })
            : store
        result = {
          ok: true,
          value: view(checked, this.#options.node, agent, ctx.actor, repaired),
        }
      } else if (
        (op === 'memory.add' || op === 'memory.edit') &&
        this.#options.estop.engaged()
      )
        result = fail('refused', '节点已急停，禁止新增或修改记忆')
      else {
        try {
          const writable = new FileMemoryStore({
            root: this.#options.root,
            now: () => new Date(row!.at),
            newId: () => id,
          })
          const entry = draft
            ? writable.write(
                {
                  scope: resolveMemoryPartition(target),
                  ...draft,
                  tags: [`kind:${draft.kind}`],
                  source: { kind: 'user', id: `user:console:${ctx.actor}` },
                  ...(op === 'memory.edit'
                    ? { supersedes: [String(args.id)] }
                    : {}),
                },
                'operator',
              )
            : op === 'memory.forget'
              ? writable.revoke(String(args.id), {
                  reason: String(args.reason),
                  by: ctx.actor,
                })
              : writable.invalidate(String(args.id), new Date(row.at))
          result = {
            ok: true,
            value: view(entry, this.#options.node, agent, ctx.actor, writable),
          }
        } catch (error) {
          this.#options.onError?.(error)
          // If the intent file exists, recovery must finish the multi-file effect before replying.
          if (
            (op === 'memory.add' || op === 'memory.edit') &&
            store.getEntry(id)
          )
            throw error
          result = fail('refused', '记忆状态不允许此操作')
        }
      }
      db.query('UPDATE operations SET result = ? WHERE id = ?').run(
        JSON.stringify(result),
        operationId,
      )
      db.exec('COMMIT')
      return result
    } catch (error) {
      this.#options.onError?.(error)
      return fail(
        'unreachable',
        '记忆操作结果未知；请使用相同 operationId 重试',
      )
    } finally {
      db.close()
    }
  }
}
