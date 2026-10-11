// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type {
  ConsoleDeps,
  ConsoleResult,
  DirectionActor,
  FilesPort,
  FilesSnapshot,
} from '../src/index.js'
import { filesApi } from '../src/routes/filesApi.js'
import type { RouteContext } from '../src/routes/types.js'
import { scopedConsoleDeps, tenantRequestDenial } from '../src/tenantScope.js'
import type { TenantConfig } from '../src/tenancy.js'
import { LIMITS } from './accountsHarness.js'
import { PageAudit, PageRegistry } from './pageHarness.js'

const source = { node: 'alpha', agent: 'main' },
  target = { node: 'beta', agent: 'main' }
const grant = {
  grantId: 'g-one',
  requestId: 'r-one',
  source,
  target,
  scope: { kind: 'file' as const, path: 'report.txt' },
  grantedBy: 'u:0123456789abcdef',
  grantedAt: 1,
  expiresAt: 100,
  revokedAt: null,
}
const fileRequest = {
  requestId: 'r-one',
  source,
  target,
  path: 'report.txt',
  reason: 'needed',
  requestedBy: 'agent',
  at: 1,
  state: 'pending' as const,
  grantId: null,
  note: null,
}
const transfer = {
  transferId: 't-one',
  grantId: 'g-one',
  groupId: 'group-one',
  source: { ...source, path: 'report.txt' },
  target: { ...target, path: null },
  files: 0,
  bytes: 0,
  doneBytes: 0,
  manifestSha256: null,
  verified: null,
  state: 'failed' as const,
  reason: null,
  startedAt: 1,
  finishedAt: null,
}
const group = {
  groupId: 'group-one',
  target,
  transfers: ['t-one'],
  createdBy: 'u:0123456789abcdef',
  createdAt: 1,
}
const snapshot: FilesSnapshot = {
  requests: [fileRequest],
  grants: [grant],
  transfers: [transfer],
  groups: [group],
  agents: [
    { ...source, reachable: true },
    { ...target, reachable: true },
  ],
  limits: { maxFileBytes: 1, maxTransferBytes: 2, maxFiles: 3, maxTtlMs: 4 },
}
let calls: { op: string; input: unknown; actor?: DirectionActor }[],
  admissions: number,
  recordings: number,
  deny: boolean,
  portFailure: boolean
const result = <T>(value: T): ConsoleResult<T> =>
  portFailure
    ? { ok: false, failure: { code: 'not_found', message: 'absent' } }
    : { ok: true, value }
