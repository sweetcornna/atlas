// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 主智能体的页面设置（初始化配置页，`MainAgentPort`）。
 *
 * 启动参数 `--chat-default` 仍是缺省；页面上选过一次后，存在这里的值盖过它，
 * 直到在页面上「恢复启动参数」。一个 0600 的小 JSON 文件，启动时读一次，之后
 * `get` 只读内存——对话首页每次渲染都要问，不能每次碰盘。
 *
 * 文件坏了（被手改、写了一半）按「没设过」处理并在 stderr 说一句，不让控制台
 * 因为一个偏好文件起不来；下一次保存会整份重写。
 */

import type { ConsoleResult, MainAgentPort } from '@qianmo/console'
import { qianmoConfigPath } from '@qianmo/paths'
import { readTextIfExists, writePrivateJson } from '../providers/store.js'

/** 缺省位置，与控制台其他小存储同目录。 */
export function consoleMainAgentPath(): string {
  return qianmoConfigPath('qianmo', 'console', 'main-agent.json')
}

const ADDRESS =
  /^qianmo:\/\/[a-z0-9][a-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

interface Stored {
  readonly v: 1
  readonly address: string | null
  readonly updatedAt: number
  readonly updatedBy: string
}

function parse(text: string): string | null {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null)
    throw new Error('not an object')
  const record = value as Record<string, unknown>
  if (record.v !== 1) throw new Error('unknown version')
  const address = record.address
  if (address === null) return null
  if (typeof address !== 'string' || !ADDRESS.test(address))
    throw new Error('bad address')
  return address
}

export class ConsoleMainAgent implements MainAgentPort {
  readonly #path: string
  readonly #now: () => number
  #address: string | null

  constructor(
    options: {
      readonly path?: string
      readonly now?: () => number
      readonly warn?: (line: string) => void
    } = {},
  ) {
    this.#path = options.path ?? consoleMainAgentPath()
    this.#now = options.now ?? Date.now
    this.#address = null
    try {
      const text = readTextIfExists(this.#path)
      if (text !== undefined) this.#address = parse(text)
    } catch (error) {
      options.warn?.(
        `main agent file unreadable, using --chat-default: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  get(): string | null {
    return this.#address
  }

  async set(address: string | null, by: string): Promise<ConsoleResult<null>> {
    if (address !== null && !ADDRESS.test(address)) {
      return {
        ok: false,
        failure: {
          code: 'invalid',
          message: '地址格式应为 qianmo://<节点>/<智能体>',
        },
      }
    }
    const stored: Stored = {
      v: 1,
      address,
      updatedAt: this.#now(),
      updatedBy: by,
    }
    try {
      writePrivateJson(this.#path, stored)
    } catch {
      return {
        ok: false,
        failure: {
          code: 'unreachable',
          message: '主智能体设置写入失败 · 检查配置目录权限',
        },
      }
    }
    this.#address = address
    return { ok: true, value: null }
  }
}
