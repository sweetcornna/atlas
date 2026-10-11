// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps, ConsoleFailure, ConsoleResult } from '../src/deps.js'
import type {
  DirectionActor,
  ScheduleRunView,
  ScheduleView,
  SchedulesPort,
  SchedulesSnapshot,
} from '../src/directionPorts.js'
import { schedulesApi } from '../src/routes/schedulesApi.js'
import { headIndex } from '../src/routes/index.js'
import type { RouteContext, RouteModule } from '../src/routes/types.js'
import { LIMITS } from './accountsHarness.js'

const module: RouteModule = {
  area: {
    id: 'jobs',
    label: '主动执行',
    group: 'main',
    href: '/schedules',
    icon: 'clock',
  },
  api: schedulesApi,
}
const heads = headIndex([module], value => value.api)
const empty: SchedulesSnapshot = {
  schedules: [],
  runs: [],
  channels: [],
  templates: [],
  targets: [],
  estop: false,
  tickAt: null,
}
const schedule: ScheduleView = {
  id: 's-one',
  title: '任务',
  target: 'qianmo://node/helper',
  template: 'custom',
  prompt: '简报',
  when: { kind: 'daily', time: '08:00' },
  timezone: 'Asia/Shanghai',
  direction: 'chat',
  channels: [],
  notifyOnlyAgent: false,
  enabled: true,
  timeoutMs: 600_000,
  createdAt: 1,
  createdBy: 'legacy:admin',
  updatedAt: 1,
  nextRunAt: 2,
  lastRun: null,
}
const run: ScheduleRunView = {
  runId: 'r-one',
  scheduleId: 's-one',
  plannedAt: 1,
  startedAt: 1,
  finishedAt: null,
  outcome: 'running',
  taskId: null,
  sessionId: null,
  excerpt: null,
  reason: null,
  pushed: [],
  trigger: 'manual',
}
const channel = {
  id: 'c-one',
  name: '手机',
  kind: 'webhook' as const,
  host: 'example.test',
  createdAt: 1,
  lastUsedAt: null,
  lastError: null,
}
let deps: ConsoleDeps
let calls: { verb: string; input: unknown; actor?: DirectionActor }[]
let admitted: boolean
let rejectAdmit: boolean
let failure: ConsoleFailure['code'] | null
function result<T>(value: T): ConsoleResult<T> {
  return failure
    ? { ok: false, failure: { code: failure, message: 'port failure' } }
    : { ok: true, value }
}
const port: SchedulesPort = {
  visible() {
    return true
  },
  async resolve() {
    return result(run)
  },
  async snapshot() {
    calls.push({ verb: 'snapshot', input: null })
    return result(empty)
  },
  async save(input, actor) {
    expect(admitted).toBe(true)
    calls.push({ verb: 'save', input, actor })
    return result(schedule)
  },
  async setEnabled(id, enabled, actor) {
    expect(admitted).toBe(true)
    calls.push({ verb: 'enabled', input: { id, enabled }, actor })
    return result({ ...schedule, enabled })
  },
  async remove(id, actor) {
    expect(admitted).toBe(true)
    calls.push({ verb: 'remove', input: id, actor })
    return result(null)
  },
  async runNow(id, actor) {
    expect(admitted).toBe(true)
    calls.push({ verb: 'run', input: id, actor })
    return result(run)
  },
  async saveChannel(input, actor) {
    expect(admitted).toBe(true)
    calls.push({ verb: 'channel.save', input, actor })
    return result(channel)
  },
  async removeChannel(id, actor) {
    expect(admitted).toBe(true)
    calls.push({ verb: 'channel.remove', input: id, actor })
    return result(null)
  },
  async testChannel(id, actor) {
    expect(admitted).toBe(true)
    calls.push({ verb: 'channel.test', input: id, actor })
    return result(channel)
  },
}
function access(
  role: 'none' | 'view' | 'admin' | 'viewer' | 'member' | 'ops',
  cookie = false,
  header = true,
): Access {
  const personal = role === 'viewer' || role === 'member' || role === 'ops'
  const credentialRole = personal ? (role === 'ops' ? 'admin' : 'view') : role
  return {
    credential: {
      role: credentialRole,
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
  route: string,
  role: Parameters<typeof access>[0],
  body?: string,
  cookie = false,
  header = true,
) {
  admitted = false
  const request = new Request(`http://console.test${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { body, headers: { 'content-type': 'application/json' } }),
  })
  const segments = route.split('/').filter(Boolean)
  const handler = heads.get(segments[1]!)!
  const ctx: RouteContext = {
    request,
    url: new URL(request.url),
    deps,
    access: access(role, cookie, header),
    accounts: undefined,
    now: 1,
    viewer: undefined,
    requestId: 'request-123',
    roster: () => deps.registry.list(),
    async admit() {
      admitted = true
      return rejectAdmit ? new Response(null, { status: 503 }) : null
    },
    async record() {
      throw new Error('direction port owns the ledger')
    },
  }
  return handler.handle(ctx, segments[1]!, segments.slice(2))
}
beforeEach(() => {
  deps = {
    schedules: port,
    limits: LIMITS,
    registry: {
      async list() {
        return { ok: true, value: [] }
      },
      async register() {
        return {
          ok: false,
          failure: { code: 'unsupported', message: 'unused' },
        }
      },
      async deregister() {
        return { ok: true, value: undefined }
      },
      async heartbeat() {
        return {
          ok: false,
          failure: { code: 'unsupported', message: 'unused' },
        }
      },
    },
    audit: {
      async read() {
        return {
          ok: false,
          failure: { code: 'unsupported', message: 'unused' },
        }
      },
      async chain() {
        return {
          ok: false,
          failure: { code: 'unsupported', message: 'unused' },
        }
      },
    },
  }
  calls = []
  admitted = false
  rejectAdmit = false
  failure = null
})

describe('schedules HeadRoute API role and status contracts', () => {
  test('all authenticated roles can read the snapshot, unauthenticated callers cannot', async () => {
    for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const) {
      const response = await request('GET', '/v0/schedules', role)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(empty)
    }
    expect((await request('GET', '/v0/schedules', 'none')).status).toBe(401)
    expect(calls).toHaveLength(5)
  })

  test('members/ops/admin can write schedules; viewers/view tokens cannot call the port', async () => {
    const paths = [
      ['POST', '/v0/schedules'],
      ['POST', '/v0/schedules/s-one/enable'],
      ['POST', '/v0/schedules/s-one/disable'],
      ['POST', '/v0/schedules/s-one/run'],
      ['DELETE', '/v0/schedules/s-one'],
    ] as const
    for (const role of ['member', 'ops', 'admin'] as const)
      for (const [method, path] of paths) {
        const response = await request(
          method,
          path,
          role,
          path === '/v0/schedules' ? '{}' : undefined,
        )
        expect(response.status).toBe(method === 'DELETE' ? 204 : 200)
        expect(calls.at(-1)!.actor).toMatchObject({
          requestId: 'request-123',
          subject: role === 'admin' ? 'legacy:admin' : 'u:0123456789abcdef',
          role: role === 'admin' ? null : role,
        })
      }
    const count = calls.length
    for (const role of ['view', 'viewer', 'none'] as const)
      for (const [method, path] of paths) {
        expect((await request(method, path, role, '{}')).status).toBe(
          role === 'none' ? 401 : 403,
        )
      }
    expect(calls).toHaveLength(count)
    expect(
      calls.some(
        call =>
          call.verb === 'enabled' &&
          JSON.stringify(call.input).includes('false'),
      ),
    ).toBe(true)
  })

  test('channel save/remove/test require ops or admin, even with a writable schedules port', async () => {
    for (const role of ['ops', 'admin'] as const)
      for (const [method, route] of [
        ['POST', '/v0/channels'],
        ['DELETE', '/v0/channels/c-one'],
        ['POST', '/v0/channels/c-one/test'],
      ] as const) {
        expect(
          (
            await request(
              method,
              route,
              role,
              route === '/v0/channels' ? '{}' : undefined,
            )
          ).status,
        ).toBe(method === 'DELETE' ? 204 : 200)
      }
    for (const role of ['view', 'viewer', 'member', 'none'] as const) {
      expect((await request('POST', '/v0/channels', role, '{}')).status).toBe(
        role === 'none' ? 401 : 403,
      )
      expect((await request('DELETE', '/v0/channels/c-one', role)).status).toBe(
        role === 'none' ? 401 : 403,
      )
      expect(
        (await request('POST', '/v0/channels/c-one/test', role)).status,
      ).toBe(role === 'none' ? 401 : 403)
    }
    expect(calls).toHaveLength(6)
  })

  test('admission and JSON failures prevent mutation; fields are validated only by the host', async () => {
    rejectAdmit = true
    expect(
      (await request('POST', '/v0/schedules', 'member', '{}')).status,
    ).toBe(503)
    rejectAdmit = false
    for (const body of ['[1]', 'null', '{bad'])
      expect(
        (await request('POST', '/v0/schedules', 'member', body)).status,
      ).toBe(400)
    expect(calls).toEqual([])
    failure = 'invalid'
    expect(
      (
        await request(
          'POST',
          '/v0/schedules',
          'member',
          '{"arbitrary":"field"}',
        )
      ).status,
    ).toBe(400)
    expect(calls[0]!.input).toEqual({ arbitrary: 'field' })
  })

  test('port failures map to established statuses; absent ports do not bypass roles/methods', async () => {
    for (const [code, status] of [
      ['not_found', 404],
      ['rejected', 400],
      ['refused', 403],
      ['invalid', 400],
      ['unsupported', 501],
      ['unreachable', 503],
    ] as const) {
      failure = code
      const response = await request(
        'POST',
        '/v0/schedules/s-one/run',
        'member',
      )
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
    }
    deps = { ...deps, schedules: undefined }
    expect((await request('GET', '/v0/schedules', 'viewer')).status).toBe(501)
    expect(
      (await request('POST', '/v0/schedules', 'viewer', '{}')).status,
    ).toBe(403)
    expect((await request('POST', '/v0/channels', 'member', '{}')).status).toBe(
      403,
    )
    expect((await request('PUT', '/v0/schedules', 'ops')).status).toBe(405)
  })

  test('guarded cookies need the console header, unknown paths are 404, wrong methods are 405', async () => {
    expect(
      (await request('POST', '/v0/schedules', 'member', '{}', true, false))
        .status,
    ).toBe(403)
    expect(
      (await request('POST', '/v0/schedules', 'member', '{}', true, true))
        .status,
    ).toBe(200)
    expect(
      (await request('POST', '/v0/schedules/s-one/other', 'ops')).status,
    ).toBe(404)
    expect(
      (await request('GET', '/v0/channels/c-one/test', 'ops')).status,
    ).toBe(405)
    expect((await request('DELETE', '/v0/schedules/%ZZ', 'ops')).status).toBe(
      400,
    )
  })
})
