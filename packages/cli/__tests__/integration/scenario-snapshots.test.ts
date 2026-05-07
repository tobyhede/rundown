import { describe, it, expect } from '@jest/globals';
import {
  createTestWorkspace,
  normalizeCliOutput,
  parseJsonEvents,
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

  // 2. Create a delegation token for substep 2.1.
  const delegate = await runCliInProcess(
    ['delegate', 'snapshot-child.runbook.md', '--step', '2.1', ...textFlag],
    workspace,
  );
  blocks.push(
    `=== command: rd delegate snapshot-child.runbook.md --step 2.1${
      format === 'text' ? ' --text' : ''
    } ===\n${delegate.stdout}`,
  );

  // 3. Extract the delegation token. rd delegate emits pretty-printed
  //    multi-line JSON in JSON mode, so try whole-document JSON first,
  //    then NDJSON, then a raw rdtk_ regex for text mode.
  const token = extractDelegationToken(delegate.stdout);
  if (!token) {
    throw new Error(`Delegation token not found in stdout:\n${delegate.stdout}`);
  }

  // 4. Claim the token — launches and runs the child to completion.
  const claim = await runCliInProcess(['claim', token, ...textFlag], workspace);
  blocks.push(
    `=== command: rd claim <token>${format === 'text' ? ' --text' : ''} ===\n${claim.stdout}`,
  );

  return blocks.join('\n');
}

function extractDelegationToken(stdout: string): string | null {
  // Pretty-printed whole-document JSON first (rd delegate's actual shape).
  try {
    const whole = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof whole.token === 'string') return whole.token;
  } catch {
    // not whole-document JSON
  }
  // NDJSON fallback.
  const events = parseJsonEvents(stdout) as Array<Record<string, unknown>>;
  for (const event of events) {
    if (typeof event.token === 'string' && event.token.length > 0) {
      return event.token;
    }
  }
  // Text-mode rdtk_ token.
  const match = /\brdtk_[A-Za-z0-9]+/.exec(stdout);
  return match ? match[0] : null;
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
