// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MAX_CHAT_TEXT_LENGTH } from '../view/chat.js'
import { requiredString, type Parsed } from './shared.js'

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/**
 * The rules every line a person sends follows: `POST /v0/chat/sessions/<id>/
 * messages` and the first line of `POST /v0/work/sessions` alike.
 */
export function parseChatText(body: Record<string, unknown>): Parsed<string> {
  const text = requiredString(body, 'text')
  if (!text.ok) return text
  if (text.value.length > MAX_CHAT_TEXT_LENGTH) {
    return {
      ok: false,
      message: `消息最长 ${MAX_CHAT_TEXT_LENGTH} 个字符，这条有 ${text.value.length} 个`,
    }
  }
  // A private key never goes to a model, whatever page sent it. The front
  // takes one out before sending (添加服务器); this is the line behind it.
  if (PRIVATE_KEY_BLOCK.test(text.value)) {
    return {
      ok: false,
      message: '消息里有私钥 · 没有发出 · 部署新服务器用「添加服务器」',
    }
  }
  return text
}
