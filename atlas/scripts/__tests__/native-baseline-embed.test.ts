// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { embeddedAddonFiles } from '../../../packages/natives/scripts/embed-native'
import { extractEmbeddedAddonArchive } from '../../../packages/natives/native/loader-state.js'

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
    const archiveEntry = Object.entries(files).find(([path]) =>
      path.endsWith('.tar.gz'),
    )!
    if (typeof archiveEntry[1] === 'string')
      throw new Error('archive must be binary')
    const archive = new Bun.Archive(archiveEntry[1])
    const entries = await archive.files()
    expect([...entries.keys()]).toEqual(['pi_natives.linux-x64-baseline.node'])
    expect(await entries.values().next().value!.text()).toBe(baseline)
    const archivePath = join(root, basename(archiveEntry[0]))
    await Bun.write(archivePath, archiveEntry[1])
    const targetDir = join(root, 'cache')
    await mkdir(targetDir)
    const written = extractEmbeddedAddonArchive({
      archivePath,
      files: [
        {
          variant: 'baseline',
          filename: 'pi_natives.linux-x64-baseline.node',
          size: baseline.length,
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
    const both = Object.entries(defaults).find(([path]) =>
      path.endsWith('.tar.gz'),
    )!
    if (typeof both[1] === 'string') throw new Error('archive must be binary')
    expect([...(await new Bun.Archive(both[1]).files()).keys()].sort()).toEqual(
      [
        'pi_natives.linux-x64-baseline.node',
        'pi_natives.linux-x64-modern.node',
      ],
    )
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
