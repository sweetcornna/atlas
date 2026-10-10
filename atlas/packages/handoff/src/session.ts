// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { runGit } from './git.js'
import { isSha } from './manifest.js'
import { redactHandoffSecrets } from './redact.js'
import { REDACTED, redactSecrets, scanForSecrets } from './secrets.js'
import { handoffIdentityEnv } from './shadow.js'

/**
 * A session transcript as a commit: one blob, a tree holding just that blob,
 * and a commit whose parent is the previous sync of the same session — so
 * `refs/qianmo/sessions/<device>/<id>` is a history of the transcript and the
 * landing check is a commit-hash comparison (design v1.1 §5).
 *
 * Plumbing only (`hash-object -w` → `mktree` → `commit-tree`); objects are
 * written into the repository at `cwd` and no ref is touched. The caller
 * pushes `<commit>:<sessionRef>`.
 *
 * The file is hashed byte for byte (`--no-filters`): a transcript lives
 * outside the work tree and must not pick up the project's
 * `.gitattributes` conversions on the way in.
 *
 * ## Secrets: redacted, not refused (ruling 5, 2026-10-03)
 *
 * A transcript routinely contains a key the model read somewhere. Refusing
 * such a session would make most real sessions impossible to hand off, so
 * with {@link SessionCommitOptions.redact} the bytes go through the same
 * gitleaks rule subset as the shadow commit's scan (`secrets.ts`), and
 * every hit is replaced with `[REDACTED]` (`redactSecrets`); then the
 * handoff's own broader rules run (`redact.ts`: generic `sk-` keys, console
 * tokens, `Authorization: Bearer`, `"api_key"` fields → `***`), all before
 * anything is hashed. What comes back is how many spans were replaced and
 * under which rule ids — never the text — so the caller can log the fact
 * without logging the secret. Bytes without a hit are committed exactly as
 * read.
 *
 * ## Unchanged is not a new commit
 *
 * When the tree comes out the same as `parent`'s (nothing was appended since
 * the last sync), `parent` itself is returned with `reused: true`. A sync of
 * the code alone then leaves the session ref where it was instead of growing
 * one empty commit per sync.
 */

export interface SessionCommitOptions {
  /** Any directory inside the repository the objects go into. */
  readonly cwd: string
  /**
   * The transcript file (qmcode rollout JSONL or Claude Code JSONL). A
   * relative path is resolved against `cwd`.
   */
  readonly file: string
  /** Entry name inside the tree; defaults to the file's base name. */
  readonly name?: string
  /** The previous session commit, if this session was synced before. */
  readonly parent?: string
  readonly message?: string
  /**
   * Commit these bytes instead of reading {@link file}, which then only names
   * the entry. Lets a caller commit exactly the prefix it checked — the
   * transcript is appended to while this runs.
   */
  readonly content?: Uint8Array
  /** Redact secrets before hashing; see the module note. */
  readonly redact?: boolean
}

/** What redaction did: counts and rule ids, never matched text. */
export interface SessionRedactions {
  /** Spans replaced with `[REDACTED]`. */
  readonly count: number
  /** gitleaks rule ids that matched, each once. */
  readonly ruleIds: readonly string[]
}

export interface SessionCommit {
  readonly commit: string
  readonly tree: string
  readonly blob: string
  /** The single entry name in `tree`. */
  readonly name: string
  /** True when `parent` had this very tree and is returned as the commit. */
  readonly reused: boolean
  /** `null` unless {@link SessionCommitOptions.redact} was set. */
  readonly redactions: SessionRedactions | null
}

/** Same bound git puts on a path component on every platform it supports. */
const MAX_NAME_BYTES = 255

function assertEntryName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.toLowerCase() === '.git' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.includes('\n') ||
    Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES
  ) {
    throw new TypeError(`unusable session entry name: ${JSON.stringify(name)}`)
  }
}

