// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Coordinates only: this shape never carries repository objects or credentials. */
export interface HandoffCodeRef {
  readonly ref: string
  readonly commit: string
}

export interface HandoffCode {
  readonly repo: string
  readonly wip: HandoffCodeRef
  readonly sessions: HandoffCodeRef | null
  readonly reason?: string
}

export interface HandoffCodeView extends HandoffCode {
  readonly sessionsReason?: string
  readonly result?: HandoffCodeRef
  readonly cleaned?: boolean
}

export function isHandoffRepo(repo: unknown): repo is string {
  return (
    typeof repo === 'string' &&
    repo.length <= 256 &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) &&
    !repo.includes('..') &&
    !repo.endsWith('.git')
  )
}

export function githubHandoffRef(
  kind: 'wip' | 'sessions',
  device: string,
  task: string,
): string {
  return `refs/heads/qianmo/${kind}/${device}/${task}`
}

export function githubResultRef(task: string): string {
  return `refs/heads/qianmo/result/${task}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isHandoffCodeRef(value: unknown): value is HandoffCodeRef {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    typeof value.ref === 'string' &&
    /^refs\/heads\/qianmo\/(?:wip\/[A-Za-z0-9_-]+|sessions\/[A-Za-z0-9_-]+|result)\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(
      value.ref,
    ) &&
    typeof value.commit === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.commit)
  )
}

/** Device binding is checked again against the authenticated actor at acceptance. */
export function validateHandoffCode(
  value: unknown,
  device: string,
): HandoffCode | null {
  if (
    !record(value) ||
    !Object.keys(value).every(key =>
      ['repo', 'wip', 'sessions', 'reason'].includes(key),
    ) ||
    !isHandoffRepo(value.repo) ||
    !isHandoffCodeRef(value.wip)
  )
    return null
  const prefix = `refs/heads/qianmo/wip/${device}/`
  if (!value.wip.ref.startsWith(prefix)) return null
  const task = value.wip.ref.slice(prefix.length)
  if (
    value.sessions !== null &&
    (!isHandoffCodeRef(value.sessions) ||
      value.sessions.ref !== githubHandoffRef('sessions', device, task) ||
      value.sessions.commit.length !== value.wip.commit.length)
  )
    return null
  if (
    value.reason !== undefined &&
    (typeof value.reason !== 'string' ||
      value.reason.length > 1024 ||
      value.reason.includes('\0'))
  )
    return null
  if (
    value.sessions === null &&
    (typeof value.reason !== 'string' || value.reason.trim() === '')
  )
    return null
  return {
    repo: value.repo,
    wip: { ...value.wip },
    sessions: value.sessions === null ? null : { ...value.sessions },
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  }
}
