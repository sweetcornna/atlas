// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildModel } from '@oh-my-pi/pi-catalog/build'
import {
  downloadVideo,
  pollVideo,
  submitVideo,
  type VideoJob,
  type VideoGenerationRequest,
  type VideoContent,
} from '@oh-my-pi/pi-ai/video'
import { configuredProvider } from '../providers/node.js'

export const DEFAULT_VIDEO_SECONDS = 8
export const VIDEO_TOOL = {
  name: 'qianmo_generate_video',
  description:
    'Generate a video from a prompt using the configured video model. Returns a workspace-relative MP4 path.',
  loadMode: 'essential' as const,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 1 },
      seconds: {
        type: 'integer',
        minimum: 1,
        maximum: 120,
        default: DEFAULT_VIDEO_SECONDS,
      },
      aspect: {
        type: 'string',
        enum: [
          '16:9',
          '9:16',
          '1:1',
          '4:3',
          '3:4',
          '3:2',
          '2:3',
          '21:9',
          '9:21',
        ],
      },
    },
    required: ['prompt'],
  },
}
export interface VideoClient {
  submit(
    request: VideoGenerationRequest,
    signal: AbortSignal,
  ): Promise<VideoJob>
  poll(id: string, signal: AbortSignal): Promise<VideoJob>
  download(id: string, signal: AbortSignal): Promise<VideoContent>
}
export interface VideoToolDeps {
  client: VideoClient
  save: (
    relative: string,
    content: VideoContent,
    signal: AbortSignal,
  ) => Promise<void>
  now?: () => number
  id?: () => string
  pause?: (ms: number, signal: AbortSignal) => Promise<void>
  timeoutMs?: number
  signal?: AbortSignal
  progress?: (status: VideoJob['status']) => void
}
export type VideoToolResult =
  | { ok: true; path: string; seconds: number }
  | { ok: false; error: string }

/** Orchestrator independent of filesystem, credentials and RPC registration. */
export async function generateVideo(
  args: unknown,
  deps: VideoToolDeps,
): Promise<VideoToolResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return { ok: false, error: '视频参数必须是对象' }
  const raw = args as Record<string, unknown>
  const aspects = VIDEO_TOOL.parameters.properties.aspect.enum
  if (
    Object.keys(raw).some(k => !['prompt', 'seconds', 'aspect'].includes(k)) ||
    typeof raw.prompt !== 'string' ||
    !raw.prompt.trim() ||
    (raw.seconds !== undefined &&
      (!Number.isInteger(raw.seconds) ||
        Number(raw.seconds) < 1 ||
        Number(raw.seconds) > 120)) ||
    (raw.aspect !== undefined && !aspects.includes(String(raw.aspect)))
  )
    return { ok: false, error: '视频参数不合法' }
  const seconds =
    raw.seconds === undefined ? DEFAULT_VIDEO_SECONDS : Number(raw.seconds)
  let phase = '提交'
  const prompt = raw.prompt
  const now = deps.now ?? Date.now
  const timeout = deps.timeoutMs ?? 10 * 60_000
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(deps.signal ? [deps.signal] : []),
  ])
  const deadline = now() + timeout
  const check = () => {
    if (now() >= deadline || signal.aborted) throw new Error('timeout')
  }
  // Bound even an injected/non-cooperative client that never observes abort.
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    check()
    const aborted = Promise.withResolvers<never>()
    const cancel = () => aborted.reject(new Error('timeout'))
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await Promise.race([operation(), aborted.promise])
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  try {
    let job = await bounded(() =>
      deps.client.submit(
        {
          prompt,
          duration: seconds,
          ...(raw.aspect === undefined
            ? {}
            : {
                aspectRatio:
                  raw.aspect as VideoGenerationRequest['aspectRatio'],
              }),
        },
        signal,
      ),
    )
    deps.progress?.(job.status)
    while (job.status !== 'completed') {
      check()
      if (['failed', 'cancelled', 'expired'].includes(job.status))
        return { ok: false, error: `视频生成失败 (${job.status})` }
      phase = '轮询'
      await bounded(() =>
        (
          deps.pause ??
          (async (ms, signal) => {
            await Bun.sleep(ms)
            signal.throwIfAborted()
          })
        )(Math.min(5000, Math.max(1, deadline - now())), signal),
      )
      job = await bounded(() => deps.client.poll(job.id, signal))
      deps.progress?.(job.status)
    }
    phase = '下载'
    const content = await bounded(() => deps.client.download(job.id, signal))
    if (
      content.contentType !== 'video/mp4' &&
      content.contentType !== 'application/octet-stream'
    )
      return { ok: false, error: '视频下载不是 MP4' }
    const relative = `outputs/videos/${now()}-${(deps.id ?? randomUUID)()
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)}.mp4`
    phase = '文件写入'
    await bounded(() => deps.save(relative, content, signal))
    return {
      ok: true,
      path: relative,
      seconds,
    }
  } catch {
    return {
      ok: false,
      error:
        signal.aborted || now() >= deadline
          ? '视频生成超时（默认 10 分钟）或已取消'
          : `视频${phase}失败`,
    }
  }
}
/** Only the host can read video-role credentials. Error output never echoes them. */
export async function runVideoTool(
  workspace: string,
  args: unknown,
  signal?: AbortSignal,
  progress?: VideoToolDeps['progress'],
): Promise<VideoToolResult> {
  const provider = configuredProvider('video')
  if (!provider || provider.api !== 'openrouter-video' || !provider.secret)
    return { ok: false as const, error: '未配置可用的视频路由或凭据' }
  const model = buildModel({
    id: provider.modelId,
    name: provider.modelId,
    provider: provider.provider,
    api: 'openrouter-video',
    baseUrl: provider.baseUrl,
    kindConfig: 'video',
    input: ['text'],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  return generateVideo(args, {
    signal,
    progress,
    client: {
      submit: (request, signal) =>
        submitVideo(model, request, { apiKey: provider.secret!, signal }),
      poll: (id, signal) =>
        pollVideo(model, id, { apiKey: provider.secret!, signal }),
      download: (id, signal) =>
        downloadVideo(model, id, { apiKey: provider.secret!, signal }),
    },
    async save(relative, content, signal) {
      // Do not follow an outputs/ or videos/ symlink out of the workspace.
      const root = await fs.realpath(workspace)
      let parent = root
      for (const name of ['outputs', 'videos']) {
        parent = path.join(parent, name)
        await fs.mkdir(parent, { recursive: true })
        const stat = await fs.lstat(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('unsafe video output directory')
      }
      const target = path.join(parent, path.basename(relative))
      const file = await fs.open(target, 'wx', 0o600)
      let complete = false
      try {
        await content.body.pipeTo(
          new WritableStream<Uint8Array>({
            async write(chunk) {
              let offset = 0
              while (offset < chunk.byteLength) {
                signal.throwIfAborted()
                const { bytesWritten } = await file.write(
                  chunk.subarray(offset),
                )
                if (bytesWritten === 0)
                  throw new Error('video write made no progress')
                offset += bytesWritten
              }
            },
          }),
          { signal },
        )
        await file.sync()
        complete = true
      } finally {
        await file.close()
        if (!complete) await fs.unlink(target)
      }
    },
  })
}
