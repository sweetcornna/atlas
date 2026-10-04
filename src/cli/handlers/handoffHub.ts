// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub as git sees it: creating the bare repository, the ref-level rule
 * inside it, and pushing / listing refs (P17.4, gate rulings 1–3 and 5).
 *
 * ## Two SSH identities, on purpose
 *
 * - `qm handoff init` creates `<root>/<project>.git` and installs its
 *   `pre-receive` hook through the user's **own** SSH (`ssh <target>`, their
 *   usual key, no gate): the gate refuses to create repositories, and the
 *   gate key can run nothing but `git-upload-pack` / `git-receive-pack`.
 * - Every push and `ls-remote` uses the **dedicated gate key**:
 *   `GIT_SSH_COMMAND=ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes`.
 *   Without `IdentitiesOnly` ssh may offer the agent's keys first and log in
 *   with one that is not behind the gate; `BatchMode` because a hook has no
 *   one to type a passphrase.
 *
 * A hub given as a local absolute path (tests, or a hub on this machine) is
 * the same bare repository without SSH in between.
 *
 * ## What the hook lets through (gate ruling 5)
 *
 * `refs/qianmo/wip/<device>/<branch>` and `refs/qianmo/sessions/<device>/
 * <session>` — creations, updates and deletions — with `<device>` anything
 * but `cloud`, which belongs to the node. A branch, a tag or any other
 * namespace fails the whole push. The node's own repository gets a different
 * hook in P17.5.
 *
 * ## Pushing
 *
 * One `git push --atomic` with `+<sha>:<ref>` for every ref: both land or
 * neither does. Before it, a `wip` ref that would collide with an existing one
 * as file and directory (`…/feat` versus `…/feat/x`) is deleted first, in its
 * own push (ruling 7) — git cannot hold both. The push runs from the user's
 * repository with their hooks switched off and the options that would make it
 * push more than the named refs (`push.followTags`, submodule recursion)
 * pinned off, so `pre-push` never sees a handoff and nothing but these refs
 * leaves the machine.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '@qianmo/handoff'
import {
  type HandoffProject,
  HandoffUserError,
  type HubLocation,
  hubRepoUrl,
} from './handoffStore.js'

/** The ref-level rule, installed as `hooks/pre-receive` in each hub repository. */
export const PRE_RECEIVE_HOOK = `#!/bin/sh
# Qianmo handoff pre-receive hook, installed by \`qm handoff init\` (P17.4).
#
# Only refs/qianmo/wip/<device>/<branch> and refs/qianmo/sessions/<device>/<session>
# may change here; <device> may not be "cloud", which is the cloud node's.
# Anything else fails the whole push.
LC_ALL=C
export LC_ALL
status=0
while read -r old new ref; do
  : "$old" "$new"
  case "$ref" in
    refs/qianmo/wip/cloud/* | refs/qianmo/sessions/cloud/*) ok=no ;;
    *)
      if printf '%s\\n' "$ref" | grep -Eq '^refs/qianmo/(wip/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[^[:space:]]+|sessions/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$'; then
        ok=yes
      else
        ok=no
      fi
      ;;
  esac
  if [ "$ok" != yes ]; then
    printf '[qianmo handoff] refused %s: only refs/qianmo/wip/<device>/<branch> and refs/qianmo/sessions/<device>/<session> are accepted\\n' "$ref" >&2
    status=1
  fi
done
exit "$status"
`

/** `'…'` for `sh`, for a value known to hold no single quote. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * A path on the far machine as a remote shell expression: `~/…` and relative
 * go under `$HOME`. For the hub root, and for the node's app-server token
 * (`qm handoff attach`, P17.6).
 */
export function remoteRoot(root: string): string {
  if (root.startsWith('/')) return quoted(root)
  const rest = root.startsWith('~/') ? root.slice(2) : root
  return `"$HOME"/${quoted(rest)}`
}

