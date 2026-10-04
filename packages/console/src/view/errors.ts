// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What an operator is told when something did not work (C5, I1).
 *
 * ## Two audiences, two strings
 *
 * An API error body is `{ error: { code, message } }`, and the `message` is
 * written for whoever reads the JSON: a developer, a script, a bug report. It
 * may spend a sentence, name a flag, quote a URL or carry the transport's own
 * English (`transport did not become ready within 15000ms`). The page is read
 * by somebody else, under the copy rule every other string on the console
 * keeps — one calm clause, `·` between facts, none of `。，、；：！`.
 *
 * So the page never prints a `message` it did not vet. {@link humanizeError}
 * turns `(code, status, message)` into the one short line the page shows, and
 * hands the original back as `detail`, which the page folds away under 详情 —
 * still there to select and paste into a ticket, never in the sentence.
 *
 * ## How the line is chosen, in order
 *
 * 1. **A known shape of transport text** ({@link ERROR_PATTERNS}): a timeout,
 *    a refused or failed connection, a missing or unwritable file. These are
 *    the strings the ports hand up from `fetch`, Bun and the file system, and
 *    each has one fixed phrase.
 * 2. **A message that already keeps the rules** is shown as it is. The model
 *    service port writes its refusals that way (`deps.ts`, `ProviderFailure`),
 *    and replacing 此服务已被他人修改 · 刷新后再保存 with a generic word would
 *    throw away the one sentence that says what to do.
 * 3. **Otherwise the code** ({@link ERROR_CODES}), and failing that the HTTP
 *    status ({@link ERROR_STATUSES}).
 *
 * A message whose first `·` segment is a short clean noun keeps it in front of
 * the phrase: `见证端点 · Unable to connect` reads 见证端点 · 无法连接, because
 * the page's own subject (审计链) does not say which half of the read failed.
 * A protocol code (`E_CAP_INSUFFICIENT`) is kept on the line as well: the
 * runbooks for wake refusals are written against it (issue #10, #14).
 *
 * ## One table, two runtimes
 *
 * The server renders failure strips with this function; the browser runtime
 * (`assets/client.ts`) carries the same three tables, serialised from here,
 * and an algorithm written out again in plain JavaScript. `test/copyGate`
 * runs both over the same corpus and requires the same answers, so the two
 * cannot drift.
 */

/** What went wrong, as the API or a port reported it. */
export interface ErrorInput {
  readonly code?: string
  readonly status?: number
  readonly message?: string
}

/** The line for the page, and the original for 详情 (empty when the same). */
export interface HumanError {
  readonly text: string
  readonly detail: string
}

/**
 * Known shapes of transport and file-system text, first match wins. Patterns
 * are case-insensitive regular expression sources, because the browser
 * runtime rebuilds them from this table.
 */
export const ERROR_PATTERNS: readonly (readonly [string, string])[] = [
  ['did not become ready within|timed? ?out|timeout|ETIMEDOUT', '连接超时'],
  [
    'Unable to connect|ECONNREFUSED|Connection refused|ECONNRESET|socket hang up|' +
      'Failed to fetch|fetch failed|NetworkError|Load failed|ENOTFOUND|' +
      'EHOSTUNREACH|ENETUNREACH|getaddrinfo',
    '无法连接',
  ],
  ['ENOSPC|no space left', '磁盘已满'],
  ['EACCES|EPERM|permission denied|operation not permitted', '没有读写权限'],
  ['ENOENT|no such file', '文件不存在'],
  ['EISDIR|ENOTDIR', '路径不是文件'],
]

/** The phrase for each error code the console and its ports use. */
export const ERROR_CODES: Readonly<Record<string, string>> = {
  unreachable: '无法连接',
  refused: '对端拒绝执行',
  rejected: '本机规则不允许',
  not_found: '对象不存在',
  unsupported: '这台控制台未开启此功能',
  invalid: '请求内容不合法',
  forbidden: '权限不足',
  unauthorized: '会话已失效',
  method_not_allowed: '不支持此操作',
  internal: '控制台内部错误',
  unavailable: '暂时不可用',
  limit: '超出限制',
  conflict: '已被他人修改 · 刷新后再试',
  in_use: '仍有节点在用',
  network: '无法连接控制台',
  aborted: '已停止等待 · 服务端可能仍在处理',
  format: '响应格式不符',
}

/** The phrase for an HTTP status, when the body named no code. */
export const ERROR_STATUSES: Readonly<Record<string, string>> = {
  '400': '请求内容不合法',
  '401': '会话已失效',
  '403': '权限不足',
  '404': '对象不存在',
  '405': '不支持此操作',
  '409': '有冲突 · 刷新后再试',
  '413': '内容过大',
  '422': '对端拒绝执行',
  '429': '请求过多 · 稍后再试',
  '500': '控制台内部错误',
  '501': '这台控制台未开启此功能',
  '502': '节点不可达',
  '503': '暂时不可用',
  '504': '连接超时',
}

/** When nothing at all is known. */
export const ERROR_FALLBACK = '操作没有完成'

/**
 * The punctuation and marks no visible string may carry. The same set the
 * copy gates test for, plus the ones a developer sentence brings with it.
 */
export const UNCLEAN_SOURCE = '[。，、；：！!;`"\\n\\r\\t]|https?://'

/** A run of CJK, which every sentence written for this page contains. */
const CJK_SOURCE = '[\\u3400-\\u9fff]'

/** Longest message shown as it came; anything longer is a paragraph. */
export const MAX_CLEAN_LENGTH = 48

/** Longest leading noun kept in front of a phrase. */
const MAX_LEAD_LENGTH = 12

const PROTOCOL_CODE_SOURCE = '\\bE_[A-Z][A-Z_]+\\b'

const UNCLEAN = new RegExp(UNCLEAN_SOURCE)
const CJK = new RegExp(CJK_SOURCE)
const PROTOCOL_CODE = new RegExp(PROTOCOL_CODE_SOURCE)
const PATTERNS = ERROR_PATTERNS.map(
  ([source, phrase]) => [new RegExp(source, 'i'), phrase] as const,
)

/** True when `text` keeps the copy rules and reads as a sentence for a person. */
export function isCleanLine(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= MAX_CLEAN_LENGTH &&
    CJK.test(text) &&
    !UNCLEAN.test(text)
  )
}

