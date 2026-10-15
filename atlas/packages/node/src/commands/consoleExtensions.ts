// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MCP connectors, skills and plugins on the hub (P32, `runtimes-channels.md`
 * §9).
 *
 * The operator configures entries on the console's 扩展 page; this book keeps
 * them, seals MCP environment variables and request headers with the
 * connector vault, and pins every GitHub source to a commit and the digest of
 * its directory. Each node gets the entries for its own agents on the control
 * link (`extensions.apply`, see `host/extensions.ts`) after every change and
 * whenever a periodic check finds the node on another set.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import {
  EXTENSION_KINDS,
  type ConsoleResult,
  type DirectionActor,
  type ExtensionDraft,
  type ExtensionKind,
  type ExtensionNodeState,
  type ExtensionsPort,
  type ExtensionsSnapshot,
  type ExtensionView,
} from '@qianmo/console'
import { parseAddress, type ControlOutcome } from '@qianmo/protocol'
import { ConnectorVault, type ConnectorSecret } from '../connectors/secrets.js'
import {
  EXTENSION_NAME,
  extensionsDigest,
  type ExtensionsStatus,
  type ExtensionWireEntry,
  pluginFormats,
  RESERVED_NAMES,
} from '../host/extensions.js'
import {
  checkRef,
  fetchGithubDir,
  GithubDirError,
  resolveCommit,
} from '../host/githubDir.js'
import type { RunCommand } from '../host/runtimeUpdate.js'
import {
  acquirePrivateInstanceLock,
  ensurePrivateDir,
  type PrivateInstanceLock,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'
import type { OutboundPolicy } from './outboundPolicy.js'

const MAX_ENTRIES = 200
/** One node's set travels in one control message (256 KiB envelope). */
const MAX_WIRE_BYTES = 192 * 1024
const MAX_BODY = 32 * 1024
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const RESERVED_ENV: ReadonlySet<string> = new Set([
  'PLUGIN_ROOT',
  'PLUGIN_DATA',
])
const RECONCILE_MS = 10 * 60_000

const secretSchema = z.object({
  revision: z.number().int().positive(),
  slot: z.enum(['password', 'ics-url']),
  at: z.number(),
  wrapped: z.string(),
  body: z.string(),
})

const storedSchema = z.object({
  id: z.string().regex(/^ext-[0-9a-f-]{36}$/),
  kind: z.enum(EXTENSION_KINDS),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  agents: z.array(z.string()),
  transport: z.enum(['stdio', 'http', 'sse']).nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  envKeys: z.array(z.string()),
  headerKeys: z.array(z.string()),
  approval: z.enum(['allow', 'ask']),
  body: z.string().nullable(),
  source: z
    .object({
      repo: z.string(),
      ref: z.string(),
      path: z.string(),
      commit: z.string(),
      digest: z.string(),
    })
    .nullable(),
  secret: secretSchema.nullable(),
  updatedAt: z.number(),
  updatedBy: z.string(),
})
type Stored = z.infer<typeof storedSchema>

const nodeSchema = z.object({
  digest: z.string().nullable(),
  results: z.record(
    z.string(),
    z.object({ ok: z.boolean(), detail: z.string().nullable() }),
  ),
  at: z.number().nullable(),
  error: z.string().nullable(),
})
type NodeRecord = z.infer<typeof nodeSchema>

const bookSchema = z.object({
  v: z.literal(1),
  extensions: z.array(storedSchema),
  nodes: z.record(z.string(), nodeSchema).default({}),
})

export interface ExtensionsControl {
  request(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<ControlOutcome>
}

export interface ConsoleExtensionsOptions {
  readonly directory: string
  readonly policy: OutboundPolicy
  /** The nodes on the control link. */
  readonly nodes: () => readonly string[]
  /** Every agent address the console knows. */
  readonly agents: () => Promise<readonly string[]>
  readonly control?: ExtensionsControl
  /** The token of the repo connection for `repo`, if there is one. */
  readonly repoToken?: (repo: string) => Promise<string | null>
  readonly run?: RunCommand
  readonly now?: () => number
  readonly reconcileMs?: number
  readonly onError?: (message: string) => void
}

class Invalid extends Error {}

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}
function fail<T>(
  code: 'invalid' | 'not_found' | 'unreachable' | 'refused',
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  )
}

