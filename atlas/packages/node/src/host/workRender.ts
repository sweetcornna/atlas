// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Office files from one structured description (`work-tasks.md` §5.3):
 * pptxgenjs for `.pptx`, docx for `.docx`, write-excel-file for `.xlsx`. All
 * three are pure-JS MIT libraries bundled into `qm`; each is imported the
 * first time a file of its kind is made, so a node that never makes one
 * never loads it.
 *
 * Every visible string is written in the description's order, so a reader
 * library (and a person) finds the same words in the file and in its preview
 * (`workPreview.ts`).
 */

import {
  cellText,
  chartTable,
  runsOf,
  themeOf,
  type WorkBlock,
  type WorkDocument,
  type WorkSheetBook,
  type WorkSheetColumn,
  type WorkSlide,
  type WorkSlides,
  type WorkSpec,
  type WorkTable,
  type WorkTheme,
} from './workSpec.js'

/** Latin, East Asian and complex-script faces alike (§5.3). */
export const WORK_FONT = 'Microsoft YaHei'
/** docx keeps a Latin face for Latin text. */
const DOCX_LATIN_FONT = 'Calibri'

export async function renderWorkSpec(spec: WorkSpec): Promise<Uint8Array> {
  switch (spec.kind) {
    case 'slides':
      return await renderSlides(spec.spec)
    case 'document':
      return await renderDocument(spec.spec)
    case 'sheet':
      return await renderSheet(spec.spec)
  }
}

// ── .pptx ────────────────────────────────────────────────────────────────

/** LAYOUT_WIDE, inches. */
const SLIDE_W = 13.333
const SLIDE_H = 7.5
const MARGIN = 0.6

async function renderSlides(deck: WorkSlides): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  const theme = themeOf(deck.theme)
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = deck.title
  if (deck.author !== undefined) pptx.author = deck.author
  pptx.company = 'Qmo'
  pptx.theme = { headFontFace: WORK_FONT, bodyFontFace: WORK_FONT }
  const base = { fontFace: WORK_FONT, lang: 'zh-CN' } as const
  deck.slides.forEach((one, index) => {
    const slide = pptx.addSlide()
    const dark = one.layout === 'title' || one.layout === 'closing'
    slide.background = {
      color: dark
        ? theme.primary
        : one.layout === 'section'
          ? theme.surface
          : theme.background,
    }
    if (!dark && index > 0)
      slide.slideNumber = {
        x: SLIDE_W - MARGIN - 0.8,
        y: SLIDE_H - 0.45,
        w: 0.8,
        h: 0.3,
        fontFace: WORK_FONT,
        fontSize: 10,
        color: theme.muted,
        align: 'right',
      }
    drawSlide(pptx, slide, one, theme, base)
    if (one.notes !== undefined) slide.addNotes(one.notes)
  })
  const out = await pptx.write({ outputType: 'uint8array' })
  if (!(out instanceof Uint8Array)) throw new Error('pptx output is not bytes')
  return out
}

type Pptx = InstanceType<typeof import('pptxgenjs').default>
type PptxSlide = ReturnType<Pptx['addSlide']>
type PptxBase = { readonly fontFace: string; readonly lang: string }

function pptxRuns(
  value: string,
  options: Record<string, unknown> = {},
): { text: string; options: Record<string, unknown> }[] {
  return runsOf(value).map(run => ({
    text: run.text,
    options: { ...options, ...(run.bold ? { bold: true } : {}) },
  }))
}

function pptxBullets(
  items: readonly string[],
  base: PptxBase,
  color: string,
): { text: string; options: Record<string, unknown> }[] {
  return items.flatMap(item =>
    pptxRuns(item, { ...base, color }).map((run, runIndex, all) => ({
      text: run.text,
      options: {
        ...run.options,
        ...(runIndex === 0 ? { bullet: { indent: 18 } } : {}),
        ...(runIndex === all.length - 1 ? { breakLine: true } : {}),
        paraSpaceAfter: 8,
      },
    })),
  )
}

