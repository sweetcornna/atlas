#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Third-party SBOM and license inventory for the WHOLE repository.
 *
 * Scope is deliberately the entire dependency tree — the base's dependencies
 * included, not just `@qianmo/*`. Roadmap P8.4 says so in as many words, and
 * the reason is that the product ships the base: `dist/qm-<target>` is one
 * compiled binary holding qm, the oh-my-pi CLI and every library either
 * touches, regardless of which package.json field declared it. The Rust half
 * of the base (the `pi_natives` addon, embedded in that binary) is covered by
 * omp's own `about.toml` / `THIRD-PARTY-NOTICES.txt`, which this report points
 * at rather than re-deriving.
 *
 * ── Sources of truth ──────────────────────────────────────────────────────
 *
 *   bun.lock       the component set and the dependency graph. It is JSONC
 *                  (trailing commas), so `JSON.parse` cannot read it; Bun's
 *                  built-in `Bun.JSONC.parse` does — no third-party parser.
 *   package.json   `workspaces.catalog` — workspace manifests declare many
 *                  dependencies as `catalog:`; the report shows the concrete
 *                  range the catalog resolves to, not the indirection.
 *   node_modules   the `license` field only. The repository installs with
 *                  `linker = "hoisted"` (bunfig.toml): one flat `node_modules`
 *                  plus nested copies where versions clash, indexed by
 *                  `name@version`. The walk also understands the isolated
 *                  `.bun/` store layout, so a local `--linker isolated`
 *                  install does not silently shrink the report.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 *
 * The outputs carry NO timestamp. `bun run atlas:sbom` on an unchanged tree must
 * rewrite the same bytes, otherwise the "regenerate and diff" review workflow
 * is useless. The lockfile's SHA-256 is recorded instead, which pins the input
 * without dating the output.
 *
 * ── Outputs ───────────────────────────────────────────────────────────────
 *
 *   docs/dev/sbom-m0.json   CycloneDX 1.5-shaped minimal BOM (hand-built; a
 *                           CycloneDX library would be a new dependency for a
 *                           document we emit once)
 *   docs/dev/sbom-m0.md     human-readable audit: license distribution, the
 *                           copyleft scan that P8.4's DoD turns on, the
 *                           missing/non-SPDX backlog, prebuilt-binary
 *                           provenance, and the workspace package roster
 *
 * Usage:
 *   bun run atlas:sbom      regenerate both files
 *   bun run atlas:sbom -- --check
 *                           regenerate, then exit 1 if any strong/network
 *                           copyleft or field-of-use-restricted component is
 *                           present (the machine-judgeable half of the DoD)
 */

import { createHash } from 'node:crypto'
import ompPin from '../upstream/omp.json'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const LOCKFILE = join(REPO_ROOT, 'bun.lock')
const NODE_MODULES = join(REPO_ROOT, 'node_modules')
const JSON_OUT = join(REPO_ROOT, 'docs', 'dev', 'sbom-m0.json')
const MD_OUT = join(REPO_ROOT, 'docs', 'dev', 'sbom-m0.md')

/**
 * Base pin, restated from BASE.md for the BOM metadata. Do not edit BASE.md.
 * Version and snapshot tag come from the same pin (`atlas/upstream/omp.json`).
 */
const BASE_PIN = ompPin.commit
const BASE_TAG = `v${ompPin.version}`

// ───────────────────────────── license classification ─────────────────────

export type LicenseTier =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'network-copyleft'
  | 'restricted'
  | 'unknown'

/**
 * Severity order. `OR` picks the minimum (we may choose the friendliest
 * branch), `AND` takes the maximum (every obligation applies at once).
 * `unknown` sits above `restricted` on purpose: an unreadable field must never
 * be allowed to look safer than a field that plainly says "no".
 */
const TIER_RANK: Record<LicenseTier, number> = {
  permissive: 0,
  'weak-copyleft': 1,
  'strong-copyleft': 2,
  'network-copyleft': 3,
  restricted: 4,
  unknown: 5,
}

const TIER_BY_RANK: LicenseTier[] = [
  'permissive',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'restricted',
  'unknown',
]

export const CONTAGIOUS_TIERS: ReadonlySet<LicenseTier> = new Set<LicenseTier>([
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
])

type FamilyRule = { match: RegExp; tier: LicenseTier; note?: string }

/**
 * Order matters — the first match wins. Narrow ids come before the family
 * prefixes they would otherwise be swallowed by (CC-BY-SA before CC-BY,
 * LGPL before GPL, CECILL-C before CECILL).
 */
const LICENSE_FAMILIES: FamilyRule[] = [
  // Network copyleft: obligations trigger on network use, not just on
  // shipping bytes. A resident agent network is exactly the deployment shape
  // these were written for, so they are the ones that matter most here.
  { match: /^AGPL(-|$)/i, tier: 'network-copyleft' },
  { match: /^SSPL(-|$)/i, tier: 'network-copyleft' },
  {
    match: /^OSL(-|$)/i,
    tier: 'network-copyleft',
    note: 'OSL 把「对外提供服务」视同分发',
  },
  {
    match: /^EUPL(-|$)/i,
    tier: 'network-copyleft',
    note: 'EUPL-1.2 含网络分发条款',
  },
  { match: /^RPL(-|$)/i, tier: 'network-copyleft' },

  // Strong copyleft.
  { match: /^LGPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^GFDL(-|$)/i, tier: 'strong-copyleft', note: '文档类 copyleft' },
  { match: /^GPL(-|$)/i, tier: 'strong-copyleft' },
  { match: /^CC-BY-SA(-|$)/i, tier: 'strong-copyleft', note: 'share-alike' },
  { match: /^CECILL-C$/i, tier: 'weak-copyleft' },
  { match: /^CECILL(-|$)/i, tier: 'strong-copyleft' },
  { match: /^Sleepycat$/i, tier: 'strong-copyleft' },
  { match: /^QPL(-|$)/i, tier: 'strong-copyleft' },
  { match: /^Parity(-|$)/i, tier: 'strong-copyleft' },

  // Weak / file-level copyleft: obligations stop at the modified file, so an
  // unmodified dependency is normally fine. Still listed — P8.4 asks for the
  // full CDDL/MPL/EPL sweep, not only the GPL family.
  { match: /^MPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^EPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^CPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^CDDL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^MS-RL$/i, tier: 'weak-copyleft' },
  { match: /^APSL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^IPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^SISSL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^Artistic-1/i, tier: 'weak-copyleft' },
  { match: /^Artistic-2\.0$/i, tier: 'weak-copyleft', note: 'GPL 兼容' },

  // Field-of-use restrictions — not copyleft, but not usable either.
  { match: /^CC-BY-NC/i, tier: 'restricted', note: '禁止商业使用' },
  { match: /^CC-BY-ND/i, tier: 'restricted', note: '禁止演绎' },
  { match: /^UNLICENSED$/i, tier: 'restricted', note: '专有/未授权' },
  { match: /^JSON$/i, tier: 'restricted', note: '含 "Good, not Evil" 条款' },
  { match: /^Commons-Clause$/i, tier: 'restricted' },

  // Permissive.
  { match: /^MIT(-0)?$/i, tier: 'permissive' },
  { match: /^ISC$/i, tier: 'permissive' },
  { match: /^0BSD$/i, tier: 'permissive' },
  { match: /^BSD-\d(-Clause)?/i, tier: 'permissive' },
  { match: /^Apache-\d/i, tier: 'permissive' },
  { match: /^Unlicense$/i, tier: 'permissive' },
  { match: /^CC0-1\.0$/i, tier: 'permissive' },
  { match: /^CC-BY-\d/i, tier: 'permissive', note: '仅署名要求' },
  { match: /^WTFPL$/i, tier: 'permissive' },
  { match: /^Zlib(-|$)/i, tier: 'permissive' },
  { match: /^libpng(-|$)/i, tier: 'permissive' },
  { match: /^X11$/i, tier: 'permissive' },
  { match: /^PostgreSQL$/i, tier: 'permissive' },
  { match: /^(Python-2\.0|PSF-2\.0)$/i, tier: 'permissive' },
  { match: /^BlueOak-/i, tier: 'permissive' },
  { match: /^UPL-/i, tier: 'permissive' },
  { match: /^NCSA$/i, tier: 'permissive' },
  { match: /^BSL-1\.0$/i, tier: 'permissive', note: 'Boost' },
  { match: /^AFL-/i, tier: 'permissive' },
  { match: /^(Ruby|OpenSSL|curl|TCL|Vim|W3C|bzip2-)/i, tier: 'permissive' },
]

