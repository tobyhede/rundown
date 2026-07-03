//! Proves the REAL `rd-landlock` binary emits the `error` status wire that
//! core's TS reader parses. Unlike `tests/enforcement.rs`, this does NOT
//! require a Landlock kernel: a spec-JSON parse failure is returned from
//! `compute()` before ABI negotiation or ruleset application ever run (see
//! `main::compute`), so this test runs un-`#[ignore]`d in normal `cargo
//! test`, exercising the real error wire end-to-end: spec read → parse_spec
//! fail → `Status::Error` written to fd-4 → non-zero exit.

mod support;
use support::run_spec;

#[test]
fn malformed_spec_json_reports_error_status_and_nonzero_exit() {
    let (status, code) = run_spec("this is not json {{{");
    assert!(status.contains("\"status\":\"error\""), "status: {status}");
    assert_ne!(code, 0, "a spec parse failure must not report exit 0");
}
