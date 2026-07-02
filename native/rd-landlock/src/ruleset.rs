//! Ruleset construction and application. The only enforcement code path.

use landlock::{path_beneath_rules, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus};

use crate::abi::{effective_abi, ro_access, rox_access, rw_access};
use crate::spec::Spec;

/// Build and apply the Landlock ruleset to the current thread.
///
/// The handled set is `effective_abi(negotiated).handled_set()` — capped at ABI
/// v3 so it never handles `IOCTL_DEV` (v5) — so every governed access type is
/// denied unless a rule grants it, while device ioctls stay unrestricted.
/// Rights construction goes exclusively through the capped `EffectiveAbi`
/// newtype, so the v3 cap cannot be bypassed. Non-existent grant paths are
/// skipped (Landlock aborts on a missing path). `no_new_privs` is set true
/// (default), applied before `restrict_self`.
pub fn apply_ruleset(negotiated: u32, spec: &Spec) -> Result<(), String> {
    let abi = effective_abi(negotiated); // EffectiveAbi (Copy), capped at v3
    let handled = abi.handled_set();

    let rox: Vec<&String> = spec.rox.iter().filter(|p| exists(p)).collect();
    let ro: Vec<&String> = spec.ro.iter().filter(|p| exists(p)).collect();
    let rw: Vec<&String> = spec.rw.iter().filter(|p| exists(p)).collect();

    let restriction = Ruleset::default()
        .handle_access(handled)
        .map_err(|e| format!("handle_access failed: {e}"))?
        .create()
        .map_err(|e| format!("ruleset create failed: {e}"))?
        .add_rules(path_beneath_rules(rox.iter().map(|p| p.as_str()), rox_access()))
        .map_err(|e| format!("add rox rules failed: {e}"))?
        .add_rules(path_beneath_rules(ro.iter().map(|p| p.as_str()), ro_access()))
        .map_err(|e| format!("add ro rules failed: {e}"))?
        .add_rules(path_beneath_rules(rw.iter().map(|p| p.as_str()), rw_access(abi)))
        .map_err(|e| format!("add rw rules failed: {e}"))?
        .set_no_new_privs(true)
        .restrict_self()
        .map_err(|e| format!("restrict_self failed: {e}"))?;
    check_enforced(restriction.ruleset)
}

/// Fail closed if the kernel enforced no restriction at all. A NotEnforced
/// ruleset means the sandbox silently did nothing (e.g. Landlock absent under
/// the default best-effort compat level), so reporting success would be
/// fail-open. PartiallyEnforced/FullyEnforced both mean real enforcement is in
/// place (the required-ABI floor is already gated earlier by `decide`), so they
/// are accepted — this preserves best-effort downgrade on older kernels while
/// refusing the total-absence case.
fn check_enforced(status: RulesetStatus) -> Result<(), String> {
    match status {
        RulesetStatus::NotEnforced => {
            Err("landlock ruleset not enforced by kernel (no filesystem restriction applied)".to_string())
        }
        RulesetStatus::PartiallyEnforced | RulesetStatus::FullyEnforced => Ok(()),
    }
}

fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_enforced_rejects_not_enforced() {
        let result = check_enforced(RulesetStatus::NotEnforced);
        let err = result.expect_err("NotEnforced must be rejected");
        assert!(
            err.contains("not enforced"),
            "error message should mention not enforced, got: {err}"
        );
    }

    #[test]
    fn check_enforced_accepts_fully_enforced() {
        assert!(check_enforced(RulesetStatus::FullyEnforced).is_ok());
    }

    #[test]
    fn check_enforced_accepts_partially_enforced() {
        assert!(check_enforced(RulesetStatus::PartiallyEnforced).is_ok());
    }
}
