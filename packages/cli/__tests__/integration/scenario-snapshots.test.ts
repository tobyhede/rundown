import { describe, it, expect } from '@jest/globals';
import { createTestWorkspace, normalizeCliOutput, runCliInProcess } from '../helpers/test-utils.js';

describe('scenario output snapshots', () => {
  describe('simple-complete', () => {
    it('JSON', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(
          ['run', 'snapshot-simple-complete.runbook.md'],
          workspace,
        );
        expect(result.exitCode).toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });

    it('text', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(
          ['run', 'snapshot-simple-complete.runbook.md', '--text'],
          workspace,
        );
        expect(result.exitCode).toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });
  });

  describe('simple-stop', () => {
    it('JSON', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(['run', 'snapshot-simple-stop.runbook.md'], workspace);
        // Fixture intentionally stops; exit code is non-zero.
        expect(result.exitCode).not.toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });

    it('text', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(
          ['run', 'snapshot-simple-stop.runbook.md', '--text'],
          workspace,
        );
        expect(result.exitCode).not.toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });
  });

  describe('multi-step', () => {
    it('JSON', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(['run', 'snapshot-multi-step.runbook.md'], workspace);
        expect(result.exitCode).toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });

    it('text', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(
          ['run', 'snapshot-multi-step.runbook.md', '--text'],
          workspace,
        );
        expect(result.exitCode).toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });
  });

  describe('retry', () => {
    it('JSON', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(['run', 'snapshot-retry.runbook.md'], workspace);
        expect(result.exitCode).toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });

    it('text', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const result = await runCliInProcess(
          ['run', 'snapshot-retry.runbook.md', '--text'],
          workspace,
        );
        expect(result.exitCode).toBe(0);
        expect(normalizeCliOutput(result.stdout, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });
  });
});
