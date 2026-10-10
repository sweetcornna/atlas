// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeFileSync } from 'node:fs'
import { rejudgeNode } from './authz-rejudge/node.js'

export function main(args: readonly string[]): number {
  let sessions = ''
  let node = ''
  let out: string | undefined
  const auditFiles: string[] = []
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    const value = args[++i]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${key}`)
    if (key === '--sessions' && !sessions) sessions = value
    else if (key === '--node' && !node) node = value
    else if (key === '--audit') auditFiles.push(value)
    else if (key === '--out' && !out) out = value
    else throw new Error(`Unknown or repeated option: ${key}`)
  }
  if (!sessions || !node || !auditFiles.length)
    throw new Error(
      'Usage: bun atlas/scripts/authz-rejudge.ts --sessions <resident/sessions> --node <node-id> --audit <node-audit.ndjson> [--audit <rotated.ndjson>] [--out <new-report.json>]',
    )
  const report = rejudgeNode({ sessions, node, auditFiles })
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (out) writeFileSync(out, text, { flag: 'wx', mode: 0o600 })
  else process.stdout.write(text)
  return report.passed ? 0 : 1
}
if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(String(error))
    process.exitCode = 2
  }
}