/**
 * Non-SPDX strings that npm packages actually ship. Every hit is also flagged
 * as "not SPDX" so the backlog table stays honest about what needed guessing.
 */
const LICENSE_ALIASES: Record<string, string> = {
  BSD: 'BSD-3-Clause',
  'NEW BSD': 'BSD-3-Clause',
  'BSD LICENSE': 'BSD-3-Clause',
  'MIT/X11': 'MIT',
  'MIT LICENSE': 'MIT',
  'THE MIT LICENSE': 'MIT',
  APACHE: 'Apache-2.0',
  'APACHE 2.0': 'Apache-2.0',
  'APACHE-2': 'Apache-2.0',
  'APACHE LICENSE 2.0': 'Apache-2.0',
  'APACHE LICENSE, VERSION 2.0': 'Apache-2.0',
  'PUBLIC DOMAIN': 'Unlicense',
  UNLICENSE: 'Unlicense',
  CC0: 'CC0-1.0',
  ZLIB: 'Zlib',
  EPL: 'EPL-1.0',
  MPL: 'MPL-2.0',
  LGPL: 'LGPL-3.0-or-later',
  GPL: 'GPL-3.0-or-later',
  AGPL: 'AGPL-3.0-or-later',
}

/**
 * Exceptions that specifically defuse the linking obligation. `GPL-2.0 WITH
 * Classpath-exception-2.0` does not infect a linking consumer, and treating it
 * as though it did would put a false positive in front of the reviewers whose
 * time this report is meant to save.
 */
const LINKING_EXCEPTIONS =
  /^(Classpath-exception|GCC-exception|LLVM-exception|Autoconf-exception|Bison-exception|Font-exception|libtool-exception|Universal-FOSS-exception|Linux-syscall-note|WxWindows-exception|GPL-3\.0-linking-exception|GPL-CC-1\.0)/i

export type LicenseIssue =
  | 'missing'
  | 'see-license-in'
  | 'unlicensed'
  | 'non-spdx'
  | 'unrecognized'

export type LicenseVerdict = {
  /** Exactly what package.json said, or '' when the field was absent. */
  raw: string
  tier: LicenseTier
  /** Every licence id seen in the expression, in source order. */
  ids: string[]
  /** Ids no family rule matched — these need a human. */
  unrecognized: string[]
  /** tier is weak/strong/network copyleft after OR-choice resolution. */
  contagious: boolean
  issues: LicenseIssue[]
  notes: string[]
}

type Token = { kind: 'id' | 'lparen' | 'rparen' | 'op'; value: string }

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expression.length) {
    const ch = expression[i] ?? ''
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: '(' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ')' })
      i++
      continue
    }
    let j = i
    while (j < expression.length && !/[\s()]/.test(expression[j] ?? '')) j++
    const word = expression.slice(i, j)
    i = j
    const upper = word.toUpperCase()
    if (upper === 'AND' || upper === 'OR' || upper === 'WITH') {
      tokens.push({ kind: 'op', value: upper })
    } else {
      tokens.push({ kind: 'id', value: word })
    }
  }
  return tokens
}

type Accumulator = {
  ids: string[]
  unrecognized: string[]
  notes: string[]
  aliased: boolean
}

function classifyId(id: string, acc: Accumulator): LicenseTier {
  const aliased = LICENSE_ALIASES[id.toUpperCase()]
  const effective = aliased ?? id.replace(/\+$/, '').replace(/\*$/, '')
  if (aliased !== undefined) {
    acc.aliased = true
    acc.notes.push(`「${id}」按 ${aliased} 归类`)
  }
  acc.ids.push(id)
  for (const rule of LICENSE_FAMILIES) {
    if (!rule.match.test(effective)) continue
    if (rule.note !== undefined) acc.notes.push(`${effective}：${rule.note}`)
    return rule.tier
  }
  acc.unrecognized.push(id)
  return 'unknown'
}

function downgrade(tier: LicenseTier): LicenseTier {
  const rank = TIER_RANK[tier]
  if (rank === 0 || rank > TIER_RANK['network-copyleft']) return tier
  return TIER_BY_RANK[rank - 1] ?? tier
}

/** Recursive descent over `or := and ('OR' and)*` etc. Evaluates as it goes. */
function parseExpression(tokens: Token[], acc: Accumulator): LicenseTier {
  let pos = 0

  function parseAtom(): LicenseTier {
    const token = tokens[pos]
    if (token === undefined) return 'unknown'
    if (token.kind === 'lparen') {
      pos++
      const inner = parseOr()
      if (tokens[pos]?.kind === 'rparen') pos++
      return inner
    }
    if (token.kind === 'id') {
      pos++
      return classifyId(token.value, acc)
    }
    // A stray operator: consume it so the loop terminates.
    pos++
    return 'unknown'
  }

  function parseWith(): LicenseTier {
    let tier = parseAtom()
    while (tokens[pos]?.kind === 'op' && tokens[pos]?.value === 'WITH') {
      pos++
      const exception = tokens[pos]
      if (exception?.kind === 'id') {
        pos++
        if (LINKING_EXCEPTIONS.test(exception.value)) {
          acc.notes.push(`例外 ${exception.value} 解除链接传染，降一档`)
          tier = downgrade(tier)
        } else {
          acc.notes.push(`例外 ${exception.value} 未识别，按原档保留`)
        }
      }
    }
    return tier
  }

  function parseAnd(): LicenseTier {
    let tier = parseWith()
    while (tokens[pos]?.kind === 'op' && tokens[pos]?.value === 'AND') {
      pos++
      const right = parseWith()
      tier = TIER_RANK[right] > TIER_RANK[tier] ? right : tier
    }
    return tier
  }

  function parseOr(): LicenseTier {
    let tier = parseAnd()
    while (tokens[pos]?.kind === 'op' && tokens[pos]?.value === 'OR') {
      pos++
      const right = parseAnd()
      tier = TIER_RANK[right] < TIER_RANK[tier] ? right : tier
    }
    return tier
  }

  return parseOr()
}

/**
 * Classify a package.json `license` string.
 *
 * Handles SPDX expressions (`(MIT OR Apache-2.0)`, `GPL-2.0 WITH
 * Classpath-exception-2.0`), the legacy free-text strings npm is full of, and
 * the two special values that mean "there is no usable grant here":
 * `UNLICENSED` and `SEE LICENSE IN <file>`.
 *
 * The OR handling is the part that keeps the copyleft scan usable: a dual
 * `(MIT OR GPL-2.0)` grant is NOT a contagion finding, because we can take the
 * MIT branch. Reporting it as one would bury the real hits.
 */
export function classifyLicense(
  raw: string | null | undefined,
): LicenseVerdict {
  const text = (raw ?? '').trim()
  const acc: Accumulator = {
    ids: [],
    unrecognized: [],
    notes: [],
    aliased: false,
  }

  if (text === '') {
    return {
      raw: '',
      tier: 'unknown',
      ids: [],
      unrecognized: [],
      contagious: false,
      issues: ['missing'],
      notes: [],
    }
  }

  if (/^SEE LICENSE IN\b/i.test(text)) {
    return {
      raw: text,
      tier: 'unknown',
      ids: [],
      unrecognized: [],
      contagious: false,
      issues: ['see-license-in', 'non-spdx'],
      notes: ['授权正文在包内文件中，需人工阅读'],
    }
  }

  if (/^UNLICENSED$/i.test(text)) {
    return {
      raw: text,
      tier: 'restricted',
      ids: ['UNLICENSED'],
      unrecognized: [],
      contagious: false,
      issues: ['unlicensed'],
      notes: ['显式声明未授权'],
    }
  }

  const tier = parseExpression(tokenize(text), acc)
  const issues: LicenseIssue[] = []
  if (acc.unrecognized.length > 0) issues.push('unrecognized')
  if (acc.aliased || acc.unrecognized.length > 0) issues.push('non-spdx')

  return {
    raw: text,
    tier,
    ids: acc.ids,
    unrecognized: acc.unrecognized,
    contagious: CONTAGIOUS_TIERS.has(tier),
    issues,
    notes: acc.notes,
  }
}

/** package.json may carry the modern `license` or the legacy `licenses` array. */
export function readLicenseField(pkg: unknown): string {
  if (!isRecord(pkg)) return ''
  const license = pkg['license']
  if (typeof license === 'string') return license
  if (isRecord(license) && typeof license['type'] === 'string') {
    return license['type']
  }
  const legacy = pkg['licenses']
  if (Array.isArray(legacy)) {
    const types = legacy
      .map(entry =>
        isRecord(entry) && typeof entry['type'] === 'string'
          ? entry['type']
          : typeof entry === 'string'
            ? entry
            : '',
      )
      .filter(value => value !== '')
    if (types.length === 1) return types[0] ?? ''
    if (types.length > 1) return `(${types.join(' OR ')})`
  }
  return ''
}

// ───────────────────────────── lockfile model ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type LockMeta = {
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  os: string[]
  cpu: string[]
}

const EMPTY_META: LockMeta = {
  dependencies: {},
  optionalDependencies: {},
  peerDependencies: {},
  os: [],
  cpu: [],
}

type Origin =
  | 'registry'
  | 'workspace'
  | 'root'
  | 'git'
  | 'tarball'
  | 'link'
  | 'alias'
  | 'other'

type Component = {
  key: string
  name: string
  version: string
  spec: string
  origin: Origin
  meta: LockMeta
  workspacePath: string | null
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string')
  return []
}

function readMeta(tuple: unknown[]): LockMeta {
  const found = tuple.find(isRecord)
  if (found === undefined) return EMPTY_META
  return {
    dependencies: stringMap(found['dependencies']),
    optionalDependencies: stringMap(found['optionalDependencies']),
    peerDependencies: stringMap(found['peerDependencies']),
    os: stringList(found['os']),
    cpu: stringList(found['cpu']),
  }
}

/** `@scope/name@spec` and `name@spec` both split at the first `@` after 0. */
function splitId(id: string): { name: string; spec: string } {
  const at = id.indexOf('@', id.startsWith('@') ? 1 : 0)
  if (at === -1) return { name: id, spec: '' }
  return { name: id.slice(0, at), spec: id.slice(at + 1) }
}

function classifyOrigin(spec: string): Origin {
  if (spec.startsWith('workspace:')) return 'workspace'
  if (spec.startsWith('root:')) return 'root'
  if (spec.startsWith('npm:')) return 'alias'
  if (spec.startsWith('git+') || spec.startsWith('github:')) return 'git'
  if (spec.startsWith('link:') || spec.startsWith('file:')) return 'link'
  if (spec.startsWith('http://') || spec.startsWith('https://'))
    return 'tarball'
  if (/^\d/.test(spec)) return 'registry'
  return 'other'
}

function versionOf(spec: string, origin: Origin): string {
  if (origin === 'registry') return spec
  if (origin === 'alias') {
    const target = spec.slice('npm:'.length)
    return splitId(target).spec || spec
  }
  return spec
}

/**
 * Lockfile keys mirror the node_modules tree: `a/b/c` is `c` nested under
 * `a/b`. Scoped names occupy two path parts but one segment.
 */
function splitKeySegments(key: string): string[] {
  if (key === '') return []
  const parts = key.split('/')
  const segments: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (part.startsWith('@') && i + 1 < parts.length) {
      segments.push(`${part}/${parts[i + 1]}`)
      i++
    } else {
      segments.push(part)
    }
  }
  return segments
}

/** Node-style lookup: nearest enclosing scope first, then outward to root. */
function resolveDependency(
  fromKey: string,
  depName: string,
  packages: Map<string, Component>,
): string | null {
  const segments = splitKeySegments(fromKey)
  for (let depth = segments.length; depth >= 0; depth--) {
    const candidate = [...segments.slice(0, depth), depName].join('/')
    if (packages.has(candidate)) return candidate
  }
  return null
}

type Workspace = {
  path: string
  name: string
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

type Lockfile = {
  workspaces: Workspace[]
  packages: Map<string, Component>
  sha256: string
}

/**
 * `workspaces.catalog` / `workspaces.catalogs` from the root package.json.
 * Workspace manifests write `"react": "catalog:"` (default catalog) or
 * `"x": "catalog:name"`; bun.lock keeps those strings verbatim, so without
 * resolving them the report would name the indirection, not the range.
 */
type Catalogs = {
  default: Record<string, string>
  named: Map<string, Record<string, string>>
}

async function readCatalogs(): Promise<Catalogs> {
  const manifest = await readJson(join(REPO_ROOT, 'package.json'))
  const workspaces = isRecord(manifest) ? manifest['workspaces'] : undefined
  const named = new Map<string, Record<string, string>>()
  if (isRecord(workspaces) && isRecord(workspaces['catalogs'])) {
    for (const [name, entries] of Object.entries(workspaces['catalogs'])) {
      named.set(name, stringMap(entries))
    }
  }
  return {
    default: isRecord(workspaces) ? stringMap(workspaces['catalog']) : {},
    named,
  }
}

/** Replace every `catalog:` / `catalog:<name>` range with the catalog's entry; an unresolvable reference throws. */
export function resolveCatalogRanges(
  deps: Record<string, string>,
  catalogs: Catalogs,
  owner: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(deps)) {
    if (!range.startsWith('catalog:')) {
      out[name] = range
      continue
    }
    const catalogName = range.slice('catalog:'.length)
    const table =
      catalogName === '' || catalogName === 'default'
        ? catalogs.default
        : catalogs.named.get(catalogName)
    const resolved = table?.[name]
    if (resolved === undefined) {
      throw new Error(
        `${owner}: ${name} uses "${range}" but the root catalog has no entry for it`,
      )
    }
    out[name] = resolved
  }
  return out
}

async function readLockfile(): Promise<Lockfile> {
  const catalogs = await readCatalogs()
  const text = await readFile(LOCKFILE, 'utf8')
  const sha256 = createHash('sha256').update(text).digest('hex')
  const parsed: unknown = Bun.JSONC.parse(text)
  if (!isRecord(parsed)) throw new Error('bun.lock did not parse to an object')

  const rawWorkspaces = parsed['workspaces']
  const workspaces: Workspace[] = []
  if (isRecord(rawWorkspaces)) {
    for (const [path, entry] of Object.entries(rawWorkspaces)) {
      if (!isRecord(entry)) continue
      const name = entry['name']
      const version = entry['version']
      const owner = typeof name === 'string' ? name : '(root)'
      workspaces.push({
        path,
        name: owner,
        version: typeof version === 'string' ? version : '0.0.0',
        dependencies: resolveCatalogRanges(
          stringMap(entry['dependencies']),
          catalogs,
          owner,
        ),
        devDependencies: resolveCatalogRanges(
          stringMap(entry['devDependencies']),
          catalogs,
          owner,
        ),
        optionalDependencies: resolveCatalogRanges(
          stringMap(entry['optionalDependencies']),
          catalogs,
          owner,
        ),
      })
    }
  }

  const packages = new Map<string, Component>()
  const rawPackages = parsed['packages']
  if (isRecord(rawPackages)) {
    for (const [key, tuple] of Object.entries(rawPackages)) {
      if (!Array.isArray(tuple)) continue
      const id = tuple[0]
      if (typeof id !== 'string') continue
      const { name, spec } = splitId(id)
      const origin = classifyOrigin(spec)
      const workspacePath =
        origin === 'workspace' ? spec.slice('workspace:'.length) : null
      const workspaceVersion = workspaces.find(
        w => w.path === workspacePath,
      )?.version
      packages.set(key, {
        key,
        name,
        version: workspaceVersion ?? versionOf(spec, origin),
        spec,
        origin,
        meta: readMeta(tuple),
        workspacePath,
      })
    }
  }

  return { workspaces, packages, sha256 }
}

// ───────────────────────────── reachability ───────────────────────────────

type Reach = 'runtime' | 'dev' | 'unreached'

type Reachability = {
  reach: Map<string, Reach>
  /** Shortest seed→component path, for the "who pulled this in" column. */
  path: Map<string, string[]>
}

function walk(
  seeds: Array<{ from: string; name: string; label: string }>,
  packages: Map<string, Component>,
): { seen: Set<string>; path: Map<string, string[]> } {
  const seen = new Set<string>()
  const path = new Map<string, string[]>()
  const queue: string[] = []

  for (const seed of seeds) {
    const key = resolveDependency(seed.from, seed.name, packages)
    if (key === null || seen.has(key)) continue
    seen.add(key)
    path.set(key, [seed.label, key])
    queue.push(key)
  }

  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) continue
    const node = packages.get(key)
    if (node === undefined) continue
    const deps = {
      ...node.meta.dependencies,
      ...node.meta.optionalDependencies,
      ...node.meta.peerDependencies,
    }
    for (const depName of Object.keys(deps)) {
      const next = resolveDependency(key, depName, packages)
      if (next === null || seen.has(next)) continue
      seen.add(next)
      path.set(next, [...(path.get(key) ?? [key]), next])
      queue.push(next)
    }
  }

  return { seen, path }
}

/**
 * Two passes, runtime first.
 *
 * "runtime" = reachable from the root package's `dependencies` /
 * `optionalDependencies`, or from any workspace package's own
 * `dependencies` — workspace packages are first-party code that ships.
 *
 * The split is reported because P8.4 asks for it, but see the report's own
 * warning: this fork bundles with `ssr.noExternal`, so `dev` here does NOT
 * mean "not distributed".
 */
function computeReachability(lock: Lockfile): Reachability {
  const runtimeSeeds: Array<{ from: string; name: string; label: string }> = []
  const devSeeds: Array<{ from: string; name: string; label: string }> = []

  for (const ws of lock.workspaces) {
    const from = ws.path === '' ? '' : ws.name
    const label = ws.path === '' ? '(root)' : ws.name
    for (const name of Object.keys(ws.dependencies)) {
      runtimeSeeds.push({ from, name, label })
    }
    for (const name of Object.keys(ws.optionalDependencies)) {
      runtimeSeeds.push({ from, name, label })
    }
    for (const name of Object.keys(ws.devDependencies)) {
      devSeeds.push({ from, name, label })
    }
  }

  const runtime = walk(runtimeSeeds, lock.packages)
  const dev = walk(devSeeds, lock.packages)

  const reach = new Map<string, Reach>()
  const path = new Map<string, string[]>()
  for (const key of lock.packages.keys()) {
    if (runtime.seen.has(key)) {
      reach.set(key, 'runtime')
      path.set(key, runtime.path.get(key) ?? [key])
    } else if (dev.seen.has(key)) {
      reach.set(key, 'dev')
      path.set(key, dev.path.get(key) ?? [key])
    } else {
      reach.set(key, 'unreached')
      path.set(key, [key])
    }
  }
  return { reach, path }
}

// ───────────────────────────── node_modules scan ──────────────────────────

type Installed = { license: string; dir: string }

/**
 * Index every installed package by `name@version`.
 *
 * Bun's isolated linker means the top-level `node_modules/<pkg>` entries are
 * symlinks into `node_modules/.bun/<key>/node_modules/<pkg>`. Following those
 * symlinks would visit each package many times, so the store is walked
 * directly and realpaths are deduplicated. The hoisted layout still works —
 * both are just "a node_modules directory" to this walk.
 */
async function indexInstalled(): Promise<Map<string, Installed>> {
  const index = new Map<string, Installed>()
  const visited = new Set<string>()

  async function readPackageJson(dir: string): Promise<void> {
    let text: string
    try {
      text = await readFile(join(dir, 'package.json'), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    const name = parsed['name']
    const version = parsed['version']
    if (typeof name !== 'string' || typeof version !== 'string') return
    const key = `${name}@${version}`
    if (index.has(key)) return
    index.set(key, { license: readLicenseField(parsed), dir })
  }

  async function walkPackageDir(dir: string, depth: number): Promise<void> {
    await readPackageJson(dir)
    if (depth > 6) return
    const nested = join(dir, 'node_modules')
    if (await isDirectory(nested)) await walkNodeModules(nested, depth + 1)
  }

  async function walkNodeModules(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry)
      if (entry === '.bun') {
        // The isolated store: each child holds one more node_modules.
        let stores: string[]
        try {
          stores = await readdir(full)
        } catch {
          continue
        }
        for (const store of stores.sort()) {
          await walkNodeModules(join(full, store, 'node_modules'), depth + 1)
        }
        continue
      }
      if (entry.startsWith('.')) continue
      // Top-level entries are symlinks into .bun under the isolated linker;
      // dedupe on the real path so each package is read exactly once.
      let real: string
      try {
        real = await realpath(full)
      } catch {
        continue
      }
      if (visited.has(real)) continue
      visited.add(real)
      if (!(await isDirectory(full))) continue
      if (entry.startsWith('@')) {
        let scoped: string[]
        try {
          scoped = await readdir(full)
        } catch {
          continue
        }
        for (const child of scoped.sort()) {
          await walkPackageDir(join(full, child), depth)
        }
        continue
      }
      await walkPackageDir(full, depth)
    }
  }

  await walkNodeModules(NODE_MODULES, 0)
  return index
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

// ───────────────────────────── prebuilt binaries ──────────────────────────

type BinaryAudit = {
  location: string
  what: string
  tracked: string
  licenseFile: string
  provenance: string
}

/**
 * The native side of the product is the oh-my-pi Rust workspace: the
 * `pi_natives` N-API addon (built by `bun run build:native`, embedded into
 * `dist/qm-<target>` by `atlas/scripts/build-qm.ts`) and the vendored crates
 * beside it. Their third-party license inventory is omp's own, produced with
 * cargo-about from `about.toml` into `THIRD-PARTY-NOTICES.txt`; this audit
 * records where those files are and what they cover, and does not re-derive
 * a Rust dependency list that `Cargo.lock` plus those two files already pin.
 */
async function auditPrebuiltBinaries(): Promise<BinaryAudit[]> {
  const rows: BinaryAudit[] = []

  const nativeDir = join(REPO_ROOT, 'packages', 'natives', 'native')
  const addons = (await isDirectory(nativeDir))
    ? (await readdir(nativeDir)).filter(f => f.endsWith('.node')).sort()
    : []
  const cargoPackages = await countCargoLockPackages()
  const noticesPresent = await isFile(
    join(REPO_ROOT, 'THIRD-PARTY-NOTICES.txt'),
  )
  const aboutPresent = await isFile(join(REPO_ROOT, 'about.toml'))
  rows.push({
    location: 'packages/natives/native/',
    what:
      addons.length > 0
        ? `${addons.length} 个本机构建的 \`pi_natives\` N-API 插件（${addons.join('、')}）`
        : '`pi_natives` N-API 插件（本机尚未构建；`bun run build:native`）',
    tracked: '不入库（构建产物）；编译时嵌入 `dist/qm-<target>`',
    licenseFile: 'THIRD-PARTY-NOTICES.txt、about.toml、deny.toml（仓库根）',
    provenance: `由 Cargo workspace（\`Cargo.lock\` ${cargoPackages} 个 package）构建；Rust 第三方依赖的许可清单取 omp 的 ${
      noticesPresent
        ? '`THIRD-PARTY-NOTICES.txt`'
        : '（缺失）`THIRD-PARTY-NOTICES.txt`'
    }，接受的许可表在 ${aboutPresent ? '`about.toml`' : '（缺失）`about.toml`'}，由 cargo-deny 的 \`deny.toml\` 兜底`,
  })

  const vendorRoot = join(REPO_ROOT, 'crates', 'vendor')
  const vendored = (await isDirectory(vendorRoot))
    ? (await readdir(vendorRoot)).sort()
    : []
  const withLicense: string[] = []
  for (const name of vendored) {
    if ((await findLicenseFile(join(vendorRoot, name))) !== null)
      withLicense.push(name)
  }
  rows.push({
    location: 'crates/vendor/',
    what: `${vendored.length} 个就地打补丁的第三方 Rust crate${vendored.length > 0 ? `（${vendored.join('、')}）` : ''}`,
    tracked: '入库（git 跟踪）',
    licenseFile: `${withLicense.length}/${vendored.length} 个目录带 LICENSE/COPYING/NOTICE`,
    provenance:
      '经 `[patch.crates-io]` 接入 Cargo workspace；各自许可正文收录在 THIRD-PARTY-NOTICES.txt 的「TRACKED VENDORED CODE」一节',
  })

  rows.push({
    location: 'dist/qm-<target>',
    what: 'qm 与 oh-my-pi CLI 编成的单个可执行文件（Bun --compile），内嵌上面的 `pi_natives` 插件',
    tracked: '不入库（`atlas/scripts/build-qm.ts` 产物）',
    licenseFile:
      '随产物分发时附 LICENSE、LICENSE.base、NOTICE 与 THIRD-PARTY-NOTICES.txt',
    provenance:
      '源码为本仓库（阡陌层 AGPL-3.0-or-later，基座层 MIT）；JS 依赖由上面的 bun.lock 清单覆盖，Rust 依赖由 omp 的 THIRD-PARTY-NOTICES.txt 覆盖',
  })

  return rows
}

/** Number of `[[package]]` entries in the root `Cargo.lock`; 0 when absent. */
async function countCargoLockPackages(): Promise<number> {
  try {
    const text = await readFile(join(REPO_ROOT, 'Cargo.lock'), 'utf8')
    return (text.match(/^\[\[package\]\]$/gm) ?? []).length
  } catch {
    return 0
  }
}

async function findLicenseFile(dir: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const hit = entries.find(e => /^(LICENSE|COPYING|NOTICE)/i.test(e))
  return hit ?? null
}

async function listFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (await isDirectory(full)) {
      // Rust 构建输出目录（native/.gitignore 里的 `target/`）不入库，里面躺的
      // 是本机刚构建出来的 libaudio_capture.dylib 之类。扫进来会让「包内有几个
      // 原生产物」随本机构建过没有而变，并把未入库的产物标成「入库」——
      // 与 NOTICE 承诺的「可随时复现核对」直接冲突。
      if (entry === 'target' && (await isFile(join(dir, 'Cargo.toml'))))
        continue
      out.push(...(await listFiles(full, depth + 1)))
    } else out.push(full)
  }
  return out
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

