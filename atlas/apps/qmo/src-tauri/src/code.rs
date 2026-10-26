// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Local sessions (qmo-local.md §4.3.2, §4.5): the bridge between the hub's
//! Code page and `qmo code serve`, the runner.
//!
//! The runner is the bundled `qmo`, kept as a child for as long as the shell
//! runs and started on the page's first call. One JSON value per line each
//! way: requests `{id, method, params}` go in on its standard input; answers
//! `{id, result}` or `{id, error: {code, message}}` and events
//! `{method: "event", params}` come back on its standard output; its standard
//! error is a log, of which the last 64 KiB are kept in
//! `<client dir>/code/runner.log` (the runner says where in its `hello`).
//!
//! The shell checks what the page asks (`ipc.rs`), passes it on, and hands
//! the answer back as the call's result or as `qmo local <code>: <message>`.
//! Events go to the one channel the main window's page registered, in order
//! and as the runner wrote them. A runner that ends is started again after
//! 1, 2, 5, 10, then every 30 s; the calls it had not answered are turned
//! down with `E_RUNNER`, and the page gets `{type: "runner", state: "down"}`.
//! Quitting Qmo asks it to `shutdown`, waits 3 s for the answer and ends it
//! if it is still there 5 s on.
//!
//! The shell reads the stream too (`Runner::tap`, `attention.rs`): which
//! sessions ended a turn or wait for the person, for notifications, the
//! badge and the question on quitting.
//!
//! The transport is a pair of pipes and a process handle (`Pipes`), so the
//! tests drive a fake runner over in-memory pipes.

use std::{
    collections::{HashMap, VecDeque},
    fmt,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use tauri::{
    ipc::Channel,
    plugin::{Plugin, TauriPlugin},
    AppHandle, Manager, RunEvent, Runtime, Url, Webview, Window,
};

use crate::{ipc::Invalid, sidecar};

/// How one call ends badly, as the page gets it: `qmo local <code>: <message>`
/// (qmo-local.md §4.5.1). The page tells these from Tauri's own refusals,
/// which mean a shell older than local sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

impl Refusal {
    pub fn new(code: &str, message: impl Into<String>) -> Refusal {
        Refusal {
            code: code.to_string(),
            message: message.into(),
        }
    }

    fn runner(message: impl Into<String>) -> Refusal {
        Refusal::new("E_RUNNER", message)
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "qmo local {}: {}", self.code, self.message)
    }
}

impl From<Invalid> for Refusal {
    fn from(invalid: Invalid) -> Refusal {
        Refusal::new("E_ARGS", invalid.0)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- transport ----------------------------------------------------------

/// A runner that has ended, or how to end one.
pub trait Process: Send {
    /// How it ended, once it has.
    fn ended(&mut self) -> Option<String>;
    /// End it now.
    fn kill(&mut self);
}

impl Process for Child {
    fn ended(&mut self) -> Option<String> {
        match self.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            Ok(None) => None,
            Err(e) => Some(e.to_string()),
        }
    }

    fn kill(&mut self) {
        let _ = Child::kill(self);
        let _ = self.wait();
    }
}

/// A started runner: where requests go, where answers, events and its log
/// come from, and the process.
pub struct Pipes {
    pub input: Box<dyn Write + Send>,
    pub output: Box<dyn Read + Send>,
    pub errors: Box<dyn Read + Send>,
    pub process: Box<dyn Process>,
}

/// How to start a runner.
pub type Launch = Box<dyn Fn() -> io::Result<Pipes> + Send + Sync>;

/// `qmo code serve`: the `qmo` beside the shell (`sidecar::qmo_path`), with
/// the shell's environment (`QMO_CLIENT_DIR` included, so it finds the same
/// client directory as every other `qmo` the shell runs).
pub fn launch_qmo() -> io::Result<Pipes> {
    let mut command = Command::new(sidecar::qmo_path()?);
    command.args(["code", "serve"]);
    spawn(command)
}

/// Start `command` with its three streams piped.
fn spawn(mut command: Command) -> io::Result<Pipes> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashes up behind the shell.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    let (Some(input), Some(output), Some(errors)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        Process::kill(&mut child);
        return Err(io::Error::other("the runner's pipes are missing"));
    };
    Ok(Pipes {
        input: Box::new(input),
        output: Box::new(output),
        errors: Box::new(errors),
        process: Box::new(child),
    })
}

/// How long things may take.
#[derive(Debug, Clone)]
pub struct Timing {
    /// From start to the answer to `hello` (§4.3.2: 2 s).
    pub hello: Duration,
    /// From a request to its answer; the call is turned down after this,
    /// the runner is left alone.
    pub call: Duration,
    /// Between a runner ending and the next start, by how many ended in a row.
    pub backoff: Vec<Duration>,
    /// A runner up this long that then ends starts the backoff over.
    pub steady: Duration,
    /// From `shutdown` to its answer.
    pub shutdown_answer: Duration,
    /// From `shutdown` to the runner being ended regardless.
    pub shutdown_exit: Duration,
    /// From the end of its output to the runner being ended regardless.
    pub reap: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            hello: Duration::from_secs(2),
            call: Duration::from_secs(30),
            backoff: [1, 2, 5, 10, 30].map(Duration::from_secs).to_vec(),
            steady: Duration::from_secs(60),
            shutdown_answer: Duration::from_secs(3),
            shutdown_exit: Duration::from_secs(5),
            reap: Duration::from_secs(1),
        }
    }
}

/// The longest line read from the runner. An answer to `session.read` can
/// carry 200 records of up to 256 KiB each.
const LINE_MAX: usize = 64 << 20;

/// The largest event passed on; the runner keeps them under 8 KiB
/// (§4.5.2), so anything near this is a fault.
const EVENT_MAX: usize = 1 << 20;

/// How much of the runner's log is kept (§4.3.2).
const LOG_MAX: usize = 64 << 10;

/// The runner's answer to `hello`: `{version, protocol: 1, features}`, and
/// where its client directory's `code/` is, for `runner.log`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    protocol: Value,
    #[serde(default)]
    version: Option<Value>,
    #[serde(default)]
    code_dir: Option<Value>,
    #[serde(default)]
    features: Option<Value>,
}

/// One line from the runner, whatever it turns out to be.
#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    result: Option<Box<RawValue>>,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Box<RawValue>>,
}

type Answer = Result<Box<RawValue>, Refusal>;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    /// Never started: the next call starts it.
    Idle,
    /// Started, waiting for its `hello`.
    Starting,
    Up,
    /// Ended; started again at `at`.
    Waiting {
        at: Instant,
        reason: String,
    },
    /// Qmo is quitting: never started again.
    Stopped,
}

/// The runner now running.
struct Live {
    generation: u64,
    input: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    process: Arc<Mutex<Box<dyn Process>>>,
    hello: u64,
    up_since: Option<Instant>,
}

struct State {
    phase: Phase,
    live: Option<Live>,
    generation: u64,
    next_id: u64,
    /// Calls waiting for an answer: id → (generation, where the answer goes).
    pending: HashMap<u64, (u64, mpsc::Sender<Answer>)>,
    /// Runners that ended in a row without staying up `steady`.
    failures: usize,
    /// Why the live runner is being ended, when the shell ends it.
    ending: Option<String>,
    /// `features.remote` of the last `hello`; `None` before the first.
    remote: Option<bool>,
}

/// The tail of the runner's log, and where it goes.
#[derive(Default)]
struct Log {
    tail: VecDeque<u8>,
    dir: Option<PathBuf>,
}

impl Log {
    fn append(&mut self, bytes: &[u8]) {
        self.tail.extend(bytes);
        if self.tail.len() > LOG_MAX {
            let excess = self.tail.len() - LOG_MAX;
            self.tail.drain(..excess);
            // Start on a whole line.
            if let Some(newline) = self.tail.iter().position(|b| *b == b'\n') {
                self.tail.drain(..=newline);
            }
        }
    }

    fn note(&mut self, line: &str) {
        self.append(format!("[{} qmo-app] {line}\n", utc_now()).as_bytes());
    }

    /// Write the tail to `<dir>/runner.log`, readable by this user only.
    fn flush(&self) {
        let Some(dir) = &self.dir else { return };
        let (front, back) = self.tail.as_slices();
        if let Err(e) = write_private(&dir.join("runner.log"), &[front, back].concat()) {
            eprintln!("qmo: runner.log not written: {e}");
        }
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let mut file = options.open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        options.open(path)?.write_all(bytes)
    }
}

/// Now, as `2026-10-24T05:21:00Z`.
fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

/// The main window page's event channel (§4.5.2): one at a time, replaced
/// by the next `qmo_local_watch`, dropped when the main window starts loading
/// a page.
#[derive(Default)]
pub struct Watcher {
    channel: Mutex<Option<Channel<Box<RawValue>>>>,
}

impl Watcher {
    pub fn watch(&self, channel: Channel<Box<RawValue>>) {
        *lock(&self.channel) = Some(channel);
    }

    pub fn forget(&self) {
        lock(&self.channel).take();
    }

