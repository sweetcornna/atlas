/**
 * Shared COMPLETE mock for src/bootstrap/state.ts
 *
 * The real module is NOT actually fail-fast: STATE is eagerly initialized at
 * module load with working in-memory defaults (random sessionId, cwd resolved
 * from process.cwd(), empty collections) and has zero disk/network side
 * effects — resetStateForTests() exists precisely because tests exercise the
 * real container. So this mock DELEGATES every export to the real
 * implementation at call time unless the caller overrode it. That keeps two
 * classes of test working at once, in any file order:
 *
 *  - suites that install this mock get their overrides;
 *  - suites that use the REAL state (claudemd.projectDirs.test.ts,
 *    autonomyRuns.test.ts call setOriginalCwd/resetStateForTests and read the
 *    results back) still work after a mocking file ran first, because the
 *    non-overridden surface IS the real module. The previous
 *    hand-stubbed base (noop setters, '/mock/cwd' getters, `() => undefined`
 *    auto-fill) silently broke them — order-dependent, direction depends on
 *    Bun's file order — and crashed iterating consumers
 *    ("Spread syntax requires ...iterable" in sandbox-adapter).
 *
 * Two keys stay pinned (overridable) because their real values are
 * environment-shaped and mock-installing suites historically relied on the
 * stable ones: getSessionId ('mock-session-id' instead of a random UUID) and
 * getIsNonInteractiveSession (false regardless of the container's
 * isInteractive default).
 *
 * Delegation alone is not enough. Those two pins — plus whatever the suite
 * overrode — outlive the file that installed them, because mock.module is
 * process-global and last-write-wins with no built-in undo: a later file that
 * expects the container's own sessionId silently reads 'mock-session-id'. So
 * `setupStateMock` is the preferred form; it can move between two baselines:
 *
 *   active   pinned keys + this suite's overrides on top of the delegating
 *            surface, so every other export still reaches the real module.
 *   reset    no overrides at all, pins included — indistinguishable from a
 *            process that never mocked state.
 *
 * Usage (preferred — install at load or in `beforeAll`, restore in `afterAll`):
 *   import { setupStateMock } from '../../../tests/mocks/state.js'
 *   const stateMock = setupStateMock({
 *     getSessionId: () => 'my-suite-session',
 *   })
 *   afterAll(() => stateMock.reset())
 *
 * Legacy form, still used by six unmigrated callers: `stateMockWith` /
 * `stateMock` hand a factory straight to `mock.module` and have no way back to
 * the delegating baseline. Migrate to `setupStateMock`; do not add new callers.
 *   mock.module('src/bootstrap/state.ts', stateMockWith({ … }))
 *
 * Both forms register under the 'src/bootstrap/state.ts' specifier (never
 * '.js') so all writers hit the same registry entry deliberately.
 */

import * as realState from 'src/bootstrap/state.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type StateOverrides = ModuleOverrides<typeof realState>

const pinnedOverrides: StateOverrides = {
  getSessionId: () => 'mock-session-id',
  getIsNonInteractiveSession: () => false,
}

/** The same two pins, through the untyped lens `stateMockWith`'s loop needs. */
const pinnedBase: Record<string, unknown> = pinnedOverrides

/**
 * Complete-surface factory with per-file overrides. Every real export not
 * overridden (and not pinned above) delegates to the real implementation at
 * call time, so a caller can never install a partial or behavior-drifting
 * surface by accident.
 */
export function stateMockWith(
  overrides: Record<string, unknown> = {},
): () => Record<string, unknown> {
  return () => {
    const surface: Record<string, unknown> = {}
    for (const key of Object.keys(realState)) {
      const realValue = (realState as Record<string, unknown>)[key]
      if (typeof realValue !== 'function') {
        surface[key] = realValue
        continue
      }
      surface[key] = (...args: unknown[]): unknown => {
        const impl = (overrides[key] ?? pinnedBase[key] ?? realValue) as (
          ...a: unknown[]
        ) => unknown
        return impl(...args)
      }
    }
    // Preserve overrides that don't exist on the real module (historical
    // helpers some suites add); real keys already delegate above.
    for (const key of Object.keys(overrides)) {
      if (!(key in surface)) surface[key] = overrides[key]
    }
    return surface
  }
}

export const stateMock = stateMockWith()

const shared = makeSharedModuleMock('src/bootstrap/state.ts', realState)

/**
 * Preferred entry point. Unlike tests/mocks/auth.ts — whose real module is
 * side-effectful when called, so its active surface must be complete-fake —
 * state's active surface only needs the pins plus the caller's overrides:
 * sharedModuleMock already delegates every untouched export to the real
 * implementation, which is exactly this module's semantics. `set` replaces the
 * whole override map (the pins are re-applied underneath it) and `reset` drops
 * back to a fully delegating surface.
 */
export function setupStateMock(
  overrides: StateOverrides = {},
): ReturnType<typeof shared.setup> {
  const withPins = (next: StateOverrides): StateOverrides => ({
    ...pinnedOverrides,
    ...next,
  })
  const handle = shared.setup(withPins(overrides))
  return {
    set: next => handle.set(withPins(next)),
    reset: handle.reset,
  }
}
