---
name: artifacts-resolution-failure
scenarios:
  resolver-failure-stops:
    description: ARTIFACTS resolution failure surfaces as RUNBOOK_STOPPED with the typed reason
    commands:
      - |
        node -e '
        const { execFileSync } = require("node:child_process");
        let out = "";
        try {
          out = execFileSync("rd", ["run", "--prompted", "artifacts-resolution-failure.runbook.md"], { encoding: "utf8" });
        } catch (error) {
          out = error.stdout || "";
        }
        const stopped = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === "runbook_stopped");
        if (!stopped) {
          throw new Error("expected runbook_stopped event");
        }
        if (stopped.reason !== "artifact_resolution_failed") {
          throw new Error("expected stopped reason to be artifact_resolution_failed, got " + stopped.reason);
        }
        '
    result: STOP
---
# Artifacts Resolution Failure

## 1. Unbound naked declaration
- ARTIFACTS
  - MissingPath
- PASS COMPLETE
