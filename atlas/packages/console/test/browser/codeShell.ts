// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A desktop app and a runner that exist only in the page, for Code's
 * browser suite and screenshots (`qmo-local.md` §4.5). Injected before the
 * page's own scripts (`Page.addScriptToEvaluateOnNewDocument`), it defines
 * `window.__QMO_SHELL__` and a Tauri `invoke` with a `Channel` class the way
 * the shell's injected globals do, and answers the `qmo_local_*` commands
 * with the shapes of §4.5.1 from a small in-memory runner. Its state lives in
 * `sessionStorage`, so a reload finds the same sessions, the way the real
 * runner's files outlive the page.
 *
 * The test plays the agent through `window.__fake`: `write` a record, `live`
 * a piece of the answer as a `delta`, `state` a session, `emit` any event,
 * `skip` a record without telling the page (a gap), `set` an option. Every
 * call the page makes is in `window.__calls`. No app window, runner or agent is started.
 *
 * The arguments are checked as the real shell checks their keys and types,
 * from the contract its own tests read too (`qmo-local-calls.json`; `ipc.rs`
 * `the_shared_contract_is_what_the_shell_checks`): a call out of shape is
 * refused with `qmo local E_ARGS` and kept in `window.__badArgs`.
 */

import contract from '../../../../tests/integration/fixtures/qmo-local-calls.json' with {
  type: 'json',
}

/** A folder as the runner answers it (§4.5.1). */
export interface FakeFolder {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly git: boolean
}

export interface FakeShellOptions {
  /** `qmo_local_list` refuses with this line instead of answering. */
  readonly listRefusal?: string
  /** What `qmo_local_agents` answers, or the line it refuses with. */
  readonly agents?: readonly object[] | string
  readonly folders?: readonly FakeFolder[]
  /** What the native folder picker comes back with (`null`: cancelled). */
  readonly pick?: FakeFolder | null
  /** `qmo_local_start` refuses with this line. */
  readonly startRefusal?: string
  /** Commands that answer this many milliseconds later. */
  readonly delays?: Readonly<Record<string, number>>
  /** How many `qmo_local_send`s are refused before they go through. */
  readonly sendRefusals?: number
  /** `qmo_local_set_mode` refuses this mode. */
  readonly refuseMode?: string
  /** `qmo_local_set_mode` answers `next-turn` instead of `now`. */
  readonly modeNextTurn?: boolean
  /** The changes panel's answer, and each file's diff. */
  readonly changes?: object
  readonly diffs?: Readonly<Record<string, string>>
}

export const FOLDER: FakeFolder = {
  id: '0123456789abcdef',
  name: 'atlas',
  path: '/Users/me/project/atlas',
  git: true,
}

export const AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    version: '2.1.310',
    protocol: 'claude-stream',
    available: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    version: '0.164.0',
    protocol: 'codex-app-server',
    available: true,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    version: '0.9.0',
    protocol: 'acp',
    available: false,
    reason: '版本太旧',
  },
]

/** Each command's keys, the optional ones, and each key's JSON type. */
const SHAPES: Record<
  string,
  { readonly keys: Record<string, string>; readonly optional: string[] }
> = Object.fromEntries(
  contract.calls.map(call => [
    call.command,
    {
      keys: Object.fromEntries(
        Object.entries(call.args).map(([key, value]) => [key, typeof value]),
      ),
      optional: 'optional' in call ? [...call.optional] : [],
    },
  ]),
)

