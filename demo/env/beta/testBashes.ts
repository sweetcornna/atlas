// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 用例里「每个 bash 各跑一遍」的那张表（P18.13）。
 *
 * 运维本机跑的脚本要同时在 macOS 自带的 bash 3.2 与 Linux 的 bash 5 上成立。两条
 * 最常咬人的差异都只在 3.2 上出现（变量紧贴全角标点、空数组 `set -u`），而 CI 与节点
 * 上只有 5；所以用例不挑一个 bash，而是把**这台机器上找得到的每一个不同版本**都跑一遍：
 * macOS 开发机上至少是 3.2，CI 上至少是 5，两边合起来覆盖两种。
 *
 * 找的地方：`/bin/bash`、`QIANMO_TEST_BASHES`（冒号分隔，给没有装进 PATH 的那一份留
 * 的口子）、Homebrew 与 /usr/bin 的常见位置。版本相同的只留第一个。
 */

import { existsSync, realpathSync } from 'node:fs'

export interface TestBash {
  readonly path: string
  /** `BASH_VERSION`，例如 `3.2.57(1)-release`。 */
  readonly version: string
  readonly major: number
}

function candidates(): string[] {
  const extra = (process.env.QIANMO_TEST_BASHES ?? '')
    .split(':')
    .filter(path => path !== '')
  return [
    '/bin/bash',
    ...extra,
    '/opt/homebrew/bin/bash',
    '/usr/local/bin/bash',
    '/usr/bin/bash',
  ]
}

function probe(path: string): TestBash | undefined {
  if (!existsSync(path)) return undefined
  const child = Bun.spawnSync([path, '-c', 'printf %s "$BASH_VERSION"'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const version = child.stdout.toString().trim()
  if (child.exitCode !== 0 || version === '') return undefined
  const major = Number(version.split('.')[0])
  return Number.isInteger(major) ? { path, version, major } : undefined
}

/** 每个不同版本一个，`/bin/bash` 排第一。 */
export function testBashes(): readonly TestBash[] {
  const seenPaths = new Set<string>()
  const seenVersions = new Set<string>()
  const found: TestBash[] = []
  for (const path of candidates()) {
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      continue
    }
    if (seenPaths.has(real)) continue
    seenPaths.add(real)
    const bash = probe(path)
    if (bash === undefined || seenVersions.has(bash.version)) continue
    seenVersions.add(bash.version)
    found.push(bash)
  }
  return found
}
