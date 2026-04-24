import { describe, it, expect } from '@jest/globals';
import {
  parseRunbook,
  parseRunbookDocument,
  formatLineNum,
  RunbookSyntaxError,
  isReservedWord,
} from '../src/index.js';
import { assertStepHasSubsteps, assertStepWithCommand, assertStepWithFor } from './helpers.js';

describe('Step-level runbooks', () => {
  it('parses runbook list in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Execute runbook
- PASS CONTINUE
- FAIL STOP

 - task-details.runbook.md
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].runbooks).toEqual(['task-details.runbook.md']);
  });

  it('rejects step with both runbooks and substeps', () => {
    const markdown = `## 1. Execute

 - task.runbook.md

### 1.1 Substep
- PASS CONTINUE
- FAIL STOP

Do work.
`;
    expect(() => parseRunbook(markdown)).toThrow(/Violates Exclusivity Rule/i);
  });

  it('parses multiple runbooks on substep', () => {
    const markdown = `## 1. Execute

### 1.1 Runbooks
- PASS CONTINUE
- FAIL STOP

 - runbook-a.runbook.md
 - runbook-b.runbook.md
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].runbooks).toEqual(['runbook-a.runbook.md', 'runbook-b.runbook.md']);
  });
});

describe('parseRunbook with substep runbooks', () => {
  it('should parse runbook list in substep', () => {
    const markdown = `# Test Runbook

## 1. Dispatch agents

### 1.1 Review step
- PASS CONTINUE
- FAIL STOP

 - review.runbook.md
 - security.runbook.md
`;

    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].runbooks).toEqual(['review.runbook.md', 'security.runbook.md']);
  });
});

describe('H3 substep with runbook list — variations', () => {
  it('parses mixed H3 substeps: prose sibling and runbook-list sibling in same parent', () => {
    const markdown = `## 1. Execute

### 1.1 Analyze
- PASS CONTINUE
- FAIL STOP

Do analysis work.

### 1.2 Run child
- PASS CONTINUE
- FAIL STOP

- child.runbook.md
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(2);
    expect(step.substeps[0].prompt).toBe('Do analysis work.');
    expect(step.substeps[0].runbooks).toBeUndefined();
    expect(step.substeps[1].prompt).toBeUndefined();
    expect(step.substeps[1].runbooks).toEqual(['child.runbook.md']);
  });

  it('parses template variable reference in H3 runbook list path', () => {
    const markdown = `## 1. Execute

### 1.1 Run plan
- PASS CONTINUE
- FAIL STOP

- {{ PlanPath }}
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const substep = step.substeps[0];
    expect(substep.runbooks).toEqual([{ ref: 'PlanPath' }]);
  });

  it('preserves H3 header description when substep body is runbook list only', () => {
    const markdown = `## 1. Execute

### 1.1 Review plan
- PASS CONTINUE
- FAIL STOP

- review-plan.runbook.md
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const substep = step.substeps[0];
    expect(substep.id).toBe('1');
    expect(substep.description).toBe('Review plan');
    expect(substep.runbooks).toEqual(['review-plan.runbook.md']);
    expect(substep.prompt).toBeUndefined();
  });

  it('parses two H3 runbook-list substeps preserving both descriptions', () => {
    const markdown = `## 1. Execute
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Write plan
- write-plan.runbook.md

### 1.2 Review plan
- review-plan.runbook.md
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(2);
    const [sub1, sub2] = step.substeps;
    expect(sub1.description).toBe('Write plan');
    expect(sub1.runbooks).toEqual(['write-plan.runbook.md']);
    expect(sub1.prompt).toBeUndefined();
    expect(sub2.description).toBe('Review plan');
    expect(sub2.runbooks).toEqual(['review-plan.runbook.md']);
    expect(sub2.prompt).toBeUndefined();
  });
});

describe('inline code preservation', () => {
  it('preserves inline code in step description', () => {
    const md = `## 1. Path: \`/some/path\`
Content here.`;
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Path: `/some/path`');
  });

  it('preserves inline code in prompt text', () => {
    const md = `## 1. Execute
- PASS CONTINUE

Run the command \`npm install\` first.`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toContain('`npm install`');
  });
});

describe('code block flexibility', () => {
  it('supports sh and shell aliases for commands', () => {
    const markdown = `## 1. Sh
\`\`\`sh
ls
\`\`\`

## 2. Shell
\`\`\`shell
pwd
\`\`\`
`;
    const steps = parseRunbook(markdown);
    const step0 = steps[0];
    assertStepWithCommand(step0);
    expect(step0.command.code).toBe('ls');
    const step1 = steps[1];
    assertStepWithCommand(step1);
    expect(step1.command.code).toBe('pwd');
  });

  it('treats prompt tag as rd prompt command', () => {
    const markdown = `## 1. Instruction
\`\`\`prompt
Please look at this example.
\`\`\`
`;
    const steps = parseRunbook(markdown);
    // prompt blocks become rd prompt commands
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command).toEqual({
      code: "rd prompt 'Please look at this example.'",
      lang: 'prompt',
    });
    expect(steps[0].prompt).toBeUndefined(); // No prompt text from prompt blocks
  });

  it('converts non-executable tagged code blocks to prompt commands', () => {
    const markdown = `## 1. Example
\`\`\`json
{"key": "value"}
\`\`\`
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command).toEqual({
      code: 'rd prompt \'{"key": "value"}\'',
      lang: 'prompt',
    });
  });

  it('converts yaml code blocks to prompt commands', () => {
    const markdown = `## 1. Example
\`\`\`yaml
key: value
\`\`\`
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command).toEqual({
      code: "rd prompt 'key: value'",
      lang: 'prompt',
    });
  });

  it('rejects bare code fences (no info string) as invalid', () => {
    const markdown = `## 1. Example
\`\`\`
some content
\`\`\`
`;
    expect(() => parseRunbook(markdown)).toThrow(RunbookSyntaxError);
  });

  it('treats prompt code blocks as rd prompt commands', () => {
    const md = `## 1. Step with prompted code
- PASS COMPLETE

Show this to agent.

\`\`\`prompt
npm run example --flag value
\`\`\`
`;
    const steps = parseRunbook(md);
    // prompt block becomes command, text before it becomes prompt
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command).toEqual({
      code: "rd prompt 'npm run example --flag value'",
      lang: 'prompt',
    });
    expect(steps[0].prompt).toBe('Show this to agent.'); // Text BEFORE code block
  });

  // Test escaping of single quotes in prompt blocks
  it('escapes single quotes in prompt code blocks', () => {
    const md = `## 1. Step with quotes
\`\`\`prompt
echo 'hello world'
\`\`\`
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command).toEqual({
      code: "rd prompt 'echo '\\''hello world'\\'''",
      lang: 'prompt',
    });
  });

  // Keep but remove prompted check
  it('parses bash code blocks as executable commands', () => {
    const md = `## 1. Step with bash code
- PASS COMPLETE

Run this automatically.

\`\`\`bash
npm run build
\`\`\`
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command).toEqual({
      code: 'npm run build',
      lang: 'bash',
    });
    // No need to check prompted - field doesn't exist anymore
  });

  it('captures language tag from code blocks', () => {
    const markdown = `## 1. Bash
\`\`\`bash
echo "hello"
\`\`\`

## 2. Shell
\`\`\`shell
echo "hello"
\`\`\`
`;
    const steps = parseRunbook(markdown);
    const step0 = steps[0];
    const step1 = steps[1];
    assertStepWithCommand(step0);
    assertStepWithCommand(step1);
    expect(step0.command.lang).toBe('bash');
    expect(step1.command.lang).toBe('shell');
  });
});

describe('Implicit prompts with lists', () => {
  it('preserves bulleted instructions in prompts', () => {
    const markdown = `## 1. Execute
- PASS CONTINUE
- FAIL STOP

The following instructions are important:
- instruction 1
- instruction 2
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].prompt).toContain('The following instructions are important:');
    expect(steps[0].prompt).toContain('- instruction 1');
    expect(steps[0].prompt).toContain('- instruction 2');
  });
});

describe('GOTO substep validation', () => {
  it('accepts GOTO 2.1 when step 2 has static substep 1', () => {
    const markdown = `
## 1. First
- PASS GOTO 2.1
- FAIL STOP

## 2. Second

### 2.1 Substep one
- PASS CONTINUE
- FAIL STOP

Do something.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'GOTO', target: { step: '2', substep: '1' } },
    });
  });

  it('rejects GOTO 2.99 when substep does not exist', () => {
    const markdown = `
## 1. First
- PASS GOTO 2.99
- FAIL STOP

## 2. Second

### 2.1 Only substep
- PASS CONTINUE
- FAIL STOP
`;
    expect(() => parseRunbook(markdown)).toThrow(/substep does not exist/i);
  });
});

describe('substep with prompts', () => {
  it('parses implicit prompt in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Implement task
- PASS CONTINUE
- FAIL STOP

This is the implicit prompt text.
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].prompt).toBe('This is the implicit prompt text.');
  });
});

describe('substep with transitions', () => {
  it('parses transitions in substep', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS CONTINUE
- FAIL STOP "BLOCKED"

Do work.

### 1.2 Second step
- PASS COMPLETE
- FAIL GOTO 1.1

More work.
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect(step.substeps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP', message: 'BLOCKED' },
    });
    expect(step.substeps[1].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'COMPLETE' },
    });
    expect(step.substeps[1].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'GOTO', target: { step: '1', substep: '1' } },
    });
  });

  it('single substep gets transitions not step', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS CONTINUE
- FAIL STOP

Do work.
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect(step.substeps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP' },
    });
  });
});

