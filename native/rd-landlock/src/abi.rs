//! ABI math: required-floor derivation, per-grant rights sets, and the
//! fail-closed decision. Pure logic — no syscalls.

use crate::spec::Spec;
use landlock::{Access, AccessFs, BitFlags, ABI};

/// Derive the required Landlock ABI floor from the policy.
///
/// `1` is baseline (any filesystem enforcement). The floor rises to `3`
/// (`TRUNCATE`, kernel 6.2) as soon as the spec has any non-writable grant
/// (`ro` or `rox`), because a truncatable read-only path is not read-only.
pub fn required_abi(spec: &Spec) -> u32 {
    if spec.ro.is_empty() && spec.rox.is_empty() {
        1
    } else {
        3
    }
}

/// A Landlock ABI value **already capped at v3** by [`effective_abi`]. The
/// inner `ABI` is private, so the only way to obtain an `EffectiveAbi` — and
/// therefore the only way to build any rights set — is through `effective_abi`.
/// This makes bypassing the v3 cap (which would start handling `IOCTL_DEV` on
/// v5 kernels) unrepresentable in the type system.
///
/// `landlock` 0.4.1's `ABI` only unconditionally derives `Copy`/`Clone` — its
/// `Debug`/`PartialEq`/`Eq` impls are gated behind the *landlock crate's own*
/// `cfg(test)`, so they are not visible to downstream crates. `Debug`,
/// `PartialEq`, and `Eq` are therefore implemented by hand below, comparing
/// and printing the enum's `u32` discriminant (valid for any fieldless enum
/// cast), which is equivalent to what a derived `PartialEq`/`Eq` would have
/// done had `ABI` exposed them.
#[derive(Clone, Copy)]
pub struct EffectiveAbi(ABI);

impl std::fmt::Debug for EffectiveAbi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("EffectiveAbi")
            .field(&(self.0 as u32))
            .finish()
    }
}

impl PartialEq for EffectiveAbi {
    fn eq(&self, other: &Self) -> bool {
        self.0 as u32 == other.0 as u32
    }
}

impl Eq for EffectiveAbi {}

impl EffectiveAbi {
    /// The full handled set for this capped ABI (`AccessFs::from_all`, never
    /// above v3), so `IOCTL_DEV` and newer rights are left unhandled.
    pub fn handled_set(self) -> BitFlags<AccessFs> {
        AccessFs::from_all(self.0)
    }
}

/// Map a numeric ABI to the `landlock` crate's `ABI` enum, clamped to the
/// highest variant this build knows about. Private: callers reach it only via
/// `effective_abi`, so an uncapped ABI cannot escape into rights construction.
fn abi_from_u32(n: u32) -> ABI {
    match n {
        0 | 1 => ABI::V1,
        2 => ABI::V2,
        3 => ABI::V3,
        4 => ABI::V4,
        _ => ABI::V5,
    }
}

/// Cap the FS handling at ABI v3 and wrap it so callers cannot pass an uncapped
/// ABI into rights construction.
///
/// v3 gives us the `TRUNCATE` right the read-only guarantee needs, while
/// capping keeps every right introduced *above* v3 (`IOCTL_DEV` at v5, and
/// anything newer) out of the handled set, so the kernel leaves those
/// operations unrestricted — matching the out-of-scope note and avoiding
/// regressions like denying `ioctl()` on `/dev/null`.
pub fn effective_abi(negotiated: u32) -> EffectiveAbi {
    EffectiveAbi(abi_from_u32(negotiated.min(3)))
}

/// Read-only rights: read a file and list a directory, nothing else.
/// Deliberately excludes EXECUTE and TRUNCATE so the path cannot be run or
/// emptied. These two flags are ABI-v1 stable, so a literal is correct.
pub fn ro_access() -> BitFlags<AccessFs> {
    AccessFs::ReadFile | AccessFs::ReadDir
}

/// Read + execute rights: the read-only set plus EXECUTE (for `/usr`, `/bin`, …).
pub fn rox_access() -> BitFlags<AccessFs> {
    ro_access() | AccessFs::Execute
}

