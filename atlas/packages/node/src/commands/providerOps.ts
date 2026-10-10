// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sixth action, node side: one request in, one response out (design
 * `providers-console-m1.md` §2.5). {@link handleProviderLine} is everything
 * `qm provider serve-stdin` does between reading stdin and writing stdout.
 *
 * The node does not trust the hub. The line is parsed with the shared schema
 * (`@qianmo/providers`), against this node's name and this node's own
 * capabilities, before anything else happens; `apply` goes through the P18.2
 * write path, which parses it again.
 *
 * ## Ops
 *
 *   - `status`: §2.4. `readProviderState()`, completed from the resident's own
 *     files (`resident/resident.pid`, `resident/lifecycle.json`,
 *     `resident/provider-switch.json`) and the node's capabilities, plus
 *     `effective` computed in a process of its own (`effectiveProcess.ts`).
 *     Not for a node the hub does not manage whose resident started with
 *     provider keys in its environment (`inheritedProviderKeys`): its ACP
 *     child runs on that environment, while `effective` strips it and reads
 *     native model and config YAML alone, so the block would describe a model the child
 *     does not run. It is left out, with a warning line saying why.
 *   - `apply`: `stageProviderApply()`; then, if a resident is running, a
 *     SIGHUP through P18.3's `signalResidentProviderCheck()` (it switches at
 *     the next idle boundary, or at its 5 s poll if the signal is not sent);
 *     if none is, the commit happens here. "Running" errs towards yes — a pid
 *     file or a `running` lifecycle stamp whose pid is alive — because the two
 *     mistakes cost differently: a wrong yes leaves the intent pending until
 *     the next resident start rolls it forward; a wrong no rewrites
 *     native configuration under a live omp child (R-5). Residents older than
 *     P18.3 write no pid file, hence the lifecycle stamp.
 *   - `probe`, `models`: `providerProbe.ts` and `providerCall.ts`.
 *   - `autocompact` (D-9): `qm provider autocompact --json` in a child of its
 *     own (`providerAutocompact.ts`, the base `/autocompact`), its line
 *     wrapped in the envelope. A child because the window is capped by the
 *     model the node's ACP child would run, and finding that out replays its
 *     start-up onto `process.env`, as `effective` does.
 *
 * ## What a response never holds
 *
 * Any key value. Key names, hashes and fingerprints only (§2.5, §7.5); for
 * probes, our own message plus an HTTP status and a filtered vendor code.
 * The few messages that come from elsewhere (a failed settings write) are
 * passed through {@link redact} with every key the request carried.
 */

import { readFileSync } from 'node:fs'
import {
  type ApplyRequest,
  type AutoCompactReport,
  type AutoCompactSource,
  type AutocompactRequest,
  errorResponse,
  type NodeCapabilities,
  type ProbeRequest,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ProviderIssue,
  type ProviderNodeState,
  type ProviderResponse,
  parseProviderRequest,
  type ModelsRequest,
  type WireProfile,
} from '@qianmo/providers'
import { qianmoConfigPath } from '@qianmo/paths'
import { getModelCompatCapabilities } from '../providers/capabilities.js'
import {
  computeEffectiveInChild,
  type EffectiveOutcome,
  runOwnCliChild,
} from '../providers/effectiveProcess.js'
import {
  commitPendingProviderConfig,
  readProviderState,
  stageProviderApply,
} from '../providers/node.js'
import { isProcessAlive, providerPaths } from '../providers/store.js'
import type { CliLaunchSpec } from '../providers/effectiveProcess.js'
import type { AutocompactResult } from './providerAutocompact.js'
import { probeCall } from './providerCall.js'
import {
  appliedTarget,
  listModels,
  type ProbeOutcome,
  probeAuth,
  probeLatency,
  profileTarget,
} from './providerProbe.js'

/**
 * A protocol response, with the probe fields §5.5 adds and, for
 * `autocompact`, the window report (D-9).
 */
export type NodeProviderResponse = ProviderResponse &
  Omit<Partial<ProbeOutcome>, 'ok'> &
  Partial<AutoCompactReport>

export type ProviderContext = {
  /** The node name the forced command was installed with (`--node`). */
  readonly node?: string
  readonly now?: () => Date
  /** One line of diagnostics, never a value; stderr by default. */
  readonly warn?: (line: string) => void
  /** How child processes re-execute this CLI; tests run it from source. */
  readonly launch?: (cliArgs: string[], env: NodeJS.ProcessEnv) => CliLaunchSpec
  /** Replaces the effective child, for tests that do not need one. */
  readonly effective?: (timeoutMs: number) => Promise<EffectiveOutcome>
  /** Replaces the dynamic import of P18.3's signaller, for tests. */
  readonly signalResident?: () => Promise<string>
}

