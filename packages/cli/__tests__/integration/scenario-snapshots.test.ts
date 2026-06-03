import { describe, it, expect } from '@jest/globals';
import {
  createTestWorkspace,
  getActiveState,
  normalizeCliOutput,
  runCliInProcess,
} from '../helpers/test-utils.js';
import type { TestWorkspace } from '../helpers/test-utils.js';

type Format = 'json' | 'text';

async function runDelegationSequence(workspace: TestWorkspace, format: Format): Promise<string> {
  const textFlag = format === 'text' ? ['--text'] : [];
  const blocks: string[] = [];

  // 1. Start the parent runbook.
  const parent = await runCliInProcess(
    ['run', 'snapshot-delegation-outputs.runbook.md', '--allow-all', ...textFlag],
    workspace,
  );
  blocks.push(
    `=== command: rd run snapshot-delegation-outputs.runbook.md --allow-all${
      format === 'text' ? ' --text' : ''
    } ===\n${parent.stdout}`,
  );

  // 2. Extract the auto-issued delegation token from state.
  const state = await getActiveState(workspace);
  const token = state?.substepStates?.[0]?.delegation?.token ?? null;
  if (!token) {
    throw new Error(`Delegation token not found in active state:\n${JSON.stringify(state)}`);
  }

  // 3. Claim the token — launches and runs the child to completion.
  const claim = await runCliInProcess(['claim', token, ...textFlag], workspace);
  blocks.push(
    `=== command: rd claim <token>${format === 'text' ? ' --text' : ''} ===\n${claim.stdout}`,
  );

  return blocks.join('\n');
}

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

  describe('delegation-outputs', () => {
    it('JSON', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const captured = await runDelegationSequence(workspace, 'json');
        expect(normalizeCliOutput(captured, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });

    it('text', async () => {
      const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
      try {
        const captured = await runDelegationSequence(workspace, 'text');
        expect(normalizeCliOutput(captured, workspace)).toMatchSnapshot();
      } finally {
        await workspace.cleanup();
      }
    });
  });
});
