// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for a browser started with `--remote-debugging-pipe`: reads
 * NUL-terminated DevTools commands on fd 3 and answers on fd 4, so the host
 * bridge's socket-pair transport can be tested without Chrome.
 */
import * as fs from 'node:fs'

const write = (message: Record<string, unknown>) => {
  const bytes = Buffer.from(`${JSON.stringify(message)}\0`)
  let offset = 0
  while (offset < bytes.length)
    try {
      offset += fs.writeSync(4, bytes, offset)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
    }
}
const answer = (method: unknown): Record<string, unknown> =>
  method === 'Browser.getVersion'
    ? { product: 'PairChrome/1', protocolVersion: '1.3' }
    : method === 'Target.getTargets'
      ? { targetInfos: [{ type: 'page' }] }
      : {}

let pending = ''
for await (const chunk of Bun.file(3).stream()) {
  pending += Buffer.from(chunk).toString('utf8')
  let end: number
  while ((end = pending.indexOf('\0')) !== -1) {
    const message = JSON.parse(pending.slice(0, end)) as {
      id: number
      method: string
    }
    pending = pending.slice(end + 1)
    write({ id: message.id, result: answer(message.method) })
  }
}
