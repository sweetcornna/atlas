/**
 * Single source of truth for this product's identity.
 *
 * Every user-visible name, the npm package the updater targets, and the
 * repository URL come from here. Before this module those strings were spread
 * across ~40 files, which is how `ccb --resume` ended up hardcoded in six
 * different places and how the self-updater came to point at three different
 * packages at once.
 *
 * ── What must NOT be renamed ──────────────────────────────────────────────
 *
 * Some strings look like branding and are load-bearing protocol. Changing them
 * breaks things in ways that are slow to diagnose, so they are deliberately
 * absent from this file:
 *
 *   - The system prompt's "You are Claude Code, Anthropic's official CLI for
 *     Claude" preamble (src/constants/prompts.ts). Anthropic's prompt caching
 *     and behaviour tuning key off that exact text.
 *   - The `claude-code/<version>` User-Agent (src/utils/userAgent.ts, 26 call
 *     sites). Anthropic-side rate limiting and eligibility read it.
 *   - The OTel `service.name: 'claude-code'` used by existing dashboards.
 *   - `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` filenames — an ecosystem
 *     convention shared with other tools.
 *   - `CLAUDECODE=1` in child process env: the cross-tool hints protocol.
 *
 * Path and directory identity lives in `src/config/paths.ts`, not here.
 *
 * ── Identity switching ────────────────────────────────────────────────────
 *
 * The three names below are identity-scoped: they carry occ's default value or
 * the Qianmo node's variant depending on `OCC_IDENTITY`, resolved once at load
 * by `byIdentity` (src/constants/identity.ts, a zero-import module so this file
 * stays lightweight for the keychain prefetch). Every one of BIN_NAME's ~78
 * consumers keeps importing the same symbol and transparently gets the right
 * value. The names below the divider are NOT switched — see their comments.
 */

import { byIdentity } from './identity.js'

/** The command users type. Also the process title and socket prefix. */
export const BIN_NAME = byIdentity({ occ: 'occ', qianmo: 'qm' })

/** Full product name, for prose and package metadata. */
export const PRODUCT_NAME = byIdentity({
  occ: 'open-claude-code',
  qianmo: 'qianmo',
})

/** Display name, for banners and dialogs. */
export const DISPLAY_NAME = byIdentity({
  occ: 'Open Claude Code',
  qianmo: 'Qianmo Node',
})

/**
 * The npm package the self-updater installs from.
 *
 * This MUST match the `name` field in package.json. Three separate places used
 * to disagree about it — `updateOcc.ts` (né `updateCCB.ts`) said
 * `claude-code-best`, `autoUpdater` read an empty `MACRO.PACKAGE_URL`, and
 * `rollback.ts` hardcoded Anthropic's `@anthropic-ai/claude-code`, meaning
 * "rolling back" installed a different product over the user's binary.
 *
 * NOT switched by identity: M0 Qianmo nodes do not self-update (they are
 * launched programmatically, not installed from npm), so the updater target
 * stays occ's package regardless of `OCC_IDENTITY`.
 */
export const NPM_PACKAGE_NAME = '@sweetcornna/open-claude-code'

/**
 * OS-level deep-link identity owned exclusively by occ.
 *
 * NOT switched by identity: M0 Qianmo nodes register no OS deep-link handler,
 * so these keep occ's values. If a node ever needs its own scheme, add a
 * `byIdentity` variant here rather than a second hardcoded string.
 */
export const DEEP_LINK_PROTOCOL = 'occ-cli'
export const MACOS_DEEP_LINK_BUNDLE_ID =
  'io.github.sweetcornna.open-claude-code-url-handler'
