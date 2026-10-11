// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { VideoContent } from '@oh-my-pi/pi-ai/video'
import { qianmoConfigPath } from '@qianmo/paths'
import { acquirePrivateLock, ensurePrivateDir } from '../providers/store.js'

export type VideoLimits = {
  maxFileBytes: number
  maxCallBytes: number
  maxStagingBytes: number
}
// Short generated clips normally fit well below 512 MiB. Four clips' worth
// bounds host disk use while leaving headroom for abandoned partial downloads.
export const DEFAULT_VIDEO_LIMITS: Readonly<VideoLimits> = {
  maxFileBytes: 512 * 1024 * 1024,
  maxCallBytes: 512 * 1024 * 1024,
  maxStagingBytes: 2 * 1024 * 1024 * 1024,
}
export class VideoSaveError extends Error {}
export function videoLimits(raw: unknown): VideoLimits {
  const values =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const limits = { ...DEFAULT_VIDEO_LIMITS }
  for (const key of Object.keys(limits) as (keyof VideoLimits)[]) {
    if (values[key] === undefined) continue
    if (!Number.isSafeInteger(values[key]) || Number(values[key]) <= 0)
      throw new VideoSaveError('视频保存上限配置不合法')
    limits[key] = Number(values[key])
  }
  return limits
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  )
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
async function writeAll(
  file: fs.FileHandle,
  chunk: Uint8Array,
  signal: AbortSignal,
) {
  let offset = 0
  while (offset < chunk.byteLength) {
    signal.throwIfAborted()
    const { bytesWritten } = await file.write(chunk.subarray(offset))
    if (!bytesWritten) throw new Error('video write made no progress')
    offset += bytesWritten
  }
}

/** A budget belongs to one invocation, even if it later saves multiple clips. */
export function videoSaver(workspace: string, limits: VideoLimits) {
  let callBytes = 0
  return async (
    relative: string,
    content: VideoContent,
    signal: AbortSignal,
  ) => {
    const root = await fs.realpath(workspace)
    const staging = qianmoConfigPath('resident', 'video-staging')
    ensurePrivateDir(staging)
    const stageRoot = await fs.realpath(staging)
    if (within(root, stageRoot))
      throw new VideoSaveError('视频暂存目录不能位于智能体工作区内')
    // Shared by all host processes; counts orphaned partials as well. Serialize
    // downloads so a concurrent invocation cannot overspend the node quota.
    const lock = acquirePrivateLock(`${stageRoot}.lock`, {
      maxAgeMs: 15 * 60_000,
    })
    if (!lock) throw new VideoSaveError('视频暂存目录正被另一下载使用')
    const temporary = path.join(
      stageRoot,
      `${process.pid}-${randomUUID()}.part`,
    )
    let file: fs.FileHandle | undefined
    try {
      let stagedBytes = 0
      for (const name of await fs.readdir(stageRoot)) {
        const stat = await fs.lstat(path.join(stageRoot, name))
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new VideoSaveError('视频暂存目录含不安全条目')
        stagedBytes += stat.size
      }
      file = await fs.open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      )
      let fileBytes = 0
      const header = new Uint8Array(12)
      await content.body.pipeTo(
        new WritableStream<Uint8Array>({
          async write(chunk) {
            const nextFile = fileBytes + chunk.byteLength
            const nextCall = callBytes + chunk.byteLength
            const nextStage = stagedBytes + nextFile
            for (const [actual, maximum, label] of [
              [nextFile, limits.maxFileBytes, '单文件'],
              [nextCall, limits.maxCallBytes, '单次调用'],
              [nextStage, limits.maxStagingBytes, '节点暂存总量'],
            ] as const) {
              if (actual > maximum)
                throw new VideoSaveError(
                  `视频下载超过${label}上限（${maximum} 字节）`,
                )
            }
            if (fileBytes < header.length)
              header.set(
                chunk.subarray(0, header.length - fileBytes),
                fileBytes,
              )
            fileBytes = nextFile
            callBytes = nextCall
            await writeAll(file!, chunk, signal)
          },
        }),
        { signal },
      )
      if (
        fileBytes < 12 ||
        new TextDecoder().decode(header.subarray(4, 8)) !== 'ftyp' ||
        new DataView(header.buffer).getUint32(0) < 12
      )
        throw new VideoSaveError('视频下载缺少有效 MP4 文件头')
      await file.sync()
      await file.close()
      file = undefined
      signal.throwIfAborted()
      await commitVideo(root, relative, temporary, signal)
    } finally {
      try {
        await file?.close()
      } finally {
        try {
          await fs.unlink(temporary).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
        } finally {
          lock.release()
        }
      }
    }
  }
}

