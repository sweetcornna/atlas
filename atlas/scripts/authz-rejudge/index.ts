// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readTrail, digestOf, type AuditRecord } from '@qianmo/audit'
import { authzDigest } from '@qianmo/capability'
import {
  residentToolVerdict,
  residentApprovalInput,
  residentActiveTools,
  RESIDENT_INPUT_IDENTITY_ENTRY,
  type ResidentExtensionConfig,
} from '@qianmo/extension/policy'
import { ResidentHardline } from '@qianmo/resident/guard'
import { nativeApproval } from './native.js'

export interface Binding {
  readonly directory: string
  readonly node: string
  readonly config: ResidentExtensionConfig
  readonly stateRoots: readonly string[]
  readonly startsAt?: number
  readonly endsAt?: number
  readonly environment?: {
    readonly home: string
    readonly configDir: string
    readonly qmcodeHome: string
  }
  readonly inputs: Readonly<
    Record<string, { readonly contextId: string; readonly taskId?: string }>
  >
}
export interface ScanOptions {
  readonly root: string
  readonly auditFiles: readonly string[]
  readonly bindings: readonly Binding[]
}
type RecordValue = Record<string, unknown>
interface Entry extends RecordValue {
  id: string
  parentId: string | null
  timestamp: string
}
export interface Finding {
  readonly file: string
  readonly callId?: string
  readonly tool?: string
  readonly category:
    | 'hardline'
    | 'tool-allowlist'
    | 'resident-policy'
    | 'native-policy'
    | 'missing-grant'
    | 'incomplete'
  readonly reason: string
  readonly execution?: 'success' | 'uncertain'
}
export interface RejudgeReport {
  readonly version: 1
  readonly passed: boolean
  readonly evidence: readonly {
    readonly file: string
    readonly sha256: string
  }[]
  readonly coverage: {
    files: number
    sidechains: number
    calls: number
    successful: number
    uncertain: number
    ask: number
    matchedGrants: number
    hardlineEvaluations: number
    allowlistEvaluations: number
  }
  readonly findings: readonly Finding[]
  readonly limits: readonly string[]
}
function inEnvironment<T>(binding: Binding, run: () => T): T {
  if (!binding.environment) return run()
  const names = ['HOME', 'QIANMO_CONFIG_DIR', 'QMCODE_HOME'] as const
  const values = [
    binding.environment.home,
    binding.environment.configDir,
    binding.environment.qmcodeHome,
  ]
  const saved = names.map(name => process.env[name])
  try {
    names.forEach((name, i) => {
      process.env[name] = values[i]
    })
    return run()
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]
      else process.env[name] = saved[i]
    })
  }
}

const LIMITS = [
  'Read-only replay of the current pinned omp approval declarations and resident policy, with no user rules or hooks. This is not historical filesystem reconstruction.',
  'A successful native toolResult is execution evidence. Error or missing results are uncertain, including native pre-execution refusals; tool_execution_start is not proof of execution.',
  'Audit hash chains detect corruption, not a hostile node owner rewriting history. Off-host witness verification and complete acquisition remain separate requirements.',
  'All JSONL files below the supplied root and all branches are inspected. Files outside that root cannot be certified absent. No claim of two production attack rounds is made.',
]
function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined
}
function hash(raw: string) {
  return createHash('sha256').update(raw).digest('hex')
}
function within(path: string, root: string) {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

/** Reject links rather than following them outside the declared evidence scope. */
function filesUnder(root: string, findings: Finding[]): string[] {
  const files: string[] = []
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name)
    if (item.isSymbolicLink()) {
      findings.push({
        file: path,
        category: 'incomplete',
        reason: 'Symbolic link in evidence tree',
      })
      continue
    }
    if (item.isDirectory()) files.push(...filesUnder(path, findings))
    else if (item.isFile() && item.name.endsWith('.jsonl')) files.push(path)
  }
  return files.sort()
}
function entryOf(value: unknown): Entry | undefined {
  const row = object(value)
  return row &&
    typeof row.id === 'string' &&
    (row.parentId === null || typeof row.parentId === 'string') &&
    typeof row.timestamp === 'string'
    ? (row as Entry)
    : undefined
}
function ancestors(entry: Entry, entries: Map<string, Entry>): Entry[] {
  const out: Entry[] = []
  const seen = new Set<string>()
  let next: Entry | undefined = entry
  while (next && !seen.has(next.id)) {
    seen.add(next.id)
    out.push(next)
    next = next.parentId === null ? undefined : entries.get(next.parentId)
  }
  return out
}
function isRecordOf(record: AuditRecord, kind: string, node: string) {
  return (
    record.kind === kind &&
    record.node === node &&
    record.source === 'resident' &&
    record.outcome === 'ok'
  )
}

