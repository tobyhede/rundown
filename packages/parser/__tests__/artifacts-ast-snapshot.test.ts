/**
 * Snapshot tests locking the parsed AST shape for runbooks that use the
 * ARTIFACTS directive at step and substep level.
 *
 * These snapshots serve as a regression guard: any change to how the parser
 * emits ArtifactDeclaration values will produce a snapshot diff, forcing
 * explicit review before acceptance.
 */

import { describe, it, expect } from '@jest/globals';
import { parseRunbookDocument } from '../src/index.js';

describe('ARTIFACTS AST shape — snapshot', () => {
  it('locks the AST for exact + wildcard ARTIFACTS at step level', () => {
    const md = `## 1. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
  - Reviews "*-reviews.json"
- PASS CONTINUE
- FAIL STOP

## 2. Parent
### 2.1 Inner capture
- ARTIFACTS
  - InnerPath "inner.json"
- PASS DEFER
- FAIL DEFER
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const artifacts = runbook.steps.map((step) => {
      const entry: Record<string, unknown> = {
        kind: step.kind,
        artifacts: step.artifacts,
      };
      if (step.kind === 'substeps') {
        entry.substepArtifacts = step.substeps.map((ss) => ({
          artifacts: ss.artifacts,
        }));
      }
      return entry;
    });
    expect(artifacts).toMatchSnapshot();
  });

  it('locks the AST for same-name ARTIFACTS + OUTPUTS pair', () => {
    const md = `## 1. Pair
- ARTIFACTS
  - PlanPath "plan.json"
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook } = parseRunbookDocument(md);
    expect({
      artifacts: runbook.steps[0].artifacts,
      outputs: runbook.steps[0].outputs,
    }).toMatchSnapshot();
  });
});
