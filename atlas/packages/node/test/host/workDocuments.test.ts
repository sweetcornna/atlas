// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P37.17 B — the three office files and their previews from one
 * description (`work-tasks.md` §5.3). Each file is opened again with a
 * reader library (omp's markit, which is what the agent itself reads office
 * files with), and every string of the description must be in the reader's
 * text and in the preview: the two say the same thing. Previews carry no
 * script; the files name the Chinese typeface.
 */

import { describe, expect, test } from 'bun:test'
import { ZipPackage } from '@oh-my-pi/pi-utils/ar'
import { Markit } from '@oh-my-pi/pi-coding-agent/markit'
import {
  chartSvg,
  parseDelimited,
  plainPreviewKind,
  previewOfPlainFile,
  previewOfSpec,
  sheetCellText,
} from '../../src/host/workPreview.js'
import { renderWorkSpec, sheetCell } from '../../src/host/workRender.js'
import {
  parseWorkSpec,
  plainOf,
  runsOf,
  themeOf,
  type WorkSpec,
} from '../../src/host/workSpec.js'

const SLIDES = {
  title: '2026 年第三季度经营汇报',
  subtitle: '华东区 · 10 月',
  author: '运营部',
  theme: 'ocean',
  slides: [
    {
      layout: 'title',
      title: '2026 年第三季度经营汇报',
      subtitle: '华东区 · 10 月',
    },
    { layout: 'section', title: '一、业绩', subtitle: '收入与客户' },
    {
      layout: 'bullets',
      title: '收入同比增长 12%',
      bullets: [
        '新客户 **320** 家，超目标 7%',
        '老客户续约率 91%',
        'Q3 revenue up',
      ],
      notes: '先讲结论。',
    },
    {
      layout: 'two-column',
      title: '上季与本季',
      columns: [
        { heading: '上季', bullets: ['渠道单一'] },
        { heading: '本季', bullets: ['新增两个渠道'] },
      ],
    },
    {
      layout: 'table',
      title: '分地区收入（万元）',
      table: {
        columns: ['地区', 'Q2', 'Q3'],
        rows: [
          ['上海', 120, 138.5],
          ['杭州', 80, null],
        ],
      },
    },
    {
      layout: 'chart',
      title: '月度收入趋势',
      chart: {
        type: 'bar',
        unit: '万元',
        categories: ['7月', '8月', '9月'],
        series: [{ name: '2026', values: [68, 70, 75] }],
      },
    },
    { layout: 'quote', quote: '交付缩短到五天', subtitle: '华东区负责人' },
    { layout: 'closing', title: '谢谢' },
  ],
}

const DOCUMENT = {
  title: '校园二手书平台项目方案',
  subtitle: '初稿',
  author: '产品组',
  blocks: [
    { type: 'heading', text: '一、背景', level: 1 },
    {
      type: 'paragraph',
      text: '每学期末大量教材被丢弃。\n\n新生需要以 **较低价格** 买到它们。',
    },
    { type: 'bullets', items: ['供给：毕业生', '需求：新生'] },
    { type: 'numbered', items: ['上架', '撮合'] },
    {
      type: 'table',
      caption: '表 1 预算',
      table: {
        columns: ['项目', '金额'],
        rows: [
          ['服务器', 1200],
          ['推广', 3000],
        ],
      },
    },
    { type: 'quote', text: '我们宿舍每年都扔掉一箱书。', source: '访谈对象 A' },
    {
      type: 'chart',
      caption: '图 1 成交量',
      chart: {
        type: 'line',
        categories: ['九月', '十月'],
        series: [{ name: '成交', values: [40, 65] }],
      },
    },
    { type: 'pagebreak' },
    { type: 'heading', text: '附录', level: 2 },
  ],
}

const SHEET = {
  title: '迎新活动预算',
  theme: 'forest',
  sheets: [
    {
      name: '明细',
      columns: [
        { header: '日期', type: 'date' },
        { header: '项目' },
        { header: '金额', type: 'currency' },
        { header: '占比', type: 'percent' },
      ],
      rows: [
        ['2026-09-01', '场地', 2000, 0.4],
        ['2026-09-02', '物料', 3000.5, 0.6],
        [null, '合计', '=SUM(C2:C3)', true],
      ],
    },
    {
      name: '说明',
      columns: [{ header: '说明', width: 60 }],
      rows: [['金额单位：元']],
    },
  ],
}

function parsed(kind: WorkSpec['kind'], raw: unknown): WorkSpec {
  const result = parseWorkSpec(kind, raw)
  if (!result.ok) throw new Error(result.issues.join('\n'))
  return result.value
}