/** Correlate exact digest + node + context, consuming each grant_used once. */
function matchGrant(
  records: readonly AuditRecord[],
  consumed: Set<string>,
  call: {
    node: string
    agent: string
    contextId: string
    toolName: string
    input: RecordValue
  },
  start: number,
  end: number,
  taskId?: string,
): boolean {
  const digest = authzDigest(call)
  for (const use of records) {
    const d = use.detail
    const key = `${use.node}:${use.seq}:${digestOf(use)}`
    if (
      !isRecordOf(use, 'authz.grant_used', call.node) ||
      !d ||
      consumed.has(key) ||
      d.digest !== digest ||
      d.contextId !== call.contextId ||
      d.tool !== call.toolName ||
      typeof d.requestId !== 'string' ||
      use.at < start ||
      use.at > end ||
      typeof d.expiresAt !== 'number' ||
      d.expiresAt < use.at
    )
      continue
    const requested = records.find(
      r =>
        isRecordOf(r, 'authz.requested', call.node) &&
        r.detail?.requestId === d.requestId &&
        r.detail.digest === digest &&
        r.detail.agent === call.agent &&
        r.detail.contextId === call.contextId &&
        r.detail.tool === call.toolName &&
        r.at <= use.at &&
        (!taskId || r.taskId === taskId),
    )
    if (!requested) continue
    const decision = records.find(
      r =>
        isRecordOf(r, 'authz.decision', call.node) &&
        r.detail?.requestId === d.requestId &&
        r.detail.digest === digest &&
        (r.detail.status === 'allow-once' ||
          (r.detail.status === 'allow-window' &&
            call.toolName !== 'qianmo_memory_write')) &&
        r.detail.approver === d.approver &&
        typeof r.detail.approver === 'string' &&
        r.detail.expiresAt === d.expiresAt &&
        r.at >= requested.at &&
        r.at <= use.at,
    )
    if (
      !decision ||
      decision.detail?.scope !== d.scope ||
      (decision.detail?.status === 'allow-once' &&
        (d.scope !== 'once' ||
          consumed.has(`once:${call.node}:${d.requestId}`))) ||
      (decision.detail?.status === 'allow-window' && d.scope !== 'window') ||
      records.some(
        r =>
          isRecordOf(r, 'authz.revoked', call.node) &&
          r.detail?.requestId === d.requestId &&
          r.at >= decision.at &&
          r.at <= use.at,
      )
    )
      continue
    consumed.add(key)
    if (decision.detail?.status === 'allow-once')
      consumed.add(`once:${call.node}:${d.requestId}`)
    return true
  }
  return false
}

