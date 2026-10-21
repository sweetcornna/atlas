// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DeepSeek Harness (`dsh --profile acp`) as an ACP runtime
 * (`harness-backends.md` §1.3, §5; facts in the P36 dsh probe of
 * 2026-10-17 on `@deepseek-ai/dsh@0.2.1-rc.2`).
 *
 * One process per agent session, configured entirely by one `--patch` file
 * the node writes per process and by environment:
 *
 * - the model route: a hand-declared pi-ai provider (`openai-completions`
 *   for the `openai-chat` lane, `anthropic-messages` for `anthropic`) whose
 *   key is read from `QM_DSH_GATEWAY_KEY` — a name with `KEY` in it, so
 *   dsh drops it from every shell the model runs. `DEEPSEEK_API_KEY` and
 *   `DEEPSEEK_BASE_URL` are never set: the native DeepSeek route stays
 *   keyless and unused;
 * - isolation: no `AGENTS.md`/`CLAUDE.md` from the workspace or any home,
 *   skills only from the agent's own dsh home (the operator's in `qmo/`,
 *   the harness's own beside them), no session-log or plugin-inventory
 *   upload, no telemetry, no web tools, no dsh subagents, workflows or goals,
 *   the experimental hook plugins off, plain-JSONL session logs (the real
 *   provider usage is only there);
 * - an approval gate plugin, first in line, that sends every tool call but
 *   a few session-only ones, and every read outside the workspace, through
 *   `session/request_permission` for the node to decide, and a guard that
 *   refuses such a call any native bundle let past it (P36.7);
 * - the node's tool bridge as a global MCP client row with the bridge's
 *   call timeout (servers from `session/new` get dsh's 60 s default).
 *
 * The node's patch is the last layer, so it wins on the rows it names; the
 * harness's own layers in the agent's home (its acp profile, the bundles the
 * operator added there natively, its MCP rows and skills) load untouched
 * underneath.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AcpLaunch,
  AcpLaunchInput,
  AcpOpenLaunch,
  AcpToolCall,
  AcpUsage,
  AcpUsageReader,
  AcpVerdictCall,
} from './acpSpec.js'

/** The variable the gateway key reaches dsh in. */
export const DSH_KEY_ENV = 'QM_DSH_GATEWAY_KEY'
/** The node's patch layer, one per process. */
export const DSH_PATCH_FILE = 'qianmo-dsh.patch.yml'
/** The approval gate, beside the patch (relative plugin names resolve there). */
export const DSH_GATE_FILE = 'qm-approval-gate.mjs'
/** Holds the ACP server back until the bridge's tools are registered. */
export const DSH_BRIDGE_READY_FILE = 'qm-bridge-ready.mjs'
/** The service it provides, which the `acp` row is made to wait for. */
const BRIDGE_READY_SERVICE = 'qmBridgeReady'
/** What the `acp` row waits for in 0.2.1-rc.2 (a patch replaces the list). */
const ACP_STARTUP_SERVICE = 'acpAppStartup'
/** How long the bridge may take to list its tools. */
const BRIDGE_READY_WAIT_MS = 30_000
/** The provider id the route is declared under. */
const PROVIDER = 'qm'
/** The operator's skills (P32), a subtree of dsh's own skills root. */
export const DSH_QMO_SKILLS = 'qmo'

/** A `!!js` expression dsh's config loader evaluates (its own helpers only). */
class JsExpr {
  readonly expr: string
  constructor(expr: string) {
    this.expr = expr
  }
}

/**
 * A YAML double-quoted scalar: JSON's escapes, which YAML shares, and every
 * character outside printable ASCII escaped too, so no value can end the
 * scalar, start a comment or a tag, or be read differently.
 */
