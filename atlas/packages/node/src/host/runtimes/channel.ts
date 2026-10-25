// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OmpRpcChannel } from '@qianmo/resident'
import { RUNTIME_CATALOG } from './catalog.js'

/**
 * A runtime a resident agent can run on besides qianmopi: a catalog id
 * (`catalog.ts`) whose protocol is not `omp`.
 */
export type ExternalRuntimeKind = string

/** The external catalog ids, catalog order. */
export const EXTERNAL_RUNTIME_KINDS: readonly ExternalRuntimeKind[] =
  RUNTIME_CATALOG.filter(spec => spec.protocol !== 'omp').map(spec => spec.id)

export function isExternalRuntimeKind(
  value: unknown,
): value is ExternalRuntimeKind {
  return (
    typeof value === 'string' &&
    RUNTIME_CATALOG.some(spec => spec.id === value && spec.protocol !== 'omp')
  )
}

/** What the resident host needs from one live external runtime process. */
export interface ExternalRuntimeChannel extends OmpRpcChannel {
  readonly alive: boolean
  readonly readyRuntimeMs: number
  /** True while a turn of ours is between admission and its `prompt_result`. */
  readonly busy: boolean
  initialize(): Promise<void>
  /** External runtimes have no qianmopi model router; always nothing. */
  prepareRoute(input: {
    text: string
    hint?: unknown
    localCommand?: string
  }): Promise<undefined>
  stop(terminateImmediately?: boolean): Promise<void>
}
