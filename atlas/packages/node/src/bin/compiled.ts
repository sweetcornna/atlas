// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Entry of the compiled `dist/qm-<target>` binary (`atlas/scripts/build-qm.ts`).
 *
 * One executable carries both qm and the oh-my-pi CLI. omp re-enters its own
 * main module for every worker (`new Worker(Bun.main, { argv })` and
 * `[execPath, '__omp_worker_*']` subprocesses), and in a compiled binary the
 * main module is this file, so this entry routes three cases to omp's CLI:
 *
 * - `qm agent …`: the `agent` word is dropped from `process.argv` and omp's
 *   `cli.ts` is imported. A compiled build defines `process.env.PI_COMPILED`,
 *   which makes that module its own process entry, so importing it runs
 *   `runCli(process.argv.slice(2))`;
 * - an omp worker selector (`__omp_worker_*`) as the first argument;
 * - any worker thread (`!Bun.isMainThread`).
 *
 * Everything else is a qm command. `QIANMO_OMP_ENTRY=self` is set first so the
 * resident host and `qm agent` spawn `<this binary> agent …` for omp children
 * (`src/omp/launch.ts`).
 *
 * No top-level await: omp's own entry avoids it because it breaks bytecode
 * builds, and the same promise-chain shape is kept here.
 */

import { isWorkerHostSelector } from '@oh-my-pi/pi-utils/worker-host'
import { ompChildEnv } from '@qianmo/paths'
import { exitOnStartupFailure } from '../host/startupFailure.js'
import { withoutManagedConfigEnvironment } from '../providers/whitelist.js'

process.env.QIANMO_OMP_ENTRY = 'self'

// Every branch can load omp natives, including the resident host itself.
// Set their extraction/config roots before either dynamic import, and retain
// the managed-provider literal scrub for this process as well as its children.
const isolatedEnv = withoutManagedConfigEnvironment(ompChildEnv(process.env))
for (const key of Object.keys(process.env)) {
  if (!(key in isolatedEnv)) delete process.env[key]
}
Object.assign(process.env, isolatedEnv)

const args = process.argv.slice(2)

function enterOmp(): Promise<unknown> {
  return import('@oh-my-pi/pi-coding-agent/cli')
}

if (!Bun.isMainThread || isWorkerHostSelector(args[0])) {
  void enterOmp()
} else if (args[0] === 'agent') {
  process.argv.splice(2, 1)
  void enterOmp()
} else {
  import('../cli.js').then(
    ({ main }) =>
      main(args).then(code => {
        process.exitCode = code
      }),
    exitOnStartupFailure,
  )
}