const port: FilesPort = {
  async snapshot() {
    return result(snapshot)
  },
  async browse(ref, path) {
    calls.push({ op: 'browse', input: { ref, path } })
    return result([{ name: 'report.txt', kind: 'file', size: 1, mtime: 1 }])
  },
  async decide(id, input, actor) {
    expect(admissions).toBe(1)
    calls.push({ op: 'decide', input: { id, input }, actor })
    return result(fileRequest)
  },
  async revokeGrant(id, actor) {
    expect(admissions).toBe(1)
    calls.push({ op: 'revoke', input: id, actor })
    return result(grant)
  },
  async transfer(input, actor) {
    expect(admissions).toBe(1)
    calls.push({ op: 'transfer', input, actor })
    return result(group)
  },
  async retry(id, actor) {
    expect(admissions).toBe(1)
    calls.push({ op: 'retry', input: id, actor })
    return result(transfer)
  },
}
let deps: ConsoleDeps
function access(
  role: 'none' | 'view' | 'admin' | 'viewer' | 'member' | 'ops',
  cookie = false,
  header = true,
): Access {
  const personal = role === 'viewer' || role === 'member' || role === 'ops'
  return {
    credential: {
      role: personal ? (role === 'ops' ? 'admin' : 'view') : role,
      source: cookie ? 'cookie' : role === 'none' ? 'none' : 'bearer',
      header,
      crossOrigin: false,
    },
    principal:
      role === 'none'
        ? null
        : personal
          ? {
              kind: 'user',
              subject: 'u:0123456789abcdef',
              role,
              credential: 'bearer',
              authenticatedAt: 1,
            }
          : {
              kind: 'legacy',
              subject: role === 'admin' ? 'legacy:admin' : 'legacy:view',
              credential: 'bearer',
            },
    sid: null,
    refusal: null,
    breakGlass: false,
  }
}
async function request(
  method: string,
  path: string,
  role: Parameters<typeof access>[0] = 'member',
  body?: unknown,
  cookie = false,
  header = true,
) {
  admissions = 0
  const req = new Request(`http://console.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: typeof body === 'string' ? body : JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  })
  const auth = access(role, cookie, header),
    scoped = scopedConsoleDeps(deps, auth),
    url = new URL(req.url)
  const preflight = await tenantRequestDenial(
    req,
    url,
    scoped.deps,
    scoped.scope,
  )
  if (preflight) return preflight
  const ctx: RouteContext = {
    request: req,
    url,
    deps: scoped.deps,
    access: auth,
    accounts: undefined,
    now: 1,
    viewer: undefined,
    requestId: 'request-123',
    roster: () => deps.registry.list(),
    async admit() {
      admissions++
      return deny ? new Response(null, { status: 503 }) : null
    },
    async record() {
      recordings++
      throw new Error('port owns ledger')
    },
  }
  return filesApi.handle(
    ctx,
    'files',
    url.pathname.split('/').filter(Boolean).slice(2),
  )
}
beforeEach(() => {
  calls = []
  admissions = 0
  recordings = 0
  deny = false
  portFailure = false
  deps = {
    files: port,
    limits: LIMITS,
    registry: new PageRegistry(),
    audit: new PageAudit(),
  }
})

test('view and above may read snapshots; only members and above browse', async () => {
  for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const)
    expect((await request('GET', '/v0/files', role)).status).toBe(200)
  expect((await request('GET', '/v0/files', 'none')).status).toBe(401)
  for (const role of ['admin', 'member', 'ops'] as const)
    expect(
      (
        await request(
          'GET',
          '/v0/files/browse?agent=qianmo://alpha/main&path=',
          role,
        )
      ).status,
    ).toBe(200)
  for (const role of ['view', 'viewer'] as const)
    expect(
      (await request('GET', '/v0/files/browse?agent=qianmo://alpha/main', role))
        .status,
    ).toBe(403)
  expect(calls).toHaveLength(3)
})

const writes = [
  ['/v0/files/requests/r-one/decide', { approve: false, note: 'denied' }],
  ['/v0/files/grants/g-one/revoke', undefined],
  [
    '/v0/files/transfers',
    {
      sources: [{ agent: 'qianmo://alpha/main', path: 'report.txt' }],
      target: 'qianmo://beta/main',
    },
  ],
  ['/v0/files/transfers/t-one/retry', undefined],
] as const
test('all member writes admit before effect, preserve explicit false and actor, and do not double-record', async () => {
  for (const role of ['admin', 'member', 'ops'] as const)
    for (const [url, body] of writes) {
      expect((await request('POST', url, role, body)).status).toBe(200)
      expect(calls.at(-1)!.actor).toMatchObject({
        subject: role === 'admin' ? 'legacy:admin' : 'u:0123456789abcdef',
        requestId: 'request-123',
      })
    }
  expect(
    (
      calls.find(one => one.op === 'decide')!.input as {
        input: { approve: boolean }
      }
    ).input.approve,
  ).toBe(false)
  expect(calls.find(one => one.op === 'transfer')!.input).toEqual({
    sources: [{ ...source, path: 'report.txt' }],
    target,
  })
  const count = calls.length
  for (const role of ['view', 'viewer', 'none'] as const)
    for (const [url, body] of writes)
      expect((await request('POST', url, role, body)).status).toBe(
        role === 'none' ? 401 : 403,
      )
  expect(calls).toHaveLength(count)
  expect(recordings).toBe(0)
})

test('invalid bodies, ids, addresses, paths, scopes and TTLs return 400 without admission or effect', async () => {
  const cases = [
    ['/v0/files/requests/%ZZ/decide', { approve: true }],
    ['/v0/files/requests/r-one/decide', { approve: 'true' }],
    [
      '/v0/files/requests/r-one/decide',
      { approve: true, scope: { kind: 'other', path: 'a' } },
    ],
    ['/v0/files/requests/r-one/decide', { approve: true, ttlMs: -1 }],
    ['/v0/files/transfers', { sources: [], target: 'qianmo://beta/main' }],
    [
      '/v0/files/transfers',
      {
        sources: [{ agent: 'https://alpha', path: 'a' }],
        target: 'qianmo://beta/main',
      },
    ],
    [
      '/v0/files/transfers',
      {
        sources: [{ agent: 'qianmo://alpha/main', path: '../a' }],
        target: 'qianmo://beta/main',
      },
    ],
    ['/v0/files/transfers', 'null'],
    ['/v0/files/transfers', '[1]'],
    ['/v0/files/transfers', '{bad'],
  ] as const
  for (const [url, body] of cases) {
    expect((await request('POST', url, 'member', body)).status).toBe(400)
    expect(admissions).toBe(0)
  }
  expect((await request('GET', '/v0/files/browse?agent=bad')).status).toBe(400)
  expect(calls).toEqual([])
})

test('admission, cookie CSRF, failure mapping, methods, absence and unknown paths keep their HTTP contracts', async () => {
  deny = true
  for (const [url, body] of writes)
    expect((await request('POST', url, 'member', body)).status).toBe(503)
  expect(calls).toEqual([])
  deny = false
  expect(
    (await request('POST', writes[0][0], 'member', writes[0][1], true, false))
      .status,
  ).toBe(403)
  expect(
    (await request('POST', writes[0][0], 'member', writes[0][1], true, true))
      .status,
  ).toBe(200)
  portFailure = true
  expect((await request('POST', writes[1][0])).status).toBe(404)
  deps = { ...deps, files: undefined }
  expect((await request('GET', '/v0/files', 'view')).status).toBe(501)
  expect((await request('POST', '/v0/files/transfers', 'viewer')).status).toBe(
    403,
  )
  expect((await request('PUT', '/v0/files', 'admin')).status).toBe(405)
  const response = await request('POST', '/v0/files/unknown', 'admin')
  expect(response.status).toBe(404)
  expect(await response.text()).toContain('unknown path: /v0/files/unknown')
})

test('tenant snapshot hides both-endpoint records, details are 404 and writes fail before admit and dial', async () => {
  const config: TenantConfig = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [{ subject: 'u:0123456789abcdef', tenant: 'a' }],
    nodes: [
      { nodeId: 'alpha', tenant: 'a', server: 'sa', memoryRoot: '/a' },
      { nodeId: 'beta', tenant: 'b', server: 'sb', memoryRoot: '/b' },
    ],
    jobs: [],
    platformSubjects: [],
  }
  let revision = 'one'
  deps = {
    ...deps,
    tenancy: { read: () => ({ config, revision }), subscribe: () => () => {} },
  }
  const read = await request('GET', '/v0/files')
  expect(await read.json()).toMatchObject({
    requests: [],
    grants: [],
    transfers: [],
    groups: [],
    agents: [{ ...source, reachable: true }],
  })
  for (const [url, body] of writes) {
    expect((await request('POST', url, 'member', body)).status).toBe(404)
    expect(admissions).toBe(0)
  }
  expect(
    (await request('GET', '/v0/files/browse?agent=qianmo://beta/main')).status,
  ).toBe(404)
  expect(calls).toEqual([])
  const scoped = scopedConsoleDeps(deps, access('member')).deps.files!
  revision = 'two'
  expect((await scoped.browse(source, '')).ok).toBe(false)
  expect(calls).toEqual([])
})
