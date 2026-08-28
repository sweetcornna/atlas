// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 无人值守那一轮的预批准清单。
 *
 * 这份文件存在的理由不在脚本里，在 `packages/resident/src/acp-client.ts`：常驻的
 * 每一轮跑在 `permissionMode: 'dontAsk'` 下，`requestPermission` 被硬钉成
 * `cancelled`，于是「没人批准」不是等待而是当场拒绝。没有这份清单，agent 连自己的
 * 工作区都写不了——而失败的形状很难认：工作区目录可写，节点日志里一条文件系统错误
 * 都没有，只有模型回话里一句「当前权限模式拒绝写入」。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const COMMON = join(REPOSITORY_ROOT, 'demo/env/beta/common.sh')
const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-node-settings-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true })
  }
})

function seed(
  configDir: string,
  workspaceRoot: string,
  agents: readonly string[],
): { readonly exitCode: number } {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        'set -uo pipefail',
        '. "$1"',
        'config_dir="$2"',
        'ws_root="$3"',
        'shift 3',
        'beta_seed_node_settings "$config_dir" "$ws_root" "$@"',
      ].join('\n'),
      'beta-node-settings-test',
      COMMON,
      configDir,
      workspaceRoot,
      ...agents,
    ],
    { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  return { exitCode: child.exitCode }
}

describe('节点配置根里的预批准清单', () => {
  test('每个 agent 的工作区各得一条 Write 与一条 Edit，路径是绝对的', () => {
    const base = root()
    const configDir = join(base, 'nodes/beta-4/config')
    const workspaceRoot = join(base, 'workspaces/beta-4')

    expect(
      seed(configDir, workspaceRoot, ['planner', 'reviewer']).exitCode,
    ).toBe(0)

    const parsed = JSON.parse(
      readFileSync(join(configDir, 'settings.json'), 'utf8'),
    ) as { permissions: { allow: string[] } }
    // 规则内容以 `/` 开头才被当成绝对路径，而工作区路径自己也以 `/` 开头——所以
    // 是两个斜杠。少一个就变成一条相对 cwd 的规则，而 cwd 是 agent 的工作区，
    // 于是它**看起来**还能用，只是不再说得清授权范围。
    expect(parsed.permissions.allow).toEqual([
      `Write(/${workspaceRoot}/planner/**)`,
      `Edit(/${workspaceRoot}/planner/**)`,
      `Write(/${workspaceRoot}/reviewer/**)`,
      `Edit(/${workspaceRoot}/reviewer/**)`,
    ])
  })

  test('只放行工作区，不放行 Bash', () => {
    const base = root()
    const configDir = join(base, 'config')
    seed(configDir, join(base, 'ws'), ['planner'])
    const text = readFileSync(join(configDir, 'settings.json'), 'utf8')

    // 只读命令本来就跑得动；放行整个 Bash 是另一个量级的授权，要给也该是单独一次
    // 决定，不该跟着这份清单顺手进来。
    expect(text).not.toContain('Bash')
    expect(text).not.toContain('deny')
  })

  test('第二次跑什么都不做（幂等）', () => {
    const base = root()
    const configDir = join(base, 'config')
    const workspaceRoot = join(base, 'ws')

    expect(seed(configDir, workspaceRoot, ['planner']).exitCode).toBe(0)
    // 1 = 本来就一致。幂等在这里不是风格：beta-up.sh 每次起节点都会调它。
    expect(seed(configDir, workspaceRoot, ['planner']).exitCode).toBe(1)
  })

  test('内容被改过就按仓库这份重写', () => {
    const base = root()
    const configDir = join(base, 'config')
    const workspaceRoot = join(base, 'ws')
    seed(configDir, workspaceRoot, ['planner'])
    const target = join(configDir, 'settings.json')
    writeFileSync(target, '{"permissions":{"allow":["Bash(rm -rf /)"]}}')

    expect(seed(configDir, workspaceRoot, ['planner']).exitCode).toBe(0)
    expect(readFileSync(target, 'utf8')).not.toContain('rm -rf')
  })

  test('能破坏 JSON 的 agent 名当场拒绝，而不是转义了事', () => {
    const base = root()
    const configDir = join(base, 'config')
    // 一个需要转义才能表达的名字，在工作区路径那一侧也已经是麻烦；静默接受只是把
    // 发现它的时刻推迟到更难查的地方。
    const result = seed(configDir, join(base, 'ws'), ['plan"ner'])

    expect(result.exitCode).not.toBe(0)
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false)
  })

  test('配置根是 0700，不看 umask 脸色', () => {
    // 这一步可能先于常驻自己建配置根跑到，而常驻建的那个是 0700。让同一个目录的
    // 权限位取决于「谁先跑到」，是下一个人查隔离时要多花的一小时。
    const base = root()
    const configDir = join(base, 'config')
    seed(configDir, join(base, 'ws'), ['planner'])

    expect(statSync(configDir).mode & 0o777).toBe(0o700)
  })

  test('落盘是 0600', () => {
    const base = root()
    const configDir = join(base, 'config')
    seed(configDir, join(base, 'ws'), ['planner'])

    expect(statSync(join(configDir, 'settings.json')).mode & 0o777).toBe(0o600)
  })
})
