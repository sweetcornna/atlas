// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import * as path from 'node:path'
import { isolatedRoot } from '../providers/fake.js'
import { providerPaths, writePrivateJson } from '../../src/providers/store.js'
import type { VideoLimits } from '../../src/host/videoSave.js'
import type {
  VideoJob,
  VideoGenerationRequest,
  VideoContent,
} from '@oh-my-pi/pi-ai/video'
import {
  generateVideo,
  runVideoTool,
  type VideoClient,
} from '../../src/host/videoTool.js'
function fake(
  statuses: VideoJob['status'][] = ['pending', 'processing', 'completed'],
) {
  const calls: string[] = []
  const submits: VideoGenerationRequest[] = []
  let clock = 1000
  const client: VideoClient = {
    async submit(request) {
      calls.push('submit')
      submits.push(request)
      return { id: 'job-a', status: statuses.shift() ?? 'completed' }
    },
    async poll(id) {
      calls.push(`poll:${id}`)
      return { id, status: statuses.shift() ?? 'completed' }
    },
    async download(id) {
      calls.push(`download:${id}`)
      return {
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]))
            c.close()
          },
        }),
        contentType: 'video/mp4',
      }
    },
  }
  const saved: { path: string; bytes: number[] }[] = []
  const deps = {
    client,
    now: () => clock,
    id: () => 'abcdefgh-unsafe',
    async pause(ms: number) {
      clock += ms
    },
    async save(path: string, content: VideoContent) {
      saved.push({
        path,
        bytes: [
          ...new Uint8Array(await new Response(content.body).arrayBuffer()),
        ],
      })
    },
  }
  return { calls, submits, saved, deps }
}
test('submit -> poll -> download -> workspace relative MP4 includes requested duration and aspect', async () => {
  const f = fake()
  const result = await generateVideo(
    { prompt: 'a tree', seconds: 8, aspect: '16:9' },
    f.deps,
  )
  expect(result).toEqual({
    ok: true,
    path: 'outputs/videos/11000-abcdefgh.mp4',
    seconds: 8,
  })
  expect(f.submits).toEqual([
    { prompt: 'a tree', duration: 8, aspectRatio: '16:9' },
  ])
  expect(f.calls).toEqual([
    'submit',
    'poll:job-a',
    'poll:job-a',
    'download:job-a',
  ])
  expect(f.saved[0]?.bytes).toEqual([1, 2, 3])
})
test('terminal failure prevents download; invalid input never submits', async () => {
  const f = fake(['failed'])
  expect(await generateVideo({ prompt: 'tree' }, f.deps)).toEqual({
    ok: false,
    error: '视频生成失败 (failed)',
  })
  expect(f.calls).toEqual(['submit'])
  for (const args of [
    { prompt: '' },
    { prompt: 'x', seconds: 0 },
    { prompt: 'x', aspect: '99:99' },
    { prompt: 'x', extra: 'unknown' },
  ])
    expect((await generateVideo(args, f.deps)).ok).toBe(false)
  expect(f.calls).toEqual(['submit'])
})
test('poll deadline and a non-cooperative hung submission both return explicit timeout', async () => {
  const f = fake(['pending', 'pending', 'pending'])
  const result = await generateVideo(
    { prompt: 'tree' },
    { ...f.deps, timeoutMs: 5 },
  )
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining('超时'),
  })
  expect(f.saved).toEqual([])
  const blocked = Promise.withResolvers<VideoJob>()
  const hung = await generateVideo(
    { prompt: 'tree' },
    {
      ...fake().deps,
      client: { ...f.deps.client, submit: () => blocked.promise },
      now: Date.now,
      timeoutMs: 10,
    },
  )
  expect(hung).toMatchObject({
    ok: false,
    error: expect.stringContaining('超时'),
  })
})
test('client errors are bounded and never expose a credential in output', async () => {
  const f = fake()
  const result = await generateVideo(
    { prompt: 'tree' },
    {
      ...f.deps,
      client: {
        ...f.deps.client,
        async submit() {
          throw new Error('sk-secret-should-not-appear')
        },
      },
    },
  )
  expect(result).toEqual({ ok: false, error: '视频提交失败' })
})

