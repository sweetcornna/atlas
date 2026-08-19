// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The parsing half of `qm watch` — the half a bad jobs file hits.
 *
 * Everything here fires at *registration*, which is the point: a watch job is
 * written once and runs for a week into a channel that is silent by design, so
 * a defect that only surfaces on the fire path surfaces unattended, every
 * period, with nobody reading. The last moment a human is looking is the
 * moment the file is parsed.
 */

import { describe, expect, test } from 'bun:test'
import {
  WATCH_HELP_TEXT,
  isWatchHelpRequest,
  parseWatchArgs,
  parseWatchJobs,
} from '../watch.js'

const JOB = {
  id: 'disk-watch',
  title: 'disk every ten minutes',
  target: 'qianmo://beta-1/reviewer',
  url: 'ws://127.0.0.1:38611',
  prompt: 'check / and /var; call qianmo_notify only if either is over 90%',
  schedule: { everyMs: 600_000 },
  taskTtlMs: 900_000,
  notifyPolicy: 'agent-initiated',
}

function jobsFile(...jobs: readonly unknown[]): string {
  return JSON.stringify(jobs)
}

describe('qm watch argument parsing', () => {
  test('requires both a jobs file and the hub address', () => {
    expect(() => parseWatchArgs([], 'qianmo')).toThrow('requires --jobs')
    expect(() => parseWatchArgs(['--jobs', 'a.json'], 'qianmo')).toThrow(
      'requires --from',
    )
  })

  test('refuses to run under any identity but the node one', () => {
    // The same gate `resident-wake` has, for the same reason: dialling other
    // people's nodes is part of the Qianmo identity, not of plain occ.
    expect(() =>
      parseWatchArgs(
        ['--jobs', 'a.json', '--from', 'qianmo://hub/console'],
        'occ',
      ),
    ).toThrow('OCC_IDENTITY=qianmo')
  })

  test('rejects an address that is not a qianmo address', () => {
    expect(() =>
      parseWatchArgs(['--jobs', 'a.json', '--from', 'hub'], 'qianmo'),
    ).toThrow()
  })

  test('takes both --name value and --name=value, and defaults the state dir', () => {
    const parsed = parseWatchArgs(
      ['--jobs=a.json', '--from', 'qianmo://hub/console'],
      'qianmo',
    )
    expect(parsed.jobsPath).toBe('a.json')
    expect(parsed.from).toBe('qianmo://hub/console')
    expect(parsed.once).toBe(false)
    // Derived from the config root rather than spelled — CLAUDE.md's path
    // invariant applies to this command like every other.
    expect(parsed.stateDir).toContain('scheduler')
  })

  test('points a mistyped option at the help instead of guessing', () => {
    expect(() =>
      parseWatchArgs(
        ['--jobs', 'a.json', '--from', 'qianmo://hub/console', '--evry', '5'],
        'qianmo',
      ),
    ).toThrow('watch --help')
  })

  test('help is recognized anywhere and names every required flag', () => {
    expect(isWatchHelpRequest(['--jobs', 'a.json', '--help'])).toBe(true)
    expect(isWatchHelpRequest(['--jobs', 'a.json'])).toBe(false)
    for (const flag of ['--jobs', '--from', '--state-dir', '--once']) {
      expect(WATCH_HELP_TEXT).toContain(flag)
    }
    // The brake is only useful if it is documented where somebody looks.
    expect(WATCH_HELP_TEXT).toContain('ESTOP')
  })
})

describe('the jobs file', () => {
  test('accepts a well-formed job and keeps its url beside it', () => {
    const [entry] = parseWatchJobs(jobsFile(JOB))
    expect(entry?.job.id).toBe('disk-watch')
    expect(entry?.job.taskTtlMs).toBe(900_000)
    expect(entry?.url).toBe('ws://127.0.0.1:38611')
    // The scheduler never sees the url: it decides *when*, the handler decides
    // *where*, and that boundary is what keeps the package free of a transport.
    expect(entry?.job).not.toHaveProperty('url')
  })

  test('a job with no url is rejected rather than skipped at fire time', () => {
    const { url: _url, ...noUrl } = JOB
    expect(() => parseWatchJobs(jobsFile(noUrl))).toThrow('needs a "url"')
  })

  test('two jobs with one id are refused, because they would share a dedup key', () => {
    // `dedupKey` is `"<jobId>:<fireAtMs>"`. Two jobs under one id firing at the
    // same instant claim the same key, so one of them silently never runs —
    // and "silently" is the part that makes this worth a hard error.
    expect(() =>
      parseWatchJobs(jobsFile(JOB, { ...JOB, title: 'a different job' })),
    ).toThrow('two jobs with id')
  })

  test('an invalid job stops the whole file, not just itself', () => {
    expect(() =>
      parseWatchJobs(jobsFile(JOB, { ...JOB, id: 'other', taskTtlMs: 0 })),
    ).toThrow('taskTtlMs')
    expect(() =>
      parseWatchJobs(jobsFile({ ...JOB, target: 'not-an-address' })),
    ).toThrow()
  })

  test('a file that is not an array says so', () => {
    expect(() => parseWatchJobs(JSON.stringify(JOB))).toThrow('JSON array')
  })
})
