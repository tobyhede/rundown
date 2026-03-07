// packages/cli/__tests__/commands/ls.test.ts

import { createTestWorkspace, runCliInProcess } from '../helpers/test-utils.js';

describe('rd ls', () => {
  let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('shows correct step count for naturally completed runbook', async () => {
    // Run in prompted mode to manually step through
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    await runCliInProcess('pass', workspace); // Step 1 -> 2
    await runCliInProcess('pass', workspace); // Step 2 -> DONE

    // Now, run `ls`
    const result = await runCliInProcess('ls', workspace);

    // It should show 2/2
    expect(result.stdout).toContain('complete');
    expect(result.stdout).toContain('2/2');
  });

  it('shows available runbooks with --all flag', async () => {
    const result = await runCliInProcess('ls --all', workspace);
    expect(result.stdout).toContain('NAME');
    expect(result.stdout).toContain('DESCRIPTION');
    expect(result.stdout).toContain('simple');
  });
});
