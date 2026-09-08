import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildGotoContextResult } from '../../src/helpers/goto-workflow.js';

// The launch-local `--prompted --step` jump resolves through the same core
// navigation seam as standalone GOTO, and `renderNavigationRefusal` returns
// `false` for `none` — an empty-stack no-op rather than a failure. `goto.ts`
// honours that; this suite pins that `run` does too.
//
// The `none` arm cannot be reached from a real launch: `run` always names its
// fresh run with `runId` (or its `claimId`), so the seam's target selector is
// never `{kind:'default'}`, which is the only selector that resolves to `none`.
// That is precisely why the arm needs a seam to be observed at — the same
// reasoning that put `renderNavigationRefusal`'s own unreachable arms
// (`claim_bearer_mismatch`, #613) under a named dispatcher. The real module is
// imported first and re-exported wholesale so only the one resolution under
// test is substituted; every other export stays the production one.
const actualGotoWorkflow = await import('../../src/helpers/goto-workflow.js');
const buildGotoContext = jest.fn<() => Promise<BuildGotoContextResult>>();
jest.unstable_mockModule('../../src/helpers/goto-workflow.js', () => ({
  ...actualGotoWorkflow,
  buildGotoContext,
}));

const { createTestWorkspace, runCliInProcess } = await import('../helpers/test-utils.js');
type TestWorkspace = Awaited<ReturnType<typeof createTestWorkspace>>;

const RUNBOOK = `## 1. First
- PASS CONTINUE

First step.

## 2. Second
- PASS COMPLETE

Second step.
`;

describe('run --prompted --step navigation refusal', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'jump.runbook.md'), RUNBOOK);
    buildGotoContext.mockReset();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('exits 0 on an empty-stack no-op rather than reporting a failure', async () => {
    buildGotoContext.mockResolvedValue({ kind: 'none' });

    const result = await runCliInProcess('run --prompted jump.runbook.md --step 2', workspace);

    expect(buildGotoContext).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  it('still exits 1 on a refusal that is a real failure', async () => {
    // Anti-vacuity: honouring the return value must not flatten every refusal
    // to success. `unknown_run` reports `true` and keeps the non-zero exit.
    buildGotoContext.mockResolvedValue({
      kind: 'unknown_run',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'Run rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa not found',
    } as BuildGotoContextResult);

    const result = await runCliInProcess('run --prompted jump.runbook.md --step 2', workspace);

    expect(result.exitCode).toBe(1);
  });
});
