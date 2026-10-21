// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings catalog (P40, `agent-settings.md` §2) against the write routes
 * `console.md` §5 documents, both ways: every documented `/v0` write is an
 * entry or a commented exemption, every entry's row is documented, and every
 * entry's request lands on its own row. Then what an approval binds: secrets
 * by tail and hash, the card's two lines, and the refusal of a change that
 * changes nothing.
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type JsonSchema,
  SETTING_AREAS,
  redactSecrets,
  schemaProblem,
  settingOperation,
  settingOperations,
  settingsBound,
  settingUnchanged,
} from '../src/settingsCatalog.js'

const WRITES = ['POST', 'PUT', 'DELETE'] as const

/**
 * Documented writes that are not settings, each with why. A new write route
 * goes into the catalog or onto this list, with its reason, in the same
 * change that documents it.
 */
const EXEMPT: readonly { readonly route: string; readonly why: string }[] = [
  // The conversation itself: what the agent is already doing.
  { route: 'POST /v0/chat/sessions', why: 'opening a conversation' },
  {
    route: 'POST /v0/chat/sessions/<会话 id>/messages',
    why: 'a line of the conversation',
  },
  // Background tasks and memory have their own agent tools (P29, P23).
  { route: 'POST /v0/tasks/<任务 id>/cancel', why: 'qianmo_task_cancel' },
  { route: 'POST /v0/memory', why: 'memory content, not a setting' },
  { route: 'PUT /v0/memory/<记忆 id>', why: 'memory content' },
  {
    route: 'POST /v0/memory/<记忆 id>/<forget|invalidate>',
    why: 'memory content',
  },
  // Messages and the console's own machinery.
  { route: 'POST /v0/wake', why: 'a message to an agent' },
  {
    route: 'POST /v0/agents/<地址>/heartbeat',
    why: 'the console renews its own leases',
  },
  // Reads that are POSTs: nothing is changed by them.
  {
    route: 'POST /v0/providers/nodes/<节点>/refresh',
    why: 'asks a node for its state',
  },
  {
    route: 'POST /v0/providers/probe',
    why: 'a probe of an unsaved candidate',
  },
  { route: 'POST /v0/providers/models', why: 'lists a candidate’s models' },
  { route: 'POST /v0/providers/preview', why: 'compiles a preview' },
  { route: 'POST /v0/providers/import/preview', why: 'previews an import' },
  {
    route: 'POST /v0/providers/profiles/<档案 id>/skip-probe',
    why: 'the page’s record of a switch it makes itself',
  },
  // Credentials that are not the console's: a job's grant, a platform's
  // signature, a device's token.
  {
    route: 'POST /v0/replicate/jobs/<作业>/models',
    why: 'the replicate job’s own one-use grant',
  },
  {
    route: 'POST /v0/billing/notify/{wechatpay,alipay}',
    why: 'payment platform callbacks',
  },
  // The relay (P17, P19) is driven by paired devices, not by the panel.
  { route: 'POST /v0/handoff/pair', why: 'a device exchanging its code' },
  { route: 'POST /v0/handoff/projects', why: 'device workflow' },
  {
    route:
      'POST /v0/handoff/git/<项目>.git/git-upload-pack、/v0/handoff/git/<项目>.git/git-receive-pack',
    why: 'git smart HTTP for devices',
  },
  { route: 'POST /v0/handoff', why: 'registering a handoff' },
  { route: 'POST /v0/handoff/<任务 id>/send', why: 'a line to the cloud side' },
  { route: 'POST /v0/handoff/<任务 id>/attach', why: 'where to attach' },
  { route: 'POST /v0/handoff/<任务 id>/clean', why: 'device bookkeeping' },
  { route: 'POST /v0/handoff/<任务 id>/return', why: 'device bookkeeping' },
]

// ---------------------------------------------------------------------------
// The table, read the way routeDocs.test.ts reads it
// ---------------------------------------------------------------------------

/** Stands in for `\\|` while a table row is split on its borders. */
const ESCAPED_PIPE = ''

