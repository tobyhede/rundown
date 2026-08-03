import { describe, it, expect } from '@jest/globals';
import {
  createTestWorkspace,
  normalizeCliOutput,
  requireFrontierToken,
  runCliInProcess,
} from '../helpers/test-utils.js';
import type { TestWorkspace } from '../helpers/test-utils.js';

type Format = 'json' | 'text';

/**
 * Drive the delegation scenario and return the rendered transcript.
 *
 * The bearer is read from the parent's emitted `step_entered.delegateFrontier`
 * — the product's actual disclosure boundary. It is deliberately NOT
 * reconstructed from persisted state plus a test-only handle on the launch
 * authority: doing so keeps the transcript green even if the CLI stops
 * disclosing a token altogether, which is the one regression this scenario is
 * best placed to catch.
 *
 * `--text` renders no bearer and no `claim_id` by design, so there is no
 * legitimate text-mode route to a token. The text variant therefore snapshots
 * the run rendering alone; `claim --text` output is covered directly in
 * `__tests__/commands/claim.test.ts`.
 *
 * @param workspace - Test workspace to run against
 * @param format - Output format under snapshot
 * @returns Concatenated command transcript
 */
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

  if (format === 'text') {
    // Pin the redaction itself: a human-facing render must never carry a bearer.
    expect(parent.stdout).not.toMatch(/rdtk_/);
    return blocks.join('\n');
  }

  // 2. Take the bearer from the emitted frontier, then claim it — this launches
  // and runs the child to completion.
  const token = requireFrontierToken(parent.stdout, '2.1');
  const claim = await runCliInProcess(['claim', token], workspace);
  blocks.push(`=== command: rd claim <token> ===\n${claim.stdout}`);

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
