#!/usr/bin/env bun
/**
 * Test-mock hygiene ratchet.
 *
 * Bun's `mock.module` is process-global and last-write-wins, and Bun runs every
 * test file of a shard in ONE process. A file that installs its own inline
 * surface therefore does not mock "for itself" — it mocks for every file loaded
 * after it, for the rest of the run. Two things go wrong:
 *
 *   missing exports  a hand-written surface only lists what its own suite
 *                    calls. Every other export becomes `undefined` for later
 *                    files ("x is not a function", "Export not found").
 *   stuck overrides  even a COMPLETE surface poisons later files if the
 *                    override itself is a lie. `src/utils/sandbox/__tests__/`
 *                    spread the real module and pinned
 *                    `getSettingsFilePathForSource: () => undefined`; that made
 *                    `settings/__tests__/changeDetector.test.ts` watch the
 *                    wrong directories. `MagicDocs/__tests__/prompts.test.ts`
 *                    left behind a hand-rolled fs adapter with no *Sync
 *                    methods, so `updateSettingsForSource` threw and
 *                    `pluginOperations.builtinSecurity.test.ts` got
 *                    success:false.
 *
 * Both only ever failed on Linux: Bun's test-file order comes from the
 * filesystem, is neither alphabetical nor argument order, and differs from
 * macOS. CI was red on all 55 runs between v2.11.0 and v2.30.0; no local run
 * ever reproduced either one.
 *
 * The fix for both is the same and already exists: `tests/mocks/*` builds a
 * complete surface whose exports delegate to the real module, with overrides
 * scoped to one suite (`setup()` at load, `set()` in `beforeAll`, `reset()` in
 * `afterAll`). See tests/mocks/sharedModuleMock.ts.
 *
 * So the rule enforced here is narrow and syntactic:
 *
 *   a `mock.module()` whose specifier resolves INSIDE this repo must take its
 *   factory from a helper (an identifier or a call — `logMock`,
 *   `setupSettingsMock()`), never an inline `() => ({ ... })` literal.
 *
 * Third-party and builtin specifiers (`bun:bundle`, `axios`, `node:*`) are
 * exempt: they have no repo module to delegate to, and a stale surface there
 * cannot desynchronise from source that lives in this tree.
 *
 * A complete surface is only half the requirement, though, and the rules that
 * came later cover the other half: whatever it installs has to be removable
 * again. Two shapes fail that test and both are counted here —
 * `mock.module(spec, authMockWith({ … }))`, which hands the factory straight
 * to Bun and keeps no handle at all, and `setupXMock({ … })` whose handle is
 * never `reset()`. The consequence is not hypothetical in either direction:
 * the first one leaked `tests/mocks/auth.ts`'s fake credentials into
 * skillLearning's REAL `queryHaiku`, which then put a fake token on a real
 * outbound HTTPS request.
 *
 * The backlog this started with — 241 inline surfaces across 64 files — is
 * gone, and the inline and shim rules have sat at a hard zero ever since it
 * cleared. What remains in scripts/mock-hygiene-budget.json is the
 * grandfathered tail of the two later rules: the helper-factory installs that
 * predate `setupAuthMock`, and the infix `).setup({ … })` sites the unreset
 * rule used to miss (see countUnscoped). Recorded, not forgiven — the budget
 * is the list of files still owed a migration, and it can only shrink. The
 * two-sided ratchet machinery (same contract as check-cycles.ts and
 * check-prompt-purity.ts) is what keeps it moving in one direction:
 *
 *   count > budget  new violation — route it through tests/mocks/.
 *   count < budget  one was converted — rerun with --update and commit the
 *                   lower baseline so it cannot silently come back.
 *
 * Worth knowing before adding a mock: roughly a third of that backlog turned
 * out to be mocks that should not have existed at all — pure constant modules,
 * pure predicates, empty `() => ({})` surfaces that blanked a module for the
 * whole shard, and in two cases a specifier pointing at a path that does not
 * exist. Deleting beats converting. Try `bun test <that dir>` without the mock
 * before writing one.
 *
 * Pure text scanning, no module loading, so it runs in milliseconds and is safe
 * inside precheck.
 *
 * Usage:
 *   bun run scripts/check-mock-hygiene.ts
 *   bun run scripts/check-mock-hygiene.ts --update
 */

import { Glob } from 'bun'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const BUDGET_FILE = join(PROJECT_ROOT, 'scripts', 'mock-hygiene-budget.json')