test('cancellation before invocation spends no client request', async () => {
  const f = fake()
  const controller = new AbortController()
  controller.abort()
  expect(
    await generateVideo(
      { prompt: 'tree' },
      { ...f.deps, signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining('取消') })
  expect(f.calls).toEqual([])
})

test('an omitted duration is explicit on the video wire and polling streams real status for the resident watchdog', async () => {
  const f = fake()
  const progress: string[] = []
  const result = await generateVideo(
    { prompt: 'tree' },
    { ...f.deps, progress: status => progress.push(status) },
  )
  expect(result).toMatchObject({ ok: true, seconds: 8 })
  expect(f.submits[0]).toEqual({ prompt: 'tree', duration: 8 })
  expect(progress).toEqual(['pending', 'processing', 'completed'])
})

test('poll, download and write failures identify the failing phase and keep private details out', async () => {
  for (const phase of ['poll', 'download', 'save'] as const) {
    const f = fake(phase === 'poll' ? ['pending'] : ['completed'])
    const failure = async (): Promise<never> => {
      throw new Error('sk-private-failure-detail')
    }
    const deps =
      phase === 'save'
        ? { ...f.deps, save: failure }
        : { ...f.deps, client: { ...f.deps.client, [phase]: failure } }
    expect(await generateVideo({ prompt: 'tree' }, deps)).toEqual({
      ok: false,
      error:
        phase === 'poll'
          ? '视频轮询失败'
          : phase === 'download'
            ? '视频下载失败'
            : '视频文件写入失败',
    })
    expect(f.saved).toEqual([])
  }
})

const mp4 = new Uint8Array(96)
mp4.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
function videoSetup(limits: Partial<VideoLimits> = {}) {
  const f = isolatedRoot()
  const workspace = path.join(f.root, 'workspace')
  const outside = path.join(f.root, 'outside')
  fs.mkdirSync(workspace)
  fs.mkdirSync(outside)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith('/content'))
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      return Response.json({ id: 'video-job', status: 'completed' })
    },
  })
  writePrivateJson(providerPaths.config(), {
    modelRoles: { video: 'fake-video/video:off' },
    qianmoVideoLimits: limits,
  })
  writePrivateJson(providerPaths.models(), {
    providers: {
      'fake-video': {
        api: 'openrouter-video',
        apiKey: 'test-no-secret',
        baseUrl: `http://127.0.0.1:${server.port}`,
        models: [{ id: 'video', api: 'openrouter-video' }],
      },
    },
  })
  return {
    workspace,
    outside,
    staging: path.join(f.root, 'resident', 'video-staging'),
    dispose: async () => {
      await server.stop(true)
      f.dispose()
    },
  }
}
test('production runVideoTool stages, validates and commits an MP4 through the real HTTP client', async () => {
  const f = videoSetup()
  try {
    const result = await runVideoTool(f.workspace, { prompt: 'tree' })
    if (!result.ok) throw new Error(result.error)
    expect(
      new Uint8Array(
        await Bun.file(path.join(f.workspace, result.path)).arrayBuffer(),
      ),
    ).toEqual(mp4)
    expect(fs.readdirSync(f.staging)).toEqual([])
    expect(fs.statSync(path.join(f.workspace, result.path)).mode & 0o777).toBe(
      0o600,
    )
  } finally {
    await f.dispose()
  }
})
for (const swapped of ['outputs', 'videos'])
  test(`production runVideoTool rejects ${swapped} replaced by an outside symlink immediately before file open`, async () => {
    const f = videoSetup()
    if (swapped === 'outputs') fs.mkdirSync(path.join(f.outside, 'videos'))
    const original = asyncFs.open
    let attacked = false
    const spy = spyOn(asyncFs, 'open').mockImplementation(
      async (target, flags, mode) => {
        if (!attacked && String(target).endsWith('.mp4')) {
          attacked = true
          const parent = path.join(
            f.workspace,
            'outputs',
            ...(swapped === 'videos' ? ['videos'] : []),
          )
          fs.renameSync(parent, `${parent}-old`)
          fs.symlinkSync(f.outside, parent)
        }
        return await original(target, flags, mode)
      },
    )
    try {
      const result = await runVideoTool(f.workspace, { prompt: 'tree' })
      expect(attacked).toBe(true)
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining('视频输出'),
      })
      expect(
        fs.readdirSync(
          swapped === 'outputs' ? path.join(f.outside, 'videos') : f.outside,
        ),
      ).toEqual([])
      expect(fs.readdirSync(f.staging)).toEqual([])
      const old =
        swapped === 'videos'
          ? path.join(f.workspace, 'outputs', 'videos-old')
          : path.join(f.workspace, 'outputs-old', 'videos')
      expect(fs.readdirSync(old)).toEqual([])
    } finally {
      spy.mockRestore()
      await f.dispose()
    }
  })
