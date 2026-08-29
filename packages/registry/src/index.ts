// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `@qianmo/registry` — where agents announce themselves and find each other.
 *
 * Ships an in-process table, an optional crash-safe file backing so the table
 * survives a restart, and a thin HTTP v0 surface over `Bun.serve`; no
 * third-party dependencies.
 */

export { ManualClock, systemClock, type Clock } from './clock.js'

export {
  AgentStatus,
  DEFAULT_TTL_MS,
  InMemoryRegistry,
  MAX_CAPABILITIES,
  MAX_CERTIFICATE_LENGTH,
  REGISTRY_SNAPSHOT_VERSION,
  RegistryErrorCode,
  isSignedRevocationListShape,
  isValidEndpoint,
  isValidPublicKey,
  type AgentRecord,
  type DeclaredStatus,
  type RegisterInput,
  type RegisterResult,
  type RegistryAuditEvent,
  type RegistryAuditSink,
  type RegistryOptions,
} from './registry.js'

export {
  FileRegistryStore,
  defaultRegistryStatePath,
  type RegistryStore,
} from './store.js'

export {
  API_PREFIX,
  createRegistryHandler,
  startRegistryServer,
  type RegistryServerHandle,
  type RegistryServerOptions,
} from './http.js'
