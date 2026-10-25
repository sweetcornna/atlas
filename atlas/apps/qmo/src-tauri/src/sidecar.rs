// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Running the bundled `qmo` (qmo-app.md §2): the one program that holds the
//! device token. The shell talks to it over pipes only — a pairing code goes in
//! on standard input, never on the command line (clients.md §3.1), and JSON
//! comes back on standard output.

use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::qmo::MAX_OUTPUT;

/// What one run left.
#[derive(Debug)]
pub struct Run {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// Stopped by the shell for taking longer than allowed.
    pub timed_out: bool,
}

/// `qmo` beside the shell's own executable, where the bundle puts it
/// (`bundle.externalBin`), and where `tauri-build` copies it for `cargo run`.
pub fn qmo_path() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("the shell's executable has no directory"))?;
    Ok(dir.join(if cfg!(windows) { "qmo.exe" } else { "qmo" }))
}

fn drain(mut from: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = from
            .by_ref()
            .take(MAX_OUTPUT as u64 + 1)
            .read_to_end(&mut bytes);
        // Keep reading to the end so the child never blocks on a full pipe.
        let _ = std::io::copy(&mut from, &mut std::io::sink());
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Run `qmo <args>` with `input` on its standard input, and wait at most
/// `timeout` before stopping it. Blocking: call from a worker thread.
pub fn run(args: &[&str], input: Option<&str>, timeout: Duration) -> std::io::Result<Run> {
    let mut command = Command::new(qmo_path()?);
    command
        .args(args)
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
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(text) = input {
            let _ = stdin.write_all(text.as_bytes());
        }
        // Dropped here: `qmo` sees the end of its input.
    }
    let stdout = drain(child.stdout.take().expect("piped"));
    let stderr = drain(child.stderr.take().expect("piped"));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    Ok(Run {
        code: status.and_then(|s| s.code()),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
        timed_out: status.is_none(),
    })
}
