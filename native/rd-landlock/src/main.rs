#![deny(unsafe_code)]

mod abi;
mod probe;
mod ruleset;
mod spec;
mod status;
mod sys;

use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::Command;

use abi::{decide, required_abi, Decision};
use status::{to_status_line, Status};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("rd-landlock {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--probe") {
        probe::run();
        return;
    }
    std::process::exit(run());
}

/// Full protocol run. Returns the process exit code for `denied`/`error`
/// outcomes; on `applied` it `exec`s and never returns.
///
/// **Status-before-exec contract:** the command is `exec`'d ONLY after the fd-4
/// status line is fully written *and* flushed. If either fails, the helper does
/// NOT `exec` — it exits non-zero (EX_IOERR). Core must never be left observing
/// a running-but-unreported command, so a broken fd-4 can never yield a running
/// command with no status.
fn run() -> i32 {
    let mut status_out = match sys::status_writer() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("rd-landlock: {e}");
            return 71; // EX_OSERR — no status channel to report on.
        }
    };

    let outcome = compute();
    let status = match &outcome {
        Ok((status, _spec)) => status.clone(),
        Err(status) => status.clone(),
    };

    // Write exactly one status line, then flush — BOTH must succeed before exec.
    if let Err(e) = status_out
        .write_all(to_status_line(&status).as_bytes())
        .and_then(|()| status_out.flush())
    {
        eprintln!("rd-landlock: failed to write/flush fd-4 status: {e}");
        return 74; // EX_IOERR — do NOT exec; no reliable status was delivered.
    }

    match outcome {
        Ok((Status::Applied { .. }, spec)) => {
            // Status was fully written+flushed above, so it is safe to exec.
            // Never returns on success; the command *becomes* the process.
            let err = Command::new("/bin/sh").arg("-c").arg(&spec.command).exec();
            eprintln!("rd-landlock: exec failed: {err}");
            127
        }
        Ok((Status::Denied { .. }, _)) => 126,
        _ => 1,
    }
}

/// Read + parse + decide + apply. Returns the applied status and spec on
/// success, or an already-typed error/denied status.
fn compute() -> Result<(Status, spec::Spec), Status> {
    let mut reader = sys::spec_reader().map_err(|e| Status::Error { message: e })?;
    let mut buf = String::new();
    reader
        .read_to_string(&mut buf)
        .map_err(|e| Status::Error { message: format!("read fd3: {e}") })?;
    let spec = spec::parse_spec(&buf).map_err(|e| Status::Error { message: e })?;

    let negotiated = sys::read_abi_version().map_err(|e| Status::Error { message: e })?;
    let required = required_abi(&spec);

    match decide(negotiated, required, spec.strict) {
        Decision::Deny { missing } => Err(Status::Denied {
            abi: negotiated,
            missing: missing.to_string(),
        }),
        Decision::Apply { downgraded } => {
            ruleset::apply_ruleset(negotiated, &spec)
                .map_err(|e| Status::Error { message: e })?;
            Ok((Status::Applied { abi: negotiated, downgraded }, spec))
        }
    }
}
