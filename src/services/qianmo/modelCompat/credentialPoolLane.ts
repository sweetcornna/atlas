// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the key pool meets a lane's retry ladder (P18.18, hermes #2): a
 * wrapper around the `create` callback `retryThirdPartyEventStream` re-runs
 * for every attempt. `openai/index.ts` hands it the request it would have made
 * anyway, as a function of the key to make it with.
 *
 * Without a pool (`activeCredentialPool()` is `null`: no `key-pool.json`, a
 * single-key profile, or an env the pool is not bound to) the callback is
 * called with `undefined` and nothing else happens — the request is the one
 * the lane always made, from the env, byte for byte
 * (`singleKeyRequestRegression.test.ts`).
 *
 * With a pool:
 *
 *   - each attempt asks the pool for this session's key (X-1);
 *   - a failure while CREATING the stream — before the ladder has seen a
 *     single event of this attempt, so before any commitment — that takes the
 *     key out is re-sent at once with the session's next key, if the error is
 *     replayable at all. Each key is tried at most once per attempt, so this
 *     ends after at most one round of the pool, and when every key is out the
 *     pool's own error names the first one back;
 *   - a failure while READING the stream is only accounted for (cooldown,
 *     binding): whether anything is re-sent is decided by the ladder's
 *     commitment barrier alone (#29). A key change never replays output the
 *     reader has seen;
 *   - a 429 the pool wants retried with the same key is simply re-thrown: the
 *     ladder retries it after its own wait, and the next attempt comes back
 *     here with the same binding.
 */

import { isAPIErrorReplayable } from '../../api/retryClassification.js'
import {
  activeCredentialPool,
  type CredentialPool,
  type PoolKey,
} from './credentialPool.js'

export type CredentialPoolTarget = {
  sessionId: string
  signal: AbortSignal
  /** `false` on routes that do not authenticate with the env key. */
  enabled: boolean
}

async function* accounted<E>(
  stream: AsyncIterable<E>,
  pool: CredentialPool,
  sessionId: string,
  key: PoolKey,
): AsyncGenerator<E, void> {
  try {
    for await (const event of stream) yield event
  } catch (error) {
    pool.failed(sessionId, key, error)
    throw error
  }
  pool.succeeded(sessionId)
}

export function withCredentialPool<E>(
  target: CredentialPoolTarget,
  create: (apiKey: string | undefined) => Promise<AsyncIterable<E>>,
): () => Promise<AsyncIterable<E>> {
  return async () => {
    const pool = target.enabled ? activeCredentialPool() : null
    if (pool === null) return create(undefined)
    const tried = new Set<string>()
    let last: unknown
    while (true) {
      const key = pool.keyFor(target.sessionId)
      // A key back in rotation already (its reset time has passed) is not
      // tried twice in one attempt: the ladder's own wait comes first.
      if (tried.has(key.id)) throw last
      tried.add(key.id)
      let stream: AsyncIterable<E>
      try {
        stream = await create(key.value)
      } catch (error) {
        if (target.signal.aborted) throw error
        const outcome = pool.failed(target.sessionId, key, error)
        if (outcome !== 'rotated' || !isAPIErrorReplayable(error)) throw error
        last = error
        continue
      }
      return accounted(stream, pool, target.sessionId, key)
    }
  }
}
