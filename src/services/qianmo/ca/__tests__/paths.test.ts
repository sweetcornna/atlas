// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The CA directory's one job beyond naming files: staying out of every
 * identity's config root (§3.3).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getProtectedUserConfigDirectories } from '../../../../config/paths.js'
import {
  CA_DIR_DEFAULT_DISPLAY,
  CA_DIR_ENV_VAR,
  caDirectory,
} from '../paths.js'

const ORIGINAL_CA_DIR = process.env[CA_DIR_ENV_VAR]
const ORIGINAL_CONFIG_DIR = process.env['OCC_CONFIG_DIR']

afterEach(() => {
  if (ORIGINAL_CA_DIR === undefined) delete process.env[CA_DIR_ENV_VAR]
  else process.env[CA_DIR_ENV_VAR] = ORIGINAL_CA_DIR
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env['OCC_CONFIG_DIR']
  else process.env['OCC_CONFIG_DIR'] = ORIGINAL_CONFIG_DIR
})

describe('CA directory (§3.3, §6.1)', () => {
  test('defaults to a sibling of the config roots, never a child', () => {
    delete process.env[CA_DIR_ENV_VAR]
    const directory = caDirectory()
    expect(directory).toBe(
      join(homedir(), CA_DIR_DEFAULT_DISPLAY.replace('~/', '')),
    )
    // The bug this guards: `~/.qianmo-ca` starts with `~/.qianmo` as a raw
    // string. A prefix test without the separator would call the default CA
    // directory a config root and refuse to run at all.
    for (const root of getProtectedUserConfigDirectories()) {
      expect(directory).not.toBe(root)
    }
  })

  test('the environment override applies, and --ca-dir beats it', () => {
    process.env[CA_DIR_ENV_VAR] = '/tmp/qianmo-ca-from-env'
    expect(caDirectory()).toBe('/tmp/qianmo-ca-from-env')
    expect(caDirectory('/tmp/qianmo-ca-explicit')).toBe(
      '/tmp/qianmo-ca-explicit',
    )
    // An empty value is not a choice; it falls back rather than resolving to
    // the process's cwd, which is where `resolve('')` would land it.
    process.env[CA_DIR_ENV_VAR] = ''
    expect(caDirectory()).toBe(
      join(homedir(), CA_DIR_DEFAULT_DISPLAY.replace('~/', '')),
    )
  })

  test('refuses a directory inside a config root', () => {
    // The failure §6.1 says must not be possible: a CA private key sitting
    // where a node process, the console, or `occ migrate` walks.
    process.env['OCC_CONFIG_DIR'] = '/tmp/qianmo-config-root'
    expect(() => caDirectory('/tmp/qianmo-config-root/ca')).toThrow(
      /inside a config root/,
    )
    expect(() => caDirectory('/tmp/qianmo-config-root')).toThrow(
      /inside a config root/,
    )
    // A sibling whose name merely starts the same way is fine.
    expect(caDirectory('/tmp/qianmo-config-root-ca')).toBe(
      '/tmp/qianmo-config-root-ca',
    )
  })

  test('refuses the official CLI’s root too, not just ours', () => {
    delete process.env['OCC_CONFIG_DIR']
    for (const root of getProtectedUserConfigDirectories()) {
      expect(() => caDirectory(join(root, 'ca'))).toThrow(
        /inside a config root/,
      )
    }
  })
})