function scalar(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** One value in YAML flow style (a JSON superset), every string quoted. */
export function yamlFlow(value: unknown): string {
  if (value instanceof JsExpr) return `!!js ${scalar(value.expr)}`
  if (typeof value === 'string') return scalar(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('not a finite number')
    return String(value)
  }
  if (typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(yamlFlow).join(', ')}]`
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${scalar(key)}: ${yamlFlow(entry)}`)
      .join(', ')}}`
  throw new Error(`cannot write ${typeof value} into a dsh patch`)
}

/** A path under the agent's dsh home, as dsh itself resolves it. */
function homePath(...segments: string[]): JsExpr {
  return new JsExpr(
    `dshHomePath(${segments.map(segment => `'${segment}'`).join(', ')})`,
  )
}

const DISABLED_ROWS = [
  // Feedback-gated OTel upload (same as DSH_TELEMETRY_DISABLED=1).
  'session-telemetry-otel',
  // web_search / web_fetch: a resident turn has no network tools.
  'tool-web',
  // Work the model would arrange for itself, out of the node's sight: dsh
  // subagents, workflows and autonomous goal rounds (Codex: `multi_agent`,
  // `goals`; Claude Code: Task, Workflow).
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-workflow',
  'tool-goal',
  // The experimental hook and auto-review plugins, should a native plugin
  // install mount them (absent rows are skipped with a warning).
  'hooks-claude-code',
  'hooks-codex',
  'auto-review',
]

/** The field's effort as one of dsh's thinking levels. */
export function dshThinkingLevel(
  effort: string | undefined,
): string | undefined {
  if (effort === undefined || effort === '') return undefined
  return effort === 'none' ? 'off' : effort
}

/** The patch layer for one dsh process. */
export function dshPatch(input: AcpLaunchInput): string {
  const anthropic = input.lane === 'anthropic'
  if (!anthropic && input.lane !== 'openai-chat')
    throw new Error(`DeepSeek Harness cannot call the ${input.lane} lane`)
  // dsh's thinking levels are pi-ai's (`off` … `max`); the field's `none`
  // is its `off`, sent to the model as `none` (§11.2).
  const level = dshThinkingLevel(input.effort)
  const efforts =
    level === undefined
      ? undefined
      : Object.fromEntries(
          [...new Set(['low', 'medium', 'high', level])].map(one => [
            one,
            one === 'off' ? 'none' : one,
          ]),
        )
  const headers =
    input.headers && Object.keys(input.headers).length > 0
      ? input.headers
      : undefined
  const route = { provider: PROVIDER, model: input.model }
  const rows: unknown[] = [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          [PROVIDER]: {
            displayName: 'Qianmo gateway',
            api: anthropic ? 'anthropic-messages' : 'openai-completions',
            baseURL: input.baseUrl,
            apiKeyEnv: DSH_KEY_ENV,
            headers,
            reasoning: level,
            models: [
              {
                id: input.model,
                contextWindow: input.contextWindow,
                maxTokens: input.maxOutputTokens,
                reasoningEfforts: efforts,
              },
            ],
          },
        },
      },
    },
    // ACP waits for the bridge: a row's startup is not awaited before the
    // server answers, and the first turn must already see the host's tools.
    input.bridge === undefined
      ? { id: 'acp', config: route }
      : {
          id: 'acp',
          config: route,
          inject: [ACP_STARTUP_SERVICE, BRIDGE_READY_SERVICE],
        },
    // The effort sessions start with (`harness-backends.md` §11.2).
    {
      id: 'agent-default-model',
      config:
        level === undefined ? route : { ...route, reasoningEffort: level },
    },
    // No AGENTS.md / CLAUDE.md from the workspace, its parents or any home.
    { id: 'agent-instructions', config: { maxBytes: 0 } },
    // Skills from this agent's dsh home only: the operator's (`qmo/`), the
    // harness's own, and its agents home; never the workspace's `.dsh` or
    // `.agents`, nor the user's `~/.dsh` or `~/.agents`.
    {
      id: 'skill-filesystem',
      config: {
        includeDefaultRoots: false,
        customSkillDirs: [
          homePath('skills', DSH_QMO_SKILLS),
          homePath('skills'),
          homePath('agents', 'skills'),
        ],
        watch: false,
      },
    },
    // Only the native DeepSeek route would attach these; it is not used, and
    // they stay off should it ever be.
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'plugin-package-inventory-deepseek', config: { enabled: false } },
    ...DISABLED_ROWS.map(id => ({ id, disabled: true })),
    // Plain JSONL logs: the turn's usage is read back from them. A patch
    // replaces a row's whole config, so the root is restated.
    {
      id: 'session-persistence-jsonl',
      config: { root: homePath('sessions'), compression: 'none' },
    },
    {
      insert: [
        // The node's bridge, here rather than in `session/new`: dsh gives
        // servers from there its 60 s call default, and host tools can wait
        // for a person. Startup fails if it does.
        ...(input.bridge === undefined
          ? []
          : [
              {
                id: 'qm-bridge',
                name: '@deepseek-ai/dsh-mcp-client',
                config: {
                  transport: 'stdio',
                  serverName: input.bridge.name,
                  command: input.bridge.command,
                  args: [...input.bridge.args],
                  cwd: input.cwd,
                  toolCallTimeoutMs: input.bridge.timeoutMs,
                  failOnStartupError: true,
                },
              },
              {
                id: 'qm-bridge-ready',
                name: `./${DSH_BRIDGE_READY_FILE}`,
                config: {
                  prefix: `mcp__${input.bridge.name}__`,
                  waitMs: BRIDGE_READY_WAIT_MS,
                },
              },
            ]),
        { id: 'qm-approval-gate', name: `./${DSH_GATE_FILE}` },
      ],
    },
  ]
  return [
    '# Written by the qianmo node for one DeepSeek Harness process (P36). Do not edit.',
    ...rows.map(row => `- ${yamlFlow(row)}`),
    '',
  ].join('\n')
}

/**
 * The approval gate, second version (P36.7, research D1–D4). Its
 * `tools/pre-execute` listener is registered first and lets the rest of the
 * chain decide, so dsh's own listeners keep working and a denial stays a
 * denial; anything else on a gated call — every tool but a few
 * session-only ones and reads inside the workspace, tools it does not know
 * included — becomes an approval request (`session/request_permission`).
 * A native bundle registered in front of it could still answer "allow"
 * without passing the call on; `tools.guard()`, which nothing can loosen,
 * then refuses every gated call this gate did not see asked. An approval
 * does not widen dsh's sandbox. It writes nothing to stdout (the ACP
 * stream).
 */
export const DSH_GATE_PLUGIN = `// Written by the qianmo node (P36.7). Do not edit.
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'qm-approval-gate'
export const inject = ['tools']

