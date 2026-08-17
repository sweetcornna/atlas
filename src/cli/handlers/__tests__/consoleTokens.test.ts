// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * CLI 与鉴权策略之间的那一道缝。
 *
 * 策略本身（「环回可以自动生成、非环回必须显式给、两个 token 都要够长且不同」）
 * 是 `packages/console/src/auth.ts` 的，也在那个包自己的用例里测过。这里测的是
 * **另一件事**：把 `parseConsoleArgs` 真正解析出来的配置喂给那条策略，会不会
 * 得到我们想要的结果——零参数起的控制台确实落在「自动生成」那一支，
 * `--hostname 0.0.0.0` 确实起不来，而 CLI 自己那个 generator 确实过得了包这一侧
 * 的长度下限。这三件事没有一件是包内单测能看见的。
 *
 * 这个文件单独放，是因为它必须在运行期 import `@qianmo/console`；参数面与端口
 * 的用例在 `consoleArgs.test.ts`，那边刻意不碰这个包，所以那些用例的成败与控制台
 * 包当下能不能加载无关。
 */

import { describe, expect, test } from 'bun:test'
import {
  MIN_TOKEN_LENGTH,
  isLoopbackHostname,
  resolveTokens,
} from '@qianmo/console'
import { newConsoleToken } from '../console.js'
import { parseConsoleArgs } from '../consoleArgs.js'

function tokensFor(args: readonly string[]): ReturnType<typeof resolveTokens> {
  const config = parseConsoleArgs(args, 'qianmo')
  return resolveTokens({
    ...(config.viewToken === undefined ? {} : { view: config.viewToken }),
    ...(config.adminToken === undefined ? {} : { admin: config.adminToken }),
    hostname: config.hostname,
    generate: newConsoleToken,
  })
}

describe('occ console token wiring', () => {
  test('the zero-argument console lands on the generating branch', () => {
    // 默认 hostname 必须是回环，否则 `occ console` 不带参数就起不来了。
    expect(isLoopbackHostname(parseConsoleArgs([], 'qianmo').hostname)).toBe(
      true,
    )
    const tokens = tokensFor([])
    expect(tokens.view).not.toBe(tokens.admin)
    expect(tokens.view.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
    expect(tokens.admin.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
  })

  test('the CLI generator clears the package floor with room to spare', () => {
    const first = newConsoleToken()
    const second = newConsoleToken()
    expect(first.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
    // 相同的两个 token 会被 `resolveTokens` 判成启动失败，这里先钉住不会相同。
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('a non-loopback bind refuses to start without both tokens', () => {
    // `--hostname 0.0.0.0` 正是控制台被挂上公网的那条路：起不来比悄悄起来好。
    expect(() => tokensFor(['--hostname=0.0.0.0'])).toThrow('非环回')
    expect(() =>
      tokensFor(['--hostname=0.0.0.0', '--view-token=view-token-long-enough']),
    ).toThrow('admin')
    expect(() =>
      tokensFor([
        '--hostname=0.0.0.0',
        '--admin-token=admin-token-long-enough',
      ]),
    ).toThrow('view')
  })

  test('a non-loopback bind starts when both tokens are supplied', () => {
    expect(
      tokensFor([
        '--hostname=0.0.0.0',
        '--view-token=view-token-long-enough',
        '--admin-token=admin-token-long-enough',
      ]),
    ).toEqual({
      view: 'view-token-long-enough',
      admin: 'admin-token-long-enough',
    })
  })

  test('a short or reused explicit token is a startup failure', () => {
    expect(() =>
      tokensFor([
        '--hostname=0.0.0.0',
        '--view-token=short',
        '--admin-token=admin-token-long-enough',
      ]),
    ).toThrow(String(MIN_TOKEN_LENGTH))
    expect(() =>
      tokensFor([
        '--hostname=0.0.0.0',
        '--view-token=same-token-long-enough',
        '--admin-token=same-token-long-enough',
      ]),
    ).toThrow('必须不同')
  })
})
