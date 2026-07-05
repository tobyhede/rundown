//! Real-kernel enforcement tests. `#[ignore]` unless run explicitly on a
//! Landlock >= v3 host: `cargo test --test enforcement -- --ignored`.
//!
//! Specs are built with `serde_json::json!` and commands use probe-style POSIX
//! single-quoting, so a TMPDIR with spaces or shell metacharacters cannot
//! corrupt the JSON or the executed command.

mod support;
use support::{run_spec, shell_single_quote};

const SYSTEM_ROX: [&str; 5] = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];

fn quoted(path: &std::path::Path) -> String {
    shell_single_quote(&path.to_string_lossy())
}

fn python_available_command(script: &str) -> String {
    format!("python3 -c {}", shell_single_quote(script))
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn denied_read_is_blocked_and_status_applied() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "x").unwrap();
    let spec = serde_json::json!({
        "command": format!("cat {}", quoted(&secret)),
        "strict": true,
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();
    let (status, code) = run_spec(&spec);
    assert!(
        status.contains("\"status\":\"applied\""),
        "status: {status}"
    );
    assert_ne!(code, 0, "ungranted read must fail");
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn truncate_blocked_on_readonly_grant() {
    let dir = tempfile::tempdir().unwrap();
    let ro = dir.path().join("ro");
    std::fs::create_dir(&ro).unwrap();
    let file = ro.join("keep.txt");
    std::fs::write(&file, "important").unwrap();
    // `: > file` truncates in place. Under a ro grant with ABI >= 3 it must fail.
    let spec = serde_json::json!({
        "command": format!(": > {}", quoted(&file)),
        "strict": true,
        "rox": SYSTEM_ROX,
        "ro": [ro.to_string_lossy(), std::borrow::Cow::from("/etc")],
    })
    .to_string();
    let (status, code) = run_spec(&spec);
    assert!(
        status.contains("\"status\":\"applied\""),
        "status: {status}"
    );
    assert_ne!(code, 0, "truncate on a read-only grant must be blocked");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "important");
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn full_write_set_works_on_readwrite_grant() {
    let dir = tempfile::tempdir().unwrap();
    let rw = dir.path().join("rw");
    let rw2 = dir.path().join("rw2");
    std::fs::create_dir(&rw).unwrap();
    std::fs::create_dir(&rw2).unwrap();
    std::fs::write(rw.join("old.txt"), "old").unwrap();
    // create (MAKE_REG) + overwrite/truncate (>) + delete (REMOVE_FILE) +
    // cross-dir rename (REFER, ABI >= 2), all under rw grants.
    let cmd = format!(
        "printf hi > {new} && printf x > {old} && rm {old} && mv {new} {moved}",
        new = quoted(&rw.join("new.txt")),
        old = quoted(&rw.join("old.txt")),
        moved = quoted(&rw2.join("moved.txt")),
    );
    let spec = serde_json::json!({
        "command": cmd,
        "strict": true,
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
        "rw": [rw.to_string_lossy(), rw2.to_string_lossy()],
    })
    .to_string();
    let (status, code) = run_spec(&spec);
    assert!(
        status.contains("\"status\":\"applied\""),
        "status: {status}"
    );
    assert_eq!(
        code, 0,
        "full write set must succeed on rw grants: {status}"
    );
    assert!(rw2.join("moved.txt").exists());
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel, run as an unprivileged user"]
fn enforcement_works_unprivileged() {
    // Landlock is unprivileged by design; PR_SET_NO_NEW_PRIVS + restrict_self
    // must enforce without elevated capabilities. CI runs this job as a
    // non-root user (see ci.yml). Assert we are not uid 0, then reuse the
    // denied-read assertion.
    assert_ne!(unsafe_getuid(), 0, "run this test as an unprivileged user");
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("s.txt");
    std::fs::write(&secret, "x").unwrap();
    let spec = serde_json::json!({
        "command": format!("cat {}", quoted(&secret)),
        "strict": true,
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""));
    assert_ne!(code, 0);
}

fn unsafe_getuid() -> u32 {
    // SAFETY (test only): getuid is always safe and never fails.
    unsafe { libc::getuid() }
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel and seccomp filter support"]
fn network_deny_blocks_tcp_socket_creation() {
    let spec = serde_json::json!({
        "command": python_available_command(
            "import errno, socket, sys\ntry:\n    socket.socket(socket.AF_INET, socket.SOCK_STREAM)\nexcept PermissionError as e:\n    sys.exit(13 if e.errno == errno.EACCES else 42)\nelse:\n    sys.exit(0)"
        ),
        "strict": true,
        "network": "deny",
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();

    let (status, code) = run_spec(&spec);
    assert!(
        status.contains("\"status\":\"applied\""),
        "status: {status}"
    );
    assert!(status.contains("\"network\":\"deny\""), "status: {status}");
    assert_eq!(
        code, 13,
        "AF_INET socket creation must fail with EACCES, not a missing python or unrelated error"
    );
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel and seccomp filter support"]
fn network_deny_allows_af_unix_socket_creation() {
    let spec = serde_json::json!({
        "command": python_available_command(
            "import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.close()"
        ),
        "strict": true,
        "network": "deny",
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();

    let (status, code) = run_spec(&spec);
    assert!(
        status.contains("\"status\":\"applied\""),
        "status: {status}"
    );
    assert!(status.contains("\"network\":\"deny\""), "status: {status}");
    assert_eq!(code, 0, "AF_UNIX socket creation must remain available");
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel and seccomp filter support"]
fn network_allow_does_not_block_tcp_socket_creation() {
    let spec = serde_json::json!({
        "command": python_available_command(
            "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.close()"
        ),
        "strict": true,
        "network": "allow",
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();

    let (status, code) = run_spec(&spec);
    assert!(
        status.contains("\"status\":\"applied\""),
        "status: {status}"
    );
    assert!(status.contains("\"network\":\"allow\""), "status: {status}");
    assert_eq!(code, 0, "network allow must not install the socket filter");
}
