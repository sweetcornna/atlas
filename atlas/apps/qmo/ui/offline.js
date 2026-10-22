// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The main window when the hub cannot be opened: why, in a line, and what to
 * do. Out of reach, it retries by itself — after 5, 10, 20 and then every 30
 * seconds, and at once when the system says the network is back.
 */

import { invoke, mark, ready, t } from './shell.js'

const $ = id => document.getElementById(id)
const KNOWN = new Set([
  'network',
  'owner_inactive',
  'loop',
  'throttled',
  'broken',
])
const DELAYS = [5, 10, 20, 30]

const state = await invoke('local_state')
ready(state)
const kind = KNOWN.has(state.problem?.kind) ? state.problem.kind : 'other'
$('mark').appendChild(mark(36))
$('title').textContent = t(`offline.${kind}`)
$('note').textContent = t(`offline.${kind}.note`)
$('detail').textContent = [
  state.hub,
  kind === 'network' ? '' : state.problem?.message,
]
  .filter(Boolean)
  .join(' · ')
$('browser').hidden = !state.hub || kind === 'broken'
$('signout').hidden = !['owner_inactive', 'loop', 'other'].includes(kind)

function retry() {
  $('retry').disabled = true
  $('next').textContent = t('offline.retrying')
  invoke('local_retry').catch(() => {
    $('retry').disabled = false
  })
}

$('retry').addEventListener('click', retry)
$('browser').addEventListener('click', () =>
  invoke('local_open', { target: 'hub' }),
)
$('signout').addEventListener('click', async () => {
  $('signout').disabled = true
  await invoke('local_sign_out').catch(() => {})
})

if (kind === 'network') {
  window.addEventListener('online', retry)
  // Each visit to this page within a few minutes is one more failed try, so
  // the wait grows; a visit after a long spell online starts over.
  let last = null
  try {
    last = JSON.parse(sessionStorage.getItem('qmo.offline') ?? 'null')
  } catch {}
  const recent = last !== null && Date.now() - last.at < 3 * 60_000
  const tries = recent ? last.tries : 0
  sessionStorage.setItem(
    'qmo.offline',
    JSON.stringify({ tries: tries + 1, at: Date.now() }),
  )
  let left = DELAYS[Math.min(tries, DELAYS.length - 1)]
  const tick = () => {
    if (left <= 0) return retry()
    $('next').textContent = t('offline.next', { n: left })
    left -= 1
    setTimeout(tick, 1000)
  }
  tick()
}