function slideTitle(
  slide: PptxSlide,
  title: string,
  theme: WorkTheme,
  base: PptxBase,
): void {
  slide.addText(pptxRuns(title), {
    ...base,
    x: MARGIN,
    y: 0.4,
    w: SLIDE_W - MARGIN * 2,
    h: 0.9,
    fontSize: 30,
    bold: true,
    color: theme.primary,
    valign: 'middle',
    fit: 'shrink',
  })
  slide.addShape('rect', {
    x: MARGIN,
    y: 1.32,
    w: 1.2,
    h: 0.06,
    fill: { color: theme.accent },
    line: { color: theme.accent, width: 0 },
  })
}

function drawSlide(
  pptx: Pptx,
  slide: PptxSlide,
  one: WorkSlide,
  theme: WorkTheme,
  base: PptxBase,
): void {
  const bodyY = 1.65
  const bodyH = SLIDE_H - bodyY - 0.7
  const bodyW = SLIDE_W - MARGIN * 2
  switch (one.layout) {
    case 'title':
    case 'closing': {
      slide.addShape('rect', {
        x: MARGIN,
        y: one.layout === 'title' ? 2.55 : 3.0,
        w: 1.4,
        h: 0.08,
        fill: { color: theme.accent },
        line: { color: theme.accent, width: 0 },
      })
      slide.addText(pptxRuns(one.title ?? ''), {
        ...base,
        x: MARGIN,
        y: one.layout === 'title' ? 2.75 : 3.2,
        w: bodyW,
        h: 1.4,
        fontSize: one.layout === 'title' ? 44 : 40,
        bold: true,
        color: 'FFFFFF',
        valign: 'top',
        fit: 'shrink',
      })
      if (one.subtitle !== undefined)
        slide.addText(pptxRuns(one.subtitle), {
          ...base,
          x: MARGIN,
          y: one.layout === 'title' ? 4.25 : 4.6,
          w: bodyW,
          h: 1.0,
          fontSize: 20,
          color: 'E8EDF2',
          valign: 'top',
          fit: 'shrink',
        })
      return
    }
    case 'section': {
      slide.addShape('rect', {
        x: 0,
        y: 0,
        w: 0.35,
        h: SLIDE_H,
        fill: { color: theme.accent },
        line: { color: theme.accent, width: 0 },
      })
      slide.addText(pptxRuns(one.title ?? ''), {
        ...base,
        x: MARGIN + 0.4,
        y: 2.6,
        w: bodyW - 0.4,
        h: 1.3,
        fontSize: 38,
        bold: true,
        color: theme.primary,
        valign: 'middle',
        fit: 'shrink',
      })
      if (one.subtitle !== undefined)
        slide.addText(pptxRuns(one.subtitle), {
          ...base,
          x: MARGIN + 0.4,
          y: 3.95,
          w: bodyW - 0.4,
          h: 0.9,
          fontSize: 20,
          color: theme.muted,
          valign: 'top',
          fit: 'shrink',
        })
      return
    }
    case 'bullets': {
      slideTitle(slide, one.title ?? '', theme, base)
      const top = one.subtitle === undefined ? bodyY : bodyY + 0.6
      if (one.subtitle !== undefined)
        slide.addText(pptxRuns(one.subtitle), {
          ...base,
          x: MARGIN,
          y: bodyY,
          w: bodyW,
          h: 0.5,
          fontSize: 18,
          color: theme.muted,
          fit: 'shrink',
        })
      slide.addText(pptxBullets(one.bullets ?? [], base, theme.text), {
        ...base,
        x: MARGIN + 0.1,
        y: top,
        w: bodyW - 0.1,
        h: bodyH - (top - bodyY),
        fontSize: 20,
        valign: 'top',
        fit: 'shrink',
      })
      return
    }
    case 'two-column': {
      slideTitle(slide, one.title ?? '', theme, base)
      const gap = 0.5
      const w = (bodyW - gap) / 2
      ;(one.columns ?? []).forEach((column, index) => {
        const x = MARGIN + index * (w + gap)
        slide.addShape('rect', {
          x,
          y: bodyY,
          w,
          h: bodyH,
          fill: { color: theme.surface },
          line: { color: theme.surface, width: 0 },
        })
        let y = bodyY + 0.2
        if (column.heading !== undefined) {
          slide.addText(pptxRuns(column.heading), {
            ...base,
            x: x + 0.25,
            y,
            w: w - 0.5,
            h: 0.6,
            fontSize: 20,
            bold: true,
            color: theme.accent,
            fit: 'shrink',
          })
          y += 0.7
        }
        slide.addText(pptxBullets(column.bullets, base, theme.text), {
          ...base,
          x: x + 0.25,
          y,
          w: w - 0.5,
          h: bodyY + bodyH - y - 0.2,
          fontSize: 17,
          valign: 'top',
          fit: 'shrink',
        })
      })
      return
    }
    case 'table': {
      slideTitle(slide, one.title ?? '', theme, base)
      const table = one.table!
      const fontSize =
        table.rows.length > 10 ? 11 : table.rows.length > 6 ? 13 : 15
      slide.addTable(pptxTable(table, theme, base, fontSize), {
        ...base,
        x: MARGIN,
        y: bodyY,
        w: bodyW,
        colW: table.columns.map(() => bodyW / table.columns.length),
        fontSize,
        border: { type: 'solid', pt: 0.75, color: 'D5DBE1' },
        valign: 'middle',
        autoPage: false,
      })
      return
    }
    case 'chart': {
      slideTitle(slide, one.title ?? '', theme, base)
      const chart = one.chart!
      const type =
        chart.type === 'bar'
          ? pptx.ChartType.bar
          : chart.type === 'line'
            ? pptx.ChartType.line
            : pptx.ChartType.pie
      slide.addChart(
        type,
        chart.series.map(series => ({
          name: series.name,
          labels: [...chart.categories],
          values: [...series.values],
        })),
        {
          x: MARGIN,
          y: bodyY,
          w: bodyW,
          h: bodyH,
          chartColors: [...theme.chart],
          showLegend: chart.type === 'pie' || chart.series.length > 1,
          legendPos: 'b',
          legendFontFace: WORK_FONT,
          legendFontSize: 12,
          catAxisLabelFontFace: WORK_FONT,
          catAxisLabelFontSize: 12,
          valAxisLabelFontFace: WORK_FONT,
          valAxisLabelFontSize: 11,
          dataLabelFontFace: WORK_FONT,
          showValue: chart.type !== 'line',
          dataLabelFontSize: 11,
          ...(chart.type === 'pie' ? { showPercent: true } : {}),
          ...(chart.unit === undefined
            ? {}
            : { showValAxisTitle: true, valAxisTitle: chart.unit }),
          valGridLine: { color: 'E3E7EB', size: 0.75 },
        },
      )
      return
    }
    case 'quote': {
      slide.addText(pptxRuns(`“${one.quote ?? ''}”`), {
        ...base,
        x: MARGIN + 0.8,
        y: 1.6,
        w: bodyW - 1.6,
        h: 3.2,
        fontSize: 30,
        italic: true,
        color: theme.primary,
        align: 'center',
        valign: 'middle',
        fit: 'shrink',
      })
      const by = one.subtitle ?? one.title
      if (by !== undefined)
        slide.addText(pptxRuns(`— ${by}`), {
          ...base,
          x: MARGIN + 0.8,
          y: 5.0,
          w: bodyW - 1.6,
          h: 0.6,
          fontSize: 18,
          color: theme.muted,
          align: 'center',
        })
      return
    }
  }
}

function pptxTable(
  table: WorkTable,
  theme: WorkTheme,
  base: PptxBase,
  fontSize: number,
): { text: string; options: Record<string, unknown> }[][] {
  return [
    table.columns.map(column => ({
      text: column,
      options: {
        ...base,
        bold: true,
        color: 'FFFFFF',
        fill: { color: theme.primary },
        fontSize,
      },
    })),
    ...table.rows.map((row, index) =>
      row.map(value => ({
        text: cellText(value),
        options: {
          ...base,
          color: theme.text,
          fontSize,
          ...(typeof value === 'number' ? { align: 'right' } : {}),
          ...(index % 2 === 1 ? { fill: { color: theme.surface } } : {}),
        },
      })),
    ),
  ]
}

// ── .docx ────────────────────────────────────────────────────────────────

async function renderDocument(document: WorkDocument): Promise<Uint8Array> {
  const docx = await import('docx')
  const theme = themeOf(document.theme)
  const font = {
    ascii: DOCX_LATIN_FONT,
    hAnsi: DOCX_LATIN_FONT,
    cs: DOCX_LATIN_FONT,
    eastAsia: WORK_FONT,
  }
  const heading = (size: number) => ({
    run: { font, size, bold: true, color: theme.primary },
    paragraph: { spacing: { before: 240, after: 120 }, keepNext: true },
  })
  const runs = (value: string, extra: Record<string, unknown> = {}) =>
    runsOf(value).map(
      run => new docx.TextRun({ text: run.text, bold: run.bold, ...extra }),
    )
  const children: (
    | InstanceType<typeof docx.Paragraph>
    | InstanceType<typeof docx.Table>
  )[] = [
    new docx.Paragraph({
      heading: docx.HeadingLevel.TITLE,
      children: runs(document.title),
    }),
  ]
  if (document.subtitle !== undefined)
    children.push(
      new docx.Paragraph({
        spacing: { after: 120 },
        children: runs(document.subtitle, { color: theme.muted, size: 26 }),
      }),
    )
  if (document.author !== undefined)
    children.push(
      new docx.Paragraph({
        spacing: { after: 240 },
        children: runs(document.author, { color: theme.muted }),
      }),
    )
  const table = (value: WorkTable) =>
    new docx.Table({
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
      rows: [
        new docx.TableRow({
          tableHeader: true,
          children: value.columns.map(
            column =>
              new docx.TableCell({
                shading: {
                  type: docx.ShadingType.CLEAR,
                  color: 'auto',
                  fill: theme.primary,
                },
                children: [
                  new docx.Paragraph({
                    children: [
                      new docx.TextRun({
                        text: column,
                        bold: true,
                        color: 'FFFFFF',
                      }),
                    ],
                  }),
                ],
              }),
          ),
        }),
        ...value.rows.map(
          (row, index) =>
            new docx.TableRow({
              children: row.map(
                one =>
                  new docx.TableCell({
                    ...(index % 2 === 1
                      ? {
                          shading: {
                            type: docx.ShadingType.CLEAR,
                            color: 'auto',
                            fill: theme.surface,
                          },
                        }
                      : {}),
                    children: [
                      new docx.Paragraph({
                        ...(typeof one === 'number'
                          ? { alignment: docx.AlignmentType.RIGHT }
                          : {}),
                        children: [new docx.TextRun({ text: cellText(one) })],
                      }),
                    ],
                  }),
              ),
            }),
        ),
      ],
    })
  const caption = (value: string) =>
    new docx.Paragraph({
      spacing: { before: 80, after: 200 },
      alignment: docx.AlignmentType.CENTER,
      children: runs(value, { italics: true, color: theme.muted, size: 20 }),
    })
  let lists = 0
  for (const block of document.blocks) children.push(...docxBlock(block))
  function docxBlock(
    block: WorkBlock,
  ): (InstanceType<typeof docx.Paragraph> | InstanceType<typeof docx.Table>)[] {
    switch (block.type) {
      case 'heading':
        return [
          new docx.Paragraph({
            heading:
              block.level === 3
                ? docx.HeadingLevel.HEADING_3
                : block.level === 2
                  ? docx.HeadingLevel.HEADING_2
                  : docx.HeadingLevel.HEADING_1,
            children: runs(block.text),
          }),
        ]
      case 'paragraph':
        return block.text.split(/\n{2,}/).map(
          part =>
            new docx.Paragraph({
              spacing: { after: 160, line: 320 },
              children: runs(part.replace(/\n/g, ' ')),
            }),
        )
      case 'bullets':
      case 'numbered': {
        lists += 1
        const instance = lists
        return block.items.map(
          item =>
            new docx.Paragraph({
              numbering: {
                reference:
                  block.type === 'bullets' ? 'qmo-bullets' : 'qmo-numbered',
                level: 0,
                instance,
              },
              spacing: { after: 80 },
              children: runs(item),
            }),
        )
      }
      case 'table':
        return [
          table(block.table),
          ...(block.caption === undefined ? [] : [caption(block.caption)]),
        ]
      case 'chart':
        return [
          table(chartTable(block.chart)),
          ...(block.caption === undefined ? [] : [caption(block.caption)]),
        ]
      case 'quote':
        return [
          new docx.Paragraph({
            indent: { left: 567 },
            spacing: { before: 120, after: 120 },
            border: {
              left: {
                style: docx.BorderStyle.SINGLE,
                size: 18,
                color: theme.accent,
                space: 12,
              },
            },
            children: runs(block.text, { italics: true }),
          }),
          ...(block.source === undefined
            ? []
            : [
                new docx.Paragraph({
                  indent: { left: 567 },
                  spacing: { after: 200 },
                  children: runs(`— ${block.source}`, { color: theme.muted }),
                }),
              ]),
        ]
      case 'pagebreak':
        return [new docx.Paragraph({ children: [new docx.PageBreak()] })]
    }
  }
  const level = (format: 'bullet' | 'decimal') => ({
    level: 0,
    format:
      format === 'bullet' ? docx.LevelFormat.BULLET : docx.LevelFormat.DECIMAL,
    text: format === 'bullet' ? '•' : '%1.',
    alignment: docx.AlignmentType.START,
    style: { paragraph: { indent: { left: 567, hanging: 283 } } },
  })
  const file = new docx.Document({
    creator: document.author ?? 'Qmo',
    title: document.title,
    styles: {
      default: {
        document: { run: { font, size: 22, color: theme.text } },
        title: {
          run: { font, size: 48, bold: true, color: theme.primary },
          paragraph: { spacing: { after: 160 } },
        },
        heading1: heading(32),
        heading2: heading(27),
        heading3: heading(24),
      },
    },
    numbering: {
      config: [
        { reference: 'qmo-bullets', levels: [level('bullet')] },
        { reference: 'qmo-numbered', levels: [level('decimal')] },
      ],
    },
    sections: [{ children }],
  })
  return new Uint8Array(await docx.Packer.toBuffer(file))
}

