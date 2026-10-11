// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AuditTrail, AuditSource } from '@qianmo/audit'
import { acquireExclusiveLock, type ExclusiveLock } from '@qianmo/handoff'
import { LIMITS, parseAddress, type ControlOutcome } from '@qianmo/protocol'
import type {
  ConnectorDraft,
  ConnectorView,
  ConnectorPresetView,
  ConnectorCallView,
  ConnectorsPort,
  ConnectorsSnapshot,
  DirectionActor,
  ConsoleResult,
  TenantPort,
} from '@qianmo/console'
import { writePrivateFileAtomic } from '../providers/store.js'
import { ConnectorVault, privateText } from '../connectors/secrets.js'
import { ImapClient, type MailSettings } from '../connectors/imap.js'
import { SmtpClient, mailData } from '../connectors/smtp.js'
import { mailbox, headerValue } from '../connectors/wire.js'
import {
  CaldavClient,
  calendarHttpsUrl,
  icsEvents,
  createIcs,
  range,
  type EventDraft,
} from '../connectors/calendar.js'
import { OutboundPolicy } from './outboundPolicy.js'
import type { HubCallHandler } from './consoleControl.js'

/** Only confirmed official values are prefilled. See console.md for dated sources. */
export const CONNECTOR_PRESETS: readonly ConnectorPresetView[] = [
  {
    id: 'qq',
    kind: 'mail',
    name: 'QQ 邮箱',
    defaults: {},
    hint: '开启 IMAP 并生成授权码；官方服务器页面未能核实，请手填',
    evaluated: false,
  },
  {
    id: '163',
    kind: 'mail',
    name: '163 邮箱',
    defaults: {},
    hint: '开启 IMAP 并生成授权码；官方页面不可访问，请手填',
    evaluated: false,
  },
  {
    id: 'gmail',
    kind: 'mail',
    name: 'Gmail（应用专用密码）',
    defaults: {
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpTls: 'smtps',
    },
    hint: '启用两步验证并生成应用专用密码；并非所有账号都可用（Google 官方，2026-10-11）',
    evaluated: false,
  },
  {
    id: 'outlook',
    kind: 'mail',
    name: 'Outlook',
    defaults: {
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      smtpHost: 'smtp-mail.outlook.com',
      smtpPort: 587,
      smtpTls: 'starttls',
    },
    hint: 'Outlook.com 要求 OAuth2；本轮口令客户端不支持（Microsoft 官方，2026-10-11）',
    evaluated: false,
  },
  {
    id: 'custom-mail',
    kind: 'mail',
    name: '自定义邮箱',
    defaults: { imapPort: 993, smtpPort: 465, smtpTls: 'smtps' },
    hint: '向服务管理员确认 IMAPS/SMTP 地址并提供应用口令',
    evaluated: false,
  },
  {
    id: 'icloud',
    kind: 'calendar',
    name: 'iCloud 日历',
    defaults: {},
    hint: '生成应用专用密码并手填日历 CalDAV 地址；官方未确认统一入口',
    evaluated: false,
  },
  {
    id: 'custom-caldav',
    kind: 'calendar',
    name: '自定义 CalDAV',
    defaults: {},
    hint: '填写 CalDAV 日历集合或发现入口 HTTPS 地址与账号口令',
    evaluated: false,
  },
  {
    id: 'ics',
    kind: 'calendar',
    name: 'ICS 订阅（只读）',
    defaults: {},
    hint: '将完整订阅 URL 填入秘密字段；不展开重复规则',
    evaluated: false,
  },
]
const settingsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
)
const secretSchema = z
  .object({
    revision: z.number().int().positive(),
    slot: z.enum(['password', 'ics-url']),
    at: z.number(),
    wrapped: z.string(),
    body: z.string(),
  })
  .strict()
const recordSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['mail', 'calendar']),
    preset: z.string(),
    settings: settingsSchema,
    agents: z.array(z.string()),
    tenant: z.string().nullable(),
    revision: z.number().int().positive(),
    createdAt: z.number(),
    createdBy: z.string(),
    lastProbe: z
      .object({ at: z.number(), ok: z.boolean(), detail: z.string() })
      .nullable(),
    secret: secretSchema,
  })
  .strict()
type ConnectorRecord = z.infer<typeof recordSchema>
const draftSchema = z
  .object({
    id: z.string().optional(),
    tenant: z.string().optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(v => ![...v].some(char => char.charCodeAt(0) < 32)),
    kind: z.enum(['mail', 'calendar']),
    preset: z.string(),
    settings: settingsSchema,
    secret: z.string().min(1).max(8192).optional(),
    agents: z.array(z.string()).max(100),
  })
  .strict()
const bookSchema = z
  .object({
    v: z.literal(1),
    connectors: z.array(recordSchema),
    operations: z.array(z.string()),
  })
  .strict()
export interface ConnectorApprovalCall {
  readonly requestId: string
  readonly node: string
  readonly agent: string
  readonly contextId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
}
export interface ConsoleConnectorsOptions {
  readonly directory: string
  readonly policy?: OutboundPolicy
  readonly agents: () => Promise<readonly string[]>
  readonly tenancy?: TenantPort
  readonly approvals?: {
    consumeConnector(input: ConnectorApprovalCall): boolean
  }
  readonly now?: () => number
}
const fail = <T>(
  code: 'invalid' | 'not_found' | 'refused' | 'unreachable',
  message: string,
): ConsoleResult<T> => ({ ok: false, failure: { code, message } })
const refused = (message = '连接或调用权限无效'): ControlOutcome => ({
  ok: false,
  code: 'refused',
  message,
})
const idPattern = /^c-[0-9a-f-]{36}$/
const operationPattern = /^[0-9a-f-]{36}$/
function accountHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function mask(value: string): string {
  const [user, domain] = value.split('@')
  return `${user?.slice(0, 2) ?? ''}***${domain ? `@${domain}` : ''}`
}
function toolName(op: string): string {
  return op === 'mail.send' ? 'qianmo_mail_send' : 'qianmo_calendar_create'
}

