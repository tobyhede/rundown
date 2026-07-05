// packages/claude-code-plugin/__tests__/cli.integration.test.ts
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('CLI Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create temp directory for each test
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Hook Dispatch Mode', () => {
    test('should handle hook dispatch with valid JSON input', (done) => {
      const proc = spawn('node', ['dist/cli.js'], {
        cwd: path.resolve(__dirname, '..'),
      });

      const input = JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: testDir,
        tool_name: 'Edit',
        tool_input: {},
      });

      let stdout = '';
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        expect(code).toBe(0);
        // Should produce empty output or valid JSON
        if (stdout.trim()) {
          expect(() => JSON.parse(stdout)).not.toThrow();
        }
        done();
      });

      proc.stdin.write(input);
      proc.stdin.end();
    });

    test('rejects input missing required fields fail-closed: exit 2, refusal on stderr', (done) => {
      const proc = spawn('node', ['dist/cli.js'], {
        cwd: path.resolve(__dirname, '..'),
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const input = JSON.stringify({
        // Missing hook_event_name and cwd - this is a schema violation
        tool_name: 'Edit',
      });

      proc.on('close', (code) => {
        expect(code).toBe(2); // exit 2 is the blocking channel; exit 1 was fail-open
        expect(stderr).toContain('Rundown hook refused');
        expect(stderr).toContain('Invalid input');
        expect(stdout.trim()).toBe(''); // no stdout decision on the refusal path
        done();
      });

      proc.stdin.write(input);
      proc.stdin.end();
    });

    test('handles invalid JSON input fail-closed: exit 2, refusal on stderr', (done) => {
      const proc = spawn('node', ['dist/cli.js'], {
        cwd: path.resolve(__dirname, '..'),
      });

      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        expect(code).toBe(2);
        expect(stderr).toContain('Rundown hook refused');
        expect(stderr).toContain('Invalid JSON input');
        done();
      });

      proc.stdin.write('not valid json');
      proc.stdin.end();
    });

    test('empty stdin fails closed: exit 2, refusal on stderr', (done) => {
      const proc = spawn('node', ['dist/cli.js'], {
        cwd: path.resolve(__dirname, '..'),
      });

      let stdout = '';
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        expect(code).toBe(2);
        expect(stderr).toContain('empty hook payload');
        expect(stdout.trim()).toBe('');
        done();
      });

      proc.stdin.end();
    });
  });
});
