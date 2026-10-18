// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the hub sends a node's `runtime.ext.install` (P36.7): the three
 * source shapes go through (a GitHub address put back to one form), an MCP
 * server goes through with its command or its address, and everything else —
 * other hosts, credentials, climbing paths, flags — stops here. The refusals
 * as the API answers them are in `magpieApi.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import {
  extensionInstallRequest,
  extensionItemName,
} from '../src/extensionSource.js'

function source(kind: 'plugin' | 'skill', text: string): string | null {
  const checked = extensionInstallRequest({ kind, source: text })
  return checked.ok ? checked.value.source : null
}

describe('extension sources', () => {
  test('GitHub, npm and a marketplace name go through; a GitHub address is put back to one form', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['obra/superpowers', 'obra/superpowers'],
      ['obra/superpowers#v4.1.0', 'obra/superpowers#v4.1.0'],
      [
        'obra/super.powers#release/2026-10',
        'obra/super.powers#release/2026-10',
      ],
      [
        'https://github.com/obra/superpowers',
        'https://github.com/obra/superpowers',
      ],
      [
        'https://github.com/obra/superpowers.git',
        'https://github.com/obra/superpowers',
      ],
      [
        'https://github.com/obra/superpowers/',
        'https://github.com/obra/superpowers',
      ],
      [
        'https://github.com/obra/superpowers#main',
        'https://github.com/obra/superpowers#main',
      ],
      ['left-pad', 'left-pad'],
      ['left-pad@1.3.0', 'left-pad@1.3.0'],
      ['@acme/review-kit', '@acme/review-kit'],
      ['@acme/review-kit@2.0.0-rc.1', '@acme/review-kit@2.0.0-rc.1'],
      [
        'superpowers@claude-plugins-official',
        'superpowers@claude-plugins-official',
      ],
    ]
    for (const [text, sent] of cases) {
      expect(`${text} ${source('plugin', text)}`).toBe(`${text} ${sent}`)
      // The node installs a skill from GitHub only.
      const github = text.includes('/') && !text.startsWith('@')
      expect(`${text} ${source('skill', text)}`).toBe(
        `${text} ${github ? sent : null}`,
      )
    }
  })

  test('other hosts, credentials, climbing, encodings and flags stop here', () => {
    for (const text of [
      '',
      'https://gitlab.com/owner/repo',
      'https://raw.githubusercontent.com/owner/repo/main/x',
      'https://GITHUB.com/owner/repo',
      'https://user@github.com/owner/repo',
      'https://github.com/owner',
      'https://github.com/owner/repo/tree/main',
      'ssh://git@github.com/owner/repo',
      'owner/repo/extra',
      'owner/repo#a..b',
      'owner/repo#/etc',
      'owner/repo#-x',
      'owner/repo#x#y',
      '..',
      './plugin',
      '/abs/plugin',
      'owner\\repo',
      'owner/re po',
      // A range is no exact version. (`left-pad@latest` reads as a
      // marketplace name: the node tells the two apart, not the hub.)
      'left-pad@^1.0.0',
      '@acme/kit@~2.0.0',
      '-y',
    ])
      expect(`${text} ${source('plugin', text)}`).toBe(`${text} null`)
  })

  test('an MCP server: a name plus a command line or an https address, never both', () => {
    const command = extensionInstallRequest({
      kind: 'mcp',
      name: 'github',
      command: '/usr/local/bin/npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    })
    expect(command).toEqual({
      ok: true,
      value: {
        kind: 'mcp',
        source: '/usr/local/bin/npx',
        name: 'github',
        command: '/usr/local/bin/npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
    })
    const address = extensionInstallRequest({
      kind: 'mcp',
      name: 'docs-v2',
      url: 'https://mcp.example.com:8443/mcp',
    })
    expect(address).toEqual({
      ok: true,
      value: {
        kind: 'mcp',
        source: 'https://mcp.example.com:8443/mcp',
        name: 'docs-v2',
        url: 'https://mcp.example.com:8443/mcp',
      },
    })
    for (const bad of [
      { name: 'x' },
      { name: 'x', command: 'npx', url: 'https://mcp.example.com' },
      { name: 'QM-tools', command: 'npx' },
      // The node refuses dots in a name it adds (a harness config path splits on them).
      { name: 'docs.v2', command: 'npx' },
      { name: 'x', command: 'np x' },
      { name: 'x', command: '/usr/../bin/sh' },
      {
        name: 'x',
        command: 'npx',
        args: Array.from({ length: 33 }, () => 'a'),
      },
      { name: 'x', url: 'https://mcp.example.com', args: ['a'] },
      { name: 'x', url: 'https://mcp.example.com/a#b' },
      { name: 'x', url: 'https://@mcp.example.com/' },
      { name: 'x', command: 'npx', source: 'owner/repo' },
    ])
      expect(
        `${JSON.stringify(bad)} ${extensionInstallRequest({ kind: 'mcp', ...bad }).ok}`,
      ).toBe(`${JSON.stringify(bad)} false`)
  })

  test('a removal names an item the way a harness lists it', () => {
    for (const name of [
      'superpowers@claude-plugins-official',
      '@acme/review-kit',
      'plugin:superpowers:github',
      'release-notes',
    ])
      expect(extensionItemName(name)).toBe(name)
    for (const name of ['', '-x', '../x', 'a b', 'a%2e', 'a\\b'])
      expect(`${name} ${extensionItemName(name)}`).toBe(`${name} null`)
  })
})