/** The page-side script: the shell, the channel and the runner. */
export function fakeShell(options: FakeShellOptions = {}): string {
  const config = {
    agents: AGENTS,
    folders: [FOLDER],
    pick: null,
    changes: { source: 'git', files: [], truncated: false },
    diffs: {},
    ...options,
  }
  return `
(function () {
  var config = ${JSON.stringify(config)};
  var shapes = ${JSON.stringify(SHAPES)};
  var KEY = '__qmoFakeRunner';
  var state = null;
  try { state = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { state = null; }
  if (!state) state = { folders: config.folders, sessions: {}, n: 0, refused: 0 };
  function save() { sessionStorage.setItem(KEY, JSON.stringify(state)); }
  var channel = null;
  window.__calls = [];
  window.__events = 0;
  function Channel() { this.id = Math.floor(Math.random() * 1e6); this.onmessage = null; }
  Channel.prototype.toJSON = function () { return '__CHANNEL__:' + this.id; };
  function emit(event) {
    event.v = 1;
    window.__events += 1;
    if (channel && typeof channel.onmessage === 'function') channel.onmessage(event);
  }
  function summary(s) {
    return { id: s.id, title: s.title, folder: { id: s.folder.id, name: s.folder.name }, agent: s.agent,
      mode: s.mode, state: s.state, remote: false, createdAt: s.createdAt, updatedAt: s.updatedAt, lastSeq: s.seq };
  }
  function touch(s) { s.updatedAt = Date.now(); save(); emit({ type: 'session', session: summary(s) }); }
  function write(s, turn, quiet) {
    s.seq += 1;
    var record = { seq: s.seq, kind: 'turn', turn: turn };
    s.records.push(record);
    if (s.live && s.live.turn === turn.id) s.live = null;
    save();
    if (!quiet) emit({ type: 'record', session: s.id, seq: record.seq, record: record });
    return record;
  }
  function id(prefix, size) {
    state.n += 1;
    var tail = String(state.n);
    while (tail.length < size) tail = 'x' + tail;
    return prefix + tail;
  }
  function turn(s, over) {
    var t = { id: id('t_', 6), sessionId: s.id, author: 'agent', at: Date.now(), text: '', state: 'done' };
    for (var k in over) t[k] = over[k];
    return t;
  }
  function find(sid) {
    var s = state.sessions[sid];
    if (!s) throw 'qmo local E_SESSION: 没有这个会话';
    return s;
  }
  function answer(command, args) {
    if (command === 'qmo_local_watch') { channel = args.channel; return {}; }
    if (command === 'qmo_local_list') {
      if (config.listRefusal) throw config.listRefusal;
      var all = [];
      for (var k in state.sessions) all.push(summary(state.sessions[k]));
      return { v: 1, features: { protocols: ['claude-stream'], worktree: false, remote: false }, folders: state.folders, sessions: all };
    }
    if (command === 'qmo_local_agents') {
      if (typeof config.agents === 'string') throw config.agents;
      return { agents: config.agents };
    }
    if (command === 'qmo_local_pick_folder') {
      if (config.pick) state.folders = [config.pick].concat(state.folders.filter(function (f) { return f.id !== config.pick.id; }));
      save();
      return config.pick;
    }
    if (command === 'qmo_local_start') {
      if (config.startRefusal) throw config.startRefusal;
      var folder = state.folders.filter(function (f) { return f.id === args.folder; })[0];
      if (!folder) throw 'qmo local E_FOLDER: 文件夹不在了';
      var s = { id: id('cs_', 22), title: args.text.split('\\n')[0].slice(0, 40), folder: folder,
        agent: { id: args.agent, name: 'Claude Code' }, mode: args.mode, state: 'running', seq: 0, records: [], live: null,
        createdAt: Date.now(), updatedAt: Date.now() };
      state.sessions[s.id] = s;
      touch(s);
      var first = write(s, turn(s, { author: 'operator', text: args.text, state: 'read', clientId: args.clientId }));
      return { session: summary(s), turn: first.turn };
    }
    if (command === 'qmo_local_send') {
      if (state.refused < (config.sendRefusals || 0)) { state.refused += 1; save(); throw 'qmo local E_BUSY: 队列已满'; }
      var to = find(args.session);
      var busy = to.state === 'running';
      var line = write(to, turn(to, { author: 'operator', text: args.text, state: busy ? 'pending' : 'read', clientId: args.clientId }));
      if (!busy) { to.state = 'running'; touch(to); }
      return { turn: line.turn, queued: busy };
    }
    if (command === 'qmo_local_stop') { var st = find(args.session); st.state = 'interrupted'; touch(st); return {}; }
    if (command === 'qmo_local_answer') {
      var on = find(args.session);
      var ask = null;
      for (var i = on.records.length - 1; i >= 0; i--) if (on.records[i].turn.ask && on.records[i].turn.ask.id === args.ask) { ask = on.records[i].turn; break; }
      if (!ask || ask.ask.decision) throw 'qmo local E_ASK: 这个征询已经答过';
      var done = JSON.parse(JSON.stringify(ask));
      done.ask.decision = args.decision;
      done.ask.by = 'user';
      if (args.message) done.ask.message = args.message;
      write(on, done);
      on.state = 'running';
      touch(on);
      return {};
    }
    if (command === 'qmo_local_set_mode') {
      if (config.refuseMode === args.mode) throw 'qmo local E_ARGS: 这个 Claude Code 没有自动模式';
      var m = find(args.session);
      m.mode = args.mode;
      touch(m);
      return { mode: args.mode, applies: config.modeNextTurn ? 'next-turn' : 'now' };
    }
    if (command === 'qmo_local_read') {
      var r = find(args.session);
      var limit = args.limit || 100;
      var below = r.records.filter(function (x) { return !args.before || x.seq < args.before; });
      var page = below.slice(Math.max(0, below.length - limit));
      return { session: summary(r), records: page, more: page.length < below.length, lastSeq: r.seq,
        live: r.live ? { turn: r.live.turn, text: r.live.text } : undefined };
    }
    if (command === 'qmo_local_changes') { find(args.session); return config.changes; }
    if (command === 'qmo_local_diff') {
      return { path: args.path, text: config.diffs[args.path] || '', truncated: false, binary: false };
    }
    if (command === 'qmo_local_set_remote') throw 'qmo local E_REMOTE: 未开放';
    if (command === 'qmo_boot_layout') return null;
    throw 'Command ' + command + ' not found';
  }
  window.__badArgs = [];
  // What the shell would refuse: a key it does not take, one it needs left
  // out, a value of another JSON type (as Tauri sends them: a Channel is its string).
  function misshapen(command, args) {
    var shape = shapes[command];
    if (!shape) return '';
    var sent = JSON.parse(JSON.stringify(args === undefined ? {} : args));
    if (!sent || typeof sent !== 'object' || Array.isArray(sent)) return 'arguments must be an object';
    for (var k in sent) {
      if (!Object.prototype.hasOwnProperty.call(shape.keys, k)) return 'unknown argument ' + k;
      if (sent[k] === null ? shape.optional.indexOf(k) === -1 : typeof sent[k] !== shape.keys[k]) return k + ' is not a ' + shape.keys[k];
    }
    for (var key in shape.keys) {
      if (shape.optional.indexOf(key) === -1 && !(key in sent)) return key + ' is required';
    }
    return '';
  }
  function invoke(command, args) {
    window.__calls.push([command, args === undefined ? null : JSON.parse(JSON.stringify(args, function (k, v) {
      return v instanceof Channel ? 'channel' : v;
    }))]);
    var bad = misshapen(command, args);
    if (bad) {
      window.__badArgs.push([command, bad]);
      return Promise.reject('qmo local E_ARGS: ' + bad);
    }
    var later = (config.delays && config.delays[command]) || 0;
    return new Promise(function (resolve, reject) {
      function run() { try { resolve(answer(command, args || {})); } catch (e) { reject(e); } }
      if (later) setTimeout(run, later); else run();
    });
  }
  window.__fake = {
    sessions: function () { return Object.keys(state.sessions); },
    write: function (sid, over, quiet) { var s = find(sid); return write(s, turn(s, over), quiet).turn; },
    rewrite: function (sid, t) { return write(find(sid), t).turn; },
    skip: function (sid, over) { var s = find(sid); return write(s, turn(s, over), true).turn; },
    live: function (sid, turnId, text) {
      var s = find(sid);
      if (!s.live || s.live.turn !== turnId) s.live = { turn: turnId, text: '' };
      var offset = s.live.text.length;
      s.live.text += text;
      save();
      emit({ type: 'delta', session: sid, turn: turnId, offset: offset, text: text });
    },
    state: function (sid, value) { var s = find(sid); s.state = value; touch(s); },
    emit: emit,
    set: function (key, value) { config[key] = value; },
    channel: function () { return channel; }
  };
  window.__QMO_SHELL__ = Object.freeze({ platform: 'macos', window: 'main', version: 'test' });
  window.__TAURI__ = { core: { invoke: invoke, Channel: Channel } };
})();
`
}
