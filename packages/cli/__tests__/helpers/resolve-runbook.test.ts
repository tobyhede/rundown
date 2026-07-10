import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  resolveRunbookFile,
  resolveRunbookRef,
  buildRunbookRef,
  parseIdentifier,
} from '../../src/helpers/resolve-runbook.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runbooksDir } from '@rundown-org/core';
import { restoreEnvVar } from './process-state.js';

describe('resolveRunbookFile', () => {
  let testDir: string;
  let originalPluginRoot: string | undefined;
  let originalCodexPluginRoot: string | undefined;
  let originalRundownPluginRoot: string | undefined;
  let originalBundledRunbooksPath: string | undefined;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-test-'));
    // Save original env to restore in afterEach
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    originalCodexPluginRoot = process.env.CODEX_PLUGIN_ROOT;
    originalRundownPluginRoot = process.env.RUNDOWN_PLUGIN_ROOT;
    originalBundledRunbooksPath = process.env.BUNDLED_RUNBOOKS_PATH;
  });

  afterEach(async () => {
    // Restore env BEFORE cleanup to prevent bleeding into other tests
    restoreEnvVar('CLAUDE_PLUGIN_ROOT', originalPluginRoot);
    restoreEnvVar('CODEX_PLUGIN_ROOT', originalCodexPluginRoot);
    restoreEnvVar('RUNDOWN_PLUGIN_ROOT', originalRundownPluginRoot);
    restoreEnvVar('BUNDLED_RUNBOOKS_PATH', originalBundledRunbooksPath);
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should find runbook in .rundown/runbooks/', async () => {
    const claudeDir = runbooksDir(testDir);
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'test.runbook.md'), '# Test');

    const result = await resolveRunbookFile(testDir, 'test.runbook.md');

    expect(result).not.toBeNull();
    expect(result!.path).toBe(path.join(claudeDir, 'test.runbook.md'));
    expect(result!.sourceRoot).toBe(testDir);
  });

  it('should find runbook in plugin runbooks directory', async () => {
    const pluginDir = path.join(testDir, 'plugin/runbooks');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'plugin.runbook.md'), '# Plugin');

    // Set CLAUDE_PLUGIN_ROOT for this test
    process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

    const result = await resolveRunbookFile(testDir, 'plugin.runbook.md');
    expect(result).not.toBeNull();
    expect(result!.path).toBe(path.join(pluginDir, 'plugin.runbook.md'));
    expect(result!.sourceRoot).toBe(pluginDir);
    // afterEach restores originalPluginRoot
  });

  it('should find runbook relative to cwd', async () => {
    await fs.writeFile(path.join(testDir, 'relative.runbook.md'), '# Relative');

    const result = await resolveRunbookFile(testDir, 'relative.runbook.md');

    expect(result).not.toBeNull();
    expect(result!.path).toBe(path.join(testDir, 'relative.runbook.md'));
    expect(result!.sourceRoot).toBe(testDir);
  });

  it('should return null if runbook not found', async () => {
    const result = await resolveRunbookFile(testDir, 'nonexistent.runbook.md');

    expect(result).toBeNull();
  });

  it('should prefer .rundown/runbooks over relative path', async () => {
    // Create in both locations
    const claudeDir = runbooksDir(testDir);
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'test.runbook.md'), '# Claude');
    await fs.writeFile(path.join(testDir, 'test.runbook.md'), '# Relative');

    const result = await resolveRunbookFile(testDir, 'test.runbook.md');

    expect(result).not.toBeNull();
    expect(result!.path).toBe(path.join(claudeDir, 'test.runbook.md'));
    expect(result!.sourceRoot).toBe(testDir);
  });

  describe('resolution precedence', () => {
    it('prefers project runbook over bundled', async () => {
      // Create a project-local override of a bundled runbook
      const claudeDir = runbooksDir(testDir);
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeDir, 'retry-success.runbook.md'),
        '---\nname: override\n---\n# Override\n',
      );

      const result = await resolveRunbookFile(testDir, 'retry-success.runbook.md');

      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(claudeDir, 'retry-success.runbook.md'));
    });
  });

  describe('bundled runbook resolution', () => {
    it('finds bundled runbook when not found elsewhere', async () => {
      // Clear plugin root to isolate test (restored by afterEach)
      delete process.env.CLAUDE_PLUGIN_ROOT;

      // Use a known bundled runbook filename (retry-success exists in runbooks/retries/)
      const result = await resolveRunbookFile(testDir, 'retry-success.runbook.md');

      expect(result).not.toBeNull();
      expect(result!.path).toContain('runbooks');
      expect(result!.path).toContain('retry-success.runbook.md');
    });
  });

  describe('namespace resolution', () => {
    it('resolves rundown:name to plugin source only', async () => {
      const claudeDir = runbooksDir(testDir);
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
      expect(withoutNamespace).not.toBeNull();
      expect(withoutNamespace!.path).toBe(path.join(claudeDir, 'write-plan.runbook.md'));

      // With rundown: namespace - should resolve to plugin only
      const withNamespace = await resolveRunbookFile(testDir, 'rundown:write-plan');
      expect(withNamespace).not.toBeNull();
      expect(withNamespace!.path).toBe(path.join(pluginDir, 'write-plan.runbook.md'));
    });

    it('returns null for unknown namespace', async () => {
      const claudeDir = runbooksDir(testDir);
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeDir, 'my-runbook.runbook.md'),
        '---\nname: my-runbook\n---\n# Test',
      );

      const result = await resolveRunbookFile(testDir, 'unknown:my-runbook');
      expect(result).toBeNull();
    });

    it('resolves rundown:name from plugin subdirectory', async () => {
      const planningDir = path.join(testDir, 'plugin/runbooks/planning');
      await fs.mkdir(planningDir, { recursive: true });
      await fs.writeFile(
        path.join(planningDir, 'review-plan.runbook.md'),
        '---\nname: review-plan\n---\n# Review',
      );

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      const result = await resolveRunbookFile(testDir, 'rundown:review-plan');
      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(planningDir, 'review-plan.runbook.md'));
    });

    it('resolves rundown:name from CODEX_PLUGIN_ROOT', async () => {
      const codexPluginRoot = path.join(testDir, 'codex-plugin');
      const planningDir = path.join(codexPluginRoot, 'runbooks/planning');
      await fs.mkdir(planningDir, { recursive: true });
      await fs.writeFile(
        path.join(planningDir, 'codex-demo.runbook.md'),
        `# Codex Demo

## 1. Prompt
- PASS COMPLETE
- FAIL STOP

Confirm Codex plugin discovery works.
`,
      );

      delete process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CODEX_PLUGIN_ROOT = codexPluginRoot;

      const result = await resolveRunbookFile(testDir, 'rundown:codex-demo');

      expect(result?.source).toBe('plugin');
      expect(result?.sourceRoot).toBe(path.join(codexPluginRoot, 'runbooks'));
      expect(result?.path).toBe(path.join(planningDir, 'codex-demo.runbook.md'));
    });

    it('returns null when namespaced runbook not found in target source', async () => {
      const claudeDir = runbooksDir(testDir);
      const pluginDir = path.join(testDir, 'plugin/runbooks');
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });

      // Create runbook only in project
      await fs.writeFile(
        path.join(claudeDir, 'project-only.runbook.md'),
        '---\nname: project-only\n---\n# Project Only',
      );

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      // Should not find it with rundown: namespace (which looks in plugin only)
      const result = await resolveRunbookFile(testDir, 'rundown:project-only');
      expect(result).toBeNull();
    });
  });

  describe('source metadata', () => {
    it('returns source "project" for runbook in .rundown/runbooks/', async () => {
      const claudeDir = runbooksDir(testDir);
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(path.join(claudeDir, 'test.runbook.md'), '# Test');

      const result = await resolveRunbookFile(testDir, 'test.runbook.md');

      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(claudeDir, 'test.runbook.md'));
      expect(result!.source).toBe('project');
    });

    it('returns source "plugin" for runbook in plugin directory', async () => {
      const pluginDir = path.join(testDir, 'plugin/runbooks');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, 'plugin.runbook.md'), '# Plugin');

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      const result = await resolveRunbookFile(testDir, 'plugin.runbook.md');

      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(pluginDir, 'plugin.runbook.md'));
      expect(result!.source).toBe('plugin');
    });

    it('returns source "plugin" for absolute subdirectory path inside plugin runbooks', async () => {
      const pluginDir = path.join(testDir, 'plugin/runbooks/planning/review');
      const runbookPath = path.join(pluginDir, 'plugin.runbook.md');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(runbookPath, '# Plugin');

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      const result = await resolveRunbookFile(testDir, runbookPath);

      expect(result).not.toBeNull();
      expect(result!.path).toBe(runbookPath);
      expect(result!.source).toBe('plugin');
    });

    it('returns source "project" for runbook relative to cwd', async () => {
      await fs.writeFile(path.join(testDir, 'relative.runbook.md'), '# Relative');

      const result = await resolveRunbookFile(testDir, 'relative.runbook.md');

      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(testDir, 'relative.runbook.md'));
      expect(result!.source).toBe('project');
    });

    it('returns source "bundled" for bundled runbook', async () => {
      delete process.env.CLAUDE_PLUGIN_ROOT;

      const result = await resolveRunbookFile(testDir, 'retry-success.runbook.md');

      expect(result).not.toBeNull();
      expect(result!.source).toBe('bundled');
    });

    it('returns source "bundled" for absolute subdirectory path inside bundled runbooks', async () => {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      const bundledDir = path.join(testDir, 'bundled-runbooks');
      const bundledSubdir = path.join(bundledDir, 'delegation');
      const runbookPath = path.join(bundledSubdir, 'delegation-child-pass.runbook.md');
      await fs.mkdir(bundledSubdir, { recursive: true });
      await fs.writeFile(runbookPath, '# Bundled');
      process.env.BUNDLED_RUNBOOKS_PATH = bundledDir;

      const result = await resolveRunbookFile(testDir, runbookPath);

      expect(result).not.toBeNull();
      expect(result!.path).toBe(runbookPath);
      expect(result!.source).toBe('bundled');
    });

    it('keeps an absolute bundled path even when a project runbook has the same basename', async () => {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      const projectDir = runbooksDir(testDir);
      const bundledDir = path.join(testDir, 'bundled-runbooks');
      const bundledSubdir = path.join(bundledDir, 'delegation');
      const filename = 'delegation-child-pass.runbook.md';
      const bundledPath = path.join(bundledSubdir, filename);
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(bundledSubdir, { recursive: true });
      await fs.writeFile(path.join(projectDir, filename), '# Project Override');
      await fs.writeFile(bundledPath, '# Bundled');
      process.env.BUNDLED_RUNBOOKS_PATH = bundledDir;

      const result = await resolveRunbookFile(testDir, bundledPath);

      expect(result).not.toBeNull();
      expect(result!.path).toBe(bundledPath);
      expect(result!.source).toBe('bundled');
    });

    it('returns source "plugin" for namespaced resolution', async () => {
      const pluginDir = path.join(testDir, 'plugin/runbooks');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, 'write-plan.runbook.md'),
        '---\nname: write-plan\n---\n# Plugin Version',
      );

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      const result = await resolveRunbookFile(testDir, 'rundown:write-plan');

      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(pluginDir, 'write-plan.runbook.md'));
      expect(result!.source).toBe('plugin');
    });

    it('returns source from discovery service for name-based lookup', async () => {
      const pluginDir = path.join(testDir, 'plugin/runbooks');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, 'my-runbook.runbook.md'),
        '---\nname: my-runbook\n---\n# Test',
      );

      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      const result = await resolveRunbookFile(testDir, 'my-runbook');

      expect(result).not.toBeNull();
      expect(result!.source).toBe('plugin');
    });

    it('returns source-root-relative runbookRef for nested plugin runbooks', async () => {
      const pluginRunbooksDir = path.join(testDir, 'plugin/runbooks');
      const runbookRef = 'planning/review/review-plan-risk-safety.runbook.md';
      await fs.mkdir(path.join(pluginRunbooksDir, 'planning', 'review'), { recursive: true });
      await fs.writeFile(path.join(pluginRunbooksDir, runbookRef), '# Risk Safety');
      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');

      const result = await resolveRunbookFile(testDir, runbookRef);

      expect(result).not.toBeNull();
      expect(result!.source).toBe('plugin');
      expect(result!.sourceRoot).toBe(pluginRunbooksDir);
      expect(await buildRunbookRef(result!)).toEqual({ source: 'plugin', path: runbookRef });
    });

    it('keeps project-local runbook refs project-root-relative', async () => {
      const projectRunbooksDir = runbooksDir(testDir);
      await fs.mkdir(path.join(projectRunbooksDir, 'ops'), { recursive: true });
      await fs.writeFile(path.join(projectRunbooksDir, 'ops/deploy.runbook.md'), '# Deploy');

      const result = await resolveRunbookFile(testDir, 'ops/deploy.runbook.md');

      expect(result).not.toBeNull();
      expect(result!.source).toBe('project');
      expect(result!.sourceRoot).toBe(testDir);
      expect(await buildRunbookRef(result!)).toEqual({
        source: 'project',
        path: '.rundown/runbooks/ops/deploy.runbook.md',
      });
    });

    it('derives cwd-relative refs for absolute project runbook paths under .rundown/runbooks', async () => {
      const filePath = path.join(testDir, '.rundown/runbooks/ops/deploy.md');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '# Deploy');

      const result = await resolveRunbookFile(testDir, filePath);

      expect(result).toMatchObject({
        source: 'project',
        sourceRoot: testDir,
      });
      expect(await buildRunbookRef(result!)).toEqual({
        source: 'project',
        path: '.rundown/runbooks/ops/deploy.md',
      });
    });

    it('derives cwd-relative refs for absolute direct project file paths', async () => {
      const filePath = path.join(testDir, 'scratch/deploy.md');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '# Deploy');

      const result = await resolveRunbookFile(testDir, filePath);

      expect(result).toMatchObject({
        source: 'project',
        sourceRoot: testDir,
      });
      expect(await buildRunbookRef(result!)).toEqual({
        source: 'project',
        path: 'scratch/deploy.md',
      });
    });

    it('re-resolves absolute external runbook refs to the original file path', async () => {
      const externalDir = await fs.mkdtemp(path.join(path.dirname(testDir), 'external-runbook-'));
      try {
        const filePath = path.join(externalDir, 'external-child.runbook.md');
        await fs.writeFile(filePath, '# External Child');

        const resolved = await resolveRunbookFile(testDir, filePath);

        expect(resolved).toMatchObject({
          path: filePath,
          source: 'external',
          sourceRoot: externalDir,
        });
        const runbookRef = await buildRunbookRef(resolved!);
        expect(runbookRef).toEqual({
          source: 'external',
          path: filePath,
        });

        const rehydrated = await resolveRunbookRef(testDir, runbookRef);
        expect(rehydrated.ok).toBe(true);
        if (rehydrated.ok) {
          expect(rehydrated.resolved).toMatchObject({
            path: filePath,
            source: 'external',
            sourceRoot: externalDir,
          });
        }
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });

    it('re-resolves persisted refs to the exact Markdown file path', async () => {
      const filePath = path.join(testDir, '.rundown/runbooks/ops/deploy.md');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '# Deploy');

      const result = await resolveRunbookRef(testDir, {
        source: 'project',
        path: '.rundown/runbooks/ops/deploy.md',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved).toMatchObject({
          path: filePath,
          source: 'project',
          sourceRoot: testDir,
        });
        expect(await buildRunbookRef(result.resolved)).toEqual({
          source: 'project',
          path: '.rundown/runbooks/ops/deploy.md',
        });
      }
    });

    it('reports missing plugin files when plugin context is available', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = path.join(testDir, 'plugin');
      const runbookRef = { source: 'plugin' as const, path: 'planning/write-plan.runbook.md' };

      const result = await resolveRunbookRef(testDir, runbookRef);

      expect(result).toEqual({
        ok: false,
        reason: 'file-missing',
        runbookRef,
      });
    });
  });
});

describe('buildRunbookRef', () => {
  it('rejects a symlinked runbook that escapes the source root', async () => {
    const realDir = await fs.mkdtemp(path.join(os.tmpdir(), 'real-'));
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'src-'));
    try {
      // Real file lives outside sourceRoot
      const realFile = path.join(realDir, 'escaped.runbook.md');
      await fs.writeFile(realFile, '# Escaped');

      // Symlink lives inside sourceRoot but resolves outside
      const symlinkInside = path.join(sourceRoot, 'inside.runbook.md');
      await fs.symlink(realFile, symlinkInside);

      // buildRunbookRef should reject because realpath(symlinkInside) is not under sourceRoot
      await expect(
        buildRunbookRef({ path: symlinkInside, source: 'project', sourceRoot }),
      ).rejects.toThrow(/outside/i);
    } finally {
      await fs.rm(realDir, { recursive: true, force: true });
      await fs.rm(sourceRoot, { recursive: true, force: true });
    }
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
