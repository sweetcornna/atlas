// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P37.17 B — work files on the node (`work-tasks.md` §5): the three host
 * tools write into the conversation's own folder, the two control
 * operations list and fetch only from its outputs, and nothing outside it
 * can be named — not with `..`, not through a link, not past 50 MiB.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { adaptSchemaForStrict } from '@oh-my-pi/pi-ai'
import { WORK_FILE_MAX_BYTES, type WorkFileRef } from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { ControlRegistry } from '../../src/host/control.js'
import { WORK_CHUNK_BYTES, WorkFolder } from '../../src/host/workFiles.js'
import { findPrintBrowser } from '../../src/host/workPdf.js'
import {
  fileNameOf,
  NodeWork,
  WORK_TOOL_NAMES,
} from '../../src/host/workTools.js'

const SESSION = 'b7a1c3d4-0000-4000-8000-000000000001'
const CTX = { agent: 'ops', sessionId: 'omp-1' }
const CONTROL = { peer: 'hub', actor: 'system:work', taskId: 'c-1' }

let root: string
let workspace: string
let outside: string
let calls: { op: string; args: Record<string, unknown>; agent: string }[]
let hubAnswer: ControlOutcome
let stopped: boolean
let audits: { kind: string; detail: Record<string, unknown> }[]

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-work-')))
  workspace = path.join(root, 'workspace')
  outside = path.join(root, 'outside')
  fs.mkdirSync(workspace)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  calls = []
  hubAnswer = { ok: true, value: { delivered: true } }
  stopped = false
  audits = []
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function work(
  options: { origin?: string | null; browser?: string | null } = {},
) {
  const contextId = options.origin === undefined ? SESSION : options.origin
  return new NodeWork({
    agents: () => [{ agent: 'ops', cwd: workspace }],
    call: async (op, args, callOptions) => {
      calls.push({ op, args, agent: callOptions.agent })
      return hubAnswer
    },
    origin: ctx =>
      contextId === null || ctx.sessionId !== CTX.sessionId
        ? null
        : { contextId, taskId: 'task-1' },
    stopped: () => stopped,
    audit: (kind, detail) => audits.push({ kind, detail }),
    browser: options.browser === undefined ? null : options.browser,
  })
}

function tool(node: NodeWork, name: string) {
  const found = node.tools().find(one => one.name === name)
  if (found === undefined) throw new Error(name)
  return found
}

const DECK = {
  kind: 'slides',
  file: '季度汇报',
  spec: {
    title: '季度汇报',
    slides: [
      { layout: 'title', title: '季度汇报', subtitle: '第三季度' },
      { layout: 'bullets', title: '要点', bullets: ['收入增长 12%'] },
    ],
  },
}

function outputs(...parts: string[]): string {
  return path.join(workspace, 'qmo-work', SESSION, 'outputs', ...parts)
}

async function list(node: NodeWork): Promise<{
  files: { name: string; preview: boolean; kind: string; tooLarge?: true }[]
  truncated: boolean
}> {
  const outcome = await node.handle(
    'work.list',
    { agent: 'ops', session: SESSION },
    CONTROL,
  )
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.value as never
}

async function readWhole(
  node: NodeWork,
  name: string,
  view: 'file' | 'preview' = 'file',
): Promise<{ bytes: Buffer; chunks: number; mime: string }> {
  const parts: Buffer[] = []
  let offset = 0
  let etag: string | undefined
  let mime = ''
  for (;;) {
    const outcome = await node.handle(
      'work.read',
      {
        agent: 'ops',
        session: SESSION,
        name,
        view,
        offset,
        ...(etag === undefined ? {} : { etag }),
      },
      CONTROL,
    )
    if (!outcome.ok) throw new Error(outcome.code)
    const value = outcome.value as {
      data: string
      etag: string
      eof: boolean
      mime: string
    }
    const data = Buffer.from(value.data, 'base64')
    parts.push(data)
    offset += data.byteLength
    etag = value.etag
    mime = value.mime
    if (value.eof) break
  }
  return { bytes: Buffer.concat(parts), chunks: parts.length, mime }
}

