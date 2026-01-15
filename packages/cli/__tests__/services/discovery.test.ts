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

  beforeEach(async () => {
    // Create isolated temp directories
    tempDir = await mkdtemp(join(tmpdir(), 'discovery-test-'));
    projectRunbooksDir = join(tempDir, '.claude', 'rundown', 'runbooks');
    pluginRunbooksDir = join(tempDir, 'plugin-runbooks');

    await mkdir(projectRunbooksDir, { recursive: true });
    await mkdir(pluginRunbooksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
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
      // Create test workflow files
      const workflowContent = `---
name: my-workflow
description: Test workflow
---

## 1. First step
- Item 1
- Item 2
`;

      await writeFile(
        join(projectRunbooksDir, 'my-workflow.runbook.md'),
        workflowContent
      );

      const workflows = await scanDirectory(projectRunbooksDir, 'project');

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('my-workflow');
      expect(workflows[0].source).toBe('project');
      expect(workflows[0].description).toBe('Test workflow');
    });

    it('returns empty array when directory does not exist', async () => {
      const nonExistentDir = join(tempDir, 'nonexistent');

      const workflows = await scanDirectory(nonExistentDir, 'project');

      expect(workflows).toEqual([]);
    });

    it('extracts frontmatter metadata', async () => {
      const workflowContent = `---
name: test-workflow
description: A test workflow
tags:
  - testing
  - automation
version: 1.0.0
---

## 1. Step
Content here
`;

      await writeFile(
        join(projectRunbooksDir, 'test-workflow.runbook.md'),
        workflowContent
      );

      const workflows = await scanDirectory(projectRunbooksDir, 'project');

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('test-workflow');
      expect(workflows[0].description).toBe('A test workflow');
      expect(workflows[0].tags).toEqual(['testing', 'automation']);
    });

    it('falls back to filename stem when no frontmatter', async () => {
      const workflowContent = `## 1. First step
Content without frontmatter
`;

      await writeFile(
        join(projectRunbooksDir, 'no-frontmatter.runbook.md'),
        workflowContent
      );

      const workflows = await scanDirectory(projectRunbooksDir, 'project');

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('no-frontmatter');
    });

    it('skips non-.runbook.md files', async () => {
      await writeFile(
        join(projectRunbooksDir, 'not-a-workflow.md'),
        '# Just a markdown file'
      );
      await writeFile(join(projectRunbooksDir, 'readme.txt'), 'Not markdown');

      const workflows = await scanDirectory(projectRunbooksDir, 'project');

      expect(workflows).toEqual([]);
    });

    it('falls back to filename for workflows with invalid frontmatter', async () => {
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
      const workflows = await scanDirectory(projectRunbooksDir, 'project');

      // File should be included, using filename as name
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('invalid');
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

      const workflows = await scanDirectory(projectRunbooksDir, 'project');

      // Should fall back to filename since frontmatter validation fails
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('missing-name');
    });

    it('includes full file paths', async () => {
      const workflowContent = `---
name: test-workflow
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-workflow.runbook.md'),
        workflowContent
      );

      const workflows = await scanDirectory(projectRunbooksDir, 'project');

      expect(workflows[0].path).toBe(
        join(projectRunbooksDir, 'test-workflow.runbook.md')
      );
    });

    it('marks source as project or plugin', async () => {
      const workflowContent = `---
name: test-workflow
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-workflow.runbook.md'),
        workflowContent
      );

      const projectWorkflows = await scanDirectory(projectRunbooksDir, 'project');
      expect(projectWorkflows[0].source).toBe('project');

      const pluginWorkflows = await scanDirectory(projectRunbooksDir, 'plugin');
      expect(pluginWorkflows[0].source).toBe('plugin');
    });
  });

  describe('discoverRunbooks()', () => {
    it('finds workflows in project directory', async () => {
      const workflowContent = `---
name: project-workflow
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'project-workflow.runbook.md'),
        workflowContent
      );

      const workflows = await discoverRunbooks(tempDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('project-workflow');
      expect(workflows[0].source).toBe('project');
    });

    it('returns empty array when no workflows exist', async () => {
      const workflows = await discoverRunbooks(tempDir);

      expect(workflows).toEqual([]);
    });

    it('discovers multiple workflows from project directory', async () => {
      const workflow1 = `---
name: workflow-one
---

## 1. Step
`;

      const workflow2 = `---
name: workflow-two
description: Second workflow
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'workflow-one.runbook.md'),
        workflow1
      );
      await writeFile(
        join(projectRunbooksDir, 'workflow-two.runbook.md'),
        workflow2
      );

      const workflows = await discoverRunbooks(tempDir);

      expect(workflows).toHaveLength(2);
      expect(workflows.map((w) => w.name)).toEqual(
        expect.arrayContaining(['workflow-one', 'workflow-two'])
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
        // Create same-named workflow in both project and plugin
        const projectWorkflow = `---
name: shared-workflow
description: Project version
---

## 1. Step
`;

        const pluginWorkflow = `---
name: shared-workflow
description: Plugin version
---

## 1. Step
`;

        await writeFile(
          join(projectRunbooksDir, 'shared-workflow.runbook.md'),
          projectWorkflow
        );
        await writeFile(
          join(pluginRunbookDir, 'shared-workflow.runbook.md'),
          pluginWorkflow
        );

        const workflows = await discoverRunbooks(tempDir);

        // Should only find one workflow (project version)
        expect(workflows).toHaveLength(1);
        expect(workflows[0].source).toBe('project');
        expect(workflows[0].description).toBe('Project version');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('includes plugin workflows when no project conflict', async () => {
      // Set up plugin directory
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      const pluginRoot = join(tempDir, 'plugin-root');
      const pluginRunbookDir = join(pluginRoot, 'runbooks');
      await mkdir(pluginRunbookDir, { recursive: true });
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

      try {
        const projectWorkflow = `---
name: project-workflow
---

## 1. Step
`;

        const pluginWorkflow = `---
name: plugin-workflow
---

## 1. Step
`;

        await writeFile(
          join(projectRunbooksDir, 'project-workflow.runbook.md'),
          projectWorkflow
        );
        await writeFile(
          join(pluginRunbookDir, 'plugin-workflow.runbook.md'),
          pluginWorkflow
        );

        const workflows = await discoverRunbooks(tempDir);

        // Should find both workflows
        expect(workflows).toHaveLength(2);
        const names = workflows.map((w) => w.name);
        expect(names).toContain('project-workflow');
        expect(names).toContain('plugin-workflow');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('extracts metadata from all discovered workflows', async () => {
      const workflow = `---
name: test-workflow
description: Test description
tags:
  - tag1
  - tag2
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-workflow.runbook.md'),
        workflow
      );

      const workflows = await discoverRunbooks(tempDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('test-workflow');
      expect(workflows[0].description).toBe('Test description');
      expect(workflows[0].tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('findRunbookByName()', () => {
    it('finds workflow by frontmatter name', async () => {
      const workflowContent = `---
name: my-workflow
description: Test workflow
---

## 1. Step
Content here
`;

      await writeFile(
        join(projectRunbooksDir, 'my-workflow.runbook.md'),
        workflowContent
      );

      const workflow = await findRunbookByName(tempDir, 'my-workflow');

      expect(workflow).not.toBeNull();
      expect(workflow?.name).toBe('my-workflow');
      expect(workflow?.description).toBe('Test workflow');
    });

    it('finds workflow by filename stem when no frontmatter', async () => {
      const workflowContent = `## 1. Step
Content without frontmatter
`;

      await writeFile(
        join(projectRunbooksDir, 'no-frontmatter.runbook.md'),
        workflowContent
      );

      const workflow = await findRunbookByName(tempDir, 'no-frontmatter');

      expect(workflow).not.toBeNull();
      expect(workflow?.name).toBe('no-frontmatter');
    });

    it('returns null when workflow not found', async () => {
      const workflow = await findRunbookByName(tempDir, 'nonexistent');

      expect(workflow).toBeNull();
    });

    it('is case-sensitive for workflow names', async () => {
      const workflowContent = `---
name: my-workflow
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'my-workflow.runbook.md'),
        workflowContent
      );

      const workflow = await findRunbookByName(tempDir, 'My-Workflow');

      expect(workflow).toBeNull();
    });

    it('respects project precedence when finding by name', async () => {
      // Set up plugin directory
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      const pluginRoot = join(tempDir, 'plugin-root');
      const pluginRunbookDir = join(pluginRoot, 'runbooks');
      await mkdir(pluginRunbookDir, { recursive: true });
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

      try {
        const projectWorkflow = `---
name: shared-workflow
description: Project version
---

## 1. Step
`;

        const pluginWorkflow = `---
name: shared-workflow
description: Plugin version
---

## 1. Step
`;

        await writeFile(
          join(projectRunbooksDir, 'shared-workflow.runbook.md'),
          projectWorkflow
        );
        await writeFile(
          join(pluginRunbookDir, 'shared-workflow.runbook.md'),
          pluginWorkflow
        );

        const workflow = await findRunbookByName(tempDir, 'shared-workflow');

        expect(workflow).not.toBeNull();
        expect(workflow?.source).toBe('project');
        expect(workflow?.description).toBe('Project version');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('finds plugin workflow when no project conflict', async () => {
      // Set up plugin directory
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      const pluginRoot = join(tempDir, 'plugin-root');
      const pluginRunbookDir = join(pluginRoot, 'runbooks');
      await mkdir(pluginRunbookDir, { recursive: true });
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

      try {
        const pluginWorkflow = `---
name: plugin-only-workflow
description: Only in plugin
---

## 1. Step
`;

        await writeFile(
          join(pluginRunbookDir, 'plugin-only-workflow.runbook.md'),
          pluginWorkflow
        );

        const workflow = await findRunbookByName(tempDir, 'plugin-only-workflow');

        expect(workflow).not.toBeNull();
        expect(workflow?.source).toBe('plugin');
        expect(workflow?.description).toBe('Only in plugin');
      } finally {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      }
    });

    it('includes all metadata when found', async () => {
      const workflowContent = `---
name: complete-workflow
description: Complete workflow description
tags:
  - important
  - automation
version: 1.0.0
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'complete-workflow.runbook.md'),
        workflowContent
      );

      const workflow = await findRunbookByName(tempDir, 'complete-workflow');

      expect(workflow).not.toBeNull();
      expect(workflow?.name).toBe('complete-workflow');
      expect(workflow?.description).toBe('Complete workflow description');
      expect(workflow?.tags).toEqual(['important', 'automation']);
      expect(workflow?.path).toBe(
        join(projectRunbooksDir, 'complete-workflow.runbook.md')
      );
      expect(workflow?.source).toBe('project');
    });
  });

  describe('edge cases', () => {
    it('handles workflows with special characters in frontmatter', async () => {
      const workflowContent = `---
name: test-workflow
description: Contains special chars & symbols!
tags:
  - test/special
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'test-workflow.runbook.md'),
        workflowContent
      );

      const workflows = await discoverRunbooks(tempDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].description).toContain('&');
    });

    it('handles empty tags array', async () => {
      const workflowContent = `---
name: no-tags
tags: []
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'no-tags.runbook.md'),
        workflowContent
      );

      const workflow = await findRunbookByName(tempDir, 'no-tags');

      expect(workflow?.tags).toEqual([]);
    });

    it('handles workflows with undefined optional fields', async () => {
      const workflowContent = `---
name: minimal-workflow
---

## 1. Step
`;

      await writeFile(
        join(projectRunbooksDir, 'minimal-workflow.runbook.md'),
        workflowContent
      );

      const workflow = await findRunbookByName(tempDir, 'minimal-workflow');

      expect(workflow?.description).toBeUndefined();
      expect(workflow?.tags).toBeUndefined();
    });
  });
});
