// packages/cli/__tests__/integration/for-loop-outputs.test.ts
//
// Regression: when a FOR loop variable is shadowed by a CLI --var override,
// OUTPUTS that reference the loop variable must publish the current iteration
// value, not the shadowing override. See mergeExecutionTemplateVars in
// packages/cli/src/helpers/execution-units.ts.

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getAllRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

// FOR loop over {{items}}; substep's OUTPUTS reference the loop variable `item`.
// Each iteration publishes {LastItem: <iter>}; the final merge is the last value.
const FOR_OUTPUTS_RUNBOOK = `---
name: for-outputs-regression
---
# FOR + OUTPUTS regression

## 1. Process items
- FOR item IN {{items}}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Record item
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - LastItem {{ item }}

\`\`\`sh
rd echo --result pass
\`\`\`
`;

describe('FOR loop OUTPUTS regression — CLI-shadowed loop variable', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'for-outputs.runbook.md'), FOR_OUTPUTS_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('publishes the current iteration value for {{item}} even when --var item shadows it', async () => {
    const result = runCli(
      ['run', 'for-outputs.runbook.md', `--var`, `item=stale`, `--var-json`, `items=["a","b","c"]`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    // OUTPUTS now go to state.variables (not outputs.json).
    // After completion, verify the last iteration's value is in state.variables.
    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables: Record<string, unknown> };

    // Last iteration wins after merge; the fresh loop variable must not be
    // shadowed by the CLI-persisted `item=stale`.
    expect(state.variables.LastItem).toBe('c');
    expect(state.variables.LastItem).not.toBe('stale');
  });
});
