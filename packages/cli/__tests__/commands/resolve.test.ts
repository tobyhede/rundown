/**
 * Tests for the `rd resolve` command.
 *
 * Validates that the resolve command runs the full variable/source resolution
 * pipeline and reports structural errors, resolved variables, data sources,
 * and unresolved variable warnings.
 *
 * @module tests/commands/resolve
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('rd resolve', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('resolves valid runbook with no variables — PASS with builtins only', async () => {
    const runbookPath = path.join(workspace.cwd, 'simple.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## Step 1
echo hello
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath} --json`, workspace);
    const output = JSON.parse(result.stdout);

    expect(output.valid).toBe(true);
    expect(output.errors).toEqual([]);
    expect(output.stats).toEqual({ steps: 1, substeps: 0 });
    expect(output.variables).toBeDefined();
    // Built-in variables should be present
    expect(output.variables).toHaveProperty('Date');
    expect(output.variables).toHaveProperty('Year');
    expect(output.variables).toHaveProperty('WorkPath');
  });

  it('resolves valid runbook with frontmatter vars — shows resolved variables', async () => {
    const runbookPath = path.join(workspace.cwd, 'vars.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `---
name: test-runbook
vars:
  environment: development
  port: 3000
---
## Step 1
Server on port {{ port }} in {{ environment }} mode.
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath} --json`, workspace);
    const output = JSON.parse(result.stdout);

    expect(output.valid).toBe(true);
    expect(output.variables).toHaveProperty('environment', 'development');
    expect(output.variables).toHaveProperty('port', '3000');
  });

  it('resolves with --var flags — CLI vars override frontmatter', async () => {
    const runbookPath = path.join(workspace.cwd, 'override.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `---
name: test-runbook
vars:
  environment: development
---
## Step 1
Deploy to {{ environment }}.
`,
    );

    const result = await runCliInProcess(
      `resolve ${runbookPath} --var environment=staging --json`,
      workspace,
    );
    const output = JSON.parse(result.stdout);

    expect(output.valid).toBe(true);
    expect(output.variables).toHaveProperty('environment', 'staging');
  });

  it('reports unresolved variables as warnings', async () => {
    const runbookPath = path.join(workspace.cwd, 'missing.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## Step 1
Deploy to {{ missingVar }}.
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath} --json`, workspace);
    const output = JSON.parse(result.stdout);

    // Unresolved vars are warnings, not errors — still valid structurally
    expect(output.valid).toBe(true);
    expect(output.unresolved).toContain('missingVar');
    // Unresolved warnings should include kind discriminant
    const unresolvedWarning = output.warnings?.find((w: { message: string }) =>
      w.message.includes('missingVar'),
    );
    expect(unresolvedWarning).toBeDefined();
    expect(unresolvedWarning.kind).toBe('unresolved');
  });

  it('reports structural errors AND variables both present', async () => {
    const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
    // Non-sequential step number produces a validation diagnostic (not parser throw)
    fs.writeFileSync(
      runbookPath,
      `---
vars:
  environment: staging
---
## 3. Deploy
Deploy to {{ environment }}.
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath} --json`, workspace);
    const output = JSON.parse(result.stdout);

    expect(output.valid).toBe(false);
    expect(output.errors.length).toBeGreaterThan(0);
    expect(output.errors[0].message).toContain('sequential');
    // Variables should still be resolved even with structural errors
    expect(output.variables).toHaveProperty('environment', 'staging');
  });

  it('shows FOR loop with valid array data source', async () => {
    // Use --var-file to supply array source (bypasses config discovery)
    const varFile = path.join(workspace.cwd, 'vars.yaml');
    fs.writeFileSync(
      varFile,
      `items:
  - alpha
  - beta
  - gamma
`,
    );

    const runbookPath = path.join(workspace.cwd, 'for-loop.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1. Process items
- FOR item IN {{ items }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo {{ item }}
\`\`\`
`,
    );

    const result = await runCliInProcess(
      `resolve ${runbookPath} --var-file ${varFile} --json`,
      workspace,
    );
    const output = JSON.parse(result.stdout);

    // Diagnostic: surface actual errors if resolve unexpectedly fails
    expect(result.stderr).toBe('');
    expect(output.errors).toEqual([]);
    expect(output).toMatchObject({ valid: true });
    expect(output.sources).toBeDefined();
    expect(output.sources).toHaveProperty('items');
    expect(output.sources.items.kind).toBe('array');
    expect(output.sources.items.items).toBe(3);
  });

  it('reports error for undefined FOR loop data source', async () => {
    const runbookPath = path.join(workspace.cwd, 'bad-source.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1. Process items
- FOR item IN {{ missing_source }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo hello
\`\`\`
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath} --json`, workspace);
    const output = JSON.parse(result.stdout);

    expect(output.valid).toBe(false);
    // Diagnostic: surface actual errors when expected source error not found
    expect(output.errors.map((e: { message: string }) => e.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('missing_source')]),
    );
    const sourceError = output.errors.find((e: { message: string }) =>
      e.message.includes('missing_source'),
    );
    expect(sourceError).toBeDefined();
  });

  it('exits 1 for file not found', async () => {
    const result = await runCliInProcess('resolve nonexistent.md --json', workspace);
    expect(result.exitCode).toBe(1);

    const output = JSON.parse(result.stdout);
    expect(output.valid).toBe(false);
    expect(output.errors[0].message).toContain('File not found');
  });

  it('discovers .rundown/config.yaml in workspace with .git boundary', async () => {
    // Regression: config discovery failed in CI when workspace had no .git marker,
    // causing findConfigFile to walk above the temp dir
    const configDir = path.join(workspace.cwd, '.rundown');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      `servers:
  - alpha
  - beta
`,
    );

    const runbookPath = path.join(workspace.cwd, 'config-discovery.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1. Deploy servers
- FOR server IN {{ servers }}
- PASS ALL: CONTINUE

### 1.1 Deploy server
- PASS: CONTINUE

\`\`\`bash
echo {{ server }}
\`\`\`
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath} --json`, workspace);
    const output = JSON.parse(result.stdout);

    // Diagnostic: surface actual errors if config discovery fails
    expect(result.stderr).toBe('');
    expect(output.errors).toEqual([]);
    // Config discovery should find .rundown/config.yaml within the workspace
    // (workspace has .git marker from createTestWorkspace preventing upward walk)
    expect(output.valid).toBe(true);
    expect(output.sources).toBeDefined();
    expect(output.sources).toHaveProperty('servers');
    expect(output.sources.servers.kind).toBe('array');
    expect(output.sources.servers.items).toBe(2);
  });

  it('outputs valid JSON matching schema with --json', async () => {
    const runbookPath = path.join(workspace.cwd, 'schema-test.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `---
vars:
  name: world
---
## Step 1
Hello {{ name }}.
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath} --json`, workspace);
    const output = JSON.parse(result.stdout);

    // Check required fields per ResolveResponseSchema
    expect(typeof output.valid).toBe('boolean');
    expect(Array.isArray(output.errors)).toBe(true);
    if (output.stats) {
      expect(typeof output.stats.steps).toBe('number');
      expect(typeof output.stats.substeps).toBe('number');
    }
    if (output.variables) {
      expect(typeof output.variables).toBe('object');
    }
  });

  it('has schema registered for --schema flag', async () => {
    // --schema is handled early in cli.ts (before Commander), not via runCliInProcess.
    // Verify the schema is registered in COMMAND_SCHEMAS instead.
    const { COMMAND_SCHEMAS } = await import('../../src/schemas/output-schemas.js');
    expect(COMMAND_SCHEMAS).toHaveProperty('resolve');
    expect(typeof COMMAND_SCHEMAS.resolve.safeParse).toBe('function');
  });

  it('renders text output for valid runbook', async () => {
    const runbookPath = path.join(workspace.cwd, 'text.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `---
vars:
  greeting: hello
---
## Step 1
Say {{ greeting }}.
`,
    );

    const result = await runCliInProcess(`resolve ${runbookPath}`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stdout).toContain('Variables:');
    expect(result.stdout).toContain('greeting');
  });
});
