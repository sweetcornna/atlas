// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runGit, type HandoffCode, githubResultRef } from '@qianmo/handoff'

export function githubTokenEnv(
  remoteUrl: string,
  token: string,
): Record<string, string> {
  if (!token || /[\r\n\0]/.test(token)) throw new Error('仓库令牌不合法')
  const url = new URL(remoteUrl)
  if (
    url.username ||
    url.password ||
    !['https:', 'file:'].includes(url.protocol)
  )
    throw new Error('仓库地址不合法')
  return {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: `http.${url.origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'http.followRedirects',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_PARAMETERS: '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TRACE: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_CURL: '0',
    GIT_CURL_VERBOSE: '0',
    GIT_TRACE2: '0',
    GIT_TRACE2_EVENT: '0',
    GIT_TRACE2_PERF: '0',
  }
}

/** Never let git's diagnostics echo an authorization value into persisted errors. */
export async function githubGit(
  args: readonly string[],
  cwd: string,
  credential?: { remoteUrl: string; token: string },
) {
  try {
    return await runGit(
      ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...args],
      {
        cwd,
        ...(credential === undefined
          ? {}
          : { env: githubTokenEnv(credential.remoteUrl, credential.token) }),
      },
    )
  } catch {
    throw new Error(`GitHub 接力 git ${args[0]} 失败`)
  }
}

export async function githubRemoteRefs(
  cwd: string,
  remoteUrl: string,
  refs: readonly string[],
  credential?: { remoteUrl: string; token: string },
): Promise<Map<string, string>> {
  const result = await githubGit(
    ['ls-remote', '--refs', remoteUrl, ...refs],
    cwd,
    credential,
  )
  const out = new Map<string, string>()
  for (const line of result.stdout.toString('utf8').trim().split('\n')) {
    const [commit, ref] = line.split(/\s+/)
    if (ref && commit) out.set(ref, commit)
  }
  return out
}

export async function deleteGithubTaskRefs(
  cwd: string,
  remoteUrl: string,
  code: HandoffCode,
  taskId: string,
  credential?: { remoteUrl: string; token: string },
): Promise<void> {
  const refs = [
    code.wip.ref,
    ...(code.sessions === null ? [] : [code.sessions.ref]),
    githubResultRef(taskId),
  ]
  const remote = await githubRemoteRefs(cwd, remoteUrl, refs, credential)
  const existing = refs.filter(ref => remote.has(ref))
  if (existing.length === 0) return
  if (credential === undefined) {
    await githubGit(['push', '--delete', remoteUrl, ...existing], cwd)
    return
  }
  // Git push needs a repository even for deletions. Use a disposable, empty
  // non-bare context outside hub state; it never fetches or holds code objects.
  // The hub has no bare repository and retains only its ledger and audit.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qianmo-ref-delete-'))
  try {
    await githubGit(['init', '--quiet', '--template=', scratch], cwd)
    await githubGit(
      ['push', '--delete', remoteUrl, ...existing],
      scratch,
      credential,
    )
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

export function tokenLinkAllowed(raw: string): boolean {
  const url = new URL(raw)
  return (
    url.protocol === 'wss:' ||
    (url.protocol === 'ws:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
  )
}
