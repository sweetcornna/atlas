// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm console --providers` 的参数面（P18.6）：纯解析，不碰磁盘。
 *
 * 钉的是：给了 `--providers` 才有这一面、且要 `--accounts`；只在这一面有意义的选项
 * 单独给出时报错；四个文件的默认位置从 `qianmoConfigPath` 派生；每台 ssh 节点要一把
 * 自己的 key；交给 ssh 的路径里不许有会被 ssh 拆开或展开的字符。
 */

import { describe, expect, test } from 'bun:test'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  CONSOLE_HELP_TEXT,
  parseConsoleArgs,
} from '../../src/commands/consoleArgs.js'

const parse = (...args: string[]) => parseConsoleArgs(args)

describe('qm console --providers', () => {
  test('off by default: the config has no providers key at all', () => {
    expect('providers' in parse()).toBe(false)
    expect('providers' in parse('--accounts')).toBe(false)
  })

  test('needs --accounts', () => {
    expect(() => parse('--providers')).toThrow('--providers needs --accounts')
  })

  test('defaults derive from the config root', () => {
    const config = parse('--accounts', '--providers')
    expect(config.providers).toEqual({
      storePath: qianmoConfigPath('qianmo', 'console', 'providers.ndjson'),
      secretsPath: qianmoConfigPath(
        'qianmo',
        'console',
        'provider-secrets.json',
      ),
      keyFile: qianmoConfigPath(
        'qianmo',
        'console-keys',
        'provider-master.key',
      ),
      knownHostsFile: qianmoConfigPath(
        'qianmo',
        'console-keys',
        'provider_known_hosts',
      ),
      nodes: [],
    })
  })

  test('every provider option alone names the switch it needs', () => {
    const cases: [string, string][] = [
      ['--providers-store', '/srv/p.ndjson'],
      ['--provider-secrets', '/srv/s.json'],
      ['--provider-key-file', '/srv/master.key'],
      ['--provider-known-hosts', '/srv/known_hosts'],
      ['--provider-local', 'beta-1=/srv/model-apply.sh'],
      ['--provider-ssh', 'beta-2=qianmo@203.0.113.7'],
      ['--provider-ssh-key', 'beta-2=/srv/keys/beta-2'],
    ]
    for (const [flag, value] of cases) {
      expect(() => parse('--accounts', flag, value)).toThrow(
        `${flag} needs --providers`,
      )
      expect(() => parse('--accounts', `${flag}=${value}`)).toThrow(
        `${flag} needs --providers`,
      )
    }
  })

  test('nodes: local and ssh, sorted, with the dedicated key per ssh node', () => {
    const config = parse(
      '--accounts',
      '--providers',
      '--provider-key-file=/srv/secrets/provider-master.key',
      '--provider-known-hosts',
      '/srv/secrets/provider_known_hosts',
      '--provider-ssh',
      'beta-4=qianmo@node4.example.net:2222',
      '--provider-ssh-key=beta-4=/srv/keys/beta-4',
      '--provider-local=beta-1=/srv/repo/demo/env/beta/ops/model-apply.sh',
      '--provider-ssh=beta-6=ops@[2001:db8::5]:22',
      '--provider-ssh-key',
      'beta-6=/srv/keys/beta-6',
    )
    expect(config.providers?.keyFile).toBe('/srv/secrets/provider-master.key')
    expect(config.providers?.knownHostsFile).toBe(
      '/srv/secrets/provider_known_hosts',
    )
    expect(config.providers?.nodes).toEqual([
      {
        node: 'beta-1',
        kind: 'local',
        command: '/srv/repo/demo/env/beta/ops/model-apply.sh',
      },
      {
        node: 'beta-4',
        kind: 'ssh',
        user: 'qianmo',
        host: 'node4.example.net',
        port: 2222,
        keyFile: '/srv/keys/beta-4',
      },
      {
        node: 'beta-6',
        kind: 'ssh',
        user: 'ops',
        host: '2001:db8::5',
        port: 22,
        keyFile: '/srv/keys/beta-6',
      },
    ])
  })

  test('an ssh node without its key, or a key without its node, is refused', () => {
    expect(() =>
      parse(
        '--accounts',
        '--providers',
        '--provider-ssh',
        'beta-2=q@h.example',
      ),
    ).toThrow('--provider-ssh beta-2 needs --provider-ssh-key')
    expect(() =>
      parse(
        '--accounts',
        '--providers',
        '--provider-ssh-key',
        'beta-2=/srv/keys/beta-2',
      ),
    ).toThrow('which has no --provider-ssh')
  })

  test('a node named twice, in either form, is refused', () => {
    expect(() =>
      parse(
        '--accounts',
        '--providers',
        '--provider-local=beta-1=/a',
        '--provider-ssh=beta-1=q@h',
        '--provider-ssh-key=beta-1=/k',
      ),
    ).toThrow('--provider-ssh repeats node beta-1')
    expect(() =>
      parse(
        '--accounts',
        '--providers',
        '--provider-local=beta-1=/a',
        '--provider-local=beta-1=/b',
      ),
    ).toThrow('--provider-local repeats node beta-1')
  })

  test('node names follow the protocol rule, not the wider console one', () => {
    for (const bad of [
      'beta_1=/a',
      'Beta-1=/a',
      '=/a',
      `${'a'.repeat(33)}=/a`,
      '/a',
    ]) {
      expect(() =>
        parse('--accounts', '--providers', '--provider-local', bad),
      ).toThrow('node 1-32 lowercase letters, digits or -')
    }
  })

  test('ssh destinations: user, host, port are checked, IPv6 only in brackets', () => {
    const bad = [
      'beta-2=h.example',
      'beta-2=-oProxyCommand=x@h',
      'beta-2=q@-oProxyCommand',
      'beta-2=q@h.example:0',
      'beta-2=q@h.example:65536',
      'beta-2=q@h.example:22x',
      'beta-2=q@2001:db8::5',
      'beta-2=q@[not-v6]:22',
      'beta-2=q@h ost',
    ]
    for (const value of bad) {
      expect([
        value,
        (() => {
          try {
            parse(
              '--accounts',
              '--providers',
              '--provider-ssh',
              value,
              '--provider-ssh-key',
              'beta-2=/k',
            )
            return 'accepted'
          } catch {
            return 'refused'
          }
        })(),
      ]).toEqual([value, 'refused'])
    }
  })

  test('paths handed to ssh carry no whitespace, % or quotes; all paths are absolute', () => {
    expect(() =>
      parse(
        '--accounts',
        '--providers',
        '--provider-known-hosts',
        '/a b/known',
      ),
    ).toThrow('must not contain whitespace')
    expect(() =>
      parse('--accounts', '--providers', '--provider-known-hosts', '/a/%h'),
    ).toThrow('must not contain whitespace')
    expect(() =>
      parse(
        '--accounts',
        '--providers',
        '--provider-ssh=beta-2=q@h',
        '--provider-ssh-key=beta-2=/keys/%u',
      ),
    ).toThrow('must not contain whitespace')
    for (const flag of [
      '--providers-store',
      '--provider-secrets',
      '--provider-key-file',
      '--provider-known-hosts',
    ]) {
      expect(() =>
        parse('--accounts', '--providers', flag, 'rel/path'),
      ).toThrow(`${flag} must be an absolute path`)
    }
    expect(() =>
      parse('--accounts', '--providers', '--provider-local', 'beta-1=rel.sh'),
    ).toThrow('--provider-local command must be an absolute path')
  })

  test('the help text lists every provider option', () => {
    for (const flag of [
      '--providers ',
      '--providers-store',
      '--provider-secrets',
      '--provider-key-file',
      '--provider-local',
      '--provider-ssh ',
      '--provider-ssh-key',
      '--provider-known-hosts',
    ]) {
      expect(CONSOLE_HELP_TEXT).toContain(flag)
    }
    expect(CONSOLE_HELP_TEXT).toContain('Needs --accounts')
  })
})
