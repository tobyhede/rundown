import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { createTestWorkspace, runCli, } from './helpers/test-utils.js';
describe('error handling', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    describe('WorkflowSyntaxError', () => {
        it('displays parsing errors clearly', async () => {
            // Create invalid workflow
            const invalidWorkflow = `
# Not a valid workflow
This doesn't have proper ## headers
`;
            await writeFile(join(workspace.cwd, 'invalid.md'), invalidWorkflow);
            const result = runCli('run invalid.md', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('Syntax error');
        });
        it('handles empty workflow file', async () => {
            await writeFile(join(workspace.cwd, 'empty.md'), '');
            const result = runCli('run empty.md', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('Syntax error');
        });
    });
    describe('file not found', () => {
        it('handles missing workflow file', async () => {
            const result = runCli('run nonexistent.md', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('not found');
        });
    });
    describe('invalid state', () => {
        it('handles corrupted state file', async () => {
            // Start a workflow
            runCli('run runbooks/simple.runbook.md', workspace);
            // Corrupt the state file
            const stateDir = workspace.statePath();
            const stateFiles = await import('fs/promises').then((fs) => fs.readdir(stateDir));
            const stateFile = stateFiles.find((f) => f.endsWith('.json'));
            if (stateFile) {
                await writeFile(join(stateDir, stateFile), 'not valid json');
            }
            // Try to use the workflow
            const result = runCli('next', workspace);
            // Should handle gracefully (may show error or "no active workflow")
            expect(result.exitCode).toBe(0); // May fallback to "no active workflow"
        });
    });
    describe('invalid arguments', () => {
        it('shows help on unknown command', async () => {
            const result = runCli('unknowncommand', workspace);
            expect(result.stderr.length).toBeGreaterThan(0);
        });
        it('shows specific error for invalid task format', async () => {
            runCli('run runbooks/simple.runbook.md', workspace);
            const result = runCli('run --task invalid-format', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('Invalid task ID');
        });
    });
});
//# sourceMappingURL=error-handling.test.js.map