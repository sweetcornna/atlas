// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 子智能体那一行的开头，两处拼写，一条测试把它们钉在一起。
 *
 * `packages/resident/src/omp-turn.ts` 把一次派生子智能体（omp 的 `task` 工具）报成
 * 一行以 `SUBAGENT_STEP_LABEL` 开头的过程；对话前台（`packages/console/src/view/front.ts`）
 * 认这个开头，把那一行画成子智能体。控制台不依赖常驻包，所以那边留了一份字面量。
 * 这个包两边都能 import，由它来看守。
 *
 * 改了一边忘了另一边，症状是子智能体退回成一行普通过程——没有报错，只有画面少了
 * 子智能体。
 */

import { describe, expect, test } from 'bun:test'
import { SUBAGENT_STEP_LABEL as FRONT_LABEL } from '@qianmo/console'
import { SUBAGENT_STEP_LABEL } from '@qianmo/resident'

describe('子智能体过程行的开头', () => {
  test('常驻侧与对话前台的拼写必须一致', () => {
    expect(FRONT_LABEL).toBe(SUBAGENT_STEP_LABEL)
  })
})
