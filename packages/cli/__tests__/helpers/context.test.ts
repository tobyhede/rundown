import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getStepTotal, isDynamicRunbook } from '../../src/helpers/context.js';

describe('context helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('isDynamicRunbook', () => {
    it('returns true for runbook with dynamic first step', async () => {
      const content = `# Dynamic\n## {N}. Process\nDo something.`;
      const filePath = path.join(tempDir, 'dynamic.md');
      await fs.writeFile(filePath, content);

      const result = await isDynamicRunbook(tempDir, 'dynamic.md');
      expect(result).toBe(true);
    });

    it('returns false for runbook with static first step', async () => {
      const content = `# Static\n## 1. First Step\nDo something.`;
      const filePath = path.join(tempDir, 'static.md');
      await fs.writeFile(filePath, content);

      const result = await isDynamicRunbook(tempDir, 'static.md');
      expect(result).toBe(false);
    });

    it('returns false when file does not exist', async () => {
      const result = await isDynamicRunbook(tempDir, 'nonexistent.md');
      expect(result).toBe(false);
    });
  });

  describe('getStepTotal', () => {
    it('returns {N} for dynamic runbooks', async () => {
      const content = `# Dynamic\n## {N}. Process\nDo something.`;
      const filePath = path.join(tempDir, 'dynamic.md');
      await fs.writeFile(filePath, content);

      const result = await getStepTotal(tempDir, 'dynamic.md');
      expect(result).toBe('{N}');
    });

    it('returns step count for static runbooks', async () => {
      const content = `# Static\n## 1. First\nOne.\n## 2. Second\nTwo.`;
      const filePath = path.join(tempDir, 'static.md');
      await fs.writeFile(filePath, content);

      const result = await getStepTotal(tempDir, 'static.md');
      expect(result).toBe(2);
    });

    it('returns 0 when file does not exist', async () => {
      const result = await getStepTotal(tempDir, 'nonexistent.md');
      expect(result).toBe(0);
    });
  });
});