/**
 * Time `status` leaves the effective child out of its 20 s (§2.5): the rest
 * reads a handful of small files.
 */
const EFFECTIVE_TIMEOUT_MS = PROTOCOL_LIMITS.timeoutMs.status - 5_000

function warnLine(ctx: ProviderContext, line: string): void {
  ;(ctx.warn ?? (text => process.stderr.write(`${text}\n`)))(
    `[qm provider] ${line}`,
  )
}

/** Every key value the request carried, replaced by `***`. */
function redact(text: string, profile: WireProfile | undefined): string {
  let out = text
  for (const key of profile?.auth.keys ?? []) {
    if ('value' in key && key.value.length > 0) {
      out = out.split(key.value).join('***')
    }
  }
  return out
}

function failure(
  requestId: string | null,
  code: ProviderIssue['code'],
  message: string,
  extra: { diffKeys?: string[]; state?: ProviderNodeState } = {},
): NodeProviderResponse {
  return errorResponse(requestId, { code, message, path: '' }, extra)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * `qianmoConfigPath('resident', …)` files the resident writes. The names are
 * spelled where the resident writes them too: `lifecycle.json` in
 * `services/qianmo/resident.ts` (the sentinel), `provider-switch.json` as
 * `PROVIDER_SWITCH_FILE` in the same file; a test pins the second.
 */
const residentFiles = {
  lifecycle: () => qianmoConfigPath('resident', 'lifecycle.json'),
  providerSwitch: () => qianmoConfigPath('resident', 'provider-switch.json'),
}

/** The live resident on this config root, if any (see the module header). */
function runningResidentPid(): number | null {
  const pidFile = readJson(providerPaths.residentPid())
  if (typeof pidFile?.pid === 'number' && isProcessAlive(pidFile.pid)) {
    return pidFile.pid
  }
  const lifecycle = readJson(residentFiles.lifecycle())
  if (
    lifecycle?.phase === 'running' &&
    typeof lifecycle.pid === 'number' &&
    isProcessAlive(lifecycle.pid)
  ) {
    return lifecycle.pid
  }
  return null
}

type InFlight = Record<string, unknown>

function count(inFlight: InFlight, keys: readonly string[]): number {
  let sum = 0
  for (const key of keys) {
    const value = inFlight[key]
    if (typeof value === 'number') sum += value
  }
  return sum
}

/** This node's capabilities: the write path's, then the call layer's (P18.5). */
function nodeCapabilities(base: NodeCapabilities): NodeCapabilities {
  return { ...base, ...getModelCompatCapabilities() }
}

/**
 * §2.4 as far as files tell it: `readProviderState()`, with `resident` and
 * `pending.waitingTurns` filled from the resident's own files and the
 * capabilities from the call layer. The resident's in-flight counts are only
 * believed from a `provider-switch.json` written by the resident that is
 * running now.
 */
function currentProviderState(): ProviderNodeState {
  const base = readProviderState()
  const pid = runningResidentPid()
  const generation = readJson(providerPaths.generation())
  const switchStatus =
    pid === null ? null : readJson(residentFiles.providerSwitch())
  const waiting =
    switchStatus !== null &&
    switchStatus.pid === pid &&
    isRecord(switchStatus.waiting) &&
    isRecord(switchStatus.waiting.inFlight)
      ? (switchStatus.waiting as { requestId?: unknown; inFlight: InFlight })
      : null
  const knowsResident =
    base.resident !== null ||
    pid !== null ||
    generation !== null ||
    readJson(residentFiles.lifecycle()) !== null
  return {
    ...base,
    capabilities: nodeCapabilities(base.capabilities),
    resident: knowsResident
      ? {
          running: pid !== null,
          generation:
            typeof generation?.generation === 'number'
              ? generation.generation
              : null,
          inFlight:
            waiting === null
              ? null
              : count(waiting.inFlight, [
                  'turns',
                  'queued',
                  'tasks',
                  'deliveries',
                  'polls',
                  'admissions',
                ]),
        }
      : null,
    pending:
      base.pending === null
        ? null
        : {
            ...base.pending,
            waitingTurns:
              waiting !== null && waiting.requestId === base.pending.requestId
                ? count(waiting.inFlight, ['turns', 'queued'])
                : null,
          },
  }
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

async function status(
  requestId: string,
  ctx: ProviderContext,
): Promise<NodeProviderResponse> {
  const state = currentProviderState()
  if (!state.managed && state.inheritedProviderKeys.length > 0) {
    warnLine(
      ctx,
      `effective not computed: not managed, the resident started with ${state.inheritedProviderKeys.join(', ')} in its environment`,
    )
    return { v: PROTOCOL_VERSION, requestId, ok: true, state }
  }
  const outcome = await (
    ctx.effective ??
    (timeoutMs =>
      computeEffectiveInChild({
        timeoutMs,
        ...(ctx.launch === undefined ? {} : { launch: ctx.launch }),
      }))
  )(EFFECTIVE_TIMEOUT_MS)
  if (!outcome.ok) warnLine(ctx, `effective not computed: ${outcome.reason}`)
  return {
    v: PROTOCOL_VERSION,
    requestId,
    ok: true,
    state,
    ...(outcome.ok ? { effective: outcome.effective } : {}),
  }
}

async function signalResident(ctx: ProviderContext): Promise<void> {
  try {
    const outcome = ctx.signalResident
      ? await ctx.signalResident()
      : await import('./resident.js').then(
          ({ signalResidentProviderCheck }) => {
            const result = signalResidentProviderCheck()
            return result.signalled ? 'signalled' : result.reason
          },
        )
    warnLine(ctx, `resident: ${outcome}`)
  } catch (error) {
    // The resident's 5 s poll finds the intent anyway.
    warnLine(
      ctx,
      `resident not signalled: ${error instanceof Error ? error.name : 'error'}`,
    )
  }
}

async function apply(
  request: ApplyRequest,
  capabilities: NodeCapabilities,
  ctx: ProviderContext,
): Promise<NodeProviderResponse> {
  const now = (ctx.now ?? (() => new Date()))()
  const staged = stageProviderApply(request, {
    capabilities,
    now,
    ...(ctx.node === undefined ? {} : { node: ctx.node }),
  })
  if (!staged.ok) {
    return failure(
      staged.requestId,
      staged.code,
      redact(staged.message, request.profile),
      {
        ...(staged.diffKeys === undefined ? {} : { diffKeys: staged.diffKeys }),
        state: currentProviderState(),
      },
    )
  }
  const done = (): NodeProviderResponse => ({
    v: PROTOCOL_VERSION,
    requestId: staged.requestId,
    ok: true,
    ...(staged.dryRun ? {} : { state: currentProviderState() }),
    diffKeys: staged.diffKeys,
    warnings: staged.warnings,
  })
  if (!staged.pending) return done()

  if (runningResidentPid() !== null) {
    await signalResident(ctx)
    return done()
  }
  const committed = await commitPendingProviderConfig({ now })
  switch (committed.status) {
    case 'committed':
    case 'none':
    case 'busy':
      return done()
    case 'conflict':
      return failure(
        staged.requestId,
        'conflict',
        '提交前发现受管键已被改动 · 本次下发已放弃 · 需要确认覆盖后重发',
        { diffKeys: committed.diffKeys, state: currentProviderState() },
      )
    case 'refused':
      return failure(staged.requestId, 'write-failed', committed.message, {
        state: currentProviderState(),
      })
    case 'write-failed':
      return failure(
        staged.requestId,
        'write-failed',
        `写入 omp 配置失败 · ${redact(committed.message, request.profile)}`,
        { state: currentProviderState() },
      )
    case 'bad-pending':
      return failure(
        staged.requestId,
        'write-failed',
        'pending 意图无法解析 · 已改名保留 · 需要重发',
        { state: currentProviderState() },
      )
  }
}

function probeResponse(
  requestId: string,
  outcome: ProbeOutcome,
): NodeProviderResponse {
  const { ok, ...rest } = outcome
  return ok
    ? { v: PROTOCOL_VERSION, requestId, ok: true, ...rest }
    : {
        v: PROTOCOL_VERSION,
        requestId,
        ok: false,
        code: 'probe-failed',
        ...rest,
      }
}

async function probe(
  request: ProbeRequest,
  capabilities: NodeCapabilities,
  ctx: ProviderContext,
): Promise<NodeProviderResponse> {
  const resolved = profileTarget(request.profile, capabilities)
  if (!resolved.ok) return errorResponse(request.requestId, resolved.issue)
  const { target, compiled } = resolved
  const limits = PROTOCOL_LIMITS.timeoutMs
  switch (request.probe.mode) {
    case 'auth':
      return probeResponse(
        request.requestId,
        await probeAuth(target, limits.probeAuth),
      )
    case 'latency':
      return probeResponse(
        request.requestId,
        await probeLatency(target, limits.probeLatency),
      )
    case 'call':
      return probeResponse(
        request.requestId,
        await probeCall({
          requestId: request.requestId,
          baseUrl: target.baseUrl,
          compiled,
          timeoutMs: limits.probeCall,
          ...(ctx.launch === undefined ? {} : { launch: ctx.launch }),
        }),
      )
  }
}

async function models(
  request: ModelsRequest,
  capabilities: NodeCapabilities,
): Promise<NodeProviderResponse> {
  if (request.profile === undefined && !readProviderState().managed) {
    return failure(
      request.requestId,
      'bad-request',
      '节点没有托管配置 · 拉模型列表要带 profile',
    )
  }
  const resolved =
    request.profile === undefined
      ? appliedTarget()
      : profileTarget(request.profile, capabilities)
  if (!resolved.ok) return errorResponse(request.requestId, resolved.issue)
  return probeResponse(
    request.requestId,
    await listModels(resolved.target, PROTOCOL_LIMITS.timeoutMs.models),
  )
}

/** Time `autocompact` leaves its child out of the op's 20 s. */
const AUTOCOMPACT_CHILD_TIMEOUT_MS =
  PROTOCOL_LIMITS.timeoutMs.autocompact - 5_000

type AutocompactRefusal = Extract<AutocompactResult, { ok: false }>['code']

function isAutocompactRefusal(value: unknown): value is AutocompactRefusal {
  return (
    value === 'bad-value' ||
    value === 'env-override' ||
    value === 'write-failed'
  )
}

function isAutoCompactSource(value: unknown): value is AutoCompactSource {
  return value === 'env' || value === 'settings' || value === 'auto'
}

/** The child's `--json` line, if it is one. */
function autocompactLine(stdout: string): AutocompactResult | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find(text => text.startsWith('{'))
  if (line === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { ok, code, autoCompactWindow, configured, source, message } = parsed
  if (
    typeof autoCompactWindow !== 'number' ||
    typeof configured !== 'number' ||
    !isAutoCompactSource(source)
  ) {
    return null
  }
  const report = { autoCompactWindow, configured, source }
  if (ok === true) {
    return typeof message === 'string'
      ? { ok, ...report, message }
      : { ok, ...report }
  }
  return ok === false &&
    isAutocompactRefusal(code) &&
    typeof message === 'string'
    ? { ok, code, ...report, message }
    : null
}

async function autocompact(
  request: AutocompactRequest,
  ctx: ProviderContext,
): Promise<NodeProviderResponse> {
  const run = await runOwnCliChild(
    [
      'provider',
      'autocompact',
      ...(request.value === undefined ? [] : [String(request.value)]),
      '--json',
    ],
    {
      timeoutMs: AUTOCOMPACT_CHILD_TIMEOUT_MS,
      ...(ctx.launch === undefined ? {} : { launch: ctx.launch }),
    },
  )
  const result = run.kind === 'exited' ? autocompactLine(run.stdout) : null
  if (result === null) {
    warnLine(
      ctx,
      `autocompact child: ${run.kind === 'exited' ? 'no-result' : run.kind}`,
    )
    return failure(
      request.requestId,
      'write-failed',
      request.value === undefined
        ? '节点没能读出自动压缩阈值'
        : '节点没能执行自动压缩阈值的设置 · 是否已写入未知 · 先读一次再重试',
    )
  }
  return { v: PROTOCOL_VERSION, requestId: request.requestId, ...result }
}

/**
 * One request line → one response. Never throws for anything a request can
 * cause; an exception out of here is a fault of the node (unreadable files,
 * a broken install) and the caller reports it without a response.
 */
export async function handleProviderLine(
  line: string,
  ctx: ProviderContext = {},
): Promise<NodeProviderResponse> {
  const now = (ctx.now ?? (() => new Date()))()
  const capabilities = nodeCapabilities(readProviderState().capabilities)
  const parsed = parseProviderRequest(line, {
    capabilities,
    now,
    ...(ctx.node === undefined ? {} : { node: ctx.node }),
  })
  if (!parsed.ok) return errorResponse(parsed.requestId, parsed.error)
  const { request } = parsed
  switch (request.op) {
    case 'status':
      return status(request.requestId, ctx)
    case 'apply':
      return apply(request, capabilities, ctx)
    case 'probe':
      return probe(request, capabilities, ctx)
    case 'models':
      return models(request, capabilities)
    case 'autocompact':
      return autocompact(request, ctx)
  }
}