    /// A page has a channel now.
    pub fn watching(&self) -> bool {
        lock(&self.channel).is_some()
    }

    /// Send the shell's own event to the page; whether it went.
    pub fn tell(&self, event: &RawValue) -> bool {
        self.send(event)
    }

    fn send(&self, event: &RawValue) -> bool {
        let Some(channel) = lock(&self.channel).clone() else {
            return false;
        };
        if channel.send(event.to_owned()).is_err() {
            let mut current = lock(&self.channel);
            if current.as_ref().is_some_and(|c| c.id() == channel.id()) {
                current.take();
            }
            return false;
        }
        true
    }
}

/// What the shell itself is shown of the runner's stream (`Runner::tap`).
pub enum Seen<'a> {
    /// An event, as the page gets it.
    Event(&'a RawValue),
    /// The runner is gone: its sessions with it, until it is back.
    Down,
}

type Tap = Arc<dyn Fn(Seen<'_>) + Send + Sync>;

/// The shell's event telling the page to open a session (a notification
/// was clicked): `{v: 1, type: "open", session}`.
pub fn open_event(session: &str) -> Box<RawValue> {
    serde_json::value::to_raw_value(&serde_json::json!({
        "v": 1,
        "type": "open",
        "session": session,
    }))
    .expect("an event is JSON")
}

/// The answer to `list` with what new sessions start with, from the
/// shell's settings (qmo-local.md §4.5.1): `defaults: {mode, remote}`.
pub fn with_defaults(answer: Box<RawValue>, mode: &str, remote: bool) -> Box<RawValue> {
    let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(answer.get()) else {
        return answer;
    };
    map.insert(
        "defaults".into(),
        serde_json::json!({ "mode": mode, "remote": remote }),
    );
    serde_json::value::to_raw_value(&map).unwrap_or(answer)
}

/// The shell's own event about the runner: `{v: 1, type: "runner", state, reason?}`.
#[derive(Serialize)]
struct RunnerEvent<'a> {
    v: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'a str>,
}

fn runner_event(up: bool, reason: Option<&str>) -> Box<RawValue> {
    let event = RunnerEvent {
        v: 1,
        kind: "runner",
        state: if up { "up" } else { "down" },
        reason,
    };
    serde_json::value::to_raw_value(&event).expect("an event is JSON")
}

/// One line of the runner's words for the page: control characters made
/// spaces, at most 500 characters.
fn one_line(text: &str) -> String {
    let line: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(500)
        .collect();
    line.trim().to_string()
}

/// An `error` the runner answered with, as the page gets it.
fn refusal_from(error: &Value) -> Refusal {
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|code| {
            code.len() <= 32
                && code.starts_with("E_")
                && code.len() > 2
                && code[2..]
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b == b'_')
        })
        .unwrap_or("E_RUNNER");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(one_line)
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "运行器没有说明原因".to_string());
    Refusal::new(code, message)
}

fn is_object(raw: &RawValue) -> bool {
    raw.get().trim_start().starts_with('{')
}

/// A positive integer id.
fn message_id(id: &Value) -> Option<u64> {
    id.as_u64().filter(|id| *id > 0)
}

/// The next line, without its newline: `Ok(None)` at the end, `Ok(Some(false))`
/// for a line over `max` (skipped).
fn next_line(
    reader: &mut impl BufRead,
    max: usize,
    line: &mut Vec<u8>,
) -> io::Result<Option<bool>> {
    line.clear();
    let mut whole = true;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            // A line cut off by the end is not a line.
            return Ok(None);
        }
        let (take, done) = match available.iter().position(|b| *b == b'\n') {
            Some(newline) => (newline, true),
            None => (available.len(), false),
        };
        if whole && line.len() + take <= max {
            line.extend_from_slice(&available[..take]);
        } else {
            whole = false;
            line.clear();
        }
        reader.consume(take + usize::from(done));
        if done {
            return Ok(Some(whole));
        }
    }
}

struct Inner {
    launch: Launch,
    timing: Timing,
    state: Mutex<State>,
    changed: Condvar,
    watcher: Watcher,
    log: Mutex<Log>,
    tap: Mutex<Option<Tap>>,
}

/// The shell's runner; see the module comment.
pub struct Runner {
    inner: Arc<Inner>,
}

impl Runner {
    pub fn new(launch: Launch, timing: Timing) -> Runner {
        Runner {
            inner: Arc::new(Inner {
                launch,
                timing,
                state: Mutex::new(State {
                    phase: Phase::Idle,
                    live: None,
                    generation: 0,
                    next_id: 1,
                    pending: HashMap::new(),
                    failures: 0,
                    ending: None,
                    remote: None,
                }),
                changed: Condvar::new(),
                watcher: Watcher::default(),
                log: Mutex::new(Log::default()),
                tap: Mutex::new(None),
            }),
        }
    }

    pub fn watcher(&self) -> &Watcher {
        &self.inner.watcher
    }

    /// Show the shell each event as it passes, and the runner going down.
    /// Called on the reader's thread: `tap` must not call the runner.
    pub fn tap(&self, tap: impl Fn(Seen<'_>) + Send + Sync + 'static) {
        *lock(&self.inner.tap) = Some(Arc::new(tap));
    }

    /// Whether the runner said it can do Remote; `None` before it first came up.
    pub fn remote_supported(&self) -> Option<bool> {
        lock(&self.inner.state).remote
    }

    /// Ask the runner only if it is up, never starting it, and wait at most
    /// `wait`. `None` when it is not up.
    pub fn ask_if_up(&self, method: &str, params: Value, wait: Duration) -> Option<Answer> {
        let st = lock(&self.inner.state);
        if st.phase != Phase::Up {
            return None;
        }
        Some(self.exchange(st, method, &params, wait))
    }

    /// Ask the runner `method` with `params` and wait for its answer, starting
    /// it first when it is not running yet. Blocking: call from a worker.
    pub fn call(&self, method: &str, params: Value) -> Answer {
        let inner = &self.inner;
        let st = {
            let mut st = lock(&inner.state);
            let deadline =
                Instant::now() + inner.timing.hello + inner.timing.reap + inner.timing.reap;
            loop {
                match &st.phase {
                    Phase::Up => break,
                    Phase::Idle => Inner::start(inner, &mut st),
                    Phase::Starting => {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            return Err(Refusal::runner("运行器没有按时起来"));
                        }
                        st = inner
                            .changed
                            .wait_timeout(st, left)
                            .unwrap_or_else(|e| e.into_inner())
                            .0;
                    }
                    Phase::Waiting { at, reason } => {
                        let secs = at.saturating_duration_since(Instant::now()).as_secs_f64();
                        return Err(Refusal::runner(format!(
                            "运行器不在（{reason}），{:.0} 秒后重起",
                            secs.ceil()
                        )));
                    }
                    Phase::Stopped => return Err(Refusal::runner("Qmo 正在退出")),
                }
            }
            st
        };
        self.exchange(st, method, &params, inner.timing.call)
    }

    /// Send one request to the runner that is up (`st` says so) and wait
    /// for its answer at most `wait`.
    fn exchange(
        &self,
        mut st: MutexGuard<'_, State>,
        method: &str,
        params: &Value,
        wait: Duration,
    ) -> Answer {
        let inner = &self.inner;
        let (id, input, answer) = {
            let live = st.live.as_ref().expect("a runner that is up is live");
            let (generation, input) = (live.generation, live.input.clone());
            let id = st.next_id;
            st.next_id += 1;
            let (tx, rx) = mpsc::channel();
            st.pending.insert(id, (generation, tx));
            drop(st);
            (id, input, rx)
        };
        if let Err(e) = Inner::send(&input, id, method, params) {
            lock(&inner.state).pending.remove(&id);
            return Err(Refusal::runner(format!("没能交给运行器：{e}")));
        }
        match answer.recv_timeout(wait) {
            Ok(answer) => answer,
            Err(_) => {
                lock(&inner.state).pending.remove(&id);
                Err(Refusal::runner(format!(
                    "运行器 {} 秒没有答复",
                    wait.as_secs()
                )))
            }
        }
    }

