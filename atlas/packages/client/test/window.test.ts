// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { pipeArgv } from '../src/cdp.ts'
import { ticketRoute, windowFlags } from '../src/window.ts'

test('the window gets its own profile and no first-run screens', () => {
  expect(windowFlags('C:\\Qmo\\window', 'win32')).toEqual([
    '--user-data-dir=C:\\Qmo\\window',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,820',
  ])
  expect(windowFlags('/home/ymy/.config/qmo/window', 'linux')).toContain(
    '--class=Qmo',
  )
})

test('only Linux keeps the ticket off the command line', () => {
  expect(ticketRoute('linux')).toBe('pipe')
  expect(ticketRoute('win32')).toBe('argv')
  expect(ticketRoute('darwin')).toBe('argv')
})

test('the pipe paths are shell arguments, never part of the script', () => {
  const argv = pipeArgv(
    { input: '/s/pipe/in', output: "/s/pi'pe/out" },
    '/usr/bin/chromium',
    ['--remote-debugging-pipe'],
  )
  expect(argv.slice(0, 3)).toEqual([
    '/bin/sh',
    '-c',
    'exec 3<"$1" 4>"$2"; shift 2; exec "$@"',
  ])
  expect(argv.slice(3)).toEqual([
    'qmo-window',
    '/s/pipe/in',
    "/s/pi'pe/out",
    '/usr/bin/chromium',
    '--remote-debugging-pipe',
  ])
})
