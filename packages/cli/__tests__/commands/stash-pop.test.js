import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, readSession, getActiveState, } from '../helpers/test-utils.js';
describe('stash command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('moves active workflow to stashed', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const beforeSession = await readSession(workspace);
        const workflowId = beforeSession.active;
        runCli('stash', workspace);
        const afterSession = await readSession(workspace);
        expect(afterSession.stashed).toBe(workflowId);
    });
    it('clears active workflow', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('stash', workspace);
        const session = await readSession(workspace);
        expect(session.active).toBeNull();
    });
    it('outputs stash confirmation', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const result = runCli('stash', workspace);
        expect(result.stdout).toContain('stashed');
        expect(result.stdout).toContain('Enforcement paused');
    });
    it('fails if no active workflow', async () => {
        const result = runCli('stash', workspace);
        expect(result.stdout).toContain('No active workflow to stash');
    });
    it('preserves workflow state', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('next', workspace); // Advance to task 2
        const beforeState = await getActiveState(workspace);
        runCli('stash', workspace);
        runCli('pop', workspace);
        const afterState = await getActiveState(workspace);
        expect(afterState?.task).toBe(beforeState?.task);
        expect(afterState?.workflow).toBe(beforeState?.workflow);
    });
});
describe('pop command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('restores stashed workflow to active', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        const beforeSession = await readSession(workspace);
        const workflowId = beforeSession.active;
        runCli('stash', workspace);
        runCli('pop', workspace);
        const afterSession = await readSession(workspace);
        expect(afterSession.active).toBe(workflowId);
    });
    it('clears stashed state', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('stash', workspace);
        runCli('pop', workspace);
        const session = await readSession(workspace);
        expect(session.stashed).toBeNull();
    });
    it('outputs restored workflow info', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('stash', workspace);
        const result = runCli('pop', workspace);
        expect(result.stdout).toContain('restored');
        expect(result.stdout).toContain('Enforcement active');
    });
    it('fails if nothing stashed', async () => {
        const result = runCli('pop', workspace);
        expect(result.stdout).toContain('No stashed workflow');
    });
    it('shows resuming task info', async () => {
        runCli('run runbooks/simple.runbook.md', workspace);
        runCli('next', workspace); // Advance to task 2
        runCli('stash', workspace);
        const result = runCli('pop', workspace);
        expect(result.stdout).toContain('Task 2');
    });
});
//# sourceMappingURL=stash-pop.test.js.map