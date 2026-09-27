// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `p81-registry.ts` 的 `--public-key <节点>=<公钥>`：真进程、真端口、真 HTTP v0。
 *
 * 本体一被 import 就解析 argv、起服务、写 ready 文件，所以这里不 import 它，而是像 beta-up
 * 那样把它当子进程起，再从名册（`GET /v0/agents`）读回来。登记逻辑本身由
 * `p81-announce-core.test.ts` 用真 `InMemoryRegistry` 钉着；这里钉的是命令行那一层：
 * 公钥按节点给、挂到该节点每一条登记上、升级前留在落盘表里的无公钥条目被补上、写错当场退出。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = join(REPOSITORY_ROOT, 'demo/lib/p81-registry.ts')
const KEY_1 = 'Inyg1lW5K3Tsc1VrzZ5-ifdAyfXrFzzBirnDnVsVsvQ'

const dirs: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-p81-registry-'))
  dirs.push(dir)
  return dir
}

interface Running {
  readonly child: ReturnType<typeof Bun.spawn>
  readonly url: string
}

async function start(dir: string, args: readonly string[]): Promise<Running> {
  const ready = join(dir, 'ready.json')
  rmSync(ready, { force: true })
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      ENTRY,
      '--ready',
      ready,
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      ...args,
    ],
    { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  children.push(child)
  for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) {
    await Bun.sleep(25)
  }
  const { url } = JSON.parse(readFileSync(ready, 'utf8')) as { url: string }
  return { child, url }
}

async function stop(running: Running): Promise<string> {
  running.child.kill('SIGTERM')
  await running.child.exited
  return await new Response(running.child.stderr as ReadableStream).text()
}

async function roster(url: string): Promise<Map<string, string | undefined>> {
  const response = await fetch(`${url}/v0/agents`)
  const body = (await response.json()) as {
    agents: { address: string; publicKey?: string }[]
  }
  return new Map(body.agents.map(agent => [agent.address, agent.publicKey]))
}

const REGISTER = [
  '--register',
  'qianmo://beta-1/planner=ws://127.0.0.1:38631',
  '--register',
  'qianmo://beta-1/reviewer=ws://127.0.0.1:38631',
  '--register',
  'qianmo://beta-4/planner=ws://127.0.0.1:38625',
]

describe('p81-registry --public-key', () => {
  test('按节点给一次，挂到该节点的每一条登记上；没给的节点照旧不带', async () => {
    const running = await start(scratch(), [
      ...REGISTER,
      '--public-key',
      `beta-1=${KEY_1}`,
    ])
    const listed = await roster(running.url)
    expect(listed.get('qianmo://beta-1/planner')).toBe(KEY_1)
    expect(listed.get('qianmo://beta-1/reviewer')).toBe(KEY_1)
    expect(listed.has('qianmo://beta-4/planner')).toBe(true)
    expect(listed.get('qianmo://beta-4/planner')).toBeUndefined()
  }, 15_000)

  test('升级：落盘表里还活着的无公钥条目，重起时被补上公钥，并且出声', async () => {
    const dir = scratch()
    const state = join(dir, 'registry-agents.json')
    // 先按旧形态（不带公钥）跑一轮，留下落盘表——现场升级前的样子。
    const before = await start(dir, [...REGISTER, '--state', state])
    expect((await roster(before.url)).get('qianmo://beta-1/planner')).toBe(
      undefined,
    )
    await stop(before)

    // 90 s 租约之内重起：表从落盘恢复，条目还活着。旧逻辑在这里只做心跳，公钥永远进不来。
    const after = await start(dir, [
      ...REGISTER,
      '--state',
      state,
      '--public-key',
      `beta-1=${KEY_1}`,
    ])
    const listed = await roster(after.url)
    expect(listed.get('qianmo://beta-1/planner')).toBe(KEY_1)
    expect(listed.get('qianmo://beta-1/reviewer')).toBe(KEY_1)
    expect(await stop(after)).toContain(
      `registry 公钥已更新：qianmo://beta-1/planner （无） → ${KEY_1}`,
    )
  }, 15_000)

  test.each([
    ['节点名笔误（没有任何 --register 属于它）', `beta-9=${KEY_1}`, 'beta-9'],
    ['形状不对', 'beta-1=not-a-key', 'not-a-key'],
  ])(
    '写错当场退出：%s',
    async (_label, value, mentioned) => {
      const dir = scratch()
      const child = Bun.spawn(
        [
          process.execPath,
          'run',
          ENTRY,
          '--ready',
          join(dir, 'ready.json'),
          '--port',
          '0',
          ...REGISTER,
          '--public-key',
          value,
        ],
        { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' },
      )
      children.push(child)
      const exited = await Promise.race([
        child.exited,
        Bun.sleep(4_000).then(() => 'still running' as const),
      ])
      expect(exited).not.toBe('still running')
      expect(exited).not.toBe(0)
      const stderr = await new Response(child.stderr as ReadableStream).text()
      expect(stderr).toContain(mentioned)
      // 起不来就不该写 ready：beta-up 等的正是这个文件。
      expect(existsSync(join(dir, 'ready.json'))).toBe(false)
    },
    15_000,
  )
})
