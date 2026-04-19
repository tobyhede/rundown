// packages/cli/__tests__/integration/for-loop-outputs.test.ts
//
// Regression: when a FOR loop variable is shadowed by a CLI --var override,
// OUTPUTS that reference the loop variable must publish the current iteration
// value, not the shadowing override. This invariant is now enforced by the
// state machine's per-step OUTPUTS evaluation (see buildExecutionFrame).

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

describe('FOR loop OUTPUTS — {{ Index }} captured by frontmatter naked form', () => {
  let workspace: TestWorkspace;

  const INDEX_RUNBOOK = `---
name: for-index-outputs
outputs:
  - LastIndex
---
# FOR Index OUTPUTS Test

## 1. Process items
- FOR i IN 1 TO 3
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Record index
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - LastIndex {{ Index }}

\`\`\`sh
rd echo --result pass
\`\`\`
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'for-index.runbook.md'), INDEX_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('stores last iteration Index in state.variables and propagates to finalVars', async () => {
    const result = runCli('run for-index.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as {
      variables?: Record<string, unknown>;
      finalVars?: Record<string, unknown>;
    };

    // Last iteration (index 3) wins; Index is a string
    expect(state.variables?.LastIndex).toBe('3');
    expect(state.finalVars).toEqual({ LastIndex: '3' });
  });
});

describe('FOR loop Guard 3b — iteration-level CONTINUE exit fires parent storeStepOutputs', () => {
  let workspace: TestWorkspace;

  // Nested forConditionals `  - PASS CONTINUE` cause Guard 3b to fire on each
  // iteration-level PASS, exiting the loop immediately on the first iteration.
  // The parent step's OUTPUTS must still be evaluated via the two-hop mechanism:
  // Guard 3b routes to the parent state (forStack cleared), then the aggregation
  // guard fires and transitions out with storeStepOutputs attached.
  const GUARD_3B_RUNBOOK = `---
name: guard3b-outputs
---
# Guard 3b OUTPUTS Test

## 1. Loop with iteration-level CONTINUE exit
- FOR i IN 1 TO 3
  - PASS CONTINUE
- PASS ALL CONTINUE
- FAIL ANY STOP
- OUTPUTS
  - ExitVar "loop-done"

### 1.1 Do work
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Sink
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'guard3b.runbook.md'), GUARD_3B_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('stores parent OUTPUTS when Guard 3b CONTINUE exit fires', async () => {
    const result = runCli('run guard3b.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };

    expect(state.variables?.ExitVar).toBe('loop-done');
  });
});
