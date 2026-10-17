// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DesktopScreenView } from '@qianmo/console'

/**
 * Base64 characters one `desktop.view` picture may take: a control reply is
 * bounded by the protocol envelope (256 KiB), and the picture must leave
 * room for the rest of it.
 */
export const SCREEN_VIEW_BASE64 = 180 * 1024

/**
 * Scale one screenshot to at most `width` pixels wide and encode it as JPEG.
 * `null` when this encoder cannot run on this node at all.
 */
export type ScreenEncoder = (
  picture: { readonly file: string; readonly bytes: Uint8Array },
  width: number,
  quality: number,
) => Promise<Uint8Array | null>

/** Bun's native image pipeline: what the base's own image resizing uses. */
const bunImage: ScreenEncoder = async ({ bytes }, width, quality) =>
  typeof Bun.Image !== 'function'
    ? null
    : await new Bun.Image(bytes)
        .resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .bytes()

/** ImageMagick on PATH, when the runtime cannot decode the picture. */
const imageMagick: ScreenEncoder = async ({ file }, width, quality) => {
  const program = Bun.which('magick') ?? Bun.which('convert')
  if (!program) return null
  const proc = Bun.spawn(
    [
      program,
      `${file}[0]`,
      '-resize',
      `${width}x>`,
      '-strip',
      '-quality',
      String(quality),
      'jpeg:-',
    ],
    { stdout: 'pipe', stderr: 'ignore', timeout: 10_000 },
  )
  const [out, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    proc.exited,
  ])
  return code === 0 && out.length > 0 ? out : null
}

const SCREEN_ENCODERS: readonly ScreenEncoder[] = [bunImage, imageMagick]

const LADDER = [
  [1440, 70],
  [1280, 60],
  [1024, 55],
  [800, 50],
  [640, 45],
  [480, 40],
] as const

/**
 * The picture made small enough for `fits`, as JPEG: the first encoder that
 * runs here walks down a size and quality ladder. `null` when even the
 * smallest step does not fit; `undefined` when no encoder can run.
 */
export async function shrinkScreenshot(
  picture: {
    readonly file: string
    readonly bytes: Uint8Array
    readonly at: number
  },
  fits: (view: DesktopScreenView) => boolean,
  encoders: readonly ScreenEncoder[] = SCREEN_ENCODERS,
): Promise<DesktopScreenView | null | undefined> {
  let usable = false
  for (const encode of encoders) {
    for (const [width, quality] of LADDER) {
      const out = await encode(picture, width, quality).catch(() => null)
      if (!out || out[0] !== 0xff || out[1] !== 0xd8) break
      usable = true
      const view: DesktopScreenView = {
        at: picture.at,
        mimeType: 'image/jpeg',
        data: Buffer.from(out).toString('base64'),
      }
      if (fits(view)) return view
    }
    if (usable) return null
  }
  return undefined
}
