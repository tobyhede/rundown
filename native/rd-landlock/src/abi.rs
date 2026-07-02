//! ABI math: required-floor derivation, per-grant rights sets, and the
//! fail-closed decision. Pure logic — no syscalls.

use crate::spec::Spec;

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
