/**
 * Mapping occ's effort ladder onto xAI's.
 *
 * Grok took no effort parameter at all before this: `/effort` and
 * `CLAUDE_CODE_EFFORT_LEVEL` were accepted, displayed, and then dropped on the
 * floor for the whole provider.
 *
 * Two things make this narrower than the other providers':
 *
 *   - xAI's ladder is TWO rungs, `low` and `high`. occ's five collapse onto
 *     them the same way DeepSeek's three do (see resolveDeepSeekReasoningEffort)
 *     — the middle of the ladder rounds up, because a coding agent asking for
 *     "medium" wants reasoning, not the cheap rung.
 *   - Only the `grok-3-mini` family accepts the field. The grok-4 reasoning
 *     models always reason and REJECT `reasoning_effort` outright, so sending it
 *     there would turn a preference into a 400 for every request in the session.
 *     Returning undefined for them is not a gap; it is the parameter not
 *     existing on that model.
 *
 * qianmo P18.8 (hermes #13): which models accept it, and the clamp, are now a
 * table — src/services/qianmo/modelCompat/effortVendors.ts. grok-3-mini is
 * unchanged; grok-4.20-multi-agent, grok-4.3, grok-4.5 and grok-4.6 are sent
 * only on an explicit effort opt-in until checked against a real endpoint.
 */
import {
  grokAcceptsReasoningEffort,
  resolveGrokEffort,
} from '../../qianmo/modelCompat/effortVendors.js'

/** Models that take `reasoning_effort`. */
function acceptsReasoningEffort(model: string): boolean {
  return grokAcceptsReasoningEffort(model)
}

/**
 * The rung to send, or undefined to send nothing (no effort chosen, or a model
 * that does not take the parameter).
 */
export function resolveGrokReasoningEffort(
  model: string,
  effortValue: unknown,
): ReturnType<typeof resolveGrokEffort> {
  if (!acceptsReasoningEffort(model)) return undefined
  // Unset, and the ant-only numeric efforts that have no rung here: leave
  // the parameter off and inherit xAI's own default.
  return resolveGrokEffort(model, effortValue)
}
