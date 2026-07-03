//! Shared fd-3/fd-4 harness for the gated enforcement tests. Mirrors core's
//! spawn contract: fds 0/1/2 inherited, fd 3 = spec-in, fd 4 = status-out.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Max time to wait for the helper's status + exit before killing its group.
/// Mirrors the probe harness deadline pattern so a helper that hangs before
/// closing fd 4 (or never exits) fails the test instead of wedging it forever.
const SPEC_DEADLINE_MS: u64 = 10_000;

/// POSIX single-quote a string for `/bin/sh -c`: wrap in single quotes and
/// replace each embedded `'` with `'\''`. Safe for spaces and shell metachars.
/// Mirrors `shell_single_quote` in `src/probe.rs` (bin-only crate — tests
/// cannot import it).
pub fn shell_single_quote(s: &str) -> String {
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

/// Run the helper with `spec_json` on fd 3; return (fd4_status_line, exit_code).
pub fn run_spec(spec_json: &str) -> (String, i32) {
    let bin = env!("CARGO_BIN_EXE_rd-landlock");
    let (spec_r, mut spec_w) = os_pipe::pipe().expect("spec pipe");
    let (mut status_r, status_w) = os_pipe::pipe().expect("status pipe");

    // Raw fds for the child ends. Ownership stays with spec_r / status_w until
    // after spawn; the pre_exec closures only `dup2` these raw fds (they never
    // construct or drop a File from them), so no fd is closed early.
    let spec_read_fd = spec_r.as_raw_fd();
    let status_write_fd = status_w.as_raw_fd();

    let mut cmd = Command::new(bin);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .process_group(0); // new group (pgid == child pid) so a deadline kill reaches grandchildren
    // Map the read end of the spec pipe to fd 3 and the write end of the status
    // pipe to fd 4 in the child, via async-signal-safe dup2.
    //
    // `os_pipe::pipe()` creates O_CLOEXEC pipe ends. If a pipe end's raw fd
    // already equals its destination (e.g. spec_read_fd == 3), `dup2(3, 3)` is
    // a documented POSIX no-op that does NOT clear FD_CLOEXEC — the fd would
    // then close at the child's own exec, breaking the fd-3/fd-4 protocol
    // nondeterministically depending on the test process's fd allocation.
    // Guard that case by clearing FD_CLOEXEC directly via fcntl instead.
    // SAFETY: each closure performs only fcntl/dup2 syscalls, both
    // async-signal-safe, and does no allocation.
    unsafe {
        cmd.pre_exec(move || {
            if spec_read_fd == 3 {
                let flags = libc::fcntl(3, libc::F_GETFD);
                if flags < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(spec_read_fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
        cmd.pre_exec(move || {
            if status_write_fd == 4 {
                let flags = libc::fcntl(4, libc::F_GETFD);
                if flags < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(4, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(status_write_fd, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().expect("spawn helper");
    let pid = child.id() as i32; // == pgid because of process_group(0)
    // Now drop the parent's copies of the child ends so EOF/reads terminate.
    drop(spec_r);
    drop(status_w);

    spec_w.write_all(spec_json.as_bytes()).expect("write spec");
    drop(spec_w); // EOF so the helper's read_to_string returns.

    // Read + reap on a worker so this thread can enforce the deadline.
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut status = String::new();
        let _ = status_r.read_to_string(&mut status);
        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = tx.send((status, code));
    });

    match rx.recv_timeout(Duration::from_millis(SPEC_DEADLINE_MS)) {
        Ok(result) => {
            let _ = worker.join();
            result
        }
        Err(_) => {
            // Deadline blown: SIGKILL the child's whole group, unblocking the
            // worker's read/wait, then join before failing the test.
            // SAFETY: kill(2) with a negative pgid is always safe to call.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            let _ = worker.join();
            panic!("rd-landlock helper did not report + exit within {SPEC_DEADLINE_MS}ms");
        }
    }
}
