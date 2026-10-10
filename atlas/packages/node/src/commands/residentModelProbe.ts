// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The startup diagnostic exercises omp's actual request path, with retries disabled. */
import { createHash, randomUUID } from 'node:crypto'
import {
  configuredProvider,
  currentManagedHash,
  readYaml,
} from '../providers/node.js'
import { providerPaths } from '../providers/store.js'
import type { CompiledProfile } from '../providers/compile.js'
import { probeCall, ProbeExitUnconfirmedError } from './providerCall.js'
export type ResidentModelProbeInputs = {
  provider: string
  model: string
  baseUrl: string
}
export type ResidentModelProbeVerdict =
  | { status: 'skipped' | 'unavailable' | 'unreachable'; detail: string }
  | { status: 'reachable'; httpStatus: number }
  | { status: 'refused'; httpStatus: number; endpoint: string; detail: string }

/** Includes unmanaged native providers and the selected stored credential.
 * Only the digest is retained, in this process; never log the snapshot. */
export function residentModelProbeFingerprint(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        models: readYaml(providerPaths.models()),
        config: readYaml(providerPaths.config()),
        managed: currentManagedHash(),
        selected: configuredProvider(),
      }),
    )
    .digest('hex')
}

/** One live-process validation barrier. A stale or unreaped result never opens it. */
export function createResidentModelProbeGate(options: {
  fingerprint: () => string
  probe: (signal: AbortSignal) => Promise<ResidentModelProbeVerdict>
  onVerdict?: (verdict: ResidentModelProbeVerdict) => void
}): (signal: AbortSignal) => Promise<void> {
  let passed: string | undefined
  let flight: Promise<void> | undefined
  let poisoned: ProbeExitUnconfirmedError | undefined
  const gate = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    if (poisoned) throw poisoned
    if (flight) {
      await flight
      return gate(signal)
    }
    const before = options.fingerprint()
    if (passed === before) return
    passed = undefined
    const operation = (async () => {
      try {
        const verdict = await options.probe(signal)
        signal.throwIfAborted()
        if (before !== options.fingerprint())
          throw new Error(
            'model configuration changed during validation; generation remains unavailable',
          )
        if (
          verdict.status === 'reachable' &&
          verdict.httpStatus >= 200 &&
          verdict.httpStatus < 300
        )
          passed = before
        options.onVerdict?.(verdict)
      } catch (error) {
        if (error instanceof ProbeExitUnconfirmedError) poisoned = error
        throw error
      }
    })()
    flight = operation
    try {
      await operation
    } finally {
      if (flight === operation) flight = undefined
    }
  }
  return gate
}
export function residentModelProbeInputs():
  | ResidentModelProbeInputs
  | undefined {
  const target = configuredProvider()
  return target?.secret
    ? {
        provider: target.provider,
        model: target.modelId,
        baseUrl: target.baseUrl,
      }
    : undefined
}
export async function probeResidentModel(
  target: ResidentModelProbeInputs,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ResidentModelProbeVerdict> {
  const models = readYaml(providerPaths.models()) as CompiledProfile['models']
  const config = readYaml(providerPaths.config()) as CompiledProfile['config']
  const compiled = { models, config } as CompiledProfile
  // A copied pool must carry its primary key because the throwaway root has no agent.db.
  const configured = configuredProvider()
  const provider = models.providers[target.provider]
  if (provider && configured?.secret && !provider.headers?.['X-Api-Key']) {
    provider.apiKey = configured.secret
    provider.auth = 'apiKey'
  }
  const result = await probeCall({
    requestId: randomUUID(),
    baseUrl: target.baseUrl,
    compiled,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
  })
  const httpStatus = result.httpStatus ?? (result.ok ? 200 : 0)
  if ([401, 403, 407].includes(httpStatus)) {
    const url = new URL(target.baseUrl)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return {
      status: 'refused',
      httpStatus,
      endpoint: url.toString(),
      detail: 'model credential rejected',
    }
  }
  if (result.reachable && httpStatus === 0)
    return {
      status: 'unavailable',
      detail: 'native model call produced no HTTP verdict',
    }
  return result.reachable
    ? { status: 'reachable', httpStatus }
    : { status: 'unreachable', detail: 'model endpoint did not answer' }
}
export function warnRefusedModelCredentials(
  verdict: ResidentModelProbeVerdict,
  warn: (message: string) => void = console.error,
): boolean {
  if (verdict.status !== 'refused') return false
  warn(
    `[resident] model endpoint REFUSED its credential: HTTP ${verdict.httpStatus} from ${verdict.endpoint}. Update this node's model service and restart idle omp children.`,
  )
  return true
}
export function warnUnavailableModelCredentialProbe(
  verdict: ResidentModelProbeVerdict,
  warn: (message: string) => void = console.error,
): boolean {
  if (verdict.status !== 'unavailable') return false
  warn(
    '[resident] the startup model-credential check could not run. Run qm provider status with this node QIANMO_CONFIG_DIR; credential acceptance is unknown.',
  )
  return true
}