    /// Quitting Qmo (§4.3.2): no more starts; ask the runner to `shutdown`,
    /// wait for the answer at most `shutdown_answer`, close its input, and end
    /// it if it is still there `shutdown_exit` after the ask. Blocking.
    pub fn shutdown(&self) {
        let inner = &self.inner;
        let began = Instant::now();
        let (live, ask) = {
            let mut st = lock(&inner.state);
            let was = std::mem::replace(&mut st.phase, Phase::Stopped);
            inner.changed.notify_all();
            let Some((generation, parts)) = st
                .live
                .as_ref()
                .map(|live| (live.generation, (live.input.clone(), live.process.clone())))
            else {
                return;
            };
            let ask = (was == Phase::Up).then(|| {
                let id = st.next_id;
                st.next_id += 1;
                let (tx, rx) = mpsc::channel();
                st.pending.insert(id, (generation, tx));
                (id, rx)
            });
            (parts, ask)
        };
        let (input, process) = live;
        lock(&inner.log).note("shutting the runner down");
        if let Some((id, answer)) = ask {
            if Inner::send(&input, id, "shutdown", &Value::Object(Default::default())).is_ok() {
                let _ = answer.recv_timeout(inner.timing.shutdown_answer);
            }
            lock(&inner.state).pending.remove(&id);
        }
        // The end of its input says the same, for a runner that missed it.
        lock(&input).take();
        let mut ended = None;
        while began.elapsed() < inner.timing.shutdown_exit {
            ended = lock(&process).ended();
            if ended.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let mut log = lock(&inner.log);
        match ended {
            Some(status) => log.note(&format!("runner stopped: {status}")),
            None => {
                lock(&process).kill();
                log.note("runner ended: it did not stop in time");
            }
        }
        log.flush();
    }

    #[cfg(test)]
    fn phase(&self) -> Phase {
        lock(&self.inner.state).phase.clone()
    }

    #[cfg(test)]
    fn log_text(&self) -> String {
        let log = lock(&self.inner.log);
        String::from_utf8_lossy(&log.tail.iter().copied().collect::<Vec<u8>>()).into_owned()
    }
}

impl Inner {
    /// Hand `seen` to the shell's tap, if there is one.
    fn show(&self, seen: Seen<'_>) {
        let tap = lock(&self.tap).clone();
        if let Some(tap) = tap {
            tap(seen);
        }
    }

    /// Write one request line.
    fn send(
        input: &Mutex<Option<Box<dyn Write + Send>>>,
        id: u64,
        method: &str,
        params: &Value,
    ) -> io::Result<()> {
        let mut line = serde_json::to_vec(&serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        }))?;
        line.push(b'\n');
        let mut input = lock(input);
        let Some(input) = input.as_mut() else {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"));
        };
        input.write_all(&line)?;
        input.flush()
    }

    /// Start a runner and say `hello`; its answer, or the lack of one, moves
    /// the phase on. Called with the state locked.
    fn start(this: &Arc<Inner>, st: &mut State) {
        st.generation += 1;
        let generation = st.generation;
        let pipes = match (this.launch)() {
            Ok(pipes) => pipes,
            Err(e) => {
                let reason = format!("没起来：{e}");
                lock(&this.log).note(&format!("runner did not start: {e}"));
                Inner::wait_to_restart(this, st, false, &reason);
                return;
            }
        };
        let hello = st.next_id;
        st.next_id += 1;
        let input = Arc::new(Mutex::new(Some(pipes.input)));
        let process = Arc::new(Mutex::new(pipes.process));
        st.live = Some(Live {
            generation,
            input: input.clone(),
            process: process.clone(),
            hello,
            up_since: None,
        });
        st.phase = Phase::Starting;
        st.ending = None;
        lock(&this.log).note("runner started");
        let reader = this.clone();
        let output = pipes.output;
        thread::spawn(move || reader.read(generation, output));
        let logger = this.clone();
        let errors = pipes.errors;
        thread::spawn(move || logger.read_log(errors));
        let watchdog = this.clone();
        thread::spawn(move || {
            thread::sleep(watchdog.timing.hello);
            watchdog.end_if(generation, Phase::Starting, || {
                format!("{} 秒内没有答 hello", watchdog.timing.hello.as_secs_f64())
            });
        });
        // A failed write shows up as the end of its output.
        let _ = Inner::send(&input, hello, "hello", &Value::Object(Default::default()));
    }

    /// End runner `generation` if it is still in `phase`, saying why.
    fn end_if(&self, generation: u64, phase: Phase, why: impl FnOnce() -> String) {
        let process = {
            let mut st = lock(&self.state);
            let process = match st.live.as_ref() {
                Some(live) if live.generation == generation && st.phase == phase => {
                    live.process.clone()
                }
                _ => return,
            };
            st.ending = Some(why());
            process
        };
        lock(&process).kill();
    }

    /// After a runner ended, or did not start: turn down what it had not
    /// answered, tell the page, and start another after the backoff.
    fn wait_to_restart(this: &Arc<Inner>, st: &mut State, was_up: bool, reason: &str) {
        st.failures += 1;
        let backoff = &this.timing.backoff;
        let delay = backoff
            .get(
                st.failures
                    .saturating_sub(1)
                    .min(backoff.len().saturating_sub(1)),
            )
            .copied()
            .unwrap_or(Duration::from_secs(30));
        st.phase = Phase::Waiting {
            at: Instant::now() + delay,
            reason: reason.to_string(),
        };
        this.changed.notify_all();
        lock(&this.log).note(&format!(
            "runner down ({reason}); starting again in {} ms",
            delay.as_millis()
        ));
        // Said once per outage: when it had been up, or on the first failure.
        if was_up || st.failures == 1 {
            this.watcher.send(&runner_event(false, Some(reason)));
        }
        this.show(Seen::Down);
        let generation = st.generation;
        let timer = this.clone();
        thread::spawn(move || {
            thread::sleep(delay);
            let mut st = lock(&timer.state);
            if st.generation == generation && matches!(st.phase, Phase::Waiting { .. }) {
                Inner::start(&timer, &mut st);
            }
        });
    }

    /// The reader: one line at a time until the runner's output ends.
    fn read(self: Arc<Inner>, generation: u64, output: Box<dyn Read + Send>) {
        let mut reader = BufReader::new(output);
        let mut line = Vec::new();
        loop {
            match next_line(&mut reader, LINE_MAX, &mut line) {
                Ok(Some(true)) => self.on_line(generation, &line),
                Ok(Some(false)) => lock(&self.log).note("a line over 64 MiB was dropped"),
                Ok(None) | Err(_) => break,
            }
        }
        self.on_end(generation);
    }

    fn on_line(self: &Arc<Inner>, generation: u64, line: &[u8]) {
        let message: Message = match serde_json::from_slice(line) {
            Ok(message) => message,
            Err(_) => {
                if !line.iter().all(u8::is_ascii_whitespace) {
                    lock(&self.log).note("a line that is not the protocol was dropped");
                }
                return;
            }
        };
        if message.method.as_deref() == Some("event") {
            match message.params {
                Some(event) if is_object(&event) && event.get().len() <= EVENT_MAX => {
                    if lock(&self.state).generation == generation {
                        self.watcher.send(&event);
                        self.show(Seen::Event(&event));
                    }
                }
                _ => lock(&self.log).note("an event that is not an object was dropped"),
            }
            return;
        }
        let Some(id) = message.id.as_ref().and_then(message_id) else {
            lock(&self.log).note("a line without an id was dropped");
            return;
        };
        let answer = match (message.result, message.error) {
            (_, Some(error)) => Err(refusal_from(&error)),
            (Some(result), None) if is_object(&result) => Ok(result),
            _ => Err(Refusal::runner("运行器的答复不成形")),
        };
        let mut st = lock(&self.state);
        if st.generation != generation {
            return;
        }
        if st.live.as_ref().is_some_and(|live| live.hello == id) {
            self.on_hello(&mut st, generation, answer);
            return;
        }
        match st.pending.remove(&id) {
            Some((asked_of, waiter)) if asked_of == generation => {
                let _ = waiter.send(answer);
            }
            Some(other) => {
                st.pending.insert(id, other);
            }
            // Answered after its call gave up.
            None => {}
        }
    }

    /// The answer to `hello`: the runner is up, or it is ended.
    fn on_hello(self: &Arc<Inner>, st: &mut State, generation: u64, answer: Answer) {
        let hello = answer
            .map_err(|refusal| format!("hello 被拒：{}", refusal.message))
            .and_then(|raw| {
                serde_json::from_str::<Hello>(raw.get())
                    .map_err(|_| "hello 的答复不成形".to_string())
            })
            .and_then(|hello| match hello.protocol.as_u64() {
                Some(1) => Ok(hello),
                _ => Err(format!("运行器的协议是 {}，壳认 1", hello.protocol)),
            });
        if st.phase != Phase::Starting {
            return;
        }
        let hello = match hello {
            Ok(hello) => hello,
            Err(reason) => {
                // Ended here; its output ends and `on_end` takes it from there.
                st.ending = Some(reason);
                if let Some(live) = st.live.as_ref() {
                    lock(&live.process).kill();
                }
                return;
            }
        };
        if let Some(live) = st.live.as_mut() {
            live.up_since = Some(Instant::now());
        }
        st.remote = Some(
            hello
                .features
                .as_ref()
                .and_then(|f| f.get("remote"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
        st.phase = Phase::Up;
        self.changed.notify_all();
        let version = hello
            .version
            .as_ref()
            .and_then(Value::as_str)
            .map(|v| one_line(v).chars().take(64).collect::<String>())
            .unwrap_or_default();
        {
            let mut log = lock(&self.log);
            if let Some(dir) = hello.code_dir.as_ref().and_then(code_dir) {
                log.dir = Some(dir);
            }
            log.note(&format!(
                "runner up (generation {generation}, qmo {version})"
            ));
            log.flush();
        }
        self.watcher.send(&runner_event(true, None));
    }

    /// The runner's output ended: it is gone or going.
    fn on_end(self: &Arc<Inner>, generation: u64) {
        let process = {
            let st = lock(&self.state);
            match st.live.as_ref() {
                Some(live) if live.generation == generation => live.process.clone(),
                _ => return,
            }
        };
        let started = Instant::now();
        let status = loop {
            if let Some(status) = lock(&process).ended() {
                break status;
            }
            if started.elapsed() >= self.timing.reap {
                lock(&process).kill();
                break "它关了输出，被结束".to_string();
            }
            thread::sleep(Duration::from_millis(10));
        };
        let mut st = lock(&self.state);
        if st.generation != generation {
            return;
        }
        let Some(live) = st.live.take() else { return };
        let reason = st
            .ending
            .take()
            .unwrap_or_else(|| format!("运行器退出了（{status}）"));
        let stopping = st.phase == Phase::Stopped;
        let refusal = if stopping {
            Refusal::runner("Qmo 正在退出")
        } else {
            Refusal::runner(reason.clone())
        };
        let ids: Vec<u64> = st
            .pending
            .iter()
            .filter(|(_, (asked_of, _))| *asked_of == generation)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some((_, waiter)) = st.pending.remove(&id) {
                let _ = waiter.send(Err(refusal.clone()));
            }
        }
        if stopping {
            self.changed.notify_all();
            return;
        }
        if live
            .up_since
            .is_some_and(|since| since.elapsed() >= self.timing.steady)
        {
            st.failures = 0;
        }
        let was_up = live.up_since.is_some();
        Inner::wait_to_restart(self, &mut st, was_up, &reason);
        lock(&self.log).flush();
    }

    /// The runner's standard error, into the kept tail.
    fn read_log(self: Arc<Inner>, mut errors: Box<dyn Read + Send>) {
        let mut chunk = [0u8; 8192];
        loop {
            match errors.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let mut log = lock(&self.log);
                    log.append(&chunk[..n]);
                    log.flush();
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    }
}

/// The runner's `codeDir`: an absolute path to a directory that exists.
fn code_dir(value: &Value) -> Option<PathBuf> {
    let path = PathBuf::from(value.as_str()?);
    (path.is_absolute() && path.is_dir()).then_some(path)
}

// ---- the folder picker --------------------------------------------------

/// The folder a person picked, as the runner gets it (§4.5.3): its real
/// path, which has to be a directory this user can read. Whether it is one
/// of the agents' own directories is the runner's to say (`E_FOLDER`), from
/// the same list the rest of `qmo` uses.
pub fn picked_folder(path: &Path) -> Result<String, Refusal> {
    let real = std::fs::canonicalize(path)
        .map_err(|e| Refusal::new("E_FOLDER", format!("读不了这个文件夹：{e}")))?;
    if !real.is_dir() {
        return Err(Refusal::new("E_FOLDER", "选中的不是文件夹"));
    }
    std::fs::read_dir(&real)
        .map_err(|e| Refusal::new("E_FOLDER", format!("读不了这个文件夹：{e}")))?;
    let text = real
        .to_str()
        .ok_or_else(|| Refusal::new("E_FOLDER", "文件夹的路径不是 UTF-8"))?;
    Ok(plain_path(text).to_string())
}

/// Windows' `canonicalize` gives `\\?\C:\…`; the runner gets `C:\…` (or
/// `\\server\share\…` for `\\?\UNC\…`).
#[cfg(windows)]
fn plain_path(path: &str) -> std::borrow::Cow<'_, str> {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}").into();
    }
    match path.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.into(),
        _ => path.into(),
    }
}

