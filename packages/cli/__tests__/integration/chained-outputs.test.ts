// packages/cli/__tests__/integration/chained-outputs.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getAllRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Two-step runbook where step 2's OUTPUTS references step 1's OUTPUTS.
 * Exercises the execution-loop path (rd run auto-progresses via rd echo).
 */
const CHAINED_RUNBOOK = `---
name: chained-outputs-test
---
# Chained OUTPUTS Test

## 1. Produce first
- OUTPUTS
  - First
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
printf 'value-one' > "$RD_OUTPUTS_First"
\`\`\`

## 2. Consume first, produce second
- OUTPUTS
  - Second
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
printf '{{First}}' > "$RD_OUTPUTS_Second"
\`\`\`
`;

describe('chained OUTPUTS — execution-loop path', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'chained.runbook.md'), CHAINED_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('step 2 OUTPUTS sees First from step 1 via state.variables', async () => {
    const result = runCli('run chained.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables?.First).toBe('value-one');
    // Without the state.variables merge in execution.ts, Second evaluates to the
    // literal string '{{First}}' (expandLoopVariables preserves unresolved refs).
    expect(state.variables?.Second).toBe('value-one');
  });
});

describe('chained OUTPUTS — overwrite preserved across terminal COMPLETE', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('step 2 OUTPUTS overwrites step 1 value; final state has step 2 value', async () => {
    const OVERWRITE_RUNBOOK = `---
name: outputs-overwrite-test
---
# OUTPUTS Overwrite Test

## 1. Set initial
- OUTPUTS
  - Counter
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
printf 'one' > "$RD_OUTPUTS_Counter"
\`\`\`

## 2. Overwrite + complete
- OUTPUTS
  - Counter
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
printf 'two' > "$RD_OUTPUTS_Counter"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'overwrite.runbook.md'), OVERWRITE_RUNBOOK);

    const result = runCli('run overwrite.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };
    // Without the fix, state.variables.Counter === 'one' because the orchestrator
    // writes {...updatedState.variables, completed: true}, where updatedState is
    // the pre-OUTPUTS snapshot. manager.update merges with storage, so the stale
    // 'one' in the update payload overrides the freshly-written 'two' in storage.
    expect(state.variables?.Counter).toBe('two');
  });
});
