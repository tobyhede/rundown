import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, } from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
describe('Nested Workflow Integration', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('should complete full parent-child workflow cycle', async () => {
        // 1. Create parent and child runbooks
        const parentWorkflow = `## 1. Dispatch agent

### 1.1
Dispatch work to agent.

- PASS: DONE
`;
        const childWorkflow = `## 1. Do work

Complete the work.

- PASS: DONE
`;
        // Write runbooks to workspace
        const runbooksDir = join(workspace.cwd, 'runbooks');
        await mkdir(runbooksDir, { recursive: true });
        await writeFile(join(runbooksDir, 'parent.runbook.md'), parentWorkflow);
        await writeFile(join(runbooksDir, 'child.runbook.md'), childWorkflow);
        // 2. Start parent workflow
        let result = runCli('run runbooks/parent.runbook.md', workspace);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Started workflow');
        // 3. Queue task with workflow
        result = runCli(['start', '--task', '1.1', 'runbooks/child.runbook.md'], workspace);
        expect(result.stdout).toContain('Task 1.1 queued');
        // 4. Bind agent - should create child workflow
        result = runCli(['start', '--agent', 'test-agent'], workspace);
        expect(result.stdout).toContain('Started child workflow');
        // 5. Complete child workflow
        result = runCli(['next', '--pass'], workspace);
        expect(result.stdout).toContain('Workflow complete');
        // 6. Complete agent in parent
        result = runCli(['next', '--pass', '--agent', 'test-agent'], workspace);
        expect(result.stdout).toContain('marked as pass');
        // 7. Verify parent sees completion
        result = runCli('status', workspace);
        expect(result.stdout).toContain('test-agent: 1.1 [done] - pass');
    });
});
//# sourceMappingURL=nested-workflow.test.js.map