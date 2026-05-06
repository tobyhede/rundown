import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import {
  createRunbook,
  createTestWorkspace,
  parseConcatenatedJson,
  readRunbookState,
  runCliInProcess,
  stripExitArtefact,
} from './test-utils.js';

describe('createRunbook', () => {
  describe('basic rendering', () => {
    it('renders minimal runbook with default title', () => {
      const md = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo hello' }],
      });
      expect(md).toContain('# Test');
      expect(md).toContain('## 1. Echo');
      expect(md).toContain('- PASS COMPLETE');
      expect(md).toContain('rd echo hello');
    });

    it('renders frontmatter with name and vars', () => {
      const md = createRunbook({
        name: 'my-runbook',
        vars: { env: 'staging', port: 3000 },
        steps: [{ title: 'Deploy', pass: 'COMPLETE' }],
      });
      expect(md).toContain('---');
      expect(md).toContain('name: my-runbook');
      expect(md).toContain('inputs:');
      expect(md).toContain('  - env');
      expect(md).toContain('  - port');
    });

    it('renders custom title', () => {
      const md = createRunbook({
        title: 'Deploy Pipeline',
        steps: [{ title: 'Start' }],
      });
      expect(md).toContain('# Deploy Pipeline');
    });

    it('renders step content', () => {
      const md = createRunbook({
        steps: [{ title: 'Review', content: 'Check the PR carefully.' }],
      });
      expect(md).toContain('Check the PR carefully.');
    });
  });

  describe('transitions and aggregation', () => {
    it('adds ALL/ANY qualifiers for steps with substeps', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Review',
            pass: 'CONTINUE',
            substeps: [{ title: 'Sub A' }],
          },
        ],
      });
      expect(md).toContain('- PASS ALL CONTINUE');
      expect(md).toContain('- FAIL ANY STOP');
    });

    it('auto-generates complement transition', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            fail: 'STOP',
            for: { variable: 'i', start: 1, end: 3 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- PASS ALL CONTINUE');
      expect(md).toContain('- FAIL ANY STOP');
    });

    it('does not add qualifiers for simple steps', () => {
      const md = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', fail: 'STOP' }],
      });
      expect(md).toContain('- PASS COMPLETE');
      expect(md).toContain('- FAIL STOP');
      expect(md).not.toContain('ALL');
      expect(md).not.toContain('ANY');
    });
  });

  describe('named steps (id field)', () => {
    it('renders named step with custom id', () => {
      const md = createRunbook({
        steps: [{ id: 'ErrorHandler', title: 'Handle errors' }],
      });
      expect(md).toContain('## ErrorHandler. Handle errors');
    });

    it('uses named id for substep numbering', () => {
      const md = createRunbook({
        steps: [
          {
            id: 'ErrorHandler',
            title: 'Handle errors',
            pass: 'COMPLETE',
            substeps: [{ title: 'Log error' }, { title: 'Notify' }],
          },
        ],
      });
      expect(md).toContain('### ErrorHandler.1 Log error');
      expect(md).toContain('### ErrorHandler.2 Notify');
    });

    it('does not consume numeric counter for named steps', () => {
      const md = createRunbook({
        steps: [
          { title: 'Setup', pass: 'GOTO ErrorHandler', command: 'rd echo setup' },
          { id: 'ErrorHandler', title: 'Handle errors', command: 'rd echo error' },
          { title: 'Cleanup', command: 'rd echo cleanup' },
        ],
      });
      expect(md).toContain('## 1. Setup');
      expect(md).toContain('## ErrorHandler. Handle errors');
      expect(md).toContain('## 2. Cleanup');
      // Must NOT produce ## 3.
      expect(md).not.toContain('## 3.');
    });

    it('rejects numeric string id (would collide with auto-numbering)', () => {
      expect(() =>
        createRunbook({
          steps: [{ id: '1', title: 'Bad' }],
        }),
      ).toThrow('not a valid named identifier');
    });

    it('rejects hyphenated id (not a valid identifier)', () => {
      expect(() =>
        createRunbook({
          steps: [{ id: 'bad-id', title: 'Bad' }],
        }),
      ).toThrow('not a valid named identifier');
    });

    it('rejects reserved word as id', () => {
      expect(() =>
        createRunbook({
          steps: [{ id: 'PASS', title: 'Bad' }],
        }),
      ).toThrow('reserved word');
    });

    it('rejects duplicate step ids', () => {
      expect(() =>
        createRunbook({
          steps: [
            { id: 'Handler', title: 'First' },
            { id: 'Handler', title: 'Second' },
          ],
        }),
      ).toThrow('Duplicate StepConfig.id "Handler"');
    });
  });

  describe('FOR clause: numeric range', () => {
    it('renders named numeric range', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { variable: 'batch', start: 1, end: 5 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR batch IN 1 TO 5');
    });

    it('defaults variable to i', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { start: 1, end: 3 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN 1 TO 3');
    });

    it('supports template variable bounds', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { variable: 'i', start: 1, end: '{{Max}}' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN 1 TO {{Max}}');
    });
  });

  describe('FOR clause: single count', () => {
    it('renders unnamed count', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { count: 5 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR 5');
    });

    it('renders named count', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { variable: 'batch', count: 5 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR batch IN 5');
    });
  });

  describe('FOR clause: data source', () => {
    it('renders full source', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process items',
            for: { variable: 'i', source: 'items' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN {{ items }}');
    });

    it('renders full source with named variable', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process servers',
            for: { variable: 'server', source: 'servers' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR server IN {{ servers }}');
    });

    it('renders windowed source', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process items',
            for: { variable: 'i', start: 2, end: 4, source: 'items' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN 2 TO 4 OF {{ items }}');
    });

    it('renders windowed source with named variable', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process items',
            for: { variable: 'item', start: 2, end: 4, source: 'items' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR item IN 2 TO 4 OF {{ items }}');
    });
  });

  describe('FOR clause: type-level validation', () => {
    it('rejects empty ForClauseConfig at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — empty object is not assignable to ForClauseConfig
            for: {},
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects partial windowed source (start without end) at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — start without end is not assignable to ForClauseConfig
            for: { source: 'items', start: 2 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects partial windowed source (end without start) at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — end without start is not assignable to ForClauseConfig
            for: { source: 'items', end: 4 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects count with start/end at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — count is mutually exclusive with start/end
            for: { count: 5, start: 1, end: 5 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects count with source at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — count is mutually exclusive with source
            for: { count: 5, source: 'items' },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects numeric range with only start at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — numeric range requires both start and end
            for: { start: 1 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });
  });
});

describe('parseConcatenatedJson', () => {
  it('skips leading non-JSON text and parses subsequent concatenated objects', () => {
    expect(parseConcatenatedJson('debug\n{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('readRunbookState', () => {
  it('accepts persisted states that reference external runbooks', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const runId = `rd_${'a'.repeat(32)}`;
      const state = {
        id: runId,
        runbook: { source: 'external', path: '/tmp/external.runbook.md' },
        runbookPath: '/tmp/external.runbook.md',
        step: '1',
        stepName: 'External step',
        retryCount: 0,
        variables: {},
        steps: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await writeFile(join(workspace.statePath(), `${runId}.json`), JSON.stringify(state));

      await expect(readRunbookState(workspace, runId)).resolves.toEqual(
        expect.objectContaining({
          id: runId,
          runbook: { source: 'external', path: '/tmp/external.runbook.md' },
        }),
      );
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('createTestWorkspace fixtureDir option', () => {
  it('copies only the named subdirectory into all three runbook destinations', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const destinations = [
        workspace.runbooksDir(),
        workspace.pluginRunbooksDir(),
        workspace.rootRunbooksDir(),
      ];
      for (const dir of destinations) {
        const files = await readdir(dir);
        // Only files from fixtures/snapshots/ should appear — not fixtures/simple.runbook.md etc.
        expect(files).toContain('snapshot-simple-complete.runbook.md');
        expect(files).not.toContain('simple.runbook.md');
        expect(files).not.toContain('with-commands.runbook.md');
      }
    } finally {
      await workspace.cleanup();
    }
  });

  it('copies all fixtures into all three destinations when fixtureDir is not passed (backwards compatible)', async () => {
    const workspace = await createTestWorkspace();
    try {
      const destinations = [
        workspace.runbooksDir(),
        workspace.pluginRunbooksDir(),
        workspace.rootRunbooksDir(),
      ];
      for (const dir of destinations) {
        const files = await readdir(dir);
        expect(files).toContain('simple.runbook.md');
      }
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('runCliInProcess', () => {
  it('does not leak ExitSignal artefacts into captured output when a command aborts with process.exit', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const result = await runCliInProcess(['run', 'snapshot-simple-stop.runbook.md'], workspace);

      expect(result.exitCode).not.toBe(0);
      // The harness intercepts process.exit() by throwing an ExitSignal, which
      // the production withErrorHandling wrapper then serialises. That is test
      // plumbing, not real CLI output — it must not appear in either buffer.
      expect(result.stdout).not.toContain('process.exit(');
      expect(result.stdout).not.toContain('"code": "UNKNOWN_ERROR"');
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain('process.exit(');
      expect(combined).not.toContain('"code": "UNKNOWN_ERROR"');
    } finally {
      await workspace.cleanup();
    }
  });

  it('sets exitIntercepted=true when the CLI triggers process.exit', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const result = await runCliInProcess(['run', 'snapshot-simple-stop.runbook.md'], workspace);
      // Observes the interception seam directly — proves the flag fires inside
      // the process.exit override, not just via the outer ExitSignal catch.
      expect(result.exitIntercepted).toBe(true);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await workspace.cleanup();
    }
  });

  it('sets exitIntercepted=false when the CLI completes without calling process.exit', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const result = await runCliInProcess(['run', 'snapshot-multi-step.runbook.md'], workspace);
      expect(result.exitCode).toBe(0);
      expect(result.exitIntercepted).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('stripExitArtefact', () => {
  const ARTEFACT = '{ "error": "process.exit(1)", "kind": "error", "code": "UNKNOWN_ERROR" }';

  it('returns an empty buffer unchanged', () => {
    expect(stripExitArtefact('')).toBe('');
  });

  it('strips an artefact at the start of the buffer (no leading newline)', () => {
    // Regression gate for the (?<=\n) lookbehind bug — pre-fix this leaves
    // the artefact in the buffer because there is no preceding newline.
    expect(stripExitArtefact(ARTEFACT)).toBe('');
  });

  it('strips an artefact preceded by a newline and preserves the newline', () => {
    expect(stripExitArtefact(`prior line\n${ARTEFACT}`)).toBe('prior line\n');
  });

  it('does NOT strip an artefact that is not at end-of-buffer', () => {
    const input = `prior\n${ARTEFACT}\nmore output`;
    expect(stripExitArtefact(input)).toBe(input);
  });

  it('strips a bare "process.exit(N)" tail from stderr', () => {
    expect(stripExitArtefact('some stderr process.exit(1)')).toBe('some stderr');
  });

  it('is idempotent', () => {
    const input = `prior\n${ARTEFACT}`;
    const once = stripExitArtefact(input);
    const twice = stripExitArtefact(once);
    expect(twice).toBe(once);
  });
});