describe('step-level transition preservation with substeps', () => {
  it('preserves step-level transitions when multiple substeps exist', () => {
    const markdown = `## 1. Aggregated check

- PASS ALL COMPLETE
- FAIL ANY STOP "A check failed"

### 1.1 First check

Do check one.

### 1.2 Second check

Do check two.
`;
    const steps = parseRunbook(markdown);
    // Step-level transitions should be preserved
    expect(steps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'COMPLETE' },
    });
    expect(steps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP', message: 'A check failed' },
    });
    expect(steps[0].aggregation?.strategy).toBe('ALL');
    // Substeps should have context-aware defaults (DEFER/DEFER under aggregation)
    const step0 = steps[0];
    assertStepHasSubsteps(step0);
    expect(step0.substeps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'DEFER' },
    });
    expect(step0.substeps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'DEFER' },
    });
    expect(step0.substeps[1].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'DEFER' },
    });
    expect(step0.substeps[1].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'DEFER' },
    });
  });

  it('preserves step-level transitions with FOR clause and substeps', () => {
    const markdown = `## 1. Process items

- FOR item IN 1 TO 3
  - FAIL CONTINUE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Check {{item}}

Do the check.
`;
    const steps = parseRunbook(markdown);
    // Step-level transitions should be preserved
    expect(steps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'COMPLETE' },
    });
    // FOR clause transitions should also be set
    const step0 = steps[0];
    assertStepWithFor(step0);
    expect(step0.forClause.transitions!.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    // Substeps should have context-aware defaults (DEFER/DEFER for runbooks)
    expect(step0.substeps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'DEFER' },
    });
    expect(step0.substeps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'DEFER' },
    });
  });

  it('substeps under non-aggregating parent get CONTINUE/STOP', () => {
    const markdown = `## 1. Sequential check

### 1.1 First check

Do check one.

### 1.2 Second check

Do check two.
`;
    const steps = parseRunbook(markdown);
    // No aggregation on parent step
    expect(steps[0].aggregation).toBeUndefined();
    // Substeps get CONTINUE/STOP defaults (no aggregation context)
    const step0 = steps[0];
    assertStepHasSubsteps(step0);
    expect(step0.substeps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect(step0.substeps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP' },
    });
    expect(step0.substeps[1].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect(step0.substeps[1].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP' },
    });
  });

  it('explicit substep transitions preserved under aggregating parent', () => {
    const markdown = `## 1. Aggregated check

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Explicit substep
- PASS DEFER
- FAIL STOP

### 1.2 Default substep

Do check.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].aggregation?.strategy).toBe('ALL');
    // Substep 1: explicit transitions preserved (DEFER/STOP, not overridden)
    const step0 = steps[0];
    assertStepHasSubsteps(step0);
    expect(step0.substeps[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'DEFER' },
    });
    expect(step0.substeps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP' },
    });
    // Substep 2: no explicit transitions → gets default DEFER/DEFER under aggregation
    expect(step0.substeps[1].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'DEFER' },
    });
    expect(step0.substeps[1].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'DEFER' },
    });
  });
});

describe('substep GOTO validation', () => {
  it('accepts GOTO to sibling substep', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS CONTINUE
- FAIL GOTO 1.2

### 1.2 Second step
- PASS CONTINUE
- FAIL STOP
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].transitions.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'GOTO', target: { step: '1', substep: '2' } },
    });
  });

  it('rejects GOTO to non-existent substep from substep', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS CONTINUE
- FAIL GOTO 1.99

### 1.2 Second step
- PASS CONTINUE
- FAIL STOP
`;
    expect(() => parseRunbook(markdown)).toThrow(/substep.*does not exist|invalid/i);
  });
});

describe('substep with command', () => {
  it('parses bash code block in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Run checks
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
npm run lint
\`\`\`
`;
    const steps = parseRunbook(markdown);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].command?.code).toBe('npm run lint');
  });

  it('rejects multiple code blocks in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Run checks
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
npm run lint
\`\`\`

\`\`\`bash
npm test
\`\`\`
`;
    expect(() => parseRunbook(markdown)).toThrow(/multiple code blocks/i);
  });
});

describe('prompt as single string', () => {
  it('returns prompt as single string instead of array', () => {
    const markdown = `## 1. Step with prompt
- PASS CONTINUE
- FAIL STOP

This is the prompt text.
Multiple lines here.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].prompt).toBe('This is the prompt text.\nMultiple lines here.');
    expect('prompts' in steps[0]).toBe(false);
  });
});

describe('prompt ordering enforcement', () => {
  it('throws error when text appears after code block', () => {
    const markdown = `## 1. Bad ordering
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
npm test
\`\`\`

This text appears after the code block.
`;
    expect(() => parseRunbook(markdown)).toThrow(/prompt.*must appear before/i);
  });

  it('allows text before code block', () => {
    const markdown = `## 1. Good ordering
- PASS CONTINUE
- FAIL STOP

This prompt appears before the code block.

\`\`\`bash
npm test
\`\`\`
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].prompt).toBe('This prompt appears before the code block.');
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command.code).toBe('npm test');
  });

  it('throws error when text appears after code block in substep', () => {
    const markdown = `## 1. Parent

### 1.1 Substep
- PASS CONTINUE

Do work.

\`\`\`bash
echo "code"
\`\`\`

Text after code block - invalid.
`;
    expect(() => parseRunbook(markdown)).toThrow(/prompt.*must appear before/i);
  });

  // E5-R1: Edge case tests added from cross-check validation
  it('throws error when text appears after runbook list', () => {
    const markdown = `## 1. Step with runbooks
- PASS CONTINUE

- setup.runbook.md
- cleanup.runbook.md

This text appears after runbooks - invalid.
`;
    expect(() => parseRunbook(markdown)).toThrow(/prompt.*must appear before/i);
  });

  it('concatenates multiple paragraphs before code block', () => {
    const markdown = `## 1. Multi-paragraph prompt
- PASS CONTINUE

First paragraph of instructions.

Second paragraph with more details.

\`\`\`bash
npm test
\`\`\`
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].prompt).toContain('First paragraph');
    expect(steps[0].prompt).toContain('Second paragraph');
  });

  it('ignores whitespace-only paragraphs after code block', () => {
    const markdown = `## 1. Step with trailing whitespace
- PASS CONTINUE

Prompt text.

\`\`\`bash
npm test
\`\`\`
`;
    // Should not throw - whitespace-only is ignored
    const steps = parseRunbook(markdown);
    expect(steps[0].prompt).toBe('Prompt text.');
  });
});

describe('parseRunbook with named steps', () => {
  it('parses named step', () => {
    const md = `## 1 Main step
- PASS COMPLETE

## Cleanup
- PASS STOP

Handle cleanup`;

    const steps = parseRunbook(md);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      name: '1',
    });
    expect(steps[1]).toMatchObject({
      name: 'Cleanup',
    });
  });

  it('parses named substep of numeric step', () => {
    const md = `## 1 Main step
### 1.1 First substep
### 1.Cleanup Handle cleanup`;

    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(2);
    expect(step.substeps[0]).toMatchObject({
      id: '1',
    });
    expect(step.substeps[1]).toMatchObject({
      id: 'Cleanup',
    });
  });

  it('allows named step to coexist with static steps', () => {
    const md = `## 1 First
## 2 Second
## ErrorHandler
Handle errors`;

    const steps = parseRunbook(md);
    expect(steps).toHaveLength(3);
    expect(steps[2].name).toBe('ErrorHandler');
  });

  it('rejects reserved word as step name', () => {
    const md = `## NEXT Do something`;

    expect(() => parseRunbook(md)).toThrow();
  });
});

describe('parser validation edge cases', () => {
  describe('substep-parent mismatch', () => {
    it('rejects substep referencing wrong parent step', () => {
      const md = `## 1 First step
### 2.1 Wrong parent substep
Do work.`;
      expect(() => parseRunbook(md)).toThrow(/does not belong to step/);
    });
  });

  describe('duplicate substep IDs', () => {
    it('rejects duplicate substep IDs in same step', () => {
      const md = `## 1 Step
### 1.1 First substep
### 1.1 Duplicate substep`;
      expect(() => parseRunbook(md)).toThrow(/Duplicate substep ID/);
    });
  });

  describe('multiple code blocks', () => {
    it('rejects multiple code blocks in step', () => {
      const md = `## 1 Step
\`\`\`bash
echo first
\`\`\`

\`\`\`bash
echo second
\`\`\``;
      expect(() => parseRunbook(md)).toThrow(/Multiple code blocks per step not allowed/);
    });
  });

  describe('transition ordering', () => {
    it('rejects transitions after prompt text in step', () => {
      const md = `## 1 Step

This is prompt text that appears first.

- PASS CONTINUE
- FAIL STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the step header/,
      );
    });

    it('rejects transitions after content in step', () => {
      const md = `## 1 Step

\`\`\`bash
npm test
\`\`\`

- PASS CONTINUE
- FAIL STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the step header/,
      );
    });

    it('rejects transitions after prompt text in substep', () => {
      const md = `## 1 Step
### 1.1 Substep

This is prompt text.

- PASS CONTINUE
- FAIL STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the substep header/,
      );
    });

    it('rejects transitions after content in substep', () => {
      const md = `## 1 Step
### 1.1 Substep

\`\`\`bash
npm test
\`\`\`

- PASS CONTINUE
- FAIL STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the substep header/,
      );
    });

    it('rejects transitions after runbook entry followed by code block in substep', () => {
      // Runbook bullets alone do not block transitions, but a subsequent code block
      // must. `hasSeenNonRunbookContent` captures that non-runbook body content even
      // when `hasSeenRunbooks` is already set.
      const md = `## 1 Step
### 1.1 Substep

- child.runbook.md

\`\`\`bash
npm test
\`\`\`

- PASS CONTINUE
- FAIL STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the substep header/,
      );
    });

    it('accepts transitions after runbook entries (structural references do not block)', () => {
      const md = `## 1 Step
### 1.1 Substep

- first.runbook.md
- second.runbook.md

- PASS CONTINUE
- FAIL STOP`;
      const steps = parseRunbook(md);
      expect(steps).toHaveLength(1);
      expect(steps[0].substeps?.[0].transitions.pass.action).toEqual({ type: 'CONTINUE' });
      expect(steps[0].substeps?.[0].transitions.fail.action).toEqual({ type: 'STOP' });
    });

    it('rejects transitions after runbook → code block → runbook sequence in substep', () => {
      // Regression: `hasSeenRunbooks` remains true indefinitely, so the old gate
      // `hasSeenContent && !hasSeenRunbooks` silently re-opened transitions after the
      // second runbook bullet. `hasSeenNonRunbookContent` is sticky — it stays `true`
      // once the code block is seen and keeps the gate closed.
      const md = `## 1 Step
### 1.1 Substep

- first.runbook.md

\`\`\`bash
npm test
\`\`\`

- second.runbook.md

- PASS CONTINUE
- FAIL STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the substep header/,
      );
    });
  });

  describe('text after content', () => {
    it('rejects text after runbooks in substep', () => {
      const md = `## 1 Step
### 1.1 Substep
- PASS CONTINUE
- FAIL STOP

- setup.runbook.md

This text appears after runbooks - invalid.`;
      expect(() => parseRunbook(md)).toThrow(
        /Prompt text must appear before code blocks or runbooks/,
      );
    });
  });

  describe('preamble handling', () => {
    it('captures preamble text before first step', () => {
      const md = `# My Runbook

This is preamble text that describes the runbook.

## 1 First step
- PASS COMPLETE

Do the work.`;
      // This should parse without error - preamble is allowed
      const steps = parseRunbook(md);
      expect(steps).toHaveLength(1);
    });
  });

  describe('list transitions handling', () => {
    it('parses list-based transitions correctly', () => {
      const md = `## 1 Step

- PASS CONTINUE
- FAIL STOP

Do the work.`;
      const steps = parseRunbook(md);
      expect(steps[0].transitions.pass.action).toEqual({ type: 'CONTINUE' });
      expect(steps[0].transitions.fail.action).toEqual({ type: 'STOP' });
    });

    it('rejects list transitions after code block', () => {
      const md = `## 1 Step

\`\`\`bash
npm test
\`\`\`

- PASS CONTINUE
- FAIL STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the step header/,
      );
    });
  });

  describe('H1 and H4+ headers', () => {
    it('rejects H1 header that looks like a step', () => {
      const md = `# 1. This looks like a step but uses H1`;
      expect(() => parseRunbook(md)).toThrow(/H1 headers.*cannot be used as step headers/);
    });

    it('rejects H4 headers', () => {
      const md = `## 1 Step
#### 1.1.1 Too deep`;
      expect(() => parseRunbook(md)).toThrow(/H4\+ headings are not allowed/);
    });
  });

  describe('list item ordering', () => {
    it('rejects list items after transitions in substep', () => {
      const md = `## 1 Step
### 1.1 Substep
- PASS CONTINUE
- FAIL STOP

- some other list item (not a runbook)`;
      expect(() => parseRunbook(md)).toThrow(
        /Prompt text must appear before code blocks or runbooks/,
      );
    });

    it('allows runbook list item after transitions in substep', () => {
      const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE
- FAIL STOP

- task.runbook.md
`;
      const steps = parseRunbook(md);
      const step = steps[0];
      assertStepHasSubsteps(step);
      expect(step.substeps[0].runbooks).toEqual(['task.runbook.md']);
    });

    it('rejects list items after content in step', () => {
      const md = `## 1 Step

\`\`\`bash
npm test
\`\`\`

- some list item that is not a transition`;
      expect(() => parseRunbook(md)).toThrow(
        /Prompt text must appear before code blocks, substeps, or runbooks/,
      );
    });
  });
});

