// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HandoffGitPort } from '@qianmo/console'
import { qianmoConfigPath } from '@qianmo/paths'
import { FileLedger } from './consoleAccountsStore.js'
import { initHubRepository } from './handoffHub.js'
import { assertProjectName } from './handoffStore.js'

const error = (status: number, message: string): Response =>
  Response.json(
    { error: { code: status === 403 ? 'forbidden' : 'invalid', message } },
    { status },
  )

export function openConsoleHandoffGit(
  root: string,
  ledgerPath = qianmoConfigPath('qianmo', 'handoff', 'projects.ndjson'),
): HandoffGitPort & {
  close(): void
  owns(project: string, owner: string): boolean
} {
  const store = new FileLedger(ledgerPath)
  const owners = new Map<string, string>()
  const content = store.read()
  if (content !== null) {
    if (!content.endsWith('\n')) throw new Error('项目账本尾部不完整')
    for (const line of content.trim().split('\n')) {
      if (!line) continue
      const value: { project: string; owner: string } = JSON.parse(line)
      assertProjectName(value.project)
      if (typeof value.owner !== 'string' || owners.has(value.project))
        throw new Error('项目账本损坏')
      owners.set(value.project, value.owner)
    }
  }
  const prepared = new Map<string, Promise<string>>()
  const prepare = (project: string): Promise<string> => {
    let pending = prepared.get(project)
    if (!pending) {
      pending = initHubRepository({ kind: 'local', root }, project)
      prepared.set(project, pending)
      void pending.finally(() => prepared.delete(project)).catch(() => {})
    }
    return pending
  }
  return {
    owns: (project, owner) => owners.get(project) === owner,
    async createProject(project, actor) {
      try {
        assertProjectName(project)
      } catch {
        return error(400, '项目名不合法')
      }
      const owner = owners.get(project)
      if (owner !== undefined && owner !== actor.owner)
        return error(403, '项目不属于此账号')
      if (owner === undefined) {
        // Existing SSH repositories have no authenticated owner; never let a
        // paired caller acquire them simply by knowing their names.
        if (fs.existsSync(path.join(root, `${project}.git`)))
          return error(403, '旧式项目没有设备属主，请使用原有登记')
        store.append(`${JSON.stringify({ project, owner: actor.owner })}\n`)
        owners.set(project, actor.owner)
      }
      await prepare(project)
      return Response.json(
        { project, created: owner === undefined },
        { status: owner === undefined ? 201 : 200 },
      )
    },
    async handle(request, project, service, advertise, actor) {
      try {
        assertProjectName(project)
      } catch {
        return error(400, '项目名不合法')
      }
      if (owners.get(project) !== actor.owner)
        return error(403, '项目不属于此账号')
      const repo = await prepare(project)
      let body: ReadableStream<Uint8Array> | null = null
      if (!advertise && request.body) {
        const encoding = request.headers.get('content-encoding')
        if (encoding !== null && encoding !== 'gzip' && encoding !== 'identity')
          return error(415, '请求压缩格式不支持')
        body =
          encoding === 'gzip'
            ? request.body.pipeThrough(new DecompressionStream('gzip'))
            : request.body
      }
      const protocol = request.headers.get('git-protocol')
      const proc = Bun.spawn(
        [
          'git',
          service,
          '--stateless-rpc',
          ...(advertise ? ['--advertise-refs'] : []),
          repo,
        ],
        {
          stdin: body ?? 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
          env: {
            ...process.env,
            ...(protocol === null ? {} : { GIT_PROTOCOL: protocol }),
            ...(service === 'receive-pack'
              ? { QIANMO_HANDOFF_DEVICE: actor.deviceId }
              : {}),
          },
        },
      )
      const reader = proc.stdout.getReader()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (advertise) {
            const line = `# service=git-${service}\n`
            controller.enqueue(
              new TextEncoder().encode(
                `${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, '0')}${line}0000`,
              ),
            )
          }
        },
        async pull(controller) {
          try {
            const result = await reader.read()
            if (result.done) {
              if ((await proc.exited) !== 0)
                controller.error(new Error('git RPC failed'))
              else controller.close()
            } else controller.enqueue(result.value)
          } catch (cause) {
            proc.kill()
            controller.error(cause)
          }
        },
        async cancel() {
          proc.kill()
          await reader.cancel()
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': `application/x-git-${service}-${advertise ? 'advertisement' : 'result'}`,
          'cache-control': 'no-cache',
        },
      })
    },
    close() {
      store.close()
    },
  }
}
