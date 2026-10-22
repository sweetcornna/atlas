// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The local settings page (qmo-app.md §6): the hub and device (read only),
 * the quick entry shortcut, opening at login, staying in the tray, signing
 * out, and the version. Every change goes to the shell at once; there is no
 * save button.
 */

import { closeOnEscape, invoke, ready, t } from './shell.js'

const $ = id => document.getElementById(id)

const MAC_SYMBOLS = { Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' }
const OTHER_NAMES = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Win',
}

/** `Control+Alt+KeyK` as the platform writes it: ⌃⌥K on a Mac, Ctrl+Alt+K elsewhere. */
function shown(accelerator, platform) {
  const parts = accelerator.split('+')
  const key = parts
    .pop()
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
  if (platform === 'macos')
    return parts.map(m => MAC_SYMBOLS[m] ?? m).join('') + key
  return [...parts.map(m => OTHER_NAMES[m] ?? m), key].join('+')
}

/** The accelerator for a key press; `null` while only modifiers are down. */
function accelerator(event) {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(event.code)) return null
  const mods = []
  if (event.ctrlKey) mods.push('Control')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  if (event.metaKey) mods.push('Super')
  return [...mods, event.code].join('+')
}

const view = await invoke('local_settings')
ready(view)
const platform = view.platform

$('hub').textContent = view.hub ?? t('none')
$('device').textContent = view.deviceName ?? t('none')
$('signout').disabled = !view.signedIn
$('version').textContent = view.version
$('autostart').checked = view.autostart
$('background').checked = view.keepInBackground
// On a Mac a closed window always leaves the app running, as Mac apps do.
$('background-row').hidden = platform === 'macos'

let shortcut = view.quickShortcut
let recording = false
const keys = $('shortcut')
const paint = () => {
  keys.textContent = recording
    ? t('settings.shortcut.record')
    : shown(shortcut, platform)
  keys.classList.toggle('recording', recording)
  $('shortcut-reset').hidden = shortcut === view.defaultShortcut
}
paint()

async function choose(next) {
  $('shortcut-error').textContent = ''
  try {
    shortcut = await invoke('local_set_shortcut', { shortcut: next })
  } catch (error) {
    $('shortcut-error').textContent =
      error === 'invalid'
        ? t('settings.shortcut.invalid')
        : t('settings.shortcut.taken')
  }
  recording = false
  paint()
}

keys.addEventListener('click', () => {
  recording = !recording
  $('shortcut-error').textContent = ''
  paint()
})
keys.addEventListener('blur', () => {
  recording = false
  paint()
})
keys.addEventListener('keydown', event => {
  if (!recording) return
  event.preventDefault()
  event.stopPropagation()
  if (
    event.key === 'Escape' &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    recording = false
    return paint()
  }
  const next = accelerator(event)
  if (next !== null) choose(next)
})
$('shortcut-reset').addEventListener('click', () =>
  choose(view.defaultShortcut),
)

$('autostart').addEventListener('change', async event => {
  const want = event.target.checked
  try {
    event.target.checked = await invoke('local_set_autostart', {
      enabled: want,
    })
  } catch {
    event.target.checked = !want
  }
})
$('background').addEventListener('change', async event => {
  event.target.checked = await invoke('local_set_keep_in_background', {
    enabled: event.target.checked,
  })
})

// Signing out revokes the device: a second click within four seconds.
let armed = null
$('signout').addEventListener('click', async () => {
  const button = $('signout')
  if (armed === null) {
    button.textContent = t('settings.signout.confirm')
    armed = setTimeout(() => {
      armed = null
      button.textContent = t('settings.signout')
    }, 4000)
    return
  }
  clearTimeout(armed)
  button.disabled = true
  await invoke('local_sign_out').catch(() => {})
})
$('about').addEventListener('click', () =>
  invoke('local_open', { target: 'about' }),
)
closeOnEscape()
