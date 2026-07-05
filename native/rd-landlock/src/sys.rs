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
const SECCOMP_DATA_NR_OFFSET: u32 = 0;
const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;
const SECCOMP_DATA_ARGS_OFFSET: u32 = 16;
const BPF_CLASS_MASK: u32 = 0x07;
#[cfg(target_arch = "x86_64")]
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH_CURRENT: u32 = 0xC000_003E;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH_CURRENT: u32 = 0xC000_00B7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeccompAction {
    Allow,
    KillProcess,
    Errno(u16),
}

impl SeccompAction {
    fn as_ret(self) -> u32 {
        match self {
            Self::Allow => libc::SECCOMP_RET_ALLOW,
            Self::KillProcess => libc::SECCOMP_RET_KILL_PROCESS,
            Self::Errno(errno) => libc::SECCOMP_RET_ERRNO | u32::from(errno),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SocketFilterRule {
    RequireArch(u32),
    DenySyscall { syscall: i64, errno: i32 },
    #[cfg(target_arch = "x86_64")]
    DenySyscallNumberMask { mask: u32, errno: i32 },
    AllowSocketFamily { syscall: i64, family: i32 },
    DenySocketFamiliesByDefault { syscall: i64, errno: i32 },
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn syscall_socket() -> i64 {
    libc::SYS_socket
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn syscall_socketpair() -> i64 {
    libc::SYS_socketpair
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn syscall_io_uring_setup() -> i64 {
    libc::SYS_io_uring_setup
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn syscall_io_uring_enter() -> i64 {
    libc::SYS_io_uring_enter
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn syscall_io_uring_register() -> i64 {
    libc::SYS_io_uring_register
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn bpf_stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn bpf_jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn ret(action: SeccompAction) -> libc::sock_filter {
    bpf_stmt((libc::BPF_RET | libc::BPF_K) as u16, action.as_ret())
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn load_word(offset: u32) -> libc::sock_filter {
    bpf_stmt((libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16, offset)
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn jump_eq(k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    bpf_jump(
        (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
        k,
        jt,
        jf,
    )
}

#[cfg(target_arch = "x86_64")]
fn jump_set(k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    bpf_jump(
        (libc::BPF_JMP | libc::BPF_JSET | libc::BPF_K) as u16,
        k,
        jt,
        jf,
    )
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn checked_skip(from: usize, to: usize) -> Result<u8, String> {
    if to <= from {
        return Err(format!("invalid backward BPF jump from {from} to {to}"));
    }
    let skip = to - from - 1;
    u8::try_from(skip).map_err(|_| format!("BPF jump from {from} to {to} exceeds u8 range"))
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn arch_from_rules(rules: &[SocketFilterRule]) -> Result<u32, String> {
    rules
        .iter()
        .find_map(|rule| match rule {
            SocketFilterRule::RequireArch(arch) => Some(*arch),
            _ => None,
        })
        .ok_or_else(|| "network seccomp rules missing architecture guard".to_string())
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn allowed_socket_families(rules: &[SocketFilterRule], syscall: i64) -> Vec<i32> {
    rules
        .iter()
        .filter_map(|rule| match *rule {
            SocketFilterRule::AllowSocketFamily { syscall: s, family } if s == syscall => {
                Some(family)
            }
            _ => None,
        })
        .collect()
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn default_socket_family_errno(rules: &[SocketFilterRule], syscall: i64) -> Result<i32, String> {
    rules
        .iter()
        .find_map(|rule| match *rule {
            SocketFilterRule::DenySocketFamiliesByDefault { syscall: s, errno } if s == syscall => {
                Some(errno)
            }
            _ => None,
        })
        .ok_or_else(|| format!("network seccomp rules missing default deny for syscall {syscall}"))
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn denied_syscalls(rules: &[SocketFilterRule]) -> Vec<(i64, i32)> {
    rules
        .iter()
        .filter_map(|rule| match *rule {
            SocketFilterRule::DenySyscall { syscall, errno } => Some((syscall, errno)),
            _ => None,
        })
        .collect()
}

#[cfg(target_arch = "x86_64")]
fn denied_syscall_number_masks(rules: &[SocketFilterRule]) -> Vec<(u32, i32)> {
    rules
        .iter()
        .filter_map(|rule| match *rule {
            SocketFilterRule::DenySyscallNumberMask { mask, errno } => Some((mask, errno)),
            _ => None,
        })
        .collect()
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn append_denied_syscall_checks(
    program: &mut Vec<libc::sock_filter>,
    syscalls: &[(i64, i32)],
) -> Result<(), String> {
    for (syscall, errno) in syscalls {
        let jump_index = program.len();
        program.push(jump_eq(*syscall as u32, 0, 0));
        program.push(ret(SeccompAction::Errno(*errno as u16)));
        let next_index = program.len();
        program[jump_index].jt = checked_skip(jump_index, jump_index + 1)?;
        program[jump_index].jf = checked_skip(jump_index, next_index)?;
    }
    Ok(())
}

#[cfg(target_arch = "x86_64")]
fn append_denied_syscall_mask_checks(
    program: &mut Vec<libc::sock_filter>,
    masks: &[(u32, i32)],
) -> Result<(), String> {
    for (mask, errno) in masks {
        let jump_index = program.len();
        program.push(jump_set(*mask, 0, 0));
        program.push(ret(SeccompAction::Errno(*errno as u16)));
        let next_index = program.len();
        program[jump_index].jt = checked_skip(jump_index, jump_index + 1)?;
        program[jump_index].jf = checked_skip(jump_index, next_index)?;
    }
    Ok(())
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn append_allowed_family_checks(
    program: &mut Vec<libc::sock_filter>,
    families: &[i32],
    default_errno: i32,
) -> Result<(), String> {
    program.push(load_word(SECCOMP_DATA_ARGS_OFFSET));
    for family in families {
        let jump_index = program.len();
        program.push(jump_eq(*family as u32, 0, 0));
        program.push(ret(SeccompAction::Allow));
        let next_index = program.len();
        program[jump_index].jt = checked_skip(jump_index, jump_index + 1)?;
        program[jump_index].jf = checked_skip(jump_index, next_index)?;
    }
    program.push(ret(SeccompAction::Errno(default_errno as u16)));
    Ok(())
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn validate_bpf_jumps(program: &[libc::sock_filter]) -> Result<(), String> {
    for (index, insn) in program.iter().enumerate() {
        let class = u32::from(insn.code) & BPF_CLASS_MASK;
        if class != libc::BPF_JMP {
            continue;
        }
        let jt_target = index + 1 + usize::from(insn.jt);
        let jf_target = index + 1 + usize::from(insn.jf);
        if jt_target >= program.len() {
            return Err(format!(
                "BPF jt target {jt_target} out of bounds from {index}"
            ));
        }
        if jf_target >= program.len() {
            return Err(format!(
                "BPF jf target {jf_target} out of bounds from {index}"
            ));
        }
    }
    Ok(())
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn build_network_filter_rules() -> Vec<SocketFilterRule> {
    vec![
        SocketFilterRule::RequireArch(AUDIT_ARCH_CURRENT),
        #[cfg(target_arch = "x86_64")]
        SocketFilterRule::DenySyscallNumberMask {
            mask: X32_SYSCALL_BIT,
            errno: libc::ENOSYS,
        },
        SocketFilterRule::DenySyscall {
            syscall: syscall_io_uring_setup(),
            errno: libc::EACCES,
        },
        SocketFilterRule::DenySyscall {
            syscall: syscall_io_uring_enter(),
            errno: libc::EACCES,
        },
        SocketFilterRule::DenySyscall {
            syscall: syscall_io_uring_register(),
            errno: libc::EACCES,
        },
        SocketFilterRule::AllowSocketFamily {
            syscall: syscall_socket(),
            family: libc::AF_UNIX,
        },
        SocketFilterRule::AllowSocketFamily {
            syscall: syscall_socket(),
            family: libc::AF_NETLINK,
        },
        SocketFilterRule::DenySocketFamiliesByDefault {
            syscall: syscall_socket(),
            errno: libc::EACCES,
        },
        SocketFilterRule::AllowSocketFamily {
            syscall: syscall_socketpair(),
            family: libc::AF_UNIX,
        },
        SocketFilterRule::DenySocketFamiliesByDefault {
            syscall: syscall_socketpair(),
            errno: libc::EACCES,
        },
    ]
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn lower_network_filter_rules(
    rules: &[SocketFilterRule],
) -> Result<Vec<libc::sock_filter>, String> {
    let arch = arch_from_rules(rules)?;
    let socket_families = allowed_socket_families(rules, syscall_socket());
    let socket_errno = default_socket_family_errno(rules, syscall_socket())?;
    let socketpair_families = allowed_socket_families(rules, syscall_socketpair());
    let socketpair_errno = default_socket_family_errno(rules, syscall_socketpair())?;
    let denied_syscalls = denied_syscalls(rules);
    #[cfg(target_arch = "x86_64")]
    let denied_syscall_masks = denied_syscall_number_masks(rules);

    let mut program = Vec::new();
    program.push(load_word(SECCOMP_DATA_ARCH_OFFSET));
    program.push(jump_eq(arch, 1, 0));
    program.push(ret(SeccompAction::KillProcess));
    program.push(load_word(SECCOMP_DATA_NR_OFFSET));

    #[cfg(target_arch = "x86_64")]
    append_denied_syscall_mask_checks(&mut program, &denied_syscall_masks)?;
    append_denied_syscall_checks(&mut program, &denied_syscalls)?;

    let socket_jump = program.len();
    program.push(jump_eq(syscall_socket() as u32, 0, 0));
    let socketpair_jump = program.len();
    program.push(jump_eq(syscall_socketpair() as u32, 0, 0));
    program.push(ret(SeccompAction::Allow));

    let socket_checks = program.len();
    append_allowed_family_checks(&mut program, &socket_families, socket_errno)?;

    let socketpair_checks = program.len();
    append_allowed_family_checks(&mut program, &socketpair_families, socketpair_errno)?;

    program[socket_jump].jt = checked_skip(socket_jump, socket_checks)?;
    program[socket_jump].jf = checked_skip(socket_jump, socketpair_jump)?;
    program[socketpair_jump].jt = checked_skip(socketpair_jump, socketpair_checks)?;
    program[socketpair_jump].jf = checked_skip(socketpair_jump, socketpair_jump + 1)?;

    validate_bpf_jumps(&program)?;
    Ok(program)
}

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
        _ => Err(format!(
            "landlock_create_ruleset probe failed: errno {errno}"
        )),
    }
}

/// Install the classic seccomp-BPF filter that allows only local AF_UNIX and
/// AF_NETLINK `socket()` creation, allows AF_UNIX `socketpair()`, and denies
/// every other socket family.
pub fn install_network_seccomp_filter() -> Result<(), String> {
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        return Err(format!(
            "unsupported architecture for network seccomp filter: {}",
            std::env::consts::ARCH
        ));
    }

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        let rules = build_network_filter_rules();
        let mut filter = lower_network_filter_rules(&rules)?;
        let mut program = libc::sock_fprog {
            len: filter
                .len()
                .try_into()
                .map_err(|_| "network seccomp filter too large".to_string())?,
            filter: filter.as_mut_ptr(),
        };

        // SAFETY: prctl is called with documented scalar arguments. Failure is
        // captured through errno and returned to the caller before exec.
        let no_new_privs = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
        if no_new_privs != 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("PR_SET_NO_NEW_PRIVS failed: {err}"));
        }

        // SAFETY: `program.filter` points into `filter`, which stays alive for
        // the duration of the syscall. The kernel copies the BPF program before
        // returning.
        let seccomp = unsafe {
            libc::prctl(
                libc::PR_SET_SECCOMP,
                libc::SECCOMP_MODE_FILTER,
                &mut program as *mut libc::sock_fprog,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            )
        };
        if seccomp != 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("PR_SET_SECCOMP SECCOMP_MODE_FILTER failed: {err}"));
        }

        Ok(())
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

    #[derive(Debug, PartialEq, Eq)]
    enum SimulatedAction {
        Allow,
        KillProcess,
        Errno(i32),
    }

    fn simulate_network_filter(
        rules: &[SocketFilterRule],
        syscall: i64,
        family: u64,
    ) -> SimulatedAction {
        if !rules
            .iter()
            .any(|rule| matches!(rule, SocketFilterRule::RequireArch(_)))
        {
            return SimulatedAction::KillProcess;
        }

        for rule in rules {
            match *rule {
                #[cfg(target_arch = "x86_64")]
                SocketFilterRule::DenySyscallNumberMask { mask, errno }
                    if (syscall as u32) & mask != 0 =>
                {
                    return SimulatedAction::Errno(errno);
                }
                SocketFilterRule::DenySyscall {
                    syscall: rule_syscall,
                    errno,
                } if rule_syscall == syscall => {
                    return SimulatedAction::Errno(errno);
                }
                SocketFilterRule::AllowSocketFamily {
                    syscall: rule_syscall,
                    family: rule_family,
                } if rule_syscall == syscall && rule_family as u64 == family => {
                    return SimulatedAction::Allow;
                }
                SocketFilterRule::DenySocketFamiliesByDefault {
                    syscall: rule_syscall,
                    errno,
                } if rule_syscall == syscall => {
                    return SimulatedAction::Errno(errno);
                }
                _ => {}
            }
        }
        SimulatedAction::Allow
    }

    #[test]
    fn abi_read_is_non_negative() {
        // Host-independent: on a Landlock host returns ≥ 1; on a non-Landlock
        // host returns Ok(0). Never errors on the common ENOSYS/EPERM path.
        let abi = read_abi_version().expect("probe returns Ok on supported errnos");
        assert!(abi <= 16, "sanity bound on ABI version");
    }

    /// `kill_group` must return early for `pid <= 0` rather than reach the real
    /// `kill(2)` call: `kill(-0, SIGKILL)` targets the *caller's own* process
    /// group (pid 0 is not "no group"), and `kill(-(-1), SIGKILL)` == `kill(1,
    /// SIGKILL)` targets init, not "no group" either. This test process shares
    /// its process group with the test harness, so if the guard were removed
    /// (or the sign got flipped), `kill_group(0)` would SIGKILL this test
    /// binary's own group — the process would die and the assertion below
    /// would never run, rather than merely failing.
    #[test]
    fn kill_group_guards_against_non_positive_pid() {
        kill_group(0);
        kill_group(-1);
        assert_eq!(2 + 2, 4, "test process survived: guard did not self-signal");
    }

    #[test]
    fn network_filter_plan_allows_af_unix_socket() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socket, libc::AF_UNIX as u64),
            SimulatedAction::Allow
        );
    }

    #[test]
    fn network_filter_plan_denies_af_inet_socket() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socket, libc::AF_INET as u64),
            SimulatedAction::Errno(libc::EACCES)
        );
    }

    #[test]
    fn network_filter_plan_denies_af_inet6_socket() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socket, libc::AF_INET6 as u64),
            SimulatedAction::Errno(libc::EACCES)
        );
    }

    #[test]
    fn network_filter_plan_allows_af_netlink_socket() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socket, libc::AF_NETLINK as u64),
            SimulatedAction::Allow
        );
    }

    #[test]
    fn network_filter_plan_denies_unclassified_socket_family_by_default() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socket, 9999),
            SimulatedAction::Errno(libc::EACCES)
        );
    }

    #[test]
    fn network_filter_plan_leaves_unrelated_syscalls_allowed() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_getpid, 0),
            SimulatedAction::Allow
        );
    }

    #[test]
    fn network_filter_plan_denies_io_uring_socket_creation_path() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_io_uring_setup, 0),
            SimulatedAction::Errno(libc::EACCES)
        );
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_io_uring_enter, 0),
            SimulatedAction::Errno(libc::EACCES)
        );
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_io_uring_register, 0),
            SimulatedAction::Errno(libc::EACCES)
        );
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn network_filter_plan_rejects_x32_syscall_numbers_before_fallthrough_allow() {
        const X32_SYSCALL_BIT: i64 = 0x4000_0000;
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_getpid | X32_SYSCALL_BIT, 0),
            SimulatedAction::Errno(libc::ENOSYS)
        );
    }

    #[test]
    fn network_filter_plan_allows_af_unix_socketpair_when_socketpair_is_filtered() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socketpair, libc::AF_UNIX as u64),
            SimulatedAction::Allow
        );
    }

    #[test]
    fn network_filter_plan_denies_af_inet_socketpair_when_socketpair_is_filtered() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socketpair, libc::AF_INET as u64),
            SimulatedAction::Errno(libc::EACCES)
        );
    }

    #[test]
    fn network_filter_plan_denies_unclassified_socketpair_family_by_default() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socketpair, 9999),
            SimulatedAction::Errno(libc::EACCES)
        );
    }

    #[test]
    fn network_filter_plan_denies_af_netlink_socketpair_when_socketpair_is_filtered() {
        let rules = build_network_filter_rules();
        assert_eq!(
            simulate_network_filter(&rules, libc::SYS_socketpair, libc::AF_NETLINK as u64),
            SimulatedAction::Errno(libc::EACCES)
        );
    }

    #[test]
    fn lowered_network_filter_has_only_in_bounds_jump_targets() {
        let rules = build_network_filter_rules();
        let program = lower_network_filter_rules(&rules).expect("lower filter");
        validate_bpf_jumps(&program).expect("jump targets in bounds");
    }
}
