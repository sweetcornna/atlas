// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Images in tool results on the chat lane (P18.12, hermes #20; design
 * `providers-console-m1.md` §5.6 row 20).
 *
 * `convertToolResult` kept only the text of a tool result: a screenshot, an
 * image the Read tool opened, an MCP tool's picture never reached the model
 * on an OpenAI-compatible endpoint. With `toolResultImages` on, a tool result
 * that carries images becomes a content-parts list (text + `image_url`, in
 * the original order); one without images stays a string, byte for byte.
 *
 * Endpoints that hold to "tool content is a string" reject the list; the
 * chat lane's send boundary then drops the images, remembers the endpoint
 * and model, and re-sends (`src/services/qianmo/modelCompat/
 * toolResultImages.ts`).
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `agent/error_classifier.py:285-295` — "Some (Anthropic native, Codex
 * Responses, Gemini native, first-party OpenAI) extend this to accept a
 * content-parts list (text + image_url) so screenshots … survive"; the list
 * is sent by default. Only the rule is taken; the code is ours.
 */

export type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * The parts of a tool result's content, or `undefined` when it has no image
 * (the caller keeps its string form). `convertImage` is the converter the
 * user-message path already uses.
 */
export function toolResultContentParts(
  content: unknown,
  convertImage: (
    block: Record<string, unknown>,
  ) => { type: 'image_url'; image_url: { url: string } } | null,
): ToolContentPart[] | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: ToolContentPart[] = []
  let images = 0
  for (const item of content as unknown[]) {
    if (typeof item === 'string') {
      if (item) parts.push({ type: 'text', text: item })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const image = convertImage(block)
      if (image) {
        parts.push(image)
        images++
      }
    }
  }
  return images > 0 ? parts : undefined
}