#[cfg(not(windows))]
fn plain_path(path: &str) -> &str {
    path
}

/// One folder picker at a time.
#[derive(Default)]
pub struct Picker {
    open: Mutex<bool>,
}

/// While a picker is up.
pub struct Open<'a>(&'a Picker);

impl Drop for Open<'_> {
    fn drop(&mut self) {
        *lock(&self.0.open) = false;
    }
}

impl Picker {
    pub fn open(&self) -> Result<Open<'_>, Refusal> {
        let mut open = lock(&self.open);
        if *open {
            return Err(Refusal::new("E_BUSY", "选择框已经开着"));
        }
        *open = true;
        Ok(Open(self))
    }
}

/// The shell's local-session state.
pub struct Code {
    pub runner: Runner,
    pub picker: Picker,
}

impl Code {
    pub fn new() -> Code {
        Code {
            runner: Runner::new(Box::new(launch_qmo), Timing::default()),
            picker: Picker::default(),
        }
    }
}

/// The main window started loading a page: the old page's channel goes.
pub fn forget_watcher<R: Runtime>(app: &AppHandle<R>) {
    if let Some(code) = app.try_state::<Code>() {
        code.runner.watcher().forget();
    }
}

/// Quitting: see `Runner::shutdown`.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Some(code) = app.try_state::<Code>() {
        code.runner.shutdown();
    }
}

// ---- the dialog plugin, without its page script ---------------------------

/// `tauri-plugin-dialog` for its Rust picker only. The plugin's own script,
/// which it would add to every page, swaps `window.alert` and
/// `window.confirm` for its commands; no page is granted those, and a
/// `confirm` that returns a promise reads as yes where a page calls it
/// synchronously. This wrapper leaves the script out and passes the rest on.
pub struct Quiet<R: Runtime>(pub TauriPlugin<R>);

