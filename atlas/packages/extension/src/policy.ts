// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The resident posture, as data and pure functions (design
 * `base-switch-omp.md` §3.4).
 *
 * Two processes read this module. The resident host builds the launch
 * arguments, the `--config` overlay and the extension's config file from it;
 * the omp child loads `index.ts`, which applies the same tables in its
 * `tool_call` hook. Nothing here imports omp at runtime, so the host does not
 * pull the agent's module graph in, and every rule can be tested without a
 * child.
 *
 * ## Why an allowlist, not a deny list
 *
 * A project `.omp/config.yml` in the workspace is a settings layer below the
 * overlay (docs/config-usage.md "Layers"): it cannot change a key the overlay
 * sets, but it can add keys the overlay does not mention — a
 * `tools.approval.bash: allow` the overlay never named would hold. The same
 * goes for tools that appear later (an MCP server, a host tool, a tool a
 * future omp adds). So the overlay is the second line, and the first is the
 * table below: a resident turn runs the tools named here and nothing else,
 * whatever the settings say.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { protectedConfigRoots } from '@qianmo/paths'
import { ResidentHardline } from '@qianmo/resident/guard'

/** Environment variable naming the extension's JSON config file. */
export const RESIDENT_EXTENSION_CONFIG_ENV = 'QIANMO_EXTENSION_CONFIG'

