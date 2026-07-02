//! The single typed status line written to fd 4 before any exec.

use serde::Serialize;

/// Typed fd-4 status. Serialized as a tagged JSON object on the `status` key.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Status {
    /// Ruleset applied; `abi` is the negotiated ABI actually enforced.
    Applied { abi: u32, downgraded: bool },
    /// Policy refused: `abi` fell below the required floor; `missing` names the gap.
    Denied { abi: u32, missing: String },
    /// The helper failed before applying/execing; enforcement state unknown.
    Error { message: String },
}

/// Render the status as exactly one newline-terminated JSON line.
pub fn to_status_line(status: &Status) -> String {
    let body = serde_json::to_string(status)
        .unwrap_or_else(|_| r#"{"status":"error","message":"status serialize failed"}"#.to_string());
    format!("{body}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applied_line_carries_abi_and_downgraded() {
        let line = to_status_line(&Status::Applied { abi: 3, downgraded: false });
        assert_eq!(line, "{\"status\":\"applied\",\"abi\":3,\"downgraded\":false}\n");
    }

    #[test]
    fn denied_line_names_missing_right() {
        let line = to_status_line(&Status::Denied { abi: 2, missing: "TRUNCATE".into() });
        assert_eq!(
            line,
            "{\"status\":\"denied\",\"abi\":2,\"missing\":\"TRUNCATE\"}\n"
        );
    }

    #[test]
    fn error_line_carries_message() {
        let line = to_status_line(&Status::Error { message: "boom".into() });
        assert_eq!(line, "{\"status\":\"error\",\"message\":\"boom\"}\n");
    }
}