/** The script `init` runs on an SSH hub, hook text included. */
export function remoteInitScript(root: string, project: string): string {
  return [
    'set -eu',
    'umask 077',
    `root=${remoteRoot(root)}`,
    `repo="$root"/${quoted(`${project}.git`)}`,
    'mkdir -p -- "$root"',
    'if [ ! -d "$repo" ]; then git init -q --bare "$repo"; fi',
    'hook="$repo/hooks/pre-receive"',
    'mkdir -p -- "$repo/hooks"',
    'cat > "$hook.tmp" <<\'QIANMO_HANDOFF_HOOK\'',
    PRE_RECEIVE_HOOK.trimEnd(),
    'QIANMO_HANDOFF_HOOK',
    'chmod 755 "$hook.tmp"',
    'mv -f -- "$hook.tmp" "$hook"',
    'printf "%s\\n" "$repo"',
    '',
  ].join('\n')
}

/** Run a command, feeding `input` on stdin; stderr passes through to the user. */
function run(
  argv: readonly string[],
  input: string,
): Promise<{ readonly code: number; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn([...argv], {
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'inherit',
    })
    Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
      ([stdout, code]) => resolve({ code, stdout }),
      reject,
    )
  })
}

/**
 * Create `<root>/<project>.git` on the hub (if missing) and (re)install its
 * `pre-receive` hook. Returns the repository path as the hub reports it.
 */
export async function initHubRepository(
  hub: HubLocation,
  project: string,
): Promise<string> {
  if (hub.kind === 'local') {
    const repo = join(hub.root, `${project}.git`)
    mkdirSync(hub.root, { recursive: true, mode: 0o700 })
    let exists = false
    try {
      exists = statSync(repo).isDirectory()
    } catch {}
    if (!exists) {
      await runGit(['init', '-q', '--bare', repo], { cwd: hub.root })
    }
    mkdirSync(join(repo, 'hooks'), { recursive: true })
    const hook = join(repo, 'hooks', 'pre-receive')
    writeFileSync(hook, PRE_RECEIVE_HOOK, { mode: 0o755 })
    chmodSync(hook, 0o755)
    return repo
  }
  // `--` ends ssh's options; the target was checked not to start with `-`.
  const result = await run(
    ['ssh', '--', hub.target, 'sh -s'],
    remoteInitScript(hub.root, project),
  )
  if (result.code !== 0) {
    throw new HandoffUserError(
      `在中枢上建裸仓失败（ssh ${hub.target} 退出码 ${result.code}）；上面是 ssh 的输出`,
    )
  }
  return result.stdout.trim()
}

// ─── Git against the hub ─────────────────────────────────────────────

