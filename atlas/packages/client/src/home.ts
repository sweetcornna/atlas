// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client's state directory (clients.md §5.1): which hub this computer is
 * paired with, its device token, and the window's browser profile.
 *
 * | Path | What |
 * | --- | --- |
 * | `client.json` | hub, device id and name, when paired |
 * | `device.token` / `device.token.dpapi` | the device token (Linux, macOS / Windows) |
 * | `window/` | the app window's browser profile, apart from the user's own |
 * | `pipe/` | the window's two DevTools FIFOs (Linux) |
 * | `agents.json` | what `qmo agents` learned by running something (versions, the login shell's PATH) |
 * | `code/` | the local sessions of `qmo code serve` (qmo-local.md §4.3.6) |
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLIENT_DIR_ENV, clientStateDir } from '@qianmo/paths'
import { ClientError, DEVICE_ID, DEVICE_TOKEN, parseHubUrl } from './hub.js'
import {
  deviceTokenStore,
  type Run,
  readPrivateFile,
  runProgram,
  type SecretStore,
  writePrivateFile,
} from './secret.js'

export interface PairedState {
  readonly version: 1
  readonly hub: string
  readonly deviceId: string
  readonly name: string
  readonly pairedAt: string
}

/** The client state directory; a relative `QMO_CLIENT_DIR` is the user's to fix. */
function stateDir(): string {
  try {
    return clientStateDir()
  } catch (error) {
    const configured = process.env[CLIENT_DIR_ENV]
    if (!configured) throw error
    throw new ClientError(
      `${CLIENT_DIR_ENV} 要写绝对路径（现在是 ${configured}）`,
      2,
    )
  }
}

export class ClientHome {
  readonly dir: string
  readonly secret: SecretStore

  constructor(
    dir: string = stateDir(),
    platform: NodeJS.Platform = process.platform,
    run: Run = runProgram,
  ) {
    this.dir = dir
    this.secret = deviceTokenStore(dir, platform, run)
  }

  get statePath(): string {
    return path.join(this.dir, 'client.json')
  }

  get windowProfile(): string {
    return path.join(this.dir, 'window')
  }

  get pipeDir(): string {
    return path.join(this.dir, 'pipe')
  }

  /** `qmo agents`' answers; kept across sign-outs, since they are of this computer. */
  get agentsCache(): string {
    return path.join(this.dir, 'agents.json')
  }

  /** Local sessions; kept across sign-outs, since they are of this computer. */
  get codeDir(): string {
    return path.join(this.dir, 'code')
  }

  /** The pairing on record, or `undefined` before the first sign-in. */
  load(): PairedState | undefined {
    const raw = readPrivateFile(this.statePath)
    if (raw === undefined) return undefined
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = null
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('hub' in value) ||
      typeof value.hub !== 'string' ||
      !('deviceId' in value) ||
      typeof value.deviceId !== 'string' ||
      !DEVICE_ID.test(value.deviceId) ||
      !('name' in value) ||
      typeof value.name !== 'string' ||
      !('pairedAt' in value) ||
      typeof value.pairedAt !== 'string'
    )
      throw new ClientError(
        `${this.statePath} 损坏，请 qmo sign-in --force 重新配对`,
        1,
        'invalid',
      )
    return {
      version: 1,
      hub: parseHubUrl(value.hub),
      deviceId: value.deviceId,
      name: value.name,
      pairedAt: value.pairedAt,
    }
  }

  /** Record a pairing: the token first, so a record never points at no token. */
  async save(state: PairedState, token: string): Promise<void> {
    await this.secret.write(token)
    writePrivateFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** The device token; a pairing without one is a broken pairing. */
  async token(): Promise<string> {
    const token = await this.secret.read()
    if (token === undefined || !DEVICE_TOKEN.test(token))
      throw new ClientError(
        '这台电脑的设备令牌不见了或不完整，请 qmo sign-in --force 重新配对',
        1,
        'invalid',
      )
    return token
  }

  /**
   * Forget the pairing. The window profile goes too, since it holds the
   * session; an open window keeps its files locked on Windows, and then the
   * profile stays until the next sign-out (the session in it is closed on the
   * hub either way when the device is revoked).
   */
  clear(): void {
    fs.rmSync(this.statePath, { force: true })
    this.secret.remove()
    for (const dir of [this.windowProfile, this.pipeDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}
