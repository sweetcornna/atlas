// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StaticPublicKeyDirectory } from '@qianmo/capability'
import type { HandshakeIdentity } from '@qianmo/transport'
import { loadOrCreateNodeKeys } from '../host/nodeIdentity.js'
import type { ConsoleWakeIdentity } from './consoleWakeIdentity.js'

/** Only a named, locally trusted peer enables mutual handshake signing. */
export function consoleHandshakeSigning(
  identity: ConsoleWakeIdentity | undefined,
  node: string | undefined,
  trusted: readonly (readonly [string, string])[] | undefined,
  loadKeys: typeof loadOrCreateNodeKeys = loadOrCreateNodeKeys,
): HandshakeIdentity | undefined {
  const publicKey = node === undefined ? undefined : new Map(trusted).get(node)
  if (identity === undefined || node === undefined || publicKey === undefined)
    return undefined
  // Key failures must escape startup, never masquerade as missing PSK.
  return {
    keys: loadKeys(identity.node),
    directory: new StaticPublicKeyDirectory([[node, publicKey]]),
    required: true,
  }
}

export function consoleHandshakeWarning(node: string): string {
  return (
    `console: ${node} has no trusted public key; wake/chat handshake uses PSK. ` +
    `Configure --trust ${node}=<publicKey> and --wake-sign/--chat-sign for mutual signing; ` +
    `PSK cannot reach a --require-signed-handshake node.`
  )
}

/** A 4003 hides the peer's reason; describe our PSK mode without guessing it. */
export function consoleHandshakeFailureMessage(
  message: string,
  signing: HandshakeIdentity | undefined,
): string {
  if (
    signing !== undefined ||
    message !== 'transport handshake rejected (4003)'
  )
    return message
  return (
    `${message} · 当前使用 PSK 握手，请核对 PSK；强制签名节点需配置命名目标、` +
    '--trust <node>=<publicKey> 和 --wake-sign/--chat-sign，并在节点上信任控制台公钥。'
  )
}
