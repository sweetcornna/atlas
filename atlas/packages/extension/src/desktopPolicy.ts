// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared closed surface. The host imports only this data, never omp runtime. */
export interface DesktopResource {
  readonly resourceId: string
  readonly resourceEpoch: number
  readonly browser: boolean
  readonly computer: boolean
  readonly cdpUrl: string | null
  readonly display: string | null
  readonly xauthority: string | null
  readonly downloads: string
  readonly tab: string
}
export const DESKTOP_FIELDS = {
  qianmo_browser_tabs: {},
  qianmo_browser_screenshot: { tab: 'string' },
  qianmo_browser_read_page: { tab: 'string' },
  qianmo_browser_find: { tab: 'string', selector: 'string' },
  qianmo_browser_navigate: { tab: 'string', url: 'string' },
  qianmo_browser_click: { tab: 'string', selector: 'string' },
  qianmo_browser_type: { tab: 'string', selector: 'string', text: 'string' },
  qianmo_browser_press: { tab: 'string', selector: 'string', key: 'string' },
  qianmo_browser_scroll: { tab: 'string', x: 'number', y: 'number' },
  qianmo_computer_screenshot: {},
  qianmo_computer_click: { x: 'number', y: 'number' },
  qianmo_computer_type: { text: 'string' },
  qianmo_computer_key: { key: 'string' },
  qianmo_computer_scroll: {
    x: 'number',
    y: 'number',
    dx: 'number',
    dy: 'number',
  },
} as const
export type DesktopTool = keyof typeof DESKTOP_FIELDS
export function isDesktopTool(name: string): name is DesktopTool {
  return Object.hasOwn(DESKTOP_FIELDS, name)
}
export function desktopTools(
  resource?: Pick<DesktopResource, 'browser' | 'computer'>,
): DesktopTool[] {
  return (Object.keys(DESKTOP_FIELDS) as DesktopTool[]).filter(name =>
    name.startsWith('qianmo_browser_') ? resource?.browser : resource?.computer,
  )
}
/**
 * What the host answers one gate phase with. A refusal carries a reason the
 * model and the operator can read; it never carries argument text.
 */
export type DesktopDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }
/** The stable prefix of the tool error when the host refuses a lease. */
export const DESKTOP_LEASE_REFUSED = 'Desktop lease refused'
/**
 * The tool-call id is minted by the provider, not by us: OpenAI Responses
 * gives `call_…|fc_…`, Anthropic `toolu_…`, chat-completions gateways their
 * own. The host only needs a bounded printable key to bind a lease to.
 */
export function isDesktopInvocationId(id: unknown): id is string {
  return typeof id === 'string' && /^[\x21-\x7e]{1,512}$/.test(id)
}
/**
 * Why this caller cannot use this tool on this resource right now, in words
 * that say how to switch it on; `undefined` when it can.
 */
