//! `--probe`: read the negotiated ABI directly, then prove enforcement by
//! recursively invoking the rd-landlock binary over the normal fd-3/fd-4
//! protocol with a positive and a negative control. Prints
//! `{"available":bool,"abi":N}` to stdout, exits 0. Replaces the old
//! spawn-`true`-then-`cat` probe and detects the "container seccomp blocks
//! landlock_*" false positive (abi == 0).
//!
//! The recursive child applies the ruleset to *itself* then execs — exactly
//! like a normal run — so nothing is applied inside a fork. Specs are built via
//! serde (never string interpolation) and paths are POSIX single-quoted, so a
//! TMPDIR with spaces/quotes/metacharacters cannot corrupt the JSON or the
//! executed command. The child runs in its own process group under a bounded
//! deadline; a hang is SIGKILLed and reported unavailable.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt; // process_group
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::sys::{kill_group, map_child_fd, read_abi_version};

/// Max time to wait for the recursive child's status + exit before giving up.
const PROBE_DEADLINE_MS: u64 = 3000;

/// Serializable probe spec — built with serde, never `format!`, so arbitrary
/// paths cannot break the JSON.
#[derive(Serialize)]
struct ProbeSpec {
    command: String,
    strict: bool,
    ro: Vec<String>,
    rox: Vec<String>,
}

/// Strict view of the child's fd-4 status. serde rejects any object missing the
/// variant's required fields or with the wrong types, so a truncated
/// `{"status":"applied"}` deserializes to `None` rather than a false positive.
// Fields are never read (only the variant tag is matched) — they exist solely
// so serde enforces the strict shape of each status variant during parsing.
#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ChildStatus {
    Applied { abi: u32, downgraded: bool },
    Denied { abi: u32, missing: String },
    Error { message: String },
}

pub fn run() {
    let abi = read_abi_version().unwrap_or(0);
    let available = abi >= 1 && self_test();
    println!("{{\"available\":{available},\"abi\":{abi}}}");
}

/// POSIX single-quote a string for `/bin/sh -c`: wrap in single quotes and
/// replace each embedded `'` with `'\''`. Safe for spaces and shell metachars.
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Prove enforcement with a positive + negative control. Available only when
/// BOTH hold: the granted read succeeds (`applied`, exit 0) AND the ungranted
/// read is blocked with EACCES (`applied`, exit exactly 1).
fn self_test() -> bool {
    let dir = std::env::temp_dir().join(format!("rd-landlock-probe-{}", std::process::id()));
    let cleanup = || {
        let _ = std::fs::remove_dir_all(&dir);
    };
    let granted = dir.join("granted");
    if std::fs::create_dir_all(&granted).is_err() {
        cleanup();
        return false;
    }
    let ok_file = granted.join("ok"); // inside the granted ro tree
    let secret = dir.join("secret"); // NOT under any grant
    if std::fs::write(&ok_file, b"x").is_err() || std::fs::write(&secret, b"x").is_err() {
        cleanup();
        return false;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => {
            cleanup();
            return false;
        }
    };
    let ro = vec!["/etc".to_string(), granted.to_string_lossy().into_owned()];
    let rox = system_paths();
    // strict:false so the probe never *refuses*; it only measures enforcement.
    let pos = ProbeSpec {
        command: format!("cat {}", shell_single_quote(&ok_file.to_string_lossy())),
        strict: false,
        ro: ro.clone(),
        rox: rox.clone(),
    };
    let neg = ProbeSpec {
        command: format!("cat {}", shell_single_quote(&secret.to_string_lossy())),
        strict: false,
        ro,
        rox,
    };

    let positive = applied_exit_code(&exe, &pos);
    let negative = applied_exit_code(&exe, &neg);
    cleanup();

    // Positive: granted read succeeded. Negative: ungranted read blocked (EACCES → 1).
    matches!(positive, Some(0)) && matches!(negative, Some(1))
}

/// Run the child; return the child exit code IFF the status strictly parsed as
/// `applied` (ruleset really applied). Any other status / parse failure → None.
fn applied_exit_code(exe: &Path, spec: &ProbeSpec) -> Option<i32> {
    let json = serde_json::to_string(spec).ok()?;
    let (line, code) = run_child(exe, &json)?;
    match serde_json::from_str::<ChildStatus>(line.trim()).ok()? {
        ChildStatus::Applied { .. } => Some(code),
        _ => None,
    }
}

/// Spawn the helper with fd 3 = spec-in and fd 4 = status-out in its OWN process
/// group; write the spec, then read the status + reap on a background thread
/// bounded by `PROBE_DEADLINE_MS`. On timeout, SIGKILL the whole group and
/// return `None`. Child stderr is discarded so a blocked read's error is quiet.
fn run_child(exe: &Path, spec_json: &str) -> Option<(String, i32)> {
    let (spec_r, mut spec_w) = os_pipe::pipe().ok()?;
    let (mut status_r, status_w) = os_pipe::pipe().ok()?;

    let mut cmd = Command::new(exe);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0); // new group (pgid == child pid) so we can kill grandchildren
    // Map the pipe ends onto fds 3 and 4 in the child via dup2 (async-signal-safe).
    // The source fds stay owned by spec_r/status_w until after spawn.
    map_child_fd(&mut cmd, spec_r.as_raw_fd(), 3);
    map_child_fd(&mut cmd, status_w.as_raw_fd(), 4);

    let mut child = cmd.spawn().ok()?;
    let pid = child.id() as i32; // == pgid because of process_group(0)
    // Drop our copies of the child ends so EOF and reads terminate correctly.
    drop(spec_r);
    drop(status_w);

    spec_w.write_all(spec_json.as_bytes()).ok()?;
    drop(spec_w); // EOF so the child's read_to_string returns.

    // Read + wait on a worker so the main thread can enforce a deadline.
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut status = String::new();
        let _ = status_r.read_to_string(&mut status);
        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = tx.send((status, code));
    });

    match rx.recv_timeout(Duration::from_millis(PROBE_DEADLINE_MS)) {
        Ok(result) => {
            let _ = worker.join();
            Some(result)
        }
        Err(_) => {
            // Timed out: kill the child's whole group, unblocking the worker's
            // read/wait, then join. Report unavailable.
            kill_group(pid);
            let _ = worker.join();
            None
        }
    }
}

/// System exec paths that exist on this host.
fn system_paths() -> Vec<String> {
    ["/usr", "/bin", "/sbin", "/lib", "/lib64"]
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_and_command_survive_paths_with_space_and_quote() {
        let path = "/tmp/we ird/o'clock/secret";
        let spec = ProbeSpec {
            command: format!("cat {}", shell_single_quote(path)),
            strict: false,
            ro: vec!["/etc".into()],
            rox: vec!["/usr".into()],
        };
        // Serde produces valid JSON that round-trips (no manual escaping bugs).
        let json = serde_json::to_string(&spec).unwrap();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        // The command re-assembles to exactly `cat <path>` under /bin/sh.
        assert_eq!(back["command"], "cat '/tmp/we ird/o'\\''clock/secret'");
        assert_eq!(
            shell_single_quote(path),
            "'/tmp/we ird/o'\\''clock/secret'"
        );
    }
}