impl<R: Runtime> Plugin<R> for Quiet<R> {
    fn name(&self) -> &'static str {
        self.0.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }

    /// None; `initialization_script_2`, which the webviews read, defaults
    /// to this.
    fn initialization_script(&self) -> Option<String> {
        None
    }

    fn window_created(&mut self, window: Window<R>) {
        self.0.window_created(window)
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        self.0.webview_created(webview)
    }

    fn on_navigation(&mut self, webview: &Webview<R>, url: &Url) -> bool {
        self.0.on_navigation(webview, url)
    }

    fn on_page_load(
        &mut self,
        webview: &Webview<R>,
        payload: &tauri::webview::PageLoadPayload<'_>,
    ) {
        self.0.on_page_load(webview, payload)
    }

    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.0.on_event(app, event)
    }

    fn extend_api(&mut self, invoke: tauri::ipc::Invoke<R>) -> bool {
        self.0.extend_api(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::{PipeReader, PipeWriter},
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use tauri::ipc::InvokeResponseBody;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn quick() -> Timing {
        Timing {
            hello: ms(400),
            call: ms(1500),
            backoff: vec![ms(40), ms(80), ms(160)],
            steady: Duration::from_secs(60),
            shutdown_answer: ms(300),
            shutdown_exit: ms(700),
            reap: ms(300),
        }
    }

    /// Spin (briefly) until `ok`.
    fn until(what: &str, ok: impl Fn() -> bool) {
        let started = Instant::now();
        while !ok() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timed out waiting: {what}"
            );
            thread::sleep(ms(2));
        }
    }

    /// One fake runner process: its two output pipes and how it ended.
    struct Life {
        out: Mutex<Option<PipeWriter>>,
        err: Mutex<Option<PipeWriter>>,
        ended: Mutex<Option<String>>,
    }

    impl Life {
        fn close(&self, how: &str) {
            lock(&self.out).take();
            lock(&self.err).take();
            lock(&self.ended).get_or_insert_with(|| how.to_string());
        }

        fn line(&self, text: &str) -> bool {
            match lock(&self.out).as_mut() {
                Some(out) => out.write_all(format!("{text}\n").as_bytes()).is_ok(),
                None => false,
            }
        }

        fn send(&self, value: &Value) -> bool {
            self.line(&value.to_string())
        }

        fn log(&self, text: &str) {
            if let Some(err) = lock(&self.err).as_mut() {
                let _ = err.write_all(text.as_bytes());
            }
        }

        fn ended(&self) -> Option<String> {
            lock(&self.ended).clone()
        }
    }

    struct FakeProcess(Arc<Life>);

    impl Process for FakeProcess {
        fn ended(&mut self) -> Option<String> {
            self.0.ended()
        }

        fn kill(&mut self) {
            self.0.close("killed");
        }
    }

    /// What the fake does with one request.
    enum Act {
        Answer(Value),
        Silent,
        Exit,
    }

    type Handler = dyn Fn(&Value, &Life) -> Act + Send + Sync;

    #[derive(Default)]
    struct Fake {
        launches: Mutex<Vec<Instant>>,
        seen: Mutex<Vec<Value>>,
        lives: Mutex<Vec<Arc<Life>>>,
        /// Stays up when its input ends.
        stubborn: AtomicBool,
        /// Fails this many launches first.
        refuse: AtomicUsize,
    }

    impl Fake {
        fn launches(&self) -> usize {
            lock(&self.launches).len()
        }

        fn methods(&self) -> Vec<String> {
            lock(&self.seen)
                .iter()
                .map(|r| r["method"].as_str().unwrap_or("").to_string())
                .collect()
        }

        fn life(&self, n: usize) -> Arc<Life> {
            lock(&self.lives)[n].clone()
        }
    }

    fn hello_answer(id: &Value, code_dir: Option<&Path>) -> Act {
        let mut result = json!({
            "version": "0.0.0-test",
            "protocol": 1,
            "features": {"protocols": ["claude-stream"], "worktree": false, "remote": true},
        });
        if let Some(dir) = code_dir {
            result["codeDir"] = json!(dir.to_str().unwrap());
        }
        Act::Answer(json!({"id": id, "result": result}))
    }

    /// A launcher for a fake runner that answers `hello` and hands every
    /// other request to `handler`.
    fn fake(handler: impl Fn(&Value, &Life) -> Act + Send + Sync + 'static) -> (Launch, Arc<Fake>) {
        let fake = Arc::new(Fake::default());
        let handler: Arc<Handler> = Arc::new(move |request, life| {
            if request["method"] == "hello" {
                return hello_answer(&request["id"], None);
            }
            handler(request, life)
        });
        (launcher(fake.clone(), handler), fake)
    }

    fn launcher(fake: Arc<Fake>, handler: Arc<Handler>) -> Launch {
        Box::new(move || {
            lock(&fake.launches).push(Instant::now());
            if fake.refuse.load(Ordering::SeqCst) > 0 {
                fake.refuse.fetch_sub(1, Ordering::SeqCst);
                return Err(io::Error::new(io::ErrorKind::NotFound, "no qmo here"));
            }
            let (input_rx, input_tx): (PipeReader, PipeWriter) = io::pipe()?;
            let (output_rx, output_tx) = io::pipe()?;
            let (errors_rx, errors_tx) = io::pipe()?;
            let life = Arc::new(Life {
                out: Mutex::new(Some(output_tx)),
                err: Mutex::new(Some(errors_tx)),
                ended: Mutex::new(None),
            });
            lock(&fake.lives).push(life.clone());
            let (fake, handler, running) = (fake.clone(), handler.clone(), life.clone());
            thread::spawn(move || {
                let mut lines = BufReader::new(input_rx).lines();
                while let Some(Ok(line)) = lines.next() {
                    let request: Value = serde_json::from_str(&line).expect("a request is JSON");
                    lock(&fake.seen).push(request.clone());
                    if running.ended().is_some() {
                        continue;
                    }
                    match handler(&request, &running) {
                        Act::Answer(answer) => {
                            running.send(&answer);
                        }
                        Act::Silent => {}
                        Act::Exit => {
                            running.close("exit status: 3");
                        }
                    }
                }
                // Its input ended: the shell is gone or said goodbye.
                if !fake.stubborn.load(Ordering::SeqCst) {
                    running.close("exit status: 0");
                }
            });
            Ok(Pipes {
                input: Box::new(input_tx),
                output: Box::new(output_rx),
                errors: Box::new(errors_rx),
                process: Box::new(FakeProcess(life)),
            })
        })
    }

    /// An answer that repeats the request.
    fn echo(request: &Value) -> Act {
        Act::Answer(json!({
            "id": request["id"],
            "result": {"method": request["method"], "params": request["params"]},
        }))
    }

    fn capture() -> (Channel<Box<RawValue>>, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(text) = body {
                lock(&sink).push(text);
            }
            Ok(())
        });
        (channel, seen)
    }

    fn events(seen: &Mutex<Vec<String>>) -> Vec<Value> {
        lock(seen)
            .iter()
            .map(|text| serde_json::from_str(text).unwrap())
            .collect()
    }

    fn runner_states(seen: &Mutex<Vec<String>>) -> Vec<String> {
        events(seen)
            .into_iter()
            .filter(|e| e["type"] == "runner")
            .map(|e| e["state"].as_str().unwrap().to_string())
            .collect()
    }

    fn value(raw: impl AsRef<RawValue>) -> Value {
        serde_json::from_str(raw.as_ref().get()).unwrap()
    }

    #[test]
    fn the_first_call_starts_it_with_hello_and_answers_pair_by_id() {
        let (launch, fake) = fake(|request, _| echo(request));
        let runner = Runner::new(launch, quick());
        assert_eq!(runner.phase(), Phase::Idle);
        assert_eq!(fake.launches(), 0, "started on demand, not before");
        let answer = runner.call("list", json!({})).unwrap();
        assert_eq!(value(answer), json!({"method": "list", "params": {}}));
        assert_eq!(runner.phase(), Phase::Up);
        assert_eq!(fake.methods(), ["hello", "list"]);
        let seen = lock(&fake.seen).clone();
        assert_eq!(seen[0], json!({"id": 1, "method": "hello", "params": {}}));
        assert_eq!(seen[1], json!({"id": 2, "method": "list", "params": {}}));
        // Requests are exactly {id, method, params}, the params as given.
        let params = json!({"session": "cs_AbCdEfGhIjKlMnOpQrSt_-", "text": "第一行\n第二行 \"引号\"", "clientId": "c", "origin": "local"});
        let answer = runner.call("session.send", params.clone()).unwrap();
        assert_eq!(value(answer)["params"], params);
        assert_eq!(lock(&fake.seen)[2]["params"], params);
        assert_eq!(fake.launches(), 1);
    }

    #[test]
    fn concurrent_calls_get_their_own_answers_whatever_the_order() {
        // Holds the first eight requests, then answers them last to first.
        let held = Arc::new(Mutex::new(Vec::<Value>::new()));
        let gate = held.clone();
        let (launch, _fake) = fake(move |request, life| {
            let mut held = lock(&gate);
            held.push(request.clone());
            if held.len() == 8 {
                for request in held.drain(..).rev() {
                    life.send(
                        &json!({"id": request["id"], "result": {"n": request["params"]["n"]}}),
                    );
                }
            }
            Act::Silent
        });
        let runner = Arc::new(Runner::new(launch, quick()));
        let calls: Vec<_> = (0..8)
            .map(|n| {
                let runner = runner.clone();
                thread::spawn(move || runner.call("session.read", json!({"n": n})))
            })
            .collect();
        for (n, call) in calls.into_iter().enumerate() {
            assert_eq!(value(call.join().unwrap().unwrap()), json!({"n": n}));
        }
        assert!(lock(&held).is_empty());
    }

    #[test]
    fn refusals_read_qmo_local_code_message() {
        let (launch, _fake) = fake(|request, life| {
            let id = &request["id"];
            match request["params"]["case"].as_str().unwrap() {
                "session" => Act::Answer(
                    json!({"id": id, "error": {"code": "E_SESSION", "message": "没有这个会话"}}),
                ),
                "odd code" => {
                    Act::Answer(json!({"id": id, "error": {"code": "boom", "message": "x"}}))
                }
                "long code" => Act::Answer(
                    json!({"id": id, "error": {"code": format!("E_{}", "A".repeat(40)), "message": "x"}}),
                ),
                "two lines" => Act::Answer(
                    json!({"id": id, "error": {"code": "E_GIT", "message": "第一行\n第二行\u{1b}[31m"}}),
                ),
                "no message" => Act::Answer(json!({"id": id, "error": {"code": "E_BUSY"}})),
                "not an object" => Act::Answer(json!({"id": id, "error": "nope"})),
                "both" => Act::Answer(
                    json!({"id": id, "result": {}, "error": {"code": "E_ASK", "message": "已经答过了"}}),
                ),
                "array" => Act::Answer(json!({"id": id, "result": [1]})),
                "null" => Act::Answer(json!({"id": id, "result": null})),
                "neither" => Act::Answer(json!({"id": id})),
                "long message" => Act::Answer(
                    json!({"id": id, "error": {"code": "E_LIMIT", "message": "字".repeat(900)}}),
                ),
                _ => {
                    life.line("{");
                    Act::Silent
                }
            }
        });
        let runner = Runner::new(launch, quick());
        let refused = |case: &str| {
            runner
                .call("session.stop", json!({ "case": case }))
                .unwrap_err()
                .to_string()
        };
        assert_eq!(refused("session"), "qmo local E_SESSION: 没有这个会话");
        assert_eq!(refused("odd code"), "qmo local E_RUNNER: x");
        assert_eq!(refused("long code"), "qmo local E_RUNNER: x");
        assert_eq!(refused("two lines"), "qmo local E_GIT: 第一行 第二行 [31m");
        assert_eq!(
            refused("no message"),
            "qmo local E_BUSY: 运行器没有说明原因"
        );
        assert_eq!(
            refused("not an object"),
            "qmo local E_RUNNER: 运行器没有说明原因"
        );
        assert_eq!(refused("both"), "qmo local E_ASK: 已经答过了");
        for case in ["array", "null", "neither"] {
            assert_eq!(
                refused(case),
                "qmo local E_RUNNER: 运行器的答复不成形",
                "{case}"
            );
        }
        let long = refused("long message");
        assert_eq!(
            long.chars().count(),
            "qmo local E_LIMIT: ".chars().count() + 500
        );
        // A line that is not JSON answers nothing: the call gives up.
        let started = Instant::now();
        assert_eq!(refused("broken"), "qmo local E_RUNNER: 运行器 1 秒没有答复");
        assert!(started.elapsed() >= ms(1500));
    }

    #[test]
    fn events_reach_the_channel_in_order_as_written() {
        let (launch, _fake) = fake(|request, life| {
            for n in 0..200 {
                // Key order and spacing as the runner wrote them.
                life.line(&format!(
                    r#"{{"method":"event","params":{{"v":1,"type":"delta","session":"cs_AbCdEfGhIjKlMnOpQrSt_-","turn":"t_1","offset":{n},"text":"字{n}"}}}}"#
                ));
            }
            echo(request)
        });
        let runner = Runner::new(launch, quick());
        let (channel, seen) = capture();
        runner.watcher().watch(channel);
        runner.call("session.send", json!({})).unwrap();
        until("201 events", || lock(&seen).len() == 201);
        let seen = lock(&seen).clone();
        assert_eq!(seen[0], r#"{"v":1,"type":"runner","state":"up"}"#);
        for (n, text) in seen[1..].iter().enumerate() {
            assert_eq!(
                text,
                &format!(
                    r#"{{"v":1,"type":"delta","session":"cs_AbCdEfGhIjKlMnOpQrSt_-","turn":"t_1","offset":{n},"text":"字{n}"}}"#
                )
            );
        }
    }

    #[test]
    fn noise_on_the_output_is_dropped_and_answers_still_arrive() {
        let (launch, _fake) = fake(|request, life| {
            life.line("not json");
            life.line("");
            life.line(r#"{"result":{}}"#);
            life.line(r#"{"id":0,"result":{}}"#);
            life.line(r#"{"id":-1,"result":{}}"#);
            life.line(r#"{"id":"2","result":{}}"#);
            life.line(r#"{"id":99999,"result":{}}"#);
            life.line(r#"{"method":"event","params":"text"}"#);
            life.line(r#"{"method":"event","params":[1,2]}"#);
            life.line(r#"{"method":"event"}"#);
            life.line(r#"{"method":"other","params":{"v":1}}"#);
            echo(request)
        });
        let runner = Runner::new(launch, quick());
        let (channel, seen) = capture();
        runner.watcher().watch(channel);
        let answer = runner.call("list", json!({})).unwrap();
        assert_eq!(value(answer)["method"], "list");
        assert_eq!(runner_states(&seen), ["up"]);
        assert_eq!(events(&seen).len(), 1, "no bad event passed on");
        assert!(runner.log_text().contains("not the protocol"));
    }

    #[test]
    fn a_reloaded_page_loses_its_channel_until_it_watches_again() {
        let (launch, fake) = fake(|request, life| {
            life.send(&json!({"method": "event", "params": {"v": 1, "type": "activity", "n": request["params"]["n"]}}));
            echo(request)
        });
        let runner = Runner::new(launch, quick());
        let (first, first_seen) = capture();
        runner.watcher().watch(first);
        runner.call("ping", json!({"n": 1})).unwrap();
        until("first event", || events(&first_seen).len() == 2);
        // The main window starts loading a page: its channel goes.
        runner.watcher().forget();
        runner.call("ping", json!({"n": 2})).unwrap();
        // The new page registers its own.
        let (second, second_seen) = capture();
        runner.watcher().watch(second);
        runner.call("ping", json!({"n": 3})).unwrap();
        until("third event", || events(&second_seen).len() == 1);
        assert_eq!(events(&first_seen)[1]["n"], 1);
        assert_eq!(events(&first_seen).len(), 2, "nothing after the reload");
        assert_eq!(events(&second_seen)[0]["n"], 3, "n = 2 went to no page");
        // Watching again replaces the channel rather than adding one.
        let (third, third_seen) = capture();
        runner.watcher().watch(third);
        runner.call("ping", json!({"n": 4})).unwrap();
        until("fourth event", || events(&third_seen).len() == 1);
        assert_eq!(events(&second_seen).len(), 1);
        assert_eq!(fake.launches(), 1);
    }

    #[test]
    fn the_shell_sees_each_event_and_the_runner_going_down() {
        let (launch, _fake) = fake(|request, life| {
            if request["method"] == "die" {
                return Act::Exit;
            }
            life.send(&json!({"method": "event", "params": {"v": 1, "type": "session", "n": request["params"]["n"]}}));
            echo(request)
        });
        let runner = Runner::new(launch, quick());
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        runner.tap(move |what| {
            lock(&sink).push(match what {
                Seen::Event(event) => event.get().to_string(),
                Seen::Down => "down".to_string(),
            })
        });
        // No page watching: the shell sees them all the same.
        assert!(!runner.watcher().watching());
        runner.call("ping", json!({"n": 1})).unwrap();
        runner.call("ping", json!({"n": 2})).unwrap();
        until("two events", || lock(&seen).len() == 2);
        assert!(runner.call("die", json!({})).is_err());
        until("down", || lock(&seen).len() == 3);
        let seen = lock(&seen).clone();
        assert_eq!(
            seen[2], "down",
            "the shell's own runner events are not the runner's"
        );
        for (n, event) in seen[..2].iter().enumerate() {
            let event: Value = serde_json::from_str(event).unwrap();
            assert_eq!(event, json!({"v": 1, "type": "session", "n": n + 1}));
        }
    }

    #[test]
    fn asking_if_up_never_starts_it_and_gives_up_on_time() {
        let (launch, fake) = fake(|request, _| match request["method"].as_str() {
            Some("hang") => Act::Silent,
            _ => echo(request),
        });
        let runner = Runner::new(launch, quick());
        assert!(runner.ask_if_up("list", json!({}), ms(200)).is_none());
        assert_eq!(fake.launches(), 0, "not started for a question");
        assert_eq!(runner.remote_supported(), None, "never up");
        runner.call("list", json!({})).unwrap();
        assert_eq!(runner.remote_supported(), Some(false), "from hello");
        let answer = runner
            .ask_if_up("list", json!({}), ms(200))
            .unwrap()
            .unwrap();
        assert_eq!(value(answer)["method"], "list");
        let started = Instant::now();
        let late = runner.ask_if_up("hang", json!({}), ms(200)).unwrap();
        assert!(late.is_err());
        assert!(started.elapsed() < ms(1000), "its own wait, not a call's");
        runner.shutdown();
        assert!(runner.ask_if_up("list", json!({}), ms(200)).is_none());
    }

    #[test]
    fn remote_is_what_hello_said() {
        let fake = Arc::new(Fake::default());
        let handler: Arc<Handler> = Arc::new(|request, _| {
            if request["method"] == "hello" {
                return Act::Answer(json!({"id": request["id"], "result": {
                    "protocol": 1,
                    "features": {"remote": true},
                }}));
            }
            echo(request)
        });
        let runner = Runner::new(launcher(fake, handler), quick());
        runner.call("list", json!({})).unwrap();
        assert_eq!(runner.remote_supported(), Some(true));
    }

    #[test]
    fn the_list_gets_the_shells_defaults() {
        let raw = |text: &str| RawValue::from_string(text.to_string()).unwrap();
        let answer = with_defaults(
            raw(
                r#"{"v":1,"features":{"remote":false},"folders":[],"sessions":[],"defaults":{"mode":"off"}}"#,
            ),
            "accept-edits",
            true,
        );
        let answer = value(answer);
        assert_eq!(
            answer["defaults"],
            json!({"mode": "accept-edits", "remote": true})
        );
        assert_eq!(answer["features"], json!({"remote": false}));
        assert_eq!(answer["v"], 1);
        // What is not an object goes through as it is.
        assert_eq!(with_defaults(raw("[1]"), "auto", false).get(), "[1]");
    }

    #[test]
    fn the_open_event_goes_to_the_page_watching_only() {
        let watcher = Watcher::default();
        assert!(!watcher.watching());
        assert!(!watcher.tell(&open_event("cs_AbCdEfGhIjKlMnOpQrSt_-")));
        let (channel, seen) = capture();
        watcher.watch(channel);
        assert!(watcher.watching());
        assert!(watcher.tell(&open_event("cs_AbCdEfGhIjKlMnOpQrSt_-")));
        assert_eq!(
            events(&seen),
            [json!({"v": 1, "type": "open", "session": "cs_AbCdEfGhIjKlMnOpQrSt_-"})]
        );
        watcher.forget();
        assert!(!watcher.watching());
    }

    #[test]
    fn a_runner_that_ends_turns_down_what_it_owed_and_comes_back() {
        let (launch, fake) = fake(|request, _| match request["method"].as_str() {
            Some("hang") => Act::Silent,
            Some("die") => Act::Exit,
            _ => echo(request),
        });
        let runner = Arc::new(Runner::new(launch, quick()));
        let (channel, seen) = capture();
        runner.watcher().watch(channel);
        runner.call("list", json!({})).unwrap();
        let hanging: Vec<_> = (0..3)
            .map(|_| {
                let runner = runner.clone();
                thread::spawn(move || runner.call("hang", json!({})))
            })
            .collect();
        until("three hanging", || {
            fake.methods().iter().filter(|m| *m == "hang").count() == 3
        });
        let died = runner.call("die", json!({})).unwrap_err();
        assert_eq!(died.code, "E_RUNNER");
        assert!(died.message.contains("exit status: 3"), "{died}");
        for call in hanging {
            let refused = call.join().unwrap().unwrap_err().to_string();
            assert!(
                refused.starts_with("qmo local E_RUNNER: 运行器退出了"),
                "{refused}"
            );
        }
        until("started again", || {
            runner.phase() == Phase::Up && fake.launches() == 2
        });
        let back = runner.call("list", json!({})).unwrap();
        assert_eq!(value(back)["method"], "list");
        let states = runner_states(&seen);
        assert_eq!(states, ["up", "down", "up"]);
        let down = events(&seen)
            .into_iter()
            .find(|e| e["state"] == "down")
            .unwrap();
        assert_eq!(down["v"], 1);
        assert!(down["reason"].as_str().unwrap().contains("exit status: 3"));
        // Each start says hello first.
        let methods = fake.methods();
        assert_eq!(methods.iter().filter(|m| *m == "hello").count(), 2);
    }

    #[test]
    fn calls_while_it_is_down_are_turned_down_at_once() {
        let (launch, fake) = fake(|request, _| match request["method"].as_str() {
            Some("die") => Act::Exit,
            _ => echo(request),
        });
        let timing = Timing {
            backoff: vec![Duration::from_secs(5)],
            ..quick()
        };
        let runner = Runner::new(launch, timing);
        runner.call("list", json!({})).unwrap();
        let _ = runner.call("die", json!({}));
        until("down", || matches!(runner.phase(), Phase::Waiting { .. }));
        let started = Instant::now();
        let refused = runner.call("list", json!({})).unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(refused.code, "E_RUNNER");
        assert!(
            refused.message.starts_with("运行器不在（运行器退出了"),
            "{refused}"
        );
        assert!(refused.message.ends_with("5 秒后重起"), "{refused}");
        assert_eq!(fake.launches(), 1, "not started early");
    }

    #[test]
    fn starts_back_off_and_say_down_once_per_outage() {
        // Every runner after the first ends as soon as it is asked anything.
        let first = Arc::new(AtomicBool::new(true));
        let (launch, fake) = {
            let fake = Arc::new(Fake::default());
            let first = first.clone();
            let handler: Arc<Handler> = Arc::new(move |request, _| {
                if first.load(Ordering::SeqCst) {
                    if request["method"] == "hello" {
                        return hello_answer(&request["id"], None);
                    }
                    if request["method"] == "die" {
                        first.store(false, Ordering::SeqCst);
                        return Act::Exit;
                    }
                    return echo(request);
                }
                Act::Exit
            });
            (launcher(fake.clone(), handler), fake)
        };
        let runner = Runner::new(launch, quick());
        let (channel, seen) = capture();
        runner.watcher().watch(channel);
        runner.call("list", json!({})).unwrap();
        let _ = runner.call("die", json!({}));
        until("five launches", || fake.launches() >= 5);
        let launches = lock(&fake.launches).clone();
        let gaps: Vec<Duration> = launches.windows(2).map(|w| w[1] - w[0]).collect();
        // 40, 80, 160, then 160 ms again (the last step repeats); each gap
        // also holds the time the failed runner took to end.
        for (gap, least) in gaps.iter().zip([40, 80, 160, 160]) {
            assert!(*gap >= ms(least), "{gaps:?}");
        }
        // Up, down when it ended, and no more downs while it keeps failing.
        assert_eq!(runner_states(&seen), ["up", "down"]);
    }

    #[test]
    fn a_runner_that_does_not_say_hello_in_time_is_ended() {
        let fake = Arc::new(Fake::default());
        let handler: Arc<Handler> = Arc::new(|_, _| Act::Silent);
        let runner = Runner::new(launcher(fake.clone(), handler), quick());
        let started = Instant::now();
        let refused = runner.call("list", json!({})).unwrap_err();
        let took = started.elapsed();
        assert_eq!(refused.code, "E_RUNNER");
        assert!(refused.message.contains("hello"), "{refused}");
        assert!(took >= ms(400) && took < Duration::from_secs(3), "{took:?}");
        assert_eq!(fake.life(0).ended().as_deref(), Some("killed"));
        assert!(runner.log_text().contains("hello"));
        assert_eq!(fake.methods(), ["hello"], "nothing else was sent to it");
    }

    #[test]
    fn a_runner_of_another_protocol_is_ended() {
        for answer in [
            json!({"version": "9", "protocol": 2, "features": {}}),
            json!({"version": "9", "protocol": "1"}),
            json!({"version": "9"}),
        ] {
            let fake = Arc::new(Fake::default());
            let reply = answer.clone();
            let handler: Arc<Handler> = Arc::new(move |request, _| {
                Act::Answer(json!({"id": request["id"], "result": reply}))
            });
            let runner = Runner::new(launcher(fake.clone(), handler), quick());
            let refused = runner.call("list", json!({})).unwrap_err();
            assert_eq!(refused.code, "E_RUNNER", "{answer}");
            assert_eq!(fake.life(0).ended().as_deref(), Some("killed"), "{answer}");
            assert_eq!(fake.methods(), ["hello"], "{answer}");
        }
    }

    #[test]
    fn a_call_without_an_answer_gives_up_and_leaves_the_runner() {
        let late = Arc::new(Mutex::new(None::<Value>));
        let keep = late.clone();
        let (launch, fake) = fake(move |request, life| {
            if request["method"] == "slow" {
                *lock(&keep) = Some(request["id"].clone());
                return Act::Silent;
            }
            if request["method"] == "late" {
                // Answers the slow one after it gave up, then this one.
                let id = lock(&keep).clone().unwrap();
                life.send(&json!({"id": id, "result": {"late": true}}));
            }
            echo(request)
        });
        let runner = Runner::new(launch, quick());
        let refused = runner.call("slow", json!({})).unwrap_err();
        assert_eq!(
            refused.to_string(),
            "qmo local E_RUNNER: 运行器 1 秒没有答复"
        );
        let answer = runner.call("late", json!({})).unwrap();
        assert_eq!(value(answer)["method"], "late");
        assert_eq!(fake.launches(), 1);
        assert_eq!(runner.phase(), Phase::Up);
    }

    #[test]
    fn a_launch_that_fails_is_tried_again() {
        let (launch, fake) = fake(|request, _| echo(request));
        fake.refuse.store(1, Ordering::SeqCst);
        let runner = Runner::new(launch, quick());
        let (channel, seen) = capture();
        runner.watcher().watch(channel);
        let refused = runner.call("list", json!({})).unwrap_err();
        assert_eq!(refused.code, "E_RUNNER");
        assert!(refused.message.contains("没起来"), "{refused}");
        until("up on the second try", || runner.phase() == Phase::Up);
        assert_eq!(fake.launches(), 2);
        assert_eq!(runner_states(&seen), ["down", "up"]);
        runner.call("list", json!({})).unwrap();
    }

    #[test]
    fn shutdown_asks_and_the_runner_goes() {
        let (launch, fake) = fake(|request, _| {
            if request["method"] == "shutdown" {
                return Act::Answer(json!({"id": request["id"], "result": {}}));
            }
            echo(request)
        });
        let runner = Runner::new(launch, quick());
        let (channel, seen) = capture();
        runner.watcher().watch(channel);
        runner.call("list", json!({})).unwrap();
        let started = Instant::now();
        runner.shutdown();
        assert!(started.elapsed() < ms(700), "{:?}", started.elapsed());
        assert_eq!(fake.methods(), ["hello", "list", "shutdown"]);
        assert_eq!(fake.life(0).ended().as_deref(), Some("exit status: 0"));
        assert_eq!(runner.phase(), Phase::Stopped);
        // Never started again, and nothing more to say to the page.
        let refused = runner.call("list", json!({})).unwrap_err();
        assert_eq!(refused.to_string(), "qmo local E_RUNNER: Qmo 正在退出");
        thread::sleep(ms(200));
        assert_eq!(fake.launches(), 1);
        assert_eq!(runner_states(&seen), ["up"]);
    }

    #[test]
    fn shutdown_ends_a_runner_that_stays() {
        // Ignores `shutdown` and stays when its input ends.
        let (launch, fake) = fake(|request, _| match request["method"].as_str() {
            Some("shutdown") => Act::Silent,
            _ => echo(request),
        });
        fake.stubborn.store(true, Ordering::SeqCst);
        let runner = Runner::new(launch, quick());
        runner.call("list", json!({})).unwrap();
        let started = Instant::now();
        runner.shutdown();
        let took = started.elapsed();
        assert!(took >= ms(700) && took < Duration::from_secs(3), "{took:?}");
        assert_eq!(fake.life(0).ended().as_deref(), Some("killed"));
        assert!(runner.log_text().contains("did not stop in time"));
    }

    #[test]
    fn shutdown_closes_the_input_for_a_runner_that_missed_it() {
        // Does not answer `shutdown`, but goes when its input ends.
        let (launch, fake) = fake(|request, _| match request["method"].as_str() {
            Some("shutdown") => Act::Silent,
            _ => echo(request),
        });
        let runner = Runner::new(launch, quick());
        runner.call("list", json!({})).unwrap();
        let started = Instant::now();
        runner.shutdown();
        let took = started.elapsed();
        assert!(took >= ms(300) && took < ms(700), "{took:?}");
        assert_eq!(fake.life(0).ended().as_deref(), Some("exit status: 0"));
    }

    #[test]
    fn shutdown_before_any_start_does_nothing() {
        let (launch, fake) = fake(|request, _| echo(request));
        let runner = Runner::new(launch, quick());
        runner.shutdown();
        assert_eq!(fake.launches(), 0);
        assert!(runner.call("list", json!({})).is_err());
        assert_eq!(fake.launches(), 0);
    }

    #[test]
    fn calls_in_flight_at_shutdown_are_turned_down() {
        let (launch, fake) = fake(|request, _| match request["method"].as_str() {
            Some("hang") => Act::Silent,
            _ => echo(request),
        });
        let runner = Arc::new(Runner::new(launch, quick()));
        runner.call("list", json!({})).unwrap();
        let hanging = {
            let runner = runner.clone();
            thread::spawn(move || runner.call("hang", json!({})))
        };
        until("hanging", || fake.methods().contains(&"hang".to_string()));
        runner.shutdown();
        assert_eq!(
            hanging.join().unwrap().unwrap_err().to_string(),
            "qmo local E_RUNNER: Qmo 正在退出"
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qmo-code-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_log_keeps_the_last_64_kib_in_the_runners_code_dir() {
        let dir = scratch("log");
        let fake = Arc::new(Fake::default());
        let code_dir = dir.clone();
        let handler: Arc<Handler> = Arc::new(move |request, life| {
            if request["method"] == "hello" {
                life.log("starting\n");
                return hello_answer(&request["id"], Some(&code_dir));
            }
            if request["method"] == "shutdown" {
                return Act::Answer(json!({"id": request["id"], "result": {}}));
            }
            for n in 0..2000 {
                life.log(&format!("line {n:04} {}\n", "x".repeat(60)));
            }
            echo(request)
        });
        let runner = Runner::new(launcher(fake.clone(), handler), quick());
        runner.call("list", json!({})).unwrap();
        let log = dir.join("runner.log");
        until("the last line", || {
            std::fs::read_to_string(&log).is_ok_and(|text| text.contains("line 1999"))
        });
        runner.shutdown();
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.len() <= LOG_MAX, "{}", text.len());
        assert!(text.len() > LOG_MAX - 200, "{}", text.len());
        assert!(!text.contains("starting"), "the head is gone");
        assert!(!text.contains("line 0000"));
        assert!(
            text.starts_with("line ") || text.starts_with('['),
            "a whole line first"
        );
        assert!(text.contains("runner stopped"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&log).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // Only the log: the shell writes nothing else there.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["runner.log"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_code_dir_that_is_not_one_is_not_used() {
        let dir = scratch("not-dir");
        let file = dir.join("file");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(code_dir(&json!(dir.to_str().unwrap())), Some(dir.clone()));
        for bad in [
            json!(file.to_str().unwrap()),
            json!("relative/code"),
            json!(dir.join("missing").to_str().unwrap()),
            json!(7),
            Value::Null,
        ] {
            assert_eq!(code_dir(&bad), None, "{bad}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lines_over_the_limit_are_skipped_and_a_cut_line_is_none() {
        let text = format!(
            "{}\nshort\n{}\nlast-no-newline",
            "x".repeat(50),
            "y".repeat(10)
        );
        let mut reader = BufReader::with_capacity(8, text.as_bytes());
        let mut line = Vec::new();
        assert_eq!(next_line(&mut reader, 16, &mut line).unwrap(), Some(false));
        assert_eq!(next_line(&mut reader, 16, &mut line).unwrap(), Some(true));
        assert_eq!(line, b"short");
        assert_eq!(next_line(&mut reader, 16, &mut line).unwrap(), Some(true));
        assert_eq!(line, "y".repeat(10).as_bytes());
        assert_eq!(next_line(&mut reader, 16, &mut line).unwrap(), None);
    }

    #[test]
    fn the_shells_own_events_have_their_shape() {
        assert_eq!(
            runner_event(true, None).get(),
            r#"{"v":1,"type":"runner","state":"up"}"#
        );
        assert_eq!(
            runner_event(false, Some("退出了（\"x\"）")).get(),
            r#"{"v":1,"type":"runner","state":"down","reason":"退出了（\"x\"）"}"#
        );
        assert_eq!(
            Refusal::from(Invalid("text is empty".into())).to_string(),
            "qmo local E_ARGS: text is empty"
        );
    }

    #[test]
    fn the_time_reads_as_utc() {
        let now = utc_now();
        assert_eq!(now.len(), 20, "{now}");
        assert!(
            now.starts_with("20") && now.ends_with('Z') && now.as_bytes()[10] == b'T',
            "{now}"
        );
    }

    #[test]
    fn one_picker_at_a_time() {
        let picker = Picker::default();
        let open = picker.open().unwrap();
        assert_eq!(
            picker.open().err().unwrap().to_string(),
            "qmo local E_BUSY: 选择框已经开着"
        );
        drop(open);
        assert!(picker.open().is_ok());
    }

    #[test]
    fn a_picked_folder_goes_on_as_its_real_path() {
        let dir = scratch("picked");
        let real = dir.join("project");
        std::fs::create_dir_all(&real).unwrap();
        let canonical = std::fs::canonicalize(&real).unwrap();
        assert_eq!(picked_folder(&real).unwrap(), canonical.to_str().unwrap());
        // Through `..` and through a link, the same folder.
        assert_eq!(
            picked_folder(&real.join("..").join("project")).unwrap(),
            canonical.to_str().unwrap()
        );
        #[cfg(unix)]
        {
            let link = dir.join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(picked_folder(&link).unwrap(), canonical.to_str().unwrap());
        }
        let file = dir.join("file.txt");
        std::fs::write(&file, b"x").unwrap();
        for bad in [file, dir.join("missing")] {
            assert_eq!(picked_folder(&bad).unwrap_err().code, "E_FOLDER", "{bad:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A runner that is a real process (`/bin/sh`), for the pipes and the
    /// process handle `launch_qmo` uses: it says hello, answers, logs, exits
    /// with a status on `crash` and goes on `shutdown`.
    #[cfg(unix)]
    const SH_RUNNER: &str = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/^[{]"id":([0-9]+),.*/\1/')
  case "$line" in
    *'"method":"hello"'*) printf '{"id":%s,"result":{"version":"sh","protocol":1,"features":{}}}\n' "$id" ;;
    *'"method":"shutdown"'*) printf '{"id":%s,"result":{}}\n' "$id"; exit 0 ;;
    *'"method":"crash"'*) echo "about to crash" >&2; exit 7 ;;
    *) printf '{"method":"event","params":{"v":1,"type":"activity","id":%s}}\n' "$id"
       printf '{"id":%s,"result":{"ok":true}}\n' "$id" ;;
  esac
done
"#;

    #[cfg(unix)]
    #[test]
    fn a_real_child_process_runs_restarts_and_shuts_down() {
        let launches = Arc::new(AtomicUsize::new(0));
        let counted = launches.clone();
        let launch: Launch = Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let mut command = Command::new("/bin/sh");
            command.args(["-c", SH_RUNNER]);
            spawn(command)
        });
        // A real process: room to start on a busy machine.
        let timing = Timing {
            hello: Duration::from_secs(5),
            call: Duration::from_secs(10),
            shutdown_answer: Duration::from_secs(3),
            shutdown_exit: Duration::from_secs(5),
            ..quick()
        };
        let runner = Runner::new(launch, timing);
        let (channel, seen) = capture();
        runner.watcher().watch(channel);
        assert_eq!(
            value(runner.call("list", json!({})).unwrap()),
            json!({"ok": true})
        );
        until("the event", || events(&seen).len() == 2);
        assert_eq!(
            events(&seen)[1],
            json!({"v": 1, "type": "activity", "id": 2})
        );
        let crashed = runner.call("crash", json!({})).unwrap_err();
        assert_eq!(
            crashed.to_string(),
            "qmo local E_RUNNER: 运行器退出了（exit status: 7）"
        );
        assert!(runner.log_text().contains("about to crash"));
        until("back up", || runner.phase() == Phase::Up);
        assert_eq!(launches.load(Ordering::SeqCst), 2);
        assert_eq!(
            value(runner.call("list", json!({})).unwrap()),
            json!({"ok": true})
        );
        assert_eq!(runner_states(&seen), ["up", "down", "up"]);
        let started = Instant::now();
        runner.shutdown();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        assert!(runner.log_text().contains("runner stopped: exit status: 0"));
    }

    #[test]
    fn the_dialog_plugin_keeps_its_script_out_of_pages() {
        let plain = tauri_plugin_dialog::init::<tauri::Wry>();
        assert!(
            plain.initialization_script_2().is_some(),
            "the plugin as it comes adds a script to every page"
        );
        let quiet = Quiet(tauri_plugin_dialog::init::<tauri::Wry>());
        assert_eq!(quiet.name(), "dialog");
        assert!(quiet.initialization_script().is_none());
        assert!(quiet.initialization_script_2().is_none());
    }
}
