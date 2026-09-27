// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer-layer executor (`docs/dev/memory-m1.md` §4, D-1 A0–A6; P16.3).
 *
 * For every corpus tier it writes the corpus into a real store, runs each
 * arm's retrieval once per question, and renders the system prompt the AC-4
 * leg would send. Then it works through the paired schedule: per call, a
 * reservation in the token ledger, one request through the transport, the
 * verdict from `handleMemoryAnswer`, and — when the citations were rejected —
 * one more round with the rejection fed back.
 *
 * WHAT STOPS A RUN
 *
 *   capped    a reservation did not fit (`TokenCapReached`): no new call is
 *             started; calls already in flight finish and are kept.
 *   invalid   an `unreadable` citation (D-2): the report is written with that
 *             status and the error is rethrown.
 *   aborted   too many consecutive transport failures, or an unexpected
 *             error (rethrown after the report is written).
 *
 * Every completed call is appended to `calls.ndjson` before the next starts,
 * and the report is written on every exit, so what was paid for is kept.
 * Rerunning with the same run id and output directory skips the calls that
 * are already in the log.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRecallSystemPrompt } from '../../src/inject.js'
import { recall, type RecallResult } from '../../src/recall.js'
import {
  CORPORA,
  type CorpusDataset,
  type CorpusId,
  type CorpusQuery,
} from '../corpora.js'
import type { Preregistration } from '../prereg.js'
import { type Materialised, materialise } from '../run.js'
import { TokenCapReached, type Phase, type TokenLedger } from './ledger.js'
import {
  ADJUDICATION_FILE,
  ADJUDICATION_KEY_FILE,
  type AnswerReport,
  ANSWER_REPORT_SCHEMA,
  adjudicationList,
  type CallRecord,
  type CorpusSection,
  countedRecords,
  evaluateGates,
  isPositiveKind,
  recordKey,
  reportedUsage,
  type RoundRecord,
  type RunStatus,
  summarise,
  validityReasons,
} from './report.js'
import {
  callKey,
  type ScheduledPair,
  scheduleSeed,
  schedulePairs,
  type Unit,
  unitKey,
} from './schedule.js'
import {
  type AnswerLabels,
  answerHead,
  InvalidRound,
  judgeRound,
  type RoundOutcome,
  scoreRound,
} from './score.js'
import {
  ARMS,
  type AnswerRequest,
  type AnswerResponse,
  type AnswerTransport,
  type Arm,
  type ArmRetriever,
  type Turn,
} from './types.js'

/** §4: three independent calls per question per provider. */
export const ANSWER_REPETITIONS = 3

export const CALLS_FILE = 'calls.ndjson'
export const REPORT_FILE = 'report.json'

/** M0: the deterministic retrieval, unchanged. */
export const m0Retriever: ArmRetriever = (store, request) =>
  recall(store, request)

export type AnswerPlan = {
  readonly runId: string
  readonly phase: Phase
  readonly corpora: readonly {
    readonly id: CorpusId
    readonly tiers: readonly number[]
  }[]
  readonly repetitions: number
  readonly arms: readonly Arm[]
  readonly concurrency: number
  /** Library-only narrowing to a few questions (tests); the CLI never sets it. */
  readonly queryIds?: readonly string[]
}

export type AnswerRunDeps = {
  readonly transports: readonly AnswerTransport[]
  readonly retrievers: Readonly<Partial<Record<Arm, ArmRetriever>>>
  readonly ledger: TokenLedger
  readonly outDir: string
  readonly prereg: { readonly values: Preregistration; readonly sha256: string }
  readonly now?: () => Date
  /** Attempts per round before the call counts as failed. Default 2. */
  readonly attempts?: number
  /** Consecutive failed calls that abort the run. Default 5. */
  readonly maxConsecutiveFailures?: number
}

