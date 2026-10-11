// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Memory recall as a **user-message sidecar** (design `resident-botization.md`
 * §4.4, hermes D3/D5).
 *
 * WHERE THE INJECTION GOES, AND WHY IT IS NOT THE SYSTEM PROMPT
 *
 * The block this module renders is appended to the text of the turn's user
 * message — the same string `formatTeammateMessages` produced — and never to
 * the system prompt. Three reasons, in the order they matter:
 *
 *   1. it is the one dynamic channel that sits *after* the cached prefix, so a
 *      block that changes every turn costs nothing;
 *   2. putting it in the system prompt would rebuild that prompt every turn,
 *      which throws away the whole prefix cache on every single wake — in a
 *      watch job that runs for seven days straight that is pure loss;
 *   3. memory is evidence, not instruction. It belongs where the rest of the
 *      turn's evidence is.
 *
 * WHY THE RECALL IS A FROZEN SNAPSHOT
 *
 * `recall()` runs exactly once per turn, at the moment the reader builds the
 * prompt, and the rendered string is then written into the admission ledger
 * alongside the prompt (`DetectedAdmissionRecord.prompt`). Every later step of
 * that turn — every tool call, every model round trip, and every post-crash
 * recovery — replays that stored string. It is *structurally* impossible for a
 * memory write made mid-turn to change what this turn is looking at.
 *
 * This is deliberate and must not be "optimised" into a live read. A turn whose
 * evidence changes under it while it reasons cannot be reproduced, cannot be
 * audited, and can cite an entry that was not in front of it when it decided.
 * AC-4 asks the answer to carry the id and the write time of what it used; that
 * promise only holds if "what it used" is a fixed set.
 *
 * WHY THE SCOPE IS `(agent, contextId)`
 *
 * The same key the omp RPC session is chosen by (§4.3). A watch job and a human
 * conversation with the same node are different contexts, so they are different
 * memory partitions — no configuration, no opt-in, and nothing to get wrong.
 */

import { isAbsolute } from 'node:path'
import type { FileMemoryStore } from '@qianmo/memory'
import {
  INJECTION_BUDGET,
  type InjectionBudget,
  type RecallRequest,
  type RecallScope,
  type RetrievalEvent,
  type RetrievalMode,
  type SemanticRecall,
  recall,
  recallHybrid,
  renderInjection,
  resolveHybridConfig,
  injectedIds,
  handleMemoryEvidenceAnswer,
  memoryEvidenceContext,
} from '@qianmo/recall'
import type { ResidentPromptScope } from './contracts.js'
import { resolveMemoryPartition } from './memory-partition.js'

/** Conversation scope retains the existing namespace and normalization. */
export function residentRecallScope(scope: ResidentPromptScope): RecallScope {
  const { projectKey, taskId } = resolveMemoryPartition({
    ...scope,
    scope: 'conversation',
  })
  return { layers: ['working'], projectKey, taskId }
}

/**
 * Refuse a memory root that is not absolute (hermes F9).
 *
 * The question F9 asks is "can dropping a directory into the working tree
 * quietly hijack this node's memory?". Today the root comes from the identity
 * config dir, so the answer is no — but only as long as it stays absolute. A
 * relative root (`QIANMO_MEMORY_DIR=memory`, an option threaded
 * through by a future caller) is resolved against `process.cwd()`, and the cwd
 * of a resident turn is the project the agent was pointed at. At that moment a
 * `memory/` directory committed to a repository *becomes* the node's memory
 * store, and every entry in it is injected as though the node had written it.
 *
 * The base makes the same call for the same reason: `validateMemoryPath` in
 * `src/memdir/paths.ts` rejects relative candidates because they "would be
 * interpreted relative to CWD". This is that rule, applied to the one root the
 * resident actually recalls from.
 */
export function assertNodeOwnedMemoryRoot(root: string): void {
  if (!isAbsolute(root)) {
    throw new Error(
      `resident memory root must be absolute, got ${JSON.stringify(root)}: ` +
        'a relative root resolves against the working tree, which would let a ' +
        'directory committed to a repository stand in for this node memory',
    )
  }
}

export interface ResidentMemorySidecarOptions {
  readonly store: FileMemoryStore
  /** Defaults to {@link INJECTION_BUDGET}. */
  readonly budget?: Partial<InjectionBudget>
  readonly now?: () => Date
  /**
   * Where a recall failure goes. Failures are **fail-open**: a store that
   * cannot be read costs the turn its memory, never the turn itself. The
   * resident reliability kit made the same call for the same reason (§3.3
   * invariant 26) — a component that exists to make the node lose less must
   * never become the reason the node stops.
   */
  readonly onError?: (error: unknown) => void
  /**
   * The semantic overlay (`docs/dev/memory-m1.md` §5). **Off when absent**:
   * {@link ResidentMemorySidecar.renderHybrid} then renders exactly what
   * {@link ResidentMemorySidecar.render} does and records no retrieval. Its
   * configuration is checked here, so a node given one that cannot work
   * refuses to start instead of degrading every turn.
   */
  readonly semantic?: SemanticRecall
  /**
   * Where the overlay's fallbacks and shortfalls are reported (I-6): cold
   * index, exhausted budget, a failed or late embedding call. None of them
   * costs the turn anything but the overlay.
   */
  readonly onRetrievalEvent?: (event: RetrievalEvent) => void
}

