import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getStepTotal, isDynamicWorkflow } from '../../src/helpers/context.js';

describe('context helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('isDynamicWorkflow', () => {
    it('returns true for workflow with dynamic first step', async () => {
      const content = `# Dynamic\n## {N}. Process\nDo something.`;
      const filePath = path.join(tempDir, 'dynamic.md');
      await fs.writeFile(filePath, content);

      const result = await isDynamicWorkflow(tempDir, 'dynamic.md');
      expect(result).toBe(true);
    });

    it('returns false for workflow with static first step', async () => {
      const content = `# Static\n## 1. First Step\nDo something.`;
      const filePath = path.join(tempDir, 'static.md');
      await fs.writeFile(filePath, content);

      const result = await isDynamicWorkflow(tempDir, 'static.md');
      expect(result).toBe(false);
    });
  });

  describe('getStepTotal', () => {
    it('returns {N} for dynamic workflows', async () => {
      const content = `# Dynamic\n## {N}. Process\nDo something.`;
      const filePath = path.join(tempDir, 'dynamic.md');
      await fs.writeFile(filePath, content);

      const result = await getStepTotal(tempDir, 'dynamic.md');
      expect(result).toBe('{N}');
    });

    it('returns step count for static workflows', async () => {
      const content = `# Static\n## 1. First\nOne.\n## 2. Second\nTwo.`;
      const filePath = path.join(tempDir, 'static.md');
      await fs.writeFile(filePath, content);

      const result = await getStepTotal(tempDir, 'static.md');
      expect(result).toBe(2);
    });
  });
});
