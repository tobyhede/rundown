/**
 * Snapshot tests locking the parsed AST shape for runbooks that use
 * name-only OUTPUTS at both step and substep level.
 *
 * These snapshots serve as a regression guard: any change to how the parser
 * handles OUTPUTS declarations will produce a snapshot diff, forcing explicit
 * review before acceptance.
 */

import { describe, it, expect } from '@jest/globals';
import { parseRunbookDocument } from '../src/index.js';

describe('OUTPUTS AST shape — snapshot', () => {
  it('locks the AST for naked-form OUTPUTS at step level', () => {
    const md = `## 1. Capture
- OUTPUTS
  - Version
  - Tag
- PASS CONTINUE
- FAIL STOP

## 2. Parent
### 2.1 Inner capture
- OUTPUTS
  - Inner
- PASS DEFER
- FAIL DEFER
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Snapshot the relevant outputs fields only — avoiding volatile fields
    // (prompt text, command, etc.) that are orthogonal to this feature.
    const outputs = runbook.steps.map((step) => {
      const entry: Record<string, unknown> = {
        kind: step.kind,
        outputs: step.outputs,
      };
      if (step.kind === 'substeps') {
        entry.substepOutputs = step.substeps.map((ss) => ({
          outputs: ss.outputs,
        }));
      }
      return entry;
    });
    expect(outputs).toMatchSnapshot();
  });

  it('locks the full step AST for multiple name-only OUTPUTS', () => {
    const md = `## 1. Deploy
- OUTPUTS
  - DeployUrl
  - Version
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook } = parseRunbookDocument(md);
    // Snapshot only the outputs field for this step.
    expect(runbook.steps[0].outputs).toMatchSnapshot();
  });
});