export function desktopUnavailable(
  name: DesktopTool,
  resource: Pick<DesktopResource, 'browser' | 'computer'> | undefined,
  agentKind: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (agentKind !== 'main')
    return '只有节点的主智能体能用专属浏览器和专属电脑，子智能体不能调用'
  if (desktopTools(resource).includes(name)) return undefined
  if (name.startsWith('qianmo_browser_'))
    return '专属浏览器没有开启或已停用：请在控制台「云端电脑」页为这个智能体打开「专属浏览器」后重试'
  return platform === 'linux'
    ? '专属电脑没有开启或已停用：请在控制台「云端电脑」页为这个智能体打开「专属电脑」（节点需装有 Xvfb 与 xauth）后重试'
    : `专属电脑只在 Linux 节点上提供（需要 Xvfb 与 xauth）；本节点是 ${platform}，只能开专属浏览器`
}
/** Read the host's answer to a lease reservation; anything unclear refuses. */
export function desktopLeaseAnswer(value: string | undefined): DesktopDecision {
  if (value === undefined)
    return {
      ok: false,
      reason: '节点没有应答租约请求（等待超时，或宿主没有接入授权通道）',
    }
  try {
    const answer = JSON.parse(value) as { ok?: unknown; reason?: unknown }
    if (answer?.ok === true) return { ok: true }
    if (
      answer?.ok === false &&
      typeof answer.reason === 'string' &&
      answer.reason.length > 0
    )
      return { ok: false, reason: answer.reason.slice(0, 500) }
  } catch {
    /* Malformed answers refuse below. */
  }
  return { ok: false, reason: '节点返回的租约应答无法识别' }
}
/** What every runtime's tool list says about one desktop tool. */
export function desktopToolDescription(name: DesktopTool): string {
  return `Private resource ${desktopOp(name)}. Obtain the current tab handle from qianmo_browser_tabs. Changes require one operator approval.`
}
/** The JSON schema of one desktop tool's arguments, for MCP tool lists. */
export function desktopToolSchema(name: DesktopTool): Record<string, unknown> {
  const fields: Readonly<Record<string, string>> = DESKTOP_FIELDS[name]
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(fields).map(([key, kind]) => [
        key,
        kind === 'number'
          ? { type: 'number', minimum: -10000, maximum: 10000 }
          : { type: 'string', maxLength: key === 'text' ? 16000 : 2000 },
      ]),
    ),
    required: Object.keys(fields),
    additionalProperties: false,
  }
}
export function desktopObservation(name: DesktopTool): boolean {
  return ['tabs', 'screenshot', 'read_page', 'find'].includes(desktopOp(name))
}
export function desktopOp(name: DesktopTool): string {
  return name.replace(/^qianmo_(browser|computer)_/, '')
}
/**
 * The base's intent tracing adds this field (`INTENT_FIELD` in pi-wire) to
 * every tool schema, so the model sends it with each call. It is free text for
 * the transcript, never an action argument: accept it only as a bounded string
 * and leave it out of the canonical arguments the host authorizes.
 */
export const DESKTOP_INTENT_FIELD = 'i'
export function desktopArgs(
  name: DesktopTool,
  raw: unknown,
): Record<string, string | number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Desktop arguments must be an object')
  const fields: Readonly<Record<string, string>> = DESKTOP_FIELDS[name]
  const input = { ...(raw as Record<string, unknown>) }
  if (Object.hasOwn(input, DESKTOP_INTENT_FIELD)) {
    const intent = input[DESKTOP_INTENT_FIELD]
    if (
      typeof intent !== 'string' ||
      intent.length > 2000 ||
      intent.includes('\0')
    )
      throw new Error('Invalid desktop argument')
    delete input[DESKTOP_INTENT_FIELD]
  }
  if (
    Object.keys(input).length !== Object.keys(fields).length ||
    Object.keys(input).some(key => !Object.hasOwn(fields, key))
  )
    throw new Error('Unknown or missing desktop argument')
  const out: Record<string, string | number> = {}
  for (const key of Object.keys(fields).sort()) {
    const value = input[key]
    if (
      typeof value !== fields[key] ||
      (typeof value === 'number' &&
        (!Number.isFinite(value) || Math.abs(value) > 10000)) ||
      (typeof value === 'string' &&
        (value.length > (key === 'text' ? 16000 : 2000) ||
          value.includes('\0')))
    )
      throw new Error('Invalid desktop argument')
    out[key] = value as string | number
  }
  if (name === 'qianmo_browser_navigate') {
    const url = new URL(String(out.url))
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        'Only HTTP(S) navigation without credentials is supported',
      )
    out.url = url.href
  }
  if (
    'selector' in out &&
    (!out.selector ||
      /^(?:xpath|text|aria|pierce)\//.test(String(out.selector)))
  )
    throw new Error('Use a nonempty CSS selector')
  // Native keyboard shortcuts can start programs, paste files or escape the
  // private display. Keep the first surface to ordinary navigation keys.
  if (
    'key' in out &&
    !/^(?:Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(
      String(out.key),
    )
  )
    throw new Error('Unsupported key')
  return out
}
