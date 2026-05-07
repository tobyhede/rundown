// packages/cli/__tests__/integration/for-loop-outputs.test.ts
//
// Regression coverage for FOR loops publishing naked OUTPUTS through the
// per-step RD_OUTPUTS channel files.

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getAllRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

// FOR loop over {{items}}; substep's command writes the loop variable `entry`.
// Each iteration publishes {LastItem: <iter>}; the final merge is the last value.
const FOR_OUTPUTS_RUNBOOK = `---
name: for-outputs-regression
---
# FOR + OUTPUTS regression

## 1. Process items
- FOR entry IN {{items}}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Record item
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - LastItem

\`\`\`sh
printf '{{ entry }}' > "$RD_OUTPUTS_LastItem"
\`\`\`
`;

describe('FOR loop OUTPUTS regression — sourced loop variable', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'for-outputs.runbook.md'), FOR_OUTPUTS_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('publishes the current iteration value for the sourced loop variable', async () => {
    const result = runCli(
      ['run', 'for-outputs.runbook.md', `--input-json`, `items=["a","b","c"]`, `--allow-all`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    // OUTPUTS now go to state.variables (not outputs.json).
    // After completion, verify the last iteration's value is in state.variables.
    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables: Record<string, unknown> };

    // Last iteration wins after merge.
    expect(state.variables.LastItem).toBe('c');
  });
});

describe('FOR loop OUTPUTS — {{ Index }} bare template reference in substep command', () => {
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
  - LastIndex

\`\`\`sh
printf '{{ Index }}' > "$RD_OUTPUTS_LastIndex"
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
    const result = runCli('run for-index.runbook.md --allow-all', workspace);
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

describe('FOR loop Guard 3b — iteration-level CONTINUE exit stores substep OUTPUTS', () => {
  let workspace: TestWorkspace;

  // Nested forConditionals `  - PASS CONTINUE` cause Guard 3b to fire on each
  // iteration-level PASS, exiting the loop immediately on the first iteration.
  // The substep's naked OUTPUTS channel must be captured before the loop exits.
  const GUARD_3B_RUNBOOK = `---
name: guard3b-outputs
---
# Guard 3b OUTPUTS Test

## 1. Loop with iteration-level CONTINUE exit
- FOR i IN 1 TO 3
  - PASS CONTINUE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Do work
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - ExitVar

\`\`\`sh
printf 'loop-done' > "$RD_OUTPUTS_ExitVar"
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

  it('stores substep OUTPUTS when Guard 3b CONTINUE exit fires', async () => {
    const result = runCli('run guard3b.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };

    expect(state.variables?.ExitVar).toBe('loop-done');
  });
});