/** What the host tells the extension running inside one resident child. */
export interface ResidentExtensionConfig {
  readonly v: 1
  readonly agent: string
  /** Absolute workspace = the omp child's cwd. */
  readonly workspace: string
  /**
   * `none`: read-only node (the default). `workspace`:
   * `qm resident --allow-workspace-edits`, writes only inside `workspace`.
   */
  readonly edits: 'none' | 'workspace'
  /**
   * Extra absolute roots refused whole — the host's memory root. Additive to
   * `protectedConfigRoots()`; a relative entry is dropped by the hardline.
   */
  readonly protectedRoots: readonly string[]
  /** Host-owned tools registered with `set_host_tools` (`qianmo_notify`). */
  readonly hostTools: readonly string[]
  readonly approvals?: boolean
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Parse and validate the config file named by
 * {@link RESIDENT_EXTENSION_CONFIG_ENV}. Throws on anything malformed: the
 * extension refuses every tool call when this throws, so a missing or damaged
 * file can only make a resident turn do less.
 */
export function readResidentExtensionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResidentExtensionConfig {
  const path = env[RESIDENT_EXTENSION_CONFIG_ENV]
  if (path === undefined || path === '') {
    throw new Error(`${RESIDENT_EXTENSION_CONFIG_ENV} is not set`)
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('resident extension config is not an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.v !== 1) throw new Error('resident extension config: v must be 1')
  if (typeof record.agent !== 'string' || record.agent === '') {
    throw new Error('resident extension config: agent is missing')
  }
  if (typeof record.workspace !== 'string' || !isAbsolute(record.workspace)) {
    throw new Error('resident extension config: workspace must be absolute')
  }
  if (record.edits !== 'none' && record.edits !== 'workspace') {
    throw new Error('resident extension config: edits must be none|workspace')
  }
  if (!isStringArray(record.protectedRoots)) {
    throw new Error('resident extension config: protectedRoots must be strings')
  }
  if (!isStringArray(record.hostTools)) {
    throw new Error('resident extension config: hostTools must be strings')
  }
  return {
    v: 1,
    agent: record.agent,
    workspace: record.workspace,
    edits: record.edits,
    protectedRoots: record.protectedRoots,
    hostTools: record.hostTools,
    ...(record.approvals === true ? { approvals: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Input identity (§4.3 crash recovery)
// ---------------------------------------------------------------------------

/**
 * `customType` of the session entry written once per accepted resident input.
 * `data` is `{ messageId: string }`.
 */
export const RESIDENT_INPUT_IDENTITY_ENTRY = 'qianmo.resident.input-identity'

const MARKER_PREFIX = '<!-- qianmo-input '
const MARKER_SUFFIX = ' -->\n'
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,200}$/

/**
 * Host side: put the admission ledger's `messageId` in front of the prompt,
 * where the extension's `input` hook takes it off again before the text
 * becomes a user message. omp's RPC `prompt` has no field for it.
 */
export function markResidentInput(messageId: string, text: string): string {
  if (!MESSAGE_ID.test(messageId)) {
    throw new Error(`resident input id is not marker-safe: ${messageId}`)
  }
  return `${MARKER_PREFIX}${messageId}${MARKER_SUFFIX}${text}`
}

/** Extension side: split a marked prompt; `undefined` when unmarked. */
export function unmarkResidentInput(
  text: string,
): { readonly messageId: string; readonly text: string } | undefined {
  if (!text.startsWith(MARKER_PREFIX)) return undefined
  const end = text.indexOf(MARKER_SUFFIX, MARKER_PREFIX.length)
  if (end < 0) return undefined
  const messageId = text.slice(MARKER_PREFIX.length, end)
  if (!MESSAGE_ID.test(messageId)) return undefined
  return { messageId, text: text.slice(end + MARKER_SUFFIX.length) }
}

/**
 * Host side: the `messageId` if one parsed session-JSONL line is an identity
 * entry, else `undefined`.
 */
export function residentInputIdentityOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  if (record.type !== 'custom') return undefined
  if (record.customType !== RESIDENT_INPUT_IDENTITY_ENTRY) return undefined
  const data = record.data
  if (typeof data !== 'object' || data === null) return undefined
  const messageId = (data as Record<string, unknown>).messageId
  return typeof messageId === 'string' && messageId.length > 0
    ? messageId
    : undefined
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/**
 * Read-only inspection tools. Their local paths must resolve inside the
 * workspace: a read-tier tool is auto-approved by omp in every mode, and an
 * unattended turn that can read `~/.ssh` can put it in its answer.
 */
export const RESIDENT_READ_TOOLS: readonly string[] = Object.freeze([
  'read',
  'grep',
  'glob',
])

/** Tools that act on the session only, never on the filesystem or network. */
export const RESIDENT_SESSION_TOOLS: readonly string[] = Object.freeze([
  'todo',
  'yield',
  'wait',
])

/** Mutating tools, granted only with `edits: 'workspace'`. */
export const RESIDENT_WRITE_TOOLS: readonly string[] = Object.freeze([
  'write',
  'edit',
  'ast_edit',
])

/**
 * Tools denied in the overlay as well (`tools.approval.<name>: deny`), so a
 * subagent — which omp runs in `yolo` — still cannot use them even if the
 * extension were somehow not bound there. Shell and code execution, agent
 * spawning, network and skill/memory writers: everything that would let one
 * unattended turn run code, arrange more work, or leave state that a later
 * turn trusts.
 */
export const RESIDENT_DENIED_TOOLS: readonly string[] = Object.freeze([
  'bash',
  'eval',
  'task',
  'browser',
  'debug',
  'ida',
  'github',
  'lsp',
  'security_scan',
  'web_search',
  'fetch',
  'memory_edit',
  'retain',
  'recall',
  'reflect',
  'learn',
  'manage_skill',
  'new_context',
  'context_notes',
  'goal',
  'ask',
  'computer',
])

/**
 * Internal URI schemes a read tool may name: session artifacts and
 * attachments, the session's scratch area, and instruction content omp
 * itself loads. Everything else (`cfg://`, `vault://`, `ssh://`, `mcp://`,
 * `http(s)://`, `pr://` …) reaches configuration, secrets or the network.
 */
const READ_SCHEMES: ReadonlySet<string> = new Set([
  'artifact',
  'attachment',
  'local',
  'skill',
  'rule',
])

/** The active tool names for one posture (`--tools`, `setActiveTools`). */
export function residentActiveTools(
  edits: ResidentExtensionConfig['edits'],
  hostTools: readonly string[] = [],
): string[] {
  return [
    ...RESIDENT_READ_TOOLS,
    ...RESIDENT_SESSION_TOOLS,
    ...(edits === 'workspace' ? RESIDENT_WRITE_TOOLS : []),
    ...hostTools,
  ]
}

function yamlKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key)
}

/**
 * YAML for the per-process `--config` overlay.
 *
 * `--approval-mode` is passed as well and outranks this file (a runtime
 * override); the overlay restates it so the file alone describes the posture.
 * The rest closes load sites and background work a project config could
 * otherwise switch on for a turn nobody is watching.
 */
export function residentConfigOverlay(options: {
  readonly edits: ResidentExtensionConfig['edits']
  readonly hostTools?: readonly string[]
}): string {
  const approvals: [string, string][] = [
    ...RESIDENT_DENIED_TOOLS.map(name => [name, 'deny'] as [string, string]),
    // A host tool has no approval tier, so omp treats it as `exec`, which
    // prompts — and fails — in both resident modes. The extension's allowlist
    // is what decides whether it runs.
    ...(options.hostTools ?? []).map(
      name => [name, 'allow'] as [string, string],
    ),
  ]
  return [
    '# Qianmo resident overlay, written by the resident host. Do not edit:',
    '# it is regenerated for every omp child the node starts.',
    'tools:',
    `  approvalMode: ${options.edits === 'workspace' ? 'write' : 'always-ask'}`,
    '  approval:',
    ...approvals.map(([name, policy]) => `    ${yamlKey(name)}: ${policy}`),
    'edit:',
    '  mode: hashline',
    'mcp:',
    '  enableProjectConfig: false',
    'advisor:',
    '  enabled: false',
    'goal:',
    '  enabled: false',
    'async:',
    '  enabled: false',
    'browser:',
    '  enabled: false',
    'web_search:',
    '  enabled: false',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Tool-call verdicts
// ---------------------------------------------------------------------------

/** One `tool_call` as the extension sees it. */
export interface ResidentToolCall {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}

/** Who is calling: the main agent, or a subagent / advisor. */
export interface ResidentCallContext {
  readonly agentKind: 'main' | 'sub'
}

export interface ResidentToolBlock {
  readonly approvalEligible?: boolean
  readonly block: true
  readonly reason: string
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

/** `~` → home, then absolute against `base`; no symlink resolution yet. */
function lexicalPath(raw: string, base: string): string {
  const expanded =
    raw === '~'
      ? homedir()
      : raw.startsWith('~/')
        ? join(homedir(), raw.slice(2))
        : raw
  return resolve(base, expanded)
}

/**
 * The real path of `target`: the deepest existing ancestor through
 * `realpath`, with the not-yet-existing remainder appended. A symlink inside
 * the workspace that points out of it resolves out of it.
 */
function realPath(target: string): string {
  let existing = target
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    rest.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    existing = parent
  }
  let base: string
  try {
    base = realpathSync(existing)
  } catch {
    base = existing
  }
  return rest.length === 0 ? base : join(base, ...rest)
}

function inside(child: string, root: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The directory part of a path that may end in a glob. */
function globBase(raw: string): string {
  const meta = raw.search(/[*?[{]/)
  if (meta < 0) return raw
  const head = raw.slice(0, meta)
  const slash = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  return slash < 0 ? '.' : head.slice(0, slash + 1) || '/'
}

/** Split a path field: a list, or omp's semicolon-delimited list. */
function pathEntries(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  const entries: string[] = []
  for (const one of values) {
    if (typeof one !== 'string') continue
    for (const part of one.split(';')) {
      const trimmed = part.trim()
      if (trimmed !== '') entries.push(trimmed)
    }
  }
  return entries
}

const READ_PATH_FIELDS = ['path', 'paths'] as const

/** `apply_patch` headers that name a file the patch writes. */
const APPLY_PATCH_TARGET =
  /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

/** Every path an edit-family call writes, or `undefined` when unknowable. */
function writeTargets(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string[] | undefined {
  const targets: string[] = []
  if (toolName === 'write') {
    targets.push(...pathEntries(input.path))
  } else if (toolName === 'ast_edit') {
    targets.push(...pathEntries(input.paths))
  } else if (toolName === 'edit') {
    // Replace/patch modes name `path`; omp's event normalizer adds `path` /
    // `paths` for hashline input and copies `_path`.
    targets.push(...pathEntries(input.path))
    targets.push(...pathEntries(input.paths))
    targets.push(...pathEntries(input._path))
    const edits = input.edits
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        if (typeof edit === 'object' && edit !== null) {
          targets.push(...pathEntries((edit as Record<string, unknown>).rename))
        }
      }
    }
    for (const key of ['input', '_input'] as const) {
      const text = input[key]
      if (typeof text !== 'string') continue
      for (const match of text.matchAll(APPLY_PATCH_TARGET)) {
        targets.push((match[1] as string).trim())
      }
    }
  }
  return targets.length === 0 ? undefined : targets
}

/**
 * Workspace-relative paths that are still off limits to a write: the
 * project's own omp/Claude configuration, which a later child would load as
 * policy (hooks, extensions, settings), and VCS internals, where a hook script
 * is code that runs outside any turn.
 */
const WORKSPACE_POLICY_DIRS: readonly string[] = Object.freeze([
  '.omp',
  '.claude',
  '.codex',
  '.gemini',
  '.qianmo',
  '.git',
])

function block(reason: string): ResidentToolBlock {
  return { block: true, reason: `Qianmo resident posture: ${reason}` }
}

/**
 * Whether one tool call may run in a resident session, apart from the
 * hardline table (`ResidentHardline`, applied first by the extension).
 * `undefined` means allowed.
 */
export function residentToolVerdict(
  call: ResidentToolCall,
  config: ResidentExtensionConfig,
  context: ResidentCallContext,
): ResidentToolBlock | undefined {
  const { toolName, input } = call
  if (config.hostTools.includes(toolName)) {
    // Host tools act through the host, which attributes them to the running
    // task; a subagent has no task of its own to attribute to.
    return context.agentKind === 'main'
      ? undefined
      : block(`${toolName} is available to the main agent only`)
  }
  const workspace = realPath(config.workspace)
  // The lexical hook cannot recognize an alias for a protected directory.
  // Check canonical targets too, including non-existent children of symlinks.
  const protectedRoots = [...protectedConfigRoots(), ...config.protectedRoots]
    .filter(isAbsolute)
    .map(realPath)
  const hardline = new ResidentHardline({
    stateRoots: protectedRoots,
    protectedRoots,
  })
  if (RESIDENT_SESSION_TOOLS.includes(toolName)) return undefined
  if (RESIDENT_READ_TOOLS.includes(toolName)) {
    // grep/glob default to cwd when no path is supplied. A directory/glob
    // scope that contains a protected subtree cannot safely be searched by
    // the native tool: it has no host-enforced per-file exclusion callback.
    const entries = READ_PATH_FIELDS.flatMap(field => pathEntries(input[field]))
    for (const entry of entries.length === 0 ? ['.'] : entries) {
      const scheme = SCHEME.exec(entry)?.[1]?.toLowerCase()
      if (scheme !== undefined && scheme !== 'file') {
        if (READ_SCHEMES.has(scheme)) continue
        return block(`${toolName} may not read ${scheme}:// resources`)
      }
      const local = scheme === 'file' ? entry.replace(SCHEME, '') : entry
      const target = realPath(lexicalPath(globBase(local), workspace))
      const denial = hardline.pathVerdict(target)
      if (denial !== null) return block(denial.target.reason)
      if (protectedRoots.some(root => inside(root, target))) {
        return block(
          `${toolName} scope contains a protected root; select an unprotected file or subtree`,
        )
      }
      if (!inside(target, workspace)) {
        return block(
          `${toolName} is limited to this node's workspace; ${entry} is outside it`,
        )
      }
    }
    return undefined
  }
  if (RESIDENT_WRITE_TOOLS.includes(toolName)) {
    if (config.edits !== 'workspace') {
      return block(
        `${toolName} is not available: this node runs read-only (start it with --allow-workspace-edits to allow edits inside the workspace)`,
      )
    }
    const targets = writeTargets(toolName, input)
    if (targets === undefined) {
      return block(`could not determine which files ${toolName} would change`)
    }
    let outside = false
    for (const entry of targets) {
      if (SCHEME.test(entry)) {
        return block(`${toolName} may only write local files, not ${entry}`)
      }
      const target = realPath(lexicalPath(globBase(entry), workspace))
      const denial = hardline.pathVerdict(target)
      if (denial !== null) return block(denial.target.reason)
      if (!inside(target, workspace)) {
        outside = true
      }
      const first = relative(workspace, target).split(/[\\/]/)[0]
      if (
        first !== undefined &&
        (WORKSPACE_POLICY_DIRS.includes(first) ||
          first.startsWith('.qianmo-backup') ||
          target
            .split(/[\\/]/)
            .some(part => WORKSPACE_POLICY_DIRS.includes(part)))
      ) {
        return block(
          `${toolName} may not change ${first}/: it holds configuration or hooks a later run would load`,
        )
      }
    }
    if (outside)
      return {
        ...block(
          `${toolName} may only change files inside this node's workspace`,
        ),
        ...(config.approvals === true ? { approvalEligible: true } : {}),
      }
    return undefined
  }
  return block(
    `${toolName} is not available to an unattended resident turn (no shell, code execution, subagents, network or memory writes)`,
  )
}

/** Bind an approval to both exact arguments and their current canonical targets. */
export function residentApprovalInput(
  call: ResidentToolCall,
  workspace: string,
): Readonly<Record<string, unknown>> {
  const targets = writeTargets(call.toolName, call.input)
  if (targets === undefined)
    throw new Error('approval has no concrete file target')
  return {
    ...call.input,
    __qianmoResolvedTargets: targets.map(target =>
      realPath(lexicalPath(target, workspace)),
    ),
  }
}