function occurrences(text: string, needle: string): number {
  let count = 0
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + needle.length)
  ) {
    count++
  }
  return count
}

/** `bytes` with every secret span replaced, and what was replaced. */
function redacted(bytes: Uint8Array): {
  readonly bytes: Uint8Array
  readonly redactions: SessionRedactions
} {
  const text = Buffer.from(bytes).toString('utf8')
  const matches = scanForSecrets(text)
  const clean = matches.length === 0 ? text : redactSecrets(text)
  const vendor =
    matches.length === 0
      ? 0
      : Math.max(
          occurrences(clean, REDACTED) - occurrences(text, REDACTED),
          matches.length,
        )
  const handoff = redactHandoffSecrets(clean)
  if (vendor === 0 && handoff.count === 0) {
    return { bytes, redactions: { count: 0, ruleIds: [] } }
  }
  return {
    bytes: Buffer.from(handoff.text, 'utf8'),
    redactions: {
      count: vendor + handoff.count,
      ruleIds: [...matches.map(match => match.ruleId), ...handoff.ruleIds],
    },
  }
}

/**
 * `text` through the same two passes a transcript gets ({@link redacted}):
 * the gitleaks subset, then the handoff rules. For short texts that leave a
 * machine next to a transcript — the node's turn summary.
 */
export function redactHandoffText(text: string): {
  readonly text: string
  readonly redactions: SessionRedactions
} {
  const bytes = Buffer.from(text, 'utf8')
  const result = redacted(bytes)
  return {
    text:
      result.bytes === bytes
        ? text
        : Buffer.from(result.bytes).toString('utf8'),
    redactions: result.redactions,
  }
}

/** Write `file` as a single-file tree and commit it. Returns the commit. */
export async function sessionCommit(
  options: SessionCommitOptions,
): Promise<SessionCommit> {
  const name = options.name ?? basename(options.file)
  assertEntryName(name)
  if (options.parent !== undefined && !isSha(options.parent)) {
    throw new TypeError(`parent is not a full object id: ${options.parent}`)
  }
  const git = (args: readonly string[], input?: string | Buffer) =>
    runGit(args, {
      cwd: options.cwd,
      env: handoffIdentityEnv(),
      ...(input === undefined ? {} : { input }),
    }).then(result => result.stdout.toString('utf8').trim())

  let blob: string
  let redactions: SessionRedactions | null = null
  if (options.content === undefined && options.redact !== true) {
    blob = await git(['hash-object', '-w', '--no-filters', '--', options.file])
  } else {
    let bytes: Uint8Array =
      options.content ?? readFileSync(resolve(options.cwd, options.file))
    if (options.redact === true) {
      const result = redacted(bytes)
      bytes = result.bytes
      redactions = result.redactions
    }
    blob = await git(
      ['hash-object', '-w', '--no-filters', '--stdin'],
      Buffer.from(bytes),
    )
  }
  // NUL-terminated, so no name is ever read as a C-quoted string.
  const tree = await git(['mktree', '-z'], `100644 blob ${blob}\t${name}\0`)
  if (options.parent !== undefined) {
    // A parent that cannot be read is not reused; `commit-tree` below then
    // fails on it, which is the error the caller should see.
    const probe = await runGit(
      ['rev-parse', '-q', '--verify', `${options.parent}^{tree}`],
      { cwd: options.cwd, okExitCodes: [1, 128] },
    )
    const parentTree = probe.stdout.toString('utf8').trim()
    if (probe.exitCode === 0 && parentTree === tree) {
      return {
        commit: options.parent,
        tree,
        blob,
        name,
        reused: true,
        redactions,
      }
    }
  }
  const commit = await git([
    'commit-tree',
    '--no-gpg-sign',
    ...(options.parent === undefined ? [] : ['-p', options.parent]),
    '-m',
    options.message ?? `qianmo handoff: session ${name}`,
    tree,
  ])
  return { commit, tree, blob, name, reused: false, redactions }
}
