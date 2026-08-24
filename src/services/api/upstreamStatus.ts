/**
 * One-way notice that the model endpoint answered a request with an HTTP
 * status, for consumers that are not the request itself.
 *
 * The consumer this exists for is a Qianmo resident node's inactivity
 * watchdog. It runs in the *parent* process and can only observe that the ACP
 * child has stopped speaking; the status that explains the silence is knowledge
 * only the child has. On the beta fleet that gap turned an expired API key —
 * `HTTP 401` in 44 milliseconds, retried quietly until the budget ran out —
 * into `ResidentInactivityError: … produced no activity for 120000ms`, an
 * error that sends every reader looking at model latency (issue #37).
 *
 * Deliberately shaped as a single global sink rather than an event emitter or
 * a per-request option:
 *
 * - **Global**, because the report has to escape from inside two retry ladders
 *   that are called from everywhere and thread no context of their own. A
 *   parameter would have to be added to every call site of every API path, and
 *   the one that got missed would be the one that mattered.
 * - **Single**, because the only subscriber is the ACP entry point, which
 *   registers once per process. A list would imply a fan-out nobody has asked
 *   for, and the reset semantics of a list are exactly where test pollution
 *   comes from.
 * - **Failures only.** A success notice per request would put a message on the
 *   ACP wire for every call a healthy node makes, to answer a question nothing
 *   asks on a healthy node. Staleness is handled by the consumer, which only
 *   believes a status recent enough to be about the silence it measured.
 *
 * Nothing here throws and nothing here awaits: reporting is on the failure
 * path of a request that is about to be retried, and a diagnostic channel that
 * can fail a request is worse than no diagnostic channel.
 */

export type UpstreamStatusReport = {
  readonly status: number
  /** A short, already-sanitized description, when one is cheaply available. */
  readonly detail?: string
}

let sink: ((report: UpstreamStatusReport) => void) | undefined

/** Subscribe. Replaces any previous subscriber; see the module comment. */
export function registerUpstreamStatusCallback(
  callback: (report: UpstreamStatusReport) => void,
): void {
  sink = callback
}

export function unregisterUpstreamStatusCallback(): void {
  sink = undefined
}

/**
 * Read an HTTP status off whatever an API layer threw.
 *
 * Every client in this repo puts it on the same property under a different
 * class — `APIError` (Anthropic SDK), `APIError` (OpenAI SDK),
 * `OpenAIRequestError`, `GeminiRequestError` — so one property read covers all
 * of them without importing any. Numeric strings are accepted because the
 * OpenAI-compatible error bodies sometimes carry `"status": "429"`.
 */
export function readUpstreamHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const raw = (error as { status?: unknown }).status
  const status =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d{3}$/.test(raw)
        ? Number(raw)
        : undefined
  if (status === undefined) return undefined
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined
}

/**
 * Report the status carried by a failed API attempt, if it carried one.
 *
 * A transport failure with no status (DNS, TLS, a socket reset) reports
 * nothing: "the request never got an answer" is a different diagnosis from
 * "the answer was 401", and inventing a status for it would let the watchdog
 * blame a credential for a network outage.
 */
export function reportUpstreamFailure(error: unknown): void {
  const status = readUpstreamHttpStatus(error)
  if (status === undefined) return
  const notify = sink
  if (notify === undefined) return
  try {
    notify({ status })
  } catch {
    // A diagnostic sink must never be able to fail the request it describes.
  }
}