export class ConsoleConnectors implements ConnectorsPort {
  readonly #options: ConsoleConnectorsOptions
  readonly #path: string
  readonly #policy: OutboundPolicy
  readonly #vault: ConnectorVault
  readonly #audit: AuditTrail
  readonly #lock: ExclusiveLock
  readonly #rows = new Map<string, ConnectorRecord>()
  readonly #operations = new Set<string>()
  readonly #recent: ConnectorCallView[] = []
  #closed = false
  readonly #now: () => number
  constructor(options: ConsoleConnectorsOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#policy = options.policy ?? new OutboundPolicy()
    this.#path = path.join(options.directory, 'connectors.json')
    this.#lock = acquireExclusiveLock(`${this.#path}.lock`)
    try {
      const raw = privateText(this.#path)
      if (raw !== undefined) {
        const book = bookSchema.parse(JSON.parse(raw))
        for (const row of book.connectors) {
          if (!idPattern.test(row.id) || this.#rows.has(row.id))
            throw new Error('连接簿无效')
          this.#rows.set(row.id, row)
        }
        for (const op of book.operations) this.#operations.add(op)
      }
      this.#vault = new ConnectorVault(
        path.join(options.directory, 'keys', 'connector-master.key'),
        [...this.#rows.values()].map(row => ({
          id: row.id,
          secret: row.secret,
        })),
      )
      this.#audit = new AuditTrail(
        path.join(options.directory, 'connector-audit.ndjson'),
      )
    } catch {
      this.#lock.release()
      throw new Error('应用连接存储不可用')
    }
  }
  #persist(rows = this.#rows, operations = this.#operations): void {
    writePrivateFileAtomic(
      this.#path,
      JSON.stringify({
        v: 1,
        connectors: [...rows.values()],
        operations: [...operations],
      }),
    )
  }
  #view(row: ConnectorRecord): ConnectorView {
    const summary: Record<string, string> = {}
    for (const key of ['imapHost', 'smtpHost'])
      if (typeof row.settings[key] === 'string')
        summary[key] = String(row.settings[key])
    if (typeof row.settings['caldavUrl'] === 'string')
      summary['host'] = new URL(row.settings['caldavUrl']).hostname
    if (row.preset === 'ics')
      summary['host'] = new URL(
        this.#vault.reveal(row.id, row.secret, row.revision),
      ).hostname
    if (typeof row.settings['username'] === 'string')
      summary['account'] = mask(row.settings['username'])
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      preset: row.preset,
      summary,
      readOnly: row.preset === 'ics',
      secretSet: true,
      secretSetAt: row.secret.at,
      agents: row.agents,
      evaluated: false,
      lastProbe: row.lastProbe,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      tenant: row.tenant,
      revision: row.revision,
    }
  }
  async snapshot(): Promise<ConsoleResult<ConnectorsSnapshot>> {
    try {
      if (this.#closed) throw new Error()
      return {
        ok: true,
        value: {
          connectors: [...this.#rows.values()].map(row => this.#view(row)),
          presets: CONNECTOR_PRESETS,
          recent: [...this.#recent],
          agents: await this.#options.agents(),
        },
      }
    } catch {
      return fail('unreachable', '应用连接存储不可用')
    }
  }
  #tenant(
    draft: ConnectorDraft,
    actor: DirectionActor,
    existing?: ConnectorRecord,
  ): string | null | undefined {
    const config = this.#options.tenancy?.read().config
    if (!config) return draft.tenant === undefined ? null : undefined
    const platform = config.platformSubjects.includes(actor.subject)
    const owner = platform
      ? (draft.tenant ??
        existing?.tenant ??
        config.nodes.find(
          row => row.nodeId === parseAddress(draft.agents[0] ?? '')?.node,
        )?.tenant)
      : config.subjects.find(row => row.subject === actor.subject)?.tenant
    if (
      !owner ||
      !config.tenants.some(row => row.id === owner) ||
      (!platform && draft.tenant !== undefined && draft.tenant !== owner) ||
      (existing && existing.tenant !== owner)
    )
      return undefined
    if (
      draft.agents.some(
        address =>
          config.nodes.find(row => row.nodeId === parseAddress(address)?.node)
            ?.tenant !== owner,
      )
    )
      return undefined
    return owner
  }
  #writer(actor: DirectionActor, row?: ConnectorRecord): boolean {
    if (this.#closed || actor.role !== 'ops' || !actor.subject.startsWith('u:'))
      return false
    if (!row || !this.#options.tenancy) return true
    const config = this.#options.tenancy.read().config
    return (
      config.platformSubjects.includes(actor.subject) ||
      config.subjects.some(
        v => v.subject === actor.subject && v.tenant === row.tenant,
      )
    )
  }
  #settings(
    draft: ConnectorDraft,
    existing?: ConnectorRecord,
  ): Record<string, string | number | boolean> {
    const preset = CONNECTOR_PRESETS.find(
      v => v.id === draft.preset && v.kind === draft.kind,
    )
    if (!preset) throw new Error('预设无效')
    const settings = {
      ...preset.defaults,
      ...existing?.settings,
      ...draft.settings,
    }
    const keys =
      draft.kind === 'mail'
        ? [
            'imapHost',
            'imapPort',
            'smtpHost',
            'smtpPort',
            'smtpTls',
            'username',
          ]
        : draft.preset === 'ics'
          ? []
          : ['caldavUrl', 'username']
    if (Object.keys(settings).some(v => !keys.includes(v)))
      throw new Error('非秘密设置字段无效')
    if (draft.kind === 'mail') {
      for (const key of ['imapHost', 'smtpHost', 'username'])
        headerValue(settings[key])
      mailbox(settings['username'])
      settings['imapPort'] = Number(settings['imapPort'])
      settings['smtpPort'] = Number(settings['smtpPort'])
      if (!['smtps', 'starttls'].includes(String(settings['smtpTls'])))
        throw new Error('SMTP TLS 类型无效')
      this.#policy.checkEndpoint(
        'imaps',
        String(settings['imapHost']),
        Number(settings['imapPort']),
      )
      this.#policy.checkEndpoint(
        settings['smtpTls'] as 'smtps' | 'starttls',
        String(settings['smtpHost']),
        Number(settings['smtpPort']),
      )
    } else if (draft.preset !== 'ics') {
      headerValue(settings['username'])
      const url = calendarHttpsUrl(this.#policy, String(settings['caldavUrl']))
      if (url.search) throw new Error('CalDAV URL 不接受令牌参数')
      settings['caldavUrl'] = url.toString()
    }
    return settings
  }
  async save(
    raw: ConnectorDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ConnectorView>> {
    if (!this.#writer(actor)) return fail('refused', '连接凭据需要运维个人账号')
    try {
      const parsed = draftSchema.safeParse(raw)
      if (!parsed.success) return fail('invalid', '连接字段无效')
      const draft = parsed.data
      const existing =
        draft.id === undefined ? undefined : this.#rows.get(draft.id)
      if (
        draft.id !== undefined &&
        (!existing || !this.#writer(actor, existing))
      )
        return fail('not_found', '连接不存在')
      if (
        existing &&
        (draft.kind !== existing.kind || draft.preset !== existing.preset)
      )
        return fail('invalid', '修改连接种类或预设请新建连接')
      const agents = await this.#options.agents()
      if (
        draft.agents.some(v => !parseAddress(v) || !agents.includes(v)) ||
        new Set(draft.agents).size !== draft.agents.length
      )
        return fail('invalid', '授权智能体不在连接范围内')
      const tenant = this.#tenant(draft, actor, existing)
      if (tenant === undefined || !this.#writer(actor, existing))
        return fail('refused', '连接与智能体必须属于同一租户')
      // Synchronous commit after the registry await: concurrent edits cannot share a revision.
      if (existing && this.#rows.get(existing.id) !== existing)
        return fail('refused', '连接已变化，请重新保存')
      const settings = this.#settings(draft, existing)
      const id = existing?.id ?? `c-${crypto.randomUUID()}`,
        revision = (existing?.revision ?? 0) + 1
      const value =
        draft.secret ??
        (existing
          ? this.#vault.reveal(id, existing.secret, existing.revision)
          : undefined)
      if (!value) return fail('invalid', '新连接必须提供秘密字段')
      if (draft.preset === 'ics') calendarHttpsUrl(this.#policy, value)
      else headerValue(value)
      const secret = this.#vault.seal(
        id,
        draft.preset === 'ics' ? 'ics-url' : 'password',
        revision,
        value,
        draft.secret === undefined && existing
          ? existing.secret.at
          : this.#now(),
      )
      const row: ConnectorRecord = {
        id,
        name: draft.name,
        kind: draft.kind,
        preset: draft.preset,
        settings,
        agents: draft.agents,
        tenant,
        revision,
        secret,
        createdAt: existing?.createdAt ?? this.#now(),
        createdBy: existing?.createdBy ?? actor.subject,
        lastProbe: null,
      }
      const next = new Map(this.#rows)
      next.set(id, row)
      this.#persist(next)
      this.#rows.set(id, row)
      return { ok: true, value: this.#view(row) }
    } catch {
      return fail('invalid', '连接设置或秘密存储无效')
    }
  }
  async remove(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<null>> {
    try {
      const row = this.#rows.get(id)
      if (!this.#writer(actor))
        return fail('refused', '连接管理需要运维个人账号')
      if (!row || !this.#writer(actor, row))
        return fail('not_found', '连接不存在')
      const next = new Map(this.#rows)
      next.delete(id)
      this.#persist(next)
      this.#rows.delete(id)
      return { ok: true, value: null }
    } catch {
      return fail('unreachable', '应用连接存储不可用')
    }
  }
  #mail(row: ConnectorRecord): MailSettings {
    return row.settings as unknown as MailSettings
  }
  #caldav(row: ConnectorRecord): CaldavClient {
    return new CaldavClient(
      this.#policy,
      String(row.settings['caldavUrl']),
      String(row.settings['username']),
      this.#vault.reveal(row.id, row.secret, row.revision),
    )
  }
  async probe(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ConnectorView>> {
    const row = this.#rows.get(id)
    if (!this.#writer(actor)) return fail('refused', '测连需要运维个人账号')
    if (!row || !this.#writer(actor, row))
      return fail('not_found', '连接不存在')
    let success = false
    try {
      const secret = this.#vault.reveal(id, row.secret, row.revision)
      if (row.kind === 'mail') {
        const imap = await ImapClient.login(
          this.#policy,
          this.#mail(row),
          secret,
        )
        await imap.logout()
        if (this.#rows.get(id) !== row || !this.#writer(actor, row))
          throw new Error()
        const smtp = await SmtpClient.login(
          this.#policy,
          this.#mail(row),
          secret,
        )
        await smtp.quit()
      } else if (row.preset === 'ics') {
        calendarHttpsUrl(this.#policy, secret)
        const response = await this.#policy.request(secret)
        if (!response.ok) throw new Error()
        await response.body?.cancel()
      } else await this.#caldav(row).discover()
      success = true
    } catch {
      success = false
    }
    if (this.#rows.get(id) !== row || !this.#writer(actor, row))
      return fail('refused', '测连期间连接或权限已变化')
    try {
      const updated = {
        ...row,
        lastProbe: {
          at: this.#now(),
          ok: success,
          detail: success
            ? '夹具或服务登录成功（未评估）'
            : '连接失败；请核对地址、出站策略与凭据',
        },
      }
      const next = new Map(this.#rows)
      next.set(id, updated)
      this.#persist(next)
      this.#rows.set(id, updated)
      return { ok: true, value: this.#view(updated) }
    } catch {
      return fail('unreachable', '测连结果无法保存')
    }
  }
  #allowed(row: ConnectorRecord, node: string, agent: string): boolean {
    if (
      this.#closed ||
      this.#rows.get(row.id) !== row ||
      !row.agents.includes(`qianmo://${node}/${agent}`)
    )
      return false
    if (!this.#options.tenancy) return row.tenant === null
    return this.#options.tenancy
      .read()
      .config.nodes.some(v => v.nodeId === node && v.tenant === row.tenant)
  }
  async #record(
    row: Pick<ConnectorRecord, 'id' | 'name'>,
    agent: string,
    op: string,
    result: ControlOutcome,
    count: number | null,
    domains: string,
  ): Promise<void> {
    if (this.#closed) throw new Error('连接簿已关闭')
    const outcome = result.ok
      ? 'ok'
      : result.code === 'refused'
        ? 'refused'
        : 'failed'
    this.#recent.unshift({
      at: this.#now(),
      connectorId: row.id,
      agent,
      op,
      outcome,
      count,
      detail: result.ok ? null : '调用失败或被拒绝',
    })
    this.#recent.length = Math.min(
      this.#recent.length,
      LIMITS.connectorRecentCalls,
    )
    this.#audit.append({
      at: this.#now(),
      source: AuditSource.Control,
      kind: `connector.${op}`,
      outcome: result.ok ? 'ok' : 'refused',
      detail: {
        name: row.name,
        result: outcome,
        count: count ?? 0,
        recipientDomains: domains,
      },
    })
  }
  readonly handle: HubCallHandler = async (fullOp, args, ctx) => {
    const op = fullOp.slice('connector.'.length),
      agent = ctx.agent
    if (!fullOp.startsWith('connector.') || this.#closed) return refused()
    const row =
      typeof args['connectorId'] === 'string'
        ? this.#rows.get(args['connectorId'])
        : undefined
    const reject = async (): Promise<ControlOutcome> => {
      const result = refused()
      if (
        [
          'mail.search',
          'mail.read',
          'mail.send',
          'calendar.events',
          'calendar.create',
        ].includes(op)
      ) {
        try {
          await this.#record(
            row ?? { id: '-', name: '不可用连接' },
            `qianmo://${ctx.node}/${agent ?? 'console'}`,
            op,
            result,
            null,
            '',
          )
        } catch {
          return { ok: false, code: 'unreachable', message: '连接审计不可用' }
        }
      }
      return result
    }
    if (!agent) return reject()
    let available: readonly string[]
    try {
      available = await this.#options.agents()
    } catch {
      return reject()
    }
    if (!available.includes(`qianmo://${ctx.node}/${agent}`)) return reject()
    if (op === 'list')
      return {
        ok: true,
        value: [...this.#rows.values()]
          .filter(value => this.#allowed(value, ctx.node, agent))
          .map(({ id, name, kind }) => ({ id, name, kind })),
      }
    if (!row || !this.#allowed(row, ctx.node, agent)) return reject()
    if (op === 'describe')
      return {
        ok: true,
        value: {
          id: row.id,
          revision: row.revision,
          readOnly: row.preset === 'ics',
          kind: row.kind,
        },
      }
    let result: ControlOutcome,
      count: number | null = null,
      domains = ''
    const execute = async (): Promise<ControlOutcome> => {
      try {
        const mutation = ['mail.send', 'calendar.create'].includes(op)
        if (row.kind !== (op.startsWith('mail.') ? 'mail' : 'calendar'))
          return refused()
        const params = { ...args }
        for (const key of [
          'approvalId',
          'contextId',
          'revision',
          'operationId',
        ])
          delete params[key]
        this.#validate(op, params)
        if (mutation) {
          if (row.preset === 'ics') return refused('ICS 订阅只读')
          if (
            typeof args['operationId'] !== 'string' ||
            !operationPattern.test(args['operationId']) ||
            args['operationId'] !== ctx.callId ||
            args['revision'] !== row.revision ||
            typeof args['contextId'] !== 'string' ||
            typeof args['approvalId'] !== 'string'
          )
            return refused('此动作需要本次调用的单次批准')
          const operationId = `${ctx.node}/${args['operationId']}`
          const bound = {
            ...params,
            revision: row.revision,
            operationId: args['operationId'],
          }
          if (
            this.#operations.has(operationId) ||
            !this.#options.approvals?.consumeConnector({
              requestId: args['approvalId'],
              node: ctx.node,
              agent,
              contextId: args['contextId'],
              toolName: toolName(op),
              input: bound,
            })
          )
            return refused('单次批准不存在、参数已变化或动作已消费')
          // Intent is durable before dialing; unknown outcomes are never retried.
          const next = new Set(this.#operations)
          next.add(operationId)
          this.#persist(this.#rows, next)
          this.#operations.add(operationId)
        }
        const guard = () => {
          if (!this.#allowed(row, ctx.node, agent))
            throw new Error('连接或授权已变化')
        }
        guard()
        const secret = this.#vault.reveal(row.id, row.secret, row.revision)
        if (op === 'mail.search' || op === 'mail.read') {
          let handle: Record<string, unknown> | undefined
          if (op === 'mail.read') {
            handle = this.#vault.openHandle(String(params['id']))
            if (
              handle['connectorId'] !== row.id ||
              handle['revision'] !== row.revision ||
              handle['account'] !==
                accountHash(String(row.settings['username']))
            )
              return refused('邮件句柄已经失效')
          }
          const folder = handle
            ? String(handle['folder'])
            : String(params['folder'] ?? 'INBOX')
          const imap = await ImapClient.login(
            this.#policy,
            this.#mail(row),
            secret,
          )
          try {
            const validity = await imap.select(folder)
            guard()
            if (handle && validity !== handle['validity'])
              return refused('邮件 UIDVALIDITY 已变化')
            if (handle) {
              const value = await imap.read(String(handle['uid']))
              result = { ok: true, value }
              count = 1
            } else {
              const messages = await imap.search(params)
              result = {
                ok: true,
                value: messages.map(value => ({
                  id: this.#vault.handle({
                    connectorId: row.id,
                    revision: row.revision,
                    account: accountHash(String(row.settings['username'])),
                    folder,
                    validity,
                    uid: value.uid,
                  }),
                  ...value.headers,
                })),
              }
              count = messages.length
            }
            guard()
            await imap.logout()
          } finally {
            imap.close()
          }
        } else if (op === 'mail.send') {
          const to = this.#recipients(params['to'])
          domains = [...new Set(to.map(v => v.split('@')[1]!))].join(',')
          const smtp = await SmtpClient.login(
            this.#policy,
            this.#mail(row),
            secret,
          )
          try {
            guard()
            await smtp.send(
              String(row.settings['username']),
              to,
              String(params['subject']),
              String(params['body']),
              guard,
            )
            result = { ok: true, value: { sent: true } }
            count = 1
            await smtp.quit()
          } finally {
            smtp.close()
          }
        } else if (op === 'calendar.events') {
          const value =
            row.preset === 'ics'
              ? await icsEvents(
                  this.#policy,
                  secret,
                  String(params['from']),
                  String(params['to']),
                )
              : await this.#caldav(row).events(
                  String(params['from']),
                  String(params['to']),
                )
          guard()
          result = { ok: true, value }
          count = value.events.length
        } else if (op === 'calendar.create') {
          const value = await this.#caldav(row).create(
            String(args['operationId']),
            params as unknown as EventDraft,
            guard,
          )
          result = { ok: true, value }
          count = 1
        } else return refused('不支持此连接操作')
        return result
      } catch {
        return {
          ok: false,
          code: 'failed',
          message: '连接调用失败；写入结果可能未知，请核对服务端，不会自动重发',
        }
      }
    }
    result = await execute()
    try {
      await this.#record(
        row,
        `qianmo://${ctx.node}/${agent}`,
        op,
        result,
        count,
        domains,
      )
    } catch {
      return {
        ok: false,
        code: 'unreachable',
        message: '连接审计不可用；不会自动重发',
      }
    }
    return result
  }
  #recipients(raw: unknown): string[] {
    const values =
      typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
    if (!values.length || values.length > LIMITS.connectorResults)
      throw new Error('收件人无效')
    return values.map(v => mailbox(v))
  }
  #validate(op: string, params: Record<string, unknown>): void {
    const keys: Record<string, readonly string[]> = {
      'mail.search': ['connectorId', 'query', 'folder', 'since', 'limit'],
      'mail.read': ['connectorId', 'id'],
      'mail.send': ['connectorId', 'to', 'subject', 'body'],
      'calendar.events': ['connectorId', 'from', 'to'],
      'calendar.create': [
        'connectorId',
        'title',
        'start',
        'end',
        'location',
        'notes',
      ],
    }
    if (!keys[op] || Object.keys(params).some(v => !keys[op]!.includes(v)))
      throw new Error('连接参数无效')
    if (op === 'mail.send') {
      this.#recipients(params['to'])
      mailData(
        'validation@example.com',
        this.#recipients(params['to']),
        headerValue(params['subject']),
        params['body'] as string,
      )
    }
    if (op === 'calendar.create')
      createIcs('validation', params as unknown as EventDraft)
    if (op === 'calendar.events') range(params['from'], params['to'])
    if (op === 'mail.read') headerValue(params['id'], 2048)
    if (op === 'mail.search') {
      for (const key of ['query', 'folder', 'since'])
        if (params[key] !== undefined)
          headerValue(
            params[key],
            key === 'folder' ? 512 : LIMITS.connectorLineBytes,
          )
      if (
        params['limit'] !== undefined &&
        (!Number.isSafeInteger(params['limit']) ||
          Number(params['limit']) < 1 ||
          Number(params['limit']) > LIMITS.connectorResults)
      )
        throw new Error('邮件数量无效')
    }
  }
  close(): void {
    this.#closed = true
    this.#audit.close()
    this.#lock.release()
  }
}