/** How to reach one project's bare repository. */
interface HubConnection {
  readonly url: string
  /** `GIT_SSH_COMMAND` for an SSH hub; empty for a local one. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * Only where the repository is and which key opens the gate: the laptop
 * passes its registered project, the hub (P17.5) a node's repository root
 * and the hub's own gate key on that node.
 */
export function hubConnection(
  project: Pick<HandoffProject, 'hub' | 'project' | 'key'>,
): HubConnection {
  const url = hubRepoUrl(project.hub, project.project)
  if (project.hub.kind === 'local') return { url, env: {} }
  if (project.key === undefined) {
    throw new HandoffUserError(
      'SSH 中枢没有登记专用钥匙：重新 qm handoff init --key <钥匙文件>',
    )
  }
  return {
    url,
    env: {
      GIT_SSH_COMMAND: `ssh -i ${quoted(project.key)} -o IdentitiesOnly=yes -o BatchMode=yes`,
    },
  }
}

/** Every ref the hub repository advertises, name → object id. */
export async function lsRemote(
  conn: HubConnection,
  cwd: string,
): Promise<Map<string, string>> {
  const { stdout } = await runGit(['ls-remote', conn.url], {
    cwd,
    env: conn.env,
  })
  const refs = new Map<string, string>()
  for (const line of stdout.toString('utf8').split('\n')) {
    const [sha, ref] = line.split('\t')
    if (sha !== undefined && ref !== undefined && ref !== '') {
      refs.set(ref, sha)
    }
  }
  return refs
}

/**
 * Refs among `existing` that cannot coexist with `target`: one is a directory
 * prefix of the other.
 */
export function dfConflicts(
  existing: Iterable<string>,
  target: string,
): string[] {
  return [...existing].filter(
    ref =>
      ref !== target &&
      (target.startsWith(`${ref}/`) || ref.startsWith(`${target}/`)),
  )
}

/** Run `use` with an empty directory to point `core.hooksPath` at. */
async function withoutHooks<T>(
  use: (hooksPath: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-nohooks-'))
  try {
    return await use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function pushConfig(hooksPath: string): string[] {
  return [
    '-c',
    `core.hooksPath=${hooksPath}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'push.followTags=false',
    '-c',
    'push.recurseSubmodules=no',
    '-c',
    'push.gpgSign=false',
  ]
}

export interface RefUpdate {
  readonly ref: string
  readonly sha: string
}

/**
 * Push `updates` to the hub in one atomic push, deleting first any `wip` ref
 * that collides with one of them as file and directory (ruling 7).
 */
export async function pushToHub(
  conn: HubConnection,
  cwd: string,
  updates: readonly RefUpdate[],
): Promise<void> {
  const remote = await lsRemote(conn, cwd)
  const conflicts = [
    ...new Set(
      updates
        .filter(update => update.ref.startsWith('refs/qianmo/wip/'))
        .flatMap(update => dfConflicts(remote.keys(), update.ref)),
    ),
  ]
  await withoutHooks(async hooksPath => {
    if (conflicts.length > 0) {
      await runGit(
        [
          ...pushConfig(hooksPath),
          'push',
          '--quiet',
          conn.url,
          ...conflicts.map(ref => `:${ref}`),
        ],
        { cwd, env: conn.env },
      )
    }
    await runGit(
      [
        ...pushConfig(hooksPath),
        'push',
        '--quiet',
        '--atomic',
        '--no-verify',
        conn.url,
        ...updates.map(update => `+${update.sha}:${update.ref}`),
      ],
      { cwd, env: conn.env },
    )
  })
}

/**
 * Point the local anti-GC refs at what was just pushed (ruling 8):
 * `refs/qianmo/local/<device>/{wip,sessions}/…`. A local `wip` ref that
 * collides as file and directory is deleted first, as on the hub.
 */
export async function updateLocalRefs(
  cwd: string,
  updates: readonly RefUpdate[],
): Promise<void> {
  await withoutHooks(async hooksPath => {
    const config = ['-c', `core.hooksPath=${hooksPath}`]
    const listed = await runGit(
      [...config, 'for-each-ref', '--format=%(refname)', 'refs/qianmo/local/'],
      { cwd },
    )
    const existing = listed.stdout
      .toString('utf8')
      .split('\n')
      .filter(ref => ref !== '')
    for (const update of updates) {
      for (const ref of dfConflicts(existing, update.ref)) {
        await runGit([...config, 'update-ref', '-d', ref], { cwd })
      }
      await runGit([...config, 'update-ref', update.ref, update.sha], { cwd })
    }
  })
}

/** The commit a local ref points at, or `undefined`. */
export async function localRef(
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  const probe = await runGit(
    ['rev-parse', '-q', '--verify', `${ref}^{commit}`],
    {
      cwd,
      okExitCodes: [1, 128],
    },
  )
  const sha = probe.stdout.toString('utf8').trim()
  return probe.exitCode === 0 && sha !== '' ? sha : undefined
}

/** The work tree's top level containing `cwd`, or `null` outside one. */
export async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    const probe = await runGit(['rev-parse', '--show-toplevel'], {
      cwd,
      okExitCodes: [128],
    })
    const root = probe.stdout.toString('utf8').trim()
    return probe.exitCode === 0 && root !== '' ? root : null
  } catch {
    // `cwd` itself is gone: no work tree either.
    return null
  }
}