// Tools that act on the session only (and the node's own tools, which the
// node authorizes when they are called).
const FREE = new Set(['todo_write', 'skill', 'job_list', 'job_output', 'job_kill',
  'list_mcp_resources', 'list_mcp_resource_templates', 'exit_plan_mode'])
// Reads and directory changes are free inside the workspace only.
const SCOPED = { read: 'file_path', read_image: 'file_path', glob: 'path', grep: 'path', working_directory: 'cd' }

function real(path) {
  let head = path
  let tail = ''
  for (;;) {
    try { return tail === '' ? realpathSync(head) : join(realpathSync(head), tail) } catch {}
    const parent = dirname(head)
    if (parent === head) return path
    tail = tail === '' ? basename(head) : join(basename(head), tail)
    head = parent
  }
}

function inside(cwd, value) {
  if (value === undefined || value === null || value === '') return true
  if (typeof value !== 'string') return false
  const root = real(resolve(cwd))
  const rel = relative(root, real(resolve(cwd, value)))
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel))
}

function gated(exec) {
  const tool = String(exec.name)
  if (FREE.has(tool) || tool.startsWith('mcp__qianmo__')) return false
  const field = SCOPED[tool]
  if (field === undefined) return true
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string') return true
  const args = exec.arguments ?? {}
  if (tool === 'glob' && (typeof args.pattern !== 'string' || isAbsolute(args.pattern) || args.pattern.split(/[\\\\/]/).includes('..'))) return true
  if (tool === 'working_directory' && args.cd === undefined) return false
  return !inside(cwd, args[field])
}

