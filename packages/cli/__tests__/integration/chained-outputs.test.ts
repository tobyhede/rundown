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
  - First "value-one"
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Consume first, produce second
- OUTPUTS
  - Second {{First}}
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
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
    const result = runCli('run chained.runbook.md', workspace);
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