export function rejudge(options: ScanOptions): RejudgeReport {
  const findings: Finding[] = []
  const evidence: { file: string; sha256: string }[] = []
  const coverage = {
    files: 0,
    sidechains: 0,
    calls: 0,
    successful: 0,
    uncertain: 0,
    ask: 0,
    matchedGrants: 0,
    hardlineEvaluations: 0,
    allowlistEvaluations: 0,
  }
  const root = resolve(options.root)
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error('Evidence root must be a real directory')
  const consumed = new Set<string>()
  const audit = new Map<string, AuditRecord>()
  const capture = (file: string) => {
    const raw = readFileSync(file, 'utf8')
    evidence.push({ file, sha256: hash(raw) })
    return raw
  }
  for (const file of new Set(
    options.auditFiles.map(path => realpathSync(path)),
  )) {
    capture(file)
    const trail = readTrail(file)
    if (!trail.present || !trail.intact)
      findings.push({
        file,
        category: 'incomplete',
        reason: `Audit trail missing/corrupt: ${JSON.stringify(trail.issues)}`,
      })
    else
      for (const r of trail.records) {
        const key = `${r.node}:${r.seq}`
        const old = audit.get(key)
        if (old && digestOf(old) !== digestOf(r))
          findings.push({
            file,
            category: 'incomplete',
            reason: `Conflicting audit record ${key}`,
          })
        audit.set(key, r)
      }
  }
  if (options.auditFiles.length === 0)
    findings.push({
      file: root,
      category: 'incomplete',
      reason: 'No node audit trail supplied',
    })
  const records = [...audit.values()]
  const native = new Map<Binding, ReturnType<typeof nativeApproval>>()
  const transcriptFiles = filesUnder(root, findings)
  for (const file of transcriptFiles) {
    coverage.files++
    const bindings = options.bindings.filter(b =>
      within(file, resolve(b.directory)),
    )
    if (bindings.length === 0) {
      findings.push({
        file,
        category: 'incomplete',
        reason: 'Missing or ambiguous immutable launch binding',
      })
      capture(file)
      continue
    }
    const rows: RecordValue[] = []
    for (const [i, line] of capture(file).split('\n').entries()) {
      if (!line.trim()) continue
      try {
        const row = object(JSON.parse(line))
        if (!row) throw new Error()
        rows.push(row)
      } catch {
        findings.push({
          file,
          category: 'incomplete',
          reason: `Invalid JSONL at line ${i + 1}`,
        })
      }
    }
    const headers = rows.filter(row => row.type === 'session')
    if (headers.length !== 1 || typeof headers[0]?.id !== 'string') {
      findings.push({
        file,
        category: 'incomplete',
        reason: 'Missing/ambiguous native session header',
      })
      continue
    }
    const sub =
      typeof headers[0].parentSession === 'string' ||
      rows.some(
        row => row.type === 'session_init' && typeof row.agent === 'string',
      )
    if (sub) coverage.sidechains++
    if (
      typeof headers[0].parentSession === 'string' &&
      transcriptFiles.filter(
        path =>
          basename(path) === basename(headers[0]!.parentSession as string),
      ).length !== 1
    )
      findings.push({
        file,
        category: 'incomplete',
        reason: 'Parent session is missing or ambiguous in acquisition',
      })
    const entries = new Map<string, Entry>()
    const identities = new Map<string, string>()
    for (const row of rows) {
      const entry = entryOf(row)
      if (!entry) {
        if (row.type === 'message' || row.type === 'custom')
          findings.push({
            file,
            category: 'incomplete',
            reason: 'Malformed native message/custom entry',
          })
        continue
      }
      if (entries.has(entry.id))
        findings.push({
          file,
          category: 'incomplete',
          reason: `Duplicate entry id ${entry.id}`,
        })
      entries.set(entry.id, entry)
      if (
        row.type === 'custom' &&
        row.customType === RESIDENT_INPUT_IDENTITY_ENTRY
      ) {
        const data = object(row.data)
        if (
          typeof data?.userEntryId === 'string' &&
          typeof data.messageId === 'string'
        ) {
          if (identities.has(data.userEntryId))
            findings.push({
              file,
              category: 'incomplete',
              reason: 'Ambiguous input identity',
            })
          identities.set(data.userEntryId, data.messageId)
        }
      }
    }
    const seenCalls = new Set<string>()
    const seenCallSlots = new Set<string>()
    const matchedResults = new Set<string>()
    for (const entry of entries.values()) {
      if (entry.parentId !== null && !entries.has(entry.parentId))
        findings.push({
          file,
          category: 'incomplete',
          reason: `Missing parent ${entry.parentId}`,
        })
      const lineage = ancestors(entry, entries)
      if (lineage.at(-1)?.parentId !== null)
        findings.push({
          file,
          category: 'incomplete',
          reason: 'Cyclic or incomplete entry ancestry',
        })
      const message = object(entry.message)
      if (
        entry.type !== 'message' ||
        message?.role !== 'assistant' ||
        !Array.isArray(message.content)
      )
        continue
      for (const value of message.content) {
        const block = object(value)
        if (block?.type !== 'toolCall') continue
        coverage.calls++
        const callId = typeof block.id === 'string' ? block.id : ''
        const tool = typeof block.name === 'string' ? block.name : ''
        const base = { file, callId, tool }
        const slot = `${entry.id}:${callId}`
        if (seenCallSlots.has(slot))
          findings.push({
            ...base,
            category: 'incomplete',
            reason: 'Duplicate native tool call id within one assistant entry',
          })
        seenCalls.add(callId)
        seenCallSlots.add(slot)
        // Streaming tool_call approval can finish before this entry is persisted.
        // The native message timestamp marks the beginning of the response.
        const persistedAt = Date.parse(entry.timestamp)
        const startedAt =
          typeof message.timestamp === 'number' ? message.timestamp : NaN
        const validStart =
          Number.isSafeInteger(startedAt) &&
          startedAt > 0 &&
          Number.isFinite(persistedAt) &&
          startedAt <= persistedAt
        if (!validStart)
          findings.push({
            ...base,
            category: 'incomplete',
            reason: 'Missing or invalid native assistant response timestamp',
          })
        const applicable = bindings.filter(
          b =>
            (b.startsAt ?? -Infinity) <= startedAt &&
            startedAt < (b.endsAt ?? Infinity),
        )
        if (applicable.length !== 1) {
          findings.push({
            ...base,
            category: 'incomplete',
            reason: 'Missing or ambiguous launch posture at call time',
          })
          continue
        }
        const binding = applicable[0]!
        if (
          binding.config.v !== 1 ||
          !isAbsolute(binding.config.workspace) ||
          !binding.node ||
          !binding.config.agent ||
          !Array.isArray(binding.stateRoots)
        )
          throw new Error('Invalid launch binding')
        let resolveNative = native.get(binding)
        if (!resolveNative) {
          resolveNative = inEnvironment(binding, () =>
            nativeApproval(binding.config),
          )
          native.set(binding, resolveNative)
        }
        const user = lineage.find(e => object(e.message)?.role === 'user')
        const identity = user ? identities.get(user.id) : undefined
        const origin = identity ? binding.inputs[identity] : undefined
        if (!origin)
          findings.push({
            ...base,
            category: 'incomplete',
            reason: 'Call has no exact native input/admission identity',
          })
        const raw = object(block.arguments)
        if (!callId || !tool || !raw) {
          findings.push({
            ...base,
            category: 'incomplete',
            reason: 'Malformed native tool call',
          })
          continue
        }
        const results = [...entries.values()].filter(e => {
          const m = object(e.message)
          return (
            e.type === 'message' &&
            m?.role === 'toolResult' &&
            m.toolCallId === callId &&
            m.toolName === tool &&
            ancestors(e, entries).find(a => {
              const owner = object(a.message)
              return (
                owner?.role === 'assistant' &&
                Array.isArray(owner.content) &&
                owner.content.some(value => {
                  const call = object(value)
                  return call?.type === 'toolCall' && call.id === callId
                })
              )
            })?.id === entry.id
          )
        })
        const result = results.length === 1 ? results[0] : undefined
        if (result) matchedResults.add(result.id)
        const resultMessage = object(result?.message)
        const success = result !== undefined && resultMessage?.isError === false
        const execution = success
          ? ('success' as const)
          : ('uncertain' as const)
        if (sub)
          findings.push({
            ...base,
            execution,
            category: 'resident-policy',
            reason:
              'Resident before_subagent_spawn forbids child-agent execution',
          })
        if (success) coverage.successful++
        else {
          coverage.uncertain++
          findings.push({
            ...base,
            execution,
            category: 'incomplete',
            reason:
              'Error, absent, ambiguous, or untyped tool result; execution cannot be excluded',
          })
        }
        let approval: ReturnType<ReturnType<typeof nativeApproval>>
        try {
          approval = inEnvironment(binding, () => resolveNative!(tool, raw))
        } catch {
          findings.push({
            ...base,
            execution,
            category: 'incomplete',
            reason: 'Native approval could not inspect tool arguments',
          })
          continue
        }
        const input = approval.input
        const hardline = new ResidentHardline({
          stateRoots: binding.stateRoots,
          protectedRoots: [
            ...binding.stateRoots,
            ...binding.config.protectedRoots,
          ],
        })
        coverage.hardlineEvaluations++
        coverage.allowlistEvaluations++
        const deny = inEnvironment(binding, () => hardline.verdict(tool, input))
        const verdict = inEnvironment(binding, () =>
          residentToolVerdict({ toolName: tool, input }, binding.config, {
            agentKind: sub ? 'sub' : 'main',
          }),
        )
        const allowed = residentActiveTools(
          binding.config.edits,
          binding.config.hostTools,
        ).includes(tool)
        if (deny)
          findings.push({
            ...base,
            execution,
            category: 'hardline',
            reason: deny.target.reason,
          })
        else if (!allowed)
          findings.push({
            ...base,
            execution,
            category: 'tool-allowlist',
            reason: 'Tool is outside the resident launch allowlist',
          })
        else if (verdict && !verdict.approvalEligible)
          findings.push({
            ...base,
            execution,
            category: 'resident-policy',
            reason: verdict.reason,
          })
        else if (approval.policy === 'deny')
          findings.push({
            ...base,
            execution,
            category: 'native-policy',
            reason: approval.reason ?? 'Native approval denies this call',
          })
        else if (
          verdict?.approvalEligible ||
          approval.policy === 'prompt' ||
          tool === 'qianmo_memory_write'
        ) {
          coverage.ask++
          const grantInput = verdict?.approvalEligible
            ? inEnvironment(binding, () =>
                residentApprovalInput(
                  { toolName: tool, input },
                  binding.config.workspace,
                ),
              )
            : input
          const start = startedAt
          const end = Date.parse(result?.timestamp ?? '')
          if (
            !origin ||
            !validStart ||
            !Number.isFinite(end) ||
            end < persistedAt
          )
            findings.push({
              ...base,
              execution,
              category: 'incomplete',
              reason:
                'Ask call lacks exact admission identity/context or timestamps',
            })
          else if (
            success &&
            matchGrant(
              records,
              consumed,
              {
                node: binding.node,
                agent: binding.config.agent,
                contextId: origin.contextId,
                toolName: tool,
                input: grantInput,
              },
              start,
              end,
              origin.taskId,
            )
          )
            coverage.matchedGrants++
          else
            findings.push({
              ...base,
              execution,
              category: 'missing-grant',
              reason:
                'No unused node grant_used with exact digest, context, live approved request and time interval',
            })
        }
      }
    }
    for (const entry of entries.values()) {
      if (
        object(entry.message)?.role === 'toolResult' &&
        !matchedResults.has(entry.id)
      )
        findings.push({
          file,
          category: 'incomplete',
          reason: `Unassociated native tool result ${entry.id}`,
        })
      if (
        entry.type === 'custom' &&
        entry.customType === 'tool_execution_start'
      ) {
        const callId = object(entry.data)?.toolCallId
        if (typeof callId !== 'string' || !seenCalls.has(callId))
          findings.push({
            file,
            category: 'incomplete',
            reason: 'Execution start has no associated native tool call',
          })
      }
    }
  }
  if (!coverage.files || !coverage.calls || !coverage.successful)
    findings.push({
      file: root,
      category: 'incomplete',
      reason: 'Empty execution coverage cannot pass',
    })
  for (const item of evidence)
    if (hash(readFileSync(item.file, 'utf8')) !== item.sha256)
      findings.push({
        file: item.file,
        category: 'incomplete',
        reason: 'Evidence changed during scan',
      })
  if (
    JSON.stringify(filesUnder(root, findings)) !==
    JSON.stringify(transcriptFiles)
  )
    findings.push({
      file: root,
      category: 'incomplete',
      reason: 'Transcript inventory changed during scan',
    })
  return {
    version: 1,
    passed: findings.length === 0,
    evidence,
    coverage,
    findings,
    limits: LIMITS,
  }
}
