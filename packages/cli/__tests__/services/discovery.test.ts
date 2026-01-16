import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  discoverRunbooks,
  findRunbookByName,
  scanDirectory,
  getSearchPaths,
} from '../../src/services/discovery.js';

describe('discovery service', () => {
  let tempDir: string;
  let projectRunbooksDir: string;
  let pluginRunbooksDir: string;
  let originalBundledRunbooksPath: string | undefined;

  beforeEach(async () => {
    // Create isolated temp directories
    tempDir = await mkdtemp(join(tmpdir(), 'discovery-test-'));
    projectRunbooksDir = join(tempDir, '.claude', 'rundown', 'runbooks');
    pluginRunbooksDir = join(tempDir, 'plugin-runbooks');

    await mkdir(projectRunbooksDir, { recursive: true });
    await mkdir(pluginRunbooksDir, { recursive: true });

    // Disable bundled runbooks for discovery tests to isolate behavior
    originalBundledRunbooksPath = process.env.BUNDLED_RUNBOOKS_PATH;
    process.env.BUNDLED_RUNBOOKS_PATH = '';
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    // Restore original bundled runbooks path
    if (originalBundledRunbooksPath) {
      process.env.BUNDLED_RUNBOOKS_PATH = originalBundledRunbooksPath;
    } else {
      delete process.env.BUNDLED_RUNBOOKS_PATH;
    }
  });

  describe('getSearchPaths()', () => {
    it('returns project directory first', async () => {
      const paths = getSearchPaths(tempDir);

      expect(paths.length).toBeGreaterThan(0);
      expect(paths[0].path).toBe(projectRunbooksDir);
      expect(paths[0].source).toBe('project');
    });

    it('includes plugin directory when CLAUDE_PLUGIN_ROOT is set', async () => {
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = pluginRunbooksDir;

      try {
        const paths = getSearchPaths(tempDir);

        expect(paths.length).toBe(3);
        expect(paths[0].source).toBe('project');
        expect(paths[1].source).toBe('plugin');
        expect(paths[1].path).toBe(join(pluginRunbooksDir, 'runbooks'));
        expect(paths[2].source).toBe('bundled');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('skips plugin directory when CLAUDE_PLUGIN_ROOT is not set', async () => {
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      delete process.env.CLAUDE_PLUGIN_ROOT;

      try {
        const paths = getSearchPaths(tempDir);

        expect(paths.length).toBe(2);
        expect(paths[0].source).toBe('project');
        expect(paths[1].source).toBe('bundled');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });
  });

  describe('bundled runbooks', () => {
    it('includes bundled path in search paths', () => {
      const paths = getSearchPaths(tempDir);

      const bundledPath = paths.find(p => p.source === 'bundled');
      expect(bundledPath).toBeDefined();
      expect(bundledPath?.path).toMatch(/runbooks$/);
    });
  });

  describe('scanDirectory()', () => {
    it('finds .runbook.md files in directory', async () => {
      // Create test runbook files
      const runbookContent = `---
name: my-runbook
description: Test runbook
---

## 1. First step
- Item 1
- Item 2
`;

      await writeFile(
        join(projectRunbooksDir, 'my-runbook.runbook.md'),
        runbookContent
      );

      const runbooks = await scanDirectory(projectRunbooksDir, 'project');

      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].name).toBe('my-runbook');
      expect(runbooks[0].source).toBe('project');
      expect(runbooks[0].description).toBe('Test runbook');
    });

    it('returns empty array when directory does not exist', async () => {
      const nonExistentDir = join(tempDir, 'nonexistent');

      const runbooks = await scanDirectory(nonExistentDir, 'project');

      expect(runbooks).toEqual([]);
    });

    it('extracts frontmatter metadata', async () => {
      const runbookContent = `---
name: test-runbook
description: A test runbook
tags:
  - testing
  - automation
version: 1.0.0
---

## 1. Step
Content here
`;

      await writeFile(
        join(projectRunbooksDir, 'test-runbook.runbook.md'),
        runbookContent
      );

      const runbooks = await scanDirectory(projectRunbooksDir, 'project');

      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].name).toBe('test-runbook');
      expect(runbooks[0].description).toBe('A test runbook');
      expect(runbooks[0].tags).toEqual(['testing', 'automation']);
    });

    it('falls back to filename stem when no frontmatter', async () => {
      const runbookContent = `## 1. First step
Content without frontmatter
`;

      await writeFile(
        join(projectRunbooksDir, 'no-frontmatter.runbook.md'),
        runbookContent
      );

      const runbooks = await scanDirectory(projectRunbooksDir, 'project');

      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].name).toBe('no-frontmatter');
    });

    it('skips non-.runbook.md files', async () => {
      await writeFile(
        join(projectRunbooksDir, 'not-a-runbook.md'),
        '# Just a markdown file'
      );
      await writeFile(join(projectRunbooksDir, 'readme.txt'), 'Not markdown');

      const runbooks = await scanDirectory(projectRunbooksDir, 'project');

      expect(runbooks).toEqual([]);
    });

    it('falls back to filename for runbooks with invalid frontmatter', async () => {
      const invalidFrontmatter = `---
invalid: yaml: syntax:
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'invalid.runbook.md'),
        invalidFrontmatter
      );

      // Should not throw, falls back to filename
      const runbooks = await scanDirectory(projectRunbooksDir, 'project');

      // File should be included, using filename as name
      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].name).toBe('invalid');
    });

    it('handles missing required frontmatter fields', async () => {
      const missingName = `---
description: Missing name field
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'missing-name.runbook.md'),
        missingName
      );

      const runbooks = await scanDirectory(projectRunbooksDir, 'project');

      // Should fall back to filename since frontmatter validation fails
      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].name).toBe('missing-name');
    });

    it('includes full file paths', async () => {
      const runbookContent = `---
name: test-runbook
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-runbook.runbook.md'),
        runbookContent
      );

      const runbooks = await scanDirectory(projectRunbooksDir, 'project');

      expect(runbooks[0].path).toBe(
        join(projectRunbooksDir, 'test-runbook.runbook.md')
      );
    });

    it('marks source as project or plugin', async () => {
      const runbookContent = `---
name: test-runbook
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-runbook.runbook.md'),
        runbookContent
      );

      const projectRunbooks = await scanDirectory(projectRunbooksDir, 'project');
      expect(projectRunbooks[0].source).toBe('project');

      const pluginRunbooks = await scanDirectory(projectRunbooksDir, 'plugin');
      expect(pluginRunbooks[0].source).toBe('plugin');
    });
  });

  describe('discoverRunbooks()', () => {
    it('finds runbooks in project directory', async () => {
      const runbookContent = `---
name: project-runbook
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'project-runbook.runbook.md'),
        runbookContent
      );

      const runbooks = await discoverRunbooks(tempDir);

      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].name).toBe('project-runbook');
      expect(runbooks[0].source).toBe('project');
    });

    it('returns empty array when no runbooks exist', async () => {
      const runbooks = await discoverRunbooks(tempDir);

      expect(runbooks).toEqual([]);
    });

    it('discovers multiple runbooks from project directory', async () => {
      const runbook1 = `---
name: runbook-one
---

## 1. Step
`;

      const runbook2 = `---
name: runbook-two
description: Second runbook
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'runbook-one.runbook.md'),
        runbook1
      );
      await writeFile(
        join(projectRunbooksDir, 'runbook-two.runbook.md'),
        runbook2
      );

      const runbooks = await discoverRunbooks(tempDir);

      expect(runbooks).toHaveLength(2);
      expect(runbooks.map((w) => w.name)).toEqual(
        expect.arrayContaining(['runbook-one', 'runbook-two'])
      );
    });

    it('enforces project precedence over plugin', async () => {
      // Set up plugin directory
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      const pluginRoot = join(tempDir, 'plugin-root');
      const pluginRunbookDir = join(pluginRoot, 'runbooks');
      await mkdir(pluginRunbookDir, { recursive: true });
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

      try {
        // Create same-named runbook in both project and plugin
        const projectRunbook = `---
name: shared-runbook
description: Project version
---

## 1. Step
`;

        const pluginRunbook = `---
name: shared-runbook
description: Plugin version
---

## 1. Step
`;

        await writeFile(
          join(projectRunbooksDir, 'shared-runbook.runbook.md'),
          projectRunbook
        );
        await writeFile(
          join(pluginRunbookDir, 'shared-runbook.runbook.md'),
          pluginRunbook
        );

        const runbooks = await discoverRunbooks(tempDir);

        // Should only find one runbook (project version)
        expect(runbooks).toHaveLength(1);
        expect(runbooks[0].source).toBe('project');
        expect(runbooks[0].description).toBe('Project version');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('includes plugin runbooks when no project conflict', async () => {
      // Set up plugin directory
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      const pluginRoot = join(tempDir, 'plugin-root');
      const pluginRunbookDir = join(pluginRoot, 'runbooks');
      await mkdir(pluginRunbookDir, { recursive: true });
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

      try {
        const projectRunbook = `---
name: project-runbook
---

## 1. Step
`;

        const pluginRunbook = `---
name: plugin-runbook
---

## 1. Step
`;

        await writeFile(
          join(projectRunbooksDir, 'project-runbook.runbook.md'),
          projectRunbook
        );
        await writeFile(
          join(pluginRunbookDir, 'plugin-runbook.runbook.md'),
          pluginRunbook
        );

        const runbooks = await discoverRunbooks(tempDir);

        // Should find both runbooks
        expect(runbooks).toHaveLength(2);
        const names = runbooks.map((w) => w.name);
        expect(names).toContain('project-runbook');
        expect(names).toContain('plugin-runbook');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('extracts metadata from all discovered runbooks', async () => {
      const runbook = `---
name: test-runbook
description: Test description
tags:
  - tag1
  - tag2
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-runbook.runbook.md'),
        runbook
      );

      const runbooks = await discoverRunbooks(tempDir);

      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].name).toBe('test-runbook');
      expect(runbooks[0].description).toBe('Test description');
      expect(runbooks[0].tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('findRunbookByName()', () => {
    it('finds runbook by frontmatter name', async () => {
      const runbookContent = `---
name: my-runbook
description: Test runbook
---

## 1. Step
Content here
`;

      await writeFile(
        join(projectRunbooksDir, 'my-runbook.runbook.md'),
        runbookContent
      );

      const runbook = await findRunbookByName(tempDir, 'my-runbook');

      expect(runbook).not.toBeNull();
      expect(runbook?.name).toBe('my-runbook');
      expect(runbook?.description).toBe('Test runbook');
    });

    it('finds runbook by filename stem when no frontmatter', async () => {
      const runbookContent = `## 1. Step
Content without frontmatter
`;

      await writeFile(
        join(projectRunbooksDir, 'no-frontmatter.runbook.md'),
        runbookContent
      );

      const runbook = await findRunbookByName(tempDir, 'no-frontmatter');

      expect(runbook).not.toBeNull();
      expect(runbook?.name).toBe('no-frontmatter');
    });

    it('returns null when runbook not found', async () => {
      const runbook = await findRunbookByName(tempDir, 'nonexistent');

      expect(runbook).toBeNull();
    });

    it('is case-sensitive for runbook names', async () => {
      const runbookContent = `---
name: my-runbook
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'my-runbook.runbook.md'),
        runbookContent
      );

      const runbook = await findRunbookByName(tempDir, 'My-Runbook');

      expect(runbook).toBeNull();
    });

    it('respects project precedence when finding by name', async () => {
      // Set up plugin directory
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      const pluginRoot = join(tempDir, 'plugin-root');
      const pluginRunbookDir = join(pluginRoot, 'runbooks');
      await mkdir(pluginRunbookDir, { recursive: true });
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

      try {
        const projectRunbook = `---
name: shared-runbook
description: Project version
---

## 1. Step
`;

        const pluginRunbook = `---
name: shared-runbook
description: Plugin version
---

## 1. Step
`;

        await writeFile(
          join(projectRunbooksDir, 'shared-runbook.runbook.md'),
          projectRunbook
        );
        await writeFile(
          join(pluginRunbookDir, 'shared-runbook.runbook.md'),
          pluginRunbook
        );

        const runbook = await findRunbookByName(tempDir, 'shared-runbook');

        expect(runbook).not.toBeNull();
        expect(runbook?.source).toBe('project');
        expect(runbook?.description).toBe('Project version');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('finds plugin runbook when no project conflict', async () => {
      // Set up plugin directory
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      const pluginRoot = join(tempDir, 'plugin-root');
      const pluginRunbookDir = join(pluginRoot, 'runbooks');
      await mkdir(pluginRunbookDir, { recursive: true });
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

      try {
        const pluginRunbook = `---
name: plugin-only-runbook
description: Only in plugin
---

## 1. Step
`;

        await writeFile(
          join(pluginRunbookDir, 'plugin-only-runbook.runbook.md'),
          pluginRunbook
        );

        const runbook = await findRunbookByName(tempDir, 'plugin-only-runbook');

        expect(runbook).not.toBeNull();
        expect(runbook?.source).toBe('plugin');
        expect(runbook?.description).toBe('Only in plugin');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('includes all metadata when found', async () => {
      const runbookContent = `---
name: complete-runbook
description: Complete runbook description
tags:
  - important
  - automation
version: 1.0.0
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'complete-runbook.runbook.md'),
        runbookContent
      );

      const runbook = await findRunbookByName(tempDir, 'complete-runbook');

      expect(runbook).not.toBeNull();
      expect(runbook?.name).toBe('complete-runbook');
      expect(runbook?.description).toBe('Complete runbook description');
      expect(runbook?.tags).toEqual(['important', 'automation']);
      expect(runbook?.path).toBe(
        join(projectRunbooksDir, 'complete-runbook.runbook.md')
      );
      expect(runbook?.source).toBe('project');
    });
  });

  describe('edge cases', () => {
    it('handles runbooks with special characters in frontmatter', async () => {
      const runbookContent = `---
name: test-runbook
description: Contains special chars & symbols!
tags:
  - test/special
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-runbook.runbook.md'),
        runbookContent
      );

      const runbooks = await discoverRunbooks(tempDir);

      expect(runbooks).toHaveLength(1);
      expect(runbooks[0].description).toContain('&');
    });

    it('handles empty tags array', async () => {
      const runbookContent = `---
name: no-tags
tags: []
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'no-tags.runbook.md'),
        runbookContent
      );

      const runbook = await findRunbookByName(tempDir, 'no-tags');

      expect(runbook?.tags).toEqual([]);
    });

    it('handles runbooks with undefined optional fields', async () => {
      const runbookContent = `---
name: minimal-runbook
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'minimal-runbook.runbook.md'),
        runbookContent
      );

      const runbook = await findRunbookByName(tempDir, 'minimal-runbook');

      expect(runbook?.description).toBeUndefined();
      expect(runbook?.tags).toBeUndefined();
    });
  });
});
