// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * High-permission mode (高权限模式, `docs/dev/elevation.md`, P39) as data and
 * pure functions. The host imports this to grant, gate and audit; the
 * extension imports it to shape the tool surface and rewrite commands into the
 * sandbox. Nothing here touches the filesystem, the network or omp's runtime.
 *
 * Elevation does not turn the resident allowlist into a deny list: it adds one
 * more table that applies only while a grant is live. Tools outside every
 * table stay refused at every tier — `eval` above all, whose interpreter runs
 * in the omp host process, out of the sandbox's reach.
 *
 * The tier ids are Claude Code's names: `accept-edits`, `auto`, `full-access`,
 * plus `off` for the default resident posture.
 *
 * No tier opens `task`: a node never spawns qianmopi-native subagents (the
 * product's sub-agents are other agents on the roster, P29), so `task` stays
 * in the denied table and `before_subagent_spawn` stays blocked.
 */

export type ElevationTier = 'accept-edits' | 'auto' | 'full-access'

const ELEVATION_TIERS: readonly ElevationTier[] = Object.freeze([
  'accept-edits',
  'auto',
  'full-access',
])

function isElevationTier(value: unknown): value is ElevationTier {
  return ELEVATION_TIERS.includes(value as ElevationTier)
}

/** Title of the extension → host confirm that gates every elevated call. */
export const ELEVATION_GATE_TITLE = 'QIANMO_ELEVATION_V1'

/** Host-computed sandbox launcher: the argv before `--chdir`, and the shell. */
export interface ElevationSandbox {
  readonly argv: readonly string[]
  readonly shell: string
}

/**
 * What the host writes for one agent. The extension re-reads it before every
 * elevated call, so a revoked grant stops the next call even in a child that
 * has not been recycled yet; the host gate checks the epoch again.
 */
export interface ElevationResource {
  readonly v: 1
  readonly tier: ElevationTier | 'off'
  readonly epoch: number
  readonly expiresAt: number
  readonly sandbox: ElevationSandbox | null
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

/** A malformed file reads as no grant: elevation can only fail closed. */
export function parseElevationResource(
  value: unknown,
): ElevationResource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const r = value as Record<string, unknown>
  if (
    r.v !== 1 ||
    (r.tier !== 'off' && !isElevationTier(r.tier)) ||
    !Number.isSafeInteger(r.epoch) ||
    !Number.isSafeInteger(r.expiresAt)
  )
    return
  let sandbox: ElevationSandbox | null = null
  if (r.sandbox !== null) {
    const s = r.sandbox as Record<string, unknown> | undefined
    if (
      !s ||
      typeof s !== 'object' ||
      !isStrings(s.argv) ||
      s.argv.length === 0 ||
      typeof s.shell !== 'string' ||
      !s.shell.startsWith('/')
    )
      return
    sandbox = { argv: [...s.argv], shell: s.shell }
  }
  return {
    v: 1,
    tier: r.tier as ElevationResource['tier'],
    epoch: r.epoch as number,
    expiresAt: r.expiresAt as number,
    sandbox,
  }
}

export function elevationActive(
  resource: ElevationResource | undefined,
  now: number = Date.now(),
): resource is ElevationResource & { tier: ElevationTier } {
  return (
    resource !== undefined &&
    resource.tier !== 'off' &&
    now < resource.expiresAt
  )
}

/**
 * Tools a live grant adds to `--tools` and `setActiveTools`. `bash` only when
 * the node has a sandbox: without one, commands are not offered at all. Every
 * tier offers the same surface; the host gate decides per call whether a tier
 * auto-runs it or sends it to the operator for one-shot approval.
 */
export function elevatedTools(
  resource: ElevationResource | undefined,
  now: number = Date.now(),
): string[] {
  if (!elevationActive(resource, now)) return []
  return [...(resource.sandbox ? ['bash'] : []), 'web_search', 'github']
}

/**
 * `local`: stays inside the node (sandboxed commands).
 * `read-out`: reads from the network. `act-out`: changes something outside.
 */
export type ElevationClass = 'local' | 'read-out' | 'act-out'

/**
 * Whether a tier sends one class of call to the operator for a one-shot
 * approval, rather than running it directly. This is the host's deterministic
 * classifier — it reads the tool name and arguments, never a model's claim,
 * and never the base's auto advisor.
 *
 * | tier | local | read-out | act-out |
 * |---|---|---|---|
 * | accept-edits | ask | ask | ask |
 * | auto | run | run | ask |
 * | full-access | run | run | run |
 *
 * Workspace edits run directly under every live tier; they are not elevated
 * calls and never reach this function.
 */
export function elevationNeedsApproval(
  tier: ElevationTier,
  cls: ElevationClass,
): boolean {
  if (tier === 'full-access') return false
  if (tier === 'auto') return cls === 'act-out'
  return true
}

const GITHUB_READ_OPS: ReadonlySet<string> = new Set([
  'repo_view',
  'file_read',
  'search_issues',
  'search_prs',
  'search_code',
  'search_commits',
  'search_repos',
  'run_watch',
])

/**
 * `pr_checkout` and `pr_push` run git mutations on the host, in and next to
 * the workspace, outside the sandbox; they stay refused.
 */
const GITHUB_ACT_OPS: ReadonlySet<string> = new Set(['pr_create'])

/** omp's own URL test for `read` (`isReadableUrlPath`, collapsed schemes too). */
function isUrlRead(path: string): boolean {
  return /^https?:\/\/?/i.test(path) || /^www\./i.test(path)
}

/** The host of a URL read, or `undefined` when it cannot be parsed. */
function urlReadHost(path: string): string | undefined {
  const repaired = path.replace(/^(https?):\/(?!\/)/i, '$1://')
  try {
    return new URL(/^www\./i.test(repaired) ? `https://${repaired}` : repaired)
      .hostname
  } catch {
    return undefined
  }
}

export interface ElevatedCall {
  readonly tool: string
  readonly class: ElevationClass
  readonly op?: string
  readonly hosts?: readonly string[]
  /** The arguments the host binds approvals and digests to. */
  readonly args: Readonly<Record<string, unknown>>
}

/** The base's intent-tracing field; free text, never an argument. */
const INTENT_FIELD = 'i'

function without(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(input).sort())
    if (!keys.includes(key)) out[key] = input[key]
  return out
}

