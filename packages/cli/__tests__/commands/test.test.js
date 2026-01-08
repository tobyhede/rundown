import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, } from '../helpers/test-utils.js';
describe('test command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('exists and shows help', () => {
        const result = runCli('test --help', workspace);
        expect(result.stdout).toContain('Test command');
    });
    describe('result sequence', () => {
        beforeEach(async () => {
            // Start a workflow first
            runCli('run runbooks/retry.runbook.md', workspace);
        });
        it('returns pass by default (no flags)', () => {
            const result = runCli('test npm install', workspace);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('-> PASS');
        });
        it('returns pass with explicit --result pass', () => {
            const result = runCli('test --result pass npm install', workspace);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('-> PASS');
        });
        it('returns fail with --result fail', () => {
            const result = runCli('test --result fail npm install', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stdout).toContain('-> FAIL');
        });
        it('uses retry count to index into sequence', async () => {
            // First invocation: retryCount=0 -> fail
            let result = runCli('test --result fail --result pass npm test', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stdout).toContain('-> FAIL');
            expect(result.stdout).toContain('attempt 1/');
            // Simulate retry via CLI (increments retryCount)
            runCli('next --retry', workspace);
            // Second invocation: retryCount=1 -> pass
            result = runCli('test --result fail --result pass npm test', workspace);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('-> PASS');
            expect(result.stdout).toContain('attempt 2/');
        });
        it('sticks on last result when retry exceeds sequence', async () => {
            // Sequence is [fail, pass], retry twice to get retryCount=2
            runCli('next --retry', workspace); // retryCount=1
            runCli('next --retry', workspace); // retryCount=2
            // retryCount=2, sequence length=2, should stick on index 1 (pass)
            const result = runCli('test --result fail --result pass npm test', workspace);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('-> PASS');
        });
    });
    describe('error handling', () => {
        it('fails when no active workflow', () => {
            const result = runCli('test npm install', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('No active workflow');
        });
        it('fails with invalid result value', () => {
            runCli('run runbooks/simple.runbook.md', workspace);
            const result = runCli('test --result maybe npm install', workspace);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('Invalid result');
        });
    });
});
//# sourceMappingURL=test.test.js.map