// ───────────────────────────── workspace roster ───────────────────────────

type WorkspaceRow = {
  name: string
  path: string
  license: string
  private: boolean
  headerCoverage: string
}

const COPYRIGHT_HEADER = '// Copyright 2026 Qianmo AgentNest Team'
const SPDX_HEADER = '// SPDX-License-Identifier: AGPL-3.0-or-later'

async function auditWorkspaces(lock: Lockfile): Promise<WorkspaceRow[]> {
  const rows: WorkspaceRow[] = []
  for (const ws of lock.workspaces) {
    if (ws.path === '') continue
    const dir = join(REPO_ROOT, ws.path)
    const pkg = await readJson(join(dir, 'package.json'))
    const license = readLicenseField(pkg)
    const isPrivate = isRecord(pkg) && pkg['private'] === true
    const coverage = ws.name.startsWith('@qianmo/')
      ? await headerCoverage(dir)
      : '—'
    rows.push({
      name: ws.name,
      path: ws.path,
      license: license === '' ? '(缺失)' : license,
      private: isPrivate,
      headerCoverage: coverage,
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** Charter §5.5 requires the two-line header on every @qianmo/* source file. */
async function headerCoverage(dir: string): Promise<string> {
  const { ok, total } = await countAgplHeaders(dir)
  return `${ok}/${total}`
}

async function countAgplHeaders(
  dir: string,
): Promise<{ ok: number; total: number }> {
  const files = (await listFiles(dir)).filter(f => f.endsWith('.ts'))
  let ok = 0
  for (const file of files) {
    // 口径与 NOTICE 一、许可一致：shebang 后的文件头可能从第 3 行开始，故扫描前 5 行而非前两行。
    const head = (await readFile(file, 'utf8')).split('\n', 5)
    if (
      head.some(line => line.trim() === COPYRIGHT_HEADER) &&
      head.some(line => line.trim() === SPDX_HEADER)
    ) {
      ok++
    }
  }
  return { ok, total: files.length }
}

// ───────────────────────────── report assembly ────────────────────────────

type Row = {
  component: Component
  reach: Reach
  path: string[]
  verdict: LicenseVerdict
  installed: boolean
  installedDir: string | null
  platformGated: boolean
  /** Filled only for rows with a license-field problem — see annotate(). */
  licenseFiles: string[] | null
}

const HOST_OS = process.platform
const HOST_CPU = process.arch

function buildRows(
  lock: Lockfile,
  reachability: Reachability,
  installed: Map<string, Installed>,
  workspaceLicenses: Map<string, string>,
): Row[] {
  const rows: Row[] = []
  for (const component of lock.packages.values()) {
    const hit = installed.get(`${component.name}@${component.version}`)
    const gated =
      (component.meta.os.length > 0 && !component.meta.os.includes(HOST_OS)) ||
      (component.meta.cpu.length > 0 && !component.meta.cpu.includes(HOST_CPU))
    // Workspace packages are read straight from their package.json — the
    // node_modules index sees them only through symlinks and their version
    // ('0.0.0' for every @qianmo/* package) is not a unique key.
    const raw =
      component.origin === 'workspace'
        ? workspaceLicenses.get(component.name)
        : hit?.license
    rows.push({
      component,
      reach: reachability.reach.get(component.key) ?? 'unreached',
      path: reachability.path.get(component.key) ?? [component.key],
      verdict: classifyLicense(raw),
      installed: component.origin === 'workspace' || hit !== undefined,
      installedDir: hit?.dir ?? null,
      platformGated: gated,
      licenseFiles: null,
    })
  }
  return rows.sort(
    (a, b) =>
      a.component.name.localeCompare(b.component.name) ||
      a.component.version.localeCompare(b.component.version) ||
      a.component.key.localeCompare(b.component.key),
  )
}

/**
 * For every component whose `license` field is missing or unparseable, look on
 * disk for an actual licence file. `SEE LICENSE IN LICENSE` where no LICENSE
 * file shipped is a different (and worse) finding than one where it did.
 */
async function annotateLicenseFiles(rows: Row[]): Promise<void> {
  for (const row of rows) {
    if (row.verdict.issues.length === 0 || row.installedDir === null) continue
    let entries: string[]
    try {
      entries = await readdir(row.installedDir)
    } catch {
      row.licenseFiles = []
      continue
    }
    row.licenseFiles = entries
      .filter(e => /^(LICEN[CS]E|COPYING)/i.test(e))
      .sort()
  }
}

function licenseFileNote(row: Row): string {
  if (row.licenseFiles === null) return '—'
  if (row.licenseFiles.length === 0) return '**无**'
  return row.licenseFiles.map(f => `\`${f}\``).join(', ')
}

function purlOf(component: Component): string {
  const encoded = component.name.startsWith('@')
    ? `%40${component.name.slice(1)}`
    : component.name
  return `pkg:npm/${encoded}@${component.version}`
}

type CycloneLicense =
  | { license: { id: string } }
  | { license: { name: string } }
  | { expression: string }

function licensesFor(verdict: LicenseVerdict): CycloneLicense[] | null {
  if (verdict.raw === '') return null
  if (verdict.ids.length === 1 && verdict.unrecognized.length === 0) {
    const id = verdict.ids[0]
    if (id !== undefined && verdict.raw === id) return [{ license: { id } }]
  }
  if (/\b(AND|OR|WITH)\b/i.test(verdict.raw) || verdict.raw.includes('(')) {
    return [{ expression: verdict.raw }]
  }
  return [{ license: { name: verdict.raw } }]
}

function buildBom(lock: Lockfile, rows: Row[]): unknown {
  // One component per purl. The lockfile lists the same name@version once per
  // place it resolves (1419 entries collapse to ~1056 packages), and a BOM
  // with duplicate purls is a malformed BOM. `runtime` wins over `dev` when
  // the same package is reachable both ways.
  const byPurl = new Map<string, Row>()
  for (const row of rows) {
    const purl = purlOf(row.component)
    const existing = byPurl.get(purl)
    if (
      existing === undefined ||
      (existing.reach !== 'runtime' && row.reach === 'runtime')
    ) {
      byPurl.set(purl, row)
    }
  }

  const components = [...byPurl.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([purl, row]) => {
      const licenses = licensesFor(row.verdict)
      const properties: Array<{ name: string; value: string }> = [
        { name: 'qianmo:reach', value: row.reach },
        { name: 'qianmo:licenseTier', value: row.verdict.tier },
        { name: 'qianmo:origin', value: row.component.origin },
      ]
      if (!row.installed) {
        properties.push({
          name: 'qianmo:installed',
          value: row.platformGated ? 'no (platform-gated)' : 'no',
        })
      }
      return {
        type: row.component.origin === 'workspace' ? 'application' : 'library',
        'bom-ref': purl,
        name: row.component.name,
        version: row.component.version,
        scope: row.reach === 'runtime' ? 'required' : 'optional',
        purl,
        ...(licenses === null ? {} : { licenses }),
        properties,
      }
    })

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': 'qianmo-agentnest',
        name: 'qianmo-agentnest',
        version: '3.0.0-dev',
        licenses: [{ license: { id: 'MIT' } }],
        properties: [
          { name: 'qianmo:basePin', value: BASE_PIN },
          { name: 'qianmo:baseTag', value: BASE_TAG },
          {
            name: 'qianmo:rootPackage',
            value: `${lock.workspaces.find(w => w.path === '')?.name ?? '?'}`,
          },
        ],
      },
      tools: [
        {
          vendor: 'Qianmo AgentNest Team',
          name: 'atlas/scripts/sbom.ts',
          version: '1',
        },
      ],
      properties: [
        {
          name: 'qianmo:source',
          value:
            'bun.lock + root package.json catalog + node_modules; Rust: THIRD-PARTY-NOTICES.txt',
        },
        { name: 'qianmo:lockfileSha256', value: lock.sha256 },
        {
          name: 'qianmo:deterministic',
          value: 'no timestamp by design; regenerate with `bun run atlas:sbom`',
        },
      ],
    },
    components,
  }
}

// ───────────────────────────── markdown ───────────────────────────────────

function tierLabel(tier: LicenseTier): string {
  switch (tier) {
    case 'permissive':
      return '宽松'
    case 'weak-copyleft':
      return '弱传染（文件级）'
    case 'strong-copyleft':
      return '强传染'
    case 'network-copyleft':
      return '网络传染'
    case 'restricted':
      return '受限/非自由'
    default:
      return '未判定'
  }
}

/** Who pulled this in — the last hop before the component itself. */
function parentLabel(path: string[]): string {
  const parent = path[path.length - 2] ?? path[0] ?? '—'
  const segments = splitKeySegments(parent)
  return segments[segments.length - 1] ?? parent
}

function pathLabel(path: string[]): string {
  if (path.length <= 1) return path[0] ?? '—'
  const trimmed = path.length > 5 ? [path[0], '…', ...path.slice(-3)] : path
  return trimmed.filter(p => p !== undefined).join(' → ')
}

function buildMarkdown(
  lock: Lockfile,
  rows: Row[],
  binaries: BinaryAudit[],
  workspaces: WorkspaceRow[],
): string {
  const out: string[] = []
  const total = rows.length
  const runtime = rows.filter(r => r.reach === 'runtime').length
  const dev = rows.filter(r => r.reach === 'dev').length
  const unreached = rows.filter(r => r.reach === 'unreached').length
  const workspaceRows = rows.filter(r => r.component.origin === 'workspace')
  const external = rows.filter(r => r.component.origin !== 'workspace')

  // 这两行必须由生成器写出来，不能只存在于 docs/dev/sbom-m0.md 里：那个文件
  // 每次 `bun run sbom` 都被整体覆盖，手加的文件头会被无声抹掉，而抹掉之后
  // NOTICE 一、许可那条「前 5 行内带两行头」的判据就少数一个文件——一次纯粹
  // 由再生成造成的计数漂移，且不会有任何门禁报错。JSON 那半边不需要（也无法
  // 加）：`sbom-m0.json` 是严格 JSON，语法里没有注释。**这条只对严格 JSON 成立，
  // 不能推广到全部 `.json`**——同批统计里的 `tsconfig.json` 按 JSONC 解析、是接受
  // `//` 的，只是不该带（见本文件顶部 napiPackageProvenance 的注释）。
  out.push('<!-- Copyright 2026 Qianmo AgentNest Team -->')
  out.push('<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->')
  out.push('')
  out.push('# 第三方依赖 SBOM 与许可证清单（oh-my-pi 基座）')
  out.push('')
  out.push(
    '> **本文件由 `bun run atlas:sbom` 生成，不要手改。**改判据请改 `atlas/scripts/sbom.ts`。',
  )
  out.push('>')
  out.push(
    `> 输入：\`bun.lock\`（SHA-256 \`${lock.sha256.slice(0, 16)}…\`）+ \`node_modules\` 的 \`license\` 字段。机器可读版本见同目录 [\`sbom-m0.json\`](./sbom-m0.json)（CycloneDX 1.5 形状）。`,
  )
  out.push('')
  out.push(
    '对应 roadmap **P8.4** 交付物①，章程 §5 与风险 L-2 的证据链见 [`license-chain-m0.md`](./license-chain-m0.md)。',
  )
  out.push('')

  out.push('## 0. 三条读表须知')
  out.push('')
  out.push(
    '**① `dev` 不等于「不分发」。**`atlas/scripts/build-qm.ts` 用 Bun `--compile` 把 qm 与 omp CLI 连同它们触达的库整体编进 `dist/qm-<target>`；而基座把绝大多数运行时库放在各包的 `devDependencies` 或按 catalog 引用，字段归属与是否进入产物没有对应关系。**因此本表的 runtime/dev 划分反映的是 package.json 字段归属，不是产物边界。传染性许可的处置不得以「它是 dev 依赖」为由放行。**',
  )
  out.push('')
  out.push(
    '**② 本仓库不发 npm 包**（章程 N-14）。分发形态是演示与竞赛材料随附的源码/产物，不是 registry 上的包。许可义务按「分发」评估仍然成立。',
  )
  out.push('')
  out.push(
    '**③ 平台受限的 optional 依赖在本机不装**，因而读不到 `license` 字段。它们单列一节，不混进「许可缺失」清单。',
  )
  out.push('')

  out.push('## 1. 统计总览')
  out.push('')
  out.push('| 项 | 数 |')
  out.push('|---|---|')
  out.push(`| 组件总数（lockfile 条目，含重复解析） | ${total} |`)
  out.push(`| ├ 第三方组件 | ${external.length} |`)
  out.push(`| └ workspace 自有包 | ${workspaceRows.length} |`)
  out.push(`| 唯一 name@version（第三方） | ${uniqueCount(external)} |`)
  out.push(`| runtime 可达 | ${runtime} |`)
  out.push(`| dev 可达 | ${dev} |`)
  out.push(`| 未被任何根可达（解析遗漏或纯 peer） | ${unreached} |`)
  out.push(
    `| 本机未安装（去重，平台受限 optional） | ${dedupe(rows.filter(r => !r.installed && r.platformGated)).length} |`,
  )
  out.push('')

  const installedExternal = dedupe(external.filter(r => r.installed))
  out.push('## 2. 许可分布')
  out.push('')
  out.push(
    `按归一化后的许可表达式统计，范围为**本机已安装的第三方组件**（去重到 name@version，共 ${installedExternal.length} 项）。未安装的 ${uniqueCount(external) - installedExternal.length} 项读不到字段，单列在 §5，不计入本表。`,
  )
  out.push('')
  out.push(
    '「分类」按 §3 的 SPDX 求值口径给出：`(A OR B)` 取较宽松的一支，所以 `(BSD-3-Clause OR GPL-2.0)` 显示为宽松。',
  )
  out.push('')
  const dist = new Map<string, { count: number; tier: LicenseTier }>()
  for (const row of installedExternal) {
    const label = row.verdict.raw === '' ? '(缺失)' : row.verdict.raw
    const entry = dist.get(label) ?? { count: 0, tier: row.verdict.tier }
    entry.count++
    dist.set(label, entry)
  }
  out.push('| 许可表达式 | 分类 | 组件数 |')
  out.push('|---|---|---|')
  for (const [label, entry] of [...dist.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  )) {
    out.push(`| \`${label}\` | ${tierLabel(entry.tier)} | ${entry.count} |`)
  }
  out.push('')

  out.push('## 3. 传染性许可扫描（P8.4 DoD 判据）')
  out.push('')
  out.push(
    '判定口径：SPDX 表达式按 `OR` 取最宽松分支、`AND` 取最严格分支求值——`(MIT OR GPL-2.0)` **不算命中**，因为可以取 MIT 那一支；`GPL-2.0 WITH Classpath-exception-2.0` 降一档，因为该例外正是为解除链接传染而写的。扫描覆盖 GPL / LGPL / AGPL / SSPL / EUPL / CC-BY-SA / OSL / CDDL / MPL / EPL / CPL / MS-RL / APSL / GFDL / Sleepycat / QPL / CECILL / Artistic 等族。',
  )
  out.push('')

  const hits = dedupe(
    external.filter(r => CONTAGIOUS_TIERS.has(r.verdict.tier)),
  ).sort(
    (a, b) =>
      TIER_RANK[b.verdict.tier] - TIER_RANK[a.verdict.tier] ||
      a.component.name.localeCompare(b.component.name),
  )
  const strong = hits.filter(r => TIER_RANK[r.verdict.tier] >= 2)
  const restricted = dedupe(
    external.filter(r => r.verdict.tier === 'restricted'),
  )

  out.push(
    `**结论：强传染 / 网络传染命中 ${strong.length} 项；弱传染（文件级）命中 ${hits.length - strong.length} 项；受限/非自由 ${restricted.length} 项。**`,
  )
  out.push('')
  if (hits.length === 0 && restricted.length === 0) {
    out.push('无命中。DoD「无 GPL 类传染性许可项」满足。')
  } else {
    out.push('| 包 | 版本 | 许可 | 分类 | 引入路径 | 字段归属 | 处置建议 |')
    out.push('|---|---|---|---|---|---|---|')
    for (const row of [...hits, ...restricted]) {
      out.push(
        `| \`${row.component.name}\` | ${row.component.version} | \`${row.verdict.raw}\` | ${tierLabel(row.verdict.tier)} | ${pathLabel(row.path)} | ${row.reach} | ${disposition(row)} |`,
      )
    }
  }
  out.push('')

  out.push('## 4. 许可字段缺失 / 非 SPDX / `SEE LICENSE IN`')
  out.push('')
  const problems = dedupe(
    external.filter(r => r.installed && r.verdict.issues.length > 0),
  ).sort((a, b) => a.component.name.localeCompare(b.component.name))
  if (problems.length === 0) {
    out.push('无。所有已安装的第三方组件都带可解析的 SPDX 许可字段。')
  } else {
    out.push(
      '「包内许可文件」列直接看磁盘：`SEE LICENSE IN <file>` 指向的文件**未必随包发布**，那种情况下授权正文在本机根本不存在，必须回到上游仓库取。',
    )
    out.push('')
    out.push('| 包 | 版本 | `license` 字段 | 问题 | 包内许可文件 | 引入路径 |')
    out.push('|---|---|---|---|---|---|')
    for (const row of problems) {
      out.push(
        `| \`${row.component.name}\` | ${row.component.version} | ${row.verdict.raw === '' ? '（无）' : `\`${row.verdict.raw}\``} | ${row.verdict.issues.join(', ')} | ${licenseFileNote(row)} | ${pathLabel(row.path)} |`,
      )
    }
    out.push('')
    out.push(
      '本脚本只读字段、不读授权正文。**上表每一项的人工核读结论记在 [`license-chain-m0.md`](./license-chain-m0.md) §4**，其中包含本次审计查到的非开源授权项的定性与其影响面判定。',
    )
  }
  out.push('')

  const notInstalled = dedupe(external.filter(r => !r.installed)).sort((a, b) =>
    a.component.name.localeCompare(b.component.name),
  )
  const gated = notInstalled.filter(r => r.platformGated)
  const ungated = notInstalled.filter(r => !r.platformGated)

  out.push('## 5. 本机未安装的组件（许可待补）')
  out.push('')
  out.push(
    `本机 \`${HOST_OS}-${HOST_CPU}\`。共 ${notInstalled.length} 项在 lockfile 里但本机 \`node_modules\` 中不存在，因而读不到 \`license\` 字段；其中 ${gated.length} 项是被 \`os\`/\`cpu\` 过滤掉的平台原生包。**结项材料若要覆盖全平台，须在各目标平台分别跑一次本脚本再并表。**`,
  )
  out.push('')
  out.push(
    '按引入者归组。「同族已安装样本的许可」是同一引入者下已装组件的许可集合——平台变体包通常与同族一致，可据此预判，但**不构成判定**。',
  )
  out.push('')
  const groups = new Map<string, { count: number; sample: string[] }>()
  for (const row of gated) {
    const parent = parentLabel(row.path)
    const entry = groups.get(parent) ?? { count: 0, sample: [] }
    entry.count++
    groups.set(parent, entry)
  }
  for (const row of installedExternal) {
    const parent = parentLabel(row.path)
    const entry = groups.get(parent)
    if (entry === undefined) continue
    const label = row.verdict.raw === '' ? '(缺失)' : row.verdict.raw
    if (!entry.sample.includes(label)) entry.sample.push(label)
  }
  out.push('| 引入者 | 未安装项数 | 同族已安装样本的许可 |')
  out.push('|---|---|---|')
  for (const [parent, entry] of [...groups.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  )) {
    out.push(
      `| \`${parent}\` | ${entry.count} | ${entry.sample.length === 0 ? '（无已装同族）' : entry.sample.map(s => `\`${s}\``).join('、')} |`,
    )
  }
  out.push('')
  if (ungated.length > 0) {
    out.push(
      `另有 ${ungated.length} 项**不受平台限制却仍未安装**（多为未被选中的 optional / peer 分支），逐项列出：`,
    )
    out.push('')
    out.push('| 包 | 版本 | 引入路径 |')
    out.push('|---|---|---|')
    for (const row of ungated) {
      out.push(
        `| \`${row.component.name}\` | ${row.component.version} | ${pathLabel(row.path)} |`,
      )
    }
    out.push('')
  }

  out.push('## 6. 原生二进制（Rust 插件与编译产物）的许可来源核对')
  out.push('')
  out.push('| 位置 | 内容 | 入库状态 | 目录内 LICENSE | 溯源 |')
  out.push('|---|---|---|---|---|')
  for (const bin of binaries) {
    out.push(
      `| \`${bin.location}\` | ${bin.what} | ${bin.tracked} | ${bin.licenseFile} | ${bin.provenance} |`,
    )
  }
  out.push('')

  out.push('## 7. workspace 自有包')
  out.push('')
  out.push(
    '「版权头」列 = 该包 `.ts` 文件中首两行为 `// Copyright 2026 Qianmo AgentNest Team` + `// SPDX-License-Identifier: AGPL-3.0-or-later` 的比例（章程 §5.5 要求 `@qianmo/*` 全覆盖）。',
  )
  out.push('')
  out.push('### 7.1 阡陌自有（`@qianmo/*`）')
  out.push('')
  out.push('| 包 | 路径 | `license` | private | 版权头 |')
  out.push('|---|---|---|---|---|')
  for (const ws of workspaces.filter(w => w.name.startsWith('@qianmo/'))) {
    out.push(
      `| \`${ws.name}\` | \`${ws.path}\` | ${ws.license} | ${ws.private ? '是' : '否'} | ${ws.headerCoverage} |`,
    )
  }
  out.push('')
  out.push('### 7.2 基座既有 workspace 包')
  out.push('')
  out.push(
    '基座包普遍不写 `license` 字段。它们 `private: true` 且不单独发布，由 `LICENSE.base`（MIT，基座层）覆盖——见 `NOTICE` 一、许可。**根 `LICENSE` 是阡陌自有层的 AGPL-3.0，不覆盖它们**：两层的权威判据是文件在不在基座快照 `base-snapshot/*` 里，不是文件头——**带头 ⇒ 属于 AGPL 层**成立，反向不成立：无头文件既可能是基座文件，也可能是不在基座快照里的阡陌文件；另有一批带着阡陌改动的基座文件有意不加头，这是独立限制、不是反例。具体个数与拆分现跑现算，命令与口径见 `NOTICE` 一、许可。**不建议在本任务里补字段**：那是基座发布面（CLAUDE.md §0）。',
  )
  out.push('')
  out.push('| 包 | 路径 | `license` | private |')
  out.push('|---|---|---|---|')
  for (const ws of workspaces.filter(w => !w.name.startsWith('@qianmo/'))) {
    out.push(
      `| \`${ws.name}\` | \`${ws.path}\` | ${ws.license} | ${ws.private ? '是' : '否'} |`,
    )
  }
  out.push('')

  return `${out.join('\n')}\n`
}

