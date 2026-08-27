// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `beta_console_url_from_args` —— 控制台**实际**绑上的地址。
 *
 * 为什么这个函数值得一个独立用例：它挡的是一类**假红**。beta-up.sh 起完控制台要探
 * `/v0/health` 才算数（issue #64：systemd 单元的状态两个方向都不算数），而探哪个地址
 * 此前用的是覆盖**之前**的默认值。于是把控制台部到 `-- --hostname 0.0.0.0 --port 80`
 * 之后，脚本探 127.0.0.1:38621 收到 000 并 die，报「控制台起不来」——那一刻控制台正在
 * :80 上对公网答 200。假红出现在部署的最后一步，读起来像真的，人会照着去重启一个
 * 本来好着的进程。
 *
 * 用例按「解析器怎么读」而不是「脚本怎么写」来钉：尾参是逃生门，最后一个赢
 * （beta-up.sh 文件头），两种写法都要认。
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const COMMON = 'demo/env/beta/common.sh'

function consoleUrl(args: readonly string[]): string {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        'set -euo pipefail',
        '. "$1"',
        'shift',
        'beta_console_url_from_args "$@"',
      ].join('\n'),
      'beta-console-url-test',
      COMMON,
      ...args,
    ],
    {
      cwd: REPOSITORY_ROOT,
      // 根目录必须存在且合法，否则 common.sh 的 guard 在 source 时就拦下来。
      env: {
        ...process.env,
        QIANMO_BETA_ROOT: '/tmp/qianmo-beta-console-url-test',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )
  expect(child.stderr.toString()).toBe('')
  expect(child.exitCode).toBe(0)
  return child.stdout.toString()
}

describe('beta_console_url_from_args', () => {
  test('没有尾参时就是那两个拓扑常量拼出来的默认值', () => {
    expect(consoleUrl([])).toBe('http://127.0.0.1:38621')
  })

  test('与控制台无关的尾参不影响结论', () => {
    expect(
      consoleUrl(['--wake-sign', '--chat-url', 'http://127.0.0.1:39000']),
    ).toBe('http://127.0.0.1:38621')
  })

  test('尾参改端口 —— 这就是那次假红的形状', () => {
    expect(consoleUrl(['--hostname', '0.0.0.0', '--port', '80'])).toBe(
      'http://127.0.0.1:80',
    )
  })

  test('等号写法与空格写法等价', () => {
    expect(consoleUrl(['--hostname=0.0.0.0', '--port=8080'])).toBe(
      'http://127.0.0.1:8080',
    )
  })

  test('后出现的赢 —— 与被调命令的解析器一致（consoleArgs.ts 是逐个赋值的循环）', () => {
    expect(consoleUrl(['--port', '38621', '--port', '80'])).toBe(
      'http://127.0.0.1:80',
    )
    expect(
      consoleUrl(['--hostname', '10.0.0.5', '--hostname', '10.0.0.6']),
    ).toBe('http://10.0.0.6:38621')
  })

  test('只改主机时端口保持默认，只改端口时主机保持默认', () => {
    expect(consoleUrl(['--hostname', '10.0.0.5'])).toBe('http://10.0.0.5:38621')
    expect(consoleUrl(['--port', '80'])).toBe('http://127.0.0.1:80')
  })

  test('通配地址换回回环 —— 它是「绑哪些网卡」不是「拨哪个地址」', () => {
    for (const wildcard of ['0.0.0.0', '::', '[::]', '*']) {
      expect(consoleUrl(['--hostname', wildcard, '--port', '80'])).toBe(
        'http://127.0.0.1:80',
      )
    }
  })

  test('非通配的具体地址原样保留，不被换成回环', () => {
    expect(consoleUrl(['--hostname', '127.0.0.2', '--port', '80'])).toBe(
      'http://127.0.0.2:80',
    )
  })
})
