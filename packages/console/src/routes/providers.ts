// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务 (J1, `providers-console-m1.md` §6.3): the pages, the JSON the page
 * script talks to, and the polled fragments — all over the hub's
 * {@link ProviderPort} (P18.6). Nothing here keeps a provider fact of its own.
 *
 * ## Pages
 *
 * | Path | What |
 * | --- | --- |
 * | `/providers` | the global default, the node matrix, the profile cards; `?node=` narrows the matrix to one node |
 * | `/providers/new` | the preset grid, five groups, searched by a plain `GET` form (`?q=`) |
 * | `/providers/new?preset=<id>[&site=<id>]` | the form a preset starts: the key, and the advanced half folded |
 * | `/providers/profiles/<id>` | one profile: the same form filled in, its key, the nodes on it |
 * | `/providers/nodes/<node>` | one node's 「模型」 tab (§6.3.8): expected, actual, drift, every `effective` field, the context window (D-8) and the auto-compact window (D-9) |
 *
 * The 「模型」 tab is also a fragment, `GET /fragments/providers/node/<node>`
 * (view; `<node>` one percent-encoded segment): the interface P18.11's
 * `/nodes/<node>` loads. Its write controls are links to
 * `/providers/nodes/<node>?do=…` that this area's script claims when it is on
 * the page; on P18.11's page, which carries no script of this area, they take
 * the writer here. The other fragments are `board` (the matrix),
 * `profiles/<id>/nodes` and `chat?target=<address>` (the chat page's label).
 * | `/providers/import` | paste or pick an export, preview it whole, import |
 *
 * A profile lives under `profiles/` rather than straight under `/providers`:
 * `new`, `import` and `nodes` are all ids a profile may have.
 *
 * ## Who may write (§7.3)
 *
 * {@link providerWriter}: a personal `ops` account outside break-glass. Not
 * {@link canWrite} — that also says yes to the legacy admin token and to the
 * admin token in break-glass, and §7.3 puts both with `viewer` here. The port
 * asks the same question again (K-2), so a route that forgot would still be
 * refused, but a page must not draw a control whose answer is a refusal.
 *
 * ## The order a write goes in
 *
 * Role (`guard`, view, guarded) → path → method → admin and writer → port
 * wired → the input parsed → `ctx.admit()` → the port. The port writes the ledger line
 * itself at the moment the act is done (`ProviderCaller`), one per node for an
 * apply; this module never records a provider write a second time. A refusal
 * at the writer step is not recorded, the same as every role refusal.
 *
 * ## Reads stay reads
 *
 * Pages, fragments and the JSON reads answer from the port's cache: they never
 * call `admit`, never write, and never reach a node. Asking a node for its
 * state now is 刷新, a writer's button (`POST …/nodes/<node>/refresh`).
 *
 * ## `/v0/providers`
 *
 * | Method and path | Who | Port |
 * | --- | --- | --- |
 * | `GET /v0/providers` | any credential, trimmed by role | `overview` |
 * | `GET /v0/providers/catalog` | any | `catalog` |
 * | `GET /v0/providers/profiles/<id>` | any, trimmed | `profile` |
 * | `GET /v0/providers/nodes/<node>` | any, trimmed | `node` |
 * | `POST /v0/providers/profiles` `{profile, presetId, site?, secrets?}` | writer | `saveProfile` (new) |
 * | `PUT /v0/providers/profiles/<id>` `{profile, ifMatch, secrets?}` | writer | `saveProfile` |
 * | `DELETE /v0/providers/profiles/<id>` `{ifMatch}` | writer | `deleteProfile` |
 * | `PUT\|DELETE /v0/providers/profiles/<id>/keys/<keyId>` `{value?, ifMatch}` | writer | `setSecret` / `clearSecret` |
 * | `PUT /v0/providers/default` `{profileId}` | writer | `setDefault` |
 * | `PUT /v0/providers/nodes/<node>/assignment` `{mode, profileId?}` | writer | `assign` |
 * | `PUT /v0/providers/nodes/<node>/context` `{tokens}` | writer | `setContextOverride` |
 * | `POST /v0/providers/nodes/<node>/refresh` | writer | `refreshNode` |
 * | `GET\|PUT /v0/providers/nodes/<node>/autocompact` `{value}` | writer | `autocompact` |
 * | `POST /v0/providers/apply` `{nodes?, dryRun?, force?, sessions?, profileId?}` | writer | `apply` |
 * | `POST /v0/providers/probe` `{node, mode, …candidate}` | writer | `probe` |
 * | `POST /v0/providers/models` `{node, …candidate}` | writer | `models` |
 * | `POST /v0/providers/preview` `{node?, …candidate}` | writer | `preview` |
 * | `GET /v0/providers/export` | writer | `exportProfiles` |
 * | `POST /v0/providers/import/preview` `{text}` | writer | `importPreview` |
 * | `POST /v0/providers/import` `{text, renames?}` | writer | `importProfiles` |
 *
 * `If-Match` rides in the body as `ifMatch` (the shared `sendJson` cannot set
 * a header) or in the header; when both are there they must agree.
 *
 * ### The form sends only what it edits
 *
 * A profile the form saves is the stored one (or the preset's draft) with the
 * form's fields laid over it — {@link EDITABLE} and nothing else. Which preset
 * it came from, its plan, its probe requests, its terms and whether it was
 * evaluated are the hub's, so a crafted request cannot mark a profile
 * 已评估 or point its probe somewhere else.
 *
 * ### Failures
 *
 * `invalid` 400, `not_found` 404, `conflict` and `in_use` 409, `rejected`
 * 403, `unavailable` 503, `unreachable` 502, `refused` 422. The page script
 * sees only `error.message`, so the field, the changed fields and the nodes
 * still on a profile are folded into it, and the hub's sentence is put in the
 * console's register first ({@link calm}).
 */

import type {
  ProviderApplyResult,
  ProviderAssignment,
  ProviderCaller,
  ProviderCandidate,
  ProviderFailure,
  ProviderNodeActual,
  ProviderNodeView,
  ProviderOverview,
  ProviderPort,
  ProviderProfileSummary,
  ProviderProfileView,
  ProviderResult,
} from '../deps.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import { bar } from '../view/bits.js'
import { escapeHtml } from '../view/escape.js'
import {
  PROVIDERS_PAGE_CSS,
  baseUrlFor,
  boardActions,
  boardDialogs,
  calm,
  noScriptNote,
  progressPanel,
  providerFailureBar,
  readOnlyBadge,
  renderBoard,
  renderBoardFailure,
  renderProvidersOff,
  type ProvidersReader,
} from '../view/providers.js'
import {
  renderChatModel,
  renderEditor,
  renderImportPage,
  renderPresetGrid,
  renderPresetReadOnly,
  renderProfileNodes,
  renderProfileReadOnly,
  type EditorModel,
} from '../view/providersForm.js'
import { renderNodePanel, renderNodePage } from '../view/providersNode.js'
import { PROVIDERS_PAGE_JS } from '../view/providersScript.js'
import { guard, safeDecode, underPath } from './shared.js'
import type { PageRender, RouteContext, RouteModule } from './types.js'

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

/**
 * May this caller change model services: a personal `ops` account, not in
 * break-glass (§7.3). Everything a page draws for writing hangs off this.
 */
export function providerWriter(ctx: RouteContext): boolean {
  const principal = ctx.access.principal
  return (
    principal?.kind === 'user' &&
    principal.role === 'ops' &&
    !ctx.access.breakGlass
  )
}

function readerOf(ctx: RouteContext): ProvidersReader {
  return { writer: providerWriter(ctx), accountsOn: ctx.accounts !== undefined }
}

/** The caller a port write is made under (`deps.ts`, `ProviderCaller`). */
function callerOf(ctx: RouteContext): ProviderCaller {
  const principal = ctx.access.principal
  return {
    subject: principal?.subject ?? 'anonymous',
    role: principal?.kind === 'user' ? principal.role : null,
    breakGlass: ctx.access.breakGlass,
    record: ctx.record,
  }
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const WRITER_REQUIRED =
  '模型服务的写操作需要运维角色的个人账号 · 共用令牌与 break-glass 只能查看'
const PROVIDERS_UNWIRED =
  '模型服务未开启 · 启动控制台时加 --providers 与 --accounts'
const BODY_REQUIRED = '请求体必须是 JSON 对象'
const BODY_TOO_LARGE = '请求体过大'

/** Biggest JSON body this module reads: an export of every profile fits. */
const MAX_BODY_BYTES = 1_048_576

const STATUS_OF: Readonly<Record<ProviderFailure['code'], number>> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  in_use: 409,
  rejected: 403,
  unavailable: 503,
  unreachable: 502,
  refused: 422,
}

/**
 * A port failure as the JSON answer. The detail the hub attached is kept as
 * fields and, because the shared client only shows `message`, also said in it.
 */
export function providerFailureResponse(failure: ProviderFailure): Response {
  let message = calm(failure.message)
  if (failure.code === 'conflict' && (failure.fields?.length ?? 0) > 0) {
    message += ` · 被改动的字段 ${(failure.fields ?? []).join(' ')}`
  }
  if (failure.code === 'in_use' && (failure.nodes?.length ?? 0) > 0) {
    message += ` · 在用的节点 ${(failure.nodes ?? []).join(' ')}`
  }
  if (failure.code === 'invalid' && failure.path !== undefined) {
    message += ` · 字段 ${failure.path}`
  }
  if (failure.code === 'refused' && failure.nodeCode !== undefined) {
    message += ` · ${failure.nodeCode}`
  }
  return json(
    {
      error: {
        code: failure.code,
        message,
        ...(failure.path === undefined ? {} : { path: failure.path }),
        ...(failure.fields === undefined ? {} : { fields: failure.fields }),
        ...(failure.nodes === undefined ? {} : { nodes: failure.nodes }),
        ...(failure.nodeCode === undefined
          ? {}
          : { nodeCode: failure.nodeCode }),
      },
    },
    STATUS_OF[failure.code],
  )
}

function answer<T>(
  result: ProviderResult<T>,
  shape: (value: T) => unknown,
): Response {
  return result.ok
    ? json(shape(result.value))
    : providerFailureResponse(result.failure)
}

function invalid(message: string): Response {
  return fail(400, 'invalid', message)
}

/** A JSON object body of bounded size, or the 400 to answer with. */
async function bodyOf(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, 'limit', BODY_TOO_LARGE)
  }
  let text: string
  try {
    text = await request.text()
  } catch {
    return invalid(BODY_REQUIRED)
  }
  if (text.length > MAX_BODY_BYTES) return fail(413, 'limit', BODY_TOO_LARGE)
  try {
    const parsed: unknown = JSON.parse(text === '' ? '{}' : text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return invalid(BODY_REQUIRED)
    return parsed as Record<string, unknown>
  } catch {
    return invalid(BODY_REQUIRED)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `If-Match` from the body or the header; `undefined` when absent, `null` when they disagree. */
function ifMatchOf(
  request: Request,
  body: Record<string, unknown>,
): number | undefined | null {
  const fromBody = body.ifMatch
  const header = request.headers.get('if-match')
  const fromHeader =
    header === null ? undefined : Number(header.replace(/"/g, '').trim())
  if (fromBody !== undefined && typeof fromBody !== 'number') return null
  if (fromHeader !== undefined && !Number.isSafeInteger(fromHeader)) return null
  if (
    typeof fromBody === 'number' &&
    fromHeader !== undefined &&
    fromBody !== fromHeader
  ) {
    return null
  }
  const value = typeof fromBody === 'number' ? fromBody : fromHeader
  if (value === undefined) return undefined
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

// ---------------------------------------------------------------------------
// Trimming by role (§7.3)
// ---------------------------------------------------------------------------

/** A profile as a reader who may not write sees it: no fingerprints, the host only. */
function trimProfile(profile: ProviderProfileView, writer: boolean): unknown {
  if (writer) return profile
  const {
    templateValues: _t,
    compat: _c,
    probe: _p,
    keys,
    baseUrl: _b,
    ...rest
  } = profile
  return {
    ...rest,
    baseUrl: baseUrlFor(profile, false),
    keys: keys.map(key => ({
      id: key.id,
      ...(key.label === undefined ? {} : { label: key.label }),
      ...(key.setAt === undefined ? {} : { setAt: key.setAt }),
    })),
  }
}

function trimActual(
  actual: ProviderNodeActual | null,
  writer: boolean,
): unknown {
  if (writer || actual === null) return actual
  return {
    managed: actual.managed,
    applied:
      actual.applied === null
        ? null
        : {
            profileId: actual.applied.profileId,
            revision: actual.applied.revision,
            at: actual.applied.at,
          },
    pending:
      actual.pending === null
        ? null
        : {
            since: actual.pending.since,
            waitingTurns: actual.pending.waitingTurns,
          },
    resident: actual.resident,
    capabilities: actual.capabilities,
    ...(actual.effective === undefined ? {} : { effective: actual.effective }),
  }
}

function trimNode(node: ProviderNodeView, writer: boolean): unknown {
  if (writer) return node
  return {
    node: node.node,
    executor: node.executor,
    assignment: node.assignment,
    contextOverride: node.contextOverride,
    expected: node.expected,
    actual: trimActual(node.actual, false),
    lastStatus:
      node.lastStatus === null
        ? null
        : { at: node.lastStatus.at, ok: node.lastStatus.ok },
    drift: node.drift.map(drift => ({ kind: drift.kind })),
    recent: [],
  }
}

function trimSummary(
  summary: ProviderProfileSummary,
  writer: boolean,
): unknown {
  return writer
    ? summary
    : { ...summary, profile: trimProfile(summary.profile, false) }
}

function trimOverview(overview: ProviderOverview, writer: boolean): unknown {
  if (writer) return overview
  return {
    revision: overview.revision,
    defaultProfileId: overview.defaultProfileId,
    profiles: overview.profiles.map(summary => trimSummary(summary, false)),
    nodes: overview.nodes.map(node => trimNode(node, false)),
  }
}

/** Node text in a result, in the console's register. */
function calmApply(result: ProviderApplyResult): ProviderApplyResult {
  return { ...result, message: calm(result.message) }
}

// ---------------------------------------------------------------------------
// The form's profile (J-20)
// ---------------------------------------------------------------------------

/** The fields the form edits. Everything else comes from the stored profile or the preset. */
const EDITABLE = [
  'name',
  'site',
  'lane',
  'baseUrl',
  'templateValues',
  'models',
  'compat',
  'effortLock',
  'auth',
] as const

/**
 * The profile to save or probe: `base` with the form's fields laid over it.
 * An empty `templateValues` or `compat` is left out rather than sent empty.
 */
export function mergeEdit(
  base: ProviderProfileView,
  edit: Readonly<Record<string, unknown>>,
  id: string,
): Record<string, unknown> {
  const { revision: _revision, ...rest } = base
  const merged: Record<string, unknown> = { ...rest, id }
  for (const field of EDITABLE) {
    if (!(field in edit)) continue
    merged[field] = edit[field]
  }
  for (const field of ['templateValues', 'compat'] as const) {
    const value = merged[field]
    if (
      value === null ||
      value === undefined ||
      (isRecord(value) && Object.keys(value).length === 0)
    ) {
      delete merged[field]
    }
  }
  return merged
}

/** Where a form's profile starts: the stored one, or the preset's draft. */
async function baseOf(
  port: ProviderPort,
  body: Record<string, unknown>,
): Promise<ProviderResult<ProviderProfileView>> {
  const profileId = stringOf(body.profileId)
  if (profileId !== undefined) return await port.profile(profileId)
  const presetId = stringOf(body.presetId)
  if (presetId === undefined) {
    return {
      ok: false,
      failure: { code: 'invalid', message: '缺少预设', path: 'presetId' },
    }
  }
  const site = stringOf(body.site)
  return port.draftFromPreset({
    presetId,
    ...(site === undefined ? {} : { site }),
  })
}

/**
 * A candidate for probe, models and preview: the form's unsaved profile when
 * it sends one (`edit`), else the stored profile by id; a typed key rides
 * along as `secret` and is never written anywhere by these.
 */
async function candidateOf(
  port: ProviderPort,
  body: Record<string, unknown>,
): Promise<ProviderResult<ProviderCandidate>> {
  const secret = stringOf(body.secret)
  const withSecret = secret === undefined ? {} : { secret }
  if (isRecord(body.edit)) {
    const base = await baseOf(port, body)
    if (!base.ok) return base
    const id =
      stringOf(body.profileId) ?? stringOf(body.edit.id) ?? base.value.id
    return {
      ok: true,
      value: { draft: mergeEdit(base.value, body.edit, id), ...withSecret },
    }
  }
  const profileId = stringOf(body.profileId)
  if (profileId === undefined) {
    return {
      ok: false,
      failure: { code: 'invalid', message: '缺少档案', path: 'profileId' },
    }
  }
  return { ok: true, value: { profileId, ...withSecret } }
}

function secretsOf(
  body: Record<string, unknown>,
): Readonly<Record<string, string>> | null | undefined {
  const raw = body.secrets
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) return null
  const secrets: Record<string, string> = {}
  for (const [keyId, value] of Object.entries(raw)) {
    if (typeof value !== 'string') return null
    if (value.length > 0) secrets[keyId] = value
  }
  return Object.keys(secrets).length === 0 ? undefined : secrets
}

function assignmentOf(
  body: Record<string, unknown>,
): ProviderAssignment | null {
  if (body.mode === 'inherit') return { mode: 'inherit' }
  if (body.mode === 'unmanaged') return { mode: 'unmanaged' }
  const profileId = stringOf(body.profileId)
  if (body.mode === 'profile' && profileId !== undefined) {
    return { mode: 'profile', profileId }
  }
  return null
}

/** `200000`, `200k`, `1M`, `1m`; `null` for empty (clear); `undefined` for nonsense. */
export function tokensOf(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (typeof raw === 'number')
    return Number.isSafeInteger(raw) ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().replace(/[\s_,]/g, '')
  if (text === '') return null
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(text)
  if (match === null) return undefined
  const scale =
    match[2] === 'k' || match[2] === 'K'
      ? 1_000
      : match[2] === 'm' || match[2] === 'M'
        ? 1_000_000
        : 1
  const value = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(value) ? value : undefined
}

function stringList(value: unknown): readonly string[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return null
  }
  return value as readonly string[]
}

// ---------------------------------------------------------------------------
// /v0/providers
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface Endpoint {
  /** Who may call it: any credential reads, a writer writes. */
  readonly writer: boolean
  /** Ask the ledger first: every write the port records. */
  readonly admit: boolean
  run(
    ctx: RouteContext,
    port: ProviderPort,
    body: Record<string, unknown>,
  ): Promise<Response>
}

/** The endpoints under one path, by method; `null` when the path is not one. */
function endpointsOf(
  rest: readonly string[],
): Partial<Record<Method, Endpoint>> | null {
  const [first, second, third, fourth] = rest
  if (rest.length === 0) {
    return {
      GET: {
        writer: false,
        admit: false,
        async run(ctx, port) {
          const writer = providerWriter(ctx)
          return answer(await port.overview(), value =>
            trimOverview(value, writer),
          )
        },
      },
    }
  }
  if (rest.length === 1 && first === 'catalog') {
    return {
      GET: {
        writer: false,
        admit: false,
        async run(_ctx, port) {
          return json(port.catalog())
        },
      },
    }
  }
  if (rest.length === 1 && first === 'profiles') {
    return { POST: saveEndpoint(null) }
  }
  if (rest.length === 2 && first === 'profiles' && second !== undefined) {
    return {
      GET: {
        writer: false,
        admit: false,
        async run(ctx, port) {
          const writer = providerWriter(ctx)
          return answer(await port.profile(second), value =>
            trimProfile(value, writer),
          )
        },
      },
      PUT: saveEndpoint(second),
      DELETE: {
        writer: true,
        admit: true,
        async run(ctx, port, body) {
          const ifMatch = ifMatchOf(ctx.request, body)
          if (typeof ifMatch !== 'number') return invalid('缺少修订号 ifMatch')
          const result = await port.deleteProfile(
            { profileId: second, ifMatch },
            callerOf(ctx),
          )
          return answer(result, () => ({ deleted: second }))
        },
      },
    }
  }
  if (
    rest.length === 4 &&
    first === 'profiles' &&
    second !== undefined &&
    third === 'keys' &&
    fourth !== undefined
  ) {
    return {
      PUT: {
        writer: true,
        admit: true,
        async run(ctx, port, body) {
          const ifMatch = ifMatchOf(ctx.request, body)
          if (typeof ifMatch !== 'number') return invalid('缺少修订号 ifMatch')
          const value = stringOf(body.value)
          if (value === undefined) return invalid('密钥不能为空')
          const result = await port.setSecret(
            { profileId: second, keyId: fourth, value, ifMatch },
            callerOf(ctx),
          )
          return answer(result, profile => ({ profile }))
        },
      },
      DELETE: {
        writer: true,
        admit: true,
        async run(ctx, port, body) {
          const ifMatch = ifMatchOf(ctx.request, body)
          if (typeof ifMatch !== 'number') return invalid('缺少修订号 ifMatch')
          const result = await port.clearSecret(
            { profileId: second, keyId: fourth, ifMatch },
            callerOf(ctx),
          )
          return answer(result, profile => ({ profile }))
        },
      },
    }
  }
  if (rest.length === 1 && first === 'default') {
    return {
      PUT: {
        writer: true,
        admit: true,
        async run(ctx, port, body) {
          const raw = body.profileId
          if (raw !== null && stringOf(raw) === undefined) {
            return invalid('profileId 必须是档案 id 或 null')
          }
          const profileId = raw === null ? null : (stringOf(raw) ?? null)
          const result = await port.setDefault({ profileId }, callerOf(ctx))
          return answer(result, () => ({ defaultProfileId: profileId }))
        },
      },
    }
  }
  if (rest.length >= 2 && first === 'nodes' && second !== undefined) {
    return nodeEndpoints(second, rest.slice(2))
  }
  if (rest.length === 1 && first === 'apply') {
    return {
      POST: {
        writer: true,
        // A dry run writes nothing and records nothing (`deps.ts`); the
        // ledger is asked inside, for a real one only.
        admit: false,
        async run(ctx, port, body) {
          const nodes = stringList(body.nodes)
          if (nodes === null) return invalid('nodes 必须是节点名数组')
          const dryRun = body.dryRun === true
          const force = body.force === true
          const sessions =
            body.sessions === 'keep' || body.sessions === 'reset'
              ? body.sessions
              : undefined
          if (body.sessions !== undefined && sessions === undefined) {
            return invalid('sessions 只能是 keep 或 reset')
          }
          const profileId = stringOf(body.profileId)
          if (!dryRun) {
            const blocked = await ctx.admit()
            if (blocked !== null) return blocked
          }
          const result = await port.apply(
            {
              ...(nodes === undefined ? {} : { nodes }),
              ...(dryRun ? { dryRun } : {}),
              ...(force ? { force } : {}),
              ...(sessions === undefined ? {} : { sessions }),
              ...(profileId === undefined ? {} : { profileId }),
            },
            callerOf(ctx),
          )
          return answer(result, results => ({
            results: results.map(calmApply),
          }))
        },
      },
    }
  }
  if (rest.length === 1 && first === 'probe') {
    return {
      POST: {
        writer: true,
        admit: true,
        async run(ctx, port, body) {
          const node = stringOf(body.node)
          if (node === undefined) return invalid('缺少节点')
          const mode =
            body.mode === 'latency' || body.mode === 'call'
              ? body.mode
              : body.mode === 'auth' || body.mode === undefined
                ? 'auth'
                : null
          if (mode === null) return invalid('mode 只能是 auth latency 或 call')
          const candidate = await candidateOf(port, body)
          if (!candidate.ok) return providerFailureResponse(candidate.failure)
          const result = await port.probe(
            { node, mode, candidate: candidate.value },
            callerOf(ctx),
          )
          return answer(result, probe => ({
            ...probe,
            message: calm(probe.message),
          }))
        },
      },
    }
  }
  if (rest.length === 1 && first === 'models') {
    return {
      POST: {
        writer: true,
        admit: false,
        async run(ctx, port, body) {
          const node = stringOf(body.node)
          if (node === undefined) return invalid('缺少节点')
          const hasCandidate = isRecord(body.edit) || stringOf(body.profileId)
          let candidate: ProviderCandidate | undefined
          if (hasCandidate) {
            const built = await candidateOf(port, body)
            if (!built.ok) return providerFailureResponse(built.failure)
            candidate = built.value
          }
          const result = await port.models(
            { node, ...(candidate === undefined ? {} : { candidate }) },
            callerOf(ctx),
          )
          return answer(result, models => ({ models }))
        },
      },
    }
  }
  if (rest.length === 1 && first === 'preview') {
    return {
      POST: {
        writer: true,
        admit: false,
        async run(_ctx, port, body) {
          const node = stringOf(body.node)
          const candidate = await candidateOf(port, body)
          if (!candidate.ok) return providerFailureResponse(candidate.failure)
          const result = await port.preview({
            candidate: candidate.value,
            ...(node === undefined ? {} : { node }),
          })
          return answer(result, preview => preview)
        },
      },
    }
  }
  if (rest.length === 2 && first === 'import' && second === 'preview') {
    return {
      POST: {
        writer: true,
        admit: false,
        async run(_ctx, port, body) {
          const text = typeof body.text === 'string' ? body.text : undefined
          if (text === undefined || text.trim() === '') {
            return invalid('没有要导入的内容')
          }
          return answer(await port.importPreview(text), preview => preview)
        },
      },
    }
  }
  if (rest.length === 1 && first === 'import') {
    return {
      POST: {
        writer: true,
        admit: true,
        async run(ctx, port, body) {
          const text = typeof body.text === 'string' ? body.text : undefined
          if (text === undefined || text.trim() === '') {
            return invalid('没有要导入的内容')
          }
          const renames = body.renames
          if (renames !== undefined && !isRecord(renames)) {
            return invalid('renames 必须是对象')
          }
          const map: Record<string, string> = {}
          for (const [from, to] of Object.entries(renames ?? {})) {
            if (typeof to !== 'string')
              return invalid('renames 的值必须是字符串')
            map[from] = to
          }
          const result = await port.importProfiles(
            {
              text,
              ...(Object.keys(map).length === 0 ? {} : { renames: map }),
            },
            callerOf(ctx),
          )
          return answer(result, profiles => ({ profiles }))
        },
      },
    }
  }
  return null
}

function saveEndpoint(id: string | null): Endpoint {
  return {
    writer: true,
    admit: true,
    async run(ctx, port, body) {
      const edit = body.profile
      if (!isRecord(edit)) return invalid('缺少档案 profile')
      const secrets = secretsOf(body)
      if (secrets === null) return invalid('secrets 必须是 keyId 到密钥的对象')
      let ifMatch: number | null = null
      if (id !== null) {
        const asked = ifMatchOf(ctx.request, body)
        if (typeof asked !== 'number') return invalid('缺少修订号 ifMatch')
        ifMatch = asked
      }
      const base = await baseOf(
        port,
        id === null ? body : { ...body, profileId: id },
      )
      if (!base.ok) return providerFailureResponse(base.failure)
      const profileId = id ?? stringOf(edit.id) ?? base.value.id
      const result = await port.saveProfile(
        {
          profile: mergeEdit(base.value, edit, profileId),
          ifMatch,
          ...(secrets === undefined ? {} : { secrets }),
        },
        callerOf(ctx),
      )
      return answer(result, profile => ({ profile }))
    },
  }
}

function nodeEndpoints(
  node: string,
  rest: readonly string[],
): Partial<Record<Method, Endpoint>> | null {
  if (rest.length === 0) {
    return {
      GET: {
        writer: false,
        admit: false,
        async run(ctx, port) {
          const writer = providerWriter(ctx)
          return answer(await port.node(node), value => trimNode(value, writer))
        },
      },
    }
  }
  if (rest.length !== 1) return null
  switch (rest[0]) {
    case 'assignment':
      return {
        PUT: {
          writer: true,
          admit: true,
          async run(ctx, port, body) {
            const assignment = assignmentOf(body)
            if (assignment === null) {
              return invalid('mode 只能是 inherit profile 或 unmanaged')
            }
            const result = await port.assign(
              { node, assignment },
              callerOf(ctx),
            )
            return answer(result, view => ({ node: view }))
          },
        },
      }
    case 'context':
      return {
        PUT: {
          writer: true,
          admit: true,
          async run(ctx, port, body) {
            const tokens = tokensOf(body.tokens)
            if (tokens === undefined) {
              return invalid('上下文窗口要写成 token 数 · 例如 200000 或 1M')
            }
            const result = await port.setContextOverride(
              { node, tokens },
              callerOf(ctx),
            )
            return answer(result, view => ({ node: view }))
          },
        },
      }
    case 'refresh':
      return {
        POST: {
          writer: true,
          admit: false,
          async run(_ctx, port) {
            return answer(await port.refreshNode(node), view => ({
              node: view,
            }))
          },
        },
      }
    case 'autocompact':
      return {
        GET: {
          writer: true,
          admit: false,
          async run(ctx, port) {
            const result = await port.autocompact({ node }, callerOf(ctx))
            return answer(result, value => value)
          },
        },
        PUT: {
          writer: true,
          admit: true,
          async run(ctx, port, body) {
            const raw = body.value
            let value: 'auto' | number | undefined
            if (
              typeof raw === 'string' &&
              raw.trim().toLowerCase() === 'auto'
            ) {
              value = 'auto'
            } else {
              const tokens = tokensOf(raw)
              value = typeof tokens === 'number' ? tokens : undefined
            }
            if (value === undefined) {
              return invalid('自动压缩阈值写 auto 或 100k 到 1M 的 token 数')
            }
            const result = await port.autocompact(
              { node, value },
              callerOf(ctx),
            )
            return answer(result, settled => settled)
          },
        },
      }
    default:
      return null
  }
}

async function handleApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const exporting = rest.length === 1 && rest[0] === 'export'
  // Export is a read a plain link can make: `document`, like a page.
  const denied = guard(
    ctx.access.credential,
    'view',
    exporting ? 'document' : 'guarded',
  )
  if (denied !== null) return denied
  if (exporting) return await handleExport(ctx)
  const endpoints = endpointsOf(rest)
  if (endpoints === null) return notFound(`unknown path: ${ctx.url.pathname}`)
  const method = ctx.request.method as Method
  const endpoint = endpoints[method]
  if (endpoint === undefined) return methodNotAllowed(Object.keys(endpoints))
  if (endpoint.writer) {
    const strict = guard(ctx.access.credential, 'admin', 'guarded')
    if (strict !== null) return strict
    if (!providerWriter(ctx)) return fail(403, 'forbidden', WRITER_REQUIRED)
  }
  const port = ctx.deps.providers
  if (port === undefined) return fail(501, 'unsupported', PROVIDERS_UNWIRED)
  let body: Record<string, unknown> = {}
  if (method !== 'GET') {
    const parsed = await bodyOf(ctx.request)
    if (parsed instanceof Response) return parsed
    body = parsed
  }
  if (endpoint.admit) {
    const blocked = await ctx.admit()
    if (blocked !== null) return blocked
  }
  return await endpoint.run(ctx, port, body)
}

/** `GET /v0/providers/export`: a file, no key and no fingerprint in it (§3.9). */
async function handleExport(ctx: RouteContext): Promise<Response> {
  if (!providerWriter(ctx)) return fail(403, 'forbidden', WRITER_REQUIRED)
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const port = ctx.deps.providers
  if (port === undefined) return fail(501, 'unsupported', PROVIDERS_UNWIRED)
  const ids = ctx.url.searchParams.getAll('id').filter(id => id !== '')
  const result = await port.exportProfiles(ids.length === 0 ? undefined : ids)
  if (!result.ok) return providerFailureResponse(result.failure)
  const filename = result.value.filename.replace(/[^A-Za-z0-9._-]/g, '_')
  return new Response(result.value.text, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

async function handleFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  const [first, second, third] = rest
  const known =
    (rest.length === 1 && (first === 'board' || first === 'chat')) ||
    (rest.length === 2 && first === 'node') ||
    (rest.length === 3 && first === 'profiles' && third === 'nodes')
  if (!known) return notFound(`unknown path: ${ctx.url.pathname}`)
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const port = ctx.deps.providers
  const reader = readerOf(ctx)
  if (port === undefined) {
    return html(first === 'chat' ? '' : renderProvidersOff())
  }
  if (first === 'board') {
    const only = ctx.url.searchParams.get('node') ?? undefined
    const overview = await port.overview()
    return html(
      overview.ok
        ? renderBoard({
            overview: overview.value,
            catalog: port.catalog(),
            reader,
            now: ctx.now,
            ...(only === undefined || only === '' ? {} : { only }),
          })
        : renderBoardFailure(overview.failure),
    )
  }
  if (first === 'chat') {
    const target = ctx.url.searchParams.get('target') ?? ''
    const overview = await port.overview()
    return html(
      overview.ok ? renderChatModel(overview.value, target, ctx.now) : '',
    )
  }
  if (first === 'node') {
    const name = safeDecode(second ?? '')
    if (name === null) return notFound(`unknown path: ${ctx.url.pathname}`)
    const [node, overview] = await Promise.all([
      port.node(name),
      port.overview(),
    ])
    if (!node.ok) {
      return html(
        providerFailureBar(node.failure),
        STATUS_OF[node.failure.code],
      )
    }
    return html(
      renderNodePanel({
        node: node.value,
        overview: overview.ok ? overview.value : null,
        reader,
        now: ctx.now,
      }),
    )
  }
  const id = safeDecode(second ?? '')
  if (id === null) return notFound(`unknown path: ${ctx.url.pathname}`)
  const overview = await port.overview()
  if (!overview.ok) return html(providerFailureBar(overview.failure))
  return html(renderProfileNodes(overview.value, id, reader, ctx.now))
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function frame(ctx: RouteContext): Pick<PageRender, 'actions'> {
  return providerWriter(ctx) ? {} : { actions: readOnlyBadge() }
}

function missing(title: string, line: string, crumbs: string): PageRender {
  return {
    title,
    crumbs: [{ label: crumbs }],
    status: 404,
    body: bar('muted', line),
  }
}

async function boardPage(
  ctx: RouteContext,
  port: ProviderPort,
): Promise<PageRender> {
  const reader = readerOf(ctx)
  const only = ctx.url.searchParams.get('node') ?? ''
  const overview = await port.overview()
  const poll = `/fragments/providers/board${
    only === '' ? '' : `?node=${encodeURIComponent(only)}`
  }`
  const board = overview.ok
    ? renderBoard({
        overview: overview.value,
        catalog: port.catalog(),
        reader,
        now: ctx.now,
        ...(only === '' ? {} : { only }),
      })
    : renderBoardFailure(overview.failure)
  return {
    title: '模型服务',
    ...(reader.writer ? { actions: boardActions() } : frame(ctx)),
    poll: true,
    body:
      (reader.writer ? noScriptNote() + progressPanel() : '') +
      `<div class="prov-board" id="prov-board" data-poll="${escapeHtml(
        poll,
      )}">${board}</div>` +
      (reader.writer ? boardDialogs(overview.ok ? overview.value : null) : ''),
  }
}

async function newPage(
  ctx: RouteContext,
  port: ProviderPort,
): Promise<PageRender> {
  const reader = readerOf(ctx)
  const presetId = ctx.url.searchParams.get('preset')
  const catalog = port.catalog()
  if (presetId === null || presetId === '') {
    return {
      title: '新增模型服务',
      crumbs: [{ label: '新增' }],
      ...frame(ctx),
      body: renderPresetGrid(catalog, ctx.url.searchParams.get('q') ?? ''),
    }
  }
  const preset = catalog.presets.find(entry => entry.id === presetId)
  if (preset === undefined) {
    return missing('新增模型服务', '没有这个预设 · 回到预设列表重选', '新增')
  }
  if (!reader.writer) {
    return {
      title: preset.name,
      crumbs: [
        { label: '新增', href: '/providers/new' },
        { label: preset.name },
      ],
      ...frame(ctx),
      body: renderPresetReadOnly(preset),
    }
  }
  const site = ctx.url.searchParams.get('site') ?? undefined
  const draft = port.draftFromPreset({
    presetId,
    ...(site === undefined || site === '' ? {} : { site }),
  })
  const overview = await port.overview()
  if (!draft.ok) {
    return {
      title: preset.name,
      crumbs: [
        { label: '新增', href: '/providers/new' },
        { label: preset.name },
      ],
      status: STATUS_OF[draft.failure.code],
      body: providerFailureBar(draft.failure),
    }
  }
  const model: EditorModel = {
    mode: 'create',
    profile: draft.value,
    preset,
    catalog,
    overview: overview.ok ? overview.value : null,
    summary: undefined,
    now: ctx.now,
  }
  return {
    title: preset.name,
    crumbs: [{ label: '新增', href: '/providers/new' }, { label: preset.name }],
    body:
      noScriptNote() +
      (overview.ok ? '' : providerFailureBar(overview.failure)) +
      progressPanel() +
      renderEditor(model) +
      boardDialogs(overview.ok ? overview.value : null),
  }
}

async function profilePage(
  ctx: RouteContext,
  port: ProviderPort,
  id: string,
): Promise<PageRender> {
  const reader = readerOf(ctx)
  const [profile, overview] = await Promise.all([
    port.profile(id),
    port.overview(),
  ])
  if (!profile.ok) {
    if (profile.failure.code === 'not_found') {
      return missing('模型服务', '没有这份模型服务 · 可能已被删除', id)
    }
    return {
      title: '模型服务',
      crumbs: [{ label: id }],
      status: STATUS_OF[profile.failure.code],
      body: providerFailureBar(profile.failure),
    }
  }
  const catalog = port.catalog()
  const summary = overview.ok
    ? overview.value.profiles.find(entry => entry.profile.id === id)
    : undefined
  const nodes =
    `<div class="prov-profile-nodes" id="prov-profile-nodes" data-poll="${escapeHtml(
      `/fragments/providers/profiles/${encodeURIComponent(id)}/nodes`,
    )}">` +
    (overview.ok
      ? renderProfileNodes(overview.value, id, reader, ctx.now)
      : providerFailureBar(overview.failure)) +
    `</div>`
  const crumbs = [{ label: profile.value.name }]
  if (!reader.writer) {
    return {
      title: profile.value.name,
      crumbs,
      ...frame(ctx),
      poll: true,
      body:
        renderProfileReadOnly({
          profile: profile.value,
          summary,
          catalog,
          reader,
        }) + nodes,
    }
  }
  const preset =
    profile.value.presetId === null
      ? undefined
      : catalog.presets.find(entry => entry.id === profile.value.presetId)
  return {
    title: profile.value.name,
    crumbs,
    poll: true,
    body:
      noScriptNote() +
      progressPanel() +
      renderEditor({
        mode: 'edit',
        profile: profile.value,
        preset,
        catalog,
        overview: overview.ok ? overview.value : null,
        summary,
        now: ctx.now,
      }) +
      nodes +
      boardDialogs(overview.ok ? overview.value : null),
  }
}

async function nodePage(
  ctx: RouteContext,
  port: ProviderPort,
  name: string,
): Promise<PageRender> {
  const reader = readerOf(ctx)
  const [node, overview] = await Promise.all([port.node(name), port.overview()])
  if (!node.ok) {
    if (node.failure.code === 'not_found') {
      return missing('节点', '没有这个节点 · 模型服务只管登记过的节点', name)
    }
    return {
      title: name,
      crumbs: [{ label: name }],
      status: STATUS_OF[node.failure.code],
      body: providerFailureBar(node.failure),
    }
  }
  return {
    title: name,
    crumbs: [{ label: name }],
    ...frame(ctx),
    poll: true,
    body:
      (reader.writer ? noScriptNote() + progressPanel() : '') +
      renderNodePage({
        node: node.value,
        overview: overview.ok ? overview.value : null,
        reader,
        now: ctx.now,
      }) +
      (reader.writer ? boardDialogs(overview.ok ? overview.value : null) : ''),
  }
}

function importPage(ctx: RouteContext): PageRender {
  const reader = readerOf(ctx)
  return {
    title: '导入模型服务',
    crumbs: [{ label: '导入' }],
    ...frame(ctx),
    body: reader.writer
      ? noScriptNote() + renderImportPage()
      : bar('muted', '导入需要运维角色的个人账号'),
  }
}

async function providersPage(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<PageRender | Response> {
  const port = ctx.deps.providers
  if (port === undefined) {
    return { title: '模型服务', body: renderProvidersOff() }
  }
  const [first, second] = rest
  if (rest.length === 0) return await boardPage(ctx, port)
  if (rest.length === 1 && first === 'new') return await newPage(ctx, port)
  if (rest.length === 1 && first === 'import') return importPage(ctx)
  if (rest.length === 2 && second !== undefined) {
    const name = safeDecode(second)
    if (name !== null && first === 'profiles') {
      return await profilePage(ctx, port, name)
    }
    if (name !== null && first === 'nodes') {
      return await nodePage(ctx, port, name)
    }
  }
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

export const providersRoute: RouteModule = {
  area: {
    id: 'providers',
    label: '模型服务',
    group: 'config',
    href: '/providers',
    icon: 'cpu',
  },
  page: {
    match: underPath('providers', 2),
    guard: 'view',
    async render(ctx, rest) {
      return await providersPage(ctx, rest)
    },
    css: PROVIDERS_PAGE_CSS,
    script: PROVIDERS_PAGE_JS,
  },
  api: {
    heads: ['providers'],
    async handle(ctx, _head, rest) {
      return await handleApi(ctx, rest)
    },
  },
  fragments: {
    heads: ['providers'],
    async handle(ctx, _head, rest) {
      return await handleFragment(ctx, rest)
    },
  },
}
