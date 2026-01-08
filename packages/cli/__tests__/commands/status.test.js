import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, readSession, listWorkflowStates, } from '../helpers/test-utils.js';
describe('status command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('displays current task info', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('status', workspace);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Task 1');
        expect(result.stdout).toContain('First task');
    });
    it('shows workflow file path', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('status', workspace);
        expect(result.stdout).toContain('simple.runbook.md');
    });
    it('shows retryCount/retryMax', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('status', workspace);
        expect(result.stdout).toContain('Retry:');
        expect(result.stdout).toContain('0/3'); // Default: 0 retries of max 3
    });
    it('shows workflow ID', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('status', workspace);
        expect(result.stdout).toContain('ID:');
        expect(result.stdout).toMatch(/wf-\d{4}-\d{2}-\d{2}/);
    });
    it('outputs "No active workflow" when none', async () => {
        const result = runCli('status', workspace);
        expect(result.stdout).toContain('No active workflow');
    });
    it('shows pending tasks count', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('run --task 2', workspace);
        const result = runCli('status', workspace);
        expect(result.stdout).toContain('Pending Tasks');
    });
    it('shows agent bindings', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('run --task 1', workspace);
        runCli('run --agent test-agent', workspace);
        const result = runCli('status', workspace);
        expect(result.stdout).toContain('Agent Bindings');
        expect(result.stdout).toContain('test-agent');
    });
});
describe('list command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('lists all workflow states', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('list', workspace);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('simple.runbook.md');
    });
    it('marks active workflow', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('list', workspace);
        expect(result.stdout).toContain('(active)');
    });
    it('shows current task for each', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('list', workspace);
        expect(result.stdout).toContain('Task 1');
    });
    it('outputs "No workflows" when empty', async () => {
        const result = runCli('list', workspace);
        expect(result.stdout).toContain('No workflows');
    });
});
describe('stop command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('deletes active workflow state', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('stop', workspace);
        const states = await listWorkflowStates(workspace);
        expect(states).toHaveLength(0);
    });
    it('clears active workflow', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('stop', workspace);
        const session = await readSession(workspace);
        expect(session.active).toBeNull();
    });
    it('outputs confirmation', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('stop', workspace);
        expect(result.stdout).toContain('Stopped');
    });
    it('handles no active workflow gracefully', async () => {
        const result = runCli('stop', workspace);
        expect(result.stdout).toContain('No active workflow');
    });
});
describe('complete command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('marks workflow as complete', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('complete', workspace);
        expect(result.stdout).toContain('complete');
    });
    it('clears active workflow', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('complete', workspace);
        const session = await readSession(workspace);
        expect(session.active).toBeNull();
    });
    it('handles --status blocked', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('complete --status blocked', workspace);
        expect(result.stdout).toContain('BLOCKED');
    });
    it('handles no active workflow', async () => {
        const result = runCli('complete', workspace);
        expect(result.stdout).toContain('No active workflow');
    });
});
//# sourceMappingURL=status.test.js.map