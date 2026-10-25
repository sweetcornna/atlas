// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The structured descriptions `qianmo_make_document` turns into files
 * (`work-tasks.md` §5.2, §5.3). One description makes the document and its
 * preview, so the two say the same thing; it is also saved under `sources/`
 * so a later revision starts from what was made.
 *
 * The shapes are this file's: the workflow skills' references describe them
 * to the model, and nothing outside the node reads them.
 */

import { z } from 'zod'

/** Colours, without `#`, the way the three libraries take them. */
export interface WorkTheme {
  readonly primary: string
  readonly accent: string
  readonly background: string
  readonly surface: string
  readonly text: string
  readonly muted: string
  readonly chart: readonly string[]
}

export const WORK_THEMES = {
  classic: {
    primary: '1F3A5F',
    accent: 'C8553D',
    background: 'FFFFFF',
    surface: 'F3F5F8',
    text: '1E2329',
    muted: '5B6573',
    chart: ['1F3A5F', 'C8553D', '4F8A8B', 'E0A458', '7A6C9D', '8AA29E'],
  },
  ocean: {
    primary: '0B5C8E',
    accent: '13A3B5',
    background: 'FFFFFF',
    surface: 'EEF6FA',
    text: '10222E',
    muted: '4E6575',
    chart: ['0B5C8E', '13A3B5', '7FC8D9', 'F2A541', '5D6D7E', 'A3C4BC'],
  },
  forest: {
    primary: '2F5D3A',
    accent: 'B5832F',
    background: 'FFFFFF',
    surface: 'F1F5EF',
    text: '1C261E',
    muted: '56645A',
    chart: ['2F5D3A', 'B5832F', '7FA36B', 'D9B26F', '4C6E73', 'A47551'],
  },
  sunset: {
    primary: '8C2F39',
    accent: 'F29E4C',
    background: 'FFFFFF',
    surface: 'FBF2EC',
    text: '2B1B17',
    muted: '6E5850',
    chart: ['8C2F39', 'F29E4C', 'B5651D', 'E8C547', '5C4B51', 'C98474'],
  },
  graphite: {
    primary: '2D3436',
    accent: '0984E3',
    background: 'FFFFFF',
    surface: 'F2F3F4',
    text: '1B1E20',
    muted: '636E72',
    chart: ['2D3436', '0984E3', '00B894', 'FDCB6E', 'D63031', '6C5CE7'],
  },
} as const satisfies Record<string, WorkTheme>

export type WorkThemeName = keyof typeof WORK_THEMES

const THEME_NAMES = Object.keys(WORK_THEMES) as [
  WorkThemeName,
  ...WorkThemeName[],
]

/** Description limits (§5.6). */
export const WORK_SPEC_LIMITS = {
  slides: 60,
  blocks: 400,
  sheets: 10,
  rows: 5000,
  columns: 50,
  /** The description as JSON. */
  bytes: 2 * 1024 * 1024,
} as const

export const SLIDE_LAYOUTS = [
  'title',
  'section',
  'bullets',
  'two-column',
  'table',
  'chart',
  'quote',
  'closing',
] as const

const line = (max: number) => z.string().max(max)
const cell = z.union([z.string().max(2000), z.number().finite(), z.null()])

const tableSchema = z
  .object({
    columns: z.array(line(200)).min(1).max(12),
    rows: z.array(z.array(cell).max(12)).max(60),
  })
  .strict()
  .superRefine((table, ctx) => {
    table.rows.forEach((row, index) => {
      if (row.length !== table.columns.length)
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index],
          message: `has ${row.length} cells; the table has ${table.columns.length} columns`,
        })
    })
  })

