// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ceiling on what an unattended turn may do (design
 * `resident-botization.md` §4.5, hermes E2 / E3 / E5; on omp,
 * `base-switch-omp.md` §3.4).
 *
 * WHAT THE RISK ACTUALLY IS
 *
 * A resident node runs its agent with nobody watching, on input that arrives
 * from other nodes. The approval posture (`always-ask`, or `write` with
 * `--allow-workspace-edits`, and no UI to answer a prompt) already refuses
 * whatever is not pre-approved. What is missing is a **ceiling on
 * pre-approval**: one `tools.approval.<tool>: allow` in a config layer, one
 * project extension that answers `tool_call`, or one approved shell command
 * can reach anything at all, including editing that same configuration,
 * reading the node's identity key, or truncating the audit trail that would
 * have recorded it. So the thing to build is a list of targets no
 * pre-approval reaches, evaluated **before** any allow is consulted.
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING
 *
 * **It is evaluated before allow.** `@qianmo/extension` runs this table in
 * omp's `tool_call` hook, which fires at argument-preparation time for every
 * model-issued call — ahead of the approval gate — and a block there is
 * final.
 *
 * **It is not read from session configuration.** The table below is a frozen
 * literal in this package. It has no settings reader, no environment lookup and
 * no constructor parameter that can empty it — the only injected values are
 * absolute state roots, which *add* coverage and cannot remove any. A hardline
 * list that a session could edit would be protecting the file that edits it.
 *
 * ON THE SHELL HALF
 *
 * Blocking the file tools alone is what hermes calls unpaired theatre: a shell
 * can `cat`, `tee`, `sed -i` and `rm` every one of these targets. So the same
 * table is applied to command strings, over every path-shaped token in them.
 * The resident posture gives a turn no shell at all; the table still covers
 * the shell surface so that a posture change cannot quietly open it.
 *
 * The honest limit: a determined command can obscure a path from any lexical
 * matcher (`$(printf 'admission')`, a variable assembled at runtime, a copy
 * made under another name first). This is a ceiling on pre-approval, not a
 * sandbox — the sandbox is a separate, coarser mechanism and stays the thing
 * that contains a genuinely hostile command. What this does guarantee is that
 * no *rule* and no *hook* can hand out access to these paths, and that the
 * ordinary ways of reaching them are refused on both surfaces rather than one.
 */

import { isAbsolute, normalize, sep } from 'node:path'

/**
 * Config-directory basenames of every agent runtime a node may find on disk:
 * its own (`.qianmo`, which holds the omp agent state under `omp/`), omp's
 * default (`.omp`), and the other agents' homes omp reads by default.
 */
const IDENTITY_DIRS: readonly string[] = Object.freeze([
  '.qianmo',
  '.omp',
  '.claude',
  '.codex',
  '.qmcode',
])

/** Directories under a config root that hold node-owned state. */
const NODE_STATE_DIRS: readonly string[] = Object.freeze(['resident', 'qianmo'])

/**
 * Customization directories under a config root. A file in any of these is
 * *loaded* as behaviour — an extension or hook runs code, an agent definition
 * sets a model and tools, a skill, rule or prompt injects instructions — so
 * writing one is the same class of self-authorization as editing the settings
 * (hermes E1/E3/E4). The list is omp's discovery set
 * (`docs/config-usage.md`) plus the Claude-compatible names it also reads.
 *
 * Matched under a known state root or spelled out under an identity directory,
 * exactly like `SETTINGS_FILES`: a `.omp/extensions/x.ts` in the repository
 * the agent is working in is loaded by the next omp process started there, so
 * it is policy in the same sense as the global one. Reads are refused as well
 * as writes: a resident turn has no reason to read the node's own agent,
 * skill or extension catalogue.
 */
const CONFIG_CUSTOMIZATION_DIRS: readonly string[] = Object.freeze([
  'agents',
  'skills',
  'plugins',
  'commands',
  'hooks',
  'extensions',
  'tools',
  'rules',
  'prompts',
])

/** Files that *are* the security policy (hermes E3): omp's and Claude's. */
const SETTINGS_FILES: readonly string[] = Object.freeze([
  'settings.json',
  'settings.local.json',
  'config.yml',
  'config.yaml',
  'config.toml',
  'mcp.json',
  '.mcp.json',
])