async function read(
  node: NodeWork,
  args: Record<string, unknown>,
): Promise<ControlOutcome> {
  return await node.handle(
    'work.read',
    { agent: 'ops', session: SESSION, view: 'file', offset: 0, ...args },
    CONTROL,
  )
}

describe('making, writing and delivering', () => {
  test('a deck lands in the outputs folder with its preview and description; folders 0700, files 0600', async () => {
    const node = work()
    const made = await tool(node, WORK_TOOL_NAMES.make).handler(DECK, CTX)
    expect(made).toMatchObject({ ok: true })
    expect(made.text).toContain('Made 季度汇报.pptx (2 slides')
    const file = outputs('季度汇报.pptx')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(workspace, 'qmo-work')).mode & 0o777).toBe(
      0o700,
    )
    const base = path.join(workspace, 'qmo-work', SESSION)
    expect(
      fs.readFileSync(
        path.join(base, 'previews', '季度汇报.pptx.html'),
        'utf8',
      ),
    ).toContain('<h2>要点</h2>')
    const source = JSON.parse(
      fs.readFileSync(path.join(base, 'sources', '季度汇报.pptx.json'), 'utf8'),
    )
    expect(source).toMatchObject({ v: 1, kind: 'slides' })
    expect(audits.map(one => one.kind)).toEqual(['work.document'])
    // No temporary file is left behind.
    expect(fs.readdirSync(outputs())).toEqual(['季度汇报.pptx'])
    const listed = await list(node)
    expect(listed.files).toEqual([
      expect.objectContaining({
        name: '季度汇报.pptx',
        kind: 'presentation',
        preview: true,
      }),
    ])
    // Made again under the same name: replaced, not duplicated.
    const again = await tool(node, WORK_TOOL_NAMES.make).handler(DECK, CTX)
    expect(again.ok).toBe(true)
    expect(fs.readdirSync(outputs())).toEqual(['季度汇报.pptx'])
  })

  test('a bad description is answered with where the problems are, and nothing is written', async () => {
    const node = work()
    const made = await tool(node, WORK_TOOL_NAMES.make).handler(
      {
        kind: 'slides',
        spec: { title: 't', slides: [{ layout: 'bullets', title: 'x' }] },
      },
      CTX,
    )
    expect(made.ok).toBe(false)
    expect(made.text).toContain('spec.slides.0.bullets')
    expect(fs.existsSync(path.join(workspace, 'qmo-work'))).toBe(false)
  })

  test('the file name stays in the outputs folder', async () => {
    const node = work()
    for (const file of ['../escape', '/etc/x', 'a\\b', 'a/b/c/d/e', 'con']) {
      const made = await tool(node, WORK_TOOL_NAMES.make).handler(
        { ...DECK, file },
        CTX,
      )
      expect(made.ok).toBe(false)
    }
    const nested = await tool(node, WORK_TOOL_NAMES.make).handler(
      { ...DECK, file: '汇报/终稿.pptx' },
      CTX,
    )
    expect(nested.ok).toBe(true)
    expect(fs.existsSync(outputs('汇报', '终稿.pptx'))).toBe(true)
    expect(fs.readdirSync(root).sort()).toEqual(['outside', 'workspace'])
    expect(fileNameOf('a/b:c?\u0001', 'docx')).toBe('a-b-c-.docx')
  })

  test('a web page is written as text and delivered with its digest and a preview', async () => {
    const node = work()
    const html = '<!doctype html><title>招新</title><h1>招新</h1>'
    const wrote = await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: '招新页.html', content: html },
      CTX,
    )
    expect(wrote.ok).toBe(true)
    const refused = await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'run.sh', content: 'rm -rf /' },
      CTX,
    )
    expect(refused.ok).toBe(false)
    const delivered = await tool(node, WORK_TOOL_NAMES.deliver).handler(
      { files: [{ name: '招新页.html', title: '招新页' }] },
      CTX,
    )
    expect(delivered.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.op).toBe('work.deliver')
    expect(calls[0]?.agent).toBe('ops')
    const files = calls[0]?.args.files as WorkFileRef[]
    expect(calls[0]?.args).toMatchObject({
      contextId: SESSION,
      taskId: 'task-1',
    })
    expect(files).toEqual([
      {
        name: '招新页.html',
        size: Buffer.byteLength(html),
        kind: 'webpage',
        mime: 'text/html; charset=utf-8',
        sha256: createHash('sha256').update(html).digest('hex'),
        preview: true,
        title: '招新页',
      },
    ])
    expect(audits.map(one => one.kind)).toEqual(['work.write', 'work.deliver'])
  })

  test('delivery checks every file first and says why nothing went', async () => {
    const node = work()
    await tool(node, WORK_TOOL_NAMES.make).handler(DECK, CTX)
    const missing = await tool(node, WORK_TOOL_NAMES.deliver).handler(
      { files: [{ name: '季度汇报.pptx' }, { name: 'nope.pdf' }] },
      CTX,
    )
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain('nope.pdf: no such file')
    expect(calls).toHaveLength(0)
    hubAnswer = { ok: false, code: 'rejected', message: '这一轮已经结束' }
    const late = await tool(node, WORK_TOOL_NAMES.deliver).handler(
      { files: [{ name: 'outputs/季度汇报.pptx' }] },
      CTX,
    )
    expect(late.ok).toBe(false)
    expect(late.text).toContain('这一轮已经结束')
  })

  test('outside a console conversation, under ESTOP, or with an unusable id the tools refuse', async () => {
    for (const [node, why] of [
      [work({ origin: null }), 'cannot store files'],
      [work({ origin: 'has.dot' }), 'cannot store files'],
    ] as const) {
      for (const name of Object.values(WORK_TOOL_NAMES)) {
        const result = await tool(node, name).handler({}, CTX)
        expect(result.ok).toBe(false)
        expect(result.text).toContain(why)
      }
    }
    stopped = true
    const halted = await tool(work(), WORK_TOOL_NAMES.make).handler(DECK, CTX)
    expect(halted.text).toContain('emergency stop')
    expect(fs.existsSync(path.join(workspace, 'qmo-work'))).toBe(false)
  })

  test('PDF: no browser says so and makes the rest', async () => {
    const node = work({ browser: null })
    const made = await tool(node, WORK_TOOL_NAMES.make).handler(
      { ...DECK, pdf: true },
      CTX,
    )
    expect(made).toMatchObject({ ok: true })
    expect(made.text).toContain(
      'PDF not made: this node has no Chrome or Chromium',
    )
    expect(fs.readdirSync(outputs())).toEqual(['季度汇报.pptx'])
  })

  const browser = findPrintBrowser()
  test.skipIf(browser === null)(
    'PDF: with this machine’s browser, a real PDF beside the deck',
    async () => {
      const node = work({ browser })
      const made = await tool(node, WORK_TOOL_NAMES.make).handler(
        { ...DECK, pdf: true },
        CTX,
      )
      expect(made).toMatchObject({ ok: true })
      expect(made.text).toContain('Printed 季度汇报.pdf')
      const pdf = fs.readFileSync(outputs('季度汇报.pdf'))
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      const listed = await list(node)
      expect(
        listed.files.find(one => one.name === '季度汇报.pdf'),
      ).toMatchObject({
        kind: 'pdf',
        preview: false,
      })
    },
    90_000,
  )

  test('tool schemas: the description stays open, the delivery list stays shaped', () => {
    const tools = work().tools()
    const make = adaptSchemaForStrict(
      tools[0]!.parameters as Record<string, unknown>,
      true,
    )
    const spec = (
      make.schema.properties as Record<string, Record<string, unknown>>
    ).spec
    expect(spec?.additionalProperties).not.toBe(false)
    const deliver = adaptSchemaForStrict(
      tools[2]!.parameters as Record<string, unknown>,
      true,
    )
    expect(deliver.strict).toBe(true)
  })
})

