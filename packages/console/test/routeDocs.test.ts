// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `docs/dev/console.md` §5's route table against the routes the console
 * actually answers, both ways (P18.11):
 *
 * - **documented ⊆ answered** — every row, its placeholders filled with a
 *   sample, is routed on a console with every port wired: the answer is not
 *   the router's `unknown path` 404 and not a 405. A domain answer (a 404
 *   for a trace that is not there, a 501 for a port not configured, a 409)
 *   still means the route exists.
 * - **answered ⊆ documented** — every head the console claims (`/v0/<head>`,
 *   `/fragments/<head>`, each page's first segment, and the doors `http.ts`
 *   keeps for itself) is walked to one level below the deepest row the table
 *   documents for it, each position drawn from the literals the owning module
 *   compares path segments against, the table's own literals and one sample
 *   segment; every (method, path) that is routed has to match a row.
 *
 * The blind spot is a sub-path dispatched by a literal the scan never
 * guesses: one that is neither compared with `===` / `!==` / `case` in the
 * owning module's source nor written in the table. Heads themselves are not
 * guessed — they come from the route table in `routes/index.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../src/routes/index.js'
import type { RouteModule } from '../src/routes/types.js'
import { CONSOLE_HEADER, accountsHarness, person } from './accountsHarness.js'
import { PLANNER, StatefulLifecycle } from './lifecycleFake.js'
import { MemoryActionLedger } from './memoryActions.js'
import { PageAudit, PageRegistry, TRACE } from './pageHarness.js'
import { FakeProviders } from './providersFake.js'
import { MemoryNotify } from './watchFakes.js'

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const
type Method = (typeof METHODS)[number]

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** One segment of a documented path: a set of literals, or any segment. */
type Segment = { readonly any: true } | { readonly one: readonly string[] }

interface Row {
  readonly method: Method
  readonly text: string
  readonly segments: readonly Segment[]
}

/** `{a,b}` → two paths; `<x>` → any; `<a\|b>` → a or b. */
function expand(path: string): readonly (readonly Segment[])[] {
  const bare = path.split('?')[0] ?? ''
  const parts = bare.split('/').filter(part => part.length > 0)
  let out: Segment[][] = [[]]
  for (const part of parts) {
    let options: Segment[]
    const braces = /^\{(.+)\}$/.exec(part)
    const angle = /^<(.+)>$/.exec(part)
    if (braces?.[1] !== undefined) {
      options = braces[1].split(',').map(word => ({ one: [word] }))
    } else if (angle?.[1] !== undefined) {
      const words = angle[1].split('|')
      options = [
        words.length > 1 && words.every(word => /^[a-z]+$/.test(word))
          ? { one: words }
          : { any: true },
      ]
    } else {
      options = [{ one: [part] }]
    }
    out = out.flatMap(prefix => options.map(option => [...prefix, option]))
  }
  return out
}

/** Stands in for `\\|` while a table row is split on its borders. */
const ESCAPED_PIPE = '\uE000'

function documentedRows(): readonly Row[] {
  const doc = source('../../../docs/dev/console.md')
  const start = doc.indexOf('\n## §5 路由表')
  const end = doc.indexOf('\n### 5.1', start)
  if (start === -1 || end === -1) throw new Error('console.md §5 not found')
  const rows: Row[] = []
  for (const line of doc.slice(start, end).split('\n')) {
    // An escaped pipe inside a cell is part of the cell, not a border.
    const cells = line.split('\\|').join(ESCAPED_PIPE).split('|')
    if (cells.length < 4) continue
    const methods = (cells[1] ?? '').trim().split(/[、/\s]+/)
    if (!methods.every(m => (METHODS as readonly string[]).includes(m))) {
      continue
    }
    const pathCell = (cells[2] ?? '').split(ESCAPED_PIPE).join('|')
    for (const [, text] of pathCell.matchAll(/`([^`]+)`/g)) {
      if (text === undefined || !text.startsWith('/')) continue
      for (const segments of expand(text)) {
        for (const method of methods as Method[]) {
          rows.push({ method, text, segments })
        }
      }
    }
  }
  return rows
}

function matches(row: Row, method: Method, path: readonly string[]): boolean {
  if (row.method !== method || row.segments.length !== path.length) {
    return false
  }
  return row.segments.every((segment, index) => {
    if ('any' in segment) return true
    return segment.one.includes(decodeURIComponent(path[index] ?? ''))
  })
}