const chartSchema = z
  .object({
    type: z.enum(['bar', 'line', 'pie']),
    categories: z.array(line(80)).min(1).max(24),
    series: z
      .array(
        z
          .object({
            name: line(80),
            values: z.array(z.number().finite()).max(24),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    unit: line(20).optional(),
  })
  .strict()
  .superRefine((chart, ctx) => {
    chart.series.forEach((series, index) => {
      if (series.values.length !== chart.categories.length)
        ctx.addIssue({
          code: 'custom',
          path: ['series', index, 'values'],
          message: `has ${series.values.length} values; there are ${chart.categories.length} categories`,
        })
    })
    if (chart.type === 'pie' && chart.series.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['series'],
        message: 'a pie chart has exactly one series',
      })
  })

export type WorkTable = z.infer<typeof tableSchema>
export type WorkChart = z.infer<typeof chartSchema>

const columnSchema = z
  .object({
    heading: line(200).optional(),
    bullets: z.array(line(500)).max(10),
  })
  .strict()

const slideSchema = z
  .object({
    layout: z.enum(SLIDE_LAYOUTS),
    title: line(200).optional(),
    subtitle: line(400).optional(),
    bullets: z.array(line(500)).max(12).optional(),
    columns: z.array(columnSchema).length(2).optional(),
    table: tableSchema.optional(),
    chart: chartSchema.optional(),
    quote: line(800).optional(),
    notes: line(4000).optional(),
  })
  .strict()
  .superRefine((slide, ctx) => {
    const need = (key: keyof typeof slide, why: string): void => {
      if (slide[key] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `required for layout ${slide.layout} (${why})`,
        })
    }
    if (slide.layout === 'bullets') need('bullets', 'the points')
    if (slide.layout === 'two-column') need('columns', 'two columns')
    if (slide.layout === 'table') need('table', 'the table')
    if (slide.layout === 'chart') need('chart', 'the chart')
    if (slide.layout === 'quote') need('quote', 'the quotation')
    if (slide.layout !== 'quote' && slide.layout !== 'closing')
      need('title', 'the slide title')
  })

export type WorkSlide = z.infer<typeof slideSchema>

const fileField = line(512).optional()

const slidesSchema = z
  .object({
    title: line(200),
    subtitle: line(400).optional(),
    author: line(200).optional(),
    theme: z.enum(THEME_NAMES).optional(),
    slides: z.array(slideSchema).min(1).max(WORK_SPEC_LIMITS.slides),
  })
  .strict()

const blockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      text: line(300),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    })
    .strict(),
  z.object({ type: z.literal('paragraph'), text: line(20_000) }).strict(),
  z
    .object({
      type: z.literal('bullets'),
      items: z.array(line(2000)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('numbered'),
      items: z.array(line(2000)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      table: tableSchema,
      caption: line(300).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('quote'),
      text: line(4000),
      source: line(300).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('chart'),
      chart: chartSchema,
      caption: line(300).optional(),
    })
    .strict(),
  z.object({ type: z.literal('pagebreak') }).strict(),
])

export type WorkBlock = z.infer<typeof blockSchema>

const documentSchema = z
  .object({
    title: line(300),
    subtitle: line(400).optional(),
    author: line(200).optional(),
    theme: z.enum(THEME_NAMES).optional(),
    blocks: z.array(blockSchema).min(1).max(WORK_SPEC_LIMITS.blocks),
  })
  .strict()

export const SHEET_COLUMN_TYPES = [
  'text',
  'number',
  'integer',
  'percent',
  'currency',
  'date',
] as const

const sheetValue = z.union([
  z.string().max(32_767),
  z.number().finite(),
  z.boolean(),
  z.null(),
])

/** Excel's own rule for a worksheet name. */
const SHEET_NAME = /^[^[\]:*?/\\]{1,31}$/

const sheetSchema = z
  .object({
    name: z
      .string()
      .regex(SHEET_NAME, 'is 1-31 characters without [ ] : * ? / \\'),
    columns: z
      .array(
        z
          .object({
            header: line(200),
            type: z.enum(SHEET_COLUMN_TYPES).optional(),
            width: z.number().int().min(4).max(80).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(WORK_SPEC_LIMITS.columns),
    rows: z.array(z.array(sheetValue)).max(WORK_SPEC_LIMITS.rows),
    /** Repeat the header row when scrolling; on unless false. */
    freezeHeader: z.boolean().optional(),
  })
  .strict()
  .superRefine((sheet, ctx) => {
    sheet.rows.forEach((row, index) => {
      if (row.length > sheet.columns.length)
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index],
          message: `has ${row.length} cells; the sheet has ${sheet.columns.length} columns`,
        })
    })
  })

export type WorkSheetTab = z.infer<typeof sheetSchema>
export type WorkSheetColumn = WorkSheetTab['columns'][number]

