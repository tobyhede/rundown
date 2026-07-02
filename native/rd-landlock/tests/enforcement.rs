//! Real-kernel enforcement tests. `#[ignore]` unless run explicitly on a
//! Landlock >= v3 host: `cargo test --test enforcement -- --ignored`.

mod support;
use support::run_spec;

fn system_grants() -> String {
    r#""rox":["/usr","/bin","/sbin","/lib","/lib64"],"ro":["/etc"]"#.to_string()
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn denied_read_is_blocked_and_status_applied() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "x").unwrap();
    let spec = format!(
        r#"{{"command":"cat {}","strict":true,{}}}"#,
        secret.display(),
        system_grants()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
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
    let spec = format!(
        r#"{{"command":": > {}","strict":true,{},"ro":["{}","/etc"]}}"#,
        file.display(),
        r#""rox":["/usr","/bin","/sbin","/lib","/lib64"]"#,
        ro.display()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
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
        new = rw.join("new.txt").display(),
        old = rw.join("old.txt").display(),
        moved = rw2.join("moved.txt").display(),
    );
    let spec = format!(
        r#"{{"command":"{}","strict":true,{},"rw":["{}","{}"]}}"#,
        cmd.replace('"', "\\\""),
        r#""rox":["/usr","/bin","/sbin","/lib","/lib64"],"ro":["/etc"]"#,
        rw.display(),
        rw2.display()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
    assert_eq!(code, 0, "full write set must succeed on rw grants: {status}");
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
    let spec = format!(
        r#"{{"command":"cat {}","strict":true,{}}}"#,
        secret.display(),
        system_grants()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""));
    assert_ne!(code, 0);
}

fn unsafe_getuid() -> u32 {
    // SAFETY (test only): getuid is always safe and never fails.
    unsafe { libc::getuid() }
}