/** HTTPS, or plain HTTP to this machine; no credentials or fragment. */
function remoteUrl(raw: unknown): string {
  let url: URL
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Invalid('地址无效')
  }
  if (
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopback(url.hostname))
    )
  )
    throw new Invalid('远程服务要用 HTTPS')
  if (url.username || url.password || url.hash)
    throw new Invalid('地址里不能带用户名 · 密码或片段')
  return url.toString()
}

/** `NAME → value | null`; `null` keeps the stored value. */
function secretMap(
  raw: unknown,
  pattern: RegExp,
  field: string,
): Map<string, string | null> {
  const out = new Map<string, string | null>()
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new Invalid(`${field}格式无效`)
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > 64) throw new Invalid(`${field}最多 64 项`)
  for (const [key, value] of entries) {
    if (!pattern.test(key) || (field === '环境变量' && RESERVED_ENV.has(key)))
      throw new Invalid(`${field}名称 ${key} 无效`)
    if (value !== null && (typeof value !== 'string' || value.length > 8192))
      throw new Invalid(`${field} ${key} 的值无效`)
    if (typeof value === 'string' && /[\0\r\n]/.test(value))
      throw new Invalid(`${field} ${key} 的值里有换行`)
    out.set(key, value as string | null)
  }
  return out
}

/** The `name:` and `description:` of a `SKILL.md` front matter. */
export function skillFrontMatter(text: string): {
  readonly name?: string
  readonly description?: string
} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (block === undefined) return {}
  const fields: Record<string, string> = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!)
    if (match === null) continue
    let value = match[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const folded: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!))
        folded.push(lines[++i]!.trim())
      value = folded.join(' ')
    } else if (value.startsWith('"')) {
      try {
        value = String(JSON.parse(value))
      } catch {
        value = value.slice(1, -1)
      }
    } else if (value.startsWith("'") && value.endsWith("'"))
      value = value.slice(1, -1).replace(/''/g, "'")
    fields[match[1]!] = value
  }
  return {
    ...(fields.name === undefined ? {} : { name: fields.name }),
    ...(fields.description === undefined
      ? {}
      : { description: fields.description }),
  }
}

