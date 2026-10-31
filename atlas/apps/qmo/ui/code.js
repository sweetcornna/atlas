// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shell's own Code page (P37.16, qmo-local.md §8): this computer's
 * sessions while the hub is out of reach, carried on through the shell's
 * `qmo_local_*` commands and one ordered event channel, straight to the
 * runner — the way the hub's `/code` does it (§4.5), minus what needs the
 * hub's page: starting a session, folders, the changes panel, renaming,
 * deleting and Remote.
 *
 * - **Drawing.** `window.qianmoCode` is the console's `CODE_RENDER_JS`,
 *   copied in at build time (`code-render.js`): the same records, steps,
 *   asks and rich text as `/code`, built with `createElement` and
 *   `textContent` only. Nothing here turns a string into markup.
 * - **Order.** `qmo_local_watch` first, then `qmo_local_list`; a session is
 *   `qmo_local_read` (the newest 200; older ones from the top). Every event
 *   carries `seq`: one already drawn is dropped, a gap or a trimmed record
 *   reads again, a `delta` out of place waits for its record.
 * - **Sending.** A line is drawn at once with its `clientId`; one the runner
 *   refuses stays as 未送达 · 重试. While the agent works the button stops it.
 *   The mode shows its new value first, and goes back with the reason when
 *   refused; 跳过权限确认 asks once more.
 * - **Back to the hub.** 重新连接, the system saying the network is back, and
 *   every 30 s while nothing is being typed: `local_reconnect`. In, the shell
 *   opens the hub's `/code` on this session; still out, the line says why.
 */

import { invoke, mark, ready, t, word } from './shell.js'

const $ = id => document.getElementById(id)
const R = window.qianmoCode
const MODES = ['off', 'accept-edits', 'auto', 'full-access']
const KNOWN = new Set(['network', 'owner_inactive', 'loop', 'throttled'])
const AGAIN_MS = 30_000
const KEY = 'qmo.code.session'

const msgs = $('msgs')
const scroller = $('scroll')
const box = $('text')
const go = $('go')
const stop = $('stop')
const modePick = $('mode')
const say = $('say')

const state = await invoke('local_state')
ready(state)
document.title = t('code.title')
$('mark').appendChild(mark(18))
$('sessions').setAttribute('aria-label', t('code.title'))
box.placeholder = t('code.reply')
go.setAttribute('aria-label', t('code.send'))
stop.setAttribute('aria-label', t('code.stop'))
modePick.setAttribute('aria-label', t('code.mode'))
for (const mode of MODES) {
  const option = document.createElement('option')
  option.value = mode
  option.textContent = t(`settings.code.${mode}`)
  modePick.appendChild(option)
}

let sessions = {}
let current = ''
let view = null
let listed = false
let listing = false
let down = false
let frame = 0
let ticker = null
let modeAsk = 0
let modeWant = ''

const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}
const clear = node => {
  while (node.firstChild) node.removeChild(node.firstChild)
}
const why = err =>
  typeof err === 'string'
    ? err
    : err && err.message
      ? String(err.message)
      : String(err || '')
const tell = (text, tone) => {
  say.textContent = text || ''
  say.dataset.tone = tone || 'muted'
}
const running = () =>
  !!current && !!sessions[current] && sessions[current].state === 'running'