// ---------------------------------------------------------------------------
// The console, with every port the table speaks of
// ---------------------------------------------------------------------------

/**
 * Every port wired, and the one caller every gate lets through: a personal
 * `ops` account, on a Bearer. A gate that refuses before the path is
 * resolved (the model-service writes refuse the admin token with a 403
 * whatever follows) would otherwise make every path under it look routed.
 */
async function wired(): Promise<{
  readonly handle: (request: Request) => Promise<Response>
  readonly bearer: string
}> {
  const h = accountsHarness({
    deps: {
      registry: new PageRegistry(),
      audit: new PageAudit(),
      lifecycle: new StatefulLifecycle(),
      actions: new MemoryActionLedger(),
      notify: new MemoryNotify([]),
      providers: new FakeProviders(),
      nodeServers: [{ node: 'tokyo-1', server: 'p11' }],
    },
  })
  const ops = await person(h.handle, 'ops')
  return { handle: h.handle, bearer: ops.credential }
}

type Verdict = 'routed' | 'unrouted' | 'method'

async function verdict(
  wiredConsole: Awaited<ReturnType<typeof wired>>,
  method: Method,
  path: string,
): Promise<Verdict> {
  const response = await wiredConsole.handle(
    new Request(`http://console.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${wiredConsole.bearer}`,
        accept: 'application/json',
        [CONSOLE_HEADER]: '1',
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    }),
  )
  if (response.status === 405) {
    await response.body?.cancel()
    return 'method'
  }
  if (response.status !== 404) {
    // An event stream never ends on its own.
    await response.body?.cancel()
    return 'routed'
  }
  const text = await response.text()
  return text.includes('"unknown path: ') ? 'unrouted' : 'routed'
}

/** A value for a placeholder, one the wired console knows where it matters. */
function sample(text: string, index: number): string {
  const found = [...text.matchAll(/<([^>]+)>/g)][index]?.[1] ?? ''
  const samples: Record<string, string> = {
    节点: 'tokyo-1',
    地址: encodeURIComponent(PLANNER),
    traceId: TRACE,
  }
  return samples[found] ?? `sample-${index}`
}

function concrete(row: Row): string {
  let slot = 0
  const parts = row.segments.map(segment => {
    if ('one' in segment) return segment.one[0] ?? ''
    const value = sample(row.text, slot)
    slot += 1
    return value
  })
  return `/${parts.join('/')}`
}

// ---------------------------------------------------------------------------
// What the scan walks
// ---------------------------------------------------------------------------

/** Literals a module's source compares path segments against. */
function literalsOf(file: string): readonly string[] {
  const text = source(file)
  const words = new Set<string>()
  for (const match of text.matchAll(
    /(?:===|!==)\s*'([^'\n]+)'|case\s+'([^'\n]+)'/g,
  )) {
    const word = match[1] ?? match[2] ?? ''
    if (/^[a-z][a-z0-9._-]*$/.test(word)) words.add(word)
  }
  return [...words]
}

/** The module's own file and the sibling route files it imports. */
function filesOf(module: RouteModule | undefined): readonly string[] {
  if (module === undefined) {
    return ['../src/http.ts', '../src/accountsHttp.ts']
  }
  const own = `../src/routes/${module.area.id}.ts`
  const imports = [...source(own).matchAll(/from '\.\/(\w+)\.js'/g)]
    .map(match => match[1] ?? '')
    .filter(name => !['shared', 'types', 'index'].includes(name))
    .map(name => `../src/routes/${name}.ts`)
  return [own, ...imports]
}

interface Root {
  readonly prefix: readonly string[]
  readonly vocabulary: readonly string[]
}

