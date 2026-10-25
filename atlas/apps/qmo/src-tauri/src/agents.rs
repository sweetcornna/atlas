// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `qmo_local_agents`: the coding agents installed on this computer, as the
//! bundled `qmo agents --json` finds them (qmo-local.md §4.2). The shell only
//! runs it and passes its list on; finding them — stat, PATH, `--version`, no
//! agent started in a service or protocol mode — is `qmo`'s.
//!
//! One run at a time: a call that comes while one is out waits for that run's
//! answer instead of starting another. A rescan does not settle for a plain
//! run's answer; it waits for that run to end, then runs (or joins) a rescan.

use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::{qmo, sidecar};

/// How long `qmo agents` may take: a login shell asked for its PATH (at most
/// 5 s on a rescan), then the agents looked at side by side, each
/// `--version` at most 10 s.
pub const TIMEOUT: Duration = Duration::from_secs(30);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// One run, and everyone waiting for it.
struct Slot<T> {
    rescan: bool,
    answer: Mutex<Option<Result<T, String>>>,
    ready: Condvar,
    #[cfg(test)]
    waiting: std::sync::atomic::AtomicUsize,
}

impl<T: Clone> Slot<T> {
    fn new(rescan: bool) -> Slot<T> {
        Slot {
            rescan,
            answer: Mutex::new(None),
            ready: Condvar::new(),
            #[cfg(test)]
            waiting: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn wait(&self) -> Result<T, String> {
        #[cfg(test)]
        self.waiting
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut answer = lock(&self.answer);
        loop {
            if let Some(answer) = answer.as_ref() {
                return answer.clone();
            }
            answer = self.ready.wait(answer).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn settle(&self, answer: Result<T, String>) {
        *lock(&self.answer) = Some(answer);
        self.ready.notify_all();
    }
}

/// At most one run of a job at a time; see the module comment.
pub struct Flight<T> {
    current: Mutex<Option<Arc<Slot<T>>>>,
}

impl<T> Default for Flight<T> {
    fn default() -> Flight<T> {
        Flight {
            current: Mutex::new(None),
        }
    }
}

/// The run this call leads: whatever happens to the job, the slot is cleared
/// and its waiters get an answer.
struct Lead<'a, T: Clone> {
    flight: &'a Flight<T>,
    slot: Arc<Slot<T>>,
    answer: Option<Result<T, String>>,
}

impl<T: Clone> Drop for Lead<'_, T> {
    fn drop(&mut self) {
        lock(&self.flight.current).take();
        let answer = self
            .answer
            .take()
            .unwrap_or_else(|| Err("qmo agents stopped".to_string()));
        self.slot.settle(answer);
    }
}

impl<T: Clone> Flight<T> {
    /// Run `job(rescan)`, or wait for the run already out when it will do.
    /// Blocking: call from a worker thread.
    pub fn run(
        &self,
        rescan: bool,
        job: impl FnOnce(bool) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut job = Some(job);
        loop {
            let (slot, leads) = {
                let mut current = lock(&self.current);
                match current.as_ref() {
                    Some(slot) => (slot.clone(), false),
                    None => {
                        let slot = Arc::new(Slot::new(rescan));
                        *current = Some(slot.clone());
                        (slot, true)
                    }
                }
            };
            if leads {
                let mut lead = Lead {
                    flight: self,
                    slot,
                    answer: None,
                };
                let answer = (job.take().expect("a call leads at most once"))(rescan);
                lead.answer = Some(answer.clone());
                return answer;
            }
            if slot.rescan || !rescan {
                return slot.wait();
            }
            // A plain run is out and this call wants a rescan: let it end.
            let _ = slot.wait();
        }
    }

    #[cfg(test)]
    fn waiting(&self) -> usize {
        lock(&self.current)
            .as_ref()
            .map(|slot| slot.waiting.load(std::sync::atomic::Ordering::SeqCst))
            .unwrap_or(0)
    }
}

/// `qmo agents --json`: `{"agents": [...]}`, each entry an object.
#[derive(Deserialize)]
struct Report {
    agents: Vec<Map<String, Value>>,
}

/// What one run left, as the page gets it: `{agents}` with each entry as
/// `qmo` printed it, or why not.
pub fn report(run: &sidecar::Run) -> Result<Value, String> {
    if run.timed_out {
        return Err(format!(
            "qmo agents took longer than {} s",
            TIMEOUT.as_secs()
        ));
    }
    match qmo::parse_output::<Report>(run.code, &run.stdout, &run.stderr) {
        Ok(report) => Ok(Value::Object(Map::from_iter([(
            "agents".to_string(),
            Value::Array(report.agents.into_iter().map(Value::Object).collect()),
        )]))),
        Err(failure) if failure.kind == qmo::ErrorKind::Broken && run.code == Some(0) => {
            Err("qmo agents printed an unexpected answer".to_string())
        }
        Err(failure) => Err(format!("qmo agents: {}", failure.message)),
    }
}

/// The arguments of one run.
pub fn args(rescan: bool) -> Vec<&'static str> {
    let mut args = vec!["agents", "--json"];
    if rescan {
        args.push("--rescan");
    }
    args
}

/// The shell's one flight of `qmo agents`.
#[derive(Default)]
pub struct Agents {
    flight: Flight<Value>,
}

impl Agents {
    /// Run `qmo agents --json [--rescan]`, or wait for the run already out.
    /// Blocking: call from a worker thread.
    pub fn scan(&self, rescan: bool) -> Result<Value, String> {
        self.flight.run(rescan, |rescan| {
            match sidecar::run(&args(rescan), None, TIMEOUT) {
                Ok(run) => report(&run),
                Err(e) => Err(format!("qmo did not start: {e}")),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::{atomic::AtomicUsize, atomic::Ordering, mpsc},
        thread,
        time::Instant,
    };

    fn run(code: Option<i32>, stdout: &str, stderr: &str, timed_out: bool) -> sidecar::Run {
        sidecar::Run {
            code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            timed_out,
        }
    }

    #[test]
    fn the_arguments_are_fixed() {
        assert_eq!(args(false), ["agents", "--json"]);
        assert_eq!(args(true), ["agents", "--json", "--rescan"]);
    }

    #[test]
    fn a_report_passes_the_list_on() {
        let out = r#"{"agents":[{"id":"omp","name":"qianmopi","version":"18.8.8","path":null,"protocol":"omp","available":true,"source":"builtin","configFound":false,"signedIn":null},{"id":"cursor","name":"Cursor CLI","available":false,"reason":"暂不支持接入"}],"extra":1}"#;
        let value = report(&run(Some(0), out, "", false)).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1, "only agents");
        assert_eq!(value["agents"][0]["id"], "omp");
        assert_eq!(value["agents"][0]["signedIn"], Value::Null);
        assert_eq!(value["agents"][1]["reason"], "暂不支持接入");
        assert_eq!(
            report(&run(Some(0), r#"{"agents":[]}"#, "", false)).unwrap(),
            json!({"agents": []})
        );
    }

    #[test]
    fn anything_else_is_an_error_string() {
        assert_eq!(
            report(&run(None, "", "", true)).unwrap_err(),
            "qmo agents took longer than 30 s"
        );
        for odd in [
            "",
            "not json",
            "{}",
            r#"{"agents":{}}"#,
            r#"{"agents":[1]}"#,
            r#"{"agents":["omp"]}"#,
            "[]",
        ] {
            assert_eq!(
                report(&run(Some(0), odd, "", false)).unwrap_err(),
                "qmo agents printed an unexpected answer",
                "{odd:?}"
            );
        }
        assert_eq!(
            report(&run(
                Some(2),
                r#"{"error":{"kind":"usage","message":"qmo agents 只接受 --json 与 --rescan"}}"#,
                "",
                false
            ))
            .unwrap_err(),
            "qmo agents: qmo agents 只接受 --json 与 --rescan"
        );
        assert_eq!(
            report(&run(Some(1), "", "TypeError: boom\n", false)).unwrap_err(),
            "qmo agents: TypeError: boom"
        );
        assert_eq!(
            report(&run(None, "", "", false)).unwrap_err(),
            "qmo agents: qmo was stopped"
        );
    }

    /// Spin (briefly) until `ok`, so the threads below are where the test
    /// says they are before it goes on.
    fn until(what: &str, ok: impl Fn() -> bool) {
        let started = Instant::now();
        while !ok() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timed out waiting: {what}"
            );
            thread::yield_now();
        }
    }

    /// A job that says when it has started and finishes when told.
    fn gated(
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<bool>,
        release: mpsc::Receiver<()>,
    ) -> impl FnOnce(bool) -> Result<String, String> {
        move |rescan| {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            started.send(rescan).unwrap();
            release.recv().unwrap();
            Ok(format!("run {n} rescan={rescan}"))
        }
    }

    #[test]
    fn calls_during_a_run_wait_for_its_answer() {
        let flight = Arc::new(Flight::<String>::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let leader = {
            let flight = flight.clone();
            let job = gated(calls.clone(), started_tx, release_rx);
            thread::spawn(move || flight.run(false, job))
        };
        assert!(!started.recv().unwrap());
        let followers: Vec<_> = (0..4)
            .map(|_| {
                let flight = flight.clone();
                thread::spawn(move || {
                    flight.run(false, |_| -> Result<String, String> {
                        panic!("a second run started")
                    })
                })
            })
            .collect();
        until("four waiting", || flight.waiting() == 4);
        release.send(()).unwrap();
        let first = leader.join().unwrap().unwrap();
        assert_eq!(first, "run 1 rescan=false");
        for follower in followers {
            assert_eq!(follower.join().unwrap().unwrap(), first);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Done is done: the next call runs again.
        let again = flight.run(false, |_| Ok("run 2".to_string())).unwrap();
        assert_eq!(again, "run 2");
    }

    #[test]
    fn a_rescan_waits_out_a_plain_run_then_runs_once() {
        let flight = Arc::new(Flight::<String>::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let plain = {
            let flight = flight.clone();
            let job = gated(calls.clone(), started_tx.clone(), release_rx);
            thread::spawn(move || flight.run(false, job))
        };
        assert!(!started.recv().unwrap());
        // Two rescans arrive during the plain run: both wait it out, then one
        // of them runs a rescan and the other joins it.
        let (release2, release2_rx) = mpsc::channel();
        let release2_rx = Arc::new(Mutex::new(Some(release2_rx)));
        let rescans: Vec<_> = (0..2)
            .map(|_| {
                let flight = flight.clone();
                let calls = calls.clone();
                let started_tx = started_tx.clone();
                let release2_rx = release2_rx.clone();
                thread::spawn(move || {
                    flight.run(true, move |rescan| {
                        let rx = release2_rx.lock().unwrap().take().expect("one rescan run");
                        gated(calls, started_tx, rx)(rescan)
                    })
                })
            })
            .collect();
        until("two rescans waiting", || flight.waiting() == 2);
        release.send(()).unwrap();
        assert_eq!(plain.join().unwrap().unwrap(), "run 1 rescan=false");
        assert!(started.recv().unwrap(), "the second run is a rescan");
        // A plain call now joins the rescan.
        let late = {
            let flight = flight.clone();
            thread::spawn(move || {
                flight.run(false, |_| -> Result<String, String> {
                    panic!("a plain run started during a rescan")
                })
            })
        };
        until("rescan joined", || flight.waiting() == 2);
        release2.send(()).unwrap();
        for rescan in rescans {
            assert_eq!(rescan.join().unwrap().unwrap(), "run 2 rescan=true");
        }
        assert_eq!(late.join().unwrap().unwrap(), "run 2 rescan=true");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_failed_run_is_everyones_answer_and_does_not_stick() {
        let flight = Flight::<String>::default();
        assert_eq!(
            flight.run(false, |_| Err("qmo did not start: x".to_string())),
            Err("qmo did not start: x".to_string())
        );
        assert_eq!(flight.run(true, |_| Ok("ok".to_string())), Ok("ok".into()));
    }
}
