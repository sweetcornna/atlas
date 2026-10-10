// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The trusted host owns expected values. Generated modules run only in the OS
 * sandbox and return data; their printed test summaries are never the oracle. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { runIsolatedCheck, type ValidationResult } from './taskValidation.js'

export type OracleTask =
  | 'slugify'
  | 'protocol-agent-of'
  | 'transport-jitter-freeze'
  | 'transport-success-receipt-type'
export interface TaskOracleResult {
  passed: boolean
  cases: number
  isolation: ValidationResult['isolation']
  output: string
}

export function verifyTaskOracle(
  task: OracleTask,
  workspace: string,
): TaskOracleResult {
  let module: string, inputs: unknown[], expected: unknown[], expression: string
  if (task === 'slugify') {
    module = './src/slugify.ts'
    const titles = [
      'Hello World',
      'Qianmo  --  AgentNest!!',
      '  ///Edge Case///  ',
      'Release 2.38.3',
      '***',
    ]
    for (let i = 0; i < 24; i++)
      titles.push(` /// Qm ${randomUUID().toUpperCase()} -- ${i} !! `)
    inputs = titles
    expected = titles.map(value =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
    )
    expression = 'inputs.map(value => module.slugify(value))'
  } else if (task === 'protocol-agent-of') {
    module = './atlas/packages/protocol/src/index.ts'
    inputs = [
      null,
      7,
      {},
      'garbage',
      'qianmo://a/b/c',
      'qianmo://a/-b',
      'qianmo://UPPER/b',
    ]
    expected = inputs.map(() => null)
    for (let i = 0; i < 24; i++) {
      const agent = `agent-${randomUUID()}`
      inputs.push(`qianmo://node-${i}/${agent}`)
      expected.push(agent)
    }
    expression = 'inputs.map(value => module.agentOf(value))'
  } else if (task === 'transport-success-receipt-type') {
    module = './atlas/packages/transport/src/frames.ts'
    inputs = [null]
    expected = [[1, 'receipt', 'accepted', 'duplicate', 'rejected']]
    expression =
      '[[module.FRAME_VERSION, module.FrameType.Receipt, module.ReceiptStatus.Accepted, module.ReceiptStatus.Duplicate, module.ReceiptStatus.Rejected]]'
  } else {
    module = './atlas/packages/transport/src/backoff.ts'
    inputs = []
    expected = []
    for (const random of [0, 0.5, 1, Math.random()]) {
      const start = Math.floor(Math.random() * 100_000)
      const times: number[] = []
      const decisions: unknown[] = []
      let now = start
      for (let i = 0; i < 8; i++) {
        times.push(now)
        const base = Math.min(1000 * 2 ** i, 30000)
        const delayMs = Math.round(base * (1 + 0.25 * (2 * random - 1)))
        decisions.push({
          action: 'retry',
          attempt: i + 1,
          delayMs,
          timeJumpDetected: false,
        })
        now += delayMs
      }
      inputs.push({ random, times })
      expected.push(decisions)
    }
    const start = Math.floor(Math.random() * 100_000)
    inputs.push({ random: 0.5, times: [start, start + 34700] })
    expected.push([
      { action: 'retry', attempt: 1, delayMs: 1000, timeJumpDetected: false },
      { action: 'retry', attempt: 1, delayMs: 1000, timeJumpDetected: true },
    ])
    expression = `inputs.map(({ random, times }) => {
      const schedule = new module.ReconnectSchedule({ ...module.DEFAULT_BACKOFF, timeJumpFactor: 1.1 }, () => random);
      return times.map(now => schedule.next(now));
    })`
  }
  const nonce = randomUUID()
  // Only inputs cross into the child. Capture output functions before importing
  // the generated module; a module exiting during import returns no result.
  const code = `const emit = process.stdout.write.bind(process.stdout);
const encode = JSON.stringify;
const inputs = ${JSON.stringify(inputs)};
const module = await import(${JSON.stringify(module)});
const values = ${expression};
emit(encode({ nonce: ${JSON.stringify(nonce)}, values }));`
  const result = runIsolatedCheck(['bun', '-e', code], workspace)
  let passed = false
  try {
    passed =
      result.code === 0 &&
      isDeepStrictEqual(JSON.parse(result.stdout), { nonce, values: expected })
  } catch {
    /* Missing/forged runner summaries are not oracle data. */
  }
  return {
    passed,
    cases: inputs.length,
    isolation: result.isolation,
    output: JSON.stringify({
      task,
      passed,
      cases: inputs.length,
      childExitCode: result.code,
    }),
  }
}