/**
 * The omp agent's model endpoints and credentials (`models.yml`, the
 * `agent.db` credential pool). Matched like the settings files: inside a state
 * root or an identity directory.
 */
const CREDENTIAL_FILES: readonly string[] = Object.freeze([
  'models.yml',
  'models.yaml',
  'agent.db',
  'agent.db-wal',
  'agent.db-shm',
])

/**
 * State files whose basename alone is enough to refuse.
 *
 * Matched without regard to where they sit, deliberately: the node's state
 * directory is derived from the config root, and a deployment that moved that
 * root would otherwise silently lose the protection. A false positive here
 * costs a resident agent access to somebody else's file with the same name,
 * which is a price worth paying for a list this short.
 */
const NODE_STATE_FILES: readonly string[] = Object.freeze([
  'admission.ndjson',
  'deliveries.ndjson',
  'notifies.ndjson',
  'trail.ndjson',
  'sessions.json',
  'lifecycle.json',
  'ESTOP',
])

export interface HardlineTarget {
  /** Stable id, used in messages and in tests. */
  readonly id: string
  /** Why this target is on the list, in one line, for the denial message. */
  readonly reason: string
}

export const HARDLINE_TARGETS: readonly HardlineTarget[] = Object.freeze([
  Object.freeze({
    id: 'settings',
    reason:
      'settings files are the permission policy itself; editing them is how a ' +
      'turn would grant itself everything else',
  }),
  Object.freeze({
    id: 'credentials',
    reason:
      "the agent's model endpoints and credentials; a turn that can read or " +
      "rewrite them can spend or leak the node's model access",
  }),
  Object.freeze({
    id: 'node-identity',
    reason:
      "the node's identity key and capability material; whoever holds it can " +
      'speak as this node to every peer',
  }),
  Object.freeze({
    id: 'audit-trail',
    reason:
      'the hash-chained audit trail; a turn that can rewrite it can erase the ' +
      'record of what it did',
  }),
  Object.freeze({
    id: 'node-state',
    reason:
      'admission, delivery, session and lifecycle state; corrupting it loses ' +
      'messages this node already promised to handle',
  }),
  Object.freeze({
    id: 'config-root',
    reason:
      "a config root as a whole — the node's own, which contains all of the " +
      "above and the agent's sessions, or another agent runtime's home",
  }),
  Object.freeze({
    id: 'config-customization',
    reason:
      'extension, hook, tool, agent, skill, rule, prompt, plugin and command ' +
      'definitions under a config root; each is loaded as behaviour, so writing ' +
      'one grants a turn a new approval, instruction or code path',
  }),
  Object.freeze({
    id: 'memory-root',
    reason:
      "the node's memory store; a turn that can write it plants a memory a later " +
      'turn trusts as evidence, which no single approval should be able to do',
  }),
])

const TARGET_BY_ID: ReadonlyMap<string, HardlineTarget> = new Map(
  HARDLINE_TARGETS.map(target => [target.id, target]),
)

export interface HardlineDenial {
  readonly target: HardlineTarget
  /** The path or command token that matched. */
  readonly matched: string
  /** Which surface caught it — the pair E3 asks for. */
  readonly surface: 'file' | 'shell'
}

export interface ResidentHardlineOptions {
  /**
   * Absolute config roots no resident turn may enter: the node's own
   * (`QIANMO_CONFIG_DIR`, which also holds the omp agent's sessions and
   * credentials) and the other agent homes (`protectedConfigRoots()` in
   * `@qianmo/paths`). Refused whole; the per-name rules below still name the
   * most specific target first. Additive only: every lexical rule applies
   * whether or not this is provided, so an empty list weakens nothing.
   * Non-absolute entries are ignored rather than resolved — a relative root
   * would be interpreted against the agent's working tree, which is the F9
   * mistake in a different costume.
   */
  readonly stateRoots?: readonly string[]
  /**
   * Absolute subtrees that are refused whole, without any per-name rule. The
   * node's memory store is the one the host supplies: it can sit outside the
   * config root (`QIANMO_MEMORY_DIR`), and a resident turn never
   * reaches it through the filesystem — the host reads and injects memory for
   * it — so the whole tree is off limits and a stray approval cannot poison a
   * later turn's evidence. Same absolute-only discipline as `stateRoots`.
   */
  readonly protectedRoots?: readonly string[]
}

