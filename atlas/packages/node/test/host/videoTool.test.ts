// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import type {
  VideoJob,
  VideoGenerationRequest,
  VideoContent,
} from '@oh-my-pi/pi-ai/video'
import { generateVideo, type VideoClient } from '../../src/host/videoTool.js'
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