export function apply(ctx) {
  const asked = new Set()
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (!gated(exec) || decision?.kind === 'deny') return decision
    asked.add(exec.callId)
    return decision?.kind === 'ask' ? decision : { kind: 'ask', reason: 'qianmo node: ' + String(exec.name) }
  }, { prepend: true })
  ctx.tools.guard(exec => gated(exec) && !asked.has(exec.callId)
    ? 'qianmo node: "' + String(exec.name) + '" was not routed to the node for approval'
    : undefined)
}
`

/**
 * Provides the service the `acp` row waits for once a tool of the bridge is
 * registered. Without one in time dsh stops (stderr, exit 70) rather than
 * serving turns without the host's tools.
 */
export const DSH_BRIDGE_READY_PLUGIN = `// Written by the qianmo node (P36). Do not edit.
export const name = 'qm-bridge-ready'
export const inject = ['tools']

export async function apply(ctx, config) {
  const deadline = Date.now() + config.waitMs
  const ready = () => [...ctx.tools.view().visible.keys()].some(tool => tool.startsWith(config.prefix))
  while (!ready()) {
    if (Date.now() > deadline) {
      process.stderr.write('qianmo: the node bridge listed no tools in ' + config.waitMs + ' ms\\n')
      process.exit(70)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  ctx.provide('${BRIDGE_READY_SERVICE}', { ready: true })
}
`

/** dsh's part of an agent's environment (`runtimeEnv`). */
export function dshEnv(
  home: string,
  route?: { readonly apiKey: string },
): Record<string, string> {
  return {
    DSH_HOME: home,
    // Shared agent skills and AGENTS.md: the agent's own, not ~/.agents.
    DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    ...(route === undefined ? {} : { [DSH_KEY_ENV]: route.apiKey }),
  }
}

/** The patch, the gate (and the bridge's readiness) beside it. */
function dshFiles(input: AcpLaunchInput): { path: string; content: string }[] {
  return [
    { path: join(input.runDir, DSH_PATCH_FILE), content: dshPatch(input) },
    { path: join(input.runDir, DSH_GATE_FILE), content: DSH_GATE_PLUGIN },
    ...(input.bridge === undefined
      ? []
      : [
          {
            path: join(input.runDir, DSH_BRIDGE_READY_FILE),
            content: DSH_BRIDGE_READY_PLUGIN,
          },
        ]),
  ]
}

/** How one agent's dsh process starts. */
export function dshLaunch(input: AcpLaunchInput): AcpLaunch {
  const patch = join(input.runDir, DSH_PATCH_FILE)
  const launchDir = join(input.home, 'launch')
  return {
    argv: [input.bin, '--profile', 'acp', '--patch', patch],
    env: dshEnv(input.home, input),
    files: dshFiles(input),
    // dsh loads a `.env` from its launch directory into its own environment
    // (and so into the model's shells): an empty directory of its own, never
    // the workspace, which is only `session/new {cwd}`.
    cwd: launchDir,
    dirs: [
      join(input.home, 'agents'),
      join(input.home, 'skills', DSH_QMO_SKILLS),
    ],
    mountsBridge: true,
  }
}

/** The web app's package, beside dsh's own in the install that has `bin`. */
export function dshWebApp(bin: string): string | undefined {
  let real = bin
  try {
    real = realpathSync(bin)
  } catch {
    // As given.
  }
  for (const start of [bin, real])
    for (let dir = dirname(start); dirname(dir) !== dir; dir = dirname(dir)) {
      const candidate = join(
        dir,
        dir.endsWith('node_modules') ? '' : 'node_modules',
        '@deepseek-ai',
        'dsh-web-app',
      )
      if (existsSync(join(candidate, 'cordis.patch.yml'))) return candidate
    }
  return undefined
}

/** The web app's patches, in the order `dsh web` layers them. */
const WEB_PATCHES = [
  'cordis.patch.yml',
  'presets/standard.patch.yml',
  'presets/ptc.patch.yml',
  'presets/minimal.patch.yml',
  'presets/cordis.patch.yml',
]

/**
 * The official frontend, dsh's web UI, served from the agent's **acp**
 * profile (the native bundles a resident process loads; a `web` profile
 * would be another set): the web app's patches, the node's patch and gate,
 * and the ACP server switched off. dsh binds loopback and prints its
 * address with a random token; the node never opens a browser.
 */
export function dshOpen(input: AcpLaunchInput): AcpOpenLaunch {
  const app = dshWebApp(input.bin)
  if (app === undefined)
    throw new Error('this DeepSeek Harness install has no web app')
  const off = join(input.runDir, 'qm-open-web.patch.yml')
  return {
    argv: [
      input.bin,
      '--profile',
      'acp',
      ...WEB_PATCHES.flatMap(patch => ['--patch', join(app, patch)]),
      '--patch',
      join(input.runDir, DSH_PATCH_FILE),
      '--patch',
      off,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    env: dshEnv(input.home, input),
    files: [
      ...dshFiles(input),
      {
        path: off,
        content: [
          '# Written by the qianmo node for `qm runtime open` (P36.7). Do not edit.',
          `- ${yamlFlow({ id: 'acp', disabled: true })}`,
          `- ${yamlFlow({ id: 'acp-app-startup', disabled: true })}`,
          '',
        ].join('\n'),
      },
    ],
    cwd: join(input.home, 'launch'),
    dirs: [
      join(input.home, 'agents'),
      join(input.home, 'skills', DSH_QMO_SKILLS),
    ],
  }
}

/** dsh's session-id path segment (`session-persistence-jsonl` `encodeSegment`). */
export function dshEncodeSegment(raw: string): string {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    out +=
      char !== '~' && /^[A-Za-z0-9._-]$/.test(char)
        ? char
        : `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** dsh's directory for a workspace's sessions (`projectKey`). */
export function dshProjectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const char = cwd[i]!
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else {
      readable +=
        char !== '~' && /^[A-Za-z0-9._-]$/.test(char)
          ? char
          : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

const LOG_FILE = 'session.v4.jsonl'
const USAGE_WAIT_MS = 3_000
const USAGE_POLL_MS = 50

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 0
}

/**
 * The provider's usage of one dsh session, from its log: each
 * `assistant/message` carries `data.usage` (`inputTokens` uncached,
 * `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`). dsh writes its
 * log in batches up to 200 ms after the events and answers the prompt
 * before that, so a read waits for the turn's `turn/end`.
 */
export function dshUsageReader(session: {
  readonly home: string
  readonly cwd: string
  readonly sessionId: string
}): AcpUsageReader {
  const sessions = join(session.home, 'sessions')
  const id = dshEncodeSegment(session.sessionId)
  const direct = join(sessions, dshProjectKey(session.cwd), id, LOG_FILE)
  const file = (): string | undefined => {
    if (existsSync(direct)) return direct
    let projects: string[]
    try {
      projects = readdirSync(sessions)
    } catch {
      return undefined
    }
    for (const project of projects) {
      const candidate = join(sessions, project, id, LOG_FILE)
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }
  const records = (
    from: number,
  ): { lines: Record<string, unknown>[]; restarted: boolean } => {
    const path = file()
    if (path === undefined) return { lines: [], restarted: false }
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      // A log cut back (torn-tail repair) is read whole; only the last
      // turn counts then.
      const restarted = size < from
      const start = restarted ? 0 : from
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      const end = buffer.lastIndexOf(0x0a)
      const lines: Record<string, unknown>[] = []
      for (const line of buffer.toString('utf8', 0, end + 1).split('\n')) {
        if (line.trim() === '') continue
        try {
          const value: unknown = JSON.parse(line)
          if (value && typeof value === 'object' && !Array.isArray(value))
            lines.push(value as Record<string, unknown>)
        } catch {
          // A torn line; the next read sees it whole.
        }
      }
      return { lines, restarted }
    } finally {
      closeSync(fd)
    }
  }
  const sum = (lines: readonly Record<string, unknown>[]) => {
    let total: AcpUsage | undefined
    for (const line of lines) {
      if (line.type !== 'assistant/message') continue
      const data = line.data
      const usage =
        data && typeof data === 'object'
          ? (data as Record<string, unknown>).usage
          : undefined
      if (!usage || typeof usage !== 'object') continue
      const one = usage as Record<string, unknown>
      total = {
        input: (total?.input ?? 0) + count(one.inputTokens),
        output: (total?.output ?? 0) + count(one.outputTokens),
        cacheRead: (total?.cacheRead ?? 0) + count(one.cacheReadTokens),
        cacheWrite: (total?.cacheWrite ?? 0) + count(one.cacheWriteTokens),
      }
    }
    return total
  }
  return {
    start() {
      const path = file()
      if (path === undefined) return 0
      try {
        return statSync(path).size
      } catch {
        return 0
      }
    },
    async read(from) {
      const deadline = Date.now() + USAGE_WAIT_MS
      for (;;) {
        let { lines, restarted } = records(from)
        if (restarted) {
          const last = lines.findLastIndex(line => line.type === 'turn/start')
          lines = last < 0 ? lines : lines.slice(last)
        }
        if (
          lines.some(line => line.type === 'turn/end') ||
          Date.now() >= deadline
        )
          return sum(lines)
        await Bun.sleep(USAGE_POLL_MS)
      }
    },
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * A dsh tool call in the node's vocabulary. dsh names the tool in the ACP
 * `title` (`kind` is always `other`); its arguments are in `rawInput`.
 */
export function dshToolCall(call: AcpToolCall): AcpVerdictCall[] {
  const raw = call.rawInput
  switch (call.title) {
    case 'bash':
    case 'pwsh':
      // An escalation past dsh's sandbox (`sandbox_permissions`) carries its
      // justification; the operator sees both.
      return [{ toolName: 'bash', input: { ...raw } }]
    case 'write':
    case 'edit':
      return [
        { toolName: call.title, input: { ...raw, path: text(raw.file_path) } },
      ]
    case 'read':
    case 'read_image':
      return [{ toolName: 'read', input: { path: text(raw.file_path) } }]
    case 'grep':
      return [
        {
          toolName: 'grep',
          input: { path: text(raw.path) ?? '.', pattern: raw.pattern },
        },
      ]
    case 'glob': {
      const base = text(raw.path) ?? '.'
      const pattern = text(raw.pattern) ?? ''
      // A pattern that leaves its directory is where the search goes.
      const escapes =
        pattern.startsWith('/') || pattern.split(/[\\/]/).includes('..')
      return [
        {
          toolName: 'glob',
          input: { path: escapes ? join(base, pattern) : base, pattern },
        },
      ]
    }
    case 'working_directory':
      // Entering a directory is reading it.
      return [{ toolName: 'read', input: { path: text(raw.cd) ?? '.' } }]
    case 'read_mcp_resource':
      return [
        {
          toolName: `mcp__${text(raw.server) ?? ''}__read_mcp_resource`,
          input: { uri: raw.uri },
        },
      ]
    case 'todo_write':
      return [{ toolName: 'todo', input: { ...raw } }]
    default:
      return [{ toolName: call.title, input: { ...raw } }]
  }
}