function readJsonText(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function nodeOf(address: string): string | null {
  return parseAddress(address)?.node ?? null
}

export class ConsoleExtensions implements ExtensionsPort {
  readonly #options: ConsoleExtensionsOptions
  readonly #now: () => number
  readonly #bookPath: string
  readonly #lock: PrivateInstanceLock | null
  readonly #vault: ConnectorVault
  readonly #entries = new Map<string, Stored>()
  #nodes: Record<string, NodeRecord>
  /** The digest each node should be on, from the last push. */
  readonly #expected = new Map<string, string>()
  #queue: Promise<unknown> = Promise.resolve()
  #pushing: Promise<void> | null = null
  #again = false
  #timer: ReturnType<typeof setInterval> | null = null
  #closed = false

  constructor(options: ConsoleExtensionsOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    ensurePrivateDir(options.directory)
    this.#bookPath = path.join(options.directory, 'extensions.json')
    this.#lock = acquirePrivateInstanceLock(
      path.join(options.directory, 'instance.lock'),
    )
    if (!this.#lock)
      options.onError?.('扩展目录已由另一实例持有；本实例只读，不向节点下发')
    const text = readTextIfExists(this.#bookPath)
    const book =
      text === undefined
        ? { v: 1 as const, extensions: [], nodes: {} }
        : bookSchema.parse(JSON.parse(text))
    this.#vault = new ConnectorVault(
      path.join(options.directory, 'vault.key'),
      book.extensions.flatMap(entry =>
        entry.secret
          ? [{ id: entry.id, secret: entry.secret as ConnectorSecret }]
          : [],
      ),
    )
    for (const entry of book.extensions) this.#entries.set(entry.id, entry)
    this.#nodes = book.nodes
  }

  /** Pushes once now, then checks every node periodically. */
  start(): void {
    if (!this.#lock?.owned() || this.#options.control === undefined) return
    this.#push()
    this.#timer = setInterval(
      () => this.#push(),
      this.#options.reconcileMs ?? RECONCILE_MS,
    )
    this.#timer.unref?.()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer !== null) clearInterval(this.#timer)
    await this.#pushing?.catch(() => {})
    this.#lock?.release()
  }

  /** Settles when the push in progress, if any, has finished (tests). */
  async settled(): Promise<void> {
    while (this.#pushing !== null) await this.#pushing.catch(() => {})
  }

  #save(): void {
    writePrivateJson(this.#bookPath, {
      v: 1,
      extensions: [...this.#entries.values()],
      nodes: this.#nodes,
    })
  }

  #secrets(entry: Stored): {
    env: Record<string, string>
    headers: Record<string, string>
  } {
    if (entry.secret === null) return { env: {}, headers: {} }
    const raw = this.#vault.reveal(
      entry.id,
      entry.secret as ConnectorSecret,
      entry.secret.revision,
    )
    const parsed = z
      .object({
        env: z.record(z.string(), z.string()),
        headers: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(raw))
    return parsed
  }

  // -- views ------------------------------------------------------------------

  /** The nodes an entry goes to: those of its agents, or every node with one. */
  #targets(
    entry: Stored,
    nodes: readonly string[],
    agents: readonly string[],
  ): string[] {
    const wanted = new Set(
      (entry.agents.length > 0 ? entry.agents : agents).map(nodeOf),
    )
    // Without a roster every node may have agents.
    if (entry.agents.length === 0 && agents.length === 0) return [...nodes]
    return nodes.filter(node => wanted.has(node))
  }

  #view(entry: Stored, agents: readonly string[]): ExtensionView {
    const nodes = this.#targets(entry, this.#options.nodes(), agents)
    const states: ExtensionNodeState[] = nodes.map(node => {
      const record = this.#nodes[node]
      const expected = this.#expected.get(node)
      const result = record?.results[entry.id]
      if (
        record === undefined ||
        expected === undefined ||
        record.digest !== expected ||
        result === undefined
      )
        return {
          node,
          state: 'pending',
          detail: record?.error ?? null,
          at: record?.at ?? null,
        }
      return {
        node,
        state: result.ok ? 'applied' : 'failed',
        detail: result.detail,
        at: record.at,
      }
    })
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      enabled: entry.enabled,
      agents: entry.agents,
      transport: entry.transport,
      command: entry.command,
      args: entry.args,
      url: entry.url,
      envKeys: entry.envKeys,
      headerKeys: entry.headerKeys,
      approval: entry.approval,
      body: entry.body,
      source:
        entry.source === null
          ? null
          : {
              repo: entry.source.repo,
              ref: entry.source.ref,
              path: entry.source.path,
              commit: entry.source.commit,
            },
      nodes: states,
      updatedAt: entry.updatedAt,
      updatedBy: entry.updatedBy,
    }
  }

  async snapshot(): Promise<ConsoleResult<ExtensionsSnapshot>> {
    const agents = await this.#options.agents().catch(() => [])
    const nodes = this.#options.nodes()
    return ok({
      extensions: [...this.#entries.values()]
        .sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
        )
        .map(entry => this.#view(entry, agents)),
      agentChoices: agents.filter(address => {
        const node = nodeOf(address)
        return node !== null && nodes.includes(node)
      }),
      nodes,
    })
  }

  // -- writes -----------------------------------------------------------------

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work)
    this.#queue = run.catch(() => {})
    return run
  }

  save(
    draft: ExtensionDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ExtensionView>> {
    return this.#serial(async () => {
      if (!this.#lock?.owned())
        return fail<ExtensionView>('refused', '本实例不持有扩展目录，只读')
      try {
        const stored = await this.#build(draft, actor)
        const before = this.#entries.get(stored.id)
        this.#entries.set(stored.id, stored)
        try {
          this.#wireBytes()
        } catch (error) {
          if (before === undefined) this.#entries.delete(stored.id)
          else this.#entries.set(stored.id, before)
          throw error
        }
        this.#save()
        this.#push()
        const agents = await this.#options.agents().catch(() => [])
        return ok(this.#view(stored, agents))
      } catch (error) {
        if (error instanceof Invalid || error instanceof GithubDirError)
          return fail<ExtensionView>('invalid', error.message)
        this.#options.onError?.(`extensions: save failed: ${message(error)}`)
        return fail<ExtensionView>('unreachable', `保存失败：${message(error)}`)
      }
    })
  }

  remove(id: string, _actor: DirectionActor): Promise<ConsoleResult<void>> {
    return this.#serial(async () => {
      if (!this.#lock?.owned())
        return fail<void>('refused', '本实例不持有扩展目录，只读')
      if (!this.#entries.delete(id))
        return fail<void>('not_found', '没有这个扩展')
      this.#save()
      this.#push()
      return ok(undefined)
    })
  }

  /** Every node's set must fit one control message. */
  #wireBytes(): void {
    const total = [...this.#entries.values()]
      .filter(entry => entry.enabled)
      .reduce((sum, entry) => {
        const secrets = this.#secrets(entry)
        return (
          sum +
          Buffer.byteLength(JSON.stringify({ ...entry, secret: null, secrets }))
        )
      }, 0)
    if (total > MAX_WIRE_BYTES)
      throw new Invalid(
        `扩展合计超过 ${MAX_WIRE_BYTES / 1024} KiB · 删掉一些或把长技能放到仓库里导入`,
      )
  }

  #unique(kind: ExtensionKind, name: string, id: string): void {
    // Skills and plugins share the skills namespace a runtime shows.
    const clash = [...this.#entries.values()].some(
      entry =>
        entry.id !== id &&
        entry.name === name &&
        (entry.kind === kind || (kind !== 'mcp' && entry.kind !== 'mcp')),
    )
    if (clash) throw new Invalid(`已有同名的扩展 ${name}`)
  }

  async #build(draft: ExtensionDraft, actor: DirectionActor): Promise<Stored> {
    const now = this.#now()
    const id = typeof draft.id === 'string' ? draft.id : undefined
    const before = id === undefined ? undefined : this.#entries.get(id)
    if (id !== undefined && before === undefined)
      throw new Invalid('没有这个扩展')
    // Only `id` and `enabled`: switch it on or off, keep the pin.
    if (before !== undefined && draft.kind === undefined) {
      if (typeof draft.enabled !== 'boolean') throw new Invalid('缺少启用状态')
      return {
        ...before,
        enabled: draft.enabled,
        updatedAt: now,
        updatedBy: actor.subject,
      }
    }
    const kind = draft.kind
    if (!(EXTENSION_KINDS as readonly unknown[]).includes(kind))
      throw new Invalid('扩展种类无效')
    if (before !== undefined && before.kind !== kind)
      throw new Invalid('不能改扩展的种类')
    if (before === undefined && this.#entries.size >= MAX_ENTRIES)
      throw new Invalid(`最多 ${MAX_ENTRIES} 个扩展`)
    const agents = [...new Set(draft.agents ?? [])]
    if (agents.length > 100) throw new Invalid('最多选 100 个智能体')
    for (const address of agents)
      if (typeof address !== 'string' || parseAddress(address) === null)
        throw new Invalid(`智能体地址 ${String(address)} 无效`)
    const entryId = before?.id ?? `ext-${randomUUID()}`
    const base = {
      id: entryId,
      kind: kind!,
      enabled: draft.enabled !== false,
      agents,
      updatedAt: now,
      updatedBy: actor.subject,
      transport: null,
      command: null,
      args: [],
      url: null,
      envKeys: [],
      headerKeys: [],
      approval: 'ask' as const,
      body: null,
      source: null,
      secret: null,
    } satisfies Partial<Stored>

    if (kind === 'mcp') {
      const name = String(draft.name ?? '').trim()
      if (!EXTENSION_NAME.test(name) || RESERVED_NAMES.has(name))
        throw new Invalid('名称只能用小写字母 · 数字与连字符 · 字母开头')
      this.#unique('mcp', name, entryId)
      const transport = draft.transport ?? 'stdio'
      if (!['stdio', 'http', 'sse'].includes(transport))
        throw new Invalid('传输方式无效')
      const approval = draft.approval === 'allow' ? 'allow' : 'ask'
      const old = before === undefined ? null : this.#secrets(before)
      const merge = (
        given: Map<string, string | null>,
        stored: Record<string, string> | undefined,
        field: string,
      ): Record<string, string> => {
        const out: Record<string, string> = {}
        for (const [key, value] of given) {
          const kept = value ?? stored?.[key]
          if (kept === undefined) throw new Invalid(`${field} ${key} 还没有值`)
          out[key] = kept
        }
        return out
      }
      let stdio: Partial<Stored> = {}
      let env: Record<string, string> = {}
      let headers: Record<string, string> = {}
      if (transport === 'stdio') {
        const command = String(draft.command ?? '').trim()
        if (!COMMAND.test(command))
          throw new Invalid('命令只写命令名 · 不带路径 · 节点按 PATH 查找')
        const args = (draft.args ?? []).map(String)
        if (args.length > 64 || args.some(arg => arg.length > 1024))
          throw new Invalid('参数最多 64 个 · 每个不超过 1024 字符')
        env = merge(
          secretMap(draft.env, ENV_NAME, '环境变量'),
          old?.env,
          '环境变量',
        )
        stdio = { command, args }
      } else {
        headers = merge(
          secretMap(draft.headers, HEADER_NAME, '请求头'),
          old?.headers,
          '请求头',
        )
        stdio = { url: remoteUrl(draft.url) }
      }
      const hasSecrets =
        Object.keys(env).length > 0 || Object.keys(headers).length > 0
      return {
        ...base,
        ...stdio,
        name,
        description: String(draft.description ?? '')
          .trim()
          .slice(0, 200),
        transport,
        approval,
        envKeys: Object.keys(env),
        headerKeys: Object.keys(headers),
        secret: hasSecrets
          ? this.#vault.seal(
              entryId,
              'password',
              (before?.secret?.revision ?? 0) + 1,
              JSON.stringify({ env, headers }),
              now,
            )
          : null,
      }
    }

    if (kind === 'skill' && draft.source === undefined) {
      const name = String(draft.name ?? '').trim()
      if (!EXTENSION_NAME.test(name) || RESERVED_NAMES.has(name))
        throw new Invalid('名称只能用小写字母 · 数字与连字符 · 字母开头')
      this.#unique('skill', name, entryId)
      const description = String(draft.description ?? '').trim()
      if (description === '' || description.length > 1024)
        throw new Invalid('用途必填 · 不超过 1024 字符')
      const body = String(draft.body ?? '')
      if (body.trim() === '' || body.length > MAX_BODY)
        throw new Invalid(`正文必填 · 不超过 ${MAX_BODY / 1024} KiB`)
      return { ...base, name, description, body }
    }

    // A GitHub directory: pin it, fetch it once here, read its manifest.
    const ref = checkRef({
      repo: String(draft.source?.repo ?? '').trim(),
      ref: String(draft.source?.ref ?? ''),
      path: String(draft.source?.path ?? ''),
    })
    const token = (await this.#options.repoToken?.(ref.repo)) ?? null
    const commit = await resolveCommit(
      this.#options.policy,
      ref.repo,
      ref.ref,
      token,
    )
    const work = path.join(this.#options.directory, 'work')
    mkdirSync(work, { recursive: true, mode: 0o700 })
    const dest = path.join(work, `check-${randomUUID()}`)
    try {
      const fetched = await fetchGithubDir({
        policy: this.#options.policy,
        repo: ref.repo,
        commit,
        path: ref.path,
        work,
        dest,
        token,
        ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
      })
      const source = {
        repo: ref.repo,
        ref: ref.ref,
        path: ref.path,
        commit,
        digest: fetched.digest,
      }
      if (kind === 'skill') {
        let text: string
        try {
          text = readFileSync(path.join(dest, 'SKILL.md'), 'utf8')
        } catch {
          throw new Invalid('目录里没有 SKILL.md')
        }
        const front = skillFrontMatter(text)
        const name = front.name ?? ''
        if (!EXTENSION_NAME.test(name) || RESERVED_NAMES.has(name))
          throw new Invalid(
            'SKILL.md 的 name 要用小写字母 · 数字与连字符 · 不超过 40 字符',
          )
        if ((front.description ?? '').trim() === '')
          throw new Invalid('SKILL.md 缺少 description')
        this.#unique('skill', name, entryId)
        return {
          ...base,
          name,
          description: front.description!.trim().slice(0, 1024),
          source,
        }
      }
      const formats = pluginFormats(dest)
      if (!formats.claude && !formats.standard && formats.codex === null)
        throw new Invalid(
          '目录里没有插件清单（.claude-plugin/plugin.json · .codex-plugin/plugin.json 或 plugin.json）',
        )
      const manifest =
        readJsonText(path.join(dest, '.claude-plugin', 'plugin.json')) ??
        readJsonText(path.join(dest, 'plugin.json')) ??
        readJsonText(path.join(dest, '.codex-plugin', 'plugin.json'))
      const fallback = (ref.path.split('/').pop() || ref.repo.split('/')[1]!)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const name = String(draft.name ?? '').trim() || fallback
      if (!EXTENSION_NAME.test(name) || RESERVED_NAMES.has(name))
        throw new Invalid('插件名称只能用小写字母 · 数字与连字符 · 请填一个')
      this.#unique('plugin', name, entryId)
      return {
        ...base,
        name,
        description:
          typeof manifest?.description === 'string'
            ? manifest.description.slice(0, 1024)
            : '',
        source,
      }
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  }

  // -- delivery ---------------------------------------------------------------

  /** One node's entries, with secrets, for its own agents. */
  #payload(node: string, agents: readonly string[]): ExtensionWireEntry[] {
    const onNode = agents.filter(address => nodeOf(address) === node)
    const out: ExtensionWireEntry[] = []
    for (const entry of this.#entries.values()) {
      if (!entry.enabled) continue
      let names: string[] | null = null
      if (entry.agents.length > 0) {
        names = entry.agents
          .filter(address => nodeOf(address) === node)
          .map(address => parseAddress(address)!.agent)
        if (names.length === 0) continue
      } else if (onNode.length === 0 && agents.length > 0) {
        // Every agent: only nodes that have one.
        continue
      }
      const secrets = this.#secrets(entry)
      out.push({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        agents: names,
        ...(entry.transport === null ? {} : { transport: entry.transport }),
        ...(entry.command === null ? {} : { command: entry.command }),
        ...(entry.args.length > 0 ? { args: entry.args } : {}),
        ...(Object.keys(secrets.env).length > 0 ? { env: secrets.env } : {}),
        ...(entry.url === null ? {} : { url: entry.url }),
        ...(Object.keys(secrets.headers).length > 0
          ? { headers: secrets.headers }
          : {}),
        ...(entry.kind === 'mcp' ? { approval: entry.approval } : {}),
        ...(entry.kind === 'skill' && entry.source === null
          ? { description: entry.description, body: entry.body ?? '' }
          : {}),
        ...(entry.source === null
          ? {}
          : {
              github: {
                repo: entry.source.repo,
                commit: entry.source.commit,
                path: entry.source.path,
                digest: entry.source.digest,
              },
            }),
      })
    }
    return out
  }

  /** Brings every node to its set; one push at a time, the last one wins. */
  #push(): void {
    if (this.#closed || this.#options.control === undefined) return
    if (this.#pushing !== null) {
      this.#again = true
      return
    }
    this.#pushing = (async () => {
      try {
        do {
          this.#again = false
          await this.#pushOnce()
        } while (this.#again && !this.#closed)
      } catch (error) {
        this.#options.onError?.(`extensions: push failed: ${message(error)}`)
      } finally {
        this.#pushing = null
      }
    })()
  }

  async #pushOnce(): Promise<void> {
    const control = this.#options.control!
    const agents = await this.#options.agents().catch(() => [])
    const nodes = this.#options.nodes()
    await Promise.all(
      nodes.map(async node => {
        const entries = this.#payload(node, agents)
        const digest = extensionsDigest(entries)
        this.#expected.set(node, digest)
        const record = this.#nodes[node]
        let current: ExtensionsStatus | null = null
        if (record?.digest === digest) {
          const status = await control
            .request(node, 'extensions.status', {}, 'extensions', {
              timeoutMs: 60_000,
            })
            .catch(() => null)
          current =
            status?.ok === true ? (status.value as ExtensionsStatus) : null
          if (
            current?.digest === digest &&
            current.results.every(result => result.ok)
          ) {
            this.#record(node, current, null)
            return
          }
        }
        const outcome = await control
          .request(
            node,
            'extensions.apply',
            { digest, entries },
            'extensions',
            {
              timeoutMs: 10 * 60_000,
            },
          )
          .catch(
            (error): ControlOutcome => ({
              ok: false,
              code: 'unreachable',
              message: message(error),
            }),
          )
        if (outcome.ok)
          this.#record(node, outcome.value as ExtensionsStatus, null)
        else
          this.#record(
            node,
            null,
            outcome.code === 'unreachable' || outcome.code === 'timeout'
              ? '节点未连上 · 稍后重试'
              : outcome.message,
          )
      }),
    )
    if (this.#lock?.owned()) this.#save()
  }

  #record(
    node: string,
    status: ExtensionsStatus | null,
    error: string | null,
  ): void {
    const previous = this.#nodes[node]
    this.#nodes[node] =
      status === null
        ? {
            digest: previous?.digest ?? null,
            results: previous?.results ?? {},
            at: previous?.at ?? null,
            error,
          }
        : {
            digest: status.digest,
            results: Object.fromEntries(
              status.results.map(result => [
                result.id,
                { ok: result.ok, detail: result.detail },
              ]),
            ),
            at: status.at ?? this.#now(),
            error: null,
          }
  }
}
