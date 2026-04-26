// packages/cli/__tests__/integration/output-capture.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getAllRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const CAPTURE_RUNBOOK = `---
name: output-capture-test
---
# Output Capture Test

## 1. Capture
- OUTPUTS
  - Version
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
printf 'v1.2.3' > "$RD_OUTPUTS_Version"
\`\`\`

## 2. Echo captured
- OUTPUTS
  - Echoed {{ Version }}
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;

describe('output capture — file-backed naked OUTPUTS at step level', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'capture.runbook.md'), CAPTURE_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  // `printf`/`echo` are not in the default policy allow list and the default
  // mode is `prompted` — `--allow-all` bypasses policy so the shell can write
  // to $RD_OUTPUTS_*.
  it('captures the shell-written value and exposes it to the next step', async () => {
    const result = runCli('run capture.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { id: string; variables?: Record<string, unknown> };
    expect(state.variables?.Version).toBe('v1.2.3');
    // Step 2's expression-form OUTPUTS pulls the captured value through
    expect(state.variables?.Echoed).toBe('v1.2.3');
  });

  it('persists the channel file on disk for audit', async () => {
    const result = runCli('run capture.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { id: string };
    const channelPath = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      'Version',
    );
    const content = await readFile(channelPath, 'utf-8');
    expect(content).toBe('v1.2.3');
  });
});

describe('output capture — best-effort behaviour', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  // `printf`/`echo` are not in the default policy allow list and the default
  // mode is `prompted` — `--allow-all` bypasses policy so the shell can write
  // to $RD_OUTPUTS_*.
  it('omits an output the shell never wrote (empty file)', async () => {
    const RUNBOOK = `---
name: empty-capture
---
# Empty Capture

