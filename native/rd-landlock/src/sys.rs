//! The single module permitted to use `unsafe`. It contains only the raw
//! syscalls the safe `landlock`/`std` wrappers cannot express: the numeric
//! Landlock ABI probe and borrowing the inherited fds 3/4 with FD_CLOEXEC.
#![allow(unsafe_code)]

use std::fs::File;
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::Command;

const SPEC_FD: RawFd = 3;
const STATUS_FD: RawFd = 4;
const LANDLOCK_CREATE_RULESET_VERSION: libc::c_ulong = 1;

/// Read the kernel's supported Landlock ABI via
/// `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`.
///
/// Returns the version integer (≥ 1) on success, `Ok(0)` when the syscall is
/// unavailable (`ENOSYS`/`EPERM` — e.g. container seccomp), or `Err` for any
/// other errno.
pub fn read_abi_version() -> Result<u32, String> {
    // SAFETY: null attr pointer with size 0 is the documented ABI-probe form;
    // it creates no ruleset and returns the supported version.
    let ret = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if ret >= 0 {
        return Ok(ret as u32);
    }
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    match errno {
        libc::ENOSYS | libc::EPERM | libc::EOPNOTSUPP => Ok(0),
        _ => Err(format!("landlock_create_ruleset probe failed: errno {errno}")),
    }
}

fn set_cloexec(fd: RawFd) -> Result<(), String> {
    // SAFETY: fcntl on a valid inherited fd; failure is reported, not ignored.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(format!("F_GETFD on fd {fd} failed"));
    }
    let rc = unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
    if rc < 0 {
        return Err(format!("F_SETFD FD_CLOEXEC on fd {fd} failed"));
    }
    Ok(())
}

/// Owned reader over inherited fd 3, marked FD_CLOEXEC so it closes at exec.
pub fn spec_reader() -> Result<File, String> {
    set_cloexec(SPEC_FD)?;
    // SAFETY: fd 3 is inherited from the parent per the spawn contract.
    Ok(unsafe { File::from_raw_fd(SPEC_FD) })
}

/// Owned writer over inherited fd 4, marked FD_CLOEXEC so it closes at exec.
pub fn status_writer() -> Result<File, String> {
    set_cloexec(STATUS_FD)?;
    // SAFETY: fd 4 is inherited from the parent per the spawn contract.
    Ok(unsafe { File::from_raw_fd(STATUS_FD) })
}

/// Map an existing fd onto `dst_fd` in the forked child, immediately before
/// exec, via `dup2`. `dup2` is async-signal-safe and allocates nothing, so this
/// is fork-safe (unlike applying a ruleset after fork). `src_fd` must stay open
/// in the parent until after `spawn`.
///
/// When `src_fd == dst_fd` (e.g. an O_CLOEXEC pipe end that happens to land
/// on its own destination fd number because it was the first fd allocated
/// after exec), `dup2` is a documented POSIX no-op that does NOT clear
/// FD_CLOEXEC. Left uncleared, the fd would close at the *child's own* exec,
/// breaking the fd-3/fd-4 protocol on that host. Handle this case by clearing
/// FD_CLOEXEC directly via fcntl instead of relying on dup2.
pub fn map_child_fd(cmd: &mut Command, src_fd: RawFd, dst_fd: RawFd) {
    // SAFETY: the pre_exec closure performs only async-signal-safe syscalls
    // (fcntl/dup2) and no allocation. When src_fd == dst_fd, dup2 would be a
    // no-op that leaves FD_CLOEXEC set (closing the fd at exec), so we clear
    // FD_CLOEXEC directly to keep the inherited fd open across exec.
    unsafe {
        cmd.pre_exec(move || {
            if src_fd == dst_fd {
                let flags = libc::fcntl(dst_fd, libc::F_GETFD);
                if flags < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(dst_fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(src_fd, dst_fd) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// SIGKILL the process group led by `pid`. Only valid for a child spawned with
/// `process_group(0)` (so its pgid == its pid); the negative pid targets the
/// whole group, reaping any grandchildren the recursive probe child spawned.
///
/// `pid` must be strictly positive: `kill(-pid, ...)` with `pid <= 0` does not
/// target "no group" — `pid == 0` signals the caller's own process group and
/// `pid < 0` signals an arbitrary group by absolute value. Guard defensively
/// so a future caller passing a bad pid can never self-signal.
pub fn kill_group(pid: i32) {
    if pid <= 0 {
        return;
    }
    // SAFETY: kill(2) with a negative pid signals the process group; a failure
    // (group already gone) is ignored. `pid > 0` is checked above, so `-pid`
    // cannot be `0` (self process group) or a sign-flip surprise.
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_read_is_non_negative() {
        // Host-independent: on a Landlock host returns ≥ 1; on a non-Landlock
        // host returns Ok(0). Never errors on the common ENOSYS/EPERM path.
        let abi = read_abi_version().expect("probe returns Ok on supported errnos");
        assert!(abi <= 16, "sanity bound on ABI version");
    }
}