function segmentsOf(rawPath: string): readonly string[] {
  return normalize(rawPath)
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
}

/**
 * Index of `first` where it is immediately followed by `second`, or -1.
 *
 * Two adjacent segments rather than "both appear somewhere" on purpose: it is
 * `qianmo/identity`, in that order and touching, that names the key directory —
 * a path that merely mentions both words elsewhere is not it.
 */
function sequenceIndex(
  segments: readonly string[],
  first: string,
  second: string,
): number {
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] === first && segments[i + 1] === second) return i
  }
  return -1
}

function withinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = normalize(root).replace(/[/\\]+$/, '')
  const normalizedCandidate = normalize(candidate)
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + sep) ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  )
}

export class ResidentHardline {
  readonly #stateRoots: readonly string[]
  readonly #protectedRoots: readonly string[]

  constructor(options: ResidentHardlineOptions = {}) {
    this.#stateRoots = Object.freeze(
      (options.stateRoots ?? []).filter(root => isAbsolute(root)),
    )
    this.#protectedRoots = Object.freeze(
      (options.protectedRoots ?? []).filter(root => isAbsolute(root)),
    )
  }

  /** The hardline verdict for a filesystem path, or `null` when it is clear. */
  pathVerdict(rawPath: string): HardlineDenial | null {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return null
    const segments = segmentsOf(rawPath)
    if (segments.length === 0) return null
    const basename = segments[segments.length - 1] as string
    const deny = (id: string): HardlineDenial => ({
      target: TARGET_BY_ID.get(id) as HardlineTarget,
      matched: rawPath,
      surface: 'file',
    })

    // A protected subtree, whole. Checked first: it has no per-name shape and
    // must hold even for a file that would otherwise read as clear.
    if (this.#protectedRoots.some(root => withinRoot(rawPath, root))) {
      return deny('memory-root')
    }

    // Any state file, wherever it lives.
    if (NODE_STATE_FILES.includes(basename)) {
      return deny(basename === 'trail.ndjson' ? 'audit-trail' : 'node-state')
    }

    // Identity and audit material named lexically, wherever it lives. This is
    // the one rule that does not depend on `stateRoots`: on a host that runs
    // several nodes (and the console) side by side, a peer's key sits under
    // `…/qianmo/identity/` in a directory this node's root never covers, and it
    // must still be refused (hermes TH-6②). Placed ahead of the root-scoped
    // rules below so it fires for those paths too.
    const identityKeyAt = sequenceIndex(segments, 'qianmo', 'identity')
    if (identityKeyAt >= 0) return deny('node-identity')
    const auditAt = sequenceIndex(segments, 'qianmo', 'audit')
    if (auditAt >= 0) return deny('audit-trail')

    const identityAt = segments.findIndex(segment =>
      IDENTITY_DIRS.includes(segment),
    )
    const insideRoot = this.#stateRoots.some(root => withinRoot(rawPath, root))

    // A settings file inside any identity directory — global or per-project.
    // Per-project counts: a `.claude/settings.json` in the repository the agent
    // is working in can carry allow rules and PreToolUse hooks for this very
    // session, so it is policy in exactly the same sense as the global one.
    if (SETTINGS_FILES.includes(basename) && (identityAt >= 0 || insideRoot)) {
      return deny('settings')
    }
    if (
      CREDENTIAL_FILES.includes(basename) &&
      (identityAt >= 0 || insideRoot)
    ) {
      return deny('credentials')
    }

    // Customization directories under a config root or identity directory —
    // same scoping test as settings, and the same reason: a definition loaded
    // from one of these changes what the session may do.
    const customizationAt = segments.findIndex(segment =>
      CONFIG_CUSTOMIZATION_DIRS.includes(segment),
    )
    if (
      customizationAt >= 0 &&
      (insideRoot || (identityAt >= 0 && identityAt < customizationAt))
    ) {
      return deny('config-customization')
    }

    // Node-owned state directories, either under a known root or spelled out
    // under an identity directory.
    const stateAt = segments.findIndex(segment =>
      NODE_STATE_DIRS.includes(segment),
    )
    if (
      stateAt >= 0 &&
      (insideRoot || (identityAt >= 0 && identityAt < stateAt))
    ) {
      const identityScoped = segments[stateAt] === 'qianmo'
      if (identityScoped) {
        const next = segments[stateAt + 1]
        if (next === 'audit') return deny('audit-trail')
        if (next === 'identity') return deny('node-identity')
      }
      return deny('node-state')
    }

    // The config root itself, anything else inside it, or an identity
    // directory as a whole: deleting one destroys everything above without
    // ever naming one of them, and the rest of a root (the agent's sessions,
    // its caches) is still the node's own state, not workspace.
    if (
      insideRoot ||
      this.#stateRoots.some(root => withinRoot(root, rawPath)) ||
      (segments.length > 0 && IDENTITY_DIRS.includes(basename))
    ) {
      return deny('config-root')
    }

    return null
  }

  /**
   * The hardline verdict for a shell command.
   *
   * Every path-shaped token is checked, including redirection targets and the
   * right-hand side of assignments — `> ~/.omp/agent/config.yml` names the file
   * just as plainly as `vi` does.
   */
  commandVerdict(command: string): HardlineDenial | null {
    if (typeof command !== 'string' || command.length === 0) return null
    for (const token of shellTokens(command)) {
      const verdict = this.pathVerdict(token)
      if (verdict !== null)
        return { ...verdict, matched: token, surface: 'shell' }
    }
    return null
  }

  /**
   * The verdict for one tool call.
   *
   * Walks the whole input rather than a per-tool list of field names. A list
   * would have to be updated every time a tool grows a second path argument,
   * and the failure mode of forgetting is silent.
   */
  verdict(toolName: string, input: unknown): HardlineDenial | null {
    for (const [key, value] of stringFields(input)) {
      const looksLikeCommand =
        key === 'command' || key === 'script' || /\s/.test(value)
      const verdict = looksLikeCommand
        ? (this.commandVerdict(value) ?? this.pathVerdict(value))
        : this.pathVerdict(value)
      if (verdict !== null) return verdict
    }
    return null
  }
}

