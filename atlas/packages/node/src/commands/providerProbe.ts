// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm provider probe` (`auth`, `latency`) and `qm provider models`: the HTTP
 * requests a node makes to tell whether a model service answers (design
 * `providers-console-m1.md` §5.5, R-9). Run on the node, because the node is
 * the one that will talk to the endpoint — its DNS, its egress, its
 * `localhost`.
 *
 * ## Three states
 *
 *   - `{ok: true}` — the service answered, with a body that is not an error;
 *   - `{ok: false, reachable: true}` — an HTTP answer came back, and it says
 *     no: a rejected key, an error body under HTTP 200 (some vendors do that),
 *     no such endpoint, a redirect, rate limiting, a server error;
 *   - `{ok: false, reachable: false}` — no HTTP answer at all: refused, DNS,
 *     TLS, reset, timeout.
 *
 * Judged on the body, not just the status (§5.5). What goes back is the
 * status, a vendor error code that passes a strict pattern, and a message of
 * our own. **Never the vendor's text**: vendors quote part of the key they
 * rejected in their error messages, and nothing here can tell.
 *
 * ## Which request
 *
 * A profile that is a catalog preset as delivered — same lane, same base URL
 * text as the preset or one of its sites — uses that preset's own `probe`
 * requests (`@qianmo/providers`, R-1), joined onto the origin. The wire
 * profile carries no preset id, so the node recognises the preset from its own
 * copy of the catalog rather than taking the hub's word. When several presets
 * share the URL and disagree, or the URL was edited, the generic request for
 * the lane is used: `{base}/models` (OpenAI lanes, Grok, DeepSeek's mirror),
 * `{base}/v1/models` (Anthropic lane), `{base}/models` (Gemini). An auth
 * request the catalog marks as not free is not sent: `auth` and `latency`
 * must cost nothing (§5.5).
 *
 * Candidates are tried in order and only a 404 or 405 moves on to the next.
 * That is also where the `/v1` correction lives (hermes B8): an OpenAI-lane
 * base without `/v1` whose `/models` is 404 is retried with `/v1`, and a hit
 * comes back as `suggestion.baseUrl`; an Anthropic-lane base ending in `/v1`
 * (the runtime appends `/v1/messages` itself) is suggested without it and
 * probed that way. With a suggestion present, `ok` and `reachable` describe
 * the suggested address.
 *
 * Redirects are not followed: a cross-origin hop would carry the key header
 * to a host nobody configured.
 */

import { readFileSync } from 'node:fs'
import {
  type AuthScheme,
  type HttpProbe,
  type Lane,
  type NodeCapabilities,
  PRESETS,
  type ProbeSpec,
  type ProviderIssue,
  primaryKey,
  resolveBaseUrl,
  secretFingerprint,
  type WireProfile,
} from '@qianmo/providers'
import {
  type CompiledProfile,
  compileProfile,
} from '../../services/qianmo/providers/compile.js'
import {
  type ManagedView,
  managedViewOf,
} from '../../services/qianmo/providers/managedView.js'
import { SECRET_ENV_KEYS } from '../../services/qianmo/providers/whitelist.js'
import { isDeepSeekBaseURL } from '../../utils/model/deepseekHost.js'
import { getSettingsFilePathForSource } from '../../utils/settings/settings.js'

/** One probe's answer, before it is wrapped into a protocol response. */
export type ProbeOutcome = {
  ok: boolean
  reachable: boolean
  /** Chinese, ours: the reason and the next step. Never vendor text. */
  message: string
  httpStatus?: number
  vendorCode?: string
  suggestion?: { baseUrl: string }
  latency?: { medianMs: number; minMs: number; samples: number }
  models?: { id: string }[]
}

/** How the generic request is shaped. */
type Style = 'openai' | 'anthropic' | 'gemini'

/** What a probe talks to, with the key already resolved. */
export type ProbeTarget = {
  /** The lane the runtime will actually speak. */
  lane: Lane
  style: Style
  /** Resolved (templates filled in), exactly as configured. */
  baseUrl: string
  scheme: AuthScheme
  secret: string
  /** The matching preset's requests, when the profile is one. */
  spec: ProbeSpec | null
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The node's `settings.json` as an object; `{}` when missing or unreadable. */
export function nodeSettings(): Record<string, unknown> {
  const path = getSettingsFilePathForSource('userSettings')
  if (path === undefined) return {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function nodeView(): ManagedView {
  return managedViewOf(nodeSettings())
}

/** The value a `keep` fingerprint names, among the node's credential keys. */
function keptSecret(
  view: ManagedView,
  fingerprint: string,
): string | undefined {
  for (const key of SECRET_ENV_KEYS) {
    const value = view.env[key]
    if (value !== undefined && secretFingerprint(value) === fingerprint) {
      return value
    }
  }
  return undefined
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * The preset requests for `(lane, baseUrl)`, when exactly one set of them
 * applies. The base URL is compared as written (templates unresolved), with
 * trailing slashes ignored.
 */
function presetSpec(lane: Lane, baseUrl: string): ProbeSpec | null {
  const wanted = trimSlash(baseUrl)
  const specs = new Set<string>()
  let found: ProbeSpec | null = null
  for (const preset of PRESETS) {
    if (preset.lane !== lane) continue
    const urls = [preset.baseUrl, ...preset.sites.map(site => site.baseUrl)]
      .filter(url => url !== '')
      .map(trimSlash)
    if (!urls.includes(wanted)) continue
    specs.add(JSON.stringify(preset.probe))
    found = preset.probe
  }
  return specs.size === 1 ? found : null
}

function styleOf(lane: Lane, deepseekMirror: boolean): Style {
  if (deepseekMirror) return 'openai'
  if (lane === 'anthropic') return 'anthropic'
  if (lane === 'gemini') return 'gemini'
  return 'openai'
}

type TargetFailure = { ok: false; issue: ProviderIssue }

type TargetResult = { ok: true; target: ProbeTarget } | TargetFailure

/**
 * A delivered profile, compiled the way `apply` would compile it; the
 * compiled patch is what `call` writes into its temporary root.
 */
export function profileTarget(
  profile: WireProfile,
  capabilities: NodeCapabilities,
):
  | { ok: true; target: ProbeTarget; compiled: CompiledProfile }
  | TargetFailure {
  const key = primaryKey(profile.auth.keys)
  const secret = 'value' in key ? key.value : keptSecret(nodeView(), key.keep)
  if (secret === undefined) {
    return {
      ok: false,
      issue: {
        code: 'secret-mismatch',
        path: 'profile.auth.keys',
        message: '节点上没有指纹相符的密钥 · 需要重新填写',
      },
    }
  }
  const compiled = compileProfile(profile, { secret, capabilities })
  if (!compiled.ok) return { ok: false, issue: compiled.error }
  const resolved = resolveBaseUrl(profile.baseUrl, profile.templateValues)
  if (!resolved.ok) {
    return {
      ok: false,
      issue: {
        code: 'bad-value',
        path: 'profile.baseUrl',
        message: resolved.message,
      },
    }
  }
  const mirror = compiled.compiled.route === 'deepseek-mirror'
  return {
    ok: true,
    target: {
      lane: compiled.compiled.effectiveLane,
      style: styleOf(compiled.compiled.effectiveLane, mirror),
      baseUrl: resolved.url,
      scheme: profile.auth.scheme,
      secret,
      spec: presetSpec(profile.lane, profile.baseUrl),
    },
    compiled: compiled.compiled,
  }
}

/**
 * The configuration already applied to this node (`models` without a
 * profile). Only managed settings are read: the compiler always writes the
 * base URL and the key, so nothing has to be guessed or defaulted.
 */
export function appliedTarget(): TargetResult {
  const view = nodeView()
  const env = view.env
  const missing = (message: string): TargetResult => ({
    ok: false,
    issue: { code: 'bad-request', path: 'profile', message },
  })
  let lane: Lane
  let baseUrl: string | undefined
  let secret: string | undefined
  let scheme: AuthScheme = 'bearer'
  switch (view.modelType) {
    case 'anthropic':
      lane = 'anthropic'
      baseUrl = env.ANTHROPIC_BASE_URL
      secret = env.ANTHROPIC_AUTH_TOKEN
      if (secret === undefined && env.ANTHROPIC_API_KEY !== undefined) {
        secret = env.ANTHROPIC_API_KEY
        scheme = 'x-api-key'
      }
      break
    case 'openai':
      lane = env.OPENAI_WIRE_API === 'chat' ? 'openai-chat' : 'openai-responses'
      baseUrl = env.OPENAI_BASE_URL
      secret = env.OPENAI_API_KEY
      break
    case 'gemini':
      lane = 'gemini'
      baseUrl = env.GEMINI_BASE_URL
      secret = env.GEMINI_API_KEY
      break
    case 'grok':
      lane = 'grok'
      baseUrl = env.GROK_BASE_URL
      secret = env.GROK_API_KEY ?? env.XAI_API_KEY
      break
    default:
      return missing('节点的 settings.json 里没有可用的模型服务 · 请带 profile')
  }
  if (baseUrl === undefined || secret === undefined) {
    return missing('节点的 settings.json 里缺 Base URL 或密钥 · 请带 profile')
  }
  // §3.3: DeepSeek is written as OPENAI_* without a wire, and the runtime's
  // mirror moves it onto DeepSeek's Anthropic endpoint unless opted out.
  const mirror =
    view.modelType === 'openai' &&
    env.OPENAI_WIRE_API === undefined &&
    isDeepSeekBaseURL(baseUrl) &&
    env.CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE !== '0'
  return {
    ok: true,
    target: {
      lane,
      style: styleOf(lane, mirror),
      baseUrl,
      scheme,
      secret,
      spec: presetSpec(mirror ? 'anthropic' : lane, baseUrl),
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Candidate = {
  url: string
  method: 'GET' | 'POST'
  body?: Record<string, unknown>
  /** Offered as `suggestion.baseUrl` when this candidate is the one used. */
  suggestion?: string
  /** Offered even if the probe then fails (a static correction). */
  alwaysSuggest?: boolean
}

type HttpResult =
  | { kind: 'http'; status: number; json: unknown; isJson: boolean }
  | {
      kind: 'network'
      cause: 'refused' | 'dns' | 'tls' | 'timeout' | 'reset' | 'other'
    }

/** Bodies larger than this are cut; a key check or model list is far smaller. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

function headersFor(target: ProbeTarget): Record<string, string> {
  const { secret } = target
  if (target.style === 'gemini') {
    // Gemini's native API takes `x-goog-api-key`, its OpenAI-compatible
    // surface (the preset's probe) takes a bearer token; same host either way.
    return { authorization: `Bearer ${secret}`, 'x-goog-api-key': secret }
  }
  if (target.style === 'anthropic') {
    return {
      ...(target.scheme === 'x-api-key'
        ? { 'x-api-key': secret }
        : { authorization: `Bearer ${secret}` }),
      'anthropic-version': '2023-06-01',
    }
  }
  return { authorization: `Bearer ${secret}` }
}

function networkCause(
  error: unknown,
): Extract<HttpResult, { kind: 'network' }>['cause'] {
  const record = isRecord(error) ? error : {}
  const name = typeof record.name === 'string' ? record.name : ''
  const code = typeof record.code === 'string' ? record.code : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  if (/refused|FailedToOpenSocket/i.test(code)) return 'refused'
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(code)) return 'dns'
  if (/CERT|TLS|SSL|SELF_SIGNED|HANDSHAKE/i.test(code)) return 'tls'
  if (/ECONNRESET|ConnectionClosed|EPIPE/i.test(code)) return 'reset'
  return 'other'
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  void reader.cancel().catch(() => {})
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8')
}

async function send(
  candidate: Candidate,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<HttpResult> {
  try {
    const response = await fetch(candidate.url, {
      method: candidate.method,
      headers: {
        accept: 'application/json',
        ...headers,
        ...(candidate.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(candidate.body === undefined
        ? {}
        : { body: JSON.stringify(candidate.body) }),
      redirect: 'manual',
      signal,
    })
    const text = await readCapped(response)
    try {
      return {
        kind: 'http',
        status: response.status,
        json: JSON.parse(text) as unknown,
        isJson: true,
      }
    } catch {
      return {
        kind: 'http',
        status: response.status,
        json: undefined,
        isJson: false,
      }
    }
  } catch (error) {
    return { kind: 'network', cause: networkCause(error) }
  }
}

function presetCandidate(base: string, probe: HttpProbe): Candidate {
  return {
    url: new URL(probe.path, new URL(base).origin).href,
    method: probe.method,
    ...(probe.body === undefined ? {} : { body: probe.body }),
  }
}

function pathEndsWithV1(base: string): boolean {
  return /\/v1$/.test(new URL(base).pathname.replace(/\/+$/, ''))
}

/** The lane's own list-models request, with the `/v1` corrections. */
function genericCandidates(target: ProbeTarget): Candidate[] {
  const base = trimSlash(target.baseUrl)
  if (target.style === 'anthropic') {
    if (pathEndsWithV1(base)) {
      const stripped = base.slice(0, -'/v1'.length)
      return [
        {
          url: `${stripped}/v1/models`,
          method: 'GET',
          suggestion: stripped,
          alwaysSuggest: true,
        },
      ]
    }
    return [{ url: `${base}/v1/models`, method: 'GET' }]
  }
  const own: Candidate = { url: `${base}/models`, method: 'GET' }
  if (target.style === 'gemini' || pathEndsWithV1(base)) return [own]
  return [
    own,
    { url: `${base}/v1/models`, method: 'GET', suggestion: `${base}/v1` },
  ]
}

type Attempt = { result: HttpResult; candidate: Candidate; suggestion?: string }

/**
 * Try `candidates` in order; only 404 / 405 moves on. When every candidate
 * is 404 / 405 the first one's answer stands and nothing is suggested.
 */
async function tryCandidates(
  candidates: readonly Candidate[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Attempt> {
  let first: Attempt | undefined
  for (const candidate of candidates) {
    const result = await send(candidate, headers, signal)
    const attempt: Attempt = {
      result,
      candidate,
      ...(candidate.suggestion === undefined
        ? {}
        : { suggestion: candidate.suggestion }),
    }
    first ??= attempt
    const notThere =
      result.kind === 'http' && (result.status === 404 || result.status === 405)
    if (!notThere) return attempt
  }
  const fallback = first as Attempt
  return fallback.candidate.alwaysSuggest === true
    ? fallback
    : { result: fallback.result, candidate: fallback.candidate }
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * A value safe to hand back as a vendor error code: a word-like string first
 * (`invalid_api_key`, `INVALID_ARGUMENT`), a number only when there is none
 * (`1004`), and never the key or a piece of it.
 */
function vendorCodeOf(json: unknown, secret: string): string | undefined {
  const values: unknown[] = []
  if (isRecord(json)) {
    const error = json.error
    if (isRecord(error)) values.push(error.code, error.type, error.status)
    values.push(json.code)
    if (isRecord(json.base_resp)) values.push(json.base_resp.status_code)
  }
  const safe = (text: string): boolean =>
    /^[A-Za-z0-9_.-]{1,64}$/.test(text) &&
    !text.includes(secret) &&
    !(text.length >= 8 && secret.includes(text))
  const word = values.find(
    (value): value is string => typeof value === 'string' && safe(value),
  )
  if (word !== undefined) return word
  const number = values.find(
    (value): value is number =>
      typeof value === 'number' && Number.isInteger(value),
  )
  return number === undefined ? undefined : String(number)
}

/** HTTP 200 whose body says it failed (智谱、MiniMax and others do this). */
function isErrorBody(json: unknown): boolean {
  if (!isRecord(json)) return false
  if (json.error !== undefined && json.error !== null && json.error !== false) {
    return true
  }
  if (json.success === false) return true
  if (
    isRecord(json.base_resp) &&
    typeof json.base_resp.status_code === 'number' &&
    json.base_resp.status_code !== 0
  ) {
    return true
  }
  return (
    typeof json.code === 'number' &&
    json.code !== 0 &&
    json.code !== 200 &&
    (typeof json.msg === 'string' || typeof json.message === 'string')
  )
}

const NETWORK_MESSAGES: Record<
  Extract<HttpResult, { kind: 'network' }>['cause'],
  string
> = {
  refused: '连不上 · 连接被拒 · 检查地址、端口和节点到该地址的网络',
  dns: '连不上 · 域名解析失败 · 检查地址拼写和节点的 DNS',
  tls: '连不上 · TLS 握手失败 · 检查地址是否为 https 以及证书',
  timeout: '连不上 · 超时 · 检查节点到该地址的网络',
  reset: '连不上 · 连接被中断 · 检查节点的代理与出口网络',
  other: '连不上 · 检查地址和节点的出口网络',
}

/** Any non-success HTTP answer, with our own wording. */
function rejection(
  status: number,
  json: unknown,
  secret: string,
): ProbeOutcome {
  const vendorCode = vendorCodeOf(json, secret)
  const code = vendorCode === undefined ? '' : ` · 厂商错误码 ${vendorCode}`
  let message: string
  if (status >= 200 && status < 300) {
    message = `服务可达 · HTTP ${status} 但响应体是错误${code} · 凭据或参数被拒`
  } else if (status >= 300 && status < 400) {
    message = `服务可达 · 地址发生跳转（HTTP ${status}）· 检查 Base URL`
  } else if (status === 401 || status === 403) {
    message = `服务可达 · 凭据被拒（HTTP ${status}）${code} · 检查密钥是否填对、是否属于这个站点`
  } else if (status === 400) {
    message = `服务可达 · 请求被拒（HTTP 400）${code} · 常见原因是密钥无效或模型名不对`
  } else if (status === 402) {
    message = `服务可达 · 余额或额度不足（HTTP 402）${code}`
  } else if (status === 404 || status === 405) {
    message = `服务可达 · 这个地址上没有验证接口（HTTP ${status}）· 检查 Base URL · 或改用真实调用测连`
  } else if (status === 429) {
    message = `服务可达 · 被限流或额度用尽（HTTP 429）${code} · 稍后再试`
  } else if (status >= 500) {
    message = `服务可达 · 服务端出错（HTTP ${status}）${code} · 稍后再试`
  } else {
    message = `服务可达 · 请求被拒（HTTP ${status}）${code}`
  }
  return {
    ok: false,
    reachable: true,
    message,
    httpStatus: status,
    ...(vendorCode === undefined ? {} : { vendorCode }),
  }
}

function withSuggestion(outcome: ProbeOutcome, attempt: Attempt): ProbeOutcome {
  if (attempt.suggestion === undefined) return outcome
  return {
    ...outcome,
    suggestion: { baseUrl: attempt.suggestion },
    message: `${outcome.message} · 按建议地址测得`,
  }
}

function authVerdict(attempt: Attempt, secret: string): ProbeOutcome {
  const { result } = attempt
  if (result.kind === 'network') {
    return {
      ok: false,
      reachable: false,
      message: NETWORK_MESSAGES[result.cause],
    }
  }
  const { status, json } = result
  if (status >= 200 && status < 300) {
    if (!result.isJson) {
      return {
        ok: false,
        reachable: true,
        httpStatus: status,
        message: '服务可达 · 返回的不是 JSON · 地址可能指向了网页而不是 API',
      }
    }
    if (isErrorBody(json)) return rejection(status, json, secret)
    return {
      ok: true,
      reachable: true,
      httpStatus: status,
      message: '可用 · 服务应答正常',
    }
  }
  return rejection(status, json, secret)
}

/** Wire ids the catalog validator would accept, never one holding the key. */
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:/~@+-]{0,127}$/
const MAX_MODELS = 1000

function modelIds(json: unknown, secret: string): string[] | null {
  const list = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.data)
      ? json.data
      : isRecord(json) && Array.isArray(json.models)
        ? json.models
        : null
  if (list === null) return null
  const ids = new Set<string>()
  for (const entry of list) {
    const raw =
      typeof entry === 'string'
        ? entry
        : isRecord(entry) && typeof entry.id === 'string'
          ? entry.id
          : isRecord(entry) && typeof entry.name === 'string'
            ? entry.name.replace(/^models\//, '')
            : undefined
    if (raw !== undefined && MODEL_ID.test(raw) && !raw.includes(secret)) {
      ids.add(raw)
    }
    if (ids.size >= MAX_MODELS) break
  }
  return [...ids]
}

function modelsVerdict(attempt: Attempt, secret: string): ProbeOutcome {
  const verdict = authVerdict(attempt, secret)
  if (!verdict.ok || attempt.result.kind !== 'http') return verdict
  const ids = modelIds(attempt.result.json, secret)
  if (ids === null) {
    return {
      ok: false,
      reachable: true,
      httpStatus: attempt.result.status,
      message: '服务可达 · 响应里没有模型列表 · 请手动填写模型',
    }
  }
  return {
    ...verdict,
    models: ids.map(id => ({ id })),
    message: `拉到 ${ids.length} 个模型`,
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function authCandidates(target: ProbeTarget): Candidate[] {
  const preset = target.spec?.auth
  const usable = preset !== null && preset !== undefined && preset.free
  return usable
    ? [presetCandidate(target.baseUrl, preset), ...genericCandidates(target)]
    : genericCandidates(target)
}

/** `probe` with `mode: auth`: one key check. */
export async function probeAuth(
  target: ProbeTarget,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const signal = AbortSignal.timeout(timeoutMs)
  const attempt = await tryCandidates(
    authCandidates(target),
    headersFor(target),
    signal,
  )
  return withSuggestion(authVerdict(attempt, target.secret), attempt)
}

/**
 * `probe` with `mode: latency`: a warm-up check, then three more against the
 * same address, timed. Network round trip only — no inference.
 */
export async function probeLatency(
  target: ProbeTarget,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const signal = AbortSignal.timeout(timeoutMs)
  const headers = headersFor(target)
  const warm = await tryCandidates(authCandidates(target), headers, signal)
  const warmVerdict = withSuggestion(authVerdict(warm, target.secret), warm)
  if (!warmVerdict.ok) return warmVerdict
  const samples: number[] = []
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now()
    const result = await send(warm.candidate, headers, signal)
    const elapsed = performance.now() - started
    const verdict = authVerdict({ ...warm, result }, target.secret)
    if (!verdict.ok) return withSuggestion(verdict, warm)
    samples.push(elapsed)
  }
  samples.sort((a, b) => a - b)
  const medianMs = Math.round(samples[1] as number)
  const minMs = Math.round(samples[0] as number)
  return {
    ...warmVerdict,
    latency: { medianMs, minMs, samples: samples.length },
    message: `网络往返 中位 ${medianMs} ms · 最快 ${minMs} ms · 不含推理`,
  }
}

/** `models`: the vendor's list, preset request first, then the generic one. */
export async function listModels(
  target: ProbeTarget,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const signal = AbortSignal.timeout(timeoutMs)
  const preset = target.spec?.models
  const candidates =
    preset === null || preset === undefined
      ? genericCandidates(target)
      : [presetCandidate(target.baseUrl, preset), ...genericCandidates(target)]
  const attempt = await tryCandidates(candidates, headersFor(target), signal)
  return withSuggestion(modelsVerdict(attempt, target.secret), attempt)
}

/**
 * Whether anything answers HTTP at the base URL's origin — no key sent. For
 * `call`, so an endpoint that cannot be reached costs nothing.
 */
export async function originAnswers(
  baseUrl: string,
  timeoutMs: number,
): Promise<ProbeOutcome | null> {
  const result = await send(
    { url: `${new URL(baseUrl).origin}/`, method: 'GET' },
    {},
    AbortSignal.timeout(timeoutMs),
  )
  return result.kind === 'network'
    ? { ok: false, reachable: false, message: NETWORK_MESSAGES[result.cause] }
    : null
}