describe('parseRunbook with FOR clause', () => {
  it('parses FOR clause from full markdown', () => {
    const md = `## 1. Process batches
- FOR batch IN 1 TO 3
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle batch
\`\`\`bash
echo batch
\`\`\`

## 2. Done
- PASS COMPLETE
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithFor(step);
    expect(step.forClause).toEqual({ variable: 'batch', start: 1, end: 3 });
    expect(step.substeps).toHaveLength(1);
  });

  it('parses unresolved FOR clause with template variable from full markdown', () => {
    const md = `## 1. Process batches
- FOR batch IN 1 TO {{Max}}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle batch
\`\`\`bash
echo batch
\`\`\`

## 2. Done
- PASS COMPLETE
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithFor(step);
    expect(step.forClause).toEqual({
      unresolved: true,
      variable: 'batch',
      start: 1,
      end: { ref: 'Max' },
    });
    expect(step.kind).toBe('for');
    expect(step.substeps).toHaveLength(1);
  });

  describe('FOR clause nested transitions', () => {
    it('parses FOR with nested transitions (PASS ALL / FAIL ANY)', () => {
      const markdown = `## 1. Review
- FOR pass IN 1 TO 3
  - PASS ALL CONTINUE
  - FAIL ANY BREAK

### 1.1 Check
\`\`\`bash
echo check
\`\`\`
`;
      const steps = parseRunbook(markdown);
      const step = steps[0];
      assertStepWithFor(step);
      expect(step.forClause.transitions).toBeDefined();
      expect(step.forClause.aggregation?.strategy).toBe('ALL');
      expect(step.forClause.transitions!.pass).toEqual({
        kind: 'pass',
        retry: 0,
        action: { type: 'CONTINUE' },
      });
      expect(step.forClause.transitions!.fail).toEqual({
        kind: 'fail',
        retry: 0,
        action: { type: 'BREAK' },
      });
    });

    it('parses FOR without nested transitions', () => {
      const markdown = `## 1. Review
- FOR pass IN 1 TO 3

### 1.1 Check
\`\`\`bash
echo check
\`\`\`
`;
      const steps = parseRunbook(markdown);
      const step = steps[0];
      assertStepWithFor(step);
      // Without nested transitions, forClause transitions should be undefined
      expect(step.forClause.transitions).toBeUndefined();
    });

    it('throws error on invalid nested bullet under FOR', () => {
      const markdown = `## 1. Review
- FOR pass IN 1 TO 3
  - some random text

### 1.1 Check
\`\`\`bash
echo check
\`\`\`
`;
      expect(() => parseRunbook(markdown)).toThrow(/Invalid nested bullet under FOR clause/i);
    });

    it('throws error on nested FOR bullet without transition paragraph', () => {
      const markdown = `## 1. Review
- FOR pass IN 1 TO 3
  - <div>invalid</div>
`;
      expect(() => parseRunbook(markdown)).toThrow(/Invalid nested bullet under FOR clause/i);
    });

    it('throws error on nested FOR bullet with code block content', () => {
      const markdown = `## 1. Review
- FOR pass IN 1 TO 3
  - \`\`\`bash
    echo nope
    \`\`\`
`;
      expect(() => parseRunbook(markdown)).toThrow(/Invalid nested bullet under FOR clause/i);
    });

    it('parses FOR with nested transitions (PASS ANY / FAIL ALL)', () => {
      const markdown = `## 1. Review
- FOR pass IN 1 TO 3
  - PASS ANY CONTINUE
  - FAIL ALL BREAK

### 1.1 Check
\`\`\`bash
echo check
\`\`\`
`;
      const steps = parseRunbook(markdown);
      const step = steps[0];
      assertStepWithFor(step);
      expect(step.forClause.transitions).toBeDefined();
      expect(step.forClause.aggregation?.strategy).toBe('ANY');
      expect(step.forClause.transitions!.pass).toEqual({
        kind: 'pass',
        retry: 0,
        action: { type: 'CONTINUE' },
      });
      expect(step.forClause.transitions!.fail).toEqual({
        kind: 'fail',
        retry: 0,
        action: { type: 'BREAK' },
      });
    });
  });
});

describe('parser ordering enforcement', () => {
  describe('paragraph text containing transition-like content in substep', () => {
    it('treats transition-like paragraph text as prompt in substep', () => {
      const md = `## 1 Step

### 1.1 Sub

Prompt text here.

PASS: CONTINUE
FAIL: STOP
`;
      // Paragraph-style transitions are now treated as prompt text
      const steps = parseRunbook(md);
      const step = steps[0];
      assertStepHasSubsteps(step);
      const sub = step.substeps[0];
      // Substeps always have transitions (context-aware defaults CONTINUE/STOP)
      expect(sub.transitions).toBeDefined();
      expect(sub.transitions.pass.action.type).toBe('CONTINUE');
      expect(sub.transitions.fail.action.type).toBe('STOP');
      expect(sub.prompt).toContain('Prompt text here.');
      expect(sub.prompt).toContain('PASS: CONTINUE');
    });

    it('rejects paragraph text after code block in substep', () => {
      const md = `## 1 Step

### 1.1 Sub

\`\`\`bash
echo hi
\`\`\`

PASS: CONTINUE
`;
      // Paragraph text (even if it looks like a transition) after code block is rejected as ordering violation
      expect(() => parseRunbook(md)).toThrow(
        /Substep 1\.1.*Prompt text must appear before code blocks or runbooks/,
      );
    });
  });

  describe('paragraph text containing transition-like content at step level', () => {
    it('treats transition-like paragraph text as prompt in step', () => {
      const md = `## 1 Step

Some prompt text.

PASS: CONTINUE
FAIL: STOP
`;
      // Paragraph-style transitions are now treated as prompt text
      const steps = parseRunbook(md);
      // Steps always have transitions (default CONTINUE/STOP)
      expect(steps[0].transitions).toBeDefined();
      expect(steps[0].transitions.pass.action.type).toBe('CONTINUE');
      expect(steps[0].transitions.fail.action.type).toBe('STOP');
      expect(steps[0].prompt).toContain('Some prompt text.');
      expect(steps[0].prompt).toContain('PASS: CONTINUE');
    });

    it('rejects paragraph text after code block in step', () => {
      const md = `## 1 Step

\`\`\`bash
npm test
\`\`\`

PASS: CONTINUE
`;
      // Paragraph text (even if it looks like a transition) after code block is rejected as ordering violation
      expect(() => parseRunbook(md)).toThrow(
        /Step 1.*Prompt text must appear before code blocks, substeps, or runbooks/,
      );
    });
  });

  describe('FOR clause ordering violations', () => {
    it('rejects duplicate FOR clause', () => {
      const md = `## 1 Step
- FOR x IN 1 TO 3
- FOR y IN 1 TO 5
- PASS ALL CONTINUE
- FAIL ANY STOP
`;
      expect(() => parseRunbook(md)).toThrow(/has multiple FOR clauses.*only one is allowed/);
    });

    it('rejects FOR after transitions', () => {
      const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP
- FOR x IN 1 TO 3
`;
      expect(() => parseRunbook(md)).toThrow(/FOR clause must appear before transitions/);
    });

    it('rejects FOR after prompt text', () => {
      const md = `## 1 Step

Some prompt text.

- FOR x IN 1 TO 3
`;
      expect(() => parseRunbook(md)).toThrow(/FOR clause must appear before content/);
    });

    it('rejects FOR after code block content', () => {
      const md = `## 1 Step

\`\`\`bash
echo hi
\`\`\`

- FOR x IN 1 TO 3
`;
      expect(() => parseRunbook(md)).toThrow(/FOR clause must appear before content/);
    });

    it('rejects FOR in substep', () => {
      const md = `## 1 Step

### 1.1 Sub
- FOR x IN 1 TO 3
`;
      expect(() => parseRunbook(md)).toThrow(/FOR is only valid on steps.*not substeps/);
    });
  });
});

