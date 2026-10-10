// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  AllocationRejected,
  type AllocationPlan,
  type PoolAdapter,
  type WorkerReceipt,
} from '@qianmo/elastic'

interface WorkerSpec {
  plan: AllocationPlan
  token: string
  socket: string
  receiptFile: string
}
async function probe(receipt: WorkerReceipt): Promise<boolean> {
  try {
    const response = await fetch('http://localhost/status', {
      unix: receipt.socket,
      headers: { Authorization: `Bearer ${receipt.token}` },
      signal: AbortSignal.timeout(1000),
    })
    const body = (await response.json()) as { id?: string; pid?: number }
    return response.ok && body.id === receipt.id && body.pid === receipt.pid
  } catch {
    return false
  }
}
function processHasExited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  // A live or reused PID and EPERM are all uncertain, never proof of release.
  return false
}
/** Existing pool simulation only: a private home/cwd, closed environment and a local worker, no cloud API. */
export function localPoolAdapter(): PoolAdapter & {
  inspect(plan: AllocationPlan): Promise<WorkerReceipt | null>
} {
  const directory = (id: string) =>
    qianmoConfigPath('qianmo', 'elastic', 'workers', id)
  return {
    async allocate(plan) {
      const root = directory(plan.id)
      if (existsSync(root))
        throw new Error('worker state already exists; inspect before retry')
      mkdirSync(root, { recursive: true, mode: 0o700 })
      mkdirSync(join(root, 'home'), { mode: 0o700 })
      const spec: WorkerSpec = {
        plan,
        token: randomBytes(32).toString('hex'),
        socket: join(tmpdir(), `qe-${randomBytes(8).toString('hex')}.sock`),
        receiptFile: join(root, 'receipt.json'),
      }
      const specFile = join(root, 'spec.json')
      writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600, flag: 'wx' })
      const argv =
        process.env.QIANMO_OMP_ENTRY === 'self'
          ? [process.execPath, 'elastic', '__worker', '--spec', specFile]
          : [
              process.execPath,
              join(import.meta.dir, '../cli.ts'),
              'elastic',
              '__worker',
              '--spec',
              specFile,
            ]
      let child: ReturnType<typeof Bun.spawn>
      try {
        child = Bun.spawn(argv, {
          cwd: root,
          env: {
            HOME: join(root, 'home'),
            PATH: process.env.PATH ?? '',
            QIANMO_CONFIG_DIR: join(root, 'config'),
          },
          stdin: 'ignore',
          stdout: Bun.file(join(root, 'worker.log')),
          stderr: Bun.file(join(root, 'worker.stderr')),
        })
      } catch {
        throw new AllocationRejected('worker could not be spawned')
      }
      child.unref()
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (existsSync(spec.receiptFile)) {
          const receipt = JSON.parse(
            readFileSync(spec.receiptFile, 'utf8'),
          ) as WorkerReceipt
          if (await probe(receipt)) return receipt
        }
        if (child.exitCode !== null)
          throw new AllocationRejected(
            'worker exited before allocation was ready',
          )
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('worker readiness unknown')
    },
    async release(receipt) {
      if (Date.now() >= receipt.expiresAt && processHasExited(receipt.pid))
        return
      const response = await fetch('http://localhost/release', {
        unix: receipt.socket,
        method: 'POST',
        headers: { Authorization: `Bearer ${receipt.token}` },
        signal: AbortSignal.timeout(2000),
      })
      const body = (await response.json()) as { released?: string }
      if (!response.ok || body.released !== receipt.id)
        throw new Error('worker release not acknowledged')
      const deadline = Date.now() + 2000
      // An HTTP error, timeout, or closed listener does not establish process exit.
      while (!processHasExited(receipt.pid)) {
        if (Date.now() >= deadline)
          throw new Error('worker process exit could not be confirmed')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    },
    async inspect(plan) {
      const file = join(directory(plan.id), 'receipt.json')
      if (!existsSync(file)) return null
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as WorkerReceipt
      return receipt.id === plan.id && (await probe(receipt)) ? receipt : null
    },
  }
}

/** Internal child route keeps the compiled binary self-contained. */
export function runPoolWorker(specFile: string): void {
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as WorkerSpec
  const startedAt = Date.now()
  const receipt: WorkerReceipt = {
    id: spec.plan.id,
    kind: 'local-pool-worker',
    socket: spec.socket,
    token: spec.token,
    pid: process.pid,
    startedAt,
    expiresAt: startedAt + spec.plan.durationMs,
  }
  let timer: ReturnType<typeof setTimeout>
  const server = Bun.serve({
    unix: spec.socket,
    fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${spec.token}`)
        return new Response('unauthorized', { status: 401 })
      const path = new URL(request.url).pathname
      if (path === '/status')
        return Response.json({
          id: receipt.id,
          pid: receipt.pid,
          mode: 'existing-pool-local-simulation',
        })
      if (path === '/release' && request.method === 'POST') {
        clearTimeout(timer)
        // Close only this worker's listener, after its release response can flush.
        setTimeout(() => {
          void server.stop(true)
        }, 25)
        return Response.json({ released: receipt.id })
      }
      return new Response('not found', { status: 404 })
    },
  })
  chmodSync(spec.socket, 0o600)
  writeFileSync(spec.receiptFile, JSON.stringify(receipt), {
    mode: 0o600,
    flag: 'wx',
  })
  writeFileSync(
    join(process.cwd(), 'started.json'),
    JSON.stringify({
      id: receipt.id,
      pid: receipt.pid,
      startedAt,
      cpuCores: spec.plan.cpuCores,
      memoryMb: spec.plan.memoryMb,
      mode: 'logical capacity, no OS CPU/memory quota claim',
    }),
    { mode: 0o600, flag: 'wx' },
  )
  timer = setTimeout(() => {
    void server.stop(true)
  }, spec.plan.durationMs)
}
