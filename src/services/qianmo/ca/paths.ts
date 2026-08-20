// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Where the offline CA keeps its material (`key-distribution.md` §6.1).
 *
 * ## The one deliberate exception to CLAUDE.md §1.1②
 *
 * Every other user-level path in this repository is derived from
 * `src/config/paths.ts`. This one is NOT, and §6.1 spells out why in one
 * sentence: the CA private key must not live in *any* identity's config root.
 * §3.3 lists the places it is forbidden to appear — a node's config root and
 * everything derived from it, `DEMO_ROOT`, the repository, CI secrets, and
 * anything the console process can reach — and "under `occConfigPath(...)`" is
 * the first of those. Deriving this path from `paths.ts` would put it there.
 *
 * So the exception is the point, not an oversight, and the guard below makes
 * it enforceable rather than merely commented: {@link caDirectory} refuses any
 * directory that resolves inside a protected config root. The next person to
 * "顺手统一" this module will get a thrown error, not a silently relocated CA.
 *
 * ## Everything else here is a literal, and that is on purpose too
 *
 * §10.3 asks for a scan in the shape of `check:identity-paths`: CA directory
 * literals must not appear in node-side code. That is only checkable if there
 * is exactly one file where they DO appear — this one. `__tests__/caScan.test.ts`
 * is the scan; the allowlist there names this file.
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { NODE_IDENTITY_MODE } from '../../../constants/identity.js'
import { getProtectedUserConfigDirectories } from '../../../config/paths.js'

/**
 * Override for the CA root.
 *
 * Named alongside the rest of the Qianmo environment surface
 * (`QIANMO_CONSOLE_ADMIN_TOKEN`, `QIANMO_TRANSPORT_PSK`, …) so an operator who
 * knows one knows where to look for this one.
 */
export const CA_DIR_ENV_VAR = 'QIANMO_CA_DIR'

/**
 * Default CA root basename: `.qianmo-ca` under the home directory.
 *
 * Built from the identity roster rather than spelled out, because
 * CLAUDE.md §2.3 allows the network's name to be written exactly once
 * (`src/constants/identity.ts`). The `-ca` suffix keeps it a *sibling* of
 * `~/.qianmo`, never a child: a child would be inside the node's config root,
 * which is precisely what §3.3 forbids.
 */
const CA_DIR_BASENAME = `.${NODE_IDENTITY_MODE}-ca`

/**
 * How the default is written in help text.
 *
 * Exported so the CLI can name it without spelling the basename a second time
 * — §10.3's scan treats a CA directory literal outside this file as a failure,
 * and "it was only in a help string" is exactly the kind of exception that
 * makes a zero-tolerance scan stop being zero-tolerance.
 */
export const CA_DIR_DEFAULT_DISPLAY = `~/${CA_DIR_BASENAME}`

/** Directory mode for everything the CA writes. Private key material lives here. */
export const CA_DIR_MODE = 0o700

/**
 * File mode for private material. Passed at creation, never chmod-ed
 * afterwards — a window in which a private key is world-readable is still a
 * window (§3.3, same discipline as `nodeIdentity.ts`).
 */
export const CA_PRIVATE_FILE_MODE = 0o600

/** File mode for public material: certificates, the signed RL, the serial. */
export const CA_PUBLIC_FILE_MODE = 0o644

/** True when `candidate` is `root` itself or sits underneath it. */
function isInside(candidate: string, root: string): boolean {
  // Compared with a separator appended, because `~/.qianmo-ca` starts with
  // `~/.qianmo` as a raw string while being a different directory entirely.
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

/**
 * The CA root: `$QIANMO_CA_DIR`, or `~/.qianmo-ca`.
 *
 * Throws when the resolved directory lands inside a protected config root
 * (§3.3). That check is cheap and it is the only mechanical defence against
 * the failure this module is built to prevent — a CA private key sitting
 * inside a directory that a node process, the console, or `occ migrate` walks.
 */
export function caDirectory(explicit?: string): string {
  const configured = explicit ?? process.env[CA_DIR_ENV_VAR]
  const directory = resolve(
    configured === undefined || configured.length === 0
      ? join(homedir(), CA_DIR_BASENAME)
      : configured,
  )
  for (const protectedRoot of getProtectedUserConfigDirectories()) {
    if (isInside(directory, resolve(protectedRoot))) {
      throw new Error(
        `refusing a CA directory inside a config root: ${directory} is under ` +
          `${protectedRoot}. The CA private key must not live in any ` +
          `identity's config root (key-distribution.md §3.3).`,
      )
    }
  }
  return directory
}

/** The CA's Ed25519 private key, PEM. Never leaves this machine. */
export function caKeyPath(directory: string): string {
  return join(directory, 'ca.key')
}

/** The self-signed root certificate, PEM. Public material. */
export function caCertPath(directory: string): string {
  return join(directory, 'ca.crt')
}

/** openssl's serial file, kept beside the key so `-CAcreateserial` is stable. */
export function caSerialPath(directory: string): string {
  return join(directory, 'ca.srl')
}

/** Copies of what has been issued, so a revocation can be looked up later. */
export function issuedCertPath(directory: string, node: string): string {
  return join(directory, 'issued', `${node}.crt`)
}

/**
 * The operator's accumulated revocation entries — the *input* to `refresh-rl`.
 *
 * Separate from the signed artefact below because they are different things:
 * this one is the CA's memory of what has been revoked, the other is a dated,
 * signed statement about it that expires (§6.2, `nextUpdate` = 30 days).
 */
export function revocationStatePath(directory: string): string {
  return join(directory, 'revoked.json')
}

/** The signed revocation list, published to the registry (§6.4). Public. */
export function revocationListPath(directory: string): string {
  return join(directory, 'revocation-list.json')
}
