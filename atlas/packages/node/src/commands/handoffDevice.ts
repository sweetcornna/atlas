// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { acquireExclusiveLock } from '@qianmo/handoff'
import { handoffCodeStore } from './handoffConfig.js'
import { writePrivateFileAtomic } from '../providers/store.js'
import {
  handoffPath,
  HandoffUserError,
  loadProject,
  parseConsoleUrl,
  readJsonFile,
  readTokenFile,
  saveProject,
  assertProjectName,
  type HandoffProject,
} from './handoffStore.js'

export interface LocalHandoffDevice {
  readonly version: 1
  readonly console: string
  readonly deviceId: string
  readonly name: string
}
export const deviceTokenPath = (): string => handoffPath('device.token')

export function loadDevice(): LocalHandoffDevice | undefined {
  const value = readJsonFile(handoffPath('device.json'))
  if (value === undefined) return undefined
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('console' in value) ||
    typeof value.console !== 'string' ||
    !('deviceId' in value) ||
    typeof value.deviceId !== 'string' ||
    !/^d-[a-z2-7]{12}$/.test(value.deviceId) ||
    !('name' in value) ||
    typeof value.name !== 'string'
  )
    throw new HandoffUserError('设备登记损坏，请重新 login --force')
  return {
    version: 1,
    console: parseConsoleUrl(value.console),
    deviceId: value.deviceId,
    name: value.name,
  }
}

export async function loginDevice(
  consoleUrl: string,
  code: string,
  name = os.hostname(),
  force = false,
): Promise<LocalHandoffDevice> {
  const url = parseConsoleUrl(consoleUrl)
  const lock = acquireExclusiveLock(handoffPath('device.lock'))
  try {
    if (
      !force &&
      (fs.existsSync(handoffPath('device.json')) ||
        fs.existsSync(deviceTokenPath()))
    )
      throw new HandoffUserError('本机已有设备，覆盖需要 --force')
    const response = await fetch(`${url}/v0/handoff/pair`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        name,
        platform: `${process.platform}-${process.arch}`,
      }),
    })
    if (!response.ok)
      throw new HandoffUserError(`配对失败（HTTP ${response.status}）`)
    const value: unknown = await response.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      !('deviceId' in value) ||
      typeof value.deviceId !== 'string' ||
      !/^d-[a-z2-7]{12}$/.test(value.deviceId) ||
      !('token' in value) ||
      typeof value.token !== 'string' ||
      !/^qmd_[A-Za-z0-9_-]{43}$/.test(value.token) ||
      !('name' in value) ||
      typeof value.name !== 'string'
    )
      throw new HandoffUserError('中枢返回的设备信息不合法')
    // Keep the exact URL the user paired with, rather than trust the issuer's
    // Origin to redirect future bearer requests to a different host.
    const device: LocalHandoffDevice = {
      version: 1,
      console: url,
      deviceId: value.deviceId,
      name: value.name,
    }
    writePrivateFileAtomic(deviceTokenPath(), `${value.token}\n`)
    writePrivateFileAtomic(
      handoffPath('device.json'),
      `${JSON.stringify(device)}\n`,
    )
    return device
  } finally {
    lock.release()
  }
}

export function logoutDevice(): void {
  const lock = acquireExclusiveLock(handoffPath('device.lock'))
  try {
    fs.rmSync(handoffPath('device.json'), { force: true })
    fs.rmSync(deviceTokenPath(), { force: true })
  } finally {
    lock.release()
  }
}

/** Lazily register a paired repository; explicit init entries always win. */
export async function pairedProject(
  root: string,
): Promise<HandoffProject | undefined> {
  const existing = loadProject(root)
  if (existing && existing.hub.kind !== 'https') return existing
  const device = loadDevice()
  if (!device) return existing
  if (
    existing?.device === device.deviceId &&
    existing.console === device.console
  )
    return existing
  let name =
    (existing?.project ??
      path
        .basename(root)
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 64)
        .replace(/-+$/, '')) ||
    'project'
  try {
    assertProjectName(name)
  } catch {
    name = 'project'
  }
  const project: HandoffProject = {
    root,
    project: name,
    device: device.deviceId,
    console: device.console,
    hub: { kind: 'https', root: `${device.console}/v0/handoff/git` },
    tokenFile: deviceTokenPath(),
  }
  if ((await handoffCodeStore(project)) === 'github') {
    await saveProject(project)
    return project
  }
  const response = await fetch(`${device.console}/v0/handoff/projects`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${readTokenFile(deviceTokenPath())}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ project: name }),
  })
  if (!response.ok)
    throw new HandoffUserError(`隐式登记项目失败（HTTP ${response.status}）`)
  await saveProject(project)
  return project
}
