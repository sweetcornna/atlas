// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsolePrincipal } from './contracts.js'

export interface TenantConfig {
  readonly version: 1
  readonly hubServer: string
  readonly tenants: readonly { readonly id: string; readonly label?: string }[]
  readonly subjects: readonly {
    readonly subject: string
    readonly tenant: string
  }[]
  readonly nodes: readonly {
    readonly nodeId: string
    readonly tenant: string
    readonly server: string
    readonly memoryRoot: string
  }[]
  readonly jobs: readonly {
    readonly jobId: string
    readonly tenant: string
    readonly nodeId: string
  }[]
  readonly platformSubjects: readonly string[]
}

export interface TenantSnapshot {
  readonly revision: string
  readonly config: TenantConfig
}

/** Enabled stores never turn themselves into an absent/disabled store on I/O failure. */
export interface TenantPort {
  read(): TenantSnapshot
  /** Closes long-lived streams when the authoritative policy changes or fails. */
  subscribe(listener: () => void): () => void
}

export interface TenantScope {
  readonly platform: boolean
  readonly tenant: string | null
  readonly revision: string
  node(node: string): boolean
  address(address: string): boolean
  subject(subject: string): boolean
  job(job: string): boolean
  server(server: string): boolean
}

function control(value: string): boolean {
  return [...value].some(
    char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  )
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const SUBJECT = /^u:[a-f0-9]{16}$/
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('租户配置对象无效')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key)))
    throw new Error('租户配置有未知字段')
  return result
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value))
    throw new Error('租户配置标识无效')
  return value
}
function subject(value: unknown): string {
  if (typeof value !== 'string' || !SUBJECT.test(value))
    throw new Error('租户配置账号无效')
  return value
}
function rows<T>(value: unknown, parse: (row: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('租户配置列表无效')
  return value.map(parse)
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    throw new Error('租户配置归属重复')
}
function segments(path: string): string[] {
  const win = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
  if (!win && !path.startsWith('/')) throw new Error('记忆根必须是绝对路径')
  const parts = (win ? path.toLowerCase().replaceAll('\\', '/') : path)
    .split('/')
    .filter(Boolean)
  if (parts.some(part => part === '.' || part === '..'))
    throw new Error('记忆根必须已规范化')
  return parts
}
function overlap(a: string, b: string): boolean {
  const x = segments(a),
    y = segments(b)
  return x
    .slice(0, Math.min(x.length, y.length))
    .every((part, i) => part === y[i])
}

/** Host resolves symlinks before this validation; requests cannot provide this input. */
export function parseTenantConfig(
  input: unknown,
  canonicalize: (path: string) => string = path => path,
): TenantConfig {
  const row = object(input, [
    'version',
    'hubServer',
    'tenants',
    'subjects',
    'nodes',
    'jobs',
    'platformSubjects',
  ])
  if (row['version'] !== 1) throw new Error('租户配置版本无效')
  const hubServer = id(row['hubServer'])
  const tenants = rows(row['tenants'], value => {
    const v = object(value, ['id', 'label'])
    if (
      v['label'] !== undefined &&
      (typeof v['label'] !== 'string' ||
        v['label'].length > 80 ||
        control(v['label']))
    )
      throw new Error('租户名称无效')
    return {
      id: id(v['id']),
      ...(typeof v['label'] === 'string' ? { label: v['label'] } : {}),
    }
  })
  const subjects = rows(row['subjects'], value => {
    const v = object(value, ['subject', 'tenant'])
    return { subject: subject(v['subject']), tenant: id(v['tenant']) }
  })
  const nodes = rows(row['nodes'], value => {
    const v = object(value, ['nodeId', 'tenant', 'server', 'memoryRoot'])
    if (typeof v['memoryRoot'] !== 'string' || control(v['memoryRoot']))
      throw new Error('记忆根无效')
    const memoryRoot = canonicalize(v['memoryRoot'])
    segments(memoryRoot)
    return {
      nodeId: id(v['nodeId']),
      tenant: id(v['tenant']),
      server: id(v['server']),
      memoryRoot,
    }
  })
  const jobs = rows(row['jobs'], value => {
    const v = object(value, ['jobId', 'tenant', 'nodeId'])
    return {
      jobId: id(v['jobId']),
      tenant: id(v['tenant']),
      nodeId: id(v['nodeId']),
    }
  })
  const platformSubjects = rows(row['platformSubjects'], subject)
  for (const keys of [
    tenants.map(v => v.id),
    subjects.map(v => v.subject),
    nodes.map(v => v.nodeId),
    jobs.map(v => v.jobId),
    platformSubjects,
  ])
    unique(keys)
  const known = new Set(tenants.map(v => v.id))
  if ([...subjects, ...nodes, ...jobs].some(v => !known.has(v.tenant)))
    throw new Error('归属引用不存在的租户')
  for (const node of nodes) {
    if (node.server === hubServer) throw new Error('中枢不能承载用户节点')
    for (const other of nodes) {
      if (node.tenant === other.tenant) continue
      if (node.server === other.server) throw new Error('同一服务器不能跨租户')
      if (overlap(node.memoryRoot, other.memoryRoot))
        throw new Error('跨租户记忆根重叠')
    }
  }
  for (const job of jobs)
    if (nodes.find(v => v.nodeId === job.nodeId)?.tenant !== job.tenant)
      throw new Error('作业租户与目标节点不一致')
  return {
    version: 1,
    hubServer,
    tenants,
    subjects,
    nodes,
    jobs,
    platformSubjects,
  }
}

export function addressNode(address: string): string | null {
  return (
    /^qianmo:\/\/([a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_.-]+$/.exec(address)?.[1] ?? null
  )
}

export function tenantScope(
  snapshot: TenantSnapshot,
  principal: ConsolePrincipal | null,
  breakGlass = false,
): TenantScope {
  const config = snapshot.config
  const who = principal?.kind === 'user' ? principal.subject : null
  const platform =
    breakGlass || (who !== null && config.platformSubjects.includes(who))
  const tenant =
    who === null
      ? null
      : (config.subjects.find(v => v.subject === who)?.tenant ?? null)
  const node = (name: string) =>
    platform ||
    (tenant !== null &&
      config.nodes.some(v => v.nodeId === name && v.tenant === tenant))
  return {
    platform,
    tenant,
    revision: snapshot.revision,
    node,
    address: address => {
      const name = addressNode(address)
      return name !== null && node(name)
    },
    subject: name =>
      platform ||
      (tenant !== null &&
        config.subjects.some(v => v.subject === name && v.tenant === tenant)),
    job: name =>
      platform ||
      (tenant !== null &&
        config.jobs.some(v => v.jobId === name && v.tenant === tenant)),
    server: name =>
      platform ||
      (tenant !== null &&
        config.nodes.some(v => v.server === name && v.tenant === tenant)),
  }
}