/** Split a command into the tokens that could be paths. */
function shellTokens(command: string): readonly string[] {
  const tokens: string[] = []
  // Quotes and commas split too, not just whitespace and operators: a path
  // spelled inside a language literal — `python3 -c "open('trail.ndjson')"` —
  // is still the same path, and a tokenizer that only knew shell syntax would
  // hand it straight through.
  for (const raw of command.split(/[\s;|&()<>,'"`]+/)) {
    const unquoted = raw
    if (unquoted.length === 0) continue
    tokens.push(unquoted)
    // `VAR=path`, `--flag=path`, `--file path` all put the path after a `=`.
    const equals = unquoted.indexOf('=')
    if (equals >= 0 && equals + 1 < unquoted.length) {
      tokens.push(unquoted.slice(equals + 1))
    }
  }
  return tokens
}

const MAX_INPUT_DEPTH = 6

/** Every string in `input`, with the key it sat under. */
function* stringFields(
  input: unknown,
  depth = 0,
): Generator<readonly [string, string]> {
  if (depth > MAX_INPUT_DEPTH || input === null || input === undefined) return
  if (typeof input === 'string') {
    yield ['', input]
    return
  }
  if (Array.isArray(input)) {
    for (const item of input) yield* stringFields(item, depth + 1)
    return
  }
  if (typeof input !== 'object') return
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') yield [key, value]
    else yield* stringFields(value, depth + 1)
  }
}

/**
 * The block tags the assembled prompt is framed with.
 *
 * Named here rather than imported from the base so this package stays a leaf.
 * The scan below asserts the count it expects, so a base that renamed its tag
 * would make these rules find zero blocks where one was promised — which fails
 * loudly instead of passing vacuously.
 */
const TEAMMATE_TAG = 'teammate-message'
const MEMORY_TAG = 'qianmo-memory'

/** Attributes the base's own renderer emits. Anything else was injected. */
const TEAMMATE_ATTRIBUTES: readonly string[] = Object.freeze([
  'teammate_id',
  'color',
  'summary',
])

export interface PromptScanExpectation {
  /** How many mailbox messages went into this prompt. */
  readonly messages: number
  /** 1 when a memory sidecar was appended, 0 when there was nothing to add. */
  readonly memoryBlocks: number
}

export interface PromptInjectionFinding {
  readonly rule: string
  readonly detail: string
}

function countOccurrences(haystack: string, needle: RegExp): number {
  return haystack.match(needle)?.length ?? 0
}

/**
 * Scan the **assembled** prompt for injected structure (hermes E5).
 *
 * The object is the product, not the inputs, and that distinction is the whole
 * value of this function. Per-field validation answers "is this string clean?",
 * which is the wrong question: a `from` of `x" summary="…` contains no tag at
 * all and is perfectly clean on its own, yet the moment the renderer
 * interpolates it into `teammate_id="${from}"` the block has grown an attribute
 * nobody put there. The injection is created *by the assembly*, so only the
 * assembly can be checked for it.
 *
 * Structural counts, not judgement. Nothing here asks whether the text is
 * persuasive, in keeping with T-7's acceptance bar being written down as
 * explicitly not that.
 */
export function scanAssembledPrompt(
  prompt: string,
  expected: PromptScanExpectation,
): readonly PromptInjectionFinding[] {
  const findings: PromptInjectionFinding[] = []

  const opens = countOccurrences(
    prompt,
    new RegExp(`<${TEAMMATE_TAG}[\\s>]`, 'g'),
  )
  const closes = countOccurrences(prompt, new RegExp(`</${TEAMMATE_TAG}>`, 'g'))
  if (opens !== expected.messages || closes !== expected.messages) {
    findings.push({
      rule: 'teammate-block-count',
      detail:
        `expected ${expected.messages} teammate blocks, found ${opens} open ` +
        `and ${closes} close tags`,
    })
  }

  const memoryOpens = countOccurrences(
    prompt,
    new RegExp(`<${MEMORY_TAG}[\\s>]`, 'g'),
  )
  const memoryCloses = countOccurrences(
    prompt,
    new RegExp(`</${MEMORY_TAG}>`, 'g'),
  )
  if (
    memoryOpens !== expected.memoryBlocks ||
    memoryCloses !== expected.memoryBlocks
  ) {
    findings.push({
      rule: 'memory-block-count',
      detail:
        `expected ${expected.memoryBlocks} memory blocks, found ${memoryOpens} ` +
        `open and ${memoryCloses} close tags`,
    })
  }

  for (const match of prompt.matchAll(
    new RegExp(`<${TEAMMATE_TAG}([^>]*)>`, 'g'),
  )) {
    findings.push(...scanAttributes(match[1] ?? ''))
  }

  return findings
}

/**
 * Read a tag's attribute region as attributes, not as text.
 *
 * A regexp that simply looked for `name=` anywhere would report a false
 * positive the moment an attribute *value* legitimately contains `foo=` — which
 * is exactly what a correctly neutralized hostile value looks like, since
 * escaping turns `x" priority="urgent` into one quoted value that still has the
 * characters `priority=` inside it. Reporting that as an injection would train
 * the reader to ignore this rule, so the parse honours quoting.
 */
function scanAttributes(attributes: string): readonly PromptInjectionFinding[] {
  const findings: PromptInjectionFinding[] = []
  const pair = /\s*([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/y
  let index = 0
  while (index < attributes.length) {
    pair.lastIndex = index
    const match = pair.exec(attributes)
    if (match === null) break
    const name = match[1] as string
    if (!TEAMMATE_ATTRIBUTES.includes(name)) {
      findings.push({
        rule: 'teammate-attribute',
        detail: `unexpected attribute ${name} on a teammate block`,
      })
    }
    index = pair.lastIndex
  }
  const trailing = attributes.slice(index).trim()
  if (trailing.length > 0) {
    findings.push({
      rule: 'teammate-attribute',
      detail: `unparsable attribute text on a teammate block: ${trailing}`,
    })
  }
  return findings
}