function roots(rows: readonly Row[]): readonly Root[] {
  const out: Root[] = []
  const add = (prefix: readonly string[], module: RouteModule | undefined) => {
    const documented = rows
      .filter(row =>
        prefix.every((word, index) => {
          const segment = row.segments[index]
          return segment !== undefined && 'one' in segment
            ? segment.one.includes(word)
            : false
        }),
      )
      .flatMap(row => row.segments.slice(prefix.length))
      .flatMap(segment => ('one' in segment ? segment.one : []))
    const vocabulary = new Set<string>([
      ...filesOf(module).flatMap(literalsOf),
      ...documented,
      'zz-sample',
    ])
    out.push({ prefix, vocabulary: [...vocabulary] })
  }
  for (const module of ROUTES) {
    for (const head of module.api?.heads ?? []) add(['v0', head], module)
    for (const head of module.fragments?.heads ?? []) {
      add(['fragments', head], module)
    }
    const href = module.area.href.split('/').filter(part => part !== '')
    // `/` is the overview alone; what is under it is every other root.
    if (href.length > 0) add(href, module)
  }
  // The doors and the heads `http.ts` keeps for itself.
  for (const prefix of [
    ['login'],
    ['logout'],
    ['invite'],
    ['assets'],
    ['v0', 'health'],
    ['v0', 'accounts'],
  ]) {
    add(prefix, undefined)
  }
  return out
}

/** Whether some row goes deeper than `path` and agrees with it so far. */
function underARow(rows: readonly Row[], path: readonly string[]): boolean {
  return rows.some(
    row =>
      row.segments.length > path.length &&
      path.every((word, index) => {
        const segment = row.segments[index]
        if (segment === undefined) return false
        return 'any' in segment || segment.one.includes(word)
      }),
  )
}

/** How deep the table goes under a prefix. */
function depthUnder(rows: readonly Row[], prefix: readonly string[]): number {
  let deepest = prefix.length
  for (const row of rows) {
    const under = prefix.every((word, index) => {
      const segment = row.segments[index]
      return segment !== undefined && 'one' in segment
        ? segment.one.includes(word)
        : false
    })
    if (under) deepest = Math.max(deepest, row.segments.length)
  }
  return deepest
}

describe('console.md §5 is the route table (P18.11)', () => {
  const rows = documentedRows()

  test('the table parses into rows', () => {
    expect(rows.length).toBeGreaterThan(60)
  })

  test('every documented row is routed', async () => {
    const h = await wired()
    const missing: string[] = []
    for (const row of rows) {
      const path = concrete(row)
      const seen = await verdict(h, row.method, path)
      if (seen !== 'routed') missing.push(`${row.method} ${path} → ${seen}`)
    }
    expect(missing).toEqual([])
  })

  test('every routed path is documented', async () => {
    const h = await wired()
    const extra = new Set<string>()
    let probes = 0
    const probe = async (path: readonly string[]): Promise<boolean> => {
      let routed = false
      for (const method of METHODS) {
        probes += 1
        const seen = await verdict(h, method, `/${path.join('/')}`)
        if (seen !== 'routed') continue
        routed = true
        if (!rows.some(row => matches(row, method, path))) {
          extra.add(`${method} /${path.join('/')}`)
        }
      }
      return routed
    }

    // The heads nobody listed: every literal anywhere, as a first segment
    // and under `/v0` and `/fragments`.
    const everyWord = new Set<string>(['zz-sample'])
    for (const root of roots(rows)) {
      for (const word of root.vocabulary) everyWord.add(word)
      for (const word of root.prefix) everyWord.add(word)
    }
    await probe([])
    for (const word of everyWord) {
      await probe([word])
      await probe(['v0', word])
      await probe(['fragments', word])
    }

    for (const root of roots(rows)) {
      // Two levels under every head are walked whole, even where the table
      // has nothing, so a head documented by nothing still shows what it
      // answers. Deeper, a path is walked on only if it is routed or a row
      // goes on below it, and never more than one level past the deepest
      // row: an undocumented route under an unrouted, undocumented
      // intermediate path that deep is the scan's blind spot.
      const whole = root.prefix.length + 2
      const limit = Math.max(depthUnder(rows, root.prefix), whole)
      let frontier: string[][] = [[...root.prefix]]
      for (let depth = root.prefix.length; depth <= limit + 1; depth += 1) {
        const next: string[][] = []
        for (const path of frontier) {
          const routed = await probe(path)
          const onward = depth < whole || routed || underARow(rows, path)
          if (onward && depth <= limit) {
            for (const word of root.vocabulary) next.push([...path, word])
          }
        }
        if (next.length === 0) break
        frontier = next
      }
    }
    console.log(`[route docs] ${rows.length} rows, ${probes} probes`)
    expect([...extra].sort()).toEqual([])
    expect(probes).toBeGreaterThan(1000)
  }, 120_000)
})
