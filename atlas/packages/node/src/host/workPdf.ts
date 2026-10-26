// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PDF from a preview page (`work-tasks.md` §5.3): the node's own Chrome or
 * Chromium prints the static HTML this package drew, headless, with a
 * throwaway profile. No browser, or a browser that fails, means no PDF and a
 * sentence saying why — never a half-written file.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const PRINT_TIMEOUT_MS = 60_000

const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const PATH_BROWSERS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
]

/** The browser this node would print with, or null. */
export function findPrintBrowser(): string | null {
  if (process.platform === 'darwin')
    for (const candidate of MAC_BROWSERS)
      if (fs.existsSync(candidate)) return candidate
  for (const name of PATH_BROWSERS) {
    const found = Bun.which(name)
    if (found !== null) return found
  }
  return null
}

export type PrintOutcome =
  | { readonly ok: true; readonly pdf: Uint8Array }
  | { readonly ok: false; readonly reason: string }

async function printOnce(
  browser: string,
  html: string,
  scratch: string,
  sandbox: boolean,
): Promise<PrintOutcome> {
  const profile = fs.mkdtempSync(path.join(scratch, 'profile-'))
  const out = path.join(scratch, sandbox ? 'out.pdf' : 'out-nosandbox.pdf')
  const child = Bun.spawn(
    [
      browser,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      `--user-data-dir=${profile}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${out}`,
      ...(sandbox ? [] : ['--no-sandbox']),
      `file://${html}`,
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), PRINT_TIMEOUT_MS)
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text().catch(() => ''),
  ])
  clearTimeout(timer)
  if (code === 0 && fs.existsSync(out)) {
    const pdf = fs.readFileSync(out)
    if (pdf.subarray(0, 5).toString('latin1') === '%PDF-')
      return { ok: true, pdf: new Uint8Array(pdf) }
  }
  const tail = stderr.trim().split('\n').slice(-1)[0] ?? ''
  return {
    ok: false,
    reason:
      child.signalCode === 'SIGKILL'
        ? `the browser did not finish within ${PRINT_TIMEOUT_MS / 1000}s`
        : `the browser exited with ${code}${tail === '' ? '' : `: ${tail.slice(0, 200)}`}`,
  }
}

/**
 * Print one page. The page is copied into a private scratch directory first,
 * so the browser reads nothing of the workspace and leaves nothing in it.
 */
export async function printPdf(
  html: string,
  options: { readonly browser?: string | null } = {},
): Promise<PrintOutcome> {
  const browser =
    options.browser === undefined ? findPrintBrowser() : options.browser
  if (browser === null)
    return {
      ok: false,
      reason: 'this node has no Chrome or Chromium to print a PDF with',
    }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-work-pdf-'))
  try {
    const page = path.join(scratch, 'page.html')
    fs.writeFileSync(page, html, { mode: 0o600 })
    const first = await printOnce(browser, page, scratch, true)
    // Linux without unprivileged user namespaces cannot start Chrome's own
    // sandbox. The page is this package's static HTML with no script.
    if (first.ok || process.platform !== 'linux') return first
    const second = await printOnce(browser, page, scratch, false)
    return second.ok ? second : first
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
