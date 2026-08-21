// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/** Verify a local audit trail against anchors held by the second location. */

import { digestOf, readTrail } from '@qianmo/audit'
import type { WitnessAnchor, WitnessEvidence } from './anchor.js'
import {
  verifyWitnessAnchor,
  witnessAnchorOf,
  witnessReceivedAtOf,
} from './anchor.js'
import { DEFAULT_WITNESS_ANCHOR_INTERVAL_MS } from './sender.js'

/** Design §4.3: after two periods without evidence, raise an alert. */
export const DEFAULT_WITNESS_STALE_AFTER_MS =
  2 * DEFAULT_WITNESS_ANCHOR_INTERVAL_MS

export type WitnessVerificationIssue =
  | { readonly kind: 'bad_signature'; readonly seq: number }
  | {
      readonly kind: 'head_mismatch'
      readonly seq: number
      readonly expected: string
      readonly actual: string | null
    }
  | {
      readonly kind: 'unwitnessed_tail'
      readonly from: number
      readonly to: number
      readonly count: number
    }
  | {
      readonly kind: 'stale'
      readonly ageMs: number | null
      readonly thresholdMs: number
    }

export interface WitnessVerification {
  /** At least one valid, published prefix hash disagrees with the local chain. */
  readonly tampered: boolean
  /** There is no current evidence: no valid anchor, or the latest is too old. */
  readonly stale: boolean
  readonly coveredThrough: number | null
  readonly issues: readonly WitnessVerificationIssue[]
}

export interface VerifyWitnessOptions {
  readonly trailPath: string
  /** Bare anchors remain comparable, but only receipts count as fresh. */
  readonly anchors: readonly WitnessEvidence[]
  readonly publicKey: string
  readonly now?: () => number
  readonly staleAfterMs?: number
}

export interface WitnessStaleness {
  readonly stale: boolean
  readonly ageMs: number | null
  readonly thresholdMs: number
  /** Signatures that passed and therefore count as prefix evidence. */
  readonly validAnchors: readonly WitnessAnchor[]
  readonly issues: readonly Extract<
    WitnessVerificationIssue,
    { readonly kind: 'bad_signature' | 'stale' }
  >[]
}

export interface CheckWitnessStalenessOptions {
  readonly anchors: readonly WitnessEvidence[]
  readonly publicKey: string
  readonly now?: () => number
  readonly staleAfterMs?: number
}

/**
 * The witness-host check from design §4.4: it needs only evidence it stores,
 * so an operator can schedule it without reading a compromised node's disk.
 */
export function checkWitnessStaleness(
  options: CheckWitnessStalenessOptions,
): WitnessStaleness {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_WITNESS_STALE_AFTER_MS
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('witness stale threshold must be a non-negative integer')
  }
  const issues: Array<
    Extract<
      WitnessVerificationIssue,
      { readonly kind: 'bad_signature' | 'stale' }
    >
  > = []
  const validAnchors: WitnessAnchor[] = []
  let latestReceivedAt: number | null = null
  for (const evidence of options.anchors) {
    const anchor = witnessAnchorOf(evidence)
    if (!verifyWitnessAnchor(anchor, options.publicKey)) {
      issues.push({ kind: 'bad_signature', seq: anchor.seq })
      continue
    }
    validAnchors.push(anchor)
    const receivedAt = witnessReceivedAtOf(evidence)
    if (receivedAt !== null) {
      latestReceivedAt = Math.max(latestReceivedAt ?? receivedAt, receivedAt)
    }
  }
  const ageMs =
    latestReceivedAt === null
      ? null
      : Math.max(0, (options.now ?? Date.now)() - latestReceivedAt)
  const stale = ageMs === null || ageMs > staleAfterMs
  if (stale) {
    issues.push({ kind: 'stale', ageMs, thresholdMs: staleAfterMs })
  }
  return { stale, ageMs, thresholdMs: staleAfterMs, validAnchors, issues }
}

/**
 * Verify every signed anchor against the trail at the moment it is read.
 *
 * This is intentionally an on-read action, per design §4.4: the person who
 * consults a chain must receive its trust verdict in the same operation. A
 * scheduled stale check is supplementary and uses {@link checkWitnessStaleness}
 * with only the anchors stored on the witness host.
 */
export function verifyAuditWitness(
  options: VerifyWitnessOptions,
): WitnessVerification {
  const trail = readTrail(options.trailPath)
  const staleness = checkWitnessStaleness(options)
  const issues: WitnessVerificationIssue[] = [...staleness.issues]
  const valid = staleness.validAnchors

  let tampered = false
  let coveredThrough: number | null = null
  for (const anchor of valid) {
    const record = trail.records.at(anchor.seq - 1)
    const actual =
      record === undefined || record.seq !== anchor.seq
        ? null
        : digestOf(record)
    if (actual !== anchor.head) {
      tampered = true
      issues.push({
        kind: 'head_mismatch',
        seq: anchor.seq,
        expected: anchor.head,
        actual,
      })
      continue
    }
    coveredThrough = Math.max(coveredThrough ?? 0, anchor.seq)
  }

  if (!tampered && coveredThrough !== null) {
    const tail = trail.records.slice(coveredThrough)
    if (tail.length > 0) {
      issues.push({
        kind: 'unwitnessed_tail',
        from: tail[0]!.seq,
        to: tail.at(-1)!.seq,
        count: tail.length,
      })
    }
  }
  return { tampered, stale: staleness.stale, coveredThrough, issues }
}

/** Human-readable witness output for a future CLI, console, or alert runner. */
export function formatWitnessVerification(
  verification: WitnessVerification,
): readonly string[] {
  const lines = [
    `witness: tampered=${String(verification.tampered)} stale=${String(verification.stale)}`,
  ]
  for (const issue of verification.issues) {
    if (issue.kind === 'bad_signature') {
      lines.push(`bad_signature: anchor seq ${issue.seq} was ignored`)
    } else if (issue.kind === 'head_mismatch') {
      lines.push(
        `head_mismatch: anchor seq ${issue.seq} expected ${issue.expected}, local ${issue.actual ?? 'missing'}`,
      )
    } else if (issue.kind === 'unwitnessed_tail') {
      lines.push(
        `unwitnessed_tail: seq ${issue.from}..${issue.to} 共 ${issue.count} 条尚未被任何锚点覆盖`,
      )
    } else if (issue.ageMs === null) {
      lines.push('stale: no valid witness anchor is available')
    } else {
      lines.push(
        `stale: last anchor is ${issue.ageMs} ms old, over ${issue.thresholdMs} ms`,
      )
    }
  }
  return lines
}
