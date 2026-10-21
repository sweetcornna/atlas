// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { WORKSPACE_POLICY_DIRS } from '@qianmo/extension/policy'

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
 * Workspace-relative directories made read-only inside the sandbox: the same
 * table the resident write verdict protects — VCS internals and the
 * per-project agent configuration a later host run would load as policy
 * (hooks, extensions, settings). A command may read them but never plant one.
 */
const SANDBOX_READONLY_WORKSPACE_DIRS = WORKSPACE_POLICY_DIRS

function real(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * The probe for one agent: its real sandbox argv running `<shell> -c true`
 * in its workspace, without the program name (the probe spawns `bwrap`).
 */
export function elevationProbeArgv(
  argv: readonly string[],
  workspace: string,
  shell: string,
): string[] {
  return [
    ...argv.slice(1),
    '--chdir',
    real(workspace),
    '--',
    shell,
    '-c',
    'true',
  ]
}

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
  // The extension hands bash a canonical cwd (`residentWorkspaceTarget`), so
  // the workspace is mounted at its real path too.
  const workspace = real(input.workspace)
  const argv: string[] = [
    input.bwrap,
    ...NAMESPACES,
    // UTS is unshared anyway; do not show the node's own host name.
    '--hostname',
    'sandbox',
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
