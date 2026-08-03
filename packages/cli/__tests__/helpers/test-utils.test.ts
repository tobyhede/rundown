import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { seedRawRunState, writeRawRunJson } from '@rundown-org/core/testing/session-fixtures';
import {
  createRunbook,
  createTestWorkspace,
  findActionOutput,
  findFrontierInEvents,
  findLatestFrontierInEvents,
  parseCliJsonObject,
  parseConcatenatedJson,
  parseFinalCliJsonObject,
  readRunbookState,
  requireFrontierToken,
  requireLatestFrontierToken,
  runCliInProcess,
  stripExitArtefact,
  withRunTarget,
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

describe('JSON CLI output helpers', () => {
  it('parses a pretty-printed JSON object', () => {
    expect(parseCliJsonObject('{\n  "kind": "error",\n  "code": "RD-804"\n}\n')).toEqual({
      kind: 'error',
      code: 'RD-804',
    });
  });

  it('parses the final object from JSONL output', () => {
    const output = '{"type":"runbook_started"}\n{"kind":"claim","action":"claimed"}\n';
    expect(parseFinalCliJsonObject(output)).toEqual({ kind: 'claim', action: 'claimed' });
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
      await seedRawRunState(workspace.cwd, state);

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

  it('rejects persisted states whose ids are not canonical run ids', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const state = {
        id: 'wf_legacy',
        runbook: { source: 'project', path: 'legacy.runbook.md' },
        runbookPath: 'legacy.runbook.md',
        step: '1',
        stepName: 'Legacy step',
        retryCount: 0,
        variables: {},
        steps: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await seedRawRunState(workspace.cwd, state);

      await expect(readRunbookState(workspace, 'wf_legacy')).resolves.toBeNull();
    } finally {
      await workspace.cleanup();
    }
  });

  it('returns null when filename id does not match embedded state.id', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const filenameId = `rd_${'a'.repeat(32)}`;
      const embeddedId = `rd_${'b'.repeat(32)}`;
      const state = {
        id: embeddedId,
        runbook: { source: 'project', path: 'x.md' },
        runbookPath: 'x.md',
        step: '1',
        stepName: 'Step',
        retryCount: 0,
        variables: {},
        steps: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await writeRawRunJson(workspace.cwd, filenameId, JSON.stringify(state));

      await expect(readRunbookState(workspace, filenameId)).resolves.toBeNull();
    } finally {
      await workspace.cleanup();
    }
  });

  it('returns the parsed state when filename id matches embedded state.id', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const id = `rd_${'c'.repeat(32)}`;
      const state = {
        id,
        runbook: { source: 'project', path: 'x.md' },
        runbookPath: 'x.md',
        step: '1',
        stepName: 'Step',
        retryCount: 0,
        variables: {},
        steps: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await seedRawRunState(workspace.cwd, state);

      await expect(readRunbookState(workspace, id)).resolves.toEqual(
        expect.objectContaining({ id }),
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

describe('delegation frontier helpers', () => {
  const entry = (id: string, token: string) => ({ id, runbook: 'child.runbook.md', token });
  const stepEntered = (...entries: ReturnType<typeof entry>[]) => ({
    type: 'step_entered',
    delegateFrontier: entries,
  });

  // A `collect` that closes one FOR iteration and opens the next, an inline
  // handoff, or a retry that re-issues in place all emit more than one frontier
  // from a single command. First-vs-last is therefore load-bearing, not
  // hypothetical: reading the first hands back a superseded bearer.
  const REISSUING_EVENTS = [
    stepEntered(entry('1.1', 'rdtk_stale'), entry('1.2', 'rdtk_sibling')),
    stepEntered(entry('1.1', 'rdtk_reissued')),
  ];

  it('findFrontierInEvents returns the FIRST emitted frontier', () => {
    expect(findFrontierInEvents(REISSUING_EVENTS)).toEqual([
      entry('1.1', 'rdtk_stale'),
      entry('1.2', 'rdtk_sibling'),
    ]);
  });

  it('findLatestFrontierInEvents returns the LAST emitted frontier', () => {
    expect(findLatestFrontierInEvents(REISSUING_EVENTS)).toEqual([entry('1.1', 'rdtk_reissued')]);
  });

  it('walks frontiers nested inside array-shaped stdout chunks', () => {
    const nested = [[REISSUING_EVENTS[0]], [REISSUING_EVENTS[1]]];
    expect(findFrontierInEvents(nested)).toEqual([
      entry('1.1', 'rdtk_stale'),
      entry('1.2', 'rdtk_sibling'),
    ]);
    expect(findLatestFrontierInEvents(nested)).toEqual([entry('1.1', 'rdtk_reissued')]);
  });

  it('returns undefined when no step_entered event carries a frontier', () => {
    const events = [{ type: 'runbook_started' }, { type: 'step_entered' }];
    expect(findFrontierInEvents(events)).toBeUndefined();
    expect(findLatestFrontierInEvents(events)).toBeUndefined();
  });

  it('requireFrontierToken selects the LAST matching entry for an id', () => {
    const stdout = REISSUING_EVENTS.map((event) => JSON.stringify(event)).join('\n');
    expect(requireFrontierToken(stdout, '1.1')).toBe('rdtk_reissued');
  });

  it('requireFrontierToken still resolves an id present only in an earlier frontier', () => {
    const stdout = REISSUING_EVENTS.map((event) => JSON.stringify(event)).join('\n');
    expect(requireFrontierToken(stdout, '1.2')).toBe('rdtk_sibling');
  });

  it('requireFrontierToken throws when no frontier entry or text token matches', () => {
    expect(() => requireFrontierToken('{"type":"runbook_started"}', '1.1')).toThrow(
      /delegation token for 1\.1/,
    );
  });

  it('requireFrontierToken throws when stdout carries a bearer but no frontier advertises it', () => {
    // A bearer printed on some other surface (a text-mode RD_CLAIM_TOKEN line,
    // a delegate JSON envelope) is NOT evidence that the frontier emission this
    // assertion is about still works. Scraping it would keep every caller green
    // after the disclosure boundary regressed away.
    const stdout = `{"type":"runbook_started"}\nRD_CLAIM_TOKEN=rdtk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n`;
    expect(() => requireFrontierToken(stdout, '1.1')).toThrow(/delegation token for 1\.1/);
  });

  it('requireFrontierToken throws rather than guessing a token by substep position', () => {
    // The removed fallback mapped '1.2' to the second bearer in stdout order.
    // That resolves to a DIFFERENT substep's credential, so an id-attribution
    // regression would return a plausible wrong token instead of failing.
    const stdout = JSON.stringify({
      type: 'step_entered',
      delegateFrontier: [
        entry('1.1', `rdtk_${'A'.repeat(32)}`),
        entry('9.9', `rdtk_${'B'.repeat(32)}`),
      ],
    });
    expect(() => requireFrontierToken(stdout, '1.2')).toThrow(/delegation token for 1\.2/);
  });
});

describe('requireLatestFrontierToken cache', () => {
  /** Child runbook a delegated substep targets. */
  const CHILD = createRunbook({
    title: 'Child',
    steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Do the work.' }],
  });

  /** Parent whose step 1 delegates two substeps; step 2 offers no frontier. */
  const PARENT = createRunbook({
    title: 'Parent',
    steps: [
      {
        title: 'Fan-out',
        pass: 'CONTINUE',
        fail: 'STOP',
        substeps: [
          { title: 'Task A', delegate: true, runbooks: ['child.runbook.md'] },
          { title: 'Task B', delegate: true, runbooks: ['child.runbook.md'] },
        ],
      },
      { title: 'Done', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result pass' },
    ],
  });

  async function startParent(workspace: Awaited<ReturnType<typeof createTestWorkspace>>) {
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD);
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), PARENT);
    const start = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    return start;
  }

  it('serves the bearer the preceding transition actually emitted', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      const start = await startParent(workspace);
      // Tests may never recover a bearer from persisted state, which holds only
      // the non-secret descriptor — the cached value must be the emitted one.
      const token = requireLatestFrontierToken(workspace, '1.1');
      expect(token).toMatch(/^rdtk_/);
      expect(token).toBe(requireFrontierToken(start.stdout, '1.1'));
    } finally {
      await workspace.cleanup();
    }
  }, 30_000);

  it('RETRACTS a run frontier once that run enters a step offering none', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      await startParent(workspace);
      expect(requireLatestFrontierToken(workspace, '1.1')).toMatch(/^rdtk_/);

      // `goto 2` moves the parent off its DELEGATE step, so step 2's
      // step_entered carries no delegateFrontier. Serving the step-1 bearer
      // afterwards would let a test stay green after the emission it asserts
      // on regressed away.
      const moved = await runCliInProcess(await withRunTarget(['goto', '2'], workspace), workspace);
      expect(moved.exitCode).toBe(0);
      expect(() => requireLatestFrontierToken(workspace, '1.1')).toThrow(
        /preceding CLI transition to emit token for 1\.1/,
      );
    } finally {
      await workspace.cleanup();
    }
  }, 30_000);

  it('keeps a parent frontier alive while a claimed child transitions past its own steps', async () => {
    const workspace = await createTestWorkspace({ fixtureDir: 'snapshots' });
    try {
      await startParent(workspace);
      const token1 = requireLatestFrontierToken(workspace, '1.1');
      const token2 = requireLatestFrontierToken(workspace, '1.2');
      expect(token2).not.toBe(token1);

      // Claiming 1.1 launches the child; driving it emits frontier-less
      // step_entered events for the CHILD run. Those say nothing about the
      // parent, so substep 1.2's still-pending bearer must survive them.
      const claim = await runCliInProcess(`claim ${token1}`, workspace);
      expect(claim.exitCode).toBe(0);
      const claimId = String(findActionOutput(claim.stdout)!.claim_id);
      const passed = await runCliInProcess(['pass', '--claim-id', claimId], workspace);
      expect(passed.exitCode).toBe(0);

      expect(requireLatestFrontierToken(workspace, '1.2')).toBe(token2);
    } finally {
      await workspace.cleanup();
    }
  }, 30_000);
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
