// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether a node keeps attachments in its session transcripts (P18.19 CH-2,
 * design `providers-console-m1.md` §5.11.5).
 *
 * The base writes attachments to the transcript for ant users only
 * (`isLoggableMessage`); everyone else's are dropped at write time. They are
 * not only context for the reader — several render into the model's input:
 * the deferred-tools announcement leads `input[0]`, date changes, nested
 * memory and file snippets sit between turns. A session resumed from a
 * transcript without them sends a different request from the one it sent
 * before the restart, from the first message on, so the whole conversation
 * is re-read at the uncached rate. On the fleet (2026-10-03) most
 * mid-session zero-hit calls were exactly that turn: the first one of a
 * session resumed after its ACP child was replaced.
 *
 * Measured on the recording stub: with attachments kept (and the transcript
 * flushed before exit, #170) the request before and after a child
 * replacement are byte-identical.
 *
 * Nodes only; every other identity's transcripts are unchanged.
 * `QIANMO_PERSIST_PROMPT_ATTACHMENTS=0` turns it off.
 */
import {
  IDENTITY_MODE,
  NODE_IDENTITY_MODE,
} from '../../../constants/identity.js'
import { isEnvDefinedFalsy } from '../../../utils/config/envUtils.js'

export function persistsPromptAttachments(): boolean {
  return (
    IDENTITY_MODE === NODE_IDENTITY_MODE &&
    !isEnvDefinedFalsy(process.env.QIANMO_PERSIST_PROMPT_ATTACHMENTS)
  )
}