/** Every attempt of one round failed. The call is not recorded. */
export class TransportFailure extends Error {
  constructor(
    readonly callKey: string,
    readonly lastError: unknown,
  ) {
    super(
      `answer eval: ${callKey} failed: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
    this.name = 'TransportFailure'
  }
}

/**
 * The comparison (P16.12) runs the whole protocol or nothing: both arms,
 * three repetitions, every tier of every corpus. The trial (P16.4) may be
 * narrowed; its numbers never enter a verdict (A1).
 */
export function checkPlan(plan: AnswerPlan): void {
  if (!/^[A-Za-z0-9._-]+$/.test(plan.runId)) {
    throw new Error(`answer eval: run id ${plan.runId} must be [A-Za-z0-9._-]+`)
  }
  if (!Number.isInteger(plan.repetitions) || plan.repetitions < 1) {
    throw new Error('answer eval: repetitions must be a positive integer')
  }
  if (!Number.isInteger(plan.concurrency) || plan.concurrency < 1) {
    throw new Error('answer eval: concurrency must be a positive integer')
  }
  if (
    plan.arms.length === 0 ||
    plan.arms.some(arm => !ARMS.includes(arm)) ||
    new Set(plan.arms).size !== plan.arms.length ||
    plan.arms[0] !== 'm0'
  ) {
    throw new Error('answer eval: arms must be [m0] or [m0, m1]')
  }
  for (const { id, tiers } of plan.corpora) {
    const corpus = CORPORA[id]
    for (const tier of tiers) {
      if (!corpus.tiers.includes(tier)) {
        throw new Error(`answer eval: ${id} has no tier ${tier}`)
      }
    }
  }
  if (plan.phase === 'comparison') {
    const everything = Object.values(CORPORA).every(corpus => {
      const planned = plan.corpora.find(c => c.id === corpus.id)
      return (
        planned !== undefined &&
        corpus.tiers.every(tier => planned.tiers.includes(tier))
      )
    })
    if (
      plan.arms.length !== 2 ||
      plan.repetitions !== ANSWER_REPETITIONS ||
      !everything ||
      plan.queryIds !== undefined
    ) {
      throw new Error(
        'answer eval: the comparison runs the whole §4 protocol — both arms, ' +
          `${ANSWER_REPETITIONS} repetitions, every tier of every corpus`,
      )
    }
  }
}

export type PreparedQuery = {
  readonly query: CorpusQuery
  readonly labels: AnswerLabels
  readonly results: Readonly<Partial<Record<Arm, RecallResult>>>
}

export type PreparedTier = {
  readonly corpus: CorpusId
  readonly tier: number
  readonly seed: number
  readonly dataset: CorpusDataset
  readonly materialised: Materialised
  readonly queries: ReadonlyMap<string, PreparedQuery>
  readonly mode: 'full' | 'ranked' | 'mixed'
}

function labelsOf(query: CorpusQuery): AnswerLabels {
  return {
    kind: query.kind,
    gold: query.gold,
    acceptable: query.acceptable,
    mentions:
      query.mustMentionAny.length > 0
        ? query.mustMentionAny
        : query.mustMention.map(term => [term]),
  }
}

/**
 * Write one corpus tier into a real store and run each arm's retrieval for
 * every question. The caller disposes `materialised`.
 */
export async function prepareTier(
  corpusId: CorpusId,
  tier: number,
  plan: Pick<AnswerPlan, 'arms' | 'queryIds'>,
  retrievers: AnswerRunDeps['retrievers'],
): Promise<PreparedTier> {
  const corpus = CORPORA[corpusId]
  // The answer layer runs on each corpus's first preregistered seed; the
  // retrieval layer covers all of them.
  const seed = corpus.seeds[0]
  if (seed === undefined)
    throw new Error(`answer eval: ${corpusId} has no seed`)
  const dataset = corpus.build(tier, seed)
  const materialised = materialise(dataset, { sourceIdOf: corpus.sourceIdOf })
  try {
    const wanted = plan.queryIds === undefined ? null : new Set(plan.queryIds)
    const queries = new Map<string, PreparedQuery>()
    const modes = new Set<string>()
    for (const query of dataset.queries) {
      if (wanted !== null && !wanted.has(query.id)) continue
      const request = {
        question: query.question,
        scope: query.scope ?? dataset.scope,
        asOf: dataset.asOf,
      }
      const results: Partial<Record<Arm, RecallResult>> = {}
      for (const arm of plan.arms) {
        const retriever = retrievers[arm]
        if (retriever === undefined) {
          throw new Error(`answer eval: no retriever for arm ${arm}`)
        }
        const result = await retriever(materialised.store, request)
        if (result.degraded) {
          throw new Error(
            `answer eval: store degraded while recalling ${query.id} (${arm})`,
          )
        }
        results[arm] = result
      }
      const m0 = results.m0
      if (m0 !== undefined) modes.add(m0.mode)
      queries.set(query.id, { query, labels: labelsOf(query), results })
    }
    return {
      corpus: corpusId,
      tier,
      seed,
      dataset,
      materialised,
      queries,
      mode:
        modes.size === 1
          ? modes.has('full')
            ? 'full'
            : 'ranked'
          : modes.size === 0
            ? 'full'
            : 'mixed',
    }
  } catch (error) {
    materialised.dispose()
    throw error
  }
}

/** Parse the call log; a torn last line (a crash mid-append) is dropped. */
export function readCallLog(path: string): CallRecord[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  const torn = !text.endsWith('\n') && (lines.at(-1) ?? '') !== ''
  const complete = torn ? lines.slice(0, -1) : lines
  const records = complete
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as CallRecord)
  if (torn) {
    writeFileSync(
      path,
      records.map(record => `${JSON.stringify(record)}\n`).join(''),
    )
  }
  return records
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Run (or resume) the plan and write the report. */
export async function runAnswerEval(
  plan: AnswerPlan,
  deps: AnswerRunDeps,
): Promise<AnswerReport> {
  checkPlan(plan)
  if (plan.arms.includes('m1') && deps.retrievers.m1 === undefined) {
    throw new Error(
      'answer eval: the M1 arm has no retriever yet (P16.6); run the M0 arm alone',
    )
  }
  const transports = new Map(deps.transports.map(t => [t.providerId, t]))
  if (transports.size !== deps.transports.length || transports.size === 0) {
    throw new Error('answer eval: provider ids must be present and unique')
  }
  const now = deps.now ?? (() => new Date())
  const attempts = deps.attempts ?? 2
  const maxFailures = deps.maxConsecutiveFailures ?? 5
  mkdirSync(deps.outDir, { recursive: true, mode: 0o700 })
  const callsPath = join(deps.outDir, CALLS_FILE)

  const prepared: PreparedTier[] = []
  try {
    for (const { id, tiers } of plan.corpora) {
      for (const tier of tiers) {
        prepared.push(await prepareTier(id, tier, plan, deps.retrievers))
      }
    }
    const tierOf = new Map(prepared.map(p => [`${p.corpus}/${p.tier}`, p]))

    const units: Unit[] = prepared.flatMap(p =>
      [...p.queries.values()].flatMap(({ query }) =>
        deps.transports.flatMap(transport =>
          Array.from({ length: plan.repetitions }, (_, index) => ({
            corpus: p.corpus,
            tier: p.tier,
            seed: p.seed,
            queryId: query.id,
            kind: query.kind,
            provider: transport.providerId,
            rep: index + 1,
          })),
        ),
      ),
    )
    const pairs = schedulePairs(units, plan.arms, scheduleSeed(plan.runId))
    const planned = new Set(
      units.flatMap(unit => plan.arms.map(arm => recordKey(unit, arm))),
    )

    const done = new Map<string, CallRecord>()
    for (const record of readCallLog(callsPath)) {
      if (!planned.has(record.key)) {
        throw new Error(
          `answer eval: ${callsPath} holds ${record.key}, which this plan does not; use another output directory`,
        )
      }
      done.set(record.key, record)
    }

    // Shared by the workers; an object so that the narrowing of a local
    // does not hide the workers' writes from the code after them.
    const state: {
      stop: { status: RunStatus; reason: string; detail: string } | null
      unexpected: unknown
      failed: number
      consecutiveFailures: number
    } = { stop: null, unexpected: null, failed: 0, consecutiveFailures: 0 }

    const exchange = async (
      transport: AnswerTransport,
      request: AnswerRequest,
    ): Promise<AnswerResponse> => {
      let lastError: unknown = null
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const reservation = deps.ledger.reserve(request.callKey, {
          input: transport.inputUpperBound(request),
          output: transport.maxOutputTokens,
        })
        let response: AnswerResponse
        try {
          response = await transport.send(request)
        } catch (error) {
          deps.ledger.settle(reservation, null)
          lastError = error
          continue
        }
        deps.ledger.settle(reservation, response.usage)
        return response
      }
      throw new TransportFailure(request.callKey, lastError)
    }

    const runCall = async (unit: Unit, arm: Arm): Promise<CallRecord> => {
      const tier = tierOf.get(`${unit.corpus}/${unit.tier}`)
      const prep = tier?.queries.get(unit.queryId)
      const result = prep?.results[arm]
      const transport = transports.get(unit.provider)
      if (tier === undefined || prep === undefined || result === undefined) {
        throw new Error(`answer eval: ${unitKey(unit)} was not prepared`)
      }
      if (transport === undefined) {
        throw new Error(`answer eval: no transport ${unit.provider}`)
      }
      const system = buildRecallSystemPrompt(result)
      const judge = (response: AnswerResponse, key: string) =>
        judgeRound({
          store: tier.materialised.store,
          result,
          response,
          keyOf: tier.materialised.keyOf,
          callKey: key,
        })
      const rounds: RoundRecord[] = []
      const keep = (outcome: RoundOutcome, response: AnswerResponse) =>
        rounds.push({
          verdict: outcome.verdict,
          citations: outcome.checks,
          acceptedKeys: outcome.acceptedKeys,
          answerHead: answerHead(outcome.answer),
          model: response.model,
          stopReason: response.stopReason,
          usage: response.usage,
        })

      const firstTurns: Turn[] = [{ role: 'user', text: prep.query.question }]
      const firstKey = callKey(unit, arm, 1)
      const firstResponse = await exchange(transport, {
        callKey: firstKey,
        system,
        turns: firstTurns,
      })
      const first = judge(firstResponse, firstKey)
      keep(first, firstResponse)
      let final = first
      if (
        first.verdict === 'rejected' &&
        first.rejection !== null &&
        first.toolCall !== null
      ) {
        const secondKey = callKey(unit, arm, 2)
        const answered = first.toolCall
        const secondResponse = await exchange(transport, {
          callKey: secondKey,
          system,
          turns: [
            ...firstTurns,
            {
              role: 'assistant',
              thinking: firstResponse.thinking,
              text: firstResponse.text,
              toolCalls: firstResponse.toolCalls,
            },
            // Every tool call needs its result; only the judged one is
            // answered with the rejection.
            ...firstResponse.toolCalls.map(
              (call): Turn => ({
                role: 'tool',
                toolCallId: call.id,
                content:
                  call === answered
                    ? (first.rejection ?? '')
                    : 'Only the first qianmo_memory_answer call is evaluated.',
              }),
            ),
          ],
        })
        final = judge(secondResponse, secondKey)
        keep(final, secondResponse)
      }
      return {
        key: recordKey(unit, arm),
        unit,
        arm,
        mode: result.mode,
        requestedModel: transport.requestedModel,
        at: now().toISOString(),
        rounds,
        first: scoreRound(first, prep.labels),
        final: scoreRound(final, prep.labels),
      }
    }

    let cursor = 0
    const worker = async (): Promise<void> => {
      while (state.stop === null && state.unexpected === null) {
        const pair: ScheduledPair | undefined = pairs[cursor]
        cursor += 1
        if (pair === undefined) return
        for (const arm of pair.order) {
          if (state.stop !== null || state.unexpected !== null) return
          const key = recordKey(pair.unit, arm)
          if (done.has(key)) continue
          try {
            const record = await runCall(pair.unit, arm)
            appendFileSync(callsPath, `${JSON.stringify(record)}\n`)
            done.set(key, record)
            state.consecutiveFailures = 0
          } catch (error) {
            if (error instanceof TokenCapReached) {
              state.stop ??= {
                status: 'capped',
                reason: 'token cap',
                detail: error.message,
              }
              return
            }
            if (error instanceof InvalidRound) {
              state.stop = {
                status: 'invalid',
                reason: 'unreadable',
                detail: error.message,
              }
              state.unexpected = error
              return
            }
            if (error instanceof TransportFailure) {
              state.failed += 1
              state.consecutiveFailures += 1
              if (state.consecutiveFailures >= maxFailures) {
                state.stop ??= {
                  status: 'aborted',
                  reason: 'transport failures',
                  detail: error.message,
                }
              }
              break
            }
            state.unexpected = error
            state.stop = {
              status: 'aborted',
              reason: 'error',
              detail: error instanceof Error ? error.message : String(error),
            }
            return
          }
        }
      }
    }
    await Promise.all(Array.from({ length: plan.concurrency }, () => worker()))

    const records = [...done.values()]
    const counted = countedRecords(records, plan.arms)
    const pairsCompleted =
      plan.arms.length < 2 ? counted.length : counted.length / 2
    if (state.stop === null && pairsCompleted < pairs.length) {
      state.stop = {
        status: 'aborted',
        reason: 'incomplete',
        detail: `${state.failed} call(s) failed; rerun with the same run id to resume`,
      }
    }
    const stop = state.stop
    const status: RunStatus = stop?.status ?? 'complete'
    const corpora: CorpusSection[] = plan.corpora.map(({ id, tiers }) => {
      const preregistered =
        id === 'synthetic-v1'
          ? deps.prereg.values.corpus.syntheticV1Sha256
          : deps.prereg.values.corpus.docsDevV1Sha256
      return {
        id,
        sha256: CORPORA[id].digest(),
        preregisteredSha256: preregistered,
        seed: CORPORA[id].seeds[0] ?? 0,
        tiers: tiers.map(tier => ({
          tier,
          mode: tierOf.get(`${id}/${tier}`)?.mode ?? 'full',
        })),
      }
    })
    const tiersWith = (corpus: string, mode: string) =>
      prepared
        .filter(p => p.corpus === corpus && p.mode === mode)
        .map(p => p.tier)
    const gates = evaluateGates(counted, {
      arms: plan.arms,
      prereg: deps.prereg.values,
      rankedTiers: corpus => tiersWith(corpus, 'ranked'),
      smallTier: corpus => tiersWith(corpus, 'full')[0] ?? null,
      positiveKinds: corpus =>
        (CORPORA[corpus as CorpusId]?.kinds ?? []).filter(isPositiveKind),
      corpora: plan.corpora.map(c => c.id),
    })
    const describe = {
      question: (unit: Unit) =>
        tierOf.get(`${unit.corpus}/${unit.tier}`)?.queries.get(unit.queryId)
          ?.query.question ?? '',
      title: (unit: Unit, key: string) =>
        tierOf
          .get(`${unit.corpus}/${unit.tier}`)
          ?.dataset.entries.find(entry => entry.key === key)?.title ?? '',
    }
    if (gates.A6.file !== null) {
      const list = adjudicationList(counted, plan.runId, describe)
      writeJson(join(deps.outDir, ADJUDICATION_FILE), list.blinded)
      writeJson(join(deps.outDir, ADJUDICATION_KEY_FILE), list.key)
    }
    const { usage, withoutUsage } = reportedUsage(records)
    const report: AnswerReport = {
      schema: ANSWER_REPORT_SCHEMA,
      status,
      runId: plan.runId,
      phase: plan.phase,
      finishedAt: now().toISOString(),
      protocol: {
        arms: plan.arms,
        repetitions: plan.repetitions,
        concurrency: plan.concurrency,
        placement: 'system-prompt',
        requireCitation: false,
        secondRoundAfterRejection: true,
        seedControl: 'uncontrolled',
      },
      preregistration: {
        sha256: deps.prereg.sha256,
        values: deps.prereg.values,
      },
      corpora,
      providers: deps.transports.map(transport => ({
        id: transport.providerId,
        requestedModel: transport.requestedModel,
        maxOutputTokens: transport.maxOutputTokens,
        observedModels: [
          ...new Set(
            records
              .filter(r => r.unit.provider === transport.providerId)
              .flatMap(r => r.rounds.map(round => round.model))
              .filter((model): model is string => model !== null),
          ),
        ].sort(),
      })),
      calls: {
        planned: planned.size,
        completed: records.length,
        pairsPlanned: pairs.length,
        pairsCompleted,
        failed: state.failed,
      },
      tokens: {
        reported: usage,
        callsWithoutUsage: withoutUsage,
        ledger: deps.ledger.snapshot(),
      },
      summary: summarise(
        counted,
        plan.corpora.map(c => c.id),
        corpus => CORPORA[corpus as CorpusId]?.kinds ?? [],
      ),
      gates,
      validity: { valid: false, reasons: [] },
      stop: stop === null ? null : { reason: stop.reason, detail: stop.detail },
    }
    const reasons = validityReasons(status, gates, corpora)
    const final: AnswerReport = {
      ...report,
      validity: { valid: reasons.length === 0, reasons },
    }
    writeJson(join(deps.outDir, REPORT_FILE), final)
    if (state.unexpected !== null) throw state.unexpected
    return final
  } finally {
    for (const tier of prepared) tier.materialised.dispose()
  }
}
