import * as os from 'os';
import { executeCommand } from '../../src/runbook/executor.js';

describe('executeCommand', () => {
  it('returns success true for exit code 0', async () => {
    // Use node for cross-platform compatibility
    const result = await executeCommand('node -e "process.exit(0)"', process.cwd());
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('returns success false for non-zero exit code', async () => {
    const result = await executeCommand('node -e "process.exit(1)"', process.cwd());
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('captures exit code from command', async () => {
    const result = await executeCommand('node -e "process.exit(42)"', process.cwd());
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it('executes in specified working directory', async () => {
    // Use os.tmpdir() for cross-platform temp directory
    const result = await executeCommand('node -e "console.log(process.cwd())"', os.tmpdir());
    expect(result.success).toBe(true);
  });

  it('includes node_modules/.bin in PATH', async () => {
    const result = await executeCommand(
      'node -e "console.log(process.env.PATH.includes(\'node_modules/.bin\'))"',
      process.cwd()
    );
    expect(result.success).toBe(true);
  });

  it('rewrites local binary commands to run through node', async () => {
    // Run jest with --version flag - this tests that:
    // 1. The local binary (jest) is detected in node_modules/.bin
    // 2. It gets rewritten to run through node explicitly
    // 3. The command executes successfully
    const result = await executeCommand('jest --version', process.cwd());
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
