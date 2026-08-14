// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { ProtocolErrorCode } from '@qianmo/protocol'

export interface ResidentMailboxMessage {
  readonly from: string
  readonly text: string
  readonly timestamp: string
  readonly read: boolean
  readonly color?: string
  readonly summary?: string
}

export interface DetectedAdmissionRecord {
  readonly kind: 'detected'
  readonly messageId: string
  readonly sessionId: string
  readonly detectedAt: number
  readonly agent: string
  readonly team: string
  readonly readBefore: Readonly<Record<string, number>>
  readonly snapshot: readonly ResidentMailboxMessage[]
  readonly prompt: string
  readonly networkMsgId?: string
}

export interface AdmittedAdmissionRecord {
  readonly kind: 'admitted'
  readonly messageId: string
  readonly at: number
}

export interface ReadAdmissionRecord {
  readonly kind: 'read'
  readonly messageId: string
  readonly at: number
}

export type AdmissionRecord =
  | DetectedAdmissionRecord
  | AdmittedAdmissionRecord
  | ReadAdmissionRecord

export type PendingAdmission = DetectedAdmissionRecord &
  (
    | { readonly phase: 'detected' }
    | { readonly phase: 'admitted'; readonly admittedAt: number }
  )

export interface AdmissionIntegrityIssue {
  readonly line: number
  readonly kind: 'corrupt_line' | 'torn_tail'
}

export interface AdmissionQueryResult {
  readonly pending: readonly PendingAdmission[]
  readonly integrityIssues: readonly AdmissionIntegrityIssue[]
}

export interface AdmissionLedger {
  append(record: AdmissionRecord): void
  query(): AdmissionQueryResult
  compact(): void
  close(): void
}

export interface ResidentMailboxPort {
  readAll(
    agent: string,
    team: string,
  ): Promise<readonly ResidentMailboxMessage[]>
  markRead(
    agent: string,
    team: string,
    snapshot: readonly ResidentMailboxMessage[],
    readBefore: Readonly<Record<string, number>>,
  ): Promise<number>
}

export interface ResidentTurnInput {
  readonly sessionId: string
  readonly messageId: string
  readonly prompt: string
  readonly networkMsgId?: string
  readonly agent?: string
}

export type ResidentTurnResult =
  | { readonly outcome: 'completed'; readonly content: string }
  | {
      readonly outcome: 'failed'
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

export interface ResidentTurnPort {
  isAccepted(input: ResidentTurnInput): Promise<boolean>
  execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult>
}
