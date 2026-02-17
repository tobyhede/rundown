import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getStepTotal, getCwd, findRunbookFile } from '../../src/helpers/context.js';

describe('context helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getCwd', () => {
    it('returns current working directory', () => {
      expect(getCwd()).toBe(process.cwd());
    });
  });

  describe('findRunbookFile', () => {
    it('returns path when file exists', async () => {
      const filePath = path.join(tempDir, 'test.md');
      await fs.writeFile(filePath, 'content');

      const result = await findRunbookFile(tempDir, 'test.md');
      expect(result).toBe(filePath);
    });

    it('returns null when file does not exist', async () => {
      const result = await findRunbookFile(tempDir, 'nonexistent.md');
      expect(result).toBeNull();
    });
  });

  describe('getStepTotal', () => {
    it('returns step count for runbooks', async () => {
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

    it('excludes named steps from count', async () => {
      const content = `# Runbook with Named Step

## 1 First Step

Do the first thing.

## 2 Second Step

Do the second thing.

## RECOVER Recovery Step
- PASS: STOP
- FAIL: STOP

Handle recovery.
`;
      const filePath = path.join(tempDir, 'named-step.md');
      await fs.writeFile(filePath, content);

      const result = await getStepTotal(tempDir, 'named-step.md');
      expect(result).toBe(2);
    });
  });
});
