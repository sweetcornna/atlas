// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-contained HTML previews (`work-tasks.md` §4.4, §5.3). Drawn by this
 * code from the same description the office file was made from, so they
 * say the same thing; files written some other way get a plain view
 * (escaped text, a table for CSV, an image page). Every page here is inline
 * styles and `data:` images only, and **never a script**: the hub serves it
 * under `script-src 'none'` inside a sandboxed frame, and these pages do not
 * need one.
 */

import {
  cellText,
  chartTable,
  runsOf,
  themeOf,
  type WorkBlock,
  type WorkChart,
  type WorkDocument,
  type WorkSheetBook,
  type WorkSheetColumn,
  type WorkSlide,
  type WorkSlides,
  type WorkSpec,
  type WorkTable,
  type WorkTheme,
} from './workSpec.js'

const FONT_STACK =
  '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function marked(value: string): string {
  return runsOf(value)
    .map(run =>
      run.bold
        ? `<strong>${escapeHtml(run.text)}</strong>`
        : escapeHtml(run.text),
    )
    .join('')
}

function page(
  title: string,
  css: string,
  body: string,
  print = '@page { size: A4; margin: 18mm }',
): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --page: #f4f5f7; --ink: #1e2329; --muted: #5b6573; --line: #d5dbe1; --card: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --page: #15181c; --ink: #e6e8eb; --muted: #9aa3ad; --line: #39404a; --card: #1e2227; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--page); color: var(--ink); font-family: ${FONT_STACK}; line-height: 1.6; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
caption, .caption { caption-side: bottom; color: var(--muted); font-size: 13px; padding-top: 6px; text-align: center; font-style: italic; }
pre { white-space: pre-wrap; word-break: break-word; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
svg text { font-family: ${FONT_STACK}; }
@media print { html, body { background: #fff; color: #1e2329; } main { max-width: none; padding: 0; } }
${print}
${css}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

export function previewOfSpec(spec: WorkSpec): string {
  switch (spec.kind) {
    case 'slides':
      return slidesPreview(spec.spec)
    case 'document':
      return documentPreview(spec.spec)
    case 'sheet':
      return sheetPreview(spec.spec)
  }
}

// ── charts as inline SVG ─────────────────────────────────────────────────

function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10])
    if (step * power >= value) return step * power
  return 10 * power
}

