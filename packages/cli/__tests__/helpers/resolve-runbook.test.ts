import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveRunbookFile, parseIdentifier } from '../../src/helpers/resolve-runbook.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('resolveRunbookFile', () => {
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

  it('should find runbook in .claude/rundown/runbooks/', async () => {
    const claudeDir = path.join(testDir, '.claude/rundown/runbooks');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'test.runbook.md'), '# Test');

    const result = await resolveRunbookFile(testDir, 'test.runbook.md');

    expect(result).toBe(path.join(claudeDir, 'test.runbook.md'));
  });

  it('should find runbook in plugin runbooks directory', async () => {
    const pluginDir = path.join(testDir, 'plugin/runbooks');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'plugin.runbook.md'), '# Plugin');

    // Set CLAUDE_PLUGIN_ROOT for this test
    process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

    const result = await resolveRunbookFile(testDir, 'plugin.runbook.md');
    expect(result).toBe(path.join(pluginDir, 'plugin.runbook.md'));
    // afterEach restores originalPluginRoot
  });

  it('should find runbook relative to cwd', async () => {
    await fs.writeFile(path.join(testDir, 'relative.runbook.md'), '# Relative');

    const result = await resolveRunbookFile(testDir, 'relative.runbook.md');

    expect(result).toBe(path.join(testDir, 'relative.runbook.md'));
  });

  it('should return null if runbook not found', async () => {
    const result = await resolveRunbookFile(testDir, 'nonexistent.runbook.md');

    expect(result).toBeNull();
  });

  it('should prefer .claude/rundown/runbooks over relative path', async () => {
    // Create in both locations
    const claudeDir = path.join(testDir, '.claude/rundown/runbooks');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'test.runbook.md'), '# Claude');
    await fs.writeFile(path.join(testDir, 'test.runbook.md'), '# Relative');

    const result = await resolveRunbookFile(testDir, 'test.runbook.md');

    expect(result).toBe(path.join(claudeDir, 'test.runbook.md'));
  });

  describe('resolution precedence', () => {
    it('prefers project runbook over bundled', async () => {
      // Create a project-local override of a bundled runbook
      const claudeDir = path.join(testDir, '.claude', 'rundown', 'runbooks');
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeDir, 'retry-success.runbook.md'),
        '---\nname: override\n---\n# Override\n'
      );

      const result = await resolveRunbookFile(testDir, 'retry-success.runbook.md');

      expect(result).toBe(path.join(claudeDir, 'retry-success.runbook.md'));
    });
  });

  describe('bundled runbook resolution', () => {
    it('finds bundled runbook when not found elsewhere', async () => {
      // Clear plugin root to isolate test (restored by afterEach)
      delete process.env.CLAUDE_PLUGIN_ROOT;

      // Use a known bundled runbook filename (retry-success exists in runbooks/patterns/retries/)
      const result = await resolveRunbookFile(testDir, 'retry-success.runbook.md');

      expect(result).not.toBeNull();
      expect(result).toContain('runbooks');
      expect(result).toContain('retry-success.runbook.md');
    });
  });

  describe('namespace resolution', () => {
    it('resolves rundown:name to plugin source only', async () => {
      const claudeDir = path.join(testDir, '.claude/rundown/runbooks');
      const pluginDir = path.join(testDir, 'plugin/runbooks');
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });

      // Create runbook with same name in both project and plugin
      const projectContent = '---\nname: write-plan\n---\n# Project Version';
      const pluginContent = '---\nname: write-plan\n---\n# Plugin Version';

      await fs.writeFile(path.join(claudeDir, 'write-plan.runbook.md'), projectContent);
      await fs.writeFile(path.join(pluginDir, 'write-plan.runbook.md'), pluginContent);

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      // Without namespace - should resolve to project (higher priority)
      const withoutNamespace = await resolveRunbookFile(testDir, 'write-plan');
      expect(withoutNamespace).toBe(path.join(claudeDir, 'write-plan.runbook.md'));

      // With rundown: namespace - should resolve to plugin only
      const withNamespace = await resolveRunbookFile(testDir, 'rundown:write-plan');
      expect(withNamespace).toBe(path.join(pluginDir, 'write-plan.runbook.md'));
    });

    it('returns null for unknown namespace', async () => {
      const claudeDir = path.join(testDir, '.claude/rundown/runbooks');
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeDir, 'my-runbook.runbook.md'),
        '---\nname: my-runbook\n---\n# Test'
      );

      const result = await resolveRunbookFile(testDir, 'unknown:my-runbook');
      expect(result).toBeNull();
    });

    it('resolves rundown:name from plugin subdirectory', async () => {
      const planningDir = path.join(testDir, 'plugin/runbooks/planning');
      await fs.mkdir(planningDir, { recursive: true });
      await fs.writeFile(
        path.join(planningDir, 'review-plan.runbook.md'),
        '---\nname: review-plan\n---\n# Review'
      );

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      const result = await resolveRunbookFile(testDir, 'rundown:review-plan');
      expect(result).toBe(path.join(planningDir, 'review-plan.runbook.md'));
    });

    it('returns null when namespaced runbook not found in target source', async () => {
      const claudeDir = path.join(testDir, '.claude/rundown/runbooks');
      const pluginDir = path.join(testDir, 'plugin/runbooks');
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });

      // Create runbook only in project
      await fs.writeFile(
        path.join(claudeDir, 'project-only.runbook.md'),
        '---\nname: project-only\n---\n# Project Only'
      );

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      // Should not find it with rundown: namespace (which looks in plugin only)
      const result = await resolveRunbookFile(testDir, 'rundown:project-only');
      expect(result).toBeNull();
    });
  });
});

