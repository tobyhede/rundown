import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, writeConfig, } from '../helpers/test-utils.js';
describe('gate command', () => {
    let workspace;
    beforeEach(async () => {
        workspace = await createTestWorkspace();
    });
    afterEach(async () => {
        await workspace.cleanup();
    });
    it('loads config from .claude/turboshovel.json', async () => {
        await writeConfig(workspace, {
            gates: {
                test: {
                    description: 'Test gate',
                    command: 'true',
                },
            },
            hooks: {},
        });
        const result = runCli('gate test', workspace);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('PASS');
    });
    it('executes gate command', async () => {
        await writeConfig(workspace, {
            gates: {
                success: {
                    description: 'Success gate',
                    command: 'true',
                },
            },
            hooks: {},
        });
        const result = runCli('gate success', workspace);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Gate success: PASS');
    });
    it('reports success on exit code 0', async () => {
        await writeConfig(workspace, {
            gates: {
                passing: {
                    description: 'Success gate',
                    command: 'true',
                },
            },
            hooks: {},
        });
        const result = runCli('gate passing', workspace);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Gate passing: PASS');
    });
    it('reports failure on non-zero exit', async () => {
        await writeConfig(workspace, {
            gates: {
                failing: {
                    description: 'Fail gate',
                    command: 'false',
                },
            },
            hooks: {},
        });
        const result = runCli('gate failing', workspace);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Gate failing: FAIL');
    });
    it('fails if gate not found in config', async () => {
        await writeConfig(workspace, {
            gates: {
                existing: {
                    description: 'Existing gate',
                    command: 'true',
                },
            },
            hooks: {},
        });
        const result = runCli('gate nonexistent', workspace);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Gate not found: nonexistent');
    });
    it('fails if no config file', async () => {
        const result = runCli('gate test', workspace);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Gate not found: test');
    });
    it('fails if gate has no command', async () => {
        await writeConfig(workspace, {
            gates: {
                nocommand: {
                    description: 'Gate without command',
                },
            },
            hooks: {},
        });
        const result = runCli('gate nocommand', workspace);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Gate has no command: nocommand');
    });
});
//# sourceMappingURL=gate.test.js.map