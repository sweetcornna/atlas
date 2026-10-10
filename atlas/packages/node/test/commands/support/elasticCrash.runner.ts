// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Crash window probe: a real worker is ready but the controller hasn't committed its receipt. */
import { readFileSync } from 'node:fs'
import { ElasticController, catalogSchema } from '@qianmo/elastic'
import { qianmoConfigPath } from '@qianmo/paths'
import { localPoolAdapter } from '../../../src/commands/elasticWorker.js'
const catalog = catalogSchema.parse(
  JSON.parse(readFileSync(process.argv[2]!, 'utf8')),
)
const controller = new ElasticController(
  qianmoConfigPath('qianmo', 'elastic', 'operations.sqlite'),
  catalog,
)
const local = localPoolAdapter()
setInterval(() => {}, 60000)
await controller.apply('crash', 'a', {
  ...local,
  async allocate(plan) {
    const receipt = await local.allocate(plan)
    console.log(JSON.stringify({ event: 'allocated', pid: receipt.pid }))
    return await new Promise(() => {})
  },
})