describe('listing and fetching: only this session’s outputs', () => {
  test('a file comes back whole in 160 KiB chunks, and a change half way is refused', async () => {
    const node = work()
    const content = 'x'.repeat(WORK_CHUNK_BYTES * 2 + 1234)
    await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'notes.md', content },
      CTX,
    )
    const whole = await readWhole(node, 'notes.md')
    expect(whole.chunks).toBe(3)
    expect(whole.bytes.toString()).toBe(content)
    expect(whole.mime).toBe('text/markdown; charset=utf-8')
    const first = await read(node, { name: 'notes.md' })
    if (!first.ok) throw new Error('first')
    const etag = (first.value as { etag: string }).etag
    await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'notes.md', content: `${content}!` },
      CTX,
    )
    expect(
      await read(node, { name: 'notes.md', offset: WORK_CHUNK_BYTES, etag }),
    ).toMatchObject({ ok: false, code: 'changed' })
  })

  test('previews: a made deck its drawn page, Markdown drawn once per version, a PDF none', async () => {
    const node = work()
    await tool(node, WORK_TOOL_NAMES.make).handler(DECK, CTX)
    const deck = await readWhole(node, '季度汇报.pptx', 'preview')
    expect(deck.mime).toBe('text/html; charset=utf-8')
    expect(deck.bytes.toString()).toContain('<h2>要点</h2>')
    await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'a.md', content: '# <b>标题</b>' },
      CTX,
    )
    const md = await readWhole(node, 'a.md', 'preview')
    expect(md.bytes.toString()).toContain('&lt;b&gt;标题&lt;/b&gt;')
    fs.writeFileSync(outputs('x.pdf'), '%PDF-1.4')
    expect(await read(node, { name: 'x.pdf', view: 'preview' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    // The deck rewritten some other way: its drawn page no longer stands for it.
    fs.writeFileSync(outputs('季度汇报.pptx'), 'not the deck')
    expect(
      await read(node, { name: '季度汇报.pptx', view: 'preview' }),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(
      (await list(node)).files.find(one => one.name === '季度汇报.pptx')
        ?.preview,
    ).toBe(false)
  })

  test('.., absolute paths, backslashes and other sessions are not names', async () => {
    const node = work()
    await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'a.txt', content: 'a' },
      CTX,
    )
    for (const name of [
      '../a.txt',
      '/etc/passwd',
      '..\\a.txt',
      'a/../a.txt',
      '.',
      'a.txt/',
    ])
      expect(await read(node, { name })).toMatchObject({
        ok: false,
        code: 'invalid',
      })
    for (const session of ['../x', 'a/b', '', '.hidden'])
      expect(
        await node.handle(
          'work.read',
          { agent: 'ops', session, name: 'a.txt', view: 'file', offset: 0 },
          CONTROL,
        ),
      ).toMatchObject({ ok: false, code: 'invalid' })
    expect(
      await node.handle(
        'work.list',
        { agent: 'someone-else', session: SESSION },
        CONTROL,
      ),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(await read(node, { name: 'a.txt', extra: 1 })).toMatchObject({
      ok: false,
      code: 'invalid',
    })
  })

  test('links are refused: a linked file, a hard link, a linked folder, a linked outputs folder', async () => {
    const node = work()
    await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'real.txt', content: 'real' },
      CTX,
    )
    fs.symlinkSync(path.join(outside, 'secret.txt'), outputs('link.txt'))
    fs.linkSync(path.join(outside, 'secret.txt'), outputs('hard.txt'))
    fs.symlinkSync(outside, outputs('dir'))
    for (const name of ['link.txt', 'hard.txt', 'dir/secret.txt']) {
      expect(await read(node, { name })).toMatchObject({
        ok: false,
        code: 'not_found',
      })
      expect(await read(node, { name, view: 'preview' })).toMatchObject({
        ok: false,
        code: 'not_found',
      })
    }
    expect((await list(node)).files.map(one => one.name)).toEqual(['real.txt'])
    const deliver = await tool(node, WORK_TOOL_NAMES.deliver).handler(
      { files: [{ name: 'link.txt' }] },
      CTX,
    )
    expect(deliver.ok).toBe(false)
    expect(calls).toHaveLength(0)
    // The whole outputs folder swapped for a link to somewhere else.
    const other = 'b7a1c3d4-0000-4000-8000-000000000002'
    fs.mkdirSync(path.join(workspace, 'qmo-work', other), { recursive: true })
    fs.symlinkSync(outside, path.join(workspace, 'qmo-work', other, 'outputs'))
    for (const op of ['work.list', 'work.read'])
      expect(
        await node.handle(
          op,
          {
            agent: 'ops',
            session: other,
            name: 'secret.txt',
            view: 'file',
            offset: 0,
            ...(op === 'work.list' ? {} : {}),
          },
          CONTROL,
        ),
      ).toMatchObject({ ok: false })
    expect(
      await node.handle('work.list', { agent: 'ops', session: other }, CONTROL),
    ).toMatchObject({ ok: false, code: 'not_found' })
  })

  test('50 MiB: a larger file is listed as too large and cannot be fetched, previewed or delivered', async () => {
    const node = work()
    await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'small.txt', content: 's' },
      CTX,
    )
    const big = outputs('big.csv')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, WORK_FILE_MAX_BYTES + 1)
    fs.chmodSync(big, 0o600)
    const listed = await list(node)
    expect(listed.files.find(one => one.name === 'big.csv')).toMatchObject({
      tooLarge: true,
      preview: false,
    })
    expect(await read(node, { name: 'big.csv' })).toMatchObject({
      ok: false,
      code: 'limit',
    })
    expect(
      await read(node, { name: 'big.csv', view: 'preview' }),
    ).toMatchObject({ ok: false, code: 'limit' })
    const deliver = await tool(node, WORK_TOOL_NAMES.deliver).handler(
      { files: [{ name: 'big.csv' }] },
      CTX,
    )
    expect(deliver.text).toContain('larger than 50 MiB')
    expect(() =>
      new WorkFolder(workspace, SESSION).write(
        'outputs',
        'huge.bin',
        new Uint8Array(WORK_FILE_MAX_BYTES + 1),
      ),
    ).toThrow('limit')
    // Exactly the limit is still a file.
    fs.truncateSync(big, WORK_FILE_MAX_BYTES)
    const head = await read(node, { name: 'big.csv' })
    expect(head.ok).toBe(true)
  })

  test('a session that never wrote lists nothing; listings are newest first and four deep', async () => {
    const node = work()
    expect(await list(node)).toEqual({ files: [], truncated: false })
    const folder = new WorkFolder(workspace, SESSION)
    folder.write('outputs', 'old.txt', new TextEncoder().encode('o'))
    fs.utimesSync(outputs('old.txt'), new Date(1_000_000), new Date(1_000_000))
    folder.write('outputs', 'a/b/c/deep.txt', new TextEncoder().encode('d'))
    fs.mkdirSync(outputs('a', 'b', 'c', 'd'), { mode: 0o700 })
    fs.writeFileSync(outputs('a', 'b', 'c', 'd', 'too-deep.txt'), 'x', {
      mode: 0o600,
    })
    expect((await list(node)).files.map(one => one.name)).toEqual([
      'a/b/c/deep.txt',
      'old.txt',
    ])
  })

  test('under ESTOP list and read still answer; nothing else is registered', async () => {
    const node = work()
    await tool(node, WORK_TOOL_NAMES.write).handler(
      { file: 'a.txt', content: 'a' },
      CTX,
    )
    const registry = new ControlRegistry({
      estopEngaged: () => true,
      ledgerPath: path.join(root, 'control.sqlite'),
    })
    node.register(registry)
    expect(
      await registry.handle(
        'work.list',
        { agent: 'ops', session: SESSION },
        CONTROL,
      ),
    ).toMatchObject({ ok: true })
    expect(
      await registry.handle(
        'work.read',
        {
          agent: 'ops',
          session: SESSION,
          name: 'a.txt',
          view: 'file',
          offset: 0,
        },
        CONTROL,
      ),
    ).toMatchObject({ ok: true })
    expect(await registry.handle('work.write', {}, CONTROL)).toMatchObject({
      ok: false,
    })
    await registry.close()
  })
})