describe('INPUTS/OUTPUTS ordering violations', () => {
  describe('OUTPUTS after body content', () => {
    it('rejects OUTPUTS after prompt text', () => {
      const md = `## 1 Step\n\nSome text.\n\n- OUTPUTS\n  - Foo {{ "bar" }}\n`;
      expect(() => parseRunbook(md)).toThrow(/OUTPUTS.*must appear before/);
    });

    it('rejects OUTPUTS after fenced code block', () => {
      const md = `## 1 Step\n\n\`\`\`bash\necho hi\n\`\`\`\n\n- OUTPUTS\n  - Foo {{ "bar" }}\n`;
      expect(() => parseRunbook(md)).toThrow(/OUTPUTS.*must appear before/);
    });

    it('rejects OUTPUTS after prompt text in substep', () => {
      const md = `## 1 Step\n\n### 1.1 Sub\n\nSome text.\n\n- OUTPUTS\n  - Foo {{ "bar" }}\n`;
      expect(() => parseRunbook(md)).toThrow(/OUTPUTS.*must appear before/);
    });

    it('rejects OUTPUTS after code block in substep', () => {
      const md = `## 1 Step\n\n### 1.1 Sub\n\n\`\`\`bash\necho hi\n\`\`\`\n\n- OUTPUTS\n  - Foo {{ "bar" }}\n`;
      expect(() => parseRunbook(md)).toThrow(/OUTPUTS.*must appear before/);
    });

    it('rejects OUTPUTS after non-runbook bullet prose', () => {
      const md = `## 1 Step\n- some note\n\n- OUTPUTS\n  - Foo {{ "bar" }}\n`;
      expect(() => parseRunbook(md)).toThrow(/OUTPUTS.*must appear before/);
    });

    it('rejects OUTPUTS after non-runbook bullet prose in substep', () => {
      const md = `## 1 Step\n\n### 1.1 Sub\n- some note\n\n- OUTPUTS\n  - Foo {{ "bar" }}\n`;
      expect(() => parseRunbook(md)).toThrow(/OUTPUTS.*must appear before/);
    });
  });

  describe('INPUTS after body content (removed directive — emits diagnostic, no throw)', () => {
    // The - INPUTS step directive has been removed. Encountering it produces a
    // parse error diagnostic rather than throwing a RunbookSyntaxError.
    // These tests verify the directive no longer throws in any position.

    it('emits removal diagnostic for INPUTS after prompt text', () => {
      const md = `## 1 Step\n\nSome text.\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('emits removal diagnostic for INPUTS after runbook-list entry', () => {
      const md = `## 1 Step\n- foo.runbook.md\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('emits removal diagnostic for INPUTS after fenced code block', () => {
      const md = `## 1 Step\n\n\`\`\`bash\necho hi\n\`\`\`\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('emits removal diagnostic for INPUTS after non-runbook bullet prose', () => {
      const md = `## 1 Step\n- some note\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('emits removal diagnostic for INPUTS after non-runbook bullet prose in substep', () => {
      const md = `## 1 Step\n\n### 1.1 Sub\n- some note\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('emits removal diagnostic for INPUTS after prompt text in substep', () => {
      const md = `## 1 Step\n\n### 1.1 Sub\n\nSome text.\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('emits removal diagnostic for INPUTS after fenced code block in substep', () => {
      const md = `## 1 Step\n\n### 1.1 Sub\n\n\`\`\`bash\necho hi\n\`\`\`\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('emits removal diagnostic for INPUTS after runbook-list in substep', () => {
      const md = `## 1 Step\n\n### 1.1 Sub\n- foo.runbook.md\n\n- INPUTS\n  - Foo\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });
  });

  describe('interchangeable with transitions (must not over-reach)', () => {
    it('emits removal diagnostic for INPUTS before transitions (no longer valid)', () => {
      const md = `## 1 Step\n- INPUTS\n  - Foo\n- PASS CONTINUE\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });

    it('allows OUTPUTS after transitions', () => {
      const md = `## 1 Step\n- PASS CONTINUE\n- OUTPUTS\n  - Foo {{ "bar" }}\n`;
      expect(() => parseRunbook(md)).not.toThrow();
    });

    it('emits removal diagnostic for interleaved transitions and INPUTS directive', () => {
      const md = `## 1 Step\n- PASS CONTINUE\n- OUTPUTS\n  - Foo {{ "bar" }}\n- FAIL CONTINUE\n- INPUTS\n  - Bar\n`;
      const result = parseRunbookDocument(md);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('INPUTS step directive has been removed'),
        ),
      ).toBe(true);
    });
  });
});

describe('substep content filtering', () => {
  it('filters runbook references from substep prompt, preserves text', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE
- FAIL STOP

Review the following items.

- task.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const sub = step.substeps[0];
    expect(sub.prompt).toBe('Review the following items.');
    expect(sub.runbooks).toEqual(['task.runbook.md']);
  });

  it('returns empty prompt when substep has only runbook references', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE
- FAIL STOP

- alpha.runbook.md
- beta.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const sub = step.substeps[0];
    expect(sub.prompt).toBeUndefined();
    expect(sub.runbooks).toEqual(['alpha.runbook.md', 'beta.runbook.md']);
  });

  it('preserves prompt text alongside runbook refs in substep', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE
- FAIL STOP

Review the tasks carefully.

- setup.runbook.md
- deploy.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const sub = step.substeps[0];
    expect(sub.prompt).toContain('Review the tasks carefully.');
    expect(sub.runbooks).toEqual(['setup.runbook.md', 'deploy.runbook.md']);
  });

  it('canonicalizes step-level runbook refs into runbook-list-derived substeps', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- deploy.runbook.md
- verify.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.prompt).toBeUndefined();
    expect(step.substepsDerivedFromRunbookList).toBe(true);
    expect(step.substeps).toHaveLength(2);
    expect(step.substeps[0]).toMatchObject({
      id: '1',
      description: '',
      runbooks: ['deploy.runbook.md'],
    });
    expect(step.substeps[1]).toMatchObject({
      id: '2',
      description: '',
      runbooks: ['verify.runbook.md'],
    });
  });

  it('step owns step-level prompt even when substeps are synthesized from a runbook list', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

Review this checklist.

- deploy.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.prompt).toBe('Review this checklist.');
    expect(step.substeps[0]).toMatchObject({
      id: '1',
      description: '',
      runbooks: ['deploy.runbook.md'],
    });
    expect(step.substeps[0].prompt).toBeUndefined();
  });

  it('step-owns-prose contract: paragraph prose lands on step.prompt when followed by a runbook list', () => {
    const md = `## 1. Delegate subagents to review the plan
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

Delegate 4x subagents to review the plan.

- review-plan-technical-accuracy.runbook.md
- review-plan-structural-integrity.runbook.md
- review-plan-build-runtime.runbook.md
- review-plan-risk-safety.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.prompt).toBe('Delegate 4x subagents to review the plan.');
    expect(step.substeps).toHaveLength(4);
    for (const substep of step.substeps) {
      expect(substep.prompt).toBeUndefined();
      expect(substep.delegate).toBe(true);
    }
    expect(step.substeps.map((s) => s.runbooks)).toEqual([
      ['review-plan-technical-accuracy.runbook.md'],
      ['review-plan-structural-integrity.runbook.md'],
      ['review-plan-build-runtime.runbook.md'],
      ['review-plan-risk-safety.runbook.md'],
    ]);
    expect(step.substepsDerivedFromRunbookList).toBe(true);
  });

  it('step-owns-prose contract: single-entry runbook list does not migrate prose to substep[0]', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

Review this checklist before continuing.

- deploy.runbook.md
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBe('Review this checklist before continuing.');
    if (steps[0].kind === 'substeps') {
      expect(steps[0].substeps).toHaveLength(1);
      expect(steps[0].substeps[0].prompt).toBeUndefined();
      expect(steps[0].substeps[0].runbooks).toEqual(['deploy.runbook.md']);
    }
  });

  it('step-owns-prose contract: step with no prose and a runbook list produces no step.prompt', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- deploy.runbook.md
- verify.runbook.md
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBeUndefined();
    if (steps[0].kind === 'substeps') {
      expect(steps[0].substeps.every((s) => s.prompt === undefined)).toBe(true);
    }
  });

  it('step-owns-prose contract: non-runbook bullets preceding a runbook list roll up into step.prompt', () => {
    // Non-runbook bullets take the handleListItemContent path (parser.ts:599),
    // accumulating into ctx.implicitText. Paragraph prose takes the
    // appendPromptToStep path (parser.ts:445). Both must route to step.prompt
    // once a runbook list follows.
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- look at X
- check for Y

- deploy.runbook.md
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toContain('look at X');
    expect(steps[0].prompt).toContain('check for Y');
    // Unconditional: a regression that absorbed `- deploy.runbook.md` into
    // prompt text would silently pass with an `if (kind === 'substeps')` guard.
    expect(steps[0].kind).toBe('substeps');
    if (steps[0].kind !== 'substeps') return; // type-narrowing for the rest
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps[0].prompt).toBeUndefined();
    expect(steps[0].substeps[0].runbooks).toEqual(['deploy.runbook.md']);
  });

  it('canonicalizes FOR + step-level runbook list into runbook-list-derived substeps', () => {
    const md = `## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY GOTO Synthesize

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
- review-build-runtime.runbook.md
- review-risk-safety.runbook.md

## Synthesize
- PASS COMPLETE
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithFor(step);
    expect(step.forClause).toEqual({ variable: 'pass', start: 1, end: 2 });
    expect(step.substepsDerivedFromRunbookList).toBe(true);
    expect(step.substeps).toHaveLength(4);
    expect(step.substeps.map((s) => s.runbooks)).toEqual([
      ['review-technical-accuracy.runbook.md'],
      ['review-structural-integrity.runbook.md'],
      ['review-build-runtime.runbook.md'],
      ['review-risk-safety.runbook.md'],
    ]);
    expect(step.transitions.fail.action).toEqual({
      type: 'GOTO',
      target: { step: 'Synthesize' },
    });
  });
});