test('production runVideoTool counts bytes rather than Content-Length, cancels an over-limit stream and removes its partial', async () => {
  const f = videoSetup({ maxFileBytes: 64 })
  let cancelled = false
  let chunks = 0
  const client: VideoClient = {
    async submit() {
      return { id: 'job', status: 'completed' }
    },
    async poll() {
      throw new Error('must not poll')
    },
    async download() {
      return {
        contentType: 'video/mp4',
        contentLength: 1,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks++
            controller.enqueue(mp4.subarray(0, 32))
          },
          cancel() {
            cancelled = true
          },
        }),
      }
    },
  }
  try {
    const result = await runVideoTool(
      f.workspace,
      { prompt: 'tree' },
      undefined,
      undefined,
      { client },
    )
    expect(result).toEqual({
      ok: false,
      error: '视频下载超过单文件上限（64 字节）',
    })
    expect(cancelled).toBe(true)
    expect(chunks).toBeLessThanOrEqual(4)
    expect(fs.readdirSync(f.staging)).toEqual([])
    expect(fs.existsSync(path.join(f.workspace, 'outputs'))).toBe(false)
  } finally {
    await f.dispose()
  }
})
for (const [limits, label] of [
  [{ maxCallBytes: 64 }, '单次调用'],
  [{ maxStagingBytes: 100 }, '节点暂存总量'],
] as const)
  test(`production runVideoTool enforces ${label} budget and retains unrelated staged data`, async () => {
    const f = videoSetup(limits)
    try {
      if (label === '节点暂存总量') {
        fs.mkdirSync(f.staging, { recursive: true, mode: 0o700 })
        fs.writeFileSync(
          path.join(f.staging, 'orphan.part'),
          new Uint8Array(16),
        )
      }
      const result = await runVideoTool(f.workspace, { prompt: 'tree' })
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(`${label}上限`),
      })
      expect(fs.readdirSync(f.staging)).toEqual(
        label === '节点暂存总量' ? ['orphan.part'] : [],
      )
      expect(fs.existsSync(path.join(f.workspace, 'outputs'))).toBe(false)
    } finally {
      await f.dispose()
    }
  })
test('production runVideoTool rejects a fake MP4 header, invalid limits and pre-existing output symlinks', async () => {
  const f = videoSetup()
  const client: VideoClient = {
    async submit() {
      return { id: 'job', status: 'completed' }
    },
    async poll() {
      throw new Error('must not poll')
    },
    async download() {
      return {
        contentType: 'video/mp4',
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(16))
            c.close()
          },
        }),
      }
    },
  }
  try {
    expect(
      await runVideoTool(
        f.workspace,
        { prompt: 'tree' },
        undefined,
        undefined,
        { client },
      ),
    ).toEqual({ ok: false, error: '视频下载缺少有效 MP4 文件头' })
    expect(fs.readdirSync(f.staging)).toEqual([])
    fs.symlinkSync(f.outside, path.join(f.workspace, 'outputs'))
    expect((await runVideoTool(f.workspace, { prompt: 'tree' })).ok).toBe(false)
    expect(fs.readdirSync(f.outside)).toEqual([])
    writePrivateJson(providerPaths.config(), {
      modelRoles: { video: 'fake-video/video:off' },
      qianmoVideoLimits: { maxFileBytes: -1 },
    })
    expect(await runVideoTool(f.workspace, { prompt: 'tree' })).toEqual({
      ok: false,
      error: '视频保存上限配置不合法',
    })
  } finally {
    await f.dispose()
  }
})
