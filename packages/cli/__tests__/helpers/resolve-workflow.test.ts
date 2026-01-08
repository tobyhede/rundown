import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveWorkflowFile } from '../../src/helpers/resolve-workflow.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('resolveWorkflowFile', () => {
  let testDir: string;
  let originalPluginRoot: string | undefined;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-test-'));
    // Save original env to restore in afterEach
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(async () => {
    // Restore env BEFORE cleanup to prevent bleeding into other tests
    process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should find workflow in .claude/runbooks/', async () => {
    const claudeDir = path.join(testDir, '.claude/runbooks');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'test.runbook.md'), '# Test');

    const result = await resolveWorkflowFile(testDir, 'test.runbook.md');

    expect(result).toBe(path.join(claudeDir, 'test.runbook.md'));
  });

  it('should find workflow in plugin workflows directory', async () => {
    const pluginDir = path.join(testDir, 'plugin/runbooks');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'plugin.runbook.md'), '# Plugin');

    // Set CLAUDE_PLUGIN_ROOT for this test
    process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

    const result = await resolveWorkflowFile(testDir, 'plugin.runbook.md');
    expect(result).toBe(path.join(pluginDir, 'plugin.runbook.md'));
    // afterEach restores originalPluginRoot
  });

  it('should find workflow relative to cwd', async () => {
    await fs.writeFile(path.join(testDir, 'relative.runbook.md'), '# Relative');

    const result = await resolveWorkflowFile(testDir, 'relative.runbook.md');

    expect(result).toBe(path.join(testDir, 'relative.runbook.md'));
  });

  it('should return null if workflow not found', async () => {
    const result = await resolveWorkflowFile(testDir, 'nonexistent.runbook.md');

    expect(result).toBeNull();
  });

  it('should prefer .claude/runbooks over relative path', async () => {
    // Create in both locations
    const claudeDir = path.join(testDir, '.claude/runbooks');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'test.runbook.md'), '# Claude');
    await fs.writeFile(path.join(testDir, 'test.runbook.md'), '# Relative');

    const result = await resolveWorkflowFile(testDir, 'test.runbook.md');

    expect(result).toBe(path.join(claudeDir, 'test.runbook.md'));
  });
});