function readEntries(input: Readonly<Record<string, unknown>>): string[] {
  const entries: string[] = []
  for (const value of [input.path, input.paths].flat())
    if (typeof value === 'string')
      for (const part of value.split(';'))
        if (part.trim() !== '') entries.push(part.trim())
  return entries
}

/**
 * Classify one call under a live grant. `undefined`: not an elevated call,
 * the ordinary resident verdict applies. A string: refused, with the reason.
 */
export function elevatedCall(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): ElevatedCall | string | undefined {
  if (toolName === 'bash') {
    const extra = Object.keys(input).filter(
      key => !['command', 'cwd', 'timeout', INTENT_FIELD].includes(key),
    )
    if (extra.length > 0)
      return `bash ${extra.join(', ')} is not available in high-permission mode (no PTY, background jobs or services)`
    if (typeof input.command !== 'string' || input.command.trim() === '')
      return 'bash needs a command'
    if (input.cwd !== undefined && typeof input.cwd !== 'string')
      return 'bash cwd must be a path'
    return {
      tool: 'bash',
      class: 'local',
      args: without(input, [INTENT_FIELD]),
    }
  }
  if (toolName === 'web_search')
    return {
      tool: 'web_search',
      class: 'read-out',
      args: without(input, [INTENT_FIELD]),
    }
  if (toolName === 'github') {
    const op = typeof input.op === 'string' ? input.op : ''
    const kind = GITHUB_READ_OPS.has(op)
      ? 'read-out'
      : GITHUB_ACT_OPS.has(op)
        ? 'act-out'
        : undefined
    if (kind === undefined)
      return `github ${op || '(no op)'} is not available in high-permission mode`
    return {
      tool: 'github',
      class: kind,
      op,
      args: without(input, [INTENT_FIELD]),
    }
  }
  if (toolName === 'read') {
    const entries = readEntries(input)
    const urls = entries.filter(isUrlRead)
    if (urls.length === 0) return undefined
    if (urls.length !== entries.length)
      return 'read cannot mix URLs with local paths'
    const hosts = urls.map(urlReadHost)
    if (hosts.some(host => host === undefined || host === ''))
      return 'read URL could not be parsed'
    return {
      tool: 'read',
      class: 'read-out',
      hosts: [...new Set(hosts as string[])].sort(),
      args: without(input, [INTENT_FIELD]),
    }
  }
  return undefined
}

/** POSIX single-quote one shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Split a line made only of single-quoted words; `undefined` otherwise. */
function quotedWords(line: string): string[] | undefined {
  const words: string[] = []
  let at = 0
  while (at < line.length) {
    if (words.length > 0) {
      if (line[at] !== ' ') return undefined
      at++
    }
    if (line[at] !== "'") return undefined
    let word = ''
    at++
    for (;;) {
      const end = line.indexOf("'", at)
      if (end < 0) return undefined
      word += line.slice(at, end)
      at = end + 1
      if (line.startsWith("\\''", at)) {
        word += "'"
        at += 3
        continue
      }
      break
    }
    words.push(word)
  }
  return words
}

/** The command line that runs `command` inside the agent's sandbox. */
export function sandboxedCommand(
  command: string,
  cwd: string,
  sandbox: ElevationSandbox,
): string {
  return [...sandbox.argv, '--chdir', cwd, '--', sandbox.shell, '-c', command]
    .map(shellQuote)
    .join(' ')
}

/**
 * The model sees its earlier calls in rewritten form and may repeat one.
 * Strip an exact earlier rewrite so a repeat is not nested; anything else,
 * including an edited rewrite, is wrapped again as ordinary text.
 */
export function unsandboxedCommand(
  command: string,
  sandbox: ElevationSandbox,
): string {
  const words = quotedWords(command)
  const head = sandbox.argv.length
  if (
    words === undefined ||
    words.length !== head + 6 ||
    sandbox.argv.some((word, index) => words[index] !== word) ||
    words[head] !== '--chdir' ||
    words[head + 2] !== '--' ||
    words[head + 3] !== sandbox.shell ||
    words[head + 4] !== '-c'
  )
    return command
  return words[head + 5]!
}