/** One turn's memory block, and how it was retrieved when that is recorded. */
interface ResidentMemoryBlock {
  readonly memoryIds?: readonly string[]
  readonly block: string
  /** Set only while the semantic overlay is on. */
  readonly retrieval?: RetrievalMode
}

/**
 * Renders the memory block for one turn.
 *
 * Holds no per-turn state: freezing is the caller's structure (one call per
 * turn, result persisted), not a cache in here. A cache would have to be
 * invalidated, and every invalidation rule is a way for two steps of one turn
 * to see different evidence.
 */
export class ResidentMemorySidecar {
  readonly #store: FileMemoryStore
  readonly #budget: Partial<InjectionBudget> | undefined
  readonly #now: (() => Date) | undefined
  readonly #onError: ((error: unknown) => void) | undefined
  readonly #semantic: SemanticRecall | undefined
  readonly #onRetrievalEvent: ((event: RetrievalEvent) => void) | undefined

  constructor(options: ResidentMemorySidecarOptions) {
    assertNodeOwnedMemoryRoot(options.store.root)
    if (options.semantic !== undefined) {
      resolveHybridConfig(options.semantic.config)
    }
    this.#store = options.store
    this.#budget = options.budget
    this.#now = options.now
    this.#onError = options.onError
    this.#semantic = options.semantic
    this.#onRetrievalEvent = options.onRetrievalEvent
  }

  #request(scope: ResidentPromptScope, question?: string): RecallRequest {
    return {
      scope: residentRecallScope(scope),
      ...(scope.owner === undefined
        ? {}
        : {
            priorityScopes: [
              {
                layers: ['working' as const],
                ...resolveMemoryPartition({
                  scope: 'long',
                  agent: scope.agent,
                  owner: scope.owner,
                }),
              },
              residentRecallScope(scope),
            ],
          }),
      ...(question === undefined ? {} : { question }),
      ...(this.#budget === undefined ? {} : { budget: this.#budget }),
      ...(this.#now === undefined ? {} : { asOf: this.#now() }),
    }
  }

  /**
   * The block to append to this turn's user message, or `''` when there is
   * nothing to say.
   *
   * @param question The turn's own text. Used for **ranking only** — never as a
   *   filter, so a watch job that phrases things differently from the entry it
   *   needs still sees that entry (that is the whole point of full injection).
   */
  render(scope: ResidentPromptScope, question?: string): string {
    return this.renderFrozen(scope, question).block
  }

  renderFrozen(
    scope: ResidentPromptScope,
    question?: string,
  ): ResidentMemoryBlock {
    try {
      const result = recall(this.#store, this.#request(scope, question))
      return {
        block:
          result.entries.length === 0
            ? ''
            : memoryEvidenceContext(renderInjection(result)),
        memoryIds: [...injectedIds(result)],
      }
    } catch (error) {
      this.#onError?.(error)
      return { block: '', memoryIds: [] }
    }
  }

  /**
   * The same block through the semantic overlay, when one is configured —
   * the middle stage of the two-stage assembly (`memory-m1.md` §5.4): the
   * batch has been rendered, and the turn waits here, bounded by the overlay's
   * timeout, before its prompt is finished.
   *
   * Same freezing rule as {@link render}: called once per turn, and the result
   * is persisted with the prompt. Same fail-open rule too: a store failure is
   * an empty block, a semantic failure is the deterministic block.
   */
  async renderHybrid(
    scope: ResidentPromptScope,
    question?: string,
  ): Promise<ResidentMemoryBlock> {
    const semantic = this.#semantic
    if (semantic === undefined || scope.owner !== undefined)
      return this.renderFrozen(scope, question)
    try {
      const result = await recallHybrid(
        this.#store,
        this.#request(scope, question),
        semantic,
      )
      for (const event of result.retrievalEvents) {
        this.#onRetrievalEvent?.(event)
      }
      return {
        block:
          result.entries.length === 0
            ? ''
            : memoryEvidenceContext(renderInjection(result)),
        retrieval: result.retrieval,
        memoryIds: [...injectedIds(result)],
      }
    } catch (error) {
      this.#onError?.(error)
      return { block: '', memoryIds: [] }
    }
  }

  answer(
    memoryIds: readonly string[],
    input: unknown,
  ): { ok: boolean; text: string } {
    try {
      const answer = handleMemoryEvidenceAnswer(
        this.#store,
        new Set(memoryIds),
        input,
      )
      return {
        ok: answer.ok,
        text: answer.ok
          ? answer.answer
          : (answer.rejection ?? 'Memory evidence unavailable.'),
      }
    } catch {
      return {
        ok: false,
        text: 'Invalid memory answer. Use supported with complete source evidence, or insufficient with evidence: []. Do not supply free answer text.',
      }
    }
  }
}

/** Unverified prose must never resemble a host-verified citation. */
export function stripMemoryCitations(text: string): string {
  return text.replace(
    /qm-mem-[A-Za-z0-9._/-]+/g,
    '[unverified memory reference]',
  )
}

export { INJECTION_BUDGET }