// Tests extractText branches not covered by 'inline code preservation' above:
// double-backtick wrapping (value contains backtick), negative single-backtick
// assertion, and non-text node types (emphasis, strong). Intentional overlap
// for mutation coverage of lines 32-51 in parser.ts.
describe('extractText and inline code', () => {
  it('uses double-backtick wrapping for code containing backtick character', () => {
    const md = '## 1. Use `` ` `` carefully\n- PASS COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Use `` ` `` carefully');
  });

  it('uses single-backtick wrapping for code without backtick character', () => {
    const md = '## 1. Run `test`\n- PASS COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Run `test`');
    expect(steps[0].description).not.toContain('``');
  });

  it('extracts text from emphasis nodes in headings', () => {
    const md = '## 1. Run the *important* task\n- PASS COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Run the important task');
  });

  it('extracts text from strong nodes in headings', () => {
    const md = '## 1. Run the **critical** task\n- PASS COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Run the critical task');
  });
});

describe('regex boundaries and runbook patterns', () => {
  it('does not match runbook ref with trailing text', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- task.runbook.md extra text
`;
    const steps = parseRunbook(md);
    // "task.runbook.md extra text" should NOT be parsed as a runbook ref
    expect('substeps' in steps[0]).toBe(false);
  });

  it('does not match bare .runbook.md without a filename prefix', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- .runbook.md
`;
    const steps = parseRunbook(md);
    // ".runbook.md" alone has no prefix — \S+ in the regex must capture at
    // least one char before the ".runbook.md" suffix, so this cannot match.
    expect('substeps' in steps[0]).toBe(false);
  });

  it('matches simple runbook ref', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- simple.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].runbooks).toEqual(['simple.runbook.md']);
  });

  it('matches path-like runbook ref', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- path/to/complex-name.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].runbooks).toEqual(['path/to/complex-name.runbook.md']);
  });

  it('does not treat .runbook.md.txt as a runbook ref', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

- task.runbook.md.txt
`;
    const steps = parseRunbook(md);
    expect('substeps' in steps[0]).toBe(false);
  });
});

describe('parseRunbookDocument metadata', () => {
  it('uses first H1 as title and ignores subsequent H1s', () => {
    const md = `# First Title

# Second Title

## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md);
    expect(doc.title).toBe('First Title');
  });

  it('captures preamble description from text between H1 and first step', () => {
    const md = `# My Runbook

This is the preamble description.

## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md);
    expect(doc.description).toBe('This is the preamble description.');
  });

  it('returns undefined description when no preamble text', () => {
    const md = `## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md);
    expect(doc.description).toBeUndefined();
  });

  it('derives name from filename when no frontmatter name', () => {
    const md = `## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md, 'my-runbook.md');
    expect(doc.name).toBe('my-runbook.md');
  });

  it('returns undefined name when no frontmatter and no filename', () => {
    const md = `## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md);
    expect(doc.name).toBeUndefined();
  });

  it('returns null frontmatter when no frontmatter present', () => {
    const md = `## 1 Step
- PASS COMPLETE
`;
    const { frontmatter } = parseRunbookDocument(md);
    expect(frontmatter).toBeNull();
  });

  it('returns validated frontmatter when present', () => {
    const md = `---
name: my-runbook
inputs:
  greeting: Hello
  count: 42
---
## 1 Step
- PASS COMPLETE
`;
    const { frontmatter } = parseRunbookDocument(md);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.name).toBe('my-runbook');
    expect(frontmatter?.inputs).toEqual({ greeting: 'Hello', count: 42 });
  });

  it('preserves extension fields in frontmatter via passthrough', () => {
    const md = `---
name: test
skill: code-review
---
## 1 Step
- PASS COMPLETE
`;
    const { frontmatter } = parseRunbookDocument(md);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.skill).toBe('code-review');
  });
});

describe('H1 step detection regex', () => {
  it('rejects H1 starting with multi-digit number followed by dot', () => {
    const md = '# 12. Step that uses H1\n';
    expect(() => parseRunbook(md)).toThrow(/H1 headers.*cannot be used as step headers/);
  });

  it('rejects H1 starting with number followed by closing paren', () => {
    const md = '# 1) Step that uses H1\n';
    expect(() => parseRunbook(md)).toThrow(/H1 headers.*cannot be used as step headers/);
  });

  it('rejects H1 starting with number followed by colon', () => {
    const md = '# 1: Step that uses H1\n';
    expect(() => parseRunbook(md)).toThrow(/H1 headers.*cannot be used as step headers/);
  });

  it('rejects H1 starting with number followed by dash', () => {
    const md = '# 1- Step that uses H1\n';
    expect(() => parseRunbook(md)).toThrow(/H1 headers.*cannot be used as step headers/);
  });

  it('rejects H1 starting with number followed by space', () => {
    const md = '# 1 Step that uses H1\n';
    expect(() => parseRunbook(md)).toThrow(/H1 headers.*cannot be used as step headers/);
  });

  it('allows H1 that does not look like a step', () => {
    const md = `# My Runbook Title

## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md);
    expect(doc.title).toBe('My Runbook Title');
  });
});

describe('finalizeStep coverage', () => {
  it('builds prompt from implicit text only', () => {
    const md = `## 1 Step
- PASS COMPLETE

This is implicit prompt text.
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBe('This is implicit prompt text.');
  });

  it('returns undefined prompt when no text provided', () => {
    const md = `## 1 Step
- PASS COMPLETE
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBeUndefined();
  });

  it('returns undefined substeps when step has no substeps', () => {
    const md = `## 1 Step
- PASS COMPLETE

Do the work.
`;
    const steps = parseRunbook(md);
    expect('substeps' in steps[0]).toBe(false);
  });

  it('returns substeps array when step has substeps', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS COMPLETE

Do work.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].id).toBe('1');
  });

  it('does not synthesize substeps when step has no runbook refs', () => {
    const md = `## 1 Step
- PASS COMPLETE

Just text.
`;
    const steps = parseRunbook(md);
    expect('substeps' in steps[0]).toBe(false);
  });
});

// Intentional overlap with 'substep content filtering' above: these tests add
// stronger negative assertions (not.toContain) and trim verification to kill
// surviving mutants in the split/filter/join logic at parser.ts lines 155-163.
describe('content filtering detail', () => {
  it('filters runbook lines from substep content while keeping non-runbook lines', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE
- FAIL STOP

Check the items.

- setup.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const sub = step.substeps[0];
    // Prompt should contain the text but NOT the runbook line
    expect(sub.prompt).toContain('Check the items.');
    expect(sub.prompt).not.toContain('setup.runbook.md');
    expect(sub.runbooks).toEqual(['setup.runbook.md']);
  });

  it('trims whitespace from filtered content', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE

Single line of text.

- task.runbook.md
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const sub = step.substeps[0];
    // Prompt should be trimmed
    expect(sub.prompt).toBe('Single line of text.');
  });
});

describe('paragraph conditional edge cases', () => {
  it('treats paragraph-style transitions as prompt text', () => {
    const md = `## 1 Step

PASS: CONTINUE
FAIL: STOP

Do the work.
`;
    const steps = parseRunbook(md);
    // Paragraph-style transitions are not parsed as transitions — they become prompt text
    // Steps always have transitions (default CONTINUE/STOP)
    expect(steps[0].transitions).toBeDefined();
    expect(steps[0].transitions.pass.action.type).toBe('CONTINUE');
    expect(steps[0].transitions.fail.action.type).toBe('STOP');
    expect(steps[0].prompt).toContain('PASS: CONTINUE');
    expect(steps[0].prompt).toContain('FAIL: STOP');
    expect(steps[0].prompt).toContain('Do the work.');
  });

  it('treats paragraph-style transitions in substeps as prompt text', () => {
    const md = `## 1 Step

### 1.1 Sub

PASS: CONTINUE
FAIL: STOP

Do substep work.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const sub = step.substeps[0];
    // Paragraph-style transitions are not parsed as transitions — they become prompt text
    // Substeps always have transitions (context-aware defaults CONTINUE/STOP)
    expect(sub.transitions).toBeDefined();
    expect(sub.transitions.pass.action.type).toBe('CONTINUE');
    expect(sub.transitions.fail.action.type).toBe('STOP');
    expect(sub.prompt).toContain('PASS: CONTINUE');
    expect(sub.prompt).toContain('Do substep work.');
  });
});