/** How many offending files to print when the ratchet trips. */
const SAMPLE_SIZE = 12

/**
 * `*.runner.ts` is deliberately absent.
 *
 * Every rule in this file is about ONE process shared by MANY files. A runner
 * is neither: its companion `.test.ts` spawns it with
 * `Bun.spawn(['bun', 'test', <runner>])`, so it gets a process containing
 * exactly itself — which is the entire reason runners exist.
 *
 * And a shard can never pull one in by accident: Bun's default discovery only
 * matches `*.test.*` / `*_test.*` / `*.spec.*`, so `bun test src/constants`
 * does not load `src/constants/promptEngineeringAudit.runner.ts`. Verified
 * with a scratch directory holding `a.runner.ts` + `b.test.ts` — `bun test .`
 * ran one file.
 *
 * Scanning them anyway put 53 inline surfaces in the ratchet that cannot
 * poison anything, and pressured whoever cleared them into converting mocks
 * that were already correct.
 */
const TEST_GLOBS = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'packages/**/*.test.ts',
  'packages/**/*.test.tsx',
  'tests/**/*.test.ts',
]

/**
 * An inline factory written out at the call site, in either form:
 *
 *   mock.module('<spec>', () => ({ … }))     arrow returning an object literal
 *   mock.module('<spec>', () => { … })       block body that builds and returns
 *
 * A helper-based call (`mock.module('x', logMock)`) does not match, which is
 * the whole point.
 *
 * The block-body arm was added after one slipped past the first version:
 * RemoteTriggerTool.test.ts did `require()` the real module and spread it — a
 * COMPLETE surface, so no missing exports — but then pinned `getOauthConfig`
 * with no `reset()`, leaving the override installed for every later file in
 * the shard. Complete-but-stuck is the second failure mode this ratchet
 * exists for, and writing the factory as a block hid it from the count.
 */