## 1. Skip the write
- OUTPUTS
  - Maybe
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'empty.runbook.md'), RUNBOOK);
    const result = runCli('run empty.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables?.Maybe).toBeUndefined();
  });

  it('trims trailing newline from echo without -n', async () => {
    const RUNBOOK = `---
name: trim-capture
---
# Trim Capture

## 1. Capture with newline
- OUTPUTS
  - Greeting
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
echo "hello" > "$RD_OUTPUTS_Greeting"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'trim.runbook.md'), RUNBOOK);
    const result = runCli('run trim.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables?.Greeting).toBe('hello');
  });

  it('mixes naked and expression forms in a single OUTPUTS block', async () => {
    const RUNBOOK = `---
name: mixed-capture
---
# Mixed Capture

## 1. Capture and tag
- OUTPUTS
  - DeployUrl
  - Tag "{{ RunId }}-staging"
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
printf 'https://example.test' > "$RD_OUTPUTS_DeployUrl"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'mixed.runbook.md'), RUNBOOK);
    const result = runCli('run mixed.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables?.DeployUrl).toBe('https://example.test');
    // Tag is expression-form; RunId is an 8-hex generated id
    expect(typeof state.variables?.Tag).toBe('string');
    expect(state.variables?.Tag as string).toMatch(/-staging$/);
  });

  it('creates a per-substep directory when the OUTPUTS lives on a substep', async () => {
    // Parent uses PASS ALL aggregation, so substep must DEFER to participate
    // (PASS CONTINUE would prevent aggregation from accumulating a result).
    const RUNBOOK = `---
name: substep-capture
---
# Substep Capture

## 1. Parent
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Capture
- OUTPUTS
  - Inner
- PASS DEFER
- FAIL DEFER

\`\`\`sh
printf 'inner-value' > "$RD_OUTPUTS_Inner"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'substep.runbook.md'), RUNBOOK);
    const result = runCli('run substep.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { id: string; variables?: Record<string, unknown> };
    expect(state.variables?.Inner).toBe('inner-value');
    const expected = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      '1',
      'Inner',
    );
    const fileStat = await stat(expected);
    expect(fileStat.isFile()).toBe(true);
  });

  it('creates a four-segment path when a substep with naked OUTPUTS is inside a FOR loop', async () => {
    const RUNBOOK = `---
name: substep-in-for-capture
required:
  - items
---
# Substep In FOR Capture

## 1. Parent
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Capture
- OUTPUTS
  - Inner
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
printf "%s" "{{ item }}" > "$RD_OUTPUTS_Inner"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'substep-in-for.runbook.md'), RUNBOOK);
    const result = runCli(
      ['run', 'substep-in-for.runbook.md', '--allow-all', '--input-json', 'items=["alpha","beta"]'],
      workspace,
    );
    expect(result.exitCode).toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { id: string; variables?: Record<string, unknown> };
    // Last iteration's value wins via SET_VARIABLES merge precedence.
    expect(state.variables?.Inner).toBe('beta');
    // Iteration 1: <stepId>/<substepId>/<iteration>/<VarName>
    const iter1 = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      '1',
      '1',
      'Inner',
    );
    const iter2 = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      '1',
      '2',
      'Inner',
    );
    expect((await stat(iter1)).isFile()).toBe(true);
    expect((await stat(iter2)).isFile()).toBe(true);
    expect(await readFile(iter1, 'utf-8')).toBe('alpha');
    expect(await readFile(iter2, 'utf-8')).toBe('beta');
  });

  it('creates per-iteration capture files for a single-substep FOR loop', async () => {
    const RUNBOOK = `---
name: step-for-single-substep
required:
  - items
---
# Step FOR Single Substep

## 1. Capture each item
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Write item
- OUTPUTS
  - Inner
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
printf "%s" "{{ item }}" > "$RD_OUTPUTS_Inner"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'step-for-single.runbook.md'), RUNBOOK);
    const result = runCli(
      [
        'run',
        'step-for-single.runbook.md',
        '--allow-all',
        '--input-json',
        'items=["alpha","beta"]',
      ],
      workspace,
    );
    expect(result.exitCode).toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { id: string; variables?: Record<string, unknown> };
    // Last iteration's value wins via SET_VARIABLES merge precedence.
    expect(state.variables?.Inner).toBe('beta');
    // Iteration paths: <stepId>/<substepId>/<iteration>/<VarName> (four-segment)
    const iter1 = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      '1',
      '1',
      'Inner',
    );
    const iter2 = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      '1',
      '2',
      'Inner',
    );
    expect((await stat(iter1)).isFile()).toBe(true);
    expect((await stat(iter2)).isFile()).toBe(true);
    expect(await readFile(iter1, 'utf-8')).toBe('alpha');
    expect(await readFile(iter2, 'utf-8')).toBe('beta');
  });

  // Gap #2: Policy-denied command skips capture
  it('does not capture when the command is blocked by policy', async () => {
    const RUNBOOK = `---
name: policy-denied-capture
---
# Policy Denied Capture

## 1. Blocked write
- OUTPUTS
  - Blocked
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
printf 'should-not-capture' > "$RD_OUTPUTS_Blocked"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'denied.runbook.md'), RUNBOOK);
    // --deny-all blocks the shell command execution, causing the step to fail → STOP.
    // This is deterministic and avoids any interactive prompt.
    const result = runCli('run denied.runbook.md --deny-all', workspace);
    // The runbook should fail (policy denial → step fails → STOP)
    expect(result.exitCode).not.toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { variables?: Record<string, unknown> };
    // Variable was never set (no merge happened because the command was blocked)
    expect(state.variables?.Blocked).toBeUndefined();
  });

  // Gap #3: FOR iteration that fails mid-sequence
  it('preserves capture from iteration 1 when iteration 2 fails', async () => {
    const RUNBOOK = `---
name: for-fail-midway
required:
  - items
---
# FOR Fail Midway

## 1. Parent
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Capture
- OUTPUTS
  - Inner
- PASS DEFER
- FAIL DEFER

\`\`\`sh
if [ "{{ item }}" = "good" ]; then
  printf "good-value" > "$RD_OUTPUTS_Inner"
else
  exit 1
fi
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'for-fail.runbook.md'), RUNBOOK);
    const result = runCli(
      `run for-fail.runbook.md --allow-all --input-json items=["good","bad"]`,
      workspace,
    );
    // Runbook stops on iteration 2's failure
    expect(result.exitCode).not.toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { id: string; variables?: Record<string, unknown> };
    // Iteration 1's captured value should be in state (the SET_VARIABLES dispatch ran before
    // iteration 2's failure).
    // NOTE: If this assertion fails, check result.stdout/stderr — the actual behaviour may differ
    // from expectation (e.g. SET_VARIABLES from iteration 1 may be rolled back on STOP).
    expect(state.variables?.Inner).toBe('good-value');
    // Iteration 1's channel file persisted
    const iter1 = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      '1',
      '1',
      'Inner',
    );
    const iter2 = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      '1',
      '2',
      'Inner',
    );
    expect(await readFile(iter1, 'utf-8')).toBe('good-value');
    // iter2 file may exist (pre-created empty) or may not (depending on whether
    // prepareOutputChannels ran for iteration 2 before the abort)
    try {
      const iter2Content = await readFile(iter2, 'utf-8');
      expect(iter2Content).toBe('');
    } catch (err) {
      // ENOENT is also acceptable — channel file may not have been created if iteration aborted early
      expect((err as { code?: string }).code).toBe('ENOENT');
    }
  });

  // Gap #5: Multiple naked OUTPUTS in one step (end-to-end)
  it('captures multiple naked OUTPUTS from a single step', async () => {
    const RUNBOOK = `---
name: multi-naked-capture
---
# Multi Naked Capture

## 1. Capture two values
- OUTPUTS
  - Version
  - DeployUrl
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
printf 'v1.2.3' > "$RD_OUTPUTS_Version"
printf 'https://example.test/v1' > "$RD_OUTPUTS_DeployUrl"
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'multi.runbook.md'), RUNBOOK);
    const result = runCli('run multi.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);
    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { id: string; variables?: Record<string, unknown> };
    expect(state.variables?.Version).toBe('v1.2.3');
    expect(state.variables?.DeployUrl).toBe('https://example.test/v1');
    // Both channel files persist on disk for audit
    const versionPath = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      'Version',
    );
    const deployPath = join(
      workspace.cwd,
      '.rundown',
      'runs',
      state.id,
      'outputs',
      '1',
      'DeployUrl',
    );
    expect(await readFile(versionPath, 'utf-8')).toBe('v1.2.3');
    expect(await readFile(deployPath, 'utf-8')).toBe('https://example.test/v1');
  });
});
