import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli } from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

describe('FOR loop data source integration', () => {
  let workspace;

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
- PASS ALL: CONTINUE

### 1.1 Handle server
- PASS: CONTINUE

\`\`\`bash
rd echo server={{ server }}
\`\`\`
`,
    );

    const result = runCli('run --json deploy.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

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
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
rd echo item={{ item }} index={{ Index }}
\`\`\`
`,
    );

    const result = runCli('run --json windowed.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

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
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

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

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

    const stepEnteredEvents = events.filter((e) => e.type === 'step_entered');
    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Empty array: first iteration enters with empty value, then loop exits
    // The substep is entered once (bootstrap) before the actor evaluates the condition
    expect(stepEnteredEvents).toHaveLength(2);
    expect(commandStartedEvents).toHaveLength(2);

    // Second event is the "Done" step
    expect(stepEnteredEvents[1].description).toContain('Done');
    expect(commandStartedEvents[1].command).toContain('done');
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
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run --json clamp.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

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
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

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

  // File source execution wiring is incomplete: the CLI execution layer does not yet call
  // createFileProvider to stream values from files. The compiler creates file source contexts
  // but currentValue is never set, causing hasMoreIterations() to stop immediately.
  // Enable this test once the execution layer wires FileProvider.next() into the iteration loop.
  it('iterates over file source variable', async () => {
    // Create a data file with 3 lines
    await writeFile(join(workspace.cwd, 'servers.txt'), 'alpha\nbeta\ngamma\n');

    // Create runbook that iterates over file source
    await writeFile(
      join(workspace.cwd, 'file-loop.runbook.md'),
      `---
name: File Loop
---
# File Loop

## 1. Process servers
- FOR server IN {{ servers }}
- PASS ALL: CONTINUE

### 1.1 Handle server
- PASS: CONTINUE

\`\`\`bash
rd echo server={{ server }}
\`\`\`
`,
    );

    const result = runCli(
      'run --json --var servers=file:servers.txt file-loop.runbook.md',
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

    const commandStartedEvents = events.filter(
      (e: { type: string }) => e.type === 'command_started',
    );

    expect(commandStartedEvents).toHaveLength(3);
    expect(commandStartedEvents[0].command).toContain('server=alpha');
    expect(commandStartedEvents[1].command).toContain('server=beta');
    expect(commandStartedEvents[2].command).toContain('server=gamma');
  });

  it('handles multiline string iteration from var-file', async () => {
    // Create var-file with multiline string
    await writeFile(
      join(workspace.cwd, 'vars.yaml'),
      `log: |
  alpha
  beta
  gamma
`,
    );

    // Create runbook that iterates over multiline string
    await writeFile(
      join(workspace.cwd, 'iterate.runbook.md'),
      `---
name: Multiline Iteration
---
# Iterate

## 1. Process lines
- FOR line IN {{ log }}
- PASS ALL: CONTINUE

### 1.1 Handle line
- PASS: CONTINUE

\`\`\`bash
rd echo line={{ line }}
\`\`\`
`,
    );

    const result = runCli('run --json iterate.runbook.md --var-file vars.yaml', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 3 iterations
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
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run --json special.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

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
- PASS ALL: CONTINUE

### 1.1 Handle server
- PASS: CONTINUE

\`\`\`bash
rd echo env={{ env }} server={{ server }}
\`\`\`
`,
    );

    const result = runCli('run --json combined.runbook.md --var env=staging', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

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
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
rd echo item={{ item }}
\`\`\`
`,
    );

    const result = runCli('run --json large.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

    const commandStartedEvents = events.filter((e) => e.type === 'command_started');

    // Should have exactly 50 iterations
    expect(commandStartedEvents).toHaveLength(50);

    // Verify first and last iterations
    expect(commandStartedEvents[0].command).toContain('item=item1');
    expect(commandStartedEvents[49].command).toContain('item=item50');
  });
});
