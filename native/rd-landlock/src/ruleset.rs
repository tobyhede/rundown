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
/// (default), applied before `restrict_self`. The resulting enforcement
/// status is checked against `spec.strict` — under strict policy, partial
/// kernel enforcement is refused rather than silently accepted, as
/// defense-in-depth on top of the caller-side required-ABI floor gate.
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
    check_enforced(restriction.ruleset, spec.strict)
}

/// Fail closed on insufficient kernel enforcement, strict-aware.
///
/// A `NotEnforced` ruleset means the sandbox silently did nothing (e.g.
/// Landlock absent under the default best-effort compat level), so reporting
/// success would be fail-open — this is refused unconditionally, regardless
/// of `strict`.
///
/// `PartiallyEnforced` means the kernel applied some but not all of the
/// requested restrictions. When `strict` is true, this is refused too: strict
/// policy demands full enforcement, and this check is defense-in-depth on top
/// of the caller-side required-ABI floor gate (`decide`) rather than relying
/// on it alone. When `strict` is false, best-effort downgrade is permitted and
/// partial enforcement is accepted.
///
/// `FullyEnforced` means every requested restriction was applied by the
/// kernel; it is always accepted, regardless of `strict`.
fn check_enforced(status: RulesetStatus, strict: bool) -> Result<(), String> {
    match status {
        RulesetStatus::NotEnforced => {
            Err("landlock ruleset not enforced by kernel (no filesystem restriction applied)".to_string())
        }
        RulesetStatus::PartiallyEnforced if strict => Err(
            "landlock ruleset only partially enforced under strict policy \
             (kernel does not support the full required access set)"
                .to_string(),
        ),
        RulesetStatus::PartiallyEnforced => Ok(()),
        RulesetStatus::FullyEnforced => Ok(()),
    }
}

fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_enforced_rejects_not_enforced_when_strict() {
        let result = check_enforced(RulesetStatus::NotEnforced, true);
        let err = result.expect_err("NotEnforced must be rejected when strict");
        assert!(
            err.contains("not enforced"),
            "error message should mention not enforced, got: {err}"
        );
    }

    #[test]
    fn check_enforced_rejects_not_enforced_when_not_strict() {
        let result = check_enforced(RulesetStatus::NotEnforced, false);
        let err = result.expect_err("NotEnforced must be rejected even when not strict");
        assert!(
            err.contains("not enforced"),
            "error message should mention not enforced, got: {err}"
        );
    }

    #[test]
    fn check_enforced_rejects_partially_enforced_when_strict() {
        let result = check_enforced(RulesetStatus::PartiallyEnforced, true);
        let err = result.expect_err("PartiallyEnforced must be rejected when strict");
        assert!(
            err.contains("partial") || err.contains("strict"),
            "error message should mention partial/strict, got: {err}"
        );
    }

    #[test]
    fn check_enforced_accepts_partially_enforced_when_not_strict() {
        assert!(check_enforced(RulesetStatus::PartiallyEnforced, false).is_ok());
    }

    #[test]
    fn check_enforced_accepts_fully_enforced_when_strict() {
        assert!(check_enforced(RulesetStatus::FullyEnforced, true).is_ok());
    }

    #[test]
    fn check_enforced_accepts_fully_enforced_when_not_strict() {
        assert!(check_enforced(RulesetStatus::FullyEnforced, false).is_ok());
    }
}
