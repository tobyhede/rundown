//! Real-kernel enforcement tests. `#[ignore]` by default; run explicitly with
//! `cargo test --test enforcement -- --ignored` on a Landlock ≥ v3 host, or in
//! CI via `RUNDOWN_REQUIRE_LANDLOCK=1`.

use std::process::Command;

/// Path to the built helper. Set by the harness invocation.
fn helper() -> String {
    env!("CARGO_BIN_EXE_rd-landlock").to_string()
}

/// Run the helper with a spec on fd 3 and capture the fd-4 status + child exit.
/// Returns (fd4_status_line, exit_code).
fn run_with_spec(spec_json: &str) -> (String, i32) {
    // Test harness lives in tests/support.rs (Task 11 adds richer helpers).
    // Minimal inline runner for this task:
    use std::io::Write;
    use std::os::unix::io::{AsRawFd, FromRawFd};
    let (spec_r, mut spec_w) = os_pipe::pipe().expect("spec pipe");
    let (status_r, status_w) = os_pipe::pipe().expect("status pipe");
    let mut cmd = Command::new(helper());
    // fds 3 and 4 wired via file_descriptor mapping.
    cmd.stdin(std::process::Stdio::null());
    // See Task 11 for the full os_pipe wiring; here we assert only that a denied
    // read is blocked. This test is #[ignore]d and finalised in Task 11.
    let _ = (spec_r, &mut spec_w, status_r, status_w, spec_json);
    let _ = cmd;
    (String::new(), 0)
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn denied_read_returns_eacces() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "x").unwrap();
    let spec = format!(
        r#"{{"command":"cat {}","strict":true,"rox":["/usr","/bin","/lib","/lib64"],"ro":["/etc"]}}"#,
        secret.display()
    );
    let (status, code) = run_with_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""));
    assert_ne!(code, 0, "reading an ungranted path must fail under Landlock");
}