const sheetBookSchema = z
  .object({
    title: line(300).optional(),
    theme: z.enum(THEME_NAMES).optional(),
    sheets: z
      .array(sheetSchema)
      .min(1)
      .max(WORK_SPEC_LIMITS.sheets)
      .superRefine((sheets, ctx) => {
        const seen = new Set<string>()
        sheets.forEach((sheet, index) => {
          const key = sheet.name.toLowerCase()
          if (seen.has(key))
            ctx.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: 'repeats another sheet name',
            })
          seen.add(key)
        })
      }),
  })
  .strict()

export type WorkSlides = z.infer<typeof slidesSchema>
export type WorkDocument = z.infer<typeof documentSchema>
export type WorkSheetBook = z.infer<typeof sheetBookSchema>

export type WorkSpec =
  | { readonly kind: 'slides'; readonly spec: WorkSlides }
  | { readonly kind: 'document'; readonly spec: WorkDocument }
  | { readonly kind: 'sheet'; readonly spec: WorkSheetBook }

export type WorkSpecKind = WorkSpec['kind']

export const WORK_SPEC_EXTENSION: Readonly<Record<WorkSpecKind, string>> = {
  slides: 'pptx',
  document: 'docx',
  sheet: 'xlsx',
}

/** The tool's own arguments, around the description. */
export const makeDocumentInput = z
  .object({
    kind: z.enum(['slides', 'document', 'sheet']),
    file: fileField,
    pdf: z.boolean().optional(),
    spec: z.unknown(),
  })
  .strict()

/**
 * Parse one description. Problems come back as short lines naming where
 * they are (`slides.3.chart.series.0.values: …`), at most twelve, so the
 * model can fix them in one go.
 */
export function parseWorkSpec(
  kind: WorkSpecKind,
  raw: unknown,
):
  | { readonly ok: true; readonly value: WorkSpec }
  | { readonly ok: false; readonly issues: readonly string[] } {
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? '')
  } catch {
    return { ok: false, issues: ['spec: is not plain JSON'] }
  }
  if (bytes > WORK_SPEC_LIMITS.bytes)
    return {
      ok: false,
      issues: [`spec: ${bytes} bytes; at most ${WORK_SPEC_LIMITS.bytes}`],
    }
  const schema =
    kind === 'slides'
      ? slidesSchema
      : kind === 'document'
        ? documentSchema
        : sheetBookSchema
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues
        .slice(0, 12)
        .map(
          issue =>
            `${['spec', ...issue.path.map(String)].join('.')}: ${issue.message}`,
        ),
    }
  return {
    ok: true,
    value: { kind, spec: parsed.data } as WorkSpec,
  }
}

export function themeOf(name: WorkThemeName | undefined): WorkTheme {
  return WORK_THEMES[name ?? 'classic']
}

/** The description's display title. */
export function specTitle(spec: WorkSpec): string {
  return spec.kind === 'sheet'
    ? (spec.spec.title ?? spec.spec.sheets[0]!.name)
    : spec.spec.title
}

/** One run of text, with the only inline mark descriptions have: `**bold**`. */
export interface WorkRun {
  readonly text: string
  readonly bold: boolean
}

export function runsOf(value: string): WorkRun[] {
  const runs: WorkRun[] = []
  const parts = value.split('**')
  // An odd count of markers leaves the last one as text.
  const closed = parts.length % 2 === 1
  parts.forEach((part, index) => {
    const bold = index % 2 === 1 && (closed || index < parts.length - 1)
    const text = bold || index % 2 === 0 ? part : `**${part}`
    if (text !== '') runs.push({ text, bold })
  })
  return runs.length === 0 ? [{ text: '', bold: false }] : runs
}

/** The plain text of a value with marks, as readers show it. */
export function plainOf(value: string): string {
  return runsOf(value)
    .map(run => run.text)
    .join('')
}

/** A chart's numbers as a table, for documents (§7: no charts in .docx). */
export function chartTable(chart: WorkChart): WorkTable {
  return {
    columns: ['', ...chart.series.map(series => series.name)],
    rows: chart.categories.map((category, index) => [
      category,
      ...chart.series.map(series => series.values[index] ?? null),
    ]),
  }
}

/** How a table cell reads, the same in every renderer. */
export function cellText(value: string | number | boolean | null): string {
  return value === null ? '' : String(value)
}
