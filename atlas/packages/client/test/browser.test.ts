// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { type BrowserProbe, findBrowser } from '../src/browser.ts'

function probe(
  platform: NodeJS.Platform,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly files?: readonly string[]
    readonly path?: Readonly<Record<string, string>>
    readonly heads?: Readonly<Record<string, string>>
    readonly links?: Readonly<Record<string, string>>
    readonly registry?: Readonly<Record<string, string>>
  } = {},
): BrowserProbe {
  const files = new Set(options.files ?? [])
  return {
    platform,
    env: options.env ?? {},
    exists: file => files.has(file),
    which: command => options.path?.[command] ?? null,
    head: file => options.heads?.[file] ?? null,
    realpath: file => options.links?.[file] ?? file,
    registry: key => options.registry?.[key] ?? null,
  }
}

const WINDOWS_ENV = {
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\ymy\\AppData\\Local',
}
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

describe('Windows', () => {
  test('Edge in its usual place comes first', () => {
    expect(
      findBrowser(probe('win32', { env: WINDOWS_ENV, files: [EDGE, CHROME] })),
    ).toEqual({ path: EDGE, name: 'edge' })
  })

  test("Chrome when there is no Edge, then the installers' App Paths", () => {
    expect(
      findBrowser(probe('win32', { env: WINDOWS_ENV, files: [CHROME] })),
    ).toEqual({ path: CHROME, name: 'chrome' })
    const moved = 'D:\\Apps\\Edge\\msedge.exe'
    expect(
      findBrowser(
        probe('win32', {
          env: WINDOWS_ENV,
          files: [moved],
          registry: {
            'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe':
              moved,
          },
        }),
      ),
    ).toEqual({ path: moved, name: 'edge' })
    expect(findBrowser(probe('win32', { env: WINDOWS_ENV }))).toBeNull()
  })
})

describe('Linux', () => {
  test('the first of Edge, Chrome, Chromium on PATH', () => {
    expect(
      findBrowser(
        probe('linux', {
          path: {
            'google-chrome': '/usr/bin/google-chrome',
            chromium: '/usr/bin/chromium',
          },
        }),
      ),
    ).toEqual({ path: '/usr/bin/google-chrome', name: 'chrome' })
  })

  test('snap builds are skipped, whether linked or wrapped', () => {
    expect(
      findBrowser(
        probe('linux', {
          path: {
            chromium: '/snap/bin/chromium',
            'chromium-browser': '/usr/bin/chromium-browser',
          },
          heads: {
            '/usr/bin/chromium-browser':
              '#!/bin/sh\nexec /snap/bin/chromium "$@"\n',
          },
        }),
      ),
    ).toBeNull()
    expect(
      findBrowser(
        probe('linux', {
          path: { chromium: '/usr/bin/chromium' },
          links: {
            '/usr/bin/chromium': '/snap/chromium/current/usr/lib/chromium',
          },
        }),
      ),
    ).toBeNull()
  })
})

test('QMO_BROWSER overrides the search, and must exist', () => {
  expect(
    findBrowser(
      probe('linux', {
        env: { QMO_BROWSER: '/opt/brave/brave' },
        files: ['/opt/brave/brave'],
        path: { 'google-chrome': '/usr/bin/google-chrome' },
      }),
    ),
  ).toEqual({ path: '/opt/brave/brave', name: 'custom' })
  expect(
    findBrowser(probe('linux', { env: { QMO_BROWSER: '/missing' } })),
  ).toBeNull()
})

test('macOS looks in /Applications', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  expect(findBrowser(probe('darwin', { files: [chrome] }))).toEqual({
    path: chrome,
    name: 'chrome',
  })
})