function uniqueCount(rows: Row[]): number {
  return new Set(rows.map(r => `${r.component.name}@${r.component.version}`))
    .size
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>()
  const out: Row[] = []
  for (const row of rows) {
    const id = `${row.component.name}@${row.component.version}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(row)
  }
  return out
}

/**
 * Contagious components that are present in the lockfile but do not ship.
 *
 * An entry is a claim, so it is re-verified on every run: the package must
 * have no import in any production source file (`packages/<pkg>/src`,
 * `atlas/packages/<pkg>/src`, test files excluded). The moment a source file
 * imports it, the exception stops holding and `--check` blocks again.
 */
export const RECORDED_EXCEPTIONS: Readonly<Record<string, string>> = {
  'kitty-vt-wasm@0.2.0':
    '仅被 `@oh-my-pi/pi-tui` 与 `pi-coding-agent` 的测试夹具引用（`packages/tui/test/virtual-terminal.ts` 等），生产源码无 import，不进 `dist/qm-<target>`；如生产源码开始引用，本例外自动失效',
}

const SOURCE_GLOBS = [
  'packages/*/src/**/*.{ts,tsx,js}',
  'atlas/packages/*/src/**/*.{ts,tsx,js}',
]

/** Production source files that import `name` (bare or subpath); empty when none do. */
async function importersOf(name: string): Promise<string[]> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?:from\\s*|import\\s*\\(?\\s*|require\\s*\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`,
  )
  const hits: string[] = []
  for (const glob of SOURCE_GLOBS) {
    for await (const file of new Bun.Glob(glob).scan({ cwd: REPO_ROOT })) {
      if (file.includes('node_modules')) continue
      if (pattern.test(await readFile(join(REPO_ROOT, file), 'utf8'))) {
        hits.push(file)
      }
    }
  }
  return hits.sort()
}

