//! JSON spec read from fd 3: grant categories, strict flag, and the command.

use serde::{Deserialize, Serialize};

/// Network access posture requested by core.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum NetworkPolicy {
    /// Install the seccomp network-denial filter before exec.
    Deny,
    /// Do not install the network filter.
    Allow,
}

fn default_network() -> NetworkPolicy {
    NetworkPolicy::Deny
}

/// Ruleset inputs delivered to the helper over fd 3.
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Spec {
    /// Shell command to exec as `/bin/sh -c <command>`.
    pub command: String,
    /// When true, refuse if the negotiated ABI is below the required floor.
    #[serde(default = "default_strict")]
    pub strict: bool,
    /// Read-only grants (READ_FILE + READ_DIR).
    #[serde(default)]
    pub ro: Vec<String>,
    /// Read + execute grants.
    #[serde(default)]
    pub rox: Vec<String>,
    /// Read-write grants (full write set).
    #[serde(default)]
    pub rw: Vec<String>,
    /// Network posture. Defaults closed for older/malformed callers.
    #[serde(default = "default_network")]
    pub network: NetworkPolicy,
}

fn default_strict() -> bool {
    true
}

/// Parse the fd-3 JSON spec.
///
/// Returns a human-readable error string on malformed JSON or a missing
/// `command`.
pub fn parse_spec(json: &str) -> Result<Spec, String> {
    serde_json::from_str::<Spec>(json).map_err(|e| format!("invalid spec JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_spec() {
        let json = r#"{"command":"echo hi","strict":true,
            "ro":["/etc"],"rox":["/usr"],"rw":["/tmp"]}"#;
        let spec = parse_spec(json).expect("parse");
        assert_eq!(spec.command, "echo hi");
        assert!(spec.strict);
        assert_eq!(spec.ro, vec!["/etc".to_string()]);
        assert_eq!(spec.rox, vec!["/usr".to_string()]);
        assert_eq!(spec.rw, vec!["/tmp".to_string()]);
        assert_eq!(spec.network, NetworkPolicy::Deny);
    }

    #[test]
    fn strict_defaults_true_and_grants_default_empty() {
        let spec = parse_spec(r#"{"command":"true"}"#).expect("parse");
        assert!(spec.strict);
        assert!(spec.ro.is_empty() && spec.rox.is_empty() && spec.rw.is_empty());
    }

    #[test]
    fn network_defaults_to_deny() {
        let spec = parse_spec(r#"{"command":"true"}"#).expect("parse");
        assert_eq!(spec.network, NetworkPolicy::Deny);
    }

    #[test]
    fn parses_network_allow() {
        let spec = parse_spec(r#"{"command":"true","network":"allow"}"#).expect("parse");
        assert_eq!(spec.network, NetworkPolicy::Allow);
    }

    #[test]
    fn rejects_invalid_network_value() {
        let err = parse_spec(r#"{"command":"true","network":"maybe"}"#).unwrap_err();
        assert!(err.contains("invalid spec JSON"), "error: {err}");
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_spec("{ not json").unwrap_err();
        assert!(err.contains("invalid spec JSON"));
    }
}

#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// `parse_spec` reads untrusted fd-3 input: for any input at all it must
        /// return `Ok`/`Err`, never panic. An `Ok` result is well-formed by
        /// construction (serde populated every required `Spec` field).
        #[test]
        fn parse_spec_never_panics(s in prop::collection::vec(any::<char>(), 0..256)
            .prop_map(|cs| cs.into_iter().collect::<String>()))
        {
            match parse_spec(&s) {
                Ok(spec) => {
                    // Reachable at all only if serde fully populated `Spec` —
                    // touch every field so a future required-field regression
                    // (a field serde could leave partially defaulted) is caught.
                    let _ = (spec.command, spec.strict, spec.ro, spec.rox, spec.rw, spec.network);
                }
                Err(e) => prop_assert!(!e.is_empty()),
            }
        }
    }
}
