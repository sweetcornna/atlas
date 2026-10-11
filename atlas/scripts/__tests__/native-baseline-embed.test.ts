// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { embeddedAddonFiles } from '../../../packages/natives/scripts/embed-native'
import { extractEmbeddedAddons } from '../../../packages/natives/native/loader-state.js'

const version = '18.8.4'
const baseline = 'baseline__piNativesV18_8_4\0'
const modern = 'modern__piNativesV18_8_4\0'

test('portable x64 embeds and extracts only baseline even when modern is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qm-baseline-'))
  try {
    const nativeDir = join(root, 'native')
    await Bun.write(
      join(nativeDir, 'pi_natives.linux-x64-baseline.node'),
      baseline,
    )
    await Bun.write(join(nativeDir, 'pi_natives.linux-x64-modern.node'), modern)
    const options = { platform: 'linux', arch: 'x64', nativeDir, version }
    const files = await embeddedAddonFiles({
      ...options,
      x64BaselineOnly: true,
    })
    // One zstd frame per embedded addon, plus the manifest that lists them.
    const frames = Object.entries(files).filter(([path]) =>
      path.endsWith('.node.zst'),
    )
    expect(frames.map(([path]) => basename(path))).toEqual([
      'pi_natives.linux-x64-baseline.node.zst',
    ])
    const manifest = Object.entries(files).find(([path]) =>
      path.endsWith('embedded-addon.js'),
    )![1]
    expect(manifest).not.toContain('modern')
    const [framePath, frame] = frames[0]!
    if (typeof frame === 'string') throw new Error('frame must be binary')
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(frame))).toBe(
      baseline,
    )
    const zstdPath = join(root, basename(framePath))
    await Bun.write(zstdPath, frame)
    const targetDir = join(root, 'cache')
    await mkdir(targetDir)
    const written = extractEmbeddedAddons({
      files: [
        {
          variant: 'baseline',
          filename: 'pi_natives.linux-x64-baseline.node',
          size: baseline.length,
          zstdPath,
        },
      ],
      targetDir,
    })
    expect(written).toHaveLength(1)
    expect(
      await Bun.file(
        join(targetDir, 'pi_natives.linux-x64-baseline.node'),
      ).text(),
    ).toBe(baseline)
    const defaults = await embeddedAddonFiles(options)
    expect(
      Object.keys(defaults)
        .filter(path => path.endsWith('.node.zst'))
        .map(path => basename(path))
        .sort(),
    ).toEqual([
      'pi_natives.linux-x64-baseline.node.zst',
      'pi_natives.linux-x64-modern.node.zst',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit baseline never silently substitutes a modern-only addon', async () => {
  const nativeDir = await mkdtemp(join(tmpdir(), 'qm-missing-baseline-'))
  try {
    await Bun.write(join(nativeDir, 'pi_natives.linux-x64-modern.node'), modern)
    await expect(
      embeddedAddonFiles({
        platform: 'linux',
        arch: 'x64',
        nativeDir,
        version,
        x64BaselineOnly: true,
      }),
    ).rejects.toThrow('No native addons found')
  } finally {
    await rm(nativeDir, { recursive: true, force: true })
  }
})

test('baseline-only refuses non-x64 targets', async () => {
  const nativeDir = await mkdtemp(join(tmpdir(), 'qm-wrong-baseline-'))
  try {
    await Bun.write(join(nativeDir, 'pi_natives.linux-arm64.node'), baseline)
    await expect(
      embeddedAddonFiles({
        platform: 'linux',
        arch: 'arm64',
        nativeDir,
        version,
        x64BaselineOnly: true,
      }),
    ).rejects.toThrow('requires x64')
  } finally {
    await rm(nativeDir, { recursive: true, force: true })
  }
})
