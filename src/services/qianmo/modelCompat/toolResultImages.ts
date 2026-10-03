// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat lane's side of hermes #20 (P18.12; design `providers-console-m1.md`
 * §5.6 row 20): whether this request may carry images in tool results, and
 * what happens when the endpoint refuses them. The conversion is
 * `packages/@ant/model-provider/src/shared/qianmo/toolResultImages.ts`.
 *
 * Passive: images go out by default; when the endpoint refuses a list-type
 * tool message, every tool message's images are replaced by its text (or a
 * placeholder), the endpoint and model are remembered for the rest of the
 * process, and the request is sent once more. Later requests to the same
 * endpoint and model convert without images from the start.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/error_classifier.py:296-311` `_MULTIMODAL_TOOL_CONTENT_PATTERNS`
 *     — the refusal wording (Xiaomi MiMo's "text is not set", DashScope's
 *     "tool_call.content must be string", …), checked on a 400;
 *   - `run_agent.py:7355-7438` `_try_strip_image_parts_from_tool_messages` —
 *     text parts joined with a blank line, else the placeholder below;
 *     (provider, model) recorded; a list without images is left alone;
 *   - `agent/conversation_loop.py:4640-4662` — one retry per request.
 * hermes keys the memory on its provider id; Qianmo has only the base URL on
 * this lane, so the endpoint stands in for it. Only the rules are taken; the
 * code is ours.
 *
 * Qianmo addition: a 400 whose text names an image (`image_url`, "image
 * input", …) also counts. Before #20 these images were dropped silently, so
 * an endpoint refusing them in words hermes did not record would otherwise
 * turn a turn that used to work into a failure; the cost of a false match is
 * one re-send without the images — the old behaviour.
 */
import { errorRecords, httpStatus, lowerStrings } from './errorRecords.js'

/** hermes `_MULTIMODAL_TOOL_CONTENT_PATTERNS`. */
const MULTIMODAL_TOOL_CONTENT_TEXT = [
  'text is not set',
  'tool message content must be a string',
  'tool content must be a string',
  'tool message must be a string',
  'expected string, got list',
  'expected string, got array',
  'tool_call.content must be string',
]

/** hermes `run_agent.py:7433-7435`. */
export const TOOL_IMAGE_REMOVED_PLACEHOLDER =
  '[image content removed — provider does not accept list-type tool message content]'

type Target = { model: string; baseURL: string | undefined }

const refused = new Set<string>()

function targetKey(target: Target): string {
  return `${(target.baseURL ?? '').trim().toLowerCase()}\u0000${target.model}`
}

/** Whether tool-result images may be sent to `target` (not refused yet). */
export function toolResultImagesAccepted(target: Target): boolean {
  return !refused.has(targetKey(target))
}

/** The endpoint refusing a list-type tool message. */
export function isToolImageRejection(error: unknown): boolean {
  const records = errorRecords(error)
  const status = httpStatus(records)
  if (status !== undefined && status !== 400 && status !== 422) return false
  const text = lowerStrings(records, ['message', 'param', 'code'])
  return text.some(
    value =>
      MULTIMODAL_TOOL_CONTENT_TEXT.some(phrase => value.includes(phrase)) ||
      (status !== undefined && /\bimage/.test(value)),
  )
}

type Part = { type?: unknown; text?: unknown }

/**
 * `body` with each tool message's image parts replaced by its text, or
 * `undefined` when no tool message carries an image.
 */
export function stripToolMessageImages<Body extends { messages?: unknown }>(
  body: Body,
): Body | undefined {
  if (!Array.isArray(body.messages)) return undefined
  let changed = false
  const messages = (body.messages as unknown[]).map(message => {
    const record = message as { role?: unknown; content?: unknown }
    if (record?.role !== 'tool' || !Array.isArray(record.content)) {
      return message
    }
    const parts = record.content as Part[]
    if (!parts.some(part => part?.type === 'image_url')) return message
    changed = true
    const texts = parts
      .filter(
        (part): part is { type: 'text'; text: string } =>
          part?.type === 'text' && typeof part.text === 'string',
      )
      .map(part => part.text.trim())
      .filter(Boolean)
    return {
      ...record,
      content:
        texts.length > 0 ? texts.join('\n\n') : TOOL_IMAGE_REMOVED_PLACEHOLDER,
    }
  })
  return changed ? { ...body, messages } : undefined
}

/**
 * `send(body)`; when the endpoint refuses list-type tool content and the
 * body carries tool images, remember `target` and `send` once more without
 * them.
 */
export async function sendDegradingToolImages<
  Body extends { messages?: unknown },
  Result,
>(
  body: Body,
  send: (body: Body) => Promise<Result>,
  target: Target,
): Promise<Result> {
  try {
    return await send(body)
  } catch (error) {
    if (!isToolImageRejection(error)) throw error
    const stripped = stripToolMessageImages(body)
    if (!stripped) throw error
    refused.add(targetKey(target))
    return send(stripped)
  }
}
