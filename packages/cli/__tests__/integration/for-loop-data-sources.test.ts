import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  parseJsonEvents,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `servers:
  - alpha
  - beta
  - gamma
`,
    );

    // Create runbook that uses the array variable
    await writeFile(
      join(workspace.cwd, 'deploy.runbook.md'),
      `---
name: Deploy Servers
---
# Deploy

## 1. Process servers
- FOR server IN {{ servers }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle server
- PASS CONTINUE

\`\`\`bash
rd echo server={{ server }}
\`\`\`
`,
    );

    const result = runCli('run --json deploy.runbook.md', workspace);
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
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `items:
  - one
  - two
  - three
  - four
  - five
`,
    );

    // Create runbook with windowed iteration
    await writeFile(
      join(workspace.cwd, 'windowed.runbook.md'),
      `---
name: Windowed Iteration
---
# Windowed

## 1. Process items
- FOR item IN 2 TO 4 OF {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }} index={{ Index }}
\`\`\`
`,
    );

    const result = runCli('run --json windowed.runbook.md', workspace);
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
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `items: []
`,
    );

    // Create runbook that iterates over empty array
    await writeFile(
      join(workspace.cwd, 'empty.runbook.md'),
      `---
name: Empty Array
---
# Empty

## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`

## 2. Done
\`\`\`bash
rd echo done
\`\`\`
`,
    );

    const result = runCli('run --json empty.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);

    const stepEnteredEvents = events.filter((e) => e.type === 'step_entered');
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Empty array: ForIterationService detects exhaustion before entering the loop,
    // so only the "Done" step is entered (0 iterations)
    expect(stepEnteredEvents).toHaveLength(1);
    expect(commandStartedEvents).toHaveLength(1);

    // The only event is the "Done" step
    expect(stepEnteredEvents[0].description).toContain('Done');
    expect(commandStartedEvents[0].command).toContain('done');
  });

  it('clamps window to array length (1 TO 100 OF 3-element array)', async () => {
    // Create config with 3-element array
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `items:
  - first
  - second
  - third
`,
    );

    // Create runbook with window larger than array
    await writeFile(
      join(workspace.cwd, 'clamp.runbook.md'),
      `---
name: Window Clamp
---
# Clamp

## 1. Process items
- FOR item IN 1 TO 100 OF {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run --json clamp.runbook.md', workspace);
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
    await writeFile(
      join(workspace.cwd, 'missing.runbook.md'),
      `---
name: Missing Source
---
# Missing

## 1. Process items
- FOR item IN {{ missing }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run missing.runbook.md', workspace);

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
    await writeFile(
      join(workspace.cwd, 'file-loop.runbook.md'),
      `---
name: File Loop
---
# File Loop

## 1. Process servers
- FOR server IN {{ servers }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle server
- PASS CONTINUE

\`\`\`bash
rd echo server={{ server }}
\`\`\`
`,
    );

    const result = runCli(
      'run --json --var servers=file:servers.jsonl file-loop.runbook.md',
      workspace,
    );
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

  it('handles array iteration from var-file', async () => {
    // Create var-file with YAML array (multiline strings are no longer iterable data sources)
    await writeFile(
      join(workspace.cwd, 'vars.yaml'),
      `log:
  - alpha
  - beta
  - gamma
`,
    );

    // Create runbook that iterates over array from var-file
    await writeFile(
      join(workspace.cwd, 'iterate.runbook.md'),
      `---
name: Array Iteration
---
# Iterate

## 1. Process lines
- FOR line IN {{ log }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle line
- PASS CONTINUE

\`\`\`bash
rd echo line={{ line }}
\`\`\`
`,
    );

    const result = runCli('run --json iterate.runbook.md --var-file vars.yaml', workspace);
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
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `items:
  - hello world
  - safe-value
  - another-safe
`,
    );

    // Create runbook that echoes items
    await writeFile(
      join(workspace.cwd, 'special.runbook.md'),
      `---
name: Special Chars
---
# Special

## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run --json special.runbook.md', workspace);
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
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `servers:
  - s1
  - s2
`,
    );

    // Create runbook that uses both loop and CLI variable in command
    await writeFile(
      join(workspace.cwd, 'combined.runbook.md'),
      `---
name: Combined Variables
---
# Combined

## 1. Process servers
- FOR server IN {{ servers }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle server
- PASS CONTINUE

\`\`\`bash
rd echo env={{ env }} server={{ server }}
\`\`\`
`,
    );

    const result = runCli('run --json combined.runbook.md --var env=staging', workspace);
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
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `items:\n${items.map((item) => `  - ${item}`).join('\n')}\n`,
    );

    // Create runbook that iterates
    await writeFile(
      join(workspace.cwd, 'large.runbook.md'),
      `---
name: Large Array
---
# Large

## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run --json large.runbook.md', workspace);
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
    await writeFile(
      join(workspace.cwd, 'jsonl-fields.runbook.md'),
      `---
name: JSONL Field Access
---
# JSONL Field Access

## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo name={{ item.name }} count={{ item.count }} full={{ item }}
\`\`\`
`,
    );

    const result = runCli(
      'run --json --var items=file:items.jsonl jsonl-fields.runbook.md',
      workspace,
    );
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
    await writeFile(
      join(workspace.cwd, 'jsonl-bad.runbook.md'),
      `---
name: JSONL Bad Data
---
# JSONL Bad

## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item.name }}
\`\`\`
`,
    );

    const result = runCli('run --var items=file:bad-items.jsonl jsonl-bad.runbook.md', workspace);

    // Should fail with non-zero exit code
    expect(result.exitCode).not.toBe(0);

    // Should contain error context with file path and line number
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/Failed to parse JSONL/i);
    expect(output).toMatch(/bad-items\.jsonl/);
    expect(output).toMatch(/line\s+2/);
  });

  it('iterates descending array source (4 TO 2) in reverse order', async () => {
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      `items:
  - alpha
  - beta
  - gamma
  - delta
  - epsilon
`,
    );

    await writeFile(
      join(workspace.cwd, 'descending-array.runbook.md'),
      `---
name: Descending Array
---
# Descending

## 1. Process items
- FOR item IN 4 TO 2 OF {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run --json descending-array.runbook.md', workspace);
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

    await writeFile(
      join(workspace.cwd, 'descending-file.runbook.md'),
      `---
name: Descending File
---
# Descending File

## 1. Process servers
- FOR server IN 3 TO 1 OF {{ servers }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle server
- PASS CONTINUE

\`\`\`bash
rd echo server={{ server }}
\`\`\`
`,
    );

    const result = runCli(
      'run --json --var servers=file:servers.jsonl descending-file.runbook.md',
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
    await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
    await writeFile(
      join(workspace.cwd, '.rundown', 'config.yaml'),
      'hosts:\n  - web-01\n  - web-02\n',
    );

    await writeFile(
      join(workspace.cwd, 'protocol-proof.runbook.md'),
      `---
name: Protocol Proof
---
# Protocol Proof

## 1. Deploy hosts
- FOR host IN {{ hosts }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Deploy
- PASS CONTINUE

\`\`\`bash
rd echo host={{ host }}
\`\`\`
`,
    );

    const result = runCli('run --json protocol-proof.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const commands = events.filter((e) => e.type === 'command_started');
    expect(commands).toHaveLength(2);
    expect(commands[0].command).toContain('host=web-01');
    expect(commands[1].command).toContain('host=web-02');

    // No empty-string values — proves ForIterationService resolved before buildStepVariables
    const allText = JSON.stringify(events);
    expect(allText).not.toContain('host=\n');
    expect(allText).not.toContain("host=''");
  });

  it('resolves JSONL file values before template expansion (protocol proof)', async () => {
    await writeFile(join(workspace.cwd, 'items.jsonl'), '"first"\n"second"\n');

    await writeFile(
      join(workspace.cwd, 'jsonl-protocol.runbook.md'),
      `---
name: JSONL Protocol Proof
---
# JSONL Protocol

## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle
- PASS CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli(
      'run --json --var items=file:items.jsonl jsonl-protocol.runbook.md',
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout);
    const commands = events.filter((e) => e.type === 'command_started');
    expect(commands).toHaveLength(2);
    expect(commands[0].command).toContain('item=first');
    expect(commands[1].command).toContain('item=second');
  });
});
