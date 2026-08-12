// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `@qianmo/registry` — where agents announce themselves and find each other.
 *
 * Ships an in-process table plus a thin HTTP v0 surface over `Bun.serve`;
 * no third-party dependencies.
 */

export { ManualClock, systemClock, type Clock } from './clock.js'

export {
  AgentStatus,
  DEFAULT_TTL_MS,
  InMemoryRegistry,
  MAX_CAPABILITIES,
  RegistryErrorCode,
  isValidEndpoint,
  isValidPublicKey,
  type AgentRecord,
  type DeclaredStatus,
  type RegisterInput,
  type RegisterResult,
  type RegistryOptions,
} from './registry.js'

export {
  API_PREFIX,
  createRegistryHandler,
  startRegistryServer,
  type RegistryServerHandle,
  type RegistryServerOptions,
} from './http.js'
