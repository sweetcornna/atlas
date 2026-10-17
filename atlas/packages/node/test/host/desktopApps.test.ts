// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DesktopApps } from '@qianmo/console'
import {
  allowedDesktopApps,
  desktopApplications,
  desktopExecArgv,
  isDesktopAppsPolicy,
  parseDesktopEntry,
} from '../../src/host/desktopApps.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function dirs(files: Record<string, Record<string, string>>): string[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-apps-'))
  roots.push(root)
  const out = ['local', 'share'].map(name => path.join(root, name))
  for (const [where, entries] of Object.entries(files))
    for (const [name, text] of Object.entries(entries)) {
      const file = path.join(root, where, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
  return out
}
const entry = (fields: Record<string, string>) =>
  `[Desktop Entry]\n${Object.entries({ Type: 'Application', ...fields })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`

test('Exec drops every field code, keeps %%, and follows the quoting rules', () => {
  expect(desktopExecArgv('gedit %U')).toEqual(['gedit'])
  expect(
    desktopExecArgv('app %f %F %u %U %i %c %k --name=%c --pct=100%% x'),
  ).toEqual(['app', '--name=', '--pct=100%', 'x'])
  // Double quotes keep spaces; inside them only " ` $ \ are escaped.
  expect(
    desktopExecArgv('"/opt/My App/run" "a \\"b\\" \\$HOME \\\\ \\n" plain'),
  ).toEqual(['/opt/My App/run', 'a "b" $HOME \\ \\n', 'plain'])
  // Single quotes and bare backslashes the way shells read them.
  expect(desktopExecArgv('sh -c \'exec foo "$1"\' x\\ y')).toEqual([
    'sh',
    '-c',
    'exec foo "$1"',
    'x y',
  ])
  expect(desktopExecArgv('"unterminated')).toBeUndefined()
  expect(desktopExecArgv("'unterminated")).toBeUndefined()
  expect(desktopExecArgv('%U')).toBeUndefined()
  expect(desktopExecArgv('   ')).toBeUndefined()
})

test('an entry reads only the unlocalized keys of [Desktop Entry] and the string escapes', () => {
  const parsed = parseDesktopEntry(
    [
      '# comment',
      '[Desktop Entry]',
      'Name[zh_CN]=编辑器',
      'Name=Text\\sEditor',
      'Exec=edit "a\\\\\\\\b"',
      'Categories=Utility;TextEditor;',
      'NoDisplay=false',
      '[Desktop Action new]',
      'Name=New window',
      'Exec=evil',
    ].join('\n'),
  )
  expect(parsed).toMatchObject({
    type: undefined,
    name: 'Text Editor',
    exec: 'edit "a\\\\b"',
    noDisplay: false,
    hidden: false,
    terminal: false,
    categories: ['Utility', 'TextEditor'],
  })
  // String escapes first (\\\\ → \\), quoting second (\\ → \).
  expect(desktopExecArgv(parsed.exec!)).toEqual(['edit', 'a\\b'])
})

test('the scan keeps launchable applications, local overrides first, terminals marked', () => {
  const available = new Set([
    'gedit',
    'xterm',
    '/usr/bin/foot',
    'vim',
    'kate',
    'firefox',
  ])
  const scan = (extra: readonly string[] = []) =>
    desktopApplications(
      dirs({
        local: {
          // Hidden in the higher-precedence directory removes the package.
          'firefox.desktop': entry({ Name: 'Firefox', Hidden: 'true' }),
          'gedit.desktop': entry({ Name: 'Local Edit', Exec: 'gedit --new' }),
        },
        share: {
          'firefox.desktop': entry({ Name: 'Firefox', Exec: 'firefox %u' }),
          'gedit.desktop': entry({ Name: 'Packaged', Exec: 'gedit %F' }),
          'debian-xterm.desktop': entry({
            Name: 'XTerm',
            Exec: 'xterm',
            Categories: 'System;TerminalEmulator;',
          }),
          'foot.desktop': entry({
            Name: 'Foot',
            Exec: '/usr/bin/foot',
            Categories: 'TerminalEmulator',
          }),
          'vim.desktop': entry({
            Name: 'Vim',
            Exec: 'vim %F',
            Terminal: 'true',
          }),
          'hidden.desktop': entry({
            Name: 'Settings',
            Exec: 'gedit',
            NoDisplay: 'true',
          }),
          'link.desktop': entry({ Name: 'Site', Type: 'Link', Exec: 'gedit' }),
          'tryexec.desktop': entry({
            Name: 'Missing',
            Exec: 'gedit',
            TryExec: 'not-installed',
          }),
          'missing.desktop': entry({ Name: 'Gone', Exec: 'not-installed' }),
          'noname.desktop': entry({ Exec: 'gedit' }),
          'kde4/kate.desktop': entry({ Name: 'Kate', Exec: 'kate -b %U' }),
          'readme.txt': entry({ Name: 'Not an entry', Exec: 'gedit' }),
        },
      }),
      program => available.has(program) || extra.includes(program),
    )
  const apps = scan()
  expect(apps.map(app => app.id)).toEqual([
    'debian-xterm',
    'foot',
    'gedit',
    'kde4-kate',
    'vim',
  ])
  expect(apps.find(app => app.id === 'gedit')).toEqual({
    id: 'gedit',
    name: 'Local Edit',
    terminal: false,
    argv: ['gedit', '--new'],
  })
  expect(apps.find(app => app.id === 'kde4-kate')?.argv).toEqual(['kate', '-b'])
  expect(apps.filter(app => app.terminal).map(app => app.id)).toEqual([
    'debian-xterm',
    'foot',
    'vim',
  ])
  // Terminal=true runs inside the first installed emulator.
  expect(apps.find(app => app.id === 'vim')?.argv).toEqual([
    'xterm',
    '-e',
    'vim',
  ])
  expect(
    scan(['x-terminal-emulator']).find(app => app.id === 'vim')?.argv,
  ).toEqual(['x-terminal-emulator', '-e', 'vim'])
  // No emulator installed: a Terminal=true entry cannot run and is not listed.
  available.delete('xterm')
  expect(scan().map(app => app.id)).toEqual(['foot', 'gedit', 'kde4-kate'])
})

test('the agent policy filters the catalog; terminals need the terminal switch', () => {
  const apps = [
    { id: 'gedit', name: 'Edit', terminal: false, argv: ['gedit'] },
    { id: 'xterm', name: 'XTerm', terminal: true, argv: ['xterm'] },
    { id: 'vim', name: 'Vim', terminal: true, argv: ['xterm', '-e', 'vim'] },
  ]
  const ids = (policy: DesktopApps, terminal: boolean) =>
    allowedDesktopApps(apps, policy, terminal).map(app => app.id)
  expect(ids('all', false)).toEqual(['gedit'])
  expect(ids('all', true)).toEqual(['gedit', 'xterm', 'vim'])
  expect(ids('none', true)).toEqual([])
  expect(ids(['xterm', 'gedit', 'other'], false)).toEqual(['gedit'])
  expect(ids(['vim'], true)).toEqual(['vim'])
  expect(isDesktopAppsPolicy('all')).toBe(true)
  expect(isDesktopAppsPolicy('none')).toBe(true)
  expect(isDesktopAppsPolicy([])).toBe(true)
  expect(isDesktopAppsPolicy(['org.gnome.TextEditor'])).toBe(true)
  expect(isDesktopAppsPolicy('some')).toBe(false)
  expect(isDesktopAppsPolicy([''])).toBe(false)
  expect(isDesktopAppsPolicy(['has space'])).toBe(false)
  expect(isDesktopAppsPolicy(['x'.repeat(201)])).toBe(false)
  expect(isDesktopAppsPolicy([1])).toBe(false)
  expect(
    isDesktopAppsPolicy(Array.from({ length: 51 }, (_, i) => `a${i}`)),
  ).toBe(false)
})
