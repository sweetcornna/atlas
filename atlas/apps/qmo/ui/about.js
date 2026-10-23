// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The About window: the mark, the name, the version and the licence. */

import { closeOnEscape, invoke, mark, ready } from './shell.js'

const state = await invoke('local_state')
ready(state)
document.getElementById('mark').appendChild(mark(64))
document.getElementById('version').textContent = state.version
closeOnEscape()
