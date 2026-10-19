// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 后台任务 for the preview (`./serve.ts`): a handful of sub-agent tasks in
 * every state the front's 后台任务 section draws, and a cancel that stops the
 * running ones. Not a test, and not a model of the hub's book — just enough
 * rows to look at.
 */

import type {
  BackgroundTaskReader,
  BackgroundTasksPort,
  BackgroundTaskView,
  DirectionActor,
} from '../../src/directionPorts.js'
import type { ConsoleResult } from '../../src/deps.js'

function task(
  over: Partial<BackgroundTaskView> &
    Pick<BackgroundTaskView, 'id' | 'title' | 'target' | 'status'>,
  now: number,
): BackgroundTaskView {
  return {
    owner: 'preview',
    phase: '',
    progress: '',
    lastError: '',
    turns: 1,
    workerSession: null,
    nextAt: null,
    everyMinutes: null,
    runsLeft: null,
    createdAt: now - 600_000,
    updatedAt: now - 60_000,
    ...over,
  }
}

export class PreviewTasks implements BackgroundTasksPort {
  readonly #tasks: BackgroundTaskView[]
  readonly #now: () => number

  constructor(now: () => number) {
    this.#now = now
    const at = now()
    this.#tasks = [
      task(
        {
          id: 't-review',
          title: '复核 feat/console-redesign 的样式改动',
          target: 'qianmo://beta-5/reviewer',
          status: 'running',
          phase: '运行中',
          progress: '已读完 css.ts 与 frontStyle.ts · 正在比对深色主题',
          createdAt: at - 252_000,
          updatedAt: at - 8_000,
        },
        at,
      ),
      task(
        {
          id: 't-bench',
          title: '在 beta-1 上跑一遍门禁并汇报耗时',
          target: 'qianmo://beta-1/planner',
          status: 'queued',
          phase: '排队中',
          createdAt: at - 40_000,
          updatedAt: at - 40_000,
        },
        at,
      ),
      task(
        {
          id: 't-notes',
          title: '整理本周发版说明',
          target: 'qianmo://beta-5/coder',
          status: 'completed',
          phase: '已完成',
          progress: '发版说明已写好 · 共 12 条改动 · 放在 docs/dev/notes.md',
          turns: 3,
          createdAt: at - 3_600_000,
          updatedAt: at - 1_800_000,
        },
        at,
      ),
      task(
        {
          id: 't-mem',
          title: '查各节点的内存余量',
          target: 'qianmo://beta-1/planner',
          status: 'needs_input',
          phase: '待你处理',
          progress: 'beta-4 不在线 · 要不要跳过它',
          createdAt: at - 900_000,
          updatedAt: at - 300_000,
        },
        at,
      ),
    ]
  }

  list(_actor: BackgroundTaskReader): readonly BackgroundTaskView[] {
    return [...this.#tasks].sort((a, b) => b.createdAt - a.createdAt)
  }

  visible(id: string, _actor: BackgroundTaskReader): boolean {
    return this.#tasks.some(one => one.id === id)
  }

  cancel(
    id: string,
    _actor: DirectionActor,
  ): Promise<ConsoleResult<BackgroundTaskView>> {
    const index = this.#tasks.findIndex(one => one.id === id)
    const found = this.#tasks[index]
    if (found === undefined) {
      return Promise.resolve({
        ok: false,
        failure: { code: 'not_found', message: '后台任务不存在' },
      })
    }
    const stopped: BackgroundTaskView = {
      ...found,
      status: 'cancelled',
      phase: '已取消',
      updatedAt: this.#now(),
    }
    this.#tasks[index] = stopped
    return Promise.resolve({ ok: true, value: stopped })
  }
}