function number(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function chartSvg(chart: WorkChart, theme: WorkTheme): string {
  const W = 800
  const H = 420
  const colors = theme.chart
  const legend =
    chart.type === 'pie' || chart.series.length > 1
      ? (chart.type === 'pie'
          ? chart.categories
          : chart.series.map(series => series.name)
        )
          .map(
            (name, index) =>
              `<g transform="translate(${60 + index * 130},${H - 18})"><rect width="12" height="12" y="-10" fill="#${colors[index % colors.length]}"/><text x="18" font-size="13" fill="currentColor">${escapeHtml(name)}</text></g>`,
          )
          .join('')
      : ''
  const title = `<title>${escapeHtml(
    chart.series.map(series => series.name).join(' / '),
  )}</title>`
  if (chart.type === 'pie') {
    const values = chart.series[0]!.values.map(value => Math.max(0, value))
    const total = values.reduce((sum, value) => sum + value, 0) || 1
    const cx = W / 2
    const cy = (H - 40) / 2 + 6
    const r = 150
    let angle = -Math.PI / 2
    const slices = values
      .map((value, index) => {
        const sweep = (value / total) * Math.PI * 2
        const end = angle + sweep
        const large = sweep > Math.PI ? 1 : 0
        const x1 = cx + r * Math.cos(angle)
        const y1 = cy + r * Math.sin(angle)
        const x2 = cx + r * Math.cos(end)
        const y2 = cy + r * Math.sin(end)
        const mid = angle + sweep / 2
        angle = end
        const fill = `#${colors[index % colors.length]}`
        const shape =
          sweep >= Math.PI * 2 - 1e-9
            ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`
            : `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${fill}"/>`
        const label =
          value > 0
            ? `<text x="${(cx + (r + 26) * Math.cos(mid)).toFixed(1)}" y="${(cy + (r + 26) * Math.sin(mid)).toFixed(1)}" font-size="13" text-anchor="middle" fill="currentColor">${Math.round((value / total) * 100)}%</text>`
            : ''
        return shape + label
      })
      .join('')
    return `<svg viewBox="0 0 ${W} ${H}" role="img" xmlns="http://www.w3.org/2000/svg">${title}${slices}${legend}</svg>`
  }
  const left = 70
  const right = 20
  const top = 20
  const bottom = 70
  const plotW = W - left - right
  const plotH = H - top - bottom
  const all = chart.series.flatMap(series => series.values)
  const max = niceMax(Math.max(0, ...all))
  const min = Math.min(0, ...all)
  const span = max - min || 1
  const y = (value: number) => top + plotH - ((value - min) / span) * plotH
  const grid = [0, 1, 2, 3, 4]
    .map(step => {
      const value = min + (span * step) / 4
      const at = y(value).toFixed(1)
      return `<line x1="${left}" x2="${W - right}" y1="${at}" y2="${at}" stroke="currentColor" stroke-opacity="0.15"/><text x="${left - 8}" y="${at}" font-size="12" text-anchor="end" dominant-baseline="middle" fill="currentColor" fill-opacity="0.7">${number(value)}</text>`
    })
    .join('')
  const band = plotW / chart.categories.length
  const categories = chart.categories
    .map(
      (category, index) =>
        `<text x="${(left + band * (index + 0.5)).toFixed(1)}" y="${H - bottom + 20}" font-size="13" text-anchor="middle" fill="currentColor">${escapeHtml(category)}</text>`,
    )
    .join('')
  let marks = ''
  if (chart.type === 'bar') {
    const groupW = band * 0.72
    const barW = groupW / chart.series.length
    marks = chart.series
      .map((series, s) =>
        series.values
          .map((value, index) => {
            const x = left + band * index + (band - groupW) / 2 + barW * s
            const y0 = y(Math.max(0, value))
            const h = Math.abs(y(value) - y(0))
            return `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${(barW * 0.9).toFixed(1)}" height="${h.toFixed(1)}" fill="#${colors[s % colors.length]}"/><text x="${(x + barW * 0.45).toFixed(1)}" y="${(y0 - 5).toFixed(1)}" font-size="11" text-anchor="middle" fill="currentColor">${number(value)}</text>`
          })
          .join(''),
      )
      .join('')
  } else {
    marks = chart.series
      .map((series, s) => {
        const points = series.values
          .map(
            (value, index) =>
              `${(left + band * (index + 0.5)).toFixed(1)},${y(value).toFixed(1)}`,
          )
          .join(' ')
        const color = `#${colors[s % colors.length]}`
        return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"/>${points
          .split(' ')
          .map(point => {
            const [px, py] = point.split(',')
            return `<circle cx="${px}" cy="${py}" r="4" fill="${color}"/>`
          })
          .join('')}`
      })
      .join('')
  }
  const unit =
    chart.unit === undefined
      ? ''
      : `<text x="${left}" y="${top - 6}" font-size="12" fill="currentColor" fill-opacity="0.7">${escapeHtml(chart.unit)}</text>`
  return `<svg viewBox="0 0 ${W} ${H}" role="img" xmlns="http://www.w3.org/2000/svg">${title}${unit}${grid}${marks}${categories}${legend}</svg>`
}

function tableHtml(table: WorkTable, caption?: string, cls = ''): string {
  return `<table${cls === '' ? '' : ` class="${cls}"`}>${
    caption === undefined ? '' : `<caption>${marked(caption)}</caption>`
  }<thead><tr>${table.columns
    .map(column => `<th>${escapeHtml(column)}</th>`)
    .join('')}</tr></thead><tbody>${table.rows
    .map(
      row =>
        `<tr>${row
          .map(value =>
            typeof value === 'number'
              ? `<td class="num">${escapeHtml(cellText(value))}</td>`
              : `<td>${escapeHtml(cellText(value))}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('')}</tbody></table>`
}

// ── slides ───────────────────────────────────────────────────────────────

function slideHtml(slide: WorkSlide, theme: WorkTheme, index: number): string {
  const title = (value: string | undefined) =>
    value === undefined ? '' : `<h2>${marked(value)}</h2>`
  const list = (items: readonly string[]) =>
    `<ul>${items.map(item => `<li>${marked(item)}</li>`).join('')}</ul>`
  const number = index > 0 ? `<span class="no">${index + 1}</span>` : ''
  switch (slide.layout) {
    case 'title':
    case 'closing':
      return `<section class="slide dark ${slide.layout}"><div class="bar"></div><h1>${marked(slide.title ?? '')}</h1>${
        slide.subtitle === undefined
          ? ''
          : `<p class="sub">${marked(slide.subtitle)}</p>`
      }</section>`
    case 'section':
      return `<section class="slide section"><div class="side"></div><h1>${marked(slide.title ?? '')}</h1>${
        slide.subtitle === undefined
          ? ''
          : `<p class="sub">${marked(slide.subtitle)}</p>`
      }${number}</section>`
    case 'bullets':
      return `<section class="slide">${title(slide.title)}<div class="rule"></div><div class="body">${
        slide.subtitle === undefined
          ? ''
          : `<p class="lead">${marked(slide.subtitle)}</p>`
      }${list(slide.bullets ?? [])}</div>${number}</section>`
    case 'two-column':
      return `<section class="slide">${title(slide.title)}<div class="rule"></div><div class="body cols">${(
        slide.columns ?? []
      )
        .map(
          column =>
            `<div class="col">${
              column.heading === undefined
                ? ''
                : `<h3>${marked(column.heading)}</h3>`
            }${list(column.bullets)}</div>`,
        )
        .join('')}</div>${number}</section>`
    case 'table':
      return `<section class="slide">${title(slide.title)}<div class="rule"></div><div class="body">${tableHtml(slide.table!, undefined, 'deck')}</div>${number}</section>`
    case 'chart':
      return `<section class="slide">${title(slide.title)}<div class="rule"></div><div class="body chart">${chartSvg(slide.chart!, theme)}</div>${number}</section>`
    case 'quote': {
      const by = slide.subtitle ?? slide.title
      return `<section class="slide quote"><blockquote>${marked(`“${slide.quote ?? ''}”`)}</blockquote>${
        by === undefined ? '' : `<p class="by">${marked(`— ${by}`)}</p>`
      }${number}</section>`
    }
  }
}

function slidesPreview(deck: WorkSlides): string {
  const theme = themeOf(deck.theme)
  const css = `
.slide { position: relative; width: 100%; aspect-ratio: 16 / 9; container-type: inline-size; margin: 0 0 20px; overflow: hidden; background: #${theme.background}; color: #${theme.text}; border-radius: 6px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.18); padding: 3.4cqw 4.5cqw; }
.slide h2 { margin: 0; font-size: 3.4cqw; line-height: 1.25; color: #${theme.primary}; }
.slide .rule { width: 9cqw; height: 0.45cqw; background: #${theme.accent}; margin: 1.2cqw 0 2cqw; }
.slide .body { font-size: 2.1cqw; }
.slide .body ul { margin: 0; padding-left: 2.6cqw; }
.slide .body li { margin-bottom: 0.9cqw; }
.slide .lead { margin: 0 0 1.2cqw; color: #${theme.muted}; }
.slide .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 3.6cqw; }
.slide .col { background: #${theme.surface}; padding: 1.6cqw 2cqw; border-radius: 0.6cqw; min-height: 28cqw; }
.slide .col h3 { margin: 0 0 1cqw; font-size: 2.2cqw; color: #${theme.accent}; }
.slide table.deck { font-size: 1.5cqw; }
.slide table.deck th { background: #${theme.primary}; color: #fff; border-color: #${theme.primary}; }
.slide table.deck td, .slide table.deck th { border-color: #d5dbe1; padding: 0.6cqw 1cqw; }
.slide table.deck tbody tr:nth-child(even) td { background: #${theme.surface}; }
.slide .chart svg { width: 100%; height: 34cqw; color: #${theme.text}; }
.slide.dark { background: #${theme.primary}; color: #fff; padding-top: 18cqw; }
.slide.dark .bar { width: 10.5cqw; height: 0.6cqw; background: #${theme.accent}; margin-bottom: 1.6cqw; }
.slide.dark h1 { margin: 0; font-size: 5cqw; line-height: 1.2; }
.slide.closing { padding-top: 22cqw; }
.slide.dark .sub { margin: 1.6cqw 0 0; font-size: 2.2cqw; color: #e8edf2; }
.slide.section { background: #${theme.surface}; padding-top: 19cqw; padding-left: 9cqw; }
.slide.section .side { position: absolute; left: 0; top: 0; bottom: 0; width: 2.6cqw; background: #${theme.accent}; }
.slide.section h1 { margin: 0; font-size: 4.4cqw; color: #${theme.primary}; }
.slide.section .sub { margin: 1.2cqw 0 0; font-size: 2.2cqw; color: #${theme.muted}; }
.slide.quote { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 6cqw 12cqw; }
.slide.quote blockquote { margin: 0; font-size: 3.4cqw; font-style: italic; color: #${theme.primary}; }
.slide.quote .by { margin: 2.4cqw 0 0; font-size: 2.1cqw; color: #${theme.muted}; }
.slide .no { position: absolute; right: 4.5cqw; bottom: 2.2cqw; font-size: 1.1cqw; color: #${theme.muted}; }
@media print { .slide { width: 13.333in; height: 7.5in; aspect-ratio: auto; margin: 0; border-radius: 0; box-shadow: none; break-after: page; } }`
  return page(
    deck.title,
    css,
    deck.slides
      .map((slide, index) => slideHtml(slide, theme, index))
      .join('\n'),
    '@page { size: 13.333in 7.5in; margin: 0 }',
  )
}

// ── documents ────────────────────────────────────────────────────────────

function blockHtml(block: WorkBlock, theme: WorkTheme): string {
  switch (block.type) {
    case 'heading': {
      const level = (block.level ?? 1) + 1
      return `<h${level}>${marked(block.text)}</h${level}>`
    }
    case 'paragraph':
      return block.text
        .split(/\n{2,}/)
        .map(part => `<p>${marked(part.replace(/\n/g, ' '))}</p>`)
        .join('')
    case 'bullets':
      return `<ul>${block.items.map(item => `<li>${marked(item)}</li>`).join('')}</ul>`
    case 'numbered':
      return `<ol>${block.items.map(item => `<li>${marked(item)}</li>`).join('')}</ol>`
    case 'table':
      return tableHtml(block.table, block.caption, 'doc')
    case 'chart':
      return `<figure>${chartSvg(block.chart, theme)}${tableHtml(chartTable(block.chart), undefined, 'doc')}${
        block.caption === undefined
          ? ''
          : `<figcaption class="caption">${marked(block.caption)}</figcaption>`
      }</figure>`
    case 'quote':
      return `<blockquote><p>${marked(block.text)}</p>${
        block.source === undefined
          ? ''
          : `<footer>${marked(`— ${block.source}`)}</footer>`
      }</blockquote>`
    case 'pagebreak':
      return '<hr class="break">'
  }
}

function documentPreview(document: WorkDocument): string {
  const theme = themeOf(document.theme)
  const css = `
article { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 40px 48px; }
article h1 { margin: 0 0 6px; font-size: 30px; color: #${theme.primary}; }
article h2, article h3, article h4 { color: #${theme.primary}; margin: 1.4em 0 0.5em; line-height: 1.3; }
@media (prefers-color-scheme: dark) { article h1, article h2, article h3, article h4 { color: #8fb4dc; } }
article .sub { margin: 0 0 4px; font-size: 17px; color: var(--muted); }
article .by { margin: 0 0 18px; color: var(--muted); }
article p { margin: 0 0 0.9em; }
article table.doc { margin: 0.6em 0 1.2em; }
article table.doc th { background: #${theme.primary}; color: #fff; border-color: #${theme.primary}; }
article blockquote { margin: 1em 0; padding: 2px 0 2px 16px; border-left: 4px solid #${theme.accent}; font-style: italic; }
article blockquote footer { font-style: normal; color: var(--muted); }
article figure { margin: 1em 0; }
article figure svg { width: 100%; height: auto; color: var(--ink); }
article hr.break { border: 0; border-top: 1px dashed var(--line); margin: 2em 0; }
@media print { article { border: 0; padding: 0; } article hr.break { break-after: page; border: 0; margin: 0; } }`
  const head = `<h1>${marked(document.title)}</h1>${
    document.subtitle === undefined
      ? ''
      : `<p class="sub">${marked(document.subtitle)}</p>`
  }${
    document.author === undefined
      ? ''
      : `<p class="by">${marked(document.author)}</p>`
  }`
  return page(
    document.title,
    css,
    `<article>${head}${document.blocks.map(block => blockHtml(block, theme)).join('\n')}</article>`,
  )
}

// ── sheets ───────────────────────────────────────────────────────────────

/** How a sheet cell reads in the preview: formulas as written. */
export function sheetCellText(
  value: string | number | boolean | null,
  column: WorkSheetColumn | undefined,
): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'string') return value
  switch (column?.type) {
    case 'percent':
      return `${(value * 100).toFixed(1)}%`
    case 'currency':
      return value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    case 'integer':
      return Math.round(value).toLocaleString('en-US')
    default:
      return String(value)
  }
}

/** Preview rows per sheet; the file has them all. */
const SHEET_PREVIEW_ROWS = 1000

function sheetPreview(book: WorkSheetBook): string {
  const theme = themeOf(book.theme)
  const title = book.title ?? book.sheets[0]!.name
  const css = `
h1 { font-size: 24px; margin: 0 0 16px; }
section.sheet { margin: 0 0 28px; }
section.sheet h2 { font-size: 17px; margin: 0 0 8px; }
.grid { overflow: auto; max-height: 70vh; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
.grid table { font-size: 13px; }
.grid th { position: sticky; top: 0; background: #${theme.primary}; color: #fff; border-color: #${theme.primary}; white-space: nowrap; }
.grid td { white-space: pre-wrap; }
.grid td.formula { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); }
.more { color: var(--muted); font-size: 13px; margin: 6px 0 0; }`
  const sections = book.sheets
    .map(sheet => {
      const rows = sheet.rows.slice(0, SHEET_PREVIEW_ROWS)
      return `<section class="sheet"><h2>${escapeHtml(sheet.name)}</h2><div class="grid"><table><thead><tr>${sheet.columns
        .map(column => `<th>${escapeHtml(column.header)}</th>`)
        .join('')}</tr></thead><tbody>${rows
        .map(
          row =>
            `<tr>${sheet.columns
              .map((column, index) => {
                const value = row[index] ?? null
                const cls =
                  typeof value === 'string' && value.startsWith('=')
                    ? ' class="formula"'
                    : typeof value === 'number'
                      ? ' class="num"'
                      : ''
                return `<td${cls}>${escapeHtml(sheetCellText(value, column))}</td>`
              })
              .join('')}</tr>`,
        )
        .join('')}</tbody></table></div>${
        sheet.rows.length > rows.length
          ? `<p class="more">${escapeHtml(`… ${sheet.rows.length - rows.length} more rows in the file`)}</p>`
          : ''
      }</section>`
    })
    .join('\n')
  return page(title, css, `<h1>${escapeHtml(title)}</h1>${sections}`)
}

// ── files written some other way ─────────────────────────────────────────

/** Largest text file with a preview (§4.4). */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
/** Largest image with a preview. */
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'csv', 'tsv'])
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * What preview a file that was not made from a description can have:
 * `self` (an HTML page, served as it is), `render` (drawn here from its
 * bytes), or none.
 */
export function plainPreviewKind(
  name: string,
  size: number,
): 'self' | 'render' | null {
  const extension = extensionOf(name)
  if (extension === 'html' || extension === 'htm') return 'self'
  if (TEXT_EXTENSIONS.has(extension))
    return size <= TEXT_PREVIEW_MAX_BYTES ? 'render' : null
  if (Object.hasOwn(IMAGE_MIME, extension))
    return size <= IMAGE_PREVIEW_MAX_BYTES ? 'render' : null
  return null
}

/** One CSV/TSV record list; quotes per RFC 4180. */
export function parseDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === separator) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function previewOfPlainFile(name: string, bytes: Uint8Array): string {
  const extension = extensionOf(name)
  const title = name.split('/').pop() ?? name
  const image = IMAGE_MIME[extension]
  if (image !== undefined)
    return page(
      title,
      'figure { margin: 0; text-align: center; } figure img { max-width: 100%; height: auto; background: repeating-conic-gradient(#0000 0 25%, #8882 0 50%) 0 0 / 16px 16px; } figcaption { color: var(--muted); font-size: 13px; margin-top: 8px; }',
      `<figure><img alt="${escapeHtml(title)}" src="data:${image};base64,${Buffer.from(bytes).toString('base64')}"><figcaption>${escapeHtml(title)}</figcaption></figure>`,
    )
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (extension === 'csv' || extension === 'tsv') {
    const rows = parseDelimited(text, extension === 'csv' ? ',' : '\t')
    const width = Math.max(1, ...rows.map(row => row.length))
    const [head = [], ...body] = rows
    return page(
      title,
      '.grid { overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--card); } .grid th { position: sticky; top: 0; background: var(--card); }',
      `<h1 style="font-size:20px">${escapeHtml(title)}</h1><div class="grid"><table><thead><tr>${Array.from(
        { length: width },
        (_, index) => `<th>${escapeHtml(head[index] ?? '')}</th>`,
      ).join('')}</tr></thead><tbody>${body
        .map(
          row =>
            `<tr>${Array.from(
              { length: width },
              (_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`,
            ).join('')}</tr>`,
        )
        .join('')}</tbody></table></div>`,
    )
  }
  let shown = text
  if (extension === 'json')
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Shown as written.
    }
  return page(
    title,
    '',
    `<h1 style="font-size:20px">${escapeHtml(title)}</h1><pre>${escapeHtml(shown)}</pre>`,
  )
}