// ── .xlsx ────────────────────────────────────────────────────────────────

const SHEET_FORMATS: Readonly<Record<string, string>> = {
  integer: '#,##0',
  percent: '0.0%',
  currency: '#,##0.00',
  date: 'yyyy-mm-dd',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** One cell as write-excel-file takes it. */
export function sheetCell(
  value: string | number | boolean | null,
  column: WorkSheetColumn | undefined,
): Record<string, unknown> | null {
  if (value === null) return null
  const format =
    column?.type === undefined ? undefined : SHEET_FORMATS[column.type]
  const shaped = format === undefined ? {} : { format }
  // OOXML keeps a formula without its `=`; the library writes what it gets.
  if (typeof value === 'string' && value.startsWith('=') && value.length > 1)
    return { type: 'Formula', value: value.slice(1), ...shaped }
  if (typeof value === 'number') return { type: Number, value, ...shaped }
  if (typeof value === 'boolean') return { type: Boolean, value }
  if (column?.type === 'date' && ISO_DATE.test(value)) {
    const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
    if (!Number.isNaN(date.getTime()))
      return { type: Date, value: date, format: SHEET_FORMATS.date }
  }
  return { type: String, value, wrap: value.length > 60 }
}

async function renderSheet(book: WorkSheetBook): Promise<Uint8Array> {
  const { default: writeXlsxFile } = await import('write-excel-file/node')
  const theme = themeOf(book.theme)
  const sheets = book.sheets.map(sheet => ({
    sheet: sheet.name,
    ...(sheet.freezeHeader === false ? {} : { stickyRowsCount: 1 }),
    columns: sheet.columns.map(column => ({
      width:
        column.width ??
        Math.min(
          60,
          Math.max(
            10,
            ...[
              column.header,
              ...sheet.rows.map(row => row[sheet.columns.indexOf(column)]),
            ]
              .slice(0, 200)
              .map(value =>
                value === null || value === undefined
                  ? 0
                  : // CJK characters take two columns.
                    [...String(value)].reduce(
                      (sum, char) =>
                        sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1),
                      2,
                    ),
              ),
          ),
        ),
    })),
    data: [
      sheet.columns.map(column => ({
        type: String,
        value: column.header,
        fontWeight: 'bold' as const,
        textColor: '#FFFFFF',
        backgroundColor: `#${theme.primary}`,
        alignVertical: 'center' as const,
      })),
      ...sheet.rows.map(row =>
        sheet.columns.map((column, index) =>
          sheetCell(row[index] ?? null, column),
        ),
      ),
    ],
  }))
  const out = await writeXlsxFile(
    sheets as unknown as Parameters<typeof writeXlsxFile>[0],
    { fontFamily: WORK_FONT, fontSize: 11 },
  ).toBuffer()
  return new Uint8Array(out)
}
