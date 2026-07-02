//! Shared fd-3/fd-4 harness for the gated enforcement tests. Mirrors core's
//! spawn contract: fds 0/1/2 inherited, fd 3 = spec-in, fd 4 = status-out.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

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
        .stderr(Stdio::inherit());
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
    // Now drop the parent's copies of the child ends so EOF/reads terminate.
    drop(spec_r);
    drop(status_w);

    spec_w.write_all(spec_json.as_bytes()).expect("write spec");
    drop(spec_w); // EOF so the helper's read_to_string returns.

    let mut status = String::new();
    let _ = status_r.read_to_string(&mut status);
    let code = child.wait().expect("wait").code().unwrap_or(-1);
    (status, code)
}
