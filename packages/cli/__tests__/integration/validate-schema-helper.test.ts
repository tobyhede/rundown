import { describe, expect, it } from '@jest/globals';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCli } from '../helpers/test-utils.js';

/**
 * End-to-end coverage for the built-in `validateSchema` template helper, which
 * renders to a complete `rdx --validate <path>` command. The helper is unit-
 * tested in core, but these cases pin its behavior through the real CLI render
 * path (parser classification -> core rendering).
 */
describe('validateSchema helper integration', () => {
  it('renders a literal path to an rdx --validate command', async () => {
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'validate-literal.runbook.md'),
        `# Validate Schema

## 1. Validate
- PASS COMPLETE

\`\`\`bash
{{ validateSchema "schemas/review.schema.json" }}
\`\`\`
`,
      );

      const result = runCli(['run', 'validate-literal.runbook.md', '--prompted'], workspace);

      expect(result.exitCode).toBe(0);
      const entered = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'step_entered');
      expect(entered.commandCode).toBe('rdx --validate schemas/review.schema.json');
    } finally {
      await workspace.cleanup();
    }
  });

  it('renders an ARTIFACTS-declared schema reference to a canonical rdx --validate command', async () => {
    const workspace = await createTestWorkspace();
    try {
      await mkdir(join(workspace.cwd, 'schemas'), { recursive: true });
      const schemaPath = join(workspace.cwd, 'schemas', 'review.schema.json');
      await writeFile(schemaPath, '{}');
      const canonicalSchemaPath = await realpath(schemaPath);
      await writeFile(
        join(workspace.cwd, 'validate-artifact.runbook.md'),
        `# Validate Schema

## 1. Validate
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS COMPLETE

\`\`\`bash
{{ validateSchema ReviewSchemaPath }}
\`\`\`
`,
      );

      const result = runCli(['run', 'validate-artifact.runbook.md', '--prompted'], workspace);

      expect(result.exitCode).toBe(0);
      const entered = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'step_entered');
      expect(entered.commandCode).toContain('rdx --validate ');
      expect(entered.commandCode).toContain(canonicalSchemaPath);
    } finally {
      await workspace.cleanup();
    }
  });
});
