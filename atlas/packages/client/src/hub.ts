// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client's calls to a hub (clients.md §3): pairing, tickets and the
 * device check.
 *
 * Every call follows no redirect and sends no cookie; the device token rides
 * as a Bearer and nowhere else. A redirect is refused rather than followed so
 * a hub, or anything in front of it, cannot point the token at another host.
 */

/** A failure the user can act on; `exitCode` 2 means the command line was wrong. */
export class ClientError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'ClientError'
    this.exitCode = exitCode
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const DEVICE_ID = /^d-[a-z2-7]{12}$/
export const DEVICE_TOKEN = /^qmd_[A-Za-z0-9_-]{43}$/
const TICKET = /^qmt_[A-Za-z0-9_-]{43}$/
const TICKET_ID = /^t-[a-z2-7]{12}$/
const TIMEOUT_MS = 30_000

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The hub's base URL, without a trailing slash. `https`, or `http` on
 * loopback only (an SSH tunnel): the device token rides on every request,
 * and plain HTTP to another machine would hand it to the network.
 */
export function parseHubUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ClientError(`中枢地址不是 URL：${raw}`, 2)
  }
  const loopback = LOOPBACK.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new ClientError(
      '中枢地址必须是 https://…（只有 127.0.0.1 / localhost 可以用 http://）',
      2,
    )
  if (url.username || url.password || url.search || url.hash)
    throw new ClientError('中枢地址里不能带用户名、密码或查询串', 2)
  return url.toString().replace(/\/+$/, '')
}

async function call(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ClientError(`连不上中枢（${reason}）`)
  }
}

/** The `message` of a console error body, if the hub sent one. */
async function messageOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'message' in body.error &&
      typeof body.error.message === 'string'
    )
      return body.error.message
  } catch {}
  return null
}

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
})

export interface PairedDevice {
  readonly deviceId: string
  readonly name: string
  readonly token: string
}

/** `POST /v0/handoff/pair`: trade a pairing code for this computer's device token. */
export async function pairDevice(
  hub: string,
  input: {
    readonly code: string
    readonly name: string
    readonly platform: string
  },
  fetchImpl: Fetch = fetch,
): Promise<PairedDevice> {
  const response = await call(fetchImpl, `${hub}/v0/handoff/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (response.status === 404 || response.status === 501)
    throw new ClientError('这台中枢没有设备配对（要开个人账号或接力）')
  if (response.status === 429) throw new ClientError('配对尝试过多，稍后再试')
  if (!response.ok) {
    const message = await messageOf(response)
    throw new ClientError(
      message === null
        ? `配对失败（HTTP ${response.status}）`
        : `配对失败：${message}`,
    )
  }
  const value: unknown = await response.json()
  if (
    typeof value !== 'object' ||
    value === null ||
    !('deviceId' in value) ||
    typeof value.deviceId !== 'string' ||
    !DEVICE_ID.test(value.deviceId) ||
    !('token' in value) ||
    typeof value.token !== 'string' ||
    !DEVICE_TOKEN.test(value.token) ||
    !('name' in value) ||
    typeof value.name !== 'string'
  )
    throw new ClientError('中枢返回的设备信息不合法')
  return { deviceId: value.deviceId, name: value.name, token: value.token }
}

export type TicketOutcome =
  | {
      readonly kind: 'ticket'
      readonly id: string
      readonly ticket: string
      readonly expiresAt: number
    }
  /**
   * No ticket from this hub: it has no accounts, predates the client door
   * (both answer a device token there with 404 or 403), or the device has no
   * account to sign in. `reason` is the hub's own sentence when it gave one.
   */
  | { readonly kind: 'unsupported'; readonly reason?: string }

const REVOKED = '这台设备的令牌无效或已被吊销，请重新 qmo sign-in'

/** `POST /v0/client/tickets`: a one-time ticket for the window. */
export async function requestTicket(
  hub: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<TicketOutcome> {
  const response = await call(fetchImpl, `${hub}/v0/client/tickets`, {
    method: 'POST',
    headers: bearer(token),
  })
  if (response.status === 404 || response.status === 501)
    return { kind: 'unsupported' }
  if (response.status === 401) throw new ClientError(REVOKED)
  if (response.status === 403) {
    const reason = await messageOf(response)
    return reason === null
      ? { kind: 'unsupported' }
      : { kind: 'unsupported', reason }
  }
  if (response.status !== 201) {
    const message = await messageOf(response)
    throw new ClientError(
      message ?? `中枢没有给出票据（HTTP ${response.status}）`,
    )
  }
  const value: unknown = await response.json()
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !TICKET_ID.test(value.id) ||
    !('ticket' in value) ||
    typeof value.ticket !== 'string' ||
    !TICKET.test(value.ticket) ||
    !('expiresAt' in value) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new ClientError('中枢返回的票据不合法')
  return {
    kind: 'ticket',
    id: value.id,
    ticket: value.ticket,
    expiresAt: Date.parse(value.expiresAt),
  }
}

/** Where the window goes to spend `ticket`. */
export function enterUrl(hub: string, ticket: string): string {
  return `${hub}/client/enter?ticket=${encodeURIComponent(ticket)}`
}

export type TicketState = 'pending' | 'used' | 'expired' | 'unknown'

/** `GET /v0/client/tickets/<id>`. */
export async function ticketState(
  hub: string,
  token: string,
  id: string,
  fetchImpl: Fetch = fetch,
): Promise<TicketState> {
  const response = await call(
    fetchImpl,
    `${hub}/v0/client/tickets/${encodeURIComponent(id)}`,
    { headers: bearer(token) },
  )
  if (response.status === 401) throw new ClientError(REVOKED)
  if (!response.ok) return 'unknown'
  const value: unknown = await response.json()
  if (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    (value.state === 'pending' ||
      value.state === 'used' ||
      value.state === 'expired')
  )
    return value.state
  return 'unknown'
}

export type DeviceStatus = 'active' | 'revoked' | 'unsupported' | 'unreachable'

/** `GET /v0/client/device`: whether the hub still knows this device. */
export async function deviceStatus(
  hub: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<DeviceStatus> {
  let response: Response
  try {
    response = await call(fetchImpl, `${hub}/v0/client/device`, {
      headers: bearer(token),
    })
  } catch {
    return 'unreachable'
  }
  if (response.ok) return 'active'
  if (response.status === 401) return 'revoked'
  if (response.status === 404 || response.status === 501) return 'unsupported'
  return 'unreachable'
}

/** `DELETE /v0/client/device`: the device revokes itself on sign-out. */
export async function revokeDevice(
  hub: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<'revoked' | 'unsupported' | 'failed'> {
  let response: Response
  try {
    response = await call(fetchImpl, `${hub}/v0/client/device`, {
      method: 'DELETE',
      headers: bearer(token),
    })
  } catch {
    return 'failed'
  }
  if (response.status === 204 || response.status === 401) return 'revoked'
  if (response.status === 404 || response.status === 501) return 'unsupported'
  return 'failed'
}
