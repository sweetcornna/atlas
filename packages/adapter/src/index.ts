// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `@qianmo/adapter` — the last hop of a cross-node delivery.
 *
 * This commit lands the three pieces the last hop is built out of: the name
 * normalization that keeps the base's two sanitizers from forking a directory,
 * the wrapper object that owns the mailbox entry's top level, and the blob
 * staging area that keeps an oversized payload out of the base mailbox's
 * 64 KiB read/write invariant.
 *
 * The inbound adapter and the `read`-flip observer that use them follow.
 *
 * This package only ever calls *into* the base (rule M-6): nothing in the base
 * calls back, which is what keeps the dependency acyclic.
 */

export {
  BLOB_DIR_SEGMENTS,
  BlobStore,
  blobStoreDir,
  isBlobRef,
  type BlobRef,
  type BlobStoreOptions,
} from './blob.js'

export {
  InvalidTeamNameError,
  MAX_TEAM_NAME_LENGTH,
  RESERVED_DEVICE_NAMES,
  TEAM_NAME_PATTERN,
  assertTeamName,
  isNormalizedTeamName,
  isReservedDeviceName,
  normalizeTeamName,
  type TeamNameRejection,
} from './names.js'

export {
  BASE_RESERVED_MESSAGE_TYPES,
  QIANMO_WRAPPER_TYPE,
  assertWrapperTypeIsNotReserved,
  buildNotice,
  buildWrapper,
  isReservedBaseMessageType,
  serializeWrapper,
  textBytes,
  type QianmoNotice,
  type QianmoWrapper,
} from './wrapper.js'