/** What the strings are compared on: no whitespace, no Markdown marks. */
function squash(value: string): string {
  return value.replace(/[\s|*_#>`-]+/g, '')
}

function previewText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

async function readBack(name: string, bytes: Uint8Array): Promise<string> {
  const markdown = await new Markit().convert(Buffer.from(bytes), {
    extension: name.slice(name.lastIndexOf('.')),
    filename: name,
  })
  return markdown.markdown
}

async function member(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await ZipPackage.open(bytes)
  const raw = await zip.readBytes(path)
  if (raw === undefined) throw new Error(`no ${path}`)
  return new TextDecoder().decode(raw)
}

/** Every element and the attributes that could run or fetch something. */
async function elementsOf(html: string): Promise<{
  readonly tags: Set<string>
  readonly handlers: string[]
  readonly links: string[]
}> {
  const tags = new Set<string>()
  const handlers: string[] = []
  const links: string[] = []
  await new HTMLRewriter()
    .on('*', {
      element(element) {
        tags.add(element.tagName.toLowerCase())
        for (const [name, value] of element.attributes) {
          if (/^on/i.test(name)) handlers.push(name)
          if (/^(?:src|href|xlink:href|action|formaction|srcset)$/i.test(name))
            links.push(value)
        }
      },
    })
    .transform(new Response(html))
    .text()
  return { tags, handlers, links }
}

function expectAll(haystack: string, needles: readonly string[]): void {
  const flat = squash(haystack)
  for (const needle of needles) expect(flat).toContain(squash(needle))
}

describe('one description, a file and a preview that say the same thing', () => {
  test('slides: PowerPoint text and the preview carry every string; the chart and the font are in the file', async () => {
    const spec = parsed('slides', SLIDES)
    const bytes = await renderWorkSpec(spec)
    expect(new TextDecoder().decode(bytes.subarray(0, 2))).toBe('PK')
    const strings = [
      SLIDES.title,
      SLIDES.slides[0]!.subtitle!,
      '一、业绩',
      '收入与客户',
      '收入同比增长 12%',
      ...SLIDES.slides[2]!.bullets!.map(plainOf),
      '上季与本季',
      '上季',
      '渠道单一',
      '本季',
      '新增两个渠道',
      '分地区收入（万元）',
      '地区',
      'Q2',
      'Q3',
      '上海',
      '120',
      '138.5',
      '杭州',
      '80',
      '月度收入趋势',
      '交付缩短到五天',
      '华东区负责人',
      '谢谢',
    ]
    expectAll(await readBack('deck.pptx', bytes), strings)
    const html = previewOfSpec(spec)
    expectAll(previewText(html), [...strings, '7月', '8月', '9月'])
    const slide = await member(bytes, 'ppt/slides/slide3.xml')
    expect(slide).toContain('typeface="Microsoft YaHei"')
    expect(slide).toMatch(/<a:ea typeface="Microsoft YaHei"/)
    const zip = await ZipPackage.open(bytes)
    const charts = [...zip.members].filter(name =>
      /^ppt\/charts\/chart\d+\.xml$/.test(name),
    )
    expect(charts).toHaveLength(1)
    const chart = await member(bytes, charts[0]!)
    for (const category of ['7月', '8月', '9月'])
      expect(chart).toContain(category)
    const notes = [...zip.members].filter(name =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name),
    )
    expect(
      (await Promise.all(notes.map(name => member(bytes, name)))).some(xml =>
        xml.includes('先讲结论。'),
      ),
    ).toBe(true)
  })

  test('document: Word text and the preview carry every string; East Asian Microsoft YaHei, Latin Calibri', async () => {
    const spec = parsed('document', DOCUMENT)
    const bytes = await renderWorkSpec(spec)
    const strings = [
      DOCUMENT.title,
      '初稿',
      '产品组',
      '一、背景',
      '每学期末大量教材被丢弃。',
      '新生需要以较低价格买到它们。',
      '供给：毕业生',
      '需求：新生',
      '上架',
      '撮合',
      '表 1 预算',
      '项目',
      '金额',
      '服务器',
      '1200',
      '推广',
      '3000',
      '我们宿舍每年都扔掉一箱书。',
      '访谈对象 A',
      '图 1 成交量',
      '九月',
      '十月',
      '成交',
      '40',
      '65',
      '附录',
    ]
    const markdown = await readBack('plan.docx', bytes)
    expectAll(markdown, strings)
    expect(markdown).toContain('1. 上架')
    expect(markdown).toContain('- 供给：毕业生')
    expectAll(previewText(previewOfSpec(spec)), strings)
    const styles = await member(bytes, 'word/styles.xml')
    expect(styles).toContain('w:eastAsia="Microsoft YaHei"')
    expect(styles).toContain('w:ascii="Calibri"')
  })

  test('sheet: Excel values, types and formulas; the preview shows the same cells', async () => {
    const spec = parsed('sheet', SHEET)
    const bytes = await renderWorkSpec(spec)
    const markdown = await readBack('budget.xlsx', bytes)
    const strings = [
      '明细',
      '日期',
      '项目',
      '金额',
      '占比',
      '场地',
      '物料',
      '合计',
      '2000',
      '3000.5',
      '0.4',
      '0.6',
      '说明',
      '金额单位：元',
    ]
    expectAll(markdown, strings)
    const preview = previewText(previewOfSpec(spec))
    expectAll(preview, [
      '迎新活动预算',
      '2026-09-01',
      '场地',
      '2,000.00',
      '3,000.50',
      '40.0%',
      '=SUM(C2:C3)',
      'TRUE',
      '金额单位：元',
    ])
    const sheet = await member(bytes, 'xl/worksheets/sheet1.xml')
    // A formula as OOXML keeps it (no `=`), a date as a date serial, a frozen header.
    expect(sheet).toContain('<f>SUM(C2:C3)</f>')
    expect(sheet).toContain('<v>46266</v>')
    expect(sheet).toContain('state="frozen"')
    const styles = await member(bytes, 'xl/styles.xml')
    expect(styles).toContain('Microsoft YaHei')
    expect(styles).toContain('yyyy-mm-dd')
  })

  test('no preview has a script, a remote resource or an event handler', async () => {
    const hostile = parsed('slides', {
      title: '<script>alert(1)</script>',
      slides: [
        {
          layout: 'bullets',
          title: '<img src=x onerror=alert(1)>',
          bullets: [
            '<a href="javascript:alert(1)">x</a>',
            '"><svg onload=alert(1)>',
          ],
        },
        {
          layout: 'chart',
          title: 'c',
          chart: {
            type: 'pie',
            categories: ['<script>'],
            series: [{ name: '</title><script>', values: [1] }],
          },
        },
      ],
    })
    const documents = [
      previewOfSpec(hostile),
      previewOfSpec(parsed('slides', SLIDES)),
      previewOfSpec(parsed('document', DOCUMENT)),
      previewOfSpec(parsed('sheet', SHEET)),
      previewOfPlainFile(
        'a.md',
        new TextEncoder().encode('<script>x</script>'),
      ),
      previewOfPlainFile(
        'a.csv',
        new TextEncoder().encode('a,"<b>"\n<script>,2'),
      ),
      previewOfPlainFile(
        'a.json',
        new TextEncoder().encode('{"x":"</pre><script>"}'),
      ),
      previewOfPlainFile('a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ]
    for (const html of documents) {
      expect(html.toLowerCase()).not.toContain('<script')
      const found = await elementsOf(html)
      expect(found.tags.has('script')).toBe(false)
      expect(found.handlers).toEqual([])
      expect(found.links.filter(link => !link.startsWith('data:'))).toEqual([])
    }
  })

  test('the preview follows the colour scheme and names the Chinese fonts', () => {
    const html = previewOfSpec(parsed('document', DOCUMENT))
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('"PingFang SC"')
    expect(html).toContain('"Noto Sans CJK SC"')
    expect(html).toContain('<html lang="zh-CN">')
  })
})

describe('descriptions are checked before anything is made', () => {
  test('problems name where they are, at most twelve', () => {
    const result = parseWorkSpec('slides', {
      title: 't',
      slides: [
        {
          layout: 'chart',
          title: 'c',
          chart: {
            type: 'pie',
            categories: ['a'],
            series: [
              { name: 'n', values: [1, 2] },
              { name: 'm', values: [1] },
            ],
          },
        },
        { layout: 'bullets' },
        {
          layout: 'table',
          title: 'x',
          table: { columns: ['a', 'b'], rows: [['1']] },
        },
        { layout: 'nope', title: 'x' },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContain(
      'spec.slides.0.chart.series.0.values: has 2 values; there are 1 categories',
    )
    expect(result.issues).toContain(
      'spec.slides.0.chart.series: a pie chart has exactly one series',
    )
    expect(
      result.issues.some(one => one.startsWith('spec.slides.1.bullets')),
    ).toBe(true)
    expect(
      result.issues.some(one => one.startsWith('spec.slides.1.title')),
    ).toBe(true)
    expect(
      result.issues.some(one => one.startsWith('spec.slides.2.table.rows.0')),
    ).toBe(true)
    expect(
      result.issues.some(one => one.startsWith('spec.slides.3.layout')),
    ).toBe(true)
  })

  test('limits: 60 slides, 400 blocks, 10 sheets, 5000 rows, 50 columns, 2 MiB', () => {
    const slide = { layout: 'closing' }
    expect(
      parseWorkSpec('slides', { title: 't', slides: Array(60).fill(slide) }).ok,
    ).toBe(true)
    expect(
      parseWorkSpec('slides', { title: 't', slides: Array(61).fill(slide) }).ok,
    ).toBe(false)
    const block = { type: 'pagebreak' }
    expect(
      parseWorkSpec('document', { title: 't', blocks: Array(400).fill(block) })
        .ok,
    ).toBe(true)
    expect(
      parseWorkSpec('document', { title: 't', blocks: Array(401).fill(block) })
        .ok,
    ).toBe(false)
    const tab = (name: string, columns = 1, rows = 0) => ({
      name,
      columns: Array.from({ length: columns }, (_, i) => ({ header: `c${i}` })),
      rows: Array.from({ length: rows }, () => [1]),
    })
    expect(
      parseWorkSpec('sheet', {
        sheets: Array.from({ length: 11 }, (_, i) => tab(`s${i}`)),
      }).ok,
    ).toBe(false)
    expect(parseWorkSpec('sheet', { sheets: [tab('s', 51)] }).ok).toBe(false)
    expect(parseWorkSpec('sheet', { sheets: [tab('s', 1, 5001)] }).ok).toBe(
      false,
    )
    expect(parseWorkSpec('sheet', { sheets: [tab('a/b')] }).ok).toBe(false)
    expect(parseWorkSpec('sheet', { sheets: [tab('S'), tab('s')] }).ok).toBe(
      false,
    )
    const huge = parseWorkSpec('document', {
      title: 't',
      blocks: Array.from({ length: 120 }, () => ({
        type: 'paragraph',
        text: 'x'.repeat(20_000),
      })),
    })
    expect(huge.ok).toBe(false)
    if (!huge.ok) expect(huge.issues[0]).toContain('bytes; at most 2097152')
  })
})

describe('small pieces', () => {
  test('bold marks, and an unclosed one left as text', () => {
    expect(runsOf('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ])
    expect(plainOf('a **b c')).toBe('a **b c')
  })

  test('sheet cells: formula without its =, dates only in date columns', () => {
    expect(sheetCell('=SUM(A1)', undefined)).toEqual({
      type: 'Formula',
      value: 'SUM(A1)',
    })
    expect(
      sheetCell('2026-09-01', { header: 'd', type: 'date' }),
    ).toMatchObject({ type: Date })
    expect(sheetCell('2026-09-01', { header: 'd' })).toMatchObject({
      type: String,
    })
    expect(sheetCell(null, undefined)).toBeNull()
    expect(sheetCellText(0.255, { header: 'p', type: 'percent' })).toBe('25.5%')
  })

  test('csv parsing keeps quoted commas and newlines', () => {
    expect(parseDelimited('a,"b,c"\n"d\ne",f', ',')).toEqual([
      ['a', 'b,c'],
      ['d\ne', 'f'],
    ])
  })

  test('plain previews: pages are their own, text up to 2 MiB, images up to 8 MiB, the rest none', () => {
    expect(plainPreviewKind('a.html', 10)).toBe('self')
    expect(plainPreviewKind('a.md', 2 * 1024 * 1024)).toBe('render')
    expect(plainPreviewKind('a.md', 2 * 1024 * 1024 + 1)).toBeNull()
    expect(plainPreviewKind('a.png', 8 * 1024 * 1024)).toBe('render')
    expect(plainPreviewKind('a.pdf', 10)).toBeNull()
    expect(plainPreviewKind('a.pptx', 10)).toBeNull()
  })

  test('charts draw every category', () => {
    const svg = chartSvg(
      {
        type: 'line',
        categories: ['甲', '乙'],
        series: [
          { name: 's', values: [-1, 3] },
          { name: 't', values: [2, 2] },
        ],
      },
      themeOf('graphite'),
    )
    expect(svg).toContain('甲')
    expect(svg).toContain('<polyline')
  })
})
