---
name: artifacts-scenario
scenarios:
  global-artifact-variable:
    description: ARTIFACTS populate global variables and step_entered payloads
    commands:
      - |
        node -e '
        const { execFileSync } = require("node:child_process");
        const out = execFileSync("rd", ["run", "--prompted", "artifacts-scenario.runbook.md"], { encoding: "utf8" });
        const entered = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === "step_entered");
        if (entered?.artifacts?.PlanPath?.key !== "plan.json") {
          throw new Error("expected PlanPath artifact in step_entered payload");
        }
        '
      - |
        node -e '
        const { execFileSync } = require("node:child_process");
        const out = execFileSync("rd", ["pass"], { encoding: "utf8" });
        const entered = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === "step_entered");
        if (entered?.artifacts?.PlanPath?.key !== "plan.json") {
          throw new Error("expected naked ARTIFACTS to rehydrate PlanPath from global variables");
        }
        '
      - |
        node -e '
        const { execFileSync } = require("node:child_process");
        const out = execFileSync("rd", ["pass"], { encoding: "utf8" });
        const entered = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === "step_entered");
        if (!entered.hasOwnProperty("artifacts") || Object.keys(entered.artifacts).length !== 0) {
          throw new Error("expected empty artifacts payload for no-ARTIFACTS step");
        }
        '
      - rd pass
    result: COMPLETE
---
# Artifacts Scenario

## 1. Produce

- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE

## 2. Consume

- ARTIFACTS
  - PlanPath
- PASS CONTINUE

## 3. Finish

- PASS COMPLETE