describe('parseIdentifier', () => {
  it('parses simple name without namespace', () => {
    const result = parseIdentifier('write-plan');
    expect(result).toEqual({ namespace: null, name: 'write-plan' });
  });

  it('parses namespaced identifier', () => {
    const result = parseIdentifier('rundown:write-plan');
    expect(result).toEqual({ namespace: 'rundown', name: 'write-plan' });
  });

  it('parses namespace with hyphens', () => {
    const result = parseIdentifier('my-plugin:my-runbook');
    expect(result).toEqual({ namespace: 'my-plugin', name: 'my-runbook' });
  });

  it('parses namespace with numbers', () => {
    const result = parseIdentifier('plugin2:runbook');
    expect(result).toEqual({ namespace: 'plugin2', name: 'runbook' });
  });

  it('treats path-like identifiers as names', () => {
    const result = parseIdentifier('planning/write-plan.runbook.md');
    expect(result).toEqual({ namespace: null, name: 'planning/write-plan.runbook.md' });
  });

  it('handles name with colons after first colon', () => {
    const result = parseIdentifier('rundown:name:with:colons');
    expect(result).toEqual({ namespace: 'rundown', name: 'name:with:colons' });
  });

  it('rejects namespace starting with number', () => {
    const result = parseIdentifier('2plugin:runbook');
    expect(result).toEqual({ namespace: null, name: '2plugin:runbook' });
  });

  it('rejects namespace starting with hyphen', () => {
    const result = parseIdentifier('-plugin:runbook');
    expect(result).toEqual({ namespace: null, name: '-plugin:runbook' });
  });

  it('rejects uppercase namespace', () => {
    const result = parseIdentifier('Plugin:runbook');
    expect(result).toEqual({ namespace: null, name: 'Plugin:runbook' });
  });

  it('handles empty string', () => {
    const result = parseIdentifier('');
    expect(result).toEqual({ namespace: null, name: '' });
  });

  it('handles colon-only input', () => {
    const result = parseIdentifier(':');
    expect(result).toEqual({ namespace: null, name: ':' });
  });

  it('handles colon at start', () => {
    const result = parseIdentifier(':runbook');
    expect(result).toEqual({ namespace: null, name: ':runbook' });
  });
});