type ExceptionStatus = { reason: string; holds: boolean; importers: string[] }

/** Recorded exception for `name@version`, with whether it still holds. */
async function exceptionFor(
  name: string,
  version: string,
): Promise<ExceptionStatus | null> {
  const reason = RECORDED_EXCEPTIONS[`${name}@${version}`]
  if (reason === undefined) return null
  const importers = await importersOf(name)
  return { reason, holds: importers.length === 0, importers }
}

/** Filled by `main` before the report is rendered (the render step is synchronous). */
const exceptionStatus = new Map<string, ExceptionStatus>()

function disposition(row: Row): string {
  const exception = exceptionStatus.get(
    `${row.component.name}@${row.component.version}`,
  )
  if (exception !== undefined) {
    return exception.holds
      ? `已记录例外（不阻断）：${exception.reason}`
      : `**阻断**：记录的例外已失效，生产源码现已引用它：${exception.importers.join('、')}`
  }
  const isLgpl = row.verdict.ids.some(id => /^LGPL/i.test(id))
  switch (row.verdict.tier) {
    case 'network-copyleft':
      return '**阻断**：常驻节点对外提供服务即触发义务，须替换或彻底隔离为独立进程并记录'
    case 'strong-copyleft':
      return '**阻断**：编译时会随 import 打进 `dist/qm-<target>`，须替换、或改为运行时外部依赖并单独分发；若它不随产物分发，需在 `RECORDED_EXCEPTIONS` 记录并由脚本复核'
    case 'weak-copyleft':
      return isLgpl
        ? '可留用（预编译共享库，非 JS，不进 `dist/` 的 JS bundle，随 `node_modules` 以独立文件形式存在）：未修改其源码即不传染到本仓库代码；分发时须随附其许可与版权声明，并保留使用者替换该库的可能（LGPL §4）'
        : '可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明'
    case 'restricted':
      return '**阻断**：无有效授权或含使用限制，须替换'
    default:
      return '人工复核'
  }
}

