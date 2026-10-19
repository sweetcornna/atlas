// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * The bubblewrap sandbox for a high-permission `bash` command (P39 §3).
 *
 * This is **not** the desktop sandbox (`desktopSandbox.ts`): that one mounts
 * `/` read-only and keeps the node's network, which is right for a browser but
 * wrong for an unattended shell. Here the system tree is mounted read-only one
 * directory at a time, the agent's own workspace is the only writable place,
 * the workspace's policy directories come back read-only on top, and the
 * command gets its own network namespace with nothing in it — so a command can
 * read the workspace but cannot reach the node's files, its keys, another
 * agent, or the network. The only way out is the typed, gated tools.
 */

/** Namespaces every elevated command runs in: no network, no shared IPC/UTS. */
const NAMESPACES: readonly string[] = [
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-uts',
  '--unshare-net',
  '--die-with-parent',
  '--new-session',
]

/** System directories mounted read-only when they exist. */
const SYSTEM_ROOTS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
  '/etc',
  '/opt',
  '/nix',
]

/**
 * Workspace-relative directories made read-only inside the sandbox: VCS
 * internals and the per-project agent configuration a later host run would
 * load as policy (hooks, extensions, settings). A command may read them but
 * never plant one.
 */
const SANDBOX_READONLY_WORKSPACE_DIRS: readonly string[] = [
  '.git',
  '.omp',
  '.claude',
  '.codex',
  '.gemini',
  '.qianmo',
]

/**
 * One bubblewrap run with the namespaces and clearenv every elevated command
 * gets, so a pass means the real launch can work: a user namespace, a fresh
 * pid namespace, an isolated network namespace, and `--clearenv`.
 */
export const ELEVATION_BWRAP_PROBE: readonly string[] = [
  ...NAMESPACES,
  '--ro-bind',
  '/usr',
  '/usr',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--tmpfs',
  '/tmp',
  '--clearenv',
  '--setenv',
  'PATH',
  '/usr/bin:/bin',
  'true',
]

export interface ElevationSandboxInput {
  /** `bwrap` or an absolute path to it. */
  readonly bwrap: string
  /** The shell run inside the sandbox (`/bin/bash`, `/bin/sh`). */
  readonly shell: string
  /** The agent's workspace: the only writable tree. */
  readonly workspace: string
  /** For tests: whether a system path exists. */
  readonly exists?: (file: string) => boolean
}

/**
 * The argv for one agent's elevated shell, up to but not including `--chdir`.
 * {@link sandboxedCommand} appends `--chdir <cwd> -- <shell> -c <command>`.
 * The result is frozen into the grant file; the model cannot change it.
 */
export function elevationSandboxArgv(input: ElevationSandboxInput): string[] {
  const exists = input.exists ?? fs.existsSync
  const workspace = path.resolve(input.workspace)
  const argv: string[] = [
    input.bwrap,
    ...NAMESPACES,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ]
  for (const root of SYSTEM_ROOTS)
    if (exists(root)) argv.push('--ro-bind', root, root)
  argv.push('--bind', workspace, workspace)
  for (const dir of SANDBOX_READONLY_WORKSPACE_DIRS) {
    const inside = path.join(workspace, dir)
    if (exists(inside)) argv.push('--ro-bind', inside, inside)
  }
  argv.push(
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8',
  )
  return argv
}

/** How the host probes for and selects a sandbox when no test override is given. */
export interface ElevationBwrap {
  readonly available: (program: string) => boolean
  readonly probe: (argv: readonly string[]) => Promise<boolean>
  readonly shell: () => string
}

/** The real bubblewrap probe: on PATH, and able to build the probe namespaces. */
export const defaultElevationBwrap: ElevationBwrap = {
  available: program => Bun.which(program) !== null,
  probe: argv =>
    new Promise<boolean>(resolve => {
      try {
        const child = spawn('bwrap', [...argv], {
          stdio: 'ignore',
          timeout: 5_000,
        })
        child.on('error', () => resolve(false))
        child.on('exit', code => resolve(code === 0))
      } catch {
        resolve(false)
      }
    }),
  shell: () => {
    for (const shell of ['/bin/bash', '/usr/bin/bash', '/bin/sh'])
      if (fs.existsSync(shell)) return shell
    return '/bin/sh'
  },
}