/** `{a,b}` → two; `<a|b>` of words → each; any other `<x>` → `*`. */
function keysOf(method: string, path: string): readonly string[] {
  const parts = (path.split('?')[0] ?? '')
    .split('/')
    .filter(part => part.length > 0)
  let out: string[][] = [[]]
  for (const part of parts) {
    const braces = /^\{(.+)\}$/.exec(part)
    const angle = /^<(.+)>$/.exec(part)
    let options: string[]
    if (braces?.[1] !== undefined) options = braces[1].split(',')
    else if (angle?.[1] !== undefined) {
      const words = angle[1].split('|')
      options =
        words.length > 1 && words.every(word => /^[a-z]+$/.test(word))
          ? words
          : ['*']
    } else options = [part]
    out = out.flatMap(prefix => options.map(option => [...prefix, option]))
  }
  return out.map(segments => `${method} /${segments.join('/')}`)
}

/** A route as written here: `METHOD path`, or `METHOD path、path`. */
function routeKeys(route: string): readonly string[] {
  const [method, ...rest] = route.split(' ')
  return rest
    .join(' ')
    .split('、')
    .flatMap(path => keysOf(method ?? '', path))
}

function documentedWrites(): readonly string[] {
  const doc = readFileSync(
    fileURLToPath(new URL('../../../../docs/dev/console.md', import.meta.url)),
    'utf8',
  )
  const start = doc.indexOf('\n## §5 路由表')
  const end = doc.indexOf('\n### 5.1', start)
  if (start === -1 || end === -1) throw new Error('console.md §5 not found')
  const keys = new Set<string>()
  for (const line of doc.slice(start, end).split('\n')) {
    const cells = line.split('\\|').join(ESCAPED_PIPE).split('|')
    if (cells.length < 4) continue
    const methods = (cells[1] ?? '').trim().split(/[、/\s]+/)
    const pathCell = (cells[2] ?? '').split(ESCAPED_PIPE).join('|')
    for (const [, text] of pathCell.matchAll(/`([^`]+)`/g)) {
      if (text === undefined || !text.startsWith('/v0/')) continue
      for (const method of methods) {
        if (!(WRITES as readonly string[]).includes(method)) continue
        for (const key of keysOf(method, text)) keys.add(key)
      }
    }
  }
  return [...keys].sort()
}

/** Whether a concrete request lands on a key (`*` is any one segment). */
function lands(key: string, method: string, path: string): boolean {
  const [keyMethod, keyPath] = key.split(' ')
  if (keyMethod !== method) return false
  const want = (keyPath ?? '').split('/').filter(part => part !== '')
  const got = (path.split('?')[0] ?? '')
    .split('/')
    .filter(part => part !== '')
    .map(part => decodeURIComponent(part))
  return (
    want.length === got.length &&
    want.every((part, index) => part === '*' || part === got[index])
  )
}

// ---------------------------------------------------------------------------
// A value for every schema
// ---------------------------------------------------------------------------

const STRINGS = [
  'tokyo-1',
  'qianmo://tokyo-1/main',
  'node:tokyo-1',
  '08:00',
  '1.2.3',
  'model',
]

function sample(schema: JsonSchema | undefined): unknown {
  if (schema === undefined) return {}
  if (schema.anyOf !== undefined) return sample(schema.anyOf[0])
  if (schema.enum !== undefined) return schema.enum[0]
  const types =
    schema.type === undefined
      ? ['object']
      : typeof schema.type === 'string'
        ? [schema.type]
        : schema.type.filter(type => type !== 'null')
  switch (types[0]) {
    case 'string': {
      const pattern = schema.pattern
      return pattern === undefined
        ? 'tokyo-1'
        : (STRINGS.find(value => new RegExp(pattern).test(value)) ?? '')
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1
    case 'boolean':
      return true
    case 'array':
      return (schema.minItems ?? 0) > 0 ? [sample(schema.items)] : []
    default: {
      const out: Record<string, unknown> = {}
      for (const key of schema.required ?? [])
        out[key] = sample(schema.properties?.[key])
      const first = Object.keys(schema.properties ?? {})[0]
      if (
        Object.keys(out).length < (schema.minProperties ?? 0) &&
        first !== undefined
      )
        out[first] = sample(schema.properties?.[first])
      return out
    }
  }
}

function args(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

// ---------------------------------------------------------------------------

describe('the catalog is the write half of console.md §5 (P40 §2)', () => {
  const documented = documentedWrites()
  const catalogued = new Set(
    settingOperations().flatMap(op => routeKeys(op.route)),
  )
  const exempt = new Set(EXEMPT.flatMap(row => routeKeys(row.route)))

  test('the table has its writes', () => {
    expect(documented.length).toBeGreaterThan(80)
  })

  test('every documented write is catalogued or exempt with a reason', () => {
    expect(
      documented.filter(key => !catalogued.has(key) && !exempt.has(key)),
    ).toEqual([])
  })

  test('every entry and every exemption is a documented row, and none is both', () => {
    const rows = new Set(documented)
    expect([...catalogued].filter(key => !rows.has(key)).sort()).toEqual([])
    expect([...exempt].filter(key => !rows.has(key)).sort()).toEqual([])
    expect([...catalogued].filter(key => exempt.has(key))).toEqual([])
    expect(EXEMPT.every(row => row.why.length > 0)).toBe(true)
  })

  test('every entry’s request lands on its own row, from inputs its schemas accept', () => {
    const wrong: string[] = []
    for (const op of settingOperations()) {
      const target = args(sample(op.target))
      const input = args(sample(op.input))
      for (const [schema, value, where] of [
        [op.target, target, 'target'],
        [op.input, input, 'input'],
      ] as const) {
        const problem =
          schema === undefined ? null : schemaProblem(schema, value, where)
        if (problem !== null) wrong.push(`${op.id}: ${problem}`)
      }
      const request = op.request(target, input)
      if (
        !routeKeys(op.route).some(key =>
          lands(key, request.method, request.path),
        )
      )
        wrong.push(`${op.id}: ${request.method} ${request.path}`)
    }
    expect(wrong).toEqual([])
  })
})

describe('the entries (P40 §2)', () => {
  const ops = settingOperations()

  test('ids are unique, every area has entries, every entry names its page', () => {
    expect(new Set(ops.map(op => op.id)).size).toBe(ops.length)
    for (const area of Object.keys(SETTING_AREAS))
      expect(`${area} ${ops.some(op => op.area === area)}`).toBe(`${area} true`)
    for (const op of ops) {
      expect(op.id.startsWith(`${op.area}.`)).toBe(true)
      expect(op.page.startsWith('/')).toBe(true)
      expect(['ops', 'member']).toContain(op.role)
    }
  })

  test('only a person: exactly the set §2 names, each with where to go', () => {
    const personal = (id: string): boolean =>
      id.startsWith('approvals.') ||
      id.startsWith('accounts.') ||
      id.startsWith('billing.') ||
      id.startsWith('servers.replicate.') ||
      id.startsWith('connectors.device.') ||
      id === 'elevation.set' ||
      id === 'im.pairing'
    expect(ops.filter(op => op.human !== undefined).map(op => op.id)).toEqual(
      ops.filter(op => personal(op.id)).map(op => op.id),
    )
    for (const op of ops)
      if (op.human !== undefined) expect(op.human).toContain('/admin/')
    // Lowering a tier is an ordinary change; raising one is not.
    for (const id of [
      'elevation.off',
      'elevation.revoke',
      'elevation.revoke-all',
    ])
      expect(settingOperation(id)?.human).toBeUndefined()
    const off = settingOperation('elevation.off')
    expect(off?.input).toBeDefined()
    if (off?.input === undefined) return
    expect(schemaProblem(off.input, { tier: 'off' }, 'input')).toBeNull()
    expect(schemaProblem(off.input, { tier: 'auto' }, 'input')).not.toBeNull()
    expect(
      off.request({ node: 'n', agent: 'a' }, { tier: 'off' }).body,
    ).toEqual({ tier: 'off' })
  })

  test('the words keep the console’s copy rules', () => {
    for (const op of ops)
      for (const words of [op.label, op.description, op.human ?? ''])
        expect(`${op.id} ${/[。，、！!]/.test(words)}`).toBe(`${op.id} false`)
  })
})

describe('what an approval binds (P40 §4.2)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  test('a secret becomes its tail and its hash, wherever the path says', () => {
    expect(
      redactSecrets(
        {
          secrets: { k1: 'sk-live-0123456789abcd', k2: '' },
          env: { A: 'short', B: null },
          name: 'gw',
        },
        ['secrets.*', 'env.*'],
      ),
    ).toEqual({
      secrets: {
        k1: { $secret: '…abcd', sha256: sha('sk-live-0123456789abcd') },
        k2: '',
      },
      env: { A: { $secret: '…', sha256: sha('short') }, B: null },
      name: 'gw',
    })
  })

  test('the card reads the change, keeps secrets masked and stays short', () => {
    const op = settingOperation('magpie.connect')
    if (op === undefined) throw new Error('missing entry')
    const input = redactSecrets(
      {
        gatewayUrl: 'https://gw.example',
        managementUrl: 'https://manage.example',
        managementKey: 'mk-secret-value-9876',
      },
      op.secrets,
    )
    const bound = settingsBound(op, null, input, {
      gatewayUrl: 'https://old.example',
      managementUrl: 'https://manage.example',
      keySet: true,
    })
    expect(bound.id).toBe('magpie.connect')
    expect(bound.target).toBeNull()
    expect(bound.card).toMatchObject({
      area: '网关',
      label: '网关连接',
      role: 'ops',
      page: '/admin/magpie',
    })
    expect(bound.card.current).toContain('https://old.example')
    expect(bound.card.next).toContain('…9876')
    expect(JSON.stringify(bound)).not.toContain('mk-secret-value-9876')

    const note = settingOperation('servers.note')
    if (note === undefined) throw new Error('missing entry')
    const long = settingsBound(
      note,
      { server: 'p11' },
      { note: 'x'.repeat(500) },
      { note: 'y'.repeat(500) },
    )
    expect([...(long.card.current ?? '')].length).toBeLessThanOrEqual(200)
    expect([...long.card.next].length).toBeLessThanOrEqual(200)
    expect(long.card.title).toContain('p11')
    expect(
      settingsBound(
        settingOperation('providers.default') ?? note,
        null,
        { profileId: 'gw-claude' },
        { profileId: null },
      ).card.title,
    ).toBe('把默认模型服务改成 gw-claude')
  })

  test('a change that changes nothing is recognised, a secret never is', () => {
    const op = settingOperation('providers.default')
    const connect = settingOperation('magpie.connect')
    if (op === undefined || connect === undefined)
      throw new Error('missing entry')
    expect(settingUnchanged(op, { profileId: 'a' }, { profileId: 'a' })).toBe(
      true,
    )
    expect(settingUnchanged(op, { profileId: 'b' }, { profileId: 'a' })).toBe(
      false,
    )
    expect(
      settingUnchanged(
        connect,
        redactSecrets({ gatewayUrl: 'g', managementKey: 'k' }, connect.secrets),
        { gatewayUrl: 'g', managementKey: 'k' },
      ),
    ).toBe(false)
  })

  test('the schema check names the field', () => {
    const op = settingOperation('desktop.set')
    if (op?.input === undefined) throw new Error('missing entry')
    expect(schemaProblem(op.input, {}, 'input')).toBe('input 至少要给一项')
    expect(schemaProblem(op.input, { confirm: 'never' }, 'input')).toContain(
      'input.confirm',
    )
    expect(schemaProblem(op.input, { colour: true }, 'input')).toBe(
      'input.colour 不认识',
    )
    expect(schemaProblem(op.input, { apps: ['a', 'b'] }, 'input')).toBeNull()
  })
})
