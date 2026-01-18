import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync } from 'fs';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Integration tests for action display.
 *
 * These tests verify that the CLI displays the correct action type
 * based on what's defined in the runbook, not computed from step numbers.
 *
 * This was a bug where CONTINUE transitions were incorrectly shown as
 * "GOTO X" when step numbers weren't sequential (e.g., step 2 -> step 3.1).
 */
describe('integration: action display', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('CONTINUE action display (bug regression)', () => {
    it('displays CONTINUE for step-to-step transitions with default PASS: CONTINUE', () => {
      // Verify CONTINUE is displayed for sequential step transitions
      const runbook = `## 1. First step

\`\`\`bash
rd echo --result pass
\`\`\`

## 2. Second step

\`\`\`bash
rd echo --result pass
\`\`\`

## 3. Third step

\`\`\`bash
rd echo --result pass
\`\`\`
`;

      writeFileSync(workspace.runbookPath('test.runbook.md'), runbook);

      const result = runCli('run runbooks/test.runbook.md', workspace);

      // All transitions should show CONTINUE because that's the default
      const lines = result.stdout.split('\n');
      const actionLines = lines.filter(line => line.includes('Action:'));

      // First action should be START
      expect(actionLines[0]).toContain('START');

      // Subsequent actions should be CONTINUE, not GOTO
      for (let i = 1; i < actionLines.length; i++) {
        const line = actionLines[i];
        // Should NOT contain "GOTO" for default transitions
        if (!line.includes('COMPLETE')) {
          expect(line).toContain('CONTINUE');
          expect(line).not.toMatch(/GOTO\s+\d/); // Should not be "GOTO 3"
        }
      }
    });

    it('displays GOTO for explicit GOTO transitions', () => {
      const runbook = `---
name: test
---
# Test Runbook

## 1. First step

PASS: GOTO 3

\`\`\`bash
rd echo --result pass
\`\`\`

## 2. Second step (skipped)

\`\`\`bash
rd echo --result pass
\`\`\`

## 3. Third step

\`\`\`bash
rd echo --result pass
\`\`\`
`;

      writeFileSync(workspace.runbookPath('test.runbook.md'), runbook);

      const result = runCli('run runbooks/test.runbook.md', workspace);

      // Should show GOTO 3 for the explicit GOTO transition
      expect(result.stdout).toContain('GOTO 3');
    });

    it('displays GOTO with named step for explicit GOTO to named step', () => {
      const runbook = `---
name: test
---
# Test Runbook

## 1. First step

FAIL: GOTO ErrorHandler

\`\`\`bash
rd echo --result fail
\`\`\`

## ErrorHandler. Handle errors

\`\`\`bash
rd echo --result pass
\`\`\`
`;

      writeFileSync(workspace.runbookPath('test.runbook.md'), runbook);

      const result = runCli('run runbooks/test.runbook.md', workspace);

      // Should show GOTO ErrorHandler
      expect(result.stdout).toContain('GOTO ErrorHandler');
    });
  });

  describe('RETRY action display', () => {
    it('displays RETRY with count for RETRY transitions', () => {
      // Use the existing retry.runbook.md fixture which has proper RETRY syntax
      const result = runCli('run runbooks/retry.runbook.md', workspace);

      // Should show RETRY with count (fixture has FAIL: RETRY 3)
      expect(result.stdout).toMatch(/RETRY\s+\(1\/3\)/);
      expect(result.stdout).toMatch(/RETRY\s+\(2\/3\)/);
    });
  });

  describe('substep transitions', () => {
    it('displays CONTINUE for sequential substep transitions', () => {
      // Create a runbook with sequential substeps
      const runbook = `---
name: test
---
# Test Runbook

## 1. Step with substeps

### 1.1 First substep

\`\`\`bash
rd echo --result pass
\`\`\`

### 1.2 Second substep

\`\`\`bash
rd echo --result pass
\`\`\`

## 2. Final step

PASS: COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;

      writeFileSync(workspace.runbookPath('substeps-continue.runbook.md'), runbook);

      const result = runCli('run runbooks/substeps-continue.runbook.md', workspace);

      // Should contain CONTINUE actions for substep transitions (1.1 -> 1.2)
      expect(result.stdout).toContain('CONTINUE');
    });

    it('displays GOTO for explicit GOTO to substep', () => {
      // Create a runbook with explicit GOTO to substep
      const runbook = `---
name: test
---
# Test Runbook

## 1. Step with substeps

### 1.1 First substep

PASS: GOTO 1.3

\`\`\`bash
rd echo --result pass
\`\`\`

### 1.2 Skipped substep

\`\`\`bash
rd echo --result pass
\`\`\`

### 1.3 Target substep

PASS: COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;

      writeFileSync(workspace.runbookPath('substep-goto.runbook.md'), runbook);

      const result = runCli('run runbooks/substep-goto.runbook.md', workspace);

      // Should show GOTO 1.3 for the explicit GOTO transition
      expect(result.stdout).toContain('GOTO 1.3');
    });
  });
});