async function commitVideo(
  root: string,
  relative: string,
  temporary: string,
  signal: AbortSignal,
) {
  const dirs: { file: fs.FileHandle; location: string }[] = []
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const linux = process.platform === 'linux'
  let target: string | undefined
  let cleanup: string | undefined
  let output: fs.FileHandle | undefined
  let complete = false
  try {
    dirs.push({ file: await fs.open(root, flags), location: root })
    for (const name of ['outputs', 'videos']) {
      const parent = dirs[dirs.length - 1]!
      // Linux opens each child relative to the pinned parent. macOS lacks
      // openat in this API: O_NOFOLLOW only guards the final component, so
      // revalidate every parent before opening the next component/file.
      const location = path.join(parent.location, name)
      const access = linux
        ? `/proc/self/fd/${parent.file.fd}/${name}`
        : location
      try {
        await fs.mkdir(access, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const file = await fs.open(access, flags)
      dirs.push({ file, location })
      await verifyDirectories(root, dirs)
    }
    const parent = dirs[dirs.length - 1]!
    const name = path.basename(relative)
    if (!/^[a-zA-Z0-9-]+\.mp4$/.test(name))
      throw new VideoSaveError('视频输出文件名不合法')
    target = linux
      ? `/proc/self/fd/${parent.file.fd}/${name}`
      : path.join(parent.location, name)
    await verifyDirectories(root, dirs)
    output = await fs.open(
      target,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    )
    cleanup = target
    if (!linux) cleanup = await fs.realpath(target)
    // Before copying any video bytes, verify the opened inode and all parents.
    await verifyOutput(root, dirs, output, target)
    const input = await fs.open(temporary, 'r')
    try {
      const buffer = new Uint8Array(1024 * 1024)
      for (;;) {
        signal.throwIfAborted()
        const { bytesRead } = await input.read(buffer)
        if (!bytesRead) break
        await writeAll(output, buffer.subarray(0, bytesRead), signal)
      }
    } finally {
      await input.close()
    }
    await output.sync()
    await verifyOutput(root, dirs, output, target)
    complete = true
    // Linux's pinned handles prevent symlink traversal, but an attacker can
    // still rename an opened directory. macOS also has a parent-swap window
    // between checks and open/copy. Post-write checks detect these changes;
    // neither platform promises atomic ancestry against arbitrary renames.
  } catch (error) {
    if (error instanceof VideoSaveError) throw error
    throw new VideoSaveError('视频输出目录不安全或文件提交失败')
  } finally {
    try {
      if (!complete && output && cleanup) {
        // Only unlink the inode we created, never a replacement at this name.
        const stat = await fs.lstat(cleanup).catch(() => undefined)
        if (stat && same(stat, await output.stat())) await fs.unlink(cleanup)
      }
    } finally {
      await output?.close()
      for (const dir of dirs.reverse()) await dir.file.close()
    }
  }
}
async function verifyDirectories(
  root: string,
  dirs: { file: fs.FileHandle; location: string }[],
) {
  for (const dir of dirs) {
    const actual = await fs.realpath(dir.location)
    const stat = await fs.lstat(dir.location)
    if (
      !within(root, actual) ||
      actual !== dir.location ||
      !stat.isDirectory() ||
      !same(stat, await dir.file.stat())
    )
      throw new VideoSaveError('视频输出目录在保存期间发生变化')
  }
}
async function verifyOutput(
  root: string,
  dirs: { file: fs.FileHandle; location: string }[],
  file: fs.FileHandle,
  target: string,
) {
  await verifyDirectories(root, dirs)
  const actual = await fs.realpath(target)
  const stat = await fs.lstat(actual)
  if (!within(root, actual) || !same(stat, await file.stat()))
    throw new VideoSaveError('视频输出文件离开工作区')
}
