import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  parseJsonEvents,
  type TestWorkspace,
  type StepConfig,
} from '../helpers/test-utils.js';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNDOWN_DIR } from '@rundown-org/core';

/**
 * Create a standard FOR-source runbook: one FOR step with one substep.
 * Covers ~15 of the 20 tests in this file. Tests with dotted field access,
 * multi-step runbooks, or unusual substep titles use createRunbook() directly.
 */
type ForSourceOpts = {
  name: string;
  title: string;
  variable: string;
  source: string;
  command: string;
  extraSteps?: StepConfig[];
} & ({ start?: never; end?: never } | { start: number | string; end: number | string });

function forSourceRunbook(opts: ForSourceOpts): string {
  return createRunbook({
    name: opts.name,
    title: opts.title,
    steps: [
      {
        title: `Process ${opts.source}`,
        for:
          'start' in opts && opts.start != null
            ? { variable: opts.variable, start: opts.start, end: opts.end, source: opts.source }
            : { variable: opts.variable, source: opts.source },
        pass: 'CONTINUE',
        substeps: [
          {
            title: `Handle ${opts.variable}`,
            pass: 'CONTINUE',
            command: opts.command,
          },
        ],
      },
      ...(opts.extraSteps ?? []),
    ],
  });
}

describe('FOR loop data source integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('iterates over YAML array variable from config file', async () => {
    // Create .rundown directory and config with array variable
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `servers:
  - alpha
  - beta
  - gamma
`,
    );

    // Create runbook that uses the array variable
    const content = forSourceRunbook({
      name: 'Deploy Servers',
      title: 'Deploy',
      variable: 'server',
      source: 'servers',
      command: 'rd echo server={{ server }}',
    });
    await writeFile(join(workspace.cwd, 'deploy.runbook.md'), content);

    const result = runCli('run deploy.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const stepEnteredEvents = events.filter((e) => e.type === 'step_entered');
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations
    expect(stepEnteredEvents).toHaveLength(3);
    expect(commandStartedEvents).toHaveLength(3);

    // Verify each iteration resolves correct value
    expect(stepEnteredEvents[0].description).toContain('Handle server');
    expect(commandStartedEvents[0].command).toContain('server=alpha');

    expect(stepEnteredEvents[1].description).toContain('Handle server');
    expect(commandStartedEvents[1].command).toContain('server=beta');

    expect(stepEnteredEvents[2].description).toContain('Handle server');
    expect(commandStartedEvents[2].command).toContain('server=gamma');

    // No raw {{server}} in output
    const allText = JSON.stringify(events);
    expect(allText).not.toContain('{{server}}');
  });

  it('iterates over windowed array (2 TO 4 OF {{items}})', async () => {
    // Create config with 5-element array
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `items:
  - one
  - two
  - three
  - four
  - five
`,
    );

    // Create runbook with windowed iteration
    const content = forSourceRunbook({
      name: 'Windowed Iteration',
      title: 'Windowed',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }} index={{ Index }}',
      start: 2,
      end: 4,
    });
    await writeFile(join(workspace.cwd, 'windowed.runbook.md'), content);

    const result = runCli('run windowed.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations (positions 2, 3, 4)
    expect(commandStartedEvents).toHaveLength(3);

    // Index reflects the iteration counter (1-based position in source)
    // Positions 2-4 map to items[1], items[2], items[3]
    expect(commandStartedEvents[0].command).toContain('item=two');
    expect(commandStartedEvents[0].command).toContain('index=2');

    expect(commandStartedEvents[1].command).toContain('item=three');
    expect(commandStartedEvents[1].command).toContain('index=3');

    expect(commandStartedEvents[2].command).toContain('item=four');
    expect(commandStartedEvents[2].command).toContain('index=4');
  });

  it('handles empty array with 0 iterations', async () => {
    // Create config with empty array
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `items: []
`,
    );

    // Create runbook that iterates over empty array
    const content = forSourceRunbook({
      name: 'Empty Array',
      title: 'Empty',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
      extraSteps: [{ title: 'Done', command: 'rd echo done' }],
    });
    await writeFile(join(workspace.cwd, 'empty.runbook.md'), content);

    const result = runCli('run empty.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const stepEnteredEvents = events.filter((e) => e.type === 'step_entered');
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Empty array: machine-owned iteration resolution detects exhaustion before entering the loop,
    // so only the "Done" step is entered (0 iterations)
    expect(stepEnteredEvents).toHaveLength(1);
    expect(commandStartedEvents).toHaveLength(1);

    // The only event is the "Done" step
    expect(stepEnteredEvents[0].description).toContain('Done');
    expect(commandStartedEvents[0].command).toContain('done');
  });

  it('clamps window to array length (1 TO 100 OF 3-element array)', async () => {
    // Create config with 3-element array
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `items:
  - first
  - second
  - third
`,
    );

    // Create runbook with window larger than array
    const content = forSourceRunbook({
      name: 'Window Clamp',
      title: 'Clamp',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
      start: 1,
      end: 100,
    });
    await writeFile(join(workspace.cwd, 'clamp.runbook.md'), content);

    const result = runCli('run clamp.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations, not 100
    expect(commandStartedEvents).toHaveLength(3);
    expect(commandStartedEvents[0].command).toContain('item=first');
    expect(commandStartedEvents[1].command).toContain('item=second');
    expect(commandStartedEvents[2].command).toContain('item=third');
  });

  it('errors on undefined source variable', async () => {
    // Create runbook with missing source variable
    const content = forSourceRunbook({
      name: 'Missing Source',
      title: 'Missing',
      variable: 'item',
      source: 'missing',
      command: 'rd echo item={{ item }}',
    });
    await writeFile(join(workspace.cwd, 'missing.runbook.md'), content);

    const result = runCli('run missing.runbook.md --text', workspace);

    // Should fail with non-zero exit code
    expect(result.exitCode).not.toBe(0);

    // Should contain error about undefined source
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/missing|undefined|not defined/i);
  });

  it('iterates over file source variable', async () => {
    // Create a JSONL data file with 3 JSON string values
    await writeFile(join(workspace.cwd, 'servers.jsonl'), '"alpha"\n"beta"\n"gamma"\n');

    // Create runbook that iterates over file source
    const content = forSourceRunbook({
      name: 'File Loop',
      title: 'File Loop',
      variable: 'server',
      source: 'servers',
      command: 'rd echo server={{ server }}',
    });
    await writeFile(join(workspace.cwd, 'file-loop.runbook.md'), content);

    const result = runCli('run --input servers=file:servers.jsonl file-loop.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter(
      (e: { type: string }) => e.type === 'command_started',
    );

    expect(commandStartedEvents).toHaveLength(3);
    expect(commandStartedEvents[0].command).toContain('server=alpha');
    expect(commandStartedEvents[1].command).toContain('server=beta');
    expect(commandStartedEvents[2].command).toContain('server=gamma');
  });

  it('handles array iteration from input-file', async () => {
    // Create input-file with YAML array (multiline strings are no longer iterable data sources)
    await writeFile(
      join(workspace.cwd, 'vars.yaml'),
      `log:
  - alpha
  - beta
  - gamma
`,
    );

    // Create runbook that iterates over array from input-file
    const content = forSourceRunbook({
      name: 'Array Iteration',
      title: 'Iterate',
      variable: 'line',
      source: 'log',
      command: 'rd echo line={{ line }}',
    });
    await writeFile(join(workspace.cwd, 'iterate.runbook.md'), content);

    const result = runCli('run iterate.runbook.md --input-file vars.yaml', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // 3 iterations: alpha, beta, gamma
    expect(commandStartedEvents).toHaveLength(3);

    // Verify each iteration has correct line value
    expect(commandStartedEvents[0].command).toContain('line=alpha');
    expect(commandStartedEvents[1].command).toContain('line=beta');
    expect(commandStartedEvents[2].command).toContain('line=gamma');
  });

  it('handles shell special chars in array source values', async () => {
    // Create config with array containing special characters
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `items:
  - hello world
  - safe-value
  - another-safe
`,
    );

    // Create runbook that echoes items
    const content = forSourceRunbook({
      name: 'Special Chars',
      title: 'Special',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
    });
    await writeFile(join(workspace.cwd, 'special.runbook.md'), content);

    const result = runCli('run special.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations
    expect(commandStartedEvents).toHaveLength(3);

    // Verify each iteration has correct item value (properly escaped for shell)
    expect(commandStartedEvents[0].command).toContain('hello world');
    expect(commandStartedEvents[1].command).toContain('safe-value');
    expect(commandStartedEvents[2].command).toContain('another-safe');
  });

  it('combines array source with template variables in commands', async () => {
    // Create config with servers array
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `servers:
  - s1
  - s2
`,
    );

    // Create runbook that uses both loop and CLI variable in command
    const content = forSourceRunbook({
      name: 'Combined Variables',
      title: 'Combined',
      variable: 'server',
      source: 'servers',
      command: 'rd echo env={{ env }} server={{ server }}',
    });
    await writeFile(join(workspace.cwd, 'combined.runbook.md'), content);

    const result = runCli('run combined.runbook.md --input env=staging', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 2 iterations
    expect(commandStartedEvents).toHaveLength(2);

    // Verify both env and server variables are resolved
    expect(commandStartedEvents[0].command).toContain('env=staging');
    expect(commandStartedEvents[0].command).toContain('server=s1');

    expect(commandStartedEvents[1].command).toContain('env=staging');
    expect(commandStartedEvents[1].command).toContain('server=s2');
  });

  it('large array source (50 elements)', async () => {
    // Create config with 50-element array
    const items = Array.from({ length: 50 }, (_, i) => `item${String(i + 1)}`);
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `items:\n${items.map((item) => `  - ${item}`).join('\n')}\n`,
    );

    // Create runbook that iterates
    const content = forSourceRunbook({
      name: 'Large Array',
      title: 'Large',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
    });
    await writeFile(join(workspace.cwd, 'large.runbook.md'), content);

    const result = runCli('run large.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 50 iterations
    expect(commandStartedEvents).toHaveLength(50);

    // Verify first and last iterations
    expect(commandStartedEvents[0].command).toContain('item=item1');
    expect(commandStartedEvents[49].command).toContain('item=item50');
  });

  it('iterates over JSONL file with object field access via dotted paths', async () => {
    // Create JSONL data file with 3 objects
    await writeFile(
      join(workspace.cwd, 'items.jsonl'),
      `{"name":"alice","count":10}
{"name":"bob","count":20}
{"name":"charlie","count":30}
`,
    );

    // Create runbook that accesses object fields via dotted paths
    const content = forSourceRunbook({
      name: 'JSONL Field Access',
      title: 'JSONL Field Access',
      variable: 'item',
      source: 'items',
      command: 'rd echo name={{ item.name }} count={{ item.count }} full={{ item }}',
    });
    await writeFile(join(workspace.cwd, 'jsonl-fields.runbook.md'), content);

    const result = runCli('run --input items=file:items.jsonl jsonl-fields.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations
    expect(commandStartedEvents).toHaveLength(3);

    // Verify first iteration: alice, 10
    expect(commandStartedEvents[0].command).toContain('name=alice');
    expect(commandStartedEvents[0].command).toContain('count=10');
    // Full object should be JSON stringified
    expect(commandStartedEvents[0].command).toContain('"name":"alice"');

    // Verify second iteration: bob, 20
    expect(commandStartedEvents[1].command).toContain('name=bob');
    expect(commandStartedEvents[1].command).toContain('count=20');
    expect(commandStartedEvents[1].command).toContain('"name":"bob"');

    // Verify third iteration: charlie, 30
    expect(commandStartedEvents[2].command).toContain('name=charlie');
    expect(commandStartedEvents[2].command).toContain('count=30');
    expect(commandStartedEvents[2].command).toContain('"name":"charlie"');

    // Verify shell escaping: full JSON object should be single-quoted in command
    expect(commandStartedEvents[0].command).toMatch(/'[^']*"name":"alice"[^']*'/);

    // Verify no raw {{item}} templates remain
    const allText = JSON.stringify(events);
    expect(allText).not.toContain('{{item');
  });

  it('errors on invalid JSONL input with parsing error context', async () => {
    // Create JSONL data file with one valid and one malformed line
    await writeFile(
      join(workspace.cwd, 'bad-items.jsonl'),
      `{"name":"valid","count":10}
{this is not valid json}
`,
    );

    // Create runbook that tries to iterate
    const content = forSourceRunbook({
      name: 'JSONL Bad Data',
      title: 'JSONL Bad',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item.name }}',
    });
    await writeFile(join(workspace.cwd, 'jsonl-bad.runbook.md'), content);

    const result = runCli(
      'run --input items=file:bad-items.jsonl jsonl-bad.runbook.md --text',
      workspace,
    );

    // Should fail with non-zero exit code
    expect(result.exitCode).not.toBe(0);

    // Should contain error context with file path and line number
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/Failed to parse JSONL/i);
    expect(output).toMatch(/bad-items\.jsonl/);
    expect(output).toMatch(/line\s+2/);
  });

  it('iterates descending array source (4 TO 2) in reverse order', async () => {
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      `items:
  - alpha
  - beta
  - gamma
  - delta
  - epsilon
`,
    );

    const content = forSourceRunbook({
      name: 'Descending Array',
      title: 'Descending',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
      start: 4,
      end: 2,
    });
    await writeFile(join(workspace.cwd, 'descending-array.runbook.md'), content);

    const result = runCli('run descending-array.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations (positions 4, 3, 2 = delta, gamma, beta)
    expect(commandStartedEvents).toHaveLength(3);
    expect(commandStartedEvents[0].command).toContain('item=delta');
    expect(commandStartedEvents[1].command).toContain('item=gamma');
    expect(commandStartedEvents[2].command).toContain('item=beta');
  });

  it('iterates descending file source (3 TO 1) in reverse order', async () => {
    await writeFile(
      join(workspace.cwd, 'servers.jsonl'),
      '"alpha"\n"beta"\n"gamma"\n"delta"\n"epsilon"\n',
    );

    const content = forSourceRunbook({
      name: 'Descending File',
      title: 'Descending File',
      variable: 'server',
      source: 'servers',
      command: 'rd echo server={{ server }}',
      start: 3,
      end: 1,
    });
    await writeFile(join(workspace.cwd, 'descending-file.runbook.md'), content);

    const result = runCli(
      'run --input servers=file:servers.jsonl descending-file.runbook.md',
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations (positions 3, 2, 1 = gamma, beta, alpha)
    expect(commandStartedEvents).toHaveLength(3);
    expect(commandStartedEvents[0].command).toContain('server=gamma');
    expect(commandStartedEvents[1].command).toContain('server=beta');
    expect(commandStartedEvents[2].command).toContain('server=alpha');
  });

  it('resolves array variable values before template expansion (protocol proof)', async () => {
    await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
    await writeFile(
      join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'),
      'hosts:\n  - web-01\n  - web-02\n',
    );

    const content = forSourceRunbook({
      name: 'Protocol Proof',
      title: 'Protocol Proof',
      variable: 'host',
      source: 'hosts',
      command: 'rd echo host={{ host }}',
    });
    await writeFile(join(workspace.cwd, 'protocol-proof.runbook.md'), content);

    const result = runCli('run protocol-proof.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const commands = events.filter((e) => e.type === 'command_started');
    expect(commands).toHaveLength(2);
    expect(commands[0].command).toContain('host=web-01');
    expect(commands[1].command).toContain('host=web-02');

    // No empty-string values — proves iteration resolution ran before buildStepVariables
    const allText = JSON.stringify(events);
    expect(allText).not.toContain('host=\n');
    expect(allText).not.toContain("host=''");
  });

  it('iterates over --input-json array', async () => {
    const content = forSourceRunbook({
      name: 'JSON Array',
      title: 'JSON Array',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
    });
    await writeFile(join(workspace.cwd, 'json-array.runbook.md'), content);

    const result = runCli(
      'run --input-json items=["alpha","bravo","charlie"] json-array.runbook.md',
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    expect(commandStartedEvents).toHaveLength(3);
    expect(commandStartedEvents[0].command).toContain('item=alpha');
    expect(commandStartedEvents[1].command).toContain('item=bravo');
    expect(commandStartedEvents[2].command).toContain('item=charlie');
  });

  it('iterates over --input-json array of objects with dotted access', async () => {
    const content = forSourceRunbook({
      name: 'JSON Objects',
      title: 'JSON Objects',
      variable: 'item',
      source: 'items',
      command: 'rd echo name={{ item.name }} count={{ item.count }}',
    });
    await writeFile(join(workspace.cwd, 'json-objects.runbook.md'), content);

    const result = runCli(
      'run --input-json items=[{"name":"alice","count":10},{"name":"bob","count":20}] json-objects.runbook.md',
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    expect(commandStartedEvents).toHaveLength(2);
    expect(commandStartedEvents[0].command).toContain('name=alice');
    expect(commandStartedEvents[0].command).toContain('count=10');
    expect(commandStartedEvents[1].command).toContain('name=bob');
    expect(commandStartedEvents[1].command).toContain('count=20');
  });

  it('handles empty --input-json array with 0 iterations', async () => {
    const content = forSourceRunbook({
      name: 'JSON Empty',
      title: 'JSON Empty',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
      extraSteps: [{ title: 'Done', command: 'rd echo done' }],
    });
    await writeFile(join(workspace.cwd, 'json-empty.runbook.md'), content);

    const result = runCli('run --input-json items=[] json-empty.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const stepEnteredEvents = events.filter((e) => e.type === 'step_entered');
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Empty array: 0 iterations, only the "Done" step runs
    expect(stepEnteredEvents).toHaveLength(1);
    expect(commandStartedEvents).toHaveLength(1);
    expect(stepEnteredEvents[0].description).toContain('Done');
    expect(commandStartedEvents[0].command).toContain('done');
  });

  it('iterates over windowed --input-json array', async () => {
    const content = forSourceRunbook({
      name: 'JSON Windowed',
      title: 'JSON Windowed',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
      start: 2,
      end: 4,
    });
    await writeFile(join(workspace.cwd, 'json-windowed.runbook.md'), content);

    const result = runCli(
      'run --input-json items=["a","b","c","d","e"] json-windowed.runbook.md',
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Positions 2-4 map to items[1], items[2], items[3]
    expect(commandStartedEvents).toHaveLength(3);
    expect(commandStartedEvents[0].command).toContain('item=b');
    expect(commandStartedEvents[1].command).toContain('item=c');
    expect(commandStartedEvents[2].command).toContain('item=d');
  });

  it('resolves JSONL file values before template expansion (protocol proof)', async () => {
    await writeFile(join(workspace.cwd, 'items.jsonl'), '"first"\n"second"\n');

    const content = forSourceRunbook({
      name: 'JSONL Protocol Proof',
      title: 'JSONL Protocol',
      variable: 'item',
      source: 'items',
      command: 'rd echo item={{ item }}',
    });
    await writeFile(join(workspace.cwd, 'jsonl-protocol.runbook.md'), content);

    const result = runCli(
      'run --input items=file:items.jsonl jsonl-protocol.runbook.md',
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const commands = events.filter((e) => e.type === 'command_started');
    expect(commands).toHaveLength(2);
    expect(commands[0].command).toContain('item=first');
    expect(commands[1].command).toContain('item=second');
  });

  it('routes escaped file source failures through FOR_RESOLUTION_FAILED', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'rd-outside-source-'));
    try {
      const outsideFile = join(outsideDir, 'items.jsonl');
      await writeFile(outsideFile, '"outside"\n');
      await writeFile(join(workspace.cwd, 'items.jsonl'), '"inside"\n');

      const content = `---
name: source-drift-escape
---
# Source Drift Escape

## 1. Drift source
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
rm items.jsonl
ln -s '${outsideFile}' items.jsonl
\`\`\`

## 2. Process items
- FOR item IN {{items}}
- PASS COMPLETE
- FAIL STOP

### 2.1 Handle item
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
rd echo item={{ item }}
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'outside-file-source.runbook.md'), content);

      const result = runCli(
        [
          'run',
          '--input',
          'items=file:items.jsonl',
          '--allow-all',
          'outside-file-source.runbook.md',
        ],
        workspace,
      );
      expect(result.exitCode).not.toBe(0);

      const events = parseJsonEvents(result.stdout);
      expect(events.some((event) => event.type === 'policy_denied')).toBe(false);
      expect(events.some((event) => event.type === 'error_occurred')).toBe(true);
      expect(
        events.some(
          (event) => event.type === 'runbook_stopped' && event.reason === 'for_resolution_failed',
        ),
      ).toBe(true);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