/**
 * A table's own entry, never one inherited from `Object.prototype`: a code of
 * `constructor` from a broken port must not print a function's source.
 */
function ownPhrase(
  table: Readonly<Record<string, string>>,
  key: string | number | undefined,
): string | undefined {
  if (key === undefined) return undefined
  const name = String(key)
  return Object.hasOwn(table, name) ? table[name] : undefined
}

/** The line for the page, and the original for 详情. */
export function humanizeError(input: ErrorInput): HumanError {
  const raw = (input.message ?? '').trim()
  const parts = raw.split(' · ')
  const head = parts[0] ?? ''
  const lead =
    parts.length > 1 &&
    head.length <= MAX_LEAD_LENGTH &&
    isCleanLine(head) &&
    !PROTOCOL_CODE.test(head)
      ? head
      : ''
  let phrase = ''
  for (const [pattern, words] of PATTERNS) {
    if (pattern.test(raw)) {
      phrase = words
      break
    }
  }
  if (phrase === '' && isCleanLine(raw)) {
    return { text: raw, detail: '' }
  }
  if (phrase === '') {
    phrase =
      ownPhrase(ERROR_CODES, input.code) ??
      ownPhrase(ERROR_STATUSES, input.status) ??
      ERROR_FALLBACK
  }
  let text = lead === '' || lead === phrase ? phrase : `${lead} · ${phrase}`
  const protocol = PROTOCOL_CODE.exec(raw)?.[0]
  if (protocol !== undefined && !text.includes(protocol)) {
    text = `${text} · ${protocol}`
  }
  return { text, detail: raw === text ? '' : raw }
}

/**
 * The three tables and the shared constants as one JSON object, for the
 * browser runtime to rebuild {@link humanizeError} from (`assets/client.ts`).
 */
export function errorTableJson(): string {
  return JSON.stringify({
    patterns: ERROR_PATTERNS,
    codes: ERROR_CODES,
    statuses: ERROR_STATUSES,
    fallback: ERROR_FALLBACK,
    unclean: UNCLEAN_SOURCE,
    cjk: CJK_SOURCE,
    protocol: PROTOCOL_CODE_SOURCE,
    maxClean: MAX_CLEAN_LENGTH,
    maxLead: MAX_LEAD_LENGTH,
  })
}
