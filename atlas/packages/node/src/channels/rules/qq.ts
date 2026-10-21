// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/qqbot/adapter.py:151`、`:762-769`、`:1374-1396`、`:1507-1515`、`:1639-1641`、`:1655-1657`，`plugins/platforms/qqbot/constants.py:29`、`:34-35`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * The QQ Open Platform bot's message rules (`runtimes-channels.md` §2.6),
 * rewritten in TypeScript after hermes-agent's qqbot adapter:
 *
 * - a group @-message carries the bot's own `@name` in front; it is taken
 *   off before the agent sees the text (`_strip_at_mention`);
 * - replies are QQ Markdown (`msg_type` 2) by default, at most 4000
 *   characters a message (`markdown_support`, `MAX_MESSAGE_LENGTH`);
 * - a refusal is not tried again (`_PERMANENT_SEND_ERRORS`: `invalid`,
 *   `forbidden`, `not found`, `bad request`); the adapter reads it from the
 *   HTTP status (4xx other than 429), the API's own signal for the same.
 *
 * hermes never falls back from Markdown; a bot without the Markdown
 * permission would then send nothing, so here a refused Markdown message
 * is sent once more as plain text, and if that one goes through Markdown
 * is left off for the rest of the connection.
 */

/** One QQ message (hermes `MAX_MESSAGE_LENGTH`). */
export const QQ_MAX_MESSAGE_LENGTH = 4_000
/** hermes `MSG_TYPE_TEXT` and `MSG_TYPE_MARKDOWN`. */
export const QQ_MSG_TEXT = 0
export const QQ_MSG_MARKDOWN = 2

/** hermes `_strip_at_mention`: the leading `@bot` of a group @-message. */
export function stripAtMention(content: string): string {
  return content.trim().replace(/^@\S+\s*/, '')
}

/** hermes `_build_text_body` without the sequence (the adapter adds `msg_id` and `msg_seq`). */
export function qqMessageBody(
  content: string,
  markdown: boolean,
): Record<string, unknown> {
  const words = content.slice(0, QQ_MAX_MESSAGE_LENGTH)
  return markdown
    ? { markdown: { content: words }, msg_type: QQ_MSG_MARKDOWN }
    : { content: words, msg_type: QQ_MSG_TEXT }
}
