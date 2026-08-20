// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/** `@qianmo/witness` — off-host, append-only audit-chain prefix proofs. */

export {
  WITNESS_ANCHOR_VERSION,
  canonicalizeWitnessAnchor,
  isWitnessAnchor,
  signWitnessAnchor,
  verifyWitnessAnchor,
  type UnsignedWitnessAnchor,
  type WitnessAnchor,
} from './anchor.js'

export {
  DEFAULT_WITNESS_ANCHOR_INTERVAL_MS,
  AuditWitnessScheduler,
  type AuditWitnessSchedulerOptions,
  type WitnessAnchorWriter,
} from './sender.js'

export {
  FileWitnessAnchorStore,
  WitnessAnchorExistsError,
  type FileWitnessAnchorStoreOptions,
} from './store.js'

export {
  ALLOWED_METHODS,
  DESTRUCTIVE_WORDS,
  WITNESS_SURFACE,
  WitnessOp,
  assertWitnessSurfaceIsSafe,
  remoteWitnessAnchorReader,
  remoteWitnessAnchorWriter,
  startWitnessService,
  type RemoteWitnessAnchorReaderOptions,
  type RemoteWitnessAnchorWriterOptions,
  type WitnessAudience,
  type WitnessRoute,
  type WitnessServiceHandle,
  type WitnessServiceOptions,
} from './service.js'

export {
  DEFAULT_WITNESS_STALE_AFTER_MS,
  checkWitnessStaleness,
  formatWitnessVerification,
  verifyAuditWitness,
  type CheckWitnessStalenessOptions,
  type VerifyWitnessOptions,
  type WitnessStaleness,
  type WitnessVerification,
  type WitnessVerificationIssue,
} from './verify.js'