describe('parser edge cases for mutation coverage', () => {
  it('ignores code blocks outside any step', () => {
    const md = `# Title

\`\`\`bash
echo outside
\`\`\`

## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md);
    expect(doc.steps).toHaveLength(1);
    expect('command' in doc.steps[0]).toBe(false);
  });

  it('parses markdown with no steps and returns diagnostics', () => {
    const md = `# Just a title

Some text but no steps.
`;
    const { runbook: doc, diagnostics } = parseRunbookDocument(md);
    expect(doc.steps).toHaveLength(0);
    expect(doc.title).toBe('Just a title');
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('returns error diagnostics for invalid runbooks instead of throwing', () => {
    const md = `## 1 Step
- PASS GOTO 99
- FAIL STOP
`;
    const { runbook: doc, diagnostics } = parseRunbookDocument(md);
    expect(doc.steps).toHaveLength(1);
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('parseRunbook throws on error diagnostics for backward compatibility', () => {
    const md = `## 1 Step
- PASS GOTO 99
- FAIL STOP
`;
    expect(() => parseRunbook(md)).toThrow();
  });

  it('parses text after substep as a new step', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE

Do sub work.

## 2 Step

Text in the second step.
`;
    const steps = parseRunbook(md);
    expect(steps).toHaveLength(2);
    expect(steps[1].prompt).toBe('Text in the second step.');
  });

  it('code block in substep sets hasSeenContent correctly', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS CONTINUE

\`\`\`bash
echo hello
\`\`\`

### 1.2 Another Sub
- PASS COMPLETE

Do other work.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(2);
    expect(step.substeps[0].command?.code).toBe('echo hello');
    expect(step.substeps[1].prompt).toBe('Do other work.');
  });

  it('preserves prompt text across multiple paragraphs in step', () => {
    const md = `## 1 Step
- PASS COMPLETE

Line one.

Line two.

\`\`\`bash
npm test
\`\`\`
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toContain('Line one.');
    expect(steps[0].prompt).toContain('Line two.');
  });

  it('carries pending conditionals from substep to substep', () => {
    const md = `## 1 Step

### 1.1 First
- PASS CONTINUE
- FAIL STOP

Do first.

### 1.2 Second
- PASS COMPLETE
- FAIL STOP

Do second.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(2);
    expect(step.substeps[0].transitions.pass.action).toEqual({ type: 'CONTINUE' });
    expect(step.substeps[1].transitions.pass.action).toEqual({ type: 'COMPLETE' });
  });

  it('handles step with only transitions and no other content', () => {
    const md = `## 1 Step
- PASS CONTINUE
- FAIL STOP

## 2 Step
- PASS COMPLETE
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBeUndefined();
    expect('command' in steps[0]).toBe(false);
    expect('substeps' in steps[0]).toBe(false);
    expect(steps[0].transitions.pass.action).toEqual({ type: 'CONTINUE' });
  });

  it('validates NEXT usage in substep context with FOR clause', () => {
    const md = `## 1 Step
- FOR i IN 1 TO 3
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Sub
- PASS NEXT
- FAIL STOP

Do iteration.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithFor(step);
    expect(step.forClause).toEqual({ variable: 'i', start: 1, end: 3 });
    expect(step.substeps[0].transitions.pass.action).toEqual({ type: 'NEXT' });
  });

  it('H3 header with unparsable format is ignored when only content', () => {
    // H3 that doesn't match substep pattern — hasSeenContent becomes true
    // but no substep is created (use @-prefixed text which is not a valid identifier)
    const md = `## 1 Step

### @random notes
`;
    const steps = parseRunbook(md);
    expect('substeps' in steps[0]).toBe(false);
  });

  it('list items in preamble are not processed as step content', () => {
    const md = `# Title

Here is a list:
- Item one
- Item two

## 1 Step
- PASS COMPLETE
`;
    const { runbook: doc } = parseRunbookDocument(md);
    expect(doc.steps).toHaveLength(1);
    expect(doc.description).toContain('Here is a list:');
  });
});

describe('C1: bash prompt code block is display-only', () => {
  it('parses bash prompt as prompt block, not executable', () => {
    const md = `## 1. Display example

\`\`\`bash prompt
rd prompt 'Hello world'
\`\`\`
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithCommand(step);
    expect(step.command.lang).toBe('prompt');
    expect(step.command.code).toContain('rd prompt');
  });
});

describe('C2: substep short form', () => {
  it('parses bare numeric substep under a step', () => {
    const md = `## 1. Parent step

### 1 First substep

Do something.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].id).toBe('1');
  });

  it('parses bare numeric substep with description', () => {
    const md = `## 1. Parent step

### 2 Review code

Review the code carefully.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].id).toBe('2');
    expect(step.substeps[0].description).toBe('Review code');
  });

  it('parses bare numeric substep under named parent step', () => {
    const md = `## Setup

### 1 Initialize

Set up the environment.

### 2 Configure

Apply configuration.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.name).toBe('Setup');
    expect(step.substeps).toHaveLength(2);
    expect(step.substeps[0].id).toBe('1');
    expect(step.substeps[0].description).toBe('Initialize');
    expect(step.substeps[1].id).toBe('2');
    expect(step.substeps[1].description).toBe('Configure');
  });
});

describe('E3: bare numeric step headers', () => {
  it('parses ## 1 as a valid step', () => {
    const md = `## 1

Do something.
`;
    const steps = parseRunbook(md);
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('1');
    expect(steps[0].description).toBe('Step 1');
  });
});

describe('strict H3 validation', () => {
  it('throws when unrecognized H3 appears after valid substep', () => {
    const md = `## 1. Setup

### 1.1 First substep

### @invalid heading
`;
    expect(() => parseRunbook(md)).toThrow(/unrecognized H3 headers/);
  });

  it('throws when unrecognized H3 appears before valid substep', () => {
    const md = `## 1. Setup

### @invalid heading

### 1.1 First substep
`;
    expect(() => parseRunbook(md)).toThrow(/unrecognized H3 headers/);
  });

  it('allows unrecognized H3 in step with no valid substeps', () => {
    const md = `## 1. Setup

### @invalid heading

Some content.
`;
    expect(() => parseRunbook(md)).not.toThrow();
  });

  it('recognizes bare named substep (not treated as unrecognized)', () => {
    const md = `## 1. Setup

### Cleanup

Some content.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].id).toBe('Cleanup');
  });
});

describe('bare named substep parsing', () => {
  it('parses bare named substep with id only', () => {
    const md = `## 1. Setup

### ErrorHandler

Handle errors.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].id).toBe('ErrorHandler');
  });

  it('parses mixed bare numeric and bare named substeps', () => {
    const md = `## 1. Setup

### 1

First task.

### Cleanup

Clean up.
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(2);
    expect(step.substeps[0].id).toBe('1');
    expect(step.substeps[1].id).toBe('Cleanup');
  });

  it('bare named substep has no stepRef (positional assignment)', () => {
    const md = `## 1. Setup

### ErrorHandler
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    // Bare named substeps don't have stepRef in the parsed header
    // (they are positionally assigned to parent H2)
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].id).toBe('ErrorHandler');
  });

  it('rejects runbook with invalid FOR dotdot syntax', () => {
    const md = `# Test\n\n## 1. Loop\n\n- FOR item IN 1..5\n\n### 1.1 Do thing\n\n\`\`\`bash\necho hi\n\`\`\`\n`;
    expect(() => parseRunbook(md)).toThrow(/Invalid FOR clause/);
  });
});

describe('DEFER shorthand', () => {
  it('standalone DEFER on substep produces both pass and fail DEFER transitions', () => {
    const md = `## 1. Validate

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Check

- DEFER

\`\`\`bash
echo "check"
\`\`\`
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    const substep = step.substeps[0];
    expect(substep).toBeDefined();
    expect(substep.transitions).toBeDefined();
    expect(substep.transitions.pass.action).toEqual({ type: 'DEFER' });
    expect(substep.transitions.fail.action).toEqual({ type: 'DEFER' });
  });

  it('standalone DEFER under FOR clause produces iteration-level DEFER transitions', () => {
    const md = `## 1. Process

- FOR item IN 1 TO 3
  - DEFER
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Do {{item}}

\`\`\`bash
echo "{{item}}"
\`\`\`
`;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('for');
    if (steps[0].kind === 'for') {
      expect(steps[0].forClause.transitions).toBeDefined();
      expect(steps[0].forClause.transitions!.pass.action).toEqual({ type: 'DEFER' });
      expect(steps[0].forClause.transitions!.fail.action).toEqual({ type: 'DEFER' });
    }
  });

  it('standalone DEFER on step-level throws syntax error', () => {
    const md = `## 1. Check

- DEFER

\`\`\`bash
echo "check"
\`\`\`
`;
    expect(() => parseRunbook(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbook(md)).toThrow(/DEFER is only valid/);
  });
});

// === Batch 7: parser.ts mutation-killing tests ===

describe('parser mutation killing - code block processing', () => {
  it('throws on code block without language tag', () => {
    const md = `## 1 Test step

\`\`\`
echo hello
\`\`\``;
    expect(() => parseRunbook(md)).toThrow(/Code block without language tag/);
  });

  it('handles code block with meta but no lang (bash prompt)', () => {
    const md = `## 1 Test step

\`\`\`bash prompt
echo hello
\`\`\``;
    const steps = parseRunbook(md);
    // bash prompt → not executable (prompt block)
    expect(steps[0].kind).toBe('command');
  });

  it('preserves code value whitespace trimming', () => {
    const md = `## 1 Test step

\`\`\`bash
  echo hello
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('command');
    if (steps[0].kind === 'command') {
      expect(steps[0].command.code).toBe('echo hello');
    }
  });
});

describe('parser mutation killing - step content and prompts', () => {
  it('handles step with only whitespace content (no prompt)', () => {
    const md = `## 1 Test step

\`\`\`bash
echo hello
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBeUndefined();
  });

  it('captures text before code block as prompt', () => {
    const md = `## 1 Test step

Run the following command

\`\`\`bash
echo hello
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBe('Run the following command');
  });

  it('parses multiple steps correctly', () => {
    const md = `## 1 First step

Step 1 content

\`\`\`bash
echo first
\`\`\`

## 2 Second step

Step 2 content

\`\`\`bash
echo second
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('1');
    expect(steps[1].name).toBe('2');
  });
});

describe('parser mutation killing - H2 heading step creation', () => {
  it('captures step line number from position', () => {
    const md = `# Title

## 1 Step One

Content`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].line).toBeDefined();
    expect(typeof runbook.steps[0].line).toBe('number');
  });

  it('uses step name as default description for named step', () => {
    const md = `## Cleanup`;
    const steps = parseRunbook(md);
    expect(steps[0].name).toBe('Cleanup');
    expect(steps[0].description).toBe('Cleanup');
  });

  it('generates default description for bare numeric step', () => {
    const md = `## 1`;
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Step 1');
  });
});

describe('parser mutation killing - substep processing', () => {
  it('parses substep with command', () => {
    const md = `## 1 Test step

### 1.1 First substep

\`\`\`bash
echo sub1
\`\`\`

### 1.2 Second substep

\`\`\`bash
echo sub2
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('substeps');
    if (steps[0].kind === 'substeps') {
      expect(steps[0].substeps).toHaveLength(2);
      expect(steps[0].substeps[0].id).toBe('1');
      expect(steps[0].substeps[0].command?.code).toBe('echo sub1');
      expect(steps[0].substeps[1].id).toBe('2');
      expect(steps[0].substeps[1].command?.code).toBe('echo sub2');
    }
  });

  it('handles substep with prompt text', () => {
    const md = `## 1 Test step

### 1.1 First substep

Do this thing

\`\`\`bash
echo sub1
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('substeps');
    if (steps[0].kind === 'substeps') {
      expect(steps[0].substeps[0].prompt).toBe('Do this thing');
    }
  });
});

describe('parser mutation killing - runbook reference detection', () => {
  it('detects runbook references in step content', () => {
    const md = `## 1 Dispatch

- verify.runbook.md
- cleanup.runbook.md`;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('substeps');
    if (steps[0].kind === 'substeps') {
      expect(steps[0].substeps).toHaveLength(2);
      expect(steps[0].substeps[0].runbooks).toEqual(['verify.runbook.md']);
    }
  });

  it('does not detect non-runbook list items as references', () => {
    const md = `## 1 Test step

- not-a-runbook-item
- another plain item`;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('base');
    expect(steps[0].prompt).toContain('- not-a-runbook-item');
  });

  it('rejects runbook ref with trailing text', () => {
    const md = `## 1 Test step

- verify.runbook.md some extra text`;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('base');
    expect(steps[0]).not.toHaveProperty('runbooks');
  });
});

describe('parser mutation killing - step finalization', () => {
  it('creates base step when no command or substeps', () => {
    const md = `## 1 Simple step

Just some text`;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('base');
    expect(steps[0].prompt).toBe('Just some text');
  });

  it('creates command step when code block present', () => {
    const md = `## 1 Command step

\`\`\`bash
echo hello
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('command');
  });

  it('creates for step when FOR clause present', () => {
    const md = `## 1 Loop step

- FOR 3

### 1.1 Iteration body

\`\`\`bash
echo iteration
\`\`\``;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepWithFor(step);
    expect(step.forClause.start).toBe(1);
    if (!('end' in step.forClause)) {
      throw new Error('expected forClause with end bound');
    }
    expect(step.forClause.end).toBe(3);
  });

  it('assigns DEFER transitions to substeps with runbook refs', () => {
    const md = `## 1 Delegation step

### 1.1 Run sub

- verify.runbook.md`;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('substeps');
    if (steps[0].kind === 'substeps') {
      expect(steps[0].substeps[0].transitions.pass.action.type).toBe('DEFER');
      expect(steps[0].substeps[0].transitions.fail.action.type).toBe('DEFER');
    }
  });

  it('multi-substep step preserves prompt on parent', () => {
    const md = `## 1 Step with text

Some prompt text

### 1.1 Sub A

\`\`\`bash
echo a
\`\`\`

### 1.2 Sub B

\`\`\`bash
echo b
\`\`\``;
    const steps = parseRunbook(md);
    // Parent step should have the prompt text
    expect(steps[0].prompt).toBe('Some prompt text');
  });
});

describe('parser mutation killing - H1 and H4+ rejection', () => {
  it('throws on H4 heading', () => {
    const md = `## 1 Step

#### 1.1.1 Too deep`;
    expect(() => parseRunbook(md)).toThrow(/H4\+ headings are not allowed/);
  });

  it('throws on H1 that looks like a step number', () => {
    const md = `# 1. Step One`;
    expect(() => parseRunbook(md)).toThrow(/H1 headers.*cannot be used as step headers/);
  });

  it('does not throw on H1 title (non-step)', () => {
    const md = `# My Runbook

## 1 First step`;
    expect(() => parseRunbook(md)).not.toThrow();
  });
});

describe('parser mutation killing - preamble and title', () => {
  it('captures H1 as title', () => {
    const md = `# My Runbook

## 1 First step`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.title).toBe('My Runbook');
  });

  it('captures preamble text', () => {
    const md = `# My Runbook

This is the preamble description.

## 1 First step`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.description).toBe('This is the preamble description.');
  });

  it('extracts name from frontmatter', () => {
    const md = `---
name: my-runbook
---
## 1 First step`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.name).toBe('my-runbook');
  });

  it('falls back to basename for name', () => {
    const md = `## 1 First step`;
    const { runbook } = parseRunbookDocument(md, 'deploy.runbook.md');
    expect(runbook.name).toBe('deploy');
  });
});