const INLINE_MOCK_RE =
  /\bmock\.module\(\s*['"]([^'"]+)['"]\s*,\s*\(\s*\)\s*=>\s*[({]/g

/**
 * Specifiers that resolve to a module in this repository. Everything else
 * (npm packages, `node:*`, `bun:*`) is out of scope.
 */
function isInternalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('src/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('tests/') ||
    specifier.startsWith('@open-claude-code/')
  )
}

/**
 * A helper factory handed straight to `mock.module`, with no handle kept.
 *
 *   mock.module('src/utils/auth/auth.js', authMockWith({ … }))
 *   mock.module('src/utils/auth/auth.js', authMock)
 *
 * The inline rule above deliberately exempts helper factories, because a
 * helper builds a COMPLETE surface and completeness was the whole problem it
 * was written for. That exemption turns out to cover a second failure mode it
 * never checked: a factory passed this way has no `reset()`, no handle, no
 * `afterAll` — nothing that can put the real module back. `mock.module` is
 * process-global, so the fake surface is simply what that module IS for every
 * file loaded after this one.
 *
 * For a delegating helper that is survivable. For `tests/mocks/auth.ts` it is
 * not: its surface is fake by design (the real module reads the macOS keychain
 * and refreshes AWS/GCP credentials when CALLED, so it must never delegate),
 * which means what leaks is a working-looking set of fake credentials.
 * skillLearning's REAL `queryHaiku` picked those up from a file that ran
 * earlier in the shard and sent the fake token on a real HTTPS request —
 * a mock in one suite making a network call on behalf of another.
 *
 * Overrides or not makes no difference and neither form is exempt: a bare
 * `authMockWith()` installs the same unremovable fake surface, and `authMock`
 * is exactly that bare call, exported as a constant. The alias list is read
 * out of tests/mocks/ rather than hardcoded so a future
 * `export const fooMock = fooMockWith()` is covered on the day it is written.
 *
 * The fix is the same one tests/mocks/auth.ts documents: `setupAuthMock({ … })`
 * — or `makeSharedModuleMock(spec, real).setup({ … })` for a module with no
 * wrapper yet — bound to a handle, `reset()` in `afterAll`.
 *
 * Known gap: both arms match on the name as written at the call site, so
 * `import { authMock as x }` slips through. Left alone deliberately — text
 * scanning cannot follow a rename without a resolver, and someone renaming a
 * mock helper on import to get past a lint rule is a different problem than
 * the one this file is for.
 */
const MOCK_MODULE_HELPER_RE =
  /\bmock\.module\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*(\(?)/g

/** `export const authMock = authMockWith()` in tests/mocks — pre-called factories. */
const FACTORY_ALIAS_RE =
  /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\w*MockWith\(/g

function findFactoryAliases(): Set<string> {
  const aliases = new Set<string>()
  for (const file of new Glob('tests/mocks/**/*.ts').scanSync(PROJECT_ROOT)) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    for (const match of source.matchAll(FACTORY_ALIAS_RE)) {
      const name = match[1]
      if (name !== undefined) aliases.add(name)
    }
  }
  return aliases
}

/**
 * `setupSettingsMock({ … })` / `makeSharedModuleMock(…).setup({ … })` — the
 * shared helper used correctly in shape, but with the overrides installed at
 * module load. A file doing this and never calling `reset()` leaves its
 * overrides in place for every later file in the shard, which is the same leak
 * as an inline surface even though the surface itself is complete. `setup()`
 * with no argument is fine: it installs the all-real delegating surface.
 */
// Every override-installing setup call, whatever it is spelled on top of:
//
//   setupSettingsMock({ … })                       helper entry point
//   makeSharedModuleMock('x', real).setup({ … })   wrapped in place
//   someHandle.setup({ … })                        handle stored first
//
// `setup()` with no argument is absent on purpose: it installs the all-real
// delegating surface, which is nothing to leak.
//
// Known gap, and the one place that reasoning does not hold: `setupAuthMock()`.
// tests/mocks/auth.ts has no all-real baseline to fall back to — the real
// module reads the keychain when called — so its ACTIVE surface is complete
// fakes whether or not overrides were passed, and a bare call leaks the same
// fake credentials as any other. Not special-cased here: telling the two kinds
// of helper apart from the outside needs a heuristic ("the module also exports
// a *MockWith builder"), which is one delegating wrapper away from being
// wrong. The cheap fix is on the other side — drop the `= {}` default on
// setupAuthMock's parameter and every call site lands back inside the rule
// below, since `setupAuthMock({})` matches this pattern like any other.
const SETUP_CALL_RE = /(?:\.setup|\bsetup[A-Za-z]*Mock)\(\s*\{/g

// Read backwards from the START of the whole receiver expression, so
// `const m = makeSharedModuleMock(\n  'x',\n  real,\n).setup({` is seen as the
// binding it is. `const` is not required: a plain reassignment still names
// something that can be reset. The optional annotation deliberately excludes
// quotes, parens and newlines — it is there for `const m: Handle =`, not to
// let the match wander backwards across half a file.
const SETUP_BINDING_RE =
  /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=;{}()'"\n]*)?=\s*$/

const IDENT_TAIL_RE = /[A-Za-z_$][\w$]*$/

/**
 * Comment bodies and string contents replaced by spaces, offsets and line
 * breaks preserved.
 *
 * Reading code backwards means prose gets read as code unless it is taken out
 * first, and the prose in these files is *about* mocks, so it is full of the
 * exact tokens being matched. Both hazards showed up the first time this ran:
 *
 *   "// … poison later files in the same process: on Linux ordering, …"
 *        `process:` read as a binding with a type annotation, so the real
 *        `const sharedMock =` two lines down never got the credit.
 *   "// … never see a partial surface.\nmakeSharedModuleMock(…)"
 *        the full stop ending the sentence read as a member access, so the
 *        walk kept going left into the comment.
 *
 * Blanking rather than deleting keeps every index equal to the raw source, so
 * a match found in one can be located in the other. Regex literals are not
 * modelled; a quote inside one would mis-pair, and none exists here.
 */
function blankNoise(source: string): string {
  const out = [...source]
  const blank = (index: number): void => {
    if (source[index] !== '\n') out[index] = ' '
  }
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') blank(i++)
      continue
    }
    if (char === '/' && next === '*') {
      blank(i++)
      while (
        i < source.length &&
        !(source[i] === '*' && source[i + 1] === '/')
      ) {
        blank(i++)
      }
      blank(i++)
      blank(i++)
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      i++ // the opening quote stays, so the literal is still delimited
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\') blank(i++)
        blank(i++)
      }
      i++ // and so does the closing one
      continue
    }
    i++
  }
  return out.join('')
}

/** Index of the `(` that `source[closeIndex]` closes, or -1. */
function matchingOpenParen(source: string, closeIndex: number): number {
  let depth = 0
  for (let i = closeIndex; i >= 0; i--) {
    const char = source[i]
    if (char === ')') depth++
    else if (char === '(') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Walk back from a `.setup(`/`setupXMock(` token to where its expression
 * starts, hopping over balanced call parens and member chains.
 *
 * This exists because the previous version pattern-matched the START of the
 * line instead. `.setup({` sitting after a `)` — which is what
 * `makeSharedModuleMock(` written across four lines produces, the house style
 * for any module without a wrapper — anchored to neither `^` nor `[;\n]\s*`,
 * so every one of them scored 0 whether or not it was ever reset. Two
 * unresettable installs in usage.test.ts sat in the blind spot that way.
 *
 * Walking the expression rather than the line also makes the named/anonymous
 * split a single decision instead of two regexes racing to claim the same
 * site, so a binding can never be counted twice.
 */
function setupExpressionStart(source: string, tokenStart: number): number {
  let start = tokenStart
  // Bounded: each hop moves strictly left, and no expression in a test file
  // chains anywhere near this deep.
  for (let hop = 0; hop < 64; hop++) {
    let cursor = start
    while (cursor > 0 && /\s/.test(source[cursor - 1] as string)) cursor--
    if (cursor > 0 && source[cursor - 1] === ')') {
      const open = matchingOpenParen(source, cursor - 1)
      if (open < 0) return start
      start = open
      continue
    }
    const ident = IDENT_TAIL_RE.exec(source.slice(0, cursor))
    if (ident === null || ident.index >= cursor) return start
    start = ident.index
    let beforeIdent = start
    while (beforeIdent > 0 && /\s/.test(source[beforeIdent - 1] as string)) {
      beforeIdent--
    }
    // A member access keeps the chain alive (`foo.bar(…).setup({ … })`).
    if (beforeIdent > 0 && source[beforeIdent - 1] === '.') {
      start = beforeIdent - 1
      continue
    }
    return start
  }
  return start
}

/**
 * Overrides installed at load with no way to take them back down again.
 *
 * Bound to a name, the file owes a `reset()` for THAT name specifically. The
 * first version tested for ANY `.reset()` in the file and zeroed the whole
 * count, which is exactly the hole that let framework.test.ts through — it
 * reset one of its two helpers and scored 0, while the other one's
 * `enqueuePendingNotification: noop` stayed installed for the rest of the
 * process. Bound to nothing, there is no name to reset and it counts outright.
 *
 * Takes the blankNoise()'d source, not the raw one.
 */
function countUnscoped(code: string): number {
  let unscoped = 0
  for (const match of code.matchAll(SETUP_CALL_RE)) {
    const start = setupExpressionStart(code, match.index)
    const variable = SETUP_BINDING_RE.exec(code.slice(0, start))?.[1]
    if (variable === undefined) {
      unscoped++
      continue
    }
    if (!new RegExp(`\\b${variable}\\.reset\\(\\s*\\)`).test(code)) unscoped++
  }
  return unscoped
}

/**
 * Mocking a re-export shim.
 *
 * Several `src/` modules exist only to forward a workspace package —
 * `src/Tool.ts` over `@open-claude-code/tool-runtime/Tool.js`,
 * `src/utils/runtime/errors.ts` over `.../errors.js`, and so on. On Linux (but
 * NOT on macOS) `mock.module('src/Tool.js', …)` replaces the underlying
 * package module too, so the stub reaches every consumer that imports the
 * package path directly.
 *
 * That cost two CI rounds each time it fired:
 *   findToolByName: () => {}   → SearchExtraToolsTool's select: found nothing
 *   AbortError: class …        → AggregateSearchAdapter swallowed the abort
 *
 * Both were invisible locally — the same preload on macOS shows no effect at
 * all — so this rule is static rather than something a test could catch. Mock
 * the package specifier directly, or (usually better) don't mock these at all:
 * shims forward pure, dependency-free code.
 */
// `export … from '@open-claude-code/…'` only — a plain `import` from a package
// is ordinary consumption and carries no penetration hazard. It is re-export
// forwarding, where the shim's exports ARE the package's bindings, that makes
// mocking one replace the other.
const SHIM_MARKER_RE = /\bexport\s[^;]*?from\s+'@open-claude-code\//

function findReExportShims(): Set<string> {
  const shims = new Set<string>()
  for (const file of new Glob('src/**/*.ts').scanSync(PROJECT_ROOT)) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    if (!SHIM_MARKER_RE.test(source)) continue
    // Normalised to the extensionless module path so both `src/Tool.js` and
    // `src/Tool.ts` spellings of the mock specifier match.
    shims.add(file.replaceAll('\\', '/').replace(/\.tsx?$/, ''))
  }
  return shims
}

interface Offender {
  /** Path relative to the project root, so it is copy-pasteable. */
  file: string
  /** Inline `mock.module` surfaces for repo modules. */
  specifiers: string[]
  /** Shared-helper overrides installed at load with no `reset()` anywhere. */
  unscoped: number
  /** `mock.module` specifiers that resolve to a re-export shim. */
  shims: string[]
  /** Helper factories handed to `mock.module` with no handle to reset. */
  factories: string[]
}

/**
 * A `mock.module` on a re-export shim whose factory is written out by hand.
 *
 * Helper-based factories (`stateMockWith({ … })`) are NOT flagged: those build
 * a complete surface that delegates every non-overridden export to the real
 * module, so replacing the package module with it preserves behaviour. What
 * broke CI twice was a hand-written STUB on a shim — `findToolByName: () => {}`
 * and `AbortError: class extends Error {}` — where the package's real
 * implementation is gone and every later consumer in the shard gets the stub.
 *
 * Flagging the safe form too would put 7 correct call sites in the report, and
 * a ratchet that cries wolf gets muted.
 */
const INLINE_SHIM_MOCK_RE =
  /\bmock\.module\(\s*['"]([^'"]+)['"]\s*,\s*\(\s*\)\s*=>\s*\(\s*\{/g

function scan(): {
  offenders: Offender[]
  total: number
  unscoped: number
  shims: number
  factories: number
} {
  const shimModules = findReExportShims()
  const factoryAliases = findFactoryAliases()
  const files = new Set<string>()
  for (const pattern of TEST_GLOBS) {
    for (const file of new Glob(pattern).scanSync(PROJECT_ROOT)) {
      files.add(file)
    }
  }

  const offenders: Offender[] = []
  let total = 0
  let unscopedTotal = 0
  let shimTotal = 0
  let factoryTotal = 0

  for (const file of [...files].sort()) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    const specifiers: string[] = []
    for (const match of source.matchAll(INLINE_MOCK_RE)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      if (!isInternalSpecifier(specifier)) continue
      specifiers.push(specifier)
    }
    // Indices line up with `source`, so a match found there can be tested for
    // "is this live code or a worked example in a comment" by position.
    const code = blankNoise(source)
    const factories: string[] = []
    for (const match of source.matchAll(MOCK_MODULE_HELPER_RE)) {
      const specifier = match[1]
      const helper = match[2]
      if (specifier === undefined || helper === undefined) continue
      if (!isInternalSpecifier(specifier)) continue
      if (code[match.index] !== source[match.index]) continue
      const called = match[3] === '('
      if (called && helper.endsWith('MockWith')) {
        factories.push(`mock.module('${specifier}', ${helper}({ … }))`)
      } else if (!called && factoryAliases.has(helper)) {
        factories.push(`mock.module('${specifier}', ${helper})`)
      }
    }
    const shims: string[] = []
    for (const match of source.matchAll(INLINE_SHIM_MOCK_RE)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      if (shimModules.has(specifier.replace(/\.(ts|tsx|js|jsx)$/, ''))) {
        shims.push(specifier)
      }
    }
    const unscoped = countUnscoped(code)
    if (
      specifiers.length > 0 ||
      unscoped > 0 ||
      shims.length > 0 ||
      factories.length > 0
    ) {
      // Path separators are normalised so the budget file is identical on
      // Windows checkouts.
      offenders.push({
        file: file.replaceAll('\\', '/'),
        specifiers,
        unscoped,
        shims,
        factories,
      })
      total += specifiers.length
      unscopedTotal += unscoped
      shimTotal += shims.length
      factoryTotal += factories.length
    }
  }

  return {
    offenders,
    total,
    unscoped: unscopedTotal,
    shims: shimTotal,
    factories: factoryTotal,
  }
}

/**
 * Per file: `[inline mock.module surfaces, unreset shared-helper overrides,
 * re-export-shim mocks, unresettable helper-factory installs]`. A tuple rather
 * than one number so converting a violation of one kind into another cannot
 * pass silently.
 */
type Budget = Record<string, [number, number, number, number]>

/**
 * Short tuples are read as trailing zeros. The fourth slot was appended after
 * the file already existed in three-slot form, and a checkout that straddles
 * that commit — a rebase, a bisect, a branch that predates it — must not read
 * "no entry for the new rule" as "budget file is corrupt" and silently reset
 * every count to zero.
 */
function readBudget(): Budget {
  let raw: Record<string, number[]>
  try {
    raw = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Record<
      string,
      number[]
    >
  } catch {
    return {}
  }
  const budget: Budget = {}
  for (const [file, counts] of Object.entries(raw)) {
    const [inline = 0, unscoped = 0, shim = 0, factory = 0] = counts ?? []
    budget[file] = [inline, unscoped, shim, factory]
  }
  return budget
}

/** Biome's default line width, which decides whether a tuple gets its own line. */
const LINE_WIDTH = 80

/**
 * Serialised the way `biome format` writes it, so `--update` output is
 * commit-ready as it lands.
 *
 * `JSON.stringify(budget, null, 2)` puts every count on a line of its own, and
 * biome re-flows that into either `"file": [0, 0, 0, 1]` or, when the path
 * makes the line too long, the same tuple on one indented continuation line.
 * The file was `{}` while it had no entries, so the two agreed and the
 * difference never showed. It would have shown the moment someone followed the
 * failure message: run --update, commit, watch CI fail on the formatting of a
 * file the tool had just generated for them.
 */
function serialiseBudget(budget: Budget): string {
  const entries = Object.entries(budget)
  if (entries.length === 0) return '{}\n'
  const lines = entries.map(([file, counts], index) => {
    const comma = index === entries.length - 1 ? '' : ','
    const head = `  ${JSON.stringify(file)}: `
    const tuple = counts.join(', ')
    const flat = `${head}[${tuple}]${comma}`
    return flat.length <= LINE_WIDTH
      ? flat
      : `${head}[\n    ${tuple}\n  ]${comma}`
  })
  return `{\n${lines.join('\n')}\n}\n`
}

function writeBudget(offenders: Offender[]): void {
  const budget: Budget = {}
  for (const offender of offenders) {
    budget[offender.file] = [
      offender.specifiers.length,
      offender.unscoped,
      offender.shims.length,
      offender.factories.length,
    ]
  }
  writeFileSync(BUDGET_FILE, serialiseBudget(budget))
}

function printHint(): void {
  console.error('')
  console.error('  Route the mock through tests/mocks/ instead:')
  console.error('')
  console.error(
    "    import { setupSettingsMock } from '../../../tests/mocks/settings.js'",
  )
  console.error(
    '    const settingsMock = setupSettingsMock()   // all-real surface',
  )
  console.error(
    '    beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))',
  )
  console.error('    afterAll(() => settingsMock.reset())')
  console.error('')
  console.error('  For a module with no wrapper yet, wrap it in place:')
  console.error('')
  console.error("    import * as real from 'src/utils/process/platform.js'")
  console.error(
    "    import { makeSharedModuleMock } from 'tests/mocks/sharedModuleMock.js'",
  )
  console.error(
    "    const m = makeSharedModuleMock('src/utils/process/platform.js', real).setup()",
  )
  console.error('')
  console.error('  See scripts/check-mock-hygiene.ts for why this matters.')
}

/**
 * The same module mocked under two extensions.
 *
 * `mock.module('x.js', …)` and `mock.module('x.ts', …)` land on the SAME
 * registry entry — verified, not assumed: registering under `.js` and then
 * importing `./target.ts` returns the mock. So two files that each install a
 * different partial surface, one writing `.js` and one writing `.ts`, are in
 * a last-write-wins fight while *reading* as though they touch different
 * modules. That is the hardest form of this bug to spot in review, and no
 * amount of per-file inspection reveals it.
 *
 * Zero tolerance, no budget: the whole repo was already consistent after the
 * seven `.js` stragglers were normalised, and a collision is never the right
 * thing to introduce. Real files are all `.ts`, which is also what CLAUDE.md
 * prescribes.
 */
function findExtensionCollisions(files: Set<string>): Map<string, Set<string>> {
  const byModule = new Map<string, Set<string>>()
  for (const file of files) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    for (const match of source.matchAll(
      /\bmock\.module\(\s*['"]([^'"]+)['"]/g,
    )) {
      const specifier = match[1]
      if (specifier === undefined || !isInternalSpecifier(specifier)) continue
      // Three spellings, one registry entry: `x.ts`, `x.js` and bare `x` all
      // resolve to the same module — the bare form was verified the same way
      // as the extension pair (register `./target`, import `./target.ts`,
      // get the mock). So "no extension" is a variant like any other.
      //
      // Relative specifiers are resolved against the mocking file so
      // `../../session/messageQueueManager` and the alias form
      // `src/utils/session/messageQueueManager.js` compare as one module —
      // otherwise the most common way to spell the same target twice slips
      // straight through.
      //
      // Known gap: `src/foo` and `src/foo/index.ts` also resolve alike but
      // normalise differently here. Not worth modelling — it needs the
      // resolver, and the extension case is the one that actually occurred.
      const parsed = /^(.*)\.(ts|tsx|js|jsx)$/.exec(specifier)
      const bare = parsed?.[1] ?? specifier
      const module = bare.startsWith('.')
        ? relative(
            PROJECT_ROOT,
            resolve(dirname(join(PROJECT_ROOT, file)), bare),
          ).replaceAll('\\', '/')
        : bare
      const extension = parsed?.[2] ?? '(none)'
      const seen = byModule.get(module) ?? new Set<string>()
      seen.add(extension)
      byModule.set(module, seen)
    }
  }
  return new Map([...byModule].filter(([, exts]) => exts.size > 1))
}

function main(): void {
  const update = process.argv.includes('--update')
  const { offenders, total, unscoped, shims, factories } = scan()

  const allTestFiles = new Set<string>()
  for (const pattern of TEST_GLOBS) {
    for (const file of new Glob(pattern).scanSync(PROJECT_ROOT)) {
      allTestFiles.add(file)
    }
  }
  const collisions = findExtensionCollisions(allTestFiles)
  if (collisions.size > 0) {
    console.error(
      `✗ mock hygiene: ${collisions.size} module(s) mocked under two extensions.`,
    )
    console.error('')
    console.error(
      "  `mock.module('x.js', …)` and `mock.module('x.ts', …)` share ONE registry",
    )
    console.error(
      '  entry, so these are competing surfaces for the same module — they just',
    )
    console.error('  do not look like it. Use the .ts form everywhere.')
    console.error('')
    for (const [module, exts] of collisions) {
      console.error(`  ${module}  →  ${[...exts].sort().join(', ')}`)
    }
    process.exit(1)
  }

  if (update) {
    writeBudget(offenders)
    console.log(
      `Updated ${BUDGET_FILE.replace(`${PROJECT_ROOT}/`, '')}: ${total} inline surface(s) + ${unscoped} unreset override(s) + ${shims} shim mock(s) + ${factories} unresettable factory install(s) across ${offenders.length} file(s).`,
    )
    return
  }

  const budget = readBudget()
  const current = new Map(
    offenders.map(
      o =>
        [
          o.file,
          [o.specifiers.length, o.unscoped, o.shims.length, o.factories.length],
        ] as const,
    ),
  )

  const addedInline: Offender[] = []
  const addedUnscoped: Offender[] = []
  const addedShims: Offender[] = []
  const addedFactories: Offender[] = []
  for (const offender of offenders) {
    const [inlineAllowed, unscopedAllowed, shimAllowed, factoryAllowed] =
      budget[offender.file] ?? [0, 0, 0, 0]
    if (offender.specifiers.length > inlineAllowed) addedInline.push(offender)
    if (offender.unscoped > unscopedAllowed) addedUnscoped.push(offender)
    if (offender.shims.length > shimAllowed) addedShims.push(offender)
    if (offender.factories.length > factoryAllowed) {
      addedFactories.push(offender)
    }
  }

  const removed: string[] = []
  for (const [
    file,
    [inlineAllowed, unscopedAllowed, shimAllowed, factoryAllowed],
  ] of Object.entries(budget)) {
    const [inlineNow, unscopedNow, shimNow, factoryNow] = current.get(file) ?? [
      0, 0, 0, 0,
    ]
    if (inlineNow < inlineAllowed) {
      removed.push(`${file}  inline ${inlineAllowed} → ${inlineNow}`)
    }
    if (unscopedNow < unscopedAllowed) {
      removed.push(`${file}  unreset ${unscopedAllowed} → ${unscopedNow}`)
    }
    if (shimNow < shimAllowed) {
      removed.push(`${file}  shim ${shimAllowed} → ${shimNow}`)
    }
    if (factoryNow < factoryAllowed) {
      removed.push(`${file}  factory ${factoryAllowed} → ${factoryNow}`)
    }
  }

  // Every violated rule is printed before exiting rather than the first one
  // only. With four rules in play a first-one-wins report sends whoever is
  // clearing them round the loop once per category, and the categories are
  // usually one edit apart.
  let failed = false

  if (addedShims.length > 0) {
    failed = true
    console.error(
      `✗ mock hygiene: ${addedShims.length} file(s) mock a re-export shim.`,
    )
    console.error('')
    console.error(
      '  On Linux — but not macOS — mocking a src/ barrel replaces the workspace',
    )
    console.error(
      '  package module it forwards, so the stub reaches every consumer that',
    )
    console.error(
      '  imports the package path directly. Mock the package specifier instead,',
    )
    console.error(
      '  or drop the mock: shims forward pure, dependency-free code.',
    )
    console.error('')
    for (const offender of addedShims.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${offender.file}`)
      for (const specifier of offender.shims) {
        console.error(`      mock.module('${specifier}', …)`)
      }
    }
  }

  if (addedInline.length > 0) {
    failed = true
    console.error(
      `✗ mock hygiene: ${addedInline.length} file(s) added an inline mock.module surface for a repo module.`,
    )
    console.error('')
    console.error(
      '  Bun runs a whole shard in one process and mock.module is global, so this',
    )
    console.error(
      '  surface is installed for every test file loaded afterwards — not just yours.',
    )
    console.error('')
    for (const offender of addedInline.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${offender.file}`)
      for (const specifier of offender.specifiers) {
        console.error(`      mock.module('${specifier}', () => ({ … }))`)
      }
    }
    if (addedInline.length > SAMPLE_SIZE) {
      console.error(`  … and ${addedInline.length - SAMPLE_SIZE} more`)
    }
    printHint()
  }

  if (addedUnscoped.length > 0) {
    failed = true
    console.error(
      `✗ mock hygiene: ${addedUnscoped.length} file(s) install shared-mock overrides at load and never reset them.`,
    )
    console.error('')
    console.error(
      '  A complete surface still leaks if the OVERRIDE outlives the suite — that is',
    )
    console.error(
      '  exactly how changeDetector.test.ts broke. Move the overrides into beforeAll',
    )
    console.error('  and add `afterAll(() => mock.reset())`.')
    console.error('')
    for (const offender of addedUnscoped.slice(0, SAMPLE_SIZE)) {
      console.error(
        `  ${offender.file}  (${offender.unscoped} override site(s), no reset())`,
      )
    }
    if (addedUnscoped.length > SAMPLE_SIZE) {
      console.error(`  … and ${addedUnscoped.length - SAMPLE_SIZE} more`)
    }
    printHint()
  }

  if (addedFactories.length > 0) {
    failed = true
    console.error(
      `✗ mock hygiene: ${addedFactories.length} file(s) hand a helper factory to mock.module with no handle to reset.`,
    )
    console.error('')
    console.error(
      '  `mock.module(spec, authMockWith({ … }))` keeps nothing to call reset() on,',
    )
    console.error(
      '  so the surface it installs is that module for the whole rest of the shard.',
    )
    console.error(
      "  tests/mocks/auth.ts's surface is fake by design, and those fake credentials",
    )
    console.error(
      "  once reached skillLearning's REAL queryHaiku, which put the token on a real",
    )
    console.error(
      '  HTTPS request. Use the setup()/reset() form, which can be taken back down:',
    )
    console.error('')
    console.error(
      "    import { setupAuthMock } from '../../../tests/mocks/auth.js'",
    )
    console.error('    const authMock = setupAuthMock({ /* overrides */ })')
    console.error('    afterAll(() => authMock.reset())')
    console.error('')
    for (const offender of addedFactories.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${offender.file}`)
      for (const factory of offender.factories) {
        console.error(`      ${factory}`)
      }
    }
    if (addedFactories.length > SAMPLE_SIZE) {
      console.error(`  … and ${addedFactories.length - SAMPLE_SIZE} more`)
    }
  }

  if (removed.length > 0) {
    failed = true
    console.error(
      `✗ mock hygiene: ${removed.length} entr(ies) dropped below the recorded baseline.`,
    )
    console.error('')
    console.error(
      '  Good change — commit the lower baseline in the same PR so it cannot regress:',
    )
    console.error('')
    console.error('    bun run scripts/check-mock-hygiene.ts --update')
    console.error('')
    for (const entry of removed.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${entry}`)
    }
    if (removed.length > SAMPLE_SIZE) {
      console.error(`  … and ${removed.length - SAMPLE_SIZE} more`)
    }
  }

  if (failed) process.exit(1)

  console.log(
    `✓ mock hygiene: ${total} inline + ${unscoped} unreset + ${shims} shim + ${factories} factory install(s) across ${offenders.length} file(s), none added.`,
  )
}

main()