const clientId = () =>
  `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
const stored = () => {
  try {
    return localStorage.getItem(KEY) || ''
  } catch {
    return ''
  }
}
const keep = id => {
  try {
    localStorage.setItem(KEY, id)
  } catch {}
}
const idInUrl = () => new URLSearchParams(location.search).get('session') || ''

if (!R) {
  $('empty').textContent = t('code.missing')
  box.disabled = go.disabled = modePick.disabled = true
  throw new Error('code-render.js is missing')
}
R.words(key => word(`code.${key}`))

// ---- the side list ----

function side() {
  const list = $('sessions')
  const focused = list.contains(document.activeElement)
    ? document.activeElement.getAttribute('data-session')
    : null
  const all = Object.values(sessions).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  )
  clear(list)
  if (!all.length) {
    list.appendChild(el('p', 'code-none', t('code.none')))
    return
  }
  const groups = new Map()
  for (const s of all) {
    const folder = s.folder || {}
    const key = folder.id ? `f:${folder.id}` : `n:${folder.name || ''}`
    if (!groups.has(key)) groups.set(key, { name: folder.name || '', rows: [] })
    groups.get(key).rows.push(s)
  }
  for (const group of groups.values()) {
    const block = el('div', 'code-group')
    block.appendChild(el('h3', 'code-group-name', group.name))
    for (const s of group.rows) {
      const row = el(
        'button',
        `code-row${s.id === current ? ' is-current' : ''}`,
      )
      row.type = 'button'
      row.setAttribute('data-session', s.id)
      if (s.id === current) row.setAttribute('aria-current', 'page')
      const state = s.state || 'idle'
      const dot = el('span', `code-dot is-${state}`)
      dot.setAttribute('role', 'img')
      dot.setAttribute('aria-label', t(`code.${state}`))
      dot.title = t(`code.${state}`)
      row.appendChild(dot)
      row.appendChild(
        el('span', 'code-row-title', s.title || t('code.untitled')),
      )
      row.appendChild(el('span', 'code-row-agent', s.agent?.name || ''))
      block.appendChild(row)
    }
    list.appendChild(block)
  }
  if (focused) {
    for (const row of list.querySelectorAll('[data-session]')) {
      if (row.getAttribute('data-session') === focused) row.focus()
    }
  }
}

$('sessions').addEventListener('click', event => {
  const row = event.target.closest('[data-session]')
  if (!row) return
  const id = row.getAttribute('data-session') || ''
  if (id !== current || !view || view.id !== id) open(id, true)
})

// ---- views ----

function head() {
  const s = current ? sessions[current] : null
  $('title').textContent = s ? s.title || t('code.untitled') : ''
  $('sub').textContent = s
    ? [s.folder?.name, s.agent?.name].filter(Boolean).join(' · ')
    : ''
}

function composer() {
  const busy = running()
  const open = !!current && !!sessions[current]
  // Offline a session is only carried on: no box until one is open.
  $('dock').hidden = !open
  go.hidden = busy
  stop.hidden = !busy
  box.disabled = go.disabled = modePick.disabled = !open
  const mode = open ? sessions[current].mode : ''
  if (mode && !modeWant && modePick.value !== mode && $('bypass').hidden) {
    modePick.value = mode
  }
}

function grow() {
  box.style.height = ''
  if (box.value) box.style.height = `${Math.min(box.scrollHeight, 240)}px`
}

function fresh(id) {
  return {
    id,
    turns: new Map(),
    drawn: 0,
    oldest: 0,
    more: false,
    live: null,
    reading: 0,
    queue: [],
    cache: new Map(),
    groups: new Map(),
    lines: [],
    activity: '',
    pend: null,
    since: 0,
    older: false,
  }
}

function blank(push) {
  current = ''
  view = null
  if (push) history.pushState(null, '', 'code.html')
  clear(msgs)
  const any = Object.keys(sessions).length > 0
  $('empty').textContent = !listed
    ? ''
    : any
      ? `${t('code.pick')} · ${t('code.noNew')}`
      : t('code.noNew')
  $('empty').hidden = false
  bypass(false)
  head()
  side()
  composer()
  tick()
}

function open(id, push) {
  if (!sessions[id]) return blank(push)
  current = id
  keep(id)
  if (push)
    history.pushState(null, '', `code.html?session=${encodeURIComponent(id)}`)
  view = fresh(id)
  clear(msgs)
  $('empty').hidden = true
  bypass(false)
  head()
  side()
  composer()
  tell('')
  load()
}

window.addEventListener('popstate', () => {
  if (!listed) return
  const id = idInUrl()
  if (id === current) return
  if (id && sessions[id]) open(id, false)
  else blank(false)
})

// ---- records ----

function put(record) {
  const turn = record?.turn
  if (!turn || typeof turn.id !== 'string' || typeof record.seq !== 'number') {
    return
  }
  const have = view.turns.get(turn.id)
  if (!have) view.turns.set(turn.id, { t: turn, s: record.seq, f: record.seq })
  else {
    if (record.seq > have.s) {
      have.t = turn
      have.s = record.seq
    }
    if (record.seq < have.f) have.f = record.seq
  }
  if (!view.oldest || record.seq < view.oldest) view.oldest = record.seq
  if (view.live && view.live.turn === turn.id) view.live = null
  if (turn.clientId) {
    view.lines = view.lines.filter(line => line.clientId !== turn.clientId)
  }
}

function merge(v, data, fill) {
  const records = Array.isArray(data?.records) ? data.records : []
  if (data?.session?.id) sessions[data.session.id] = data.session
  let lowest = 0
  for (const r of records) if (!lowest || r.seq < lowest) lowest = r.seq
  // A gap wider than one page: start over from this page.
  if (fill && v.drawn && lowest > v.drawn + 1) {
    v.turns = new Map()
    v.oldest = 0
    v.more = true
  }
  for (const r of records) put(r)
  if (typeof data?.lastSeq === 'number' && data.lastSeq > v.drawn) {
    v.drawn = data.lastSeq
  }
  if (!fill || !v.oldest || lowest <= v.oldest) v.more = !!data?.more
  const live = data?.live
  const liveId = live
    ? typeof live.turn === 'string'
      ? live.turn
      : live.turn?.id
    : ''
  if (liveId && !v.turns.has(liveId)) {
    v.live = { turn: liveId, text: String(live.text || ''), at: Date.now() }
  }
}

function load() {
  const v = view
  const fill = v.drawn > 0
  v.reading += 1
  invoke('qmo_local_read', { session: v.id, limit: 200 })
    .then(
      data => {
        if (view === v) merge(v, data, fill)
      },
      err => {
        if (view === v) tell(why(err), 'warn')
      },
    )
    .then(() => {
      if (view !== v) return
      v.reading -= 1
      if (v.reading) return
      const queued = v.queue
      v.queue = []
      for (const event of queued) apply(event)
      head()
      composer()
      side()
      paint(true)
    })
}

function older() {
  const v = view
  if (!v || v.older || !v.more || !v.oldest) return
  v.older = true
  const from = scroller.scrollHeight - scroller.scrollTop
  invoke('qmo_local_read', { session: v.id, before: v.oldest, limit: 200 })
    .then(
      data => {
        if (view !== v) return
        merge(v, data, false)
        v.more = !!data?.more
        paint(false)
        scroller.scrollTop = scroller.scrollHeight - from
      },
      err => {
        if (view === v) tell(why(err), 'warn')
      },
    )
    .then(() => {
      v.older = false
    })
}
scroller.addEventListener(
  'scroll',
  () => {
    if (scroller.scrollTop < 40) older()
  },
  { passive: true },
)

function apply(event) {
  const v = view
  if (event.type === 'record') {
    if (typeof event.seq !== 'number' || event.seq <= v.drawn) return
    if (event.trimmed || event.seq !== v.drawn + 1 || !event.record) {
      load()
      return
    }
    v.drawn = event.seq
    put(event.record)
    paint(false)
  } else if (event.type === 'delta') {
    let live = v.live
    if (!live || live.turn !== event.turn) {
      if (event.offset !== 0 || v.turns.has(event.turn)) return
      live = v.live = { turn: event.turn, text: '', at: Date.now() }
    }
    if (event.offset !== live.text.length) return
    live.text += String(event.text || '')
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        paint(false)
      })
    }
  } else if (event.type === 'activity') {
    v.activity = String(event.words || '')
    paint(false)
  }
}

function onEvent(event) {
  if (!event || typeof event !== 'object') return
  const type = event.type
  if (type === 'runner') {
    if (event.state === 'down') {
      down = true
      // What was streaming went with the process; its record comes on reading.
      if (view?.live) {
        view.live = null
        paint(false)
      }
      tell(t('code.down') + (event.reason ? ` · ${event.reason}` : ''), 'warn')
    } else if (event.state === 'up' && (down || !listed) && !listing) {
      down = false
      tell('')
      const again = listed
      list(!again).then(() => {
        if (again && view?.id) load()
      }, refused)
    }
    return
  }
  if (type === 'session') {
    const s = event.session
    if (!s || typeof s.id !== 'string') return
    sessions[s.id] = s
    side()
    if (s.id === current) {
      head()
      composer()
      paint(false)
    }
    return
  }
  if (type === 'open') {
    if (listed && sessions[event.session]) open(event.session, true)
    return
  }
  if (type === 'removed') {
    delete sessions[event.session]
    if (event.session === current) blank(true)
    else side()
    return
  }
  if (!view || event.session !== view.id) return
  if (view.reading) {
    view.queue.push(event)
    return
  }
  apply(event)
}

// ---- drawing a session ----

function cached(key, sig, make) {
  let have = view.cache.get(key)
  if (!have || have.sig !== sig) {
    have = { sig, el: make(), fresh: true }
    view.cache.set(key, have)
  }
  have.used = true
  return have.el
}

function place(parent, want) {
  for (let i = 0; i < want.length; i++) {
    if (parent.children[i] !== want[i]) {
      parent.insertBefore(want[i], parent.children[i] || null)
    }
  }
  while (parent.children.length > want.length) {
    parent.removeChild(parent.lastElementChild)
  }
}

const how = turn =>
  turn.state === 'pending' ? 'queued' : turn.state === 'failed' ? 'unsent' : ''

function paint(bottom) {
  const v = view
  if (!v) return
  const atEnd =
    bottom ||
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  for (const entry of v.cache.values()) {
    entry.used = false
    entry.fresh = false
  }
  const all = [...v.turns.values()].sort((a, b) => a.f - b.f)
  let lastUser = ''
  let since = 0
  for (const { t: turn } of all) {
    if (turn.author === 'operator' && turn.variant !== 'notice') {
      lastUser = turn.id
      since = turn.at
    }
  }
  const want = []
  let before
  let group = null
  const groups = []
  for (const entry of all) {
    const turn = entry.t
    const step = turn.variant === 'notice' && !R.asking(turn)
    if (!(step && group) && R.pauses(turn.at, before)) {
      const at = turn.at
      const prior = before
      want.push(
        cached(`sep:${turn.id}`, `${at}|${prior}`, () => R.sep(at, prior)),
      )
    }
    before = turn.at
    if (step) {
      if (!group) {
        const key = `steps:${turn.id}`
        group = v.groups.get(key)
        if (!group) {
          group = R.steps(key)
          v.groups.set(key, group)
        }
        group.items = []
        groups.push(group)
        want.push(group.el)
      }
      group.items.push(entry)
      continue
    }
    group = null
    const last = turn.id === lastUser
    want.push(
      cached(`turn:${turn.id}`, `${entry.s}|${last}`, () => {
        if (R.asking(turn)) return R.ask(turn)
        if (turn.author === 'operator') return R.user(turn, how(turn), last)
        return R.agent(turn, false)
      }),
    )
  }
  for (let g = 0; g < groups.length; g++) {
    steps(
      groups[g],
      g === groups.length - 1 && group === groups[g] && running(),
    )
  }
  if (v.live) {
    if (!v.live.el) v.live.el = R.agent({ text: '', at: v.live.at }, true)
    const text = v.live.el.querySelector('.fx-text')
    clear(text)
    R.richText(text, v.live.text)
    want.push(v.live.el)
  }
  for (const line of v.lines) {
    if (!line.el || line.drawn !== line.how) {
      line.el = R.user(line, line.how, false)
      line.el.qmoLine = line
      line.drawn = line.how
    }
    want.push(line.el)
  }
  if (running() && !v.live?.text) {
    if (!v.pend) v.pend = R.pending()
    v.pend.querySelector('.fx-typing-word').textContent =
      v.activity || word('code.thinking')
    v.since = since || sessions[current]?.updatedAt || Date.now()
    want.push(v.pend)
  } else v.activity = ''
  place(msgs, want)
  let focus = null
  for (const [key, entry] of v.cache) {
    if (!entry.used) v.cache.delete(key)
    else if (entry.fresh && entry.el.className === 'fx-perm') {
      focus = entry.el.querySelector('.fx-perm-once')
    }
  }
  // Not out of a field with words in it: a space typed there would approve.
  const at = document.activeElement
  if (focus && !(at && /^(TEXTAREA|INPUT)$/.test(at.tagName) && at.value)) {
    focus.focus({ preventScroll: true })
  }
  tick()
  if (atEnd) scroller.scrollTop = scroller.scrollHeight
}

function steps(group, live) {
  const want = []
  let worst = 'muted'
  for (const item of group.items) {
    const turn = item.t
    want.push(cached(`step:${turn.id}`, item.s, () => R.step(turn)))
    const tool = turn.tool || {}
    if (tool.status === 'failed' || turn.severity === 'error') worst = 'bad'
    else if (
      worst !== 'bad' &&
      (tool.status === 'denied' ||
        turn.severity === 'warn' ||
        turn.ask?.decision === 'deny')
    ) {
      worst = 'warn'
    }
  }
  place(group.list, want)
  const last = group.items[group.items.length - 1].t
  group.label(
    group.items.length,
    String(last.ask ? last.ask.title || last.text : last.text || ''),
    live,
    worst,
  )
}

function tick() {
  const pend = view?.pend?.isConnected ? view.pend : null
  if (!pend) {
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
    return
  }
  pend.querySelector('.fx-typing-time').textContent = R.elapsed(
    Date.now() - view.since,
  )
  if (!ticker) ticker = setInterval(tick, 1000)
}

// ---- sending ----

function send(text) {
  const v = view
  const line = { clientId: clientId(), text, at: Date.now(), how: 'sending' }
  v.lines.push(line)
  box.value = ''
  grow()
  paint(true)
  invoke('qmo_local_send', {
    session: v.id,
    text,
    clientId: line.clientId,
  }).then(
    data => {
      if (data?.queued && line.how === 'sending') line.how = 'queued'
      if (view === v) paint(false)
    },
    err => {
      line.how = 'failed'
      if (view !== v) return
      paint(false)
      tell(why(err), 'warn')
    },
  )
}

function submit() {
  const text = box.value
  if (!text.trim() || !listed || !view?.id) return
  send(text)
}

$('box').addEventListener('submit', event => {
  event.preventDefault()
  submit()
})
box.addEventListener('keydown', event => {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.isComposing ||
    event.keyCode === 229
  ) {
    return
  }
  event.preventDefault()
  submit()
})
box.addEventListener('input', grow)

stop.addEventListener('click', () => {
  if (!current) return
  const id = current
  tell(t('code.stopping'))
  invoke('qmo_local_stop', { session: id }).then(
    () => {
      if (current === id) tell('')
    },
    err => {
      if (current === id) tell(why(err), 'warn')
    },
  )
})

// ---- the permission mode ----

function bypass(on) {
  $('bypass').hidden = !on
  if (on) $('bypass-ok').focus()
}

function setMode(next) {
  if (!current) return
  const id = current
  const before = sessions[id].mode
  const mine = ++modeAsk
  modeWant = next
  invoke('qmo_local_set_mode', { session: id, mode: next }).then(
    data => {
      if (mine !== modeAsk) return
      modeWant = ''
      if (current !== id) return
      const mode = data?.mode || next
      sessions[id].mode = mode
      modePick.value = mode
      tell(data?.applies === 'next-turn' ? t('code.next') : t('code.now'))
    },
    err => {
      if (mine !== modeAsk) return
      modeWant = ''
      if (current !== id) return
      sessions[id].mode = before
      modePick.value = before
      tell(why(err), 'warn')
    },
  )
}

modePick.addEventListener('change', () => {
  if (modePick.value === 'full-access') return bypass(true)
  bypass(false)
  setMode(modePick.value)
})
$('bypass-ok').addEventListener('click', () => {
  bypass(false)
  setMode('full-access')
  modePick.focus()
})
$('bypass-no').addEventListener('click', () => {
  bypass(false)
  if (current && sessions[current]) modePick.value = sessions[current].mode
  modePick.focus()
})

// ---- what the records carry: retry, copy, asks ----

msgs.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]')
  if (!button || !msgs.contains(button)) return
  const action = button.getAttribute('data-action')
  if (action === 'code-retry') {
    const line = button.closest('.fx-msg')?.qmoLine
    if (!line || !view) return
    view.lines = view.lines.filter(other => other !== line)
    send(line.text)
  } else if (action === 'fx-copy-turn') {
    const text = button.closest('.fx-msg')?.querySelector('.fx-text')
    if (text) navigator.clipboard?.writeText(text.innerText).catch(() => {})
  } else if (action === 'code-ask') answer(button)
  else if (action === 'code-deny') {
    const note = button.closest('.fx-perm').querySelector('.fx-perm-note')
    note.hidden = !note.hidden
    button.setAttribute('aria-expanded', note.hidden ? 'false' : 'true')
    if (!note.hidden) note.querySelector('input').focus()
  }
})

function answer(button) {
  const card = button.closest('.fx-perm')
  if (!card || !current) return
  const args = {
    session: current,
    ask: card.getAttribute('data-ask') || '',
    decision: button.getAttribute('data-decision') || '',
  }
  const note = card.querySelector('.fx-perm-note input')
  if (args.decision === 'deny' && note?.value.trim()) {
    args.message = note.value.trim()
  }
  const buttons = card.querySelectorAll('button')
  for (const b of buttons) b.disabled = true
  invoke('qmo_local_answer', args).catch(err => {
    for (const b of buttons) b.disabled = false
    card.querySelector('.fx-perm-say').textContent = why(err)
  })
}

// Enter approves nothing: a button takes space or a click; in the note it denies.
msgs.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !event.target.closest) return
  const card = event.target.closest('.fx-perm')
  if (!card) return
  event.preventDefault()
  if (event.target.tagName === 'INPUT' && !event.isComposing) {
    card.querySelector('.fx-perm-note button').click()
  }
})

// ---- back to the hub ----

let reconnecting = false

/** Nothing would be lost by leaving: no words in the box or a note. */
function idle() {
  if (box.value.trim()) return false
  for (const input of msgs.querySelectorAll('.fx-perm-note input')) {
    if (input.value.trim()) return false
  }
  return true
}

function reconnect(byHand) {
  if (reconnecting || (!byHand && !idle())) return
  reconnecting = true
  const button = $('reconnect')
  button.disabled = true
  $('offline').textContent = t('code.reconnecting')
  invoke('local_reconnect', { session: current || null }).then(
    // In: the shell is taking the window to the hub's /code.
    () => {},
    problem => {
      reconnecting = false
      button.disabled = false
      const kind = KNOWN.has(problem?.kind) ? problem.kind : 'other'
      $('offline').textContent =
        kind === 'network' ? t('code.offline') : t(`offline.${kind}`)
    },
  )
}

$('reconnect').addEventListener('click', () => reconnect(true))
window.addEventListener('online', () => reconnect(false))
setInterval(() => {
  if (!document.hidden) reconnect(false)
}, AGAIN_MS)

// ---- start ----

function list(route) {
  listing = true
  return invoke('qmo_local_list', {}).then(
    data => {
      listing = false
      const all = Array.isArray(data?.sessions) ? data.sessions : []
      sessions = {}
      for (const s of all) if (typeof s?.id === 'string') sessions[s.id] = s
      listed = true
      if (!route) {
        side()
        head()
        composer()
        return
      }
      const want = idInUrl() || stored()
      if (want && sessions[want]) open(want, false)
      else {
        if (idInUrl()) history.replaceState(null, '', 'code.html')
        blank(false)
      }
    },
    err => {
      listing = false
      throw err
    },
  )
}

function refused(err) {
  listing = false
  tell(why(err), 'warn')
}

const channel = new window.__TAURI__.core.Channel()
channel.onmessage = onEvent
blank(false)
listing = true
invoke('qmo_local_watch', { channel })
  .then(() => list(true))
  .catch(refused)