describe('parser mutation killing - FOR list processing', () => {
  it('handles FOR clause with nested transitions', () => {
    const md = `## 1 Loop step

- FOR i IN 1 TO 3
  - PASS CONTINUE
  - FAIL STOP

### 1.1 Body

\`\`\`bash
echo iteration
\`\`\``;
    const steps = parseRunbook(md);
    expect(steps[0].kind).toBe('for');
    if (steps[0].kind === 'for') {
      expect(steps[0].forClause.transitions).toBeDefined();
      expect(steps[0].forClause.transitions!.pass.action.type).toBe('CONTINUE');
      expect(steps[0].forClause.transitions!.fail.action.type).toBe('STOP');
    }
  });

  it('throws on FOR in substep context', () => {
    const md = `## 1 Step

### 1.1 Sub

- FOR 3`;
    expect(() => parseRunbook(md)).toThrow(/FOR is only valid on steps/);
  });

  it('throws on multiple FOR clauses', () => {
    const md = `## 1 Step

- FOR 3
- FOR 5

### 1.1 Body`;
    expect(() => parseRunbook(md)).toThrow(/multiple FOR clauses/);
  });
});

describe('parser mutation killing - inline code in text extraction', () => {
  it('handles inline code in step description', () => {
    const md = '## 1 Run `npm test` command\n\n```bash\nnpm test\n```';
    const steps = parseRunbook(md);
    expect(steps[0].description).toContain('`npm test`');
  });
});
describe('formatLineNum', () => {
  it('returns formatted line number when position exists', () => {
    expect(formatLineNum({ position: { start: { line: 42 } } })).toBe(' (line 42)');
  });

  it('returns empty string when position is undefined', () => {
    expect(formatLineNum({})).toBe('');
  });

  it('returns empty string when line is 0', () => {
    expect(formatLineNum({ position: { start: { line: 0 } } })).toBe('');
  });

  it('accepts a raw line number', () => {
    expect(formatLineNum(10)).toBe(' (line 10)');
  });

  it('returns empty string for raw 0', () => {
    expect(formatLineNum(0)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatLineNum(undefined)).toBe('');
  });
});

describe('parse errors include source line numbers', () => {
  it('H1 step header error includes line number', () => {
    const md = '# 1. My Step\n\nSome content';
    expect(() => parseRunbook(md)).toThrow(/\(line 1\)/);
  });

  it('bare code fence error includes line number', () => {
    const md = '## 1. Step\n\n```\ncode\n```';
    expect(() => parseRunbook(md)).toThrow(/\(line 3\)/);
  });

  it('duplicate code block error includes line number', () => {
    const md = '## 1. Step\n\n```bash\nfirst\n```\n\n```bash\nsecond\n```';
    expect(() => parseRunbook(md)).toThrow(/\(line 7\)/);
  });

  it('H4+ heading error includes line number', () => {
    const md = '## 1. Step\n\n#### Deep heading';
    expect(() => parseRunbook(md)).toThrow(/\(line 3\)/);
  });

  it('duplicate substep error includes line number', () => {
    const md = '## 1. Step\n\n### 1.1 Sub\n\n```bash\necho hi\n```\n\n### 1.1 Sub';
    expect(() => parseRunbook(md)).toThrow(/\(line 9\)/);
  });

  it('validator diagnostic error includes line number', () => {
    const md = '## 1. Step\n- PASS GOTO 99\n- FAIL STOP';
    expect(() => parseRunbook(md)).toThrow(/\(line 1\)/);
  });
});

describe('prompt accumulation (extracted helpers)', () => {
  it('accumulates prompt text into substep', () => {
    const md = `## 1. Step

### 1.1 Sub
Prompt line one
Prompt line two

\`\`\`bash
echo "go"
\`\`\`
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].prompt).toBe('Prompt line one\nPrompt line two');
  });

  it('accumulates prompt text into step (no substeps)', () => {
    const md = `## 1. Step
Some prompt text

\`\`\`bash
echo "go"
\`\`\`
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBe('Some prompt text');
  });
});

describe('RunbookRef in runbook lists', () => {
  it('captures template variable in substep runbook list as RunbookRef', () => {
    const md = `## 1. Execute

### 1.1 Run target
- PASS CONTINUE
- FAIL STOP

 - {{ TargetRunbook }}
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].runbooks).toEqual([{ ref: 'TargetRunbook' }]);
  });

  it('captures mixed literal and template entries in substep', () => {
    const md = `## 1. Execute

### 1.1 Run workflow

 - setup.runbook.md
 - {{ DynamicRunbook }}
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].runbooks).toEqual(['setup.runbook.md', { ref: 'DynamicRunbook' }]);
  });

  it('does not include template variable in prompt text', () => {
    const md = `## 1. Execute

### 1.1 Run target
Some prompt text

 - {{ TargetRunbook }}
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].prompt).toBe('Some prompt text');
    expect(step.substeps[0].runbooks).toEqual([{ ref: 'TargetRunbook' }]);
  });

  it('canonicalizes step-level template variable to synthetic substep', () => {
    const md = `## 1. Execute
- PASS CONTINUE
- FAIL STOP

- {{ TargetRunbook }}
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.kind).toBe('substeps');
    expect(step.substepsDerivedFromRunbookList).toBe(true);
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].runbooks).toEqual([{ ref: 'TargetRunbook' }]);
  });

  it('captures dotted path in RunbookRef', () => {
    const md = `## 1. Execute

### 1.1 Run
 - {{ config.target }}
`;
    const steps = parseRunbook(md);
    const step = steps[0];
    assertStepHasSubsteps(step);
    expect(step.substeps[0].runbooks).toEqual([{ ref: 'config.target' }]);
  });
});

describe('DELEGATE annotation — reserved word and AST type', () => {
  it('parses a substep with DELEGATE annotation and sets delegate: true', () => {
    const md = `## 1. Step
### 1.1 Substep
- DELEGATE
- work.runbook.md
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
    }
  });

  it('DELEGATE is in the reserved word list', () => {
    expect(isReservedWord('DELEGATE')).toBe(true);
  });
});

