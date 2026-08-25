// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Where a running artifact learns which source it was built from.
 *
 * Issue #70: a fleet node's deployment tree has no `.git`, its 684 `dist/`
 * chunks carry no marker, and the only version string in the entrypoint is the
 * base's `"2.46.0"` — identical on every commit of this fork. So nothing on a
 * deployed machine could answer "which commit is this". The build now injects
 * `MACRO.SOURCE_COMMIT` (scripts/defines.ts); this module is how runtime code
 * reads it back.
 */

/**
 * The value reported when the build could not establish a commit — a clean
 * tarball, a `.git`-less container, an unborn branch — and also what an
 * unbundled run (tests, a direct `bun src/…`) sees, since MACRO substitution
 * only happens under the bundler or `bun -d`.
 *
 * Deliberately a word and not `''`/`undefined`: every consumer is reporting
 * provenance to a human or to a report, and an empty field there reads as
 * "nobody filled it in" rather than "the build genuinely does not know".
 * Kept byte-identical to UNKNOWN_SOURCE_COMMIT in scripts/defines.ts.
 *
 * Module-private on purpose: the only thing outside needs is the string, and
 * an export nothing imports is what the dead-code ratchet exists to catch.
 */
const UNKNOWN_SOURCE_COMMIT = 'unknown'

/**
 * The commit this artifact was built from: a 40-char SHA, that SHA with a
 * `-dirty` suffix, or {@link UNKNOWN_SOURCE_COMMIT}.
 *
 * **Read through `try`, not `typeof MACRO !== 'undefined'`.** The bundler
 * substitutes the member expression `MACRO.SOURCE_COMMIT` and leaves a bare
 * `MACRO` alone, so the `typeof` guard compiles into a test that is *false* in
 * every shipped bundle — the two existing users of that idiom
 * (`transcriptWriter.ts`, `doctorDiagnostic.ts`) therefore report `'unknown'`
 * in production even though the define landed right next to them. Catching the
 * ReferenceError is the form that works on both sides: substituted, the `try`
 * body is a string literal; unsubstituted, `MACRO` is simply not a global.
 */
export function sourceCommit(): string {
  try {
    return MACRO.SOURCE_COMMIT || UNKNOWN_SOURCE_COMMIT
  } catch {
    return UNKNOWN_SOURCE_COMMIT
  }
}
