// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { sep } from 'node:path'
import { hostTriple, sidecarPath, tauriBuildArgs } from '../build-app.ts'

describe('build-app', () => {
  test('the host triple comes from rustc -vV', () => {
    const rustc = [
      'rustc 1.92.0 (ded5c06cf 2025-12-08)',
      'binary: rustc',
      'host: aarch64-apple-darwin',
      'release: 1.92.0',
    ].join('\n')
    expect(hostTriple(rustc)).toBe('aarch64-apple-darwin')
    expect(hostTriple('rustc 1.92.0\nbinary: rustc\n')).toBeNull()
  })

  test('the sidecar has the name externalBin looks for', () => {
    expect(sidecarPath('aarch64-apple-darwin')).toEndWith(
      ['src-tauri', 'binaries', 'qmo-aarch64-apple-darwin'].join(sep),
    )
    expect(sidecarPath('x86_64-pc-windows-msvc')).toEndWith(
      'qmo-x86_64-pc-windows-msvc.exe',
    )
    expect(sidecarPath('x86_64-unknown-linux-gnu')).toEndWith(
      'qmo-x86_64-unknown-linux-gnu',
    )
  })

  test('macOS makes the .app only; the others their default bundles', () => {
    expect(tauriBuildArgs('darwin', false)).toEqual([
      'tauri',
      'build',
      '--bundles',
      'app',
    ])
    expect(tauriBuildArgs('darwin', true)).toEqual([
      'tauri',
      'build',
      '--debug',
      '--bundles',
      'app',
    ])
    expect(tauriBuildArgs('linux', false)).toEqual(['tauri', 'build'])
    expect(tauriBuildArgs('win32', true)).toEqual(['tauri', 'build', '--debug'])
  })
})