describe('DELEGATE annotation — parsing and ordering', () => {
  it('parses DELEGATE on a substep (H3) with a runbook target', () => {
    const md = `## 1. Step
### 1.1 Substep
- DELEGATE
- work.runbook.md
- PASS CONTINUE
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
    }
  });

  it('parses DELEGATE on a step (H2) — stored for propagation', () => {
    // DELEGATE at step level doesn't directly set a field on the step,
    // it propagates to substeps (tested in Task 3). Here we just confirm parsing doesn't throw.
    // Per spec §4.3 every propagated substep must resolve to a runbook target.
    const md = `## 1. Step
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 Substep one
- one.runbook.md

### 1.2 Substep two
- two.runbook.md
`;
    expect(() => parseRunbookDocument(md)).not.toThrow();
  });

  it('throws RunbookSyntaxError when DELEGATE has arguments', () => {
    const md = `## 1. Step
### 1.1 Substep
- DELEGATE foo

Do work.
`;
    expect(() => parseRunbookDocument(md)).toThrow(/DELEGATE.*no arguments/i);
  });

  it('throws RunbookSyntaxError when DELEGATE is followed by a non-ascii whitespace and args', () => {
    // U+00A0 NO-BREAK SPACE — \s matches it; the legacy space/tab check does not.
    // Use an explicit \u00A0 escape so editor/tool normalization cannot silently
    // turn this into a duplicate of the ASCII-space case above.
    const nbsp = '\u00A0';
    const md = `## 1 Step\n### 1.1 Sub\n- child.runbook.md\n- DELEGATE${nbsp}foo\n`;
    expect(() => parseRunbookDocument(md)).toThrow(/DELEGATE.*no arguments/i);
  });

  it('throws RunbookSyntaxError when DELEGATE appears after transitions', () => {
    const md = `## 1. Step
### 1.1 Substep
- PASS CONTINUE
- DELEGATE
`;
    expect(() => parseRunbookDocument(md)).toThrow(/DELEGATE.*before transitions/i);
  });

  it('throws RunbookSyntaxError when DELEGATE appears after content', () => {
    const md = `## 1. Step
### 1.1 Substep
Do work.
- DELEGATE
`;
    expect(() => parseRunbookDocument(md)).toThrow(/DELEGATE.*before.*content/i);
  });

  it('throws RunbookSyntaxError when DELEGATE is duplicated on a substep', () => {
    const md = `## 1. Step
### 1.1 Substep
- DELEGATE
- DELEGATE
`;
    expect(() => parseRunbookDocument(md)).toThrow(/duplicate DELEGATE/i);
  });

  it('throws RunbookSyntaxError when FOR appears after DELEGATE on a step', () => {
    const md = `## 1. Step
- DELEGATE
- FOR 3
`;
    expect(() => parseRunbookDocument(md)).toThrow(/FOR.*before DELEGATE/i);
  });

  it('throws RunbookSyntaxError when DELEGATE appears on a base step (no substeps)', () => {
    const md = `## 1 Step
- DELEGATE

Some prompt text.
`;
    expect(() => parseRunbookDocument(md)).toThrow(/step "1".*DELEGATE.*no.*(substep|runbook)/i);
  });

  it('throws RunbookSyntaxError when DELEGATE appears on a command step', () => {
    const md = `## 1 Step
- DELEGATE

\`\`\`bash
echo hi
\`\`\`
`;
    expect(() => parseRunbookDocument(md)).toThrow(/step "1".*DELEGATE.*no.*(substep|runbook)/i);
  });

  it('throws RunbookSyntaxError when DELEGATE substep has no runbook target', () => {
    const md = `## 1 Step
### 1.1 Sub
- DELEGATE

Prompt for this substep.
`;
    expect(() => parseRunbookDocument(md)).toThrow(/substep "1\.1".*DELEGATE.*runbook/i);
  });

  it('throws RunbookSyntaxError when DELEGATE substep has prompt-only body', () => {
    const md = `## 1 Step
### 1.1 Sub
- DELEGATE

\`\`\`bash
echo not-a-runbook
\`\`\`
`;
    expect(() => parseRunbookDocument(md)).toThrow(/substep "1\.1".*DELEGATE.*runbook/i);
  });
});

describe('DELEGATE annotation — step-level propagation', () => {
  it('propagates step-level DELEGATE to all explicit H3 substeps', () => {
    // Per spec §4.3 every DELEGATE substep must resolve to a runbook target,
    // so step-level DELEGATE requires each H3 to carry a `.runbook.md` entry.
    const md = `## 1. Step
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 First
- first.runbook.md

### 1.2 Second
- second.runbook.md
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
      expect(step.substeps[1].delegate).toBe(true);
    }
  });

  it('rejects step-level DELEGATE when any propagated substep lacks a runbook target', () => {
    // Spec §4.3: "A DELEGATE substep must resolve to a runbook target. A
    // DELEGATE substep with no runbook target is a structural error." The
    // substep-level guard in finalizePendingSubstep only sees `ps.hasSeenDelegate`
    // when DELEGATE is on the substep itself — step-level DELEGATE must be
    // re-checked at propagation time so mixed substeps don't slip through.
    const md = `## 1. Step
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 Has runbook
- child.runbook.md

### 1.2 Command only
\`\`\`bash
echo hi
\`\`\`
`;
    expect(() => parseRunbookDocument(md)).toThrow(/DELEGATE cannot propagate to substep "1\.2"/);
  });

  it('propagates step-level DELEGATE to synthetic substeps from runbook list', () => {
    const md = `## 1. Step
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

- review-a.runbook.md
- review-b.runbook.md
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
      expect(step.substeps[1].delegate).toBe(true);
    }
  });

  it('propagates step-level DELEGATE to substeps of a FOR step', () => {
    const md = `## 1. Step
- FOR 3
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First substep
- first.runbook.md

### 1.2 Second substep
- second.runbook.md
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('for');
    if (step.kind === 'for') {
      expect(step.substeps[0].delegate).toBe(true);
      expect(step.substeps[1].delegate).toBe(true);
    }
  });

  it('does not propagate when DELEGATE is not set at step level', () => {
    const md = `## 1. Step
### 1.1 First
### 1.2 Second
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBeUndefined();
      expect(step.substeps[1].delegate).toBeUndefined();
    }
  });

  it('does not override explicit substep DELEGATE when step has no DELEGATE', () => {
    const md = `## 1. Step
### 1.1 First
- DELEGATE
- work.runbook.md

### 1.2 Second
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
      expect(step.substeps[1].delegate).toBeUndefined();
    }
  });

  it('all three DELEGATE syntax forms produce identical delegate flags on substeps', () => {
    // Form 1: step-level DELEGATE propagates to H3 substeps
    const form1 = `## 3. Step
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 3.1 Technical accuracy
- review-plan-technical-accuracy.runbook.md

### 3.2 Structural integrity
- review-plan-structural-integrity.runbook.md
`;

    // Form 2: per-entry DELEGATE nested under runbook list items (Task 4)
    const form2 = `## 3. Step
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

- review-plan-technical-accuracy.runbook.md
  - DELEGATE
- review-plan-structural-integrity.runbook.md
  - DELEGATE
`;

    // Form 3: per-substep DELEGATE on each H3
    const form3 = `## 3. Step
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 3.1 Technical accuracy
- DELEGATE
- review-plan-technical-accuracy.runbook.md

### 3.2 Structural integrity
- DELEGATE
- review-plan-structural-integrity.runbook.md
`;

    const step1 = parseRunbookDocument(form1).runbook.steps[0];
    const step2 = parseRunbookDocument(form2).runbook.steps[0];
    const step3 = parseRunbookDocument(form3).runbook.steps[0];

    for (const step of [step1, step2, step3]) {
      expect(step.kind).toBe('substeps');
      if (step.kind === 'substeps') {
        expect(step.substeps[0].delegate).toBe(true);
        expect(step.substeps[1].delegate).toBe(true);
        expect(step.substeps[0].runbooks).toEqual(['review-plan-technical-accuracy.runbook.md']);
        expect(step.substeps[1].runbooks).toEqual(['review-plan-structural-integrity.runbook.md']);
      }
    }
  });
});

describe('DELEGATE annotation — runbook list shorthand', () => {
  it('allows DELEGATE nested under a step-level runbook list entry', () => {
    const md = `## 1. Step
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

- review-a.runbook.md
  - DELEGATE
- review-b.runbook.md
  - DELEGATE
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
      expect(step.substeps[1].delegate).toBe(true);
    }
  });

  it('allows transition annotations nested under a step-level runbook list entry', () => {
    const md = `## 1. Step
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

- review-a.runbook.md
  - DELEGATE
  - FAIL STOP
- review-b.runbook.md
  - DELEGATE
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
      expect(step.substeps[0].transitions.fail.action.type).toBe('STOP');
      expect(step.substeps[1].delegate).toBe(true);
    }
  });

  it('entries without annotations are unaffected', () => {
    const md = `## 1. Step
- review-a.runbook.md
  - DELEGATE
- review-b.runbook.md
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
      expect(step.substeps[1].delegate).toBeUndefined();
    }
  });

  it('allows DELEGATE nested under a substep-level runbook list entry', () => {
    const md = `## 1. Step
### 1.1 Sub
- review-a.runbook.md
  - DELEGATE
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    if (step.kind === 'substeps') {
      expect(step.substeps[0].delegate).toBe(true);
    }
  });

  it('throws RunbookSyntaxError for DELEGATE with arguments in runbook entry annotation', () => {
    const md = `## 1. Step
- review-a.runbook.md
  - DELEGATE foo
`;
    expect(() => parseRunbookDocument(md)).toThrow(/DELEGATE.*no arguments/i);
  });
});

describe('OUTPUTS nested under runbook-list entry', () => {
  it('accepts OUTPUTS nested under a runbook-list entry (symmetric with DELEGATE)', () => {
    const md = `## 1 Step
- child.runbook.md
  - OUTPUTS
    - PlanPath {{ path "plan.json" }}
`;
    const result = parseRunbookDocument(md);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const step = result.runbook.steps[0];
    if (step.kind !== 'substeps' && step.kind !== 'for') {
      throw new Error(`expected substeps-kind step, got ${step.kind}`);
    }
    expect(step.substeps).toHaveLength(1);
    expect(step.substeps[0].outputs).toEqual([
      { name: 'PlanPath', value: '{{ path "plan.json" }}' },
    ]);
  });

  it('still rejects OUTPUTS after prose prompt text under a runbook-list entry', () => {
    const md = `## 1 Step
- child.runbook.md
  - some prose note
  - OUTPUTS
    - PlanPath {{ path "plan.json" }}
`;
    expect(() => parseRunbookDocument(md)).toThrow(/OUTPUTS.*must appear before/);
  });
});
