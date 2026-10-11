#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Prepare an isolated, reviewable omp update. No push, PR, merge or deployment.
 * Upstream history exists only in the disposable upstream clone. The candidate
 * receives a parentless snapshot with the exact upstream tree, then a three-way
 * patch. Local additions and conflicting edits require a human resolution. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const UPSTREAM = 'can1357/oh-my-pi'
const MANIFEST = 'atlas/upstream/omp.json'
const ROOT = resolve(import.meta.dir, '../..')
const STABLE = /^(?:v)?(\d+\.\d+\.\d+)$/
export interface OmpPin {
  repository: string
  version: string
  commit: string
  tree: string
  snapshot: string
}
export interface CandidateResult {
  status: 'unchanged' | 'prepared'
  version: string
  branch?: string
  snapshot?: string
  candidate?: string
  baseHead: string
  upstreamCommit?: string
  upstreamTree?: string
  changedPaths?: string[]
  /** Upstream changed these base paths, which Atlas deleted; not applied. */
  removedLocally?: string[]
}
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Atlas upstream bot',
  GIT_AUTHOR_EMAIL: 'upstream-bot@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Atlas upstream bot',
  GIT_COMMITTER_EMAIL: 'upstream-bot@users.noreply.github.com',
}
export function git(
  cwd: string,
  args: string[],
  options: {
    input?: string
    env?: Record<string, string>
    allowFailure?: boolean
  } = {},
): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, ...IDENTITY, ...options.env },
    stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0 && !options.allowFailure)
    throw new Error(
      `git ${args[0]} failed (${result.exitCode}): ${result.stderr.toString().slice(0, 8000)}`,
    )
  return result.stdout.toString().trimEnd()
}
function run(cwd: string, command: string[], log: string): void {
  const fd = openSync(log, 'w')
  try {
    const result = Bun.spawnSync(command, {
      cwd,
      stdout: fd,
      stderr: fd,
      stdin: 'ignore',
    })
    if (result.exitCode !== 0)
      throw new Error(
        `${command.join(' ')} failed (${result.exitCode}); see ${log}`,
      )
  } finally {
    closeSync(fd)
  }
}
export function stableRelease(value: unknown): {
  version: string
  tag: string
} {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid GitHub release response')
  const release = value as Record<string, unknown>
  const match =
    typeof release.tag_name === 'string' ? STABLE.exec(release.tag_name) : null
  if (!match || release.draft !== false || release.prerelease !== false)
    throw new Error('Expected a published stable omp release')
  return { version: match[1]!, tag: String(release.tag_name) }
}
function pinAt(repo: string): OmpPin {
  const pin = JSON.parse(readFileSync(join(repo, MANIFEST), 'utf8')) as OmpPin
  if (
    pin.repository !== UPSTREAM ||
    !STABLE.test(pin.version) ||
    !/^[a-f0-9]{40}$/.test(pin.commit) ||
    !/^[a-f0-9]{40}$/.test(pin.tree) ||
    pin.snapshot !== `base-snapshot/omp-v${pin.version}`
  )
    throw new Error('Invalid explicit omp pin')
  if (git(repo, ['rev-parse', `${pin.snapshot}^{tree}`]) !== pin.tree)
    throw new Error('Pinned snapshot tree differs from manifest')
  if (
    git(repo, ['rev-list', '--parents', '-n', '1', pin.snapshot]).split(' ')
      .length !== 1
  )
    throw new Error('Base snapshot must be parentless')
  return pin
}
export function checkProvenance(repo: string): OmpPin {
  const pin = pinAt(repo)
  const version = JSON.parse(
    readFileSync(join(repo, 'packages/utils/package.json'), 'utf8'),
  ).version
  if (version !== pin.version)
    throw new Error('omp package version differs from the explicit base pin')
  for (const file of ['BASE.md', 'NOTICE']) {
    let text = readFileSync(join(repo, file), 'utf8')
    if (file === 'BASE.md' && text.includes('<!-- omp-current:start -->'))
      text = text
        .split('<!-- omp-current:start -->')[1]!
        .split('<!-- omp-current:end -->')[0]!
    for (const value of [pin.commit, pin.tree, pin.snapshot])
      if (!text.includes(value))
        throw new Error(`${file} does not record the pinned ${value}`)
  }
  const license = Bun.spawnSync(['git', 'show', `${pin.snapshot}:LICENSE`], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (
    license.exitCode !== 0 ||
    !readFileSync(join(repo, 'LICENSE.base')).equals(license.stdout)
  )
    throw new Error('LICENSE.base differs from the pinned upstream LICENSE')
  return pin
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Import only tree/blob objects via a temporary work tree and index. */
export function importSnapshot(
  candidate: string,
  upstream: string,
  tag: string,
  scratch: string,
): OmpPin {
  const version = STABLE.exec(tag)?.[1]
  if (!version) throw new Error('Only stable version tags are accepted')
  const commit = git(upstream, ['rev-parse', `${tag}^{commit}`])
  const tree = git(upstream, ['rev-parse', `${tag}^{tree}`])
  const manifest = JSON.parse(
    git(upstream, ['show', `${tag}:packages/utils/package.json`]),
  ) as { version?: string }
  if (manifest.version !== version)
    throw new Error('Release tag and omp package version differ')
  const stage = join(scratch, 'snapshot-tree')
  mkdirSync(stage, { recursive: false })
  const archive = join(scratch, 'snapshot.tar')
  git(upstream, ['archive', '--format=tar', `--output=${archive}`, commit])
  run(
    scratch,
    ['tar', '-xf', archive, '-C', stage],
    join(scratch, 'extract.log'),
  )
  const env = {
    GIT_DIR: join(candidate, '.git'),
    GIT_INDEX_FILE: join(scratch, 'snapshot.index'),
    GIT_WORK_TREE: stage,
  }
  git(stage, ['read-tree', '--empty'], { env })
  git(stage, ['-c', 'core.autocrlf=false', 'add', '--force', '--all', '.'], {
    env,
  })
  const importedTree = git(stage, ['write-tree'], { env })
  if (importedTree !== tree)
    throw new Error(`Snapshot tree mismatch: ${importedTree} != ${tree}`)
  const snapshot = `base-snapshot/omp-v${version}`
  const existing = git(
    candidate,
    ['rev-parse', '--verify', '--quiet', `refs/tags/${snapshot}`],
    { allowFailure: true },
  )
  if (existing) {
    if (
      git(candidate, ['rev-parse', `${snapshot}^{tree}`]) !== tree ||
      git(candidate, ['rev-list', '--parents', '-n', '1', snapshot]).split(' ')
        .length !== 1
    )
      throw new Error(
        `Snapshot tag already exists with different provenance: ${snapshot}; never overwrite it`,
      )
    return { repository: UPSTREAM, version, commit, tree, snapshot }
  }
  const parentless = git(candidate, ['commit-tree', tree], {
    input: `chore(base): zero-modification omp v${version} snapshot\n\nUpstream: ${UPSTREAM}@${commit}\n`,
  })
  git(candidate, [
    'update-ref',
    `refs/tags/${snapshot}`,
    parentless,
    '0000000000000000000000000000000000000000',
  ])
  return { repository: UPSTREAM, version, commit, tree, snapshot }
}

/** Explicit current boundary references; historical import records stay intact. */
export function updateProvenance(
  candidate: string,
  old: OmpPin,
  next: OmpPin,
): void {
  writeJson(join(candidate, MANIFEST), next)
  const oldSnapshotCommit = git(candidate, ['rev-parse', old.snapshot])
  const nextSnapshotCommit = git(candidate, ['rev-parse', next.snapshot])
  const notices = join(candidate, 'NOTICE')
  if (!existsSync(notices))
    throw new Error('Missing NOTICE: provenance requires human review')
  let notice = readFileSync(notices, 'utf8')
  for (const [from, to] of [
    [old.snapshot, next.snapshot],
    [old.commit, next.commit],
    [old.tree, next.tree],
    [oldSnapshotCommit, nextSnapshotCommit],
    [`v${old.version}`, `v${next.version}`],
    [old.commit.slice(0, 8), next.commit.slice(0, 8)],
  ])
    notice = notice.replaceAll(from!, to!)
  writeFileSync(notices, notice)
  const basePath = join(candidate, 'BASE.md')
  let base = readFileSync(basePath, 'utf8')
  const start = '<!-- omp-current:start -->'
  const end = '<!-- omp-current:end -->'
  const block = `${start}\n## Current reviewed-candidate base\n\n- Repository: https://github.com/${UPSTREAM}\n- Version: v${next.version}\n- Commit: ${next.commit}\n- Snapshot: \`${next.snapshot}\` (${nextSnapshotCommit}, no parents)\n- Tree: ${next.tree} (byte-identical to upstream)\n- Previous snapshot: \`${old.snapshot}\` (retained unchanged)\n- Status: candidate; compatibility checks are attached to the draft PR. Deployment requires review.\n${end}`
  if (base.includes(start) && base.includes(end))
    base =
      base.slice(0, base.indexOf(start)) +
      block +
      base.slice(base.indexOf(end) + end.length)
  else {
    // The original section remains a dated import record, not a second current pin.
    base = base
      .replace('## 现行基座：', '## 初始导入基座：')
      .replace('（**当前 pin**）', '（**导入 pin**）')
    base = base.replace(/^(# [^\n]+\n)/, `$1\n${block}\n`)
  }
  writeFileSync(basePath, base)
  for (const file of [
    'CLAUDE.md',
    'CLAUDE.full.md',
    'docs/dev/base-switch-omp.md',
    'docs/dev/base-modifications.md',
  ]) {
    const path = join(candidate, file)
    if (existsSync(path))
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replaceAll(old.snapshot, next.snapshot),
      )
  }
  // The other statements of the current base. In the three base files Atlas
  // prefixes, only the Atlas preamble up to the "verbatim below" marker is
  // touched; the upstream text after it stays byte-for-byte.
  const bump = (text: string) =>
    text.replaceAll(`v${old.version}`, `v${next.version}`)
  const marker = 'verbatim below -->'
  for (const file of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md']) {
    const path = join(candidate, file)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    const at = text.indexOf(marker)
    if (at === -1) continue
    const end = at + marker.length
    writeFileSync(path, bump(text.slice(0, end)) + text.slice(end))
  }
  for (const file of ['CLAUDE.full.md', 'docs/dev/base-modifications.md']) {
    const path = join(candidate, file)
    if (existsSync(path)) writeFileSync(path, bump(readFileSync(path, 'utf8')))
  }
  // Preserve the original license verbatim even if upstream updates its notice.
  const license = Bun.spawnSync(['git', 'show', `${next.snapshot}:LICENSE`], {
    cwd: candidate,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (license.exitCode !== 0)
    throw new Error('Snapshot has no readable LICENSE')
  writeFileSync(join(candidate, 'LICENSE.base'), license.stdout)
}

/** Used by offline fixtures with local upstream repos; CLI fixes the remote URL. */
export function prepareCandidate(
  source: string,
  upstream: string,
  tag: string,
  out: string,
): CandidateResult {
  if (git(source, ['status', '--porcelain']).trim())
    throw new Error(
      'Source checkout is dirty; candidate must start at a reviewable committed revision',
    )
  const old = pinAt(source)
  const version = STABLE.exec(tag)?.[1]
  if (!version) throw new Error('Only stable releases are accepted')
  const baseHead = git(source, ['rev-parse', 'HEAD'])
  if (Bun.semver.order(version, old.version) <= 0)
    return { status: 'unchanged', version: old.version, baseHead }
  mkdirSync(out, { recursive: true })
  const candidate = join(out, 'candidate')
  git(source, ['clone', '--no-hardlinks', '--no-local', source, candidate])
  // Local clone must not keep a credential-bearing remote or accidentally publish.
  git(candidate, ['remote', 'remove', 'origin'])
  const branch = `codex/sync-omp-${version}`
  git(candidate, ['checkout', '-b', branch, baseHead])
  const next = importSnapshot(candidate, upstream, tag, out)
  const changes = git(candidate, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    old.snapshot,
    next.snapshot,
  ])
    .split('\0')
    .filter(Boolean)
  const paths: string[] = []
  for (let i = 0; i < changes.length; i += 2) {
    const status = changes[i]!,
      path = changes[i + 1]!
    paths.push(path)
    if (/^(atlas\/|demo\/|docs\/dev\/)/.test(path))
      throw new Error(`Upstream overlaps the Atlas-owned namespace: ${path}`)
    if (status === 'A' && git(candidate, ['ls-tree', 'HEAD', '--', path]))
      throw new Error(`Upstream addition collides with local path: ${path}`)
  }
  // Base paths Atlas deleted on purpose (registered in
  // docs/dev/base-modifications.md, enforced by check-omp-base-change). The
  // deletion stands: upstream's delta for them is kept out of the applied patch
  // and handed to review, where a change worth having (say, to upstream's CI)
  // is ported by hand. Applying it would fail on the missing file.
  const deleted = new Set(
    git(candidate, [
      'diff',
      '--name-only',
      '--no-renames',
      '--diff-filter=D',
      '-z',
      old.snapshot,
      'HEAD',
    ])
      .split('\0')
      .filter(Boolean),
  )
  const removedLocally = paths.filter(path => deleted.has(path))
  const literal = (path: string) => `:(literal)${path}`
  const patch = join(out, 'upstream.patch')
  // --output preserves exact binary bytes; stdout helpers must never trim a patch.
  const diff = (output: string, pathspec: readonly string[]) =>
    git(candidate, [
      'diff',
      '--binary',
      '--full-index',
      '--no-renames',
      `--output=${output}`,
      old.snapshot,
      next.snapshot,
      '--',
      ...pathspec,
    ])
  diff(patch, ['.', ...removedLocally.map(path => `:(exclude,literal)${path}`)])
  if (removedLocally.length > 0)
    diff(
      join(out, 'upstream-removed-locally.patch'),
      removedLocally.map(literal),
    )
  try {
    git(candidate, ['apply', '--3way', '--index', '--whitespace=nowarn', patch])
  } catch (error) {
    writeFileSync(
      join(out, 'conflicts.txt'),
      git(candidate, ['status', '--short']) + '\n' + String(error),
    )
    throw new Error(
      `Upstream patch conflicts; preserved candidate and conflicts.txt for review: ${out}`,
    )
  }
  git(candidate, [
    'commit',
    '-m',
    `chore(base): sync omp v${old.version} to v${version}`,
  ])
  updateProvenance(candidate, old, next)
  checkProvenance(candidate)
  git(candidate, ['add', '--all'])
  git(candidate, [
    'commit',
    '-m',
    `chore(base): record omp v${version} provenance for review`,
  ])
  const result: CandidateResult = {
    status: 'prepared',
    version,
    branch,
    snapshot: next.snapshot,
    candidate,
    baseHead,
    upstreamCommit: next.commit,
    upstreamTree: next.tree,
    changedPaths: paths,
    removedLocally,
  }
  writeJson(join(out, 'candidate.json'), result)
  writeFileSync(
    join(out, 'review.md'),
    `Updates the omp base from v${old.version} to v${version}.\n\nUpstream: https://github.com/${UPSTREAM}/releases/tag/${tag}\n\nThe first commit applies the upstream delta; the second records the new parentless snapshot and license boundary. Existing snapshot tags and Atlas changes remain intact.\n\nCompatibility results: see the attached workflow artifact. This draft requires review before merge. It does not deploy or update any node.\n` +
      (removedLocally.length === 0
        ? ''
        : `\n## Upstream changes to base files Atlas deleted\n\nNot applied; the deletions are registered in docs/dev/base-modifications.md. Port anything still relevant by hand. The upstream delta is \`upstream-removed-locally.patch\` in the workflow artifact.\n\n${removedLocally.map(path => `- \`${path}\``).join('\n')}\n`),
  )
  return result
}

export const COMPATIBILITY_COMMANDS = [
  ['bun', 'install', '--frozen-lockfile'],
  ['bun', 'run', 'build:native'],
  ['bun', 'run', 'atlas:lint:ci'],
  ['bun', 'run', 'atlas:typecheck'],
  ['bun', 'run', 'atlas:check:identity-paths'],
  ['bun', 'run', 'atlas:check:license-headers'],
  ['bun', 'run', 'atlas:check:cycles'],
  ['bun', 'run', 'atlas:check:unused'],
  ['bun', 'run', 'atlas:sbom', '--', '--check'],
  ['bun', 'run', 'check:ts'],
  ['bun', 'run', 'test:ts'],
  ['bun', 'run', 'atlas:test'],
  ['bun', 'run', 'atlas:test:registry-ha'],
  ['bun', 'run', 'atlas:build:qm'],
  ['bun', 'run', 'atlas:check:qm-smoke'],
  ['bash', 'demo/ac1-restart.sh'],
] as const
async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'check') {
    console.log(`[omp-pin] OK ${JSON.stringify(checkProvenance(ROOT))}`)
    return
  }
  const out = process.argv[3] ? resolve(process.argv[3]) : undefined
  if (!out || !['prepare', 'verify', 'bundle'].includes(mode ?? ''))
    throw new Error(
      'Usage: bun atlas/scripts/sync-omp.ts check | prepare|verify|bundle <evidence-directory>',
    )
  mkdirSync(out, { recursive: true })
  if (mode === 'prepare') {
    const response = await fetch(
      `https://api.github.com/repos/${UPSTREAM}/releases/latest`,
      {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!response.ok)
      throw new Error(`GitHub release discovery failed: ${response.status}`)
    const release = stableRelease(await response.json())
    const old = pinAt(ROOT)
    let result: CandidateResult
    if (Bun.semver.order(release.version, old.version) <= 0)
      result = {
        status: 'unchanged',
        version: old.version,
        baseHead: git(ROOT, ['rev-parse', 'HEAD']),
      }
    else {
      const upstream = join(out, 'upstream')
      git(ROOT, [
        'clone',
        '--no-checkout',
        '--depth=1',
        '--branch',
        release.tag,
        `https://github.com/${UPSTREAM}.git`,
        upstream,
      ])
      result = prepareCandidate(ROOT, upstream, release.tag, out)
    }
    writeJson(join(out, 'candidate.json'), result)
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `status=${result.status}\nversion=${result.version}\nbranch=${result.branch ?? ''}\nsnapshot=${result.snapshot ?? ''}\n`,
      )
    console.log(JSON.stringify(result))
  } else {
    if (mode === 'verify') {
      // A new attempt invalidates the previous attestation before even parsing
      // metadata. A failed recheck must never leave an old head publishable.
      writeFileSync(join(out, 'verified-head'), '')
      writeJson(join(out, 'checks.json'), [])
    }
    const result = JSON.parse(
      readFileSync(join(out, 'candidate.json'), 'utf8'),
    ) as CandidateResult
    if (
      result.status !== 'prepared' ||
      result.candidate !== join(out, 'candidate') ||
      result.branch !== `codex/sync-omp-${result.version}` ||
      result.snapshot !== `base-snapshot/omp-v${result.version}`
    )
      throw new Error('Invalid candidate metadata')
    const candidate = result.candidate
    if (mode === 'verify') {
      checkProvenance(candidate)
      const checks: { command: readonly string[]; passed: boolean }[] = []
      for (const [i, command] of COMPATIBILITY_COMMANDS.entries()) {
        try {
          run(
            candidate,
            [...command],
            join(out, `gate-${String(i + 1).padStart(2, '0')}.log`),
          )
          checks.push({ command, passed: true })
        } catch (error) {
          checks.push({ command, passed: false })
          writeJson(join(out, 'checks.json'), checks)
          throw error
        }
      }
      // SBOM regeneration is a reviewable metadata change, never auto-ratchet budgets.
      git(candidate, ['add', 'docs/dev/sbom-m0.json', 'docs/dev/sbom-m0.md'])
      if (git(candidate, ['diff', '--cached', '--name-only']))
        git(candidate, [
          'commit',
          '-m',
          `chore(base): refresh omp v${result.version} SBOM`,
        ])
      if (git(candidate, ['status', '--porcelain']))
        throw new Error(
          'Compatibility checks modified unexpected tracked files',
        )
      writeJson(join(out, 'checks.json'), checks)
      writeFileSync(
        join(out, 'verified-head'),
        git(candidate, ['rev-parse', 'HEAD']) + '\n',
      )
    } else {
      if (
        readFileSync(join(out, 'verified-head'), 'utf8').trim() !==
        git(candidate, ['rev-parse', 'HEAD'])
      )
        throw new Error('Candidate changed since compatibility checks')
      git(candidate, [
        'bundle',
        'create',
        join(out, 'candidate.bundle'),
        `refs/heads/${result.branch}`,
        `refs/tags/${result.snapshot}`,
      ])
    }
  }
}
if (import.meta.main)
  main().catch(error => {
    console.error(String(error))
    process.exitCode = 1
  })
