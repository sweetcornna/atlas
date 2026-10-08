// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which inbound `task.request` a resident hands to its ACP child as a local
 * command rather than as a message (P18.20, design `providers-console-m1.md`
 * D-9).
 *
 * Every other turn is assembled into `<teammate-message>` blocks with the
 * provenance notice and the memory sidecar (`residentPrompt.ts`). That is right
 * for anything a peer says, and it is why `/autocompact 150k` typed on the
 * console chat page used to reach the model as text inside a JSON wrapper: the
 * child only runs a slash command when the prompt *starts* with one. This
 * module names the one exception, and everything it does not name is wrapped
 * exactly as before.
 *
 * ## The exception, all four conditions
 *
 * 1. the routing layer verified a capability token on this very message and
 *    put it on the `verified-capability` tier — a signature from an issuer
 *    this node was told to trust, at `write-limited` or above, bound to this
 *    task (`NodeCapabilities.check`; nothing here re-verifies anything);
 * 2. the issuer is one this node was told is its **console**
 *    (`qm resident --local-commands-from <issuer>`). `--trust` alone is not
 *    enough: it lists peers too, and a peer is exactly who must not reach a
 *    local command. With no `--local-commands-from` this function never
 *    answers, whatever arrives;
 * 3. the payload marks itself a local command, `command: { name }`, with a
 *    name from {@link ACP_LOCAL_COMMANDS};
 * 4. the payload's `prompt` is that command: `/<name>` then whitespace or the
 *    end. A marked payload whose text says something else is a message.
 *
 * What a console signs with: the key in its own config root
 * (`<config>/qianmo/identity/<node>.json`), under the name in the node segment
 * of its `--chat-from` address — `console` by default — and only when it runs
 * with `--chat-sign` (`src/cli/handlers/consoleWakeIdentity.ts`). That name is
 * what this node's `--trust <name>=<publicKey>` and `--local-commands-from
 * <name>` must say.
 *
 * ## Why the answer is taken from the transport, not from the mailbox
 *
 * The decision is made where the verdict exists — on the envelope as it came
 * off the authenticated channel — and the prompt it returns is that envelope's
 * text. The mailbox copy the turn is later assembled from is a file other local
 * writers can also append to; it is used to find the task, never as the source
 * of what runs.
 */

import {
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  type NoticeTrust,
  type QianmoMessage,
} from '@qianmo/protocol'
import { ACP_LOCAL_COMMANDS } from '../acp/agent/localCommands.js'

/**
 * The text to hand the ACP child verbatim, or `undefined` for "assemble it as
 * a message, as always".
 *
 * `verdict` is `NodeRouter.inbound`'s finding for this message; `issuers` is
 * the `--local-commands-from` set.
 */
export function residentLocalCommand(
  message: QianmoMessage,
  verdict: { readonly trust: NoticeTrust; readonly issuer?: string },
  issuers: ReadonlySet<string>,
): string | undefined {
  if (message.type !== MessageType.TaskRequest) return undefined
  if (verdict.trust !== NOTICE_TRUST_VERIFIED_CAPABILITY) return undefined
  if (verdict.issuer === undefined || !issuers.has(verdict.issuer)) {
    return undefined
  }
  const payload = message.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const { prompt, command } = payload as Record<string, unknown>
  if (typeof prompt !== 'string') return undefined
  if (typeof command !== 'object' || command === null) return undefined
  const name = (command as Record<string, unknown>).name
  if (typeof name !== 'string' || !ACP_LOCAL_COMMANDS.includes(name)) {
    return undefined
  }
  const head = `/${name}`
  if (!prompt.startsWith(head)) return undefined
  const next = prompt.charAt(head.length)
  return next === '' || /\s/.test(next) ? prompt : undefined
}
