/**
 * Shared COMPLETE mock for `src/utils/auth/auth.js`.
 *
 * The real module is side-effectful when CALLED (macOS keychain reads, apiKey
 * helper subprocesses, AWS/GCP credential refresh), so unlike the pure-module
 * wrappers (tests/mocks/cron.ts) its ACTIVE surface must NOT delegate to the
 * real implementation — a test that forgot an override would silently hit the
 * user's keychain. Instead it follows tests/mocks/state.ts: hand-tuned safe
 * defaults below, every remaining real export auto-filled, per-file overrides
 * on top. Completeness matters because mock.module is process-global
 * last-write-wins: a hand-rolled PARTIAL auth mock in one file (e.g. only
 * `getClaudeAIOAuthTokens`) used to break every file that ran after it and
 * imported any other auth export ("Export named 'isClaudeAISubscriber' not
 * found" at load) — order-dependent, direction depends on Bun's file order.
 *
 * Completeness alone is not enough. A surface that can never be taken down
 * leaks its fake credentials to every file loaded afterwards, which is how
 * skillLearning's REAL `queryHaiku` ended up putting a fake token on a real
 * HTTPS request. So this module keeps two baselines, and `setupAuthMock` is
 * the preferred form because it can move between them:
 *
 *   active   complete fake surface (safe defaults + auto-fill + overrides);
 *            no export can reach the real implementation.
 *   reset    no overrides at all, so every export delegates to the real
 *            module — indistinguishable from a process that never mocked auth.
 *
 * Usage (preferred — install at load or in `beforeAll`, restore in `afterAll`):
 *   import { setupAuthMock } from '../../tests/mocks/auth.js'
 *   const authMock = setupAuthMock({
 *     getClaudeAIOAuthTokens: () => ({ accessToken: 'my-token' }),
 *   })
 *   afterAll(() => authMock.reset())
 *
 * Legacy form, still used by eight unmigrated files: `authMockWith` / `authMock`
 * hand a factory straight to `mock.module` and have no way back to the
 * delegating baseline. Migrate to `setupAuthMock`; do not add new callers.
 *   mock.module('src/utils/auth/auth.js', authMockWith({ … }))
 *
 * Both forms register under the 'src/utils/auth/auth.js' specifier (never
 * '.ts') so all writers hit the same registry entry deliberately.
 */

import * as realAuth from 'src/utils/auth/auth.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type AuthOverrides = ModuleOverrides<typeof realAuth>

function baseAuthMock() {
  return {
    // Mirrors the production contract: src/utils/auth.ts returns
    // Promise<boolean> ("did the access token change") and a token object that
    // carries scopes, subscriptionType, expiresAt, etc. Tests that branch on
    // these values must see the full shape so they can not silently drift away
    // from production.
    checkAndRefreshOAuthTokenIfNeeded: async () => false,
    getClaudeAIOAuthTokens: () => ({
      accessToken: 'token',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }),
    isClaudeAISubscriber: () => true,
    isProSubscriber: () => false,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
    // Null-typed getters: the real signatures are `T | null`, and consumers
    // check `=== null` / pass the value onward — an auto-filled
    // `() => undefined` would be out of contract.
    getAnthropicApiKey: () => null,
    getSubscriptionType: () => null,
    getRateLimitTier: () => null,
    // Boolean gates default to "no API-key auth configured".
    hasAnthropicApiKeyAuth: () => false,
    isAnthropicAuthEnabled: () => false,
    removeClaudeAIOAuthTokens: () => ({ success: true }),
  }
}

/**
 * Complete-surface factory with per-file overrides. Real exports missing from
 * the hand-tuned base are auto-filled (functions -> () => undefined, values
 * copied), so a caller can never install a partial surface by accident.
 */
export function authMockWith(
  overrides: Record<string, unknown> = {},
): () => Record<string, unknown> {
  return () => {
    const base = baseAuthMock() as Record<string, unknown>
    const full: Record<string, unknown> = { ...base }
    for (const key of Object.keys(realAuth)) {
      if (key in full) continue
      const realValue = (realAuth as Record<string, unknown>)[key]
      full[key] = typeof realValue === 'function' ? () => undefined : realValue
    }
    return { ...full, ...overrides }
  }
}

export const authMock = authMockWith()

const shared = makeSharedModuleMock('src/utils/auth/auth.js', realAuth)

/**
 * The complete fake surface, expressed as an override MAP rather than as the
 * installed surface. That is the whole trick: sharedModuleMock's delegating
 * wrapper falls back to the real function only when a key has no override, and
 * this map carries a key for EVERY real export, so while a suite is active the
 * fallback is unreachable. The cast covers the auto-filled `() => undefined`
 * stubs, whose arity and return type cannot match the signatures they stand in
 * for.
 */
function completeFakeSurface(overrides: AuthOverrides): AuthOverrides {
  return authMockWith(
    overrides as Record<string, unknown>,
  )() as unknown as AuthOverrides
}

/**
 * Preferred entry point. `set` replaces the whole override map — the fake
 * surface is rebuilt underneath it, so "active means complete" survives every
 * update — and `reset` drops back to delegating to the real module.
 */
export function setupAuthMock(
  overrides: AuthOverrides = {},
): ReturnType<typeof shared.setup> {
  const handle = shared.setup(completeFakeSurface(overrides))
  return {
    set: next => handle.set(completeFakeSurface(next)),
    reset: handle.reset,
  }
}