// ───────────────────────────── main ───────────────────────────────────────

async function main(): Promise<void> {
  const check = process.argv.includes('--check')

  const lock = await readLockfile()
  const installed = await indexInstalled()
  const reachability = computeReachability(lock)
  const binaries = await auditPrebuiltBinaries()
  const workspaces = await auditWorkspaces(lock)
  const workspaceLicenses = new Map(
    workspaces.map(ws => [ws.name, ws.license === '(缺失)' ? '' : ws.license]),
  )
  const rows = buildRows(lock, reachability, installed, workspaceLicenses)
  await annotateLicenseFiles(rows)
  for (const row of rows) {
    const status = await exceptionFor(row.component.name, row.component.version)
    if (status !== null) {
      exceptionStatus.set(
        `${row.component.name}@${row.component.version}`,
        status,
      )
    }
  }

  const bom = buildBom(lock, rows)
  await Bun.write(JSON_OUT, `${JSON.stringify(bom, null, 2)}\n`)
  await Bun.write(MD_OUT, buildMarkdown(lock, rows, binaries, workspaces))

  const external = rows.filter(r => r.component.origin !== 'workspace')
  const contagious = dedupe(
    external.filter(
      r =>
        TIER_RANK[r.verdict.tier] >= TIER_RANK['strong-copyleft'] &&
        r.verdict.tier !== 'unknown',
    ),
  )
  const isExcepted = (r: Row): boolean =>
    exceptionStatus.get(`${r.component.name}@${r.component.version}`)?.holds ===
    true
  const blocking = contagious.filter(r => !isExcepted(r))
  const excepted = contagious.filter(isExcepted)
  const weak = dedupe(external.filter(r => r.verdict.tier === 'weak-copyleft'))
  const unknown = dedupe(
    external.filter(r => r.verdict.tier === 'unknown' && r.installed),
  )

  console.log(`✓ sbom: ${rows.length} lockfile entries → docs/dev/sbom-m0.json`)
  console.log(`✓ sbom: 人读摘要 → docs/dev/sbom-m0.md`)
  console.log(
    `  强/网络传染 ${blocking.length} · 弱传染 ${weak.length} · 未判定（已安装）${unknown.length}`,
  )
  for (const row of excepted) {
    console.log(
      `  ~ ${row.component.name}@${row.component.version}  ${row.verdict.raw}  (recorded exception: not shipped)`,
    )
  }
  for (const row of blocking) {
    console.log(
      `  ✗ ${row.component.name}@${row.component.version}  ${row.verdict.raw}`,
    )
  }

  if (check && blocking.length > 0) {
    console.error(
      '✗ sbom --check: 存在强传染 / 网络传染 / 受限许可组件，P8.4 DoD 不满足。',
    )
    process.exit(1)
  }
}

// Guarded: `scripts/__tests__/sbom.test.ts` imports the classifier from this
// module, and an unguarded call would make `bun test` rewrite docs/dev/.
if (import.meta.main) {
  await main()
}