/// Full write set: the capped ABI's handled set *minus* EXECUTE. Because it
/// takes an [`EffectiveAbi`], `from_all` is capped at v3 and never includes
/// `IOCTL_DEV` (v5). Covers new rights up to v3 automatically; matches
/// `landrun --rw` (not `--rwx`). WRITE_FILE and TRUNCATE are paired so `>`
/// truncation still works once TRUNCATE is in the handled set.
pub fn rw_access(abi: EffectiveAbi) -> BitFlags<AccessFs> {
    abi.handled_set() & !AccessFs::Execute
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::parse_spec;

    #[test]
    fn floor_is_three_when_any_readonly_grant_present() {
        let spec = parse_spec(r#"{"command":"x","rox":["/usr"]}"#).unwrap();
        assert_eq!(required_abi(&spec), 3);
    }

    #[test]
    fn floor_is_three_for_ro_only() {
        let spec = parse_spec(r#"{"command":"x","ro":["/etc"]}"#).unwrap();
        assert_eq!(required_abi(&spec), 3);
    }

    #[test]
    fn floor_is_one_for_all_writable_policy() {
        let spec = parse_spec(r#"{"command":"x","rw":["/tmp"]}"#).unwrap();
        assert_eq!(required_abi(&spec), 1);
    }
}

#[cfg(test)]
mod rights_tests {
    use super::*;

    #[test]
    fn ro_is_read_only_no_exec_no_truncate() {
        let ro = ro_access();
        assert!(ro.contains(AccessFs::ReadFile));
        assert!(ro.contains(AccessFs::ReadDir));
        assert!(!ro.contains(AccessFs::Execute));
        assert!(!ro.contains(AccessFs::Truncate));
        assert!(!ro.contains(AccessFs::WriteFile));
    }

    #[test]
    fn rox_adds_execute_to_ro() {
        assert_eq!(rox_access(), ro_access() | AccessFs::Execute);
    }

    #[test]
    fn rw_has_full_write_set_and_truncate_but_no_execute() {
        let rw = rw_access(effective_abi(3));
        assert!(rw.contains(AccessFs::WriteFile));
        assert!(rw.contains(AccessFs::Truncate));
        assert!(rw.contains(AccessFs::RemoveFile));
        assert!(rw.contains(AccessFs::RemoveDir));
        assert!(rw.contains(AccessFs::MakeReg));
        assert!(!rw.contains(AccessFs::Execute));
    }

    #[test]
    fn rw_includes_refer_at_abi_v2_and_above() {
        assert!(rw_access(effective_abi(2)).contains(AccessFs::Refer));
        assert!(rw_access(effective_abi(3)).contains(AccessFs::Refer));
    }

    #[test]
    fn effective_abi_caps_above_v3() {
        // Every numeric ABI ≥ 3 collapses to the same capped value.
        assert_eq!(effective_abi(4), effective_abi(3));
        assert_eq!(effective_abi(5), effective_abi(3));
    }

    #[test]
    fn rights_only_reachable_through_capped_type_no_ioctl_dev() {
        // The ONLY way to build rights is through EffectiveAbi (rw_access's
        // parameter type), and EffectiveAbi's only constructor is effective_abi,
        // which caps at v3 — so even on a v5 kernel the handled set gains
        // TRUNCATE (v3) but never IOCTL_DEV (v5), and device ioctls stay
        // unrestricted (e.g. ioctl on /dev/null keeps working).
        let capped = effective_abi(5);
        let handled = capped.handled_set();
        assert!(handled.contains(AccessFs::Truncate));
        assert!(!handled.contains(AccessFs::IoctlDev));
        assert!(!rw_access(capped).contains(AccessFs::IoctlDev));
    }
}

/// Outcome of comparing the negotiated ABI against the required floor.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Apply the ruleset and exec. `downgraded` is true only when the
    /// negotiated ABI is below the required floor and strict was disabled.
    Apply { downgraded: bool },
    /// Refuse: negotiated ABI is below the required floor under strict mode.
    /// `missing` names the first right that cannot be enforced.
    Deny { missing: &'static str },
}

/// Fail-closed decision, atomic with the syscall that read `negotiated`.
///
/// * negotiated ≥ required → apply, not downgraded.
/// * negotiated < required, strict → deny (naming the missing right).
/// * negotiated < required, !strict → apply best-effort, downgraded.
pub fn decide(negotiated: u32, required: u32, strict: bool) -> Decision {
    if negotiated >= required {
        Decision::Apply { downgraded: false }
    } else if strict {
        // required rises to 3 only for TRUNCATE, so TRUNCATE is the gap.
        Decision::Deny { missing: "TRUNCATE" }
    } else {
        Decision::Apply { downgraded: true }
    }
}

#[cfg(test)]
mod decision_tests {
    use super::*;

    #[test]
    fn applies_when_negotiated_meets_floor() {
        assert_eq!(decide(3, 3, true), Decision::Apply { downgraded: false });
        assert_eq!(decide(5, 3, true), Decision::Apply { downgraded: false });
    }

    #[test]
    fn denies_below_floor_under_strict() {
        assert_eq!(decide(2, 3, true), Decision::Deny { missing: "TRUNCATE" });
    }

    #[test]
    fn downgrades_below_floor_when_not_strict() {
        assert_eq!(decide(2, 3, false), Decision::Apply { downgraded: true });
    }
}
