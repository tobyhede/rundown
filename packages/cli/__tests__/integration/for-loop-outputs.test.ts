// packages/cli/__tests__/integration/for-loop-outputs.test.ts
//
// Regression: when a FOR loop variable is shadowed by a CLI --var override,
// OUTPUTS that reference the loop variable must publish the current iteration
// value, not the shadowing override. See mergeExecutionTemplateVars in
// packages/cli/src/helpers/execution-units.ts.

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';

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
    const contextId = 'for-outputs-ctx';

    const result = runCli(
      [
        'run',
        'for-outputs.runbook.md',
        `--var`,
        `ContextId=${contextId}`,
        `--var`,
        `item=stale`,
        `--var-json`,
        `items=["a","b","c"]`,
      ],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;

    // Last iteration wins after merge; the fresh loop variable must not be
    // shadowed by the CLI-persisted `item=stale`.
    expect(outputs.LastItem).toBe('c');
    expect(outputs.LastItem).not.toBe('stale');
  });
});
