// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `DEMO_ENTRYPOINTS` 与仓库里真实的 `demo_entry` 调用点必须对得上。
 *
 * **这个文件的存在本身是一次返工的结果。**判据最早写成 `demoBundles.ts` 里一句注释：
 * 「grep `demo/lib/[a-z0-9-]*\.ts`」。那句话是错的 —— `demo/ac1-restart.sh`、
 * `ac2-wake-forward.sh`、`p31-resident-wake.sh`、`p41-task-result.sh` 先
 * `LIB="$REPO_DIR/demo/lib"` 再 `bun run "$LIB/xxx.ts"`，那条 grep 一个都找不到，
 * 首版因此漏了 14 个入口。**注释里的判据没人执行，写错了不会有任何反馈。**
 *
 * 漏一条的症状不是构建失败：那个脚本在开发机上照跑（源文件旁边有 node_modules），
 * 只在**投出去的机器上**崩，而且崩在 Bun 的模块解析层——错误信息与脚本自己想报的
 * 事情毫无关系。这正是本包要修的那个形状，所以判据必须是可执行的。
 *
 * 方向是单向的：**每个调用点都要被覆盖**。反过来不要求——`ac2-target` 与 `p73-sample`
 * 是注释里教人手敲的命令，没有调用点，但投出去的树上同样得有它们的产物。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEMO_ENTRYPOINTS, DEMO_ENTRYPOINTS_EXCLUDED } from '../demoBundles.ts'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')

/** 仓库里所有 shell 脚本。demo/ 之外将来也可能有调用点，所以不写死目录。 */
function shellScripts(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) shellScripts(path, found)
    else if (name.endsWith('.sh')) found.push(path)
  }
  return found
}

describe('DEMO_ENTRYPOINTS 覆盖每一处 demo_entry 调用', () => {
  const calls = new Map<string, string[]>()
  for (const path of shellScripts(join(REPOSITORY_ROOT, 'demo'))) {
    const text = readFileSync(path, 'utf8')
    for (const m of text.matchAll(/demo_entry ([a-z0-9-]+)/g)) {
      const name = m[1]
      if (name === undefined) continue
      calls.set(name, [
        ...(calls.get(name) ?? []),
        path.slice(REPOSITORY_ROOT.length + 1),
      ])
    }
  }

  test('扫得到调用点（这个用例自己不能是空转的）', () => {
    // 少了这一条，正则写坏时上面的 Map 会是空的，下面每一条都会「通过」。
    expect(calls.size).toBeGreaterThan(10)
  })

  test('每个被调用的入口，要么打包、要么在排除名单里', () => {
    const known = new Set<string>([
      ...DEMO_ENTRYPOINTS,
      ...DEMO_ENTRYPOINTS_EXCLUDED,
    ])
    const orphans = [...calls.entries()].filter(([name]) => !known.has(name))
    expect(
      orphans.map(([name, where]) => `${name}（${where.join('、')}）`),
    ).toEqual([])
  })

  test('每个入口都真的存在于 demo/lib/', () => {
    const missing = [...DEMO_ENTRYPOINTS, ...DEMO_ENTRYPOINTS_EXCLUDED].filter(
      name => {
        try {
          return !statSync(
            join(REPOSITORY_ROOT, 'demo/lib', `${name}.ts`),
          ).isFile()
        } catch {
          return true
        }
      },
    )
    expect(missing).toEqual([])
  })

  test('打包表与排除名单不相交', () => {
    const excluded = new Set<string>(DEMO_ENTRYPOINTS_EXCLUDED)
    expect(DEMO_ENTRYPOINTS.filter(name => excluded.has(name))).toEqual([])
  })
})
