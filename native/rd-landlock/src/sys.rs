//! The single module permitted to use `unsafe`. It contains only the raw
//! syscalls the safe `landlock`/`std` wrappers cannot express: the numeric
//! Landlock ABI probe and borrowing the inherited fds 3/4 with FD_CLOEXEC.
#![allow(unsafe_code)]

use std::fs::File;
use std::os::fd::{FromRawFd, RawFd};

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
