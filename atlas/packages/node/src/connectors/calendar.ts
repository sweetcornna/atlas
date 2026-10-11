// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LIMITS } from '@qianmo/protocol'
import { OutboundPolicy, boundedText } from '../commands/outboundPolicy.js'

/** Notification fixture exceptions cannot downgrade credentialed calendar protocols. */
export function calendarHttpsUrl(policy: OutboundPolicy, raw: string): URL {
  const url = policy.url(raw)
  if (url.protocol !== 'https:') throw new Error('日历连接只允许 HTTPS')
  return url
}

export interface CalendarEvent {
  readonly id: string
  readonly title: string
  readonly start: string
  readonly end: string
  readonly location: string
  readonly notes: string
  readonly recurring: boolean
}
export interface CalendarResult {
  readonly events: readonly CalendarEvent[]
  readonly warnings: readonly string[]
}
export interface EventDraft {
  readonly title: string
  readonly start: string
  readonly end: string
  readonly location?: string
  readonly notes?: string
}
export function range(
  from: unknown,
  to: unknown,
): { from: string; to: string } {
  const date = (v: unknown): string => {
    if (
      typeof v !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(
        v,
      ) ||
      !Number.isFinite(Date.parse(v))
    )
      throw new Error('日程时间需要带时区的 ISO 时间')
    return new Date(v).toISOString()
  }
  const result = { from: date(from), to: date(to) }
  if (result.to <= result.from) throw new Error('日程结束必须晚于开始')
  return result
}
function icsTime(raw: string): string | null {
  if (/^\d{8}$/.test(raw))
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00.000Z`
  if (!/^\d{8}T\d{6}Z?$/.test(raw)) return null
  const value = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}.000Z`
  return Number.isFinite(Date.parse(value)) ? value : null
}
function unescapeIcs(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_raw: string, char: string) =>
    char.toLowerCase() === 'n' ? '\n' : char,
  )
}
export function parseIcs(
  raw: string,
  from: string,
  to: string,
): CalendarResult {
  const bounds = range(from, to)
  if (!raw.includes('BEGIN:VCALENDAR') || !raw.includes('END:VCALENDAR'))
    throw new Error('ICS 内容无效')
  for (const line of raw.split(/\r?\n/))
    if (Buffer.byteLength(line) > LIMITS.connectorLineBytes)
      throw new Error('ICS 行超过上限')
  const events: CalendarEvent[] = [],
    warnings = new Set<string>()
  let fields: Record<string, string> | undefined,
    nested = 0,
    timeZone = false
  const lines = raw.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  for (const line of lines) {
    if (Buffer.byteLength(line) > LIMITS.connectorLineBytes)
      throw new Error('ICS 展开行超过上限')
    if (line === 'BEGIN:VEVENT') {
      if (fields) throw new Error('ICS 事件结构无效')
      fields = {}
      nested = 0
      timeZone = false
      continue
    }
    if (!fields) continue
    if (line.startsWith('BEGIN:')) {
      nested++
      continue
    }
    if (line === 'END:VEVENT') {
      const recurring = fields['RRULE'] !== undefined
      if (recurring)
        warnings.add('RRULE 未展开；仅返回原始事件，时间段中的重复实例可能缺失')
      if (timeZone) {
        warnings.add('带 TZID 的本地时间未解析，该事件已省略')
        fields = undefined
        continue
      }
      const start = icsTime(fields['DTSTART'] ?? ''),
        end = icsTime(fields['DTEND'] ?? '')
      if (
        start &&
        end &&
        end > start &&
        start < bounds.to &&
        end > bounds.from
      ) {
        if (events.length < LIMITS.connectorResults)
          events.push({
            id: fields['UID'] ?? '',
            title: unescapeIcs(fields['SUMMARY'] ?? ''),
            start,
            end,
            location: unescapeIcs(fields['LOCATION'] ?? ''),
            notes: unescapeIcs(fields['DESCRIPTION'] ?? ''),
            recurring,
          })
        else warnings.add('结果已限制为前 50 条')
      }
      fields = undefined
      continue
    }
    if (line.startsWith('END:')) {
      nested--
      continue
    }
    if (nested) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const left = line.slice(0, colon),
      name = left.split(';')[0]!.toUpperCase()
    if (/^DT(?:START|END)$/.test(name) && /;TZID=/i.test(left)) timeZone = true
    if (
      /^DT(?:START|END)$/.test(name) &&
      /^\d{8}T\d{6}$/.test(line.slice(colon + 1))
    )
      warnings.add('无时区的浮动时间按 UTC 显示')
    fields[name] = line.slice(colon + 1)
  }
  if (fields) throw new Error('ICS 事件未闭合')
  while (
    Buffer.byteLength(JSON.stringify(events)) > LIMITS.connectorResultBytes
  ) {
    events.pop()
    warnings.add('结果已按控制链路字节预算截断')
  }
  return { events, warnings: [...warnings] }
}
function escapeXml(raw: string): string {
  return raw.replace(
    /[&<>"']/g,
    v =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[v]!,
  )
}
function decodeXml(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (_v: string, name: string) =>
        name[0] === '#'
          ? String.fromCodePoint(
              Number.parseInt(
                name.slice(name[1] === 'x' ? 2 : 1),
                name[1] === 'x' ? 16 : 10,
              ),
            )
          : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name]!,
    )
}
function elements(raw: string, local: string): string[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw))
    throw new Error('CalDAV XML 不允许实体声明')
  return [
    ...raw.matchAll(
      new RegExp(
        `<((?:[\\w-]+:)?${local})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`,
        'gi',
      ),
    ),
  ].map(v => v[2]!)
}
function stamp(value: string): string {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}
function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/[,;]/g, v => `\\${v}`)
}
function fold(value: string): string {
  const result: string[] = []
  let part = ''
  for (const char of value) {
    if (Buffer.byteLength(part + char) > 73) {
      result.push(part)
      part = ' '
    }
    part += char
  }
  result.push(part)
  return result.join('\r\n')
}
export function createIcs(id: string, draft: EventDraft): string {
  const times = range(draft.start, draft.end)
  for (const v of [draft.title, draft.location ?? '', draft.notes ?? ''])
    if (
      typeof v !== 'string' ||
      Buffer.byteLength(v) > LIMITS.connectorTextBytes ||
      v.includes('\0')
    )
      throw new Error('日程内容无效')
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Qianmo//P25//EN',
    'BEGIN:VEVENT',
    `UID:${id}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(times.from)}`,
    `DTEND:${stamp(times.to)}`,
    `SUMMARY:${escapeIcs(draft.title)}`,
    `LOCATION:${escapeIcs(draft.location ?? '')}`,
    `DESCRIPTION:${escapeIcs(draft.notes ?? '')}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]
    .map(fold)
    .join('\r\n')
}

export class CaldavClient {
  readonly #policy: OutboundPolicy
  readonly #root: URL
  readonly #authorization: string
  constructor(
    policy: OutboundPolicy,
    raw: string,
    username: string,
    password: string,
  ) {
    this.#policy = policy
    this.#root = calendarHttpsUrl(policy, raw)
    this.#authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }
  #href(raw: string, base = this.#root): URL {
    const target = this.#policy.url(
      new URL(decodeXml(raw).trim(), base).toString(),
    )
    if (target.origin !== this.#root.origin)
      throw new Error('CalDAV 跨源资源被拒绝')
    return target
  }
  async #request(
    url: URL,
    method: string,
    body: string,
    headers: Record<string, string> = {},
    beforeDispatch?: () => void,
  ): Promise<string> {
    const response = await this.#policy.request(
      url.toString(),
      {
        method,
        body,
        headers: {
          Authorization: this.#authorization,
          'Content-Type':
            method === 'PUT'
              ? 'text/calendar; charset=utf-8'
              : 'application/xml; charset=utf-8',
          ...headers,
        },
        signal: AbortSignal.timeout(LIMITS.connectorTimeoutMs),
      },
      true,
      beforeDispatch,
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('CalDAV 请求失败')
    }
    return boundedText(response)
  }
  async discover(): Promise<URL> {
    const propfind = (url: URL, prop: string, depth = '0') =>
      this.#request(
        url,
        'PROPFIND',
        `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${prop}</d:prop></d:propfind>`,
        { Depth: depth },
      )
    let root = this.#root
    let document = await propfind(
      root,
      '<d:current-user-principal/><c:calendar-home-set/><d:resourcetype/>',
    )
    const principal = elements(
      elements(document, 'current-user-principal')[0] ?? '',
      'href',
    )[0]
    if (principal) {
      root = this.#href(principal)
      document = await propfind(root, '<c:calendar-home-set/><d:resourcetype/>')
    }
    const home = elements(
      elements(document, 'calendar-home-set')[0] ?? '',
      'href',
    )[0]
    if (home) root = this.#href(home, root)
    document = await propfind(root, '<d:resourcetype/><d:displayname/>', '1')
    for (const response of elements(document, 'response')) {
      if (
        !/<(?:[\w-]+:)?calendar\s*\/?\s*>/i.test(
          elements(response, 'resourcetype').join(''),
        )
      )
        continue
      const href = elements(response, 'href')[0]
      if (href) return this.#href(href, root)
    }
    throw new Error('CalDAV 未发现日历，请提供日历集合地址')
  }
  async events(from: string, to: string): Promise<CalendarResult> {
    const times = range(from, to),
      calendar = await this.discover()
    const xml = await this.#request(
      calendar,
      'REPORT',
      `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${escapeXml(stamp(times.from))}" end="${escapeXml(stamp(times.to))}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      { Depth: '1' },
    )
    const events: CalendarEvent[] = [],
      warnings = new Set<string>()
    for (const data of elements(xml, 'calendar-data')) {
      const parsed = parseIcs(decodeXml(data), times.from, times.to)
      events.push(...parsed.events)
      for (const warning of parsed.warnings) warnings.add(warning)
    }
    if (events.length > LIMITS.connectorResults)
      warnings.add('结果已限制为前 50 条')
    const bounded = events.slice(0, LIMITS.connectorResults)
    while (
      Buffer.byteLength(JSON.stringify(bounded)) > LIMITS.connectorResultBytes
    ) {
      bounded.pop()
      warnings.add('结果已按控制链路字节预算截断')
    }
    return { events: bounded, warnings: [...warnings] }
  }
  async create(
    id: string,
    draft: EventDraft,
    beforeSend: () => void = () => {},
  ): Promise<{ id: string }> {
    const calendar = await this.discover()
    const target = this.#href(
      `${calendar.toString().replace(/\/?$/, '/')}${encodeURIComponent(id)}.ics`,
    )
    beforeSend()
    await this.#request(
      target,
      'PUT',
      createIcs(id, draft),
      {
        'If-None-Match': '*',
      },
      beforeSend,
    )
    return { id }
  }
}
export async function icsEvents(
  policy: OutboundPolicy,
  url: string,
  from: string,
  to: string,
): Promise<CalendarResult> {
  range(from, to)
  calendarHttpsUrl(policy, url)
  const response = await policy.request(url, {
    signal: AbortSignal.timeout(LIMITS.connectorTimeoutMs),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('ICS 请求失败')
  }
  return parseIcs(await boundedText(response), from, to)
}
