// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sign-in page (qmo-app.md §3 step 1): the hub's address and a pairing
 * code. The shell runs `qmo sign-in` with the code on standard input, then
 * opens the hub; this window goes away when the hub's page is up.
 */

import { invoke, mark, ready, t } from './shell.js'

const $ = id => document.getElementById(id)

/** What the shell's error kinds read as here. */
const ERRORS = new Set([
  'usage',
  'bad_code',
  'unsupported',
  'throttled',
  'network',
  'broken',
  'signed_in',
])

function showError(problem) {
  $('error-text').textContent = t(
    ERRORS.has(problem.kind) ? `error.${problem.kind}` : 'error.other',
  )
  // `qmo`'s own words, which name the cause; in Chinese whatever the language.
  $('error-detail').textContent =
    problem.message && problem.kind !== 'usage' ? problem.message : ''
  $('error').hidden = false
}

function busy(label) {
  $('submit').disabled = label !== null
  $('submit').textContent = t(label ?? 'signin.submit')
  $('hub').disabled = label !== null
  $('code').disabled = label !== null
}

async function submit(event) {
  event.preventDefault()
  $('error').hidden = true
  const hub = $('hub').value.trim()
  const code = $('code').value.trim()
  if (hub === '') return $('hub').focus()
  if (code === '') return $('code').focus()
  busy('signin.busy')
  try {
    await invoke('local_sign_in', { hub, code })
    // Paired: the shell is opening the hub, and closes this window.
    busy('signin.entering')
  } catch (problem) {
    busy(null)
    showError(
      typeof problem === 'object' && problem !== null
        ? problem
        : { kind: 'other', message: String(problem) },
    )
    ;(problem?.kind === 'usage' ? $('hub') : $('code')).focus()
  }
}

const state = await invoke('local_state')
ready(state)
$('mark').appendChild(mark(44))
if (state.hub) $('hub').value = state.hub
// Why this page is showing: the device was revoked, or the last sign-out
// could not revoke it on the hub.
const pairing = ['revoked', 'invalid', 'device_kind']
const notice = pairing.includes(state.problem?.kind)
  ? `notice.${state.problem.kind}`
  : state.notice
    ? 'notice.signed_out'
    : null
if (notice !== null) {
  $('notice').textContent = t(notice)
  $('notice').hidden = false
}
$('form').addEventListener('submit', submit)
;(state.hub ? $('code') : $('hub')).focus()
