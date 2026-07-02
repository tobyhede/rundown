//! JSON spec read from fd 3: grant categories, strict flag, and the command.

use serde::Deserialize;

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
    }

    #[test]
    fn strict_defaults_true_and_grants_default_empty() {
        let spec = parse_spec(r#"{"command":"true"}"#).expect("parse");
        assert!(spec.strict);
        assert!(spec.ro.is_empty() && spec.rox.is_empty() && spec.rw.is_empty());
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_spec("{ not json").unwrap_err();
        assert!(err.contains("invalid spec JSON"));
    }
}
