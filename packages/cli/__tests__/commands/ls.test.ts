// packages/cli/__tests__/commands/ls.test.ts

import { createTestWorkspace, runCli } from '../helpers/test-utils.js';

describe('rd ls', () => {
  let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('shows correct step count for naturally completed runbook', () => {
    // Run in prompted mode to manually step through
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('pass', workspace); // Step 1 -> 2
    runCli('pass', workspace); // Step 2 -> DONE

    // Now, run `ls`
    const result = runCli('ls', workspace);

    // It should show 2/2
    expect(result.stdout).toContain('complete');
    expect(result.stdout).toContain('2/2');
  });

  it('shows available runbooks with --all flag', () => {
    const result = runCli('ls --all', workspace);
    expect(result.stdout).toContain('Available runbooks:');
    expect(result.stdout).toContain('simple');
  });
});
