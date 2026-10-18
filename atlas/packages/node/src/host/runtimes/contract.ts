// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Wire shapes of the runtime control operations (P36, `harness-backends.md`
 * §2–§4), shared by the node (`runtimeUpdate.ts`, `runtimeConfig.ts`) and the
 * hub (`consoleMagpie*.ts`, `consoleUpdates.ts`). Every op is a signed control
 * message; the side-effecting ones (`runtime.install`, `runtime.remove`,
 * `runtime.update`, `runtime.configure`) go through the node's idempotency
 * ledger and are refused under emergency stop.
 */

import type { RuntimeLane } from './catalog.js'

/** Node capability bit: the node answers every op in this file. */
export const RUNTIME_CATALOG_CAPABILITY = 'runtimeCatalog'

export const RUNTIME_OPS = {
  versions: 'runtime.versions',
  install: 'runtime.install',
  remove: 'runtime.remove',
  update: 'runtime.update',
  status: 'runtime.status',
  configure: 'runtime.configure',
} as const

/** `runtime.versions` → one row per catalog entry. */
export interface RuntimeVersionRow {
  readonly id: string
  readonly label: string
  readonly installed: boolean
  /** What a new child would start; absent when not installed. */
  readonly version?: string
  readonly source?: 'builtin' | 'prefix' | 'path' | 'flag'
  /** The version this build installs by default. */
  readonly pin?: string
  readonly installing: boolean
  readonly lastInstall?: {
    readonly at: number
    readonly ok: boolean
    readonly version?: string
    /** Short, secret-free; only operators see it. */
    readonly error?: string
  }
  readonly verified: boolean
}

export interface RuntimeVersionsReply {
  readonly defaultRuntime: string
  readonly runtimes: readonly RuntimeVersionRow[]
}

/** `runtime.install` / `runtime.update`. */
export interface RuntimeInstallRequest {
  readonly runtime: string
  /** Exact version; absent installs the catalog pin. */
  readonly version?: string
}

/** `runtime.remove`; refused (`E_RUNTIME_IN_USE`) while an agent is configured on it. */
export interface RuntimeRemoveRequest {
  readonly runtime: string
}

/** Why an agent is not on its configured runtime (§3.3). */
export type RuntimeFallbackCode =
  | 'not-installed'
  | 'installing'
  | 'install-failed'
  | 'smoke-failed'
  | 'no-model'
  | 'no-node'

export interface AgentRuntimeState {
  readonly agent: string
  readonly configured: {
    readonly runtime: string
    /** `<profile>/<model>`, `auto`, or `null` (not set anywhere). */
    readonly model: string | null
    /** Where `runtime` came from (§3.1). */
    readonly source: 'config' | 'flag' | 'default'
  }
  readonly effective: {
    readonly runtime: string
    readonly model?: string
    readonly lane?: RuntimeLane
  }
  readonly reason?: {
    readonly code: RuntimeFallbackCode
    readonly message: string
  }
}

/** `runtime.status`. */
export interface RuntimeStatusReply {
  readonly defaultRuntime: string
  readonly agents: readonly AgentRuntimeState[]
}

/**
 * `runtime.configure`: omitted fields stay as they are; `runtime: null` and
 * `model: null` clear the config entry so the flag or default applies again.
 * Answers the agent's new {@link AgentRuntimeState}.
 */
export interface RuntimeConfigureRequest {
  readonly agent: string
  readonly runtime?: string | null
  /** `<profile>/<model>`, `auto`, or `null`. */
  readonly model?: string | null
}

/** Refusal codes the ops answer with (besides the control link's own). */
export const RUNTIME_ERRORS = {
  unknownRuntime: 'E_RUNTIME_UNKNOWN',
  unknownAgent: 'E_AGENT_UNKNOWN',
  inUse: 'E_RUNTIME_IN_USE',
  builtin: 'E_RUNTIME_BUILTIN',
  badModel: 'E_RUNTIME_MODEL',
  busy: 'E_RUNTIME_BUSY',
  installFailed: 'E_RUNTIME_INSTALL',
} as const

/** P36.7 (`harness-backends.md` §7.3): native extension operations. */
export const RUNTIME_EXT_OPS = {
  list: 'runtime.ext.list',
  install: 'runtime.ext.install',
  remove: 'runtime.ext.remove',
} as const

export type NativeExtensionKind = 'plugin' | 'mcp' | 'skill'

/** One natively installed item, as the harness's own list reports it. */
export interface NativeExtensionRow {
  readonly kind: NativeExtensionKind
  /** The harness's own name/id for it (e.g. `name@marketplace`). */
  readonly name: string
  readonly version?: string
  readonly enabled: boolean
  /** Where it came from, when the harness records it (repo, npm, path). */
  readonly source?: string
  /**
   * The resident runtime does not load it, and why (e.g. opencode plugins
   * under `--pure`); absent = loaded.
   */
  readonly notLoaded?: string
}

export interface NativeExtensionsReply {
  readonly agent: string
  readonly runtime: string
  readonly items: readonly NativeExtensionRow[]
  /** Pin-layer facts the console shows (e.g. 「已撤销预授权」, project files still loaded). */
  readonly notes: readonly string[]
  /** The node command that opens this agent's official frontend (§7.2). */
  readonly openCommand: string
}

/**
 * An install or removal that went through when listing again afterwards did
 * not: no `items`, so the console reads the list itself and shows `notes`
 * (the change's own) with it.
 */
export interface NativeExtensionsChanged {
  readonly agent: string
  readonly runtime: string
  readonly changed: true
  readonly notes: readonly string[]
  /** Why listing again failed. */
  readonly listError: string
}

/** `runtime.ext.list`. */
export interface NativeExtensionsListRequest {
  readonly agent: string
}

/**
 * `runtime.ext.install`: `source` is a GitHub repo (`owner/repo[#ref]` or an
 * https github.com URL), an npm package name (`[@scope/]name[@exact]`), or the
 * harness's own marketplace name (`name@marketplace`); for `mcp`, a stdio
 * command line (`command` + `args`, env names only — values are connectors'
 * business) or an https URL.
 */
export interface NativeExtensionInstallRequest {
  readonly agent: string
  readonly kind: NativeExtensionKind
  readonly source: string
  readonly name?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
}

/** `runtime.ext.remove`. */
export interface NativeExtensionRemoveRequest {
  readonly agent: string
  readonly kind: NativeExtensionKind
  readonly name: string
}

export const RUNTIME_EXT_ERRORS = {
  unsupported: 'E_RUNTIME_EXT_UNSUPPORTED',
  badSource: 'E_RUNTIME_EXT_SOURCE',
  failed: 'E_RUNTIME_EXT_FAILED',
  /** The agent's official frontend is open (§7.2 lock). */
  locked: 'E_RUNTIME_EXT_LOCKED',
} as const
