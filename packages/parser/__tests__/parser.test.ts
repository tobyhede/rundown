import { describe, it, expect } from '@jest/globals';
import { parseRunbook, parseRunbookDocument } from '../src/index.js';

describe('Step-level runbooks', () => {
  it('parses runbook list in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Execute runbook
- PASS: CONTINUE
- FAIL: STOP

 - task-details.runbook.md
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps![0].workflows).toEqual(['task-details.runbook.md']);
  });

  it('rejects step with both runbooks and substeps', () => {
    const markdown = `## 1. Execute

 - task.runbook.md

### 1.1 Substep
- PASS: CONTINUE
- FAIL: STOP

Do work.
`;
    expect(() => parseRunbook(markdown)).toThrow(/Violates Exclusivity Rule/i);
  });

  it('parses multiple runbooks on substep', () => {
    const markdown = `## 1. Execute

### 1.1 Runbooks
- PASS: CONTINUE
- FAIL: STOP

 - runbook-a.runbook.md
 - runbook-b.runbook.md
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps?.[0].workflows).toEqual([
      'runbook-a.runbook.md',
      'runbook-b.runbook.md',
    ]);
  });
});

describe('parseRunbook with substep runbooks', () => {
  it('should parse runbook list in substep', () => {
    const markdown = `# Test Runbook

## 1. Dispatch agents

### 1.1 Review step
- PASS: CONTINUE
- FAIL: STOP

 - review.runbook.md
 - security.runbook.md
`;

    const steps = parseRunbook(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps?.[0].workflows).toEqual(['review.runbook.md', 'security.runbook.md']);
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
- PASS: CONTINUE

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
    expect(steps[0].command?.code).toBe('ls');
    expect(steps[1].command?.code).toBe('pwd');
  });

  it('treats prompt tag as rd prompt command', () => {
    const markdown = `## 1. Instruction
\`\`\`prompt
Please look at this example.
\`\`\`
`;
    const steps = parseRunbook(markdown);
    // prompt blocks become rd prompt commands
    expect(steps[0].command).toEqual({
      code: "rd prompt 'Please look at this example.'",
      lang: 'prompt',
    });
    expect(steps[0].prompt).toBeUndefined(); // No prompt text from prompt blocks
  });

  it('treats other tags as passive prose', () => {
    const markdown = `## 1. Example
\`\`\`json
{"key": "value"}
\`\`\`
`;
    const steps = parseRunbook(markdown);
    // JSON code blocks are ignored - not valid for execution
    expect(steps[0].command).toBeUndefined();
    expect(steps[0].prompt).toBeUndefined();
  });

  it('treats prompt code blocks as rd prompt commands', () => {
    const md = `## 1. Step with prompted code
- PASS: COMPLETE

Show this to agent.

\`\`\`prompt
npm run example --flag value
\`\`\`
`;
    const steps = parseRunbook(md);
    // prompt block becomes command, text before it becomes prompt
    expect(steps[0].command).toEqual({
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
    expect(steps[0].command).toEqual({
      code: "rd prompt 'echo '\\''hello world'\\'''",
      lang: 'prompt',
    });
  });

  // Keep but remove prompted check
  it('parses bash code blocks as executable commands', () => {
    const md = `## 1. Step with bash code
- PASS: COMPLETE

Run this automatically.

\`\`\`bash
npm run build
\`\`\`
`;
    const steps = parseRunbook(md);
    expect(steps[0].command).toEqual({
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
    // @ts-expect-error - testing new lang property
    expect(steps[0].command?.lang).toBe('bash');
    // @ts-expect-error - testing new lang property
    expect(steps[1].command?.lang).toBe('shell');
  });
});

describe('Implicit prompts with lists', () => {
  it('preserves bulleted instructions in prompts', () => {
    const markdown = `## 1. Execute
- PASS: CONTINUE
- FAIL: STOP

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
- PASS: GOTO 2.1
- FAIL: STOP

## 2. Second

### 2.1 Substep one
- PASS: CONTINUE
- FAIL: STOP

Do something.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'GOTO', target: { step: '2', substep: '1' } },
    });
  });

  it('rejects GOTO 2.99 when substep does not exist', () => {
    const markdown = `
## 1. First
- PASS: GOTO 2.99
- FAIL: STOP

## 2. Second

### 2.1 Only substep
- PASS: CONTINUE
- FAIL: STOP
`;
    expect(() => parseRunbook(markdown)).toThrow(/substep does not exist/i);
  });
});

describe('substep with prompts', () => {
  it('parses implicit prompt in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Implement task
- PASS: CONTINUE
- FAIL: STOP

This is the implicit prompt text.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].substeps?.[0].prompt).toBe('This is the implicit prompt text.');
  });
});

describe('substep with transitions', () => {
  it('parses transitions in substep', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS: CONTINUE
- FAIL: STOP "BLOCKED"

Do work.

### 1.2 Second step
- PASS: COMPLETE
- FAIL: GOTO 1.1

More work.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].substeps?.[0].transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect(steps[0].substeps?.[0].transitions?.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP', message: 'BLOCKED' },
    });
    expect(steps[0].substeps?.[1].transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'COMPLETE' },
    });
    expect(steps[0].substeps?.[1].transitions?.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'GOTO', target: { step: '1', substep: '1' } },
    });
  });

  it('single substep gets transitions not step', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS: CONTINUE
- FAIL: STOP

Do work.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].substeps?.[0].transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect(steps[0].substeps?.[0].transitions?.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'STOP' },
    });
  });
});

describe('substep GOTO validation', () => {
  it('accepts GOTO to sibling substep', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS: CONTINUE
- FAIL: GOTO 1.2

### 1.2 Second step
- PASS: CONTINUE
- FAIL: STOP
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].substeps?.[0].transitions?.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'GOTO', target: { step: '1', substep: '2' } },
    });
  });

  it('rejects GOTO to non-existent substep from substep', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS: CONTINUE
- FAIL: GOTO 1.99

### 1.2 Second step
- PASS: CONTINUE
- FAIL: STOP
`;
    expect(() => parseRunbook(markdown)).toThrow(/substep.*does not exist|invalid/i);
  });
});

describe('substep with command', () => {
  it('parses bash code block in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Run checks
- PASS: CONTINUE
- FAIL: STOP

\`\`\`bash
npm run lint
\`\`\`
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps?.[0].command?.code).toBe('npm run lint');
  });

  it('rejects multiple code blocks in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Run checks
- PASS: CONTINUE
- FAIL: STOP

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
- PASS: CONTINUE
- FAIL: STOP

This is the prompt text.
Multiple lines here.
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].prompt).toBe('This is the prompt text.\nMultiple lines here.');
    expect((steps[0] as any).prompts).toBeUndefined();
  });
});

describe('prompt ordering enforcement', () => {
  it('throws error when text appears after code block', () => {
    const markdown = `## 1. Bad ordering
- PASS: CONTINUE
- FAIL: STOP

\`\`\`bash
npm test
\`\`\`

This text appears after the code block.
`;
    expect(() => parseRunbook(markdown)).toThrow(/prompt.*must appear before/i);
  });

  it('allows text before code block', () => {
    const markdown = `## 1. Good ordering
- PASS: CONTINUE
- FAIL: STOP

This prompt appears before the code block.

\`\`\`bash
npm test
\`\`\`
`;
    const steps = parseRunbook(markdown);
    expect(steps[0].prompt).toBe('This prompt appears before the code block.');
    expect(steps[0].command?.code).toBe('npm test');
  });

  it('throws error when text appears after code block in substep', () => {
    const markdown = `## 1. Parent

### 1.1 Substep
- PASS: CONTINUE

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
- PASS: CONTINUE

- setup.runbook.md
- cleanup.runbook.md

This text appears after runbooks - invalid.
`;
    expect(() => parseRunbook(markdown)).toThrow(/prompt.*must appear before/i);
  });

  it('concatenates multiple paragraphs before code block', () => {
    const markdown = `## 1. Multi-paragraph prompt
- PASS: CONTINUE

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
- PASS: CONTINUE

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
- PASS: COMPLETE

## Cleanup
- PASS: STOP

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
    expect(steps[0].substeps).toHaveLength(2);
    expect(steps[0].substeps?.[0]).toMatchObject({
      id: '1',
    });
    expect(steps[0].substeps?.[1]).toMatchObject({
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

- PASS: CONTINUE
- FAIL: STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the step header/,
      );
    });

    it('rejects transitions after content in step', () => {
      const md = `## 1 Step

\`\`\`bash
npm test
\`\`\`

- PASS: CONTINUE
- FAIL: STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the step header/,
      );
    });

    it('rejects transitions after prompt text in substep', () => {
      const md = `## 1 Step
### 1.1 Substep

This is prompt text.

- PASS: CONTINUE
- FAIL: STOP`;
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

- PASS: CONTINUE
- FAIL: STOP`;
      expect(() => parseRunbook(md)).toThrow(
        /Transitions must appear immediately after the substep header/,
      );
    });
  });

  describe('text after content', () => {
    it('rejects text after runbooks in substep', () => {
      const md = `## 1 Step
### 1.1 Substep
- PASS: CONTINUE
- FAIL: STOP

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
- PASS: COMPLETE

Do the work.`;
      // This should parse without error - preamble is allowed
      const steps = parseRunbook(md);
      expect(steps).toHaveLength(1);
    });
  });

  describe('list transitions handling', () => {
    it('parses list-based transitions correctly', () => {
      const md = `## 1 Step

- PASS: CONTINUE
- FAIL: STOP

Do the work.`;
      const steps = parseRunbook(md);
      expect(steps[0].transitions?.pass.action).toEqual({ type: 'CONTINUE' });
      expect(steps[0].transitions?.fail.action).toEqual({ type: 'STOP' });
    });

    it('rejects list transitions after code block', () => {
      const md = `## 1 Step

\`\`\`bash
npm test
\`\`\`

- PASS: CONTINUE
- FAIL: STOP`;
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
- PASS: CONTINUE
- FAIL: STOP

- some other list item (not a runbook)`;
      expect(() => parseRunbook(md)).toThrow(
        /Prompt text must appear before code blocks or runbooks/,
      );
    });

    it('allows runbook list item after transitions in substep', () => {
      const md = `## 1 Step

### 1.1 Sub
- PASS: CONTINUE
- FAIL: STOP

- task.runbook.md
`;
      const steps = parseRunbook(md);
      expect(steps[0].substeps?.[0].workflows).toEqual(['task.runbook.md']);
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
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Handle batch
\`\`\`bash
echo batch
\`\`\`

## 2. Done
- PASS: COMPLETE
`;
    const steps = parseRunbook(md);
    expect(steps[0].forClause).toEqual({ variable: 'batch', start: 1, end: 3 });
    expect(steps[0].substeps).toHaveLength(1);
  });
});

describe('parser ordering enforcement', () => {
  describe('paragraph-based transitions after content in substep', () => {
    it('rejects paragraph transition after prompt text in substep', () => {
      const md = `## 1 Step

### 1.1 Sub

Prompt text here.

PASS: CONTINUE
FAIL: STOP
`;
      expect(() => parseRunbook(md)).toThrow(
        /Substep 1\.1.*Transitions must appear immediately after the substep header, before any content/,
      );
    });

    it('rejects paragraph transition after code block in substep', () => {
      const md = `## 1 Step

### 1.1 Sub

\`\`\`bash
echo hi
\`\`\`

PASS: CONTINUE
`;
      expect(() => parseRunbook(md)).toThrow(
        /Substep 1\.1.*Transitions must appear immediately after the substep header, before any content/,
      );
    });
  });

  describe('paragraph-based transitions after content at step level', () => {
    it('rejects paragraph transition after prompt text in step', () => {
      const md = `## 1 Step

Some prompt text.

PASS: CONTINUE
FAIL: STOP
`;
      expect(() => parseRunbook(md)).toThrow(
        /Step 1.*Transitions must appear immediately after the step header, before any content/,
      );
    });

    it('rejects paragraph transition after code block in step', () => {
      const md = `## 1 Step

\`\`\`bash
npm test
\`\`\`

PASS: CONTINUE
`;
      expect(() => parseRunbook(md)).toThrow(
        /Step 1.*Transitions must appear immediately after the step header, before any content/,
      );
    });
  });

  describe('FOR clause ordering violations', () => {
    it('rejects duplicate FOR clause', () => {
      const md = `## 1 Step
- FOR x IN 1 TO 3
- FOR y IN 1 TO 5
- PASS ALL: CONTINUE
- FAIL ANY: STOP
`;
      expect(() => parseRunbook(md)).toThrow(/has multiple FOR clauses.*only one is allowed/);
    });

    it('rejects FOR after transitions', () => {
      const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP
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

describe('substep content filtering', () => {
  it('filters runbook references from substep prompt, preserves text', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS: CONTINUE
- FAIL: STOP

Review the following items.

- task.runbook.md
`;
    const steps = parseRunbook(md);
    const sub = steps[0].substeps?.[0];
    expect(sub?.prompt).toBe('Review the following items.');
    expect(sub?.workflows).toEqual(['task.runbook.md']);
  });

  it('returns empty prompt when substep has only runbook references', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS: CONTINUE
- FAIL: STOP

- alpha.runbook.md
- beta.runbook.md
`;
    const steps = parseRunbook(md);
    const sub = steps[0].substeps?.[0];
    expect(sub?.prompt).toBeUndefined();
    expect(sub?.workflows).toEqual(['alpha.runbook.md', 'beta.runbook.md']);
  });

  it('preserves prompt text alongside runbook refs in substep', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS: CONTINUE
- FAIL: STOP

Review the tasks carefully.

- setup.runbook.md
- deploy.runbook.md
`;
    const steps = parseRunbook(md);
    const sub = steps[0].substeps?.[0];
    expect(sub?.prompt).toContain('Review the tasks carefully.');
    expect(sub?.workflows).toEqual(['setup.runbook.md', 'deploy.runbook.md']);
  });

  it('filters runbook refs at step level and populates workflows', () => {
    const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP

- deploy.runbook.md
- verify.runbook.md
`;
    const steps = parseRunbook(md);
    expect(steps[0].workflows).toEqual(['deploy.runbook.md', 'verify.runbook.md']);
    expect(steps[0].prompt).toBeUndefined();
  });
});

// Tests extractText branches not covered by 'inline code preservation' above:
// double-backtick wrapping (value contains backtick), negative single-backtick
// assertion, and non-text node types (emphasis, strong). Intentional overlap
// for mutation coverage of lines 32-51 in parser.ts.
describe('extractText and inline code', () => {
  it('uses double-backtick wrapping for code containing backtick character', () => {
    const md = '## 1. Use `` ` `` carefully\n- PASS: COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Use `` ` `` carefully');
  });

  it('uses single-backtick wrapping for code without backtick character', () => {
    const md = '## 1. Run `test`\n- PASS: COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Run `test`');
    expect(steps[0].description).not.toContain('``');
  });

  it('extracts text from emphasis nodes in headings', () => {
    const md = '## 1. Run the *important* task\n- PASS: COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Run the important task');
  });

  it('extracts text from strong nodes in headings', () => {
    const md = '## 1. Run the **critical** task\n- PASS: COMPLETE\n';
    const steps = parseRunbook(md);
    expect(steps[0].description).toBe('Run the critical task');
  });
});

describe('regex boundaries and runbook patterns', () => {
  it('does not match runbook ref with trailing text', () => {
    const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP

- task.runbook.md extra text
`;
    const steps = parseRunbook(md);
    // "task.runbook.md extra text" should NOT be parsed as a runbook ref
    expect(steps[0].workflows).toBeUndefined();
  });

  it('does not match runbook ref starting with a dot', () => {
    const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP

- .runbook.md
`;
    const steps = parseRunbook(md);
    // ".runbook.md" has no prefix before .runbook.md so the regex requires
    // at least one non-whitespace char as a filename prefix
    expect(steps[0].workflows).toBeUndefined();
  });

  it('matches simple runbook ref', () => {
    const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP

- simple.runbook.md
`;
    const steps = parseRunbook(md);
    expect(steps[0].workflows).toEqual(['simple.runbook.md']);
  });

  it('matches path-like runbook ref', () => {
    const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP

- path/to/complex-name.runbook.md
`;
    const steps = parseRunbook(md);
    expect(steps[0].workflows).toEqual(['path/to/complex-name.runbook.md']);
  });

  it('does not treat .runbook.md.txt as a runbook ref', () => {
    const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP

- task.runbook.md.txt
`;
    const steps = parseRunbook(md);
    expect(steps[0].workflows).toBeUndefined();
  });
});

describe('parseRunbookDocument metadata', () => {
  it('uses first H1 as title and ignores subsequent H1s', () => {
    const md = `# First Title

# Second Title

## 1 Step
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md);
    expect(doc.title).toBe('First Title');
  });

  it('captures preamble description from text between H1 and first step', () => {
    const md = `# My Runbook

This is the preamble description.

## 1 Step
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md);
    expect(doc.description).toBe('This is the preamble description.');
  });

  it('returns undefined description when no preamble text', () => {
    const md = `## 1 Step
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md);
    expect(doc.description).toBeUndefined();
  });

  it('derives name from filename when no frontmatter name', () => {
    const md = `## 1 Step
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md, 'my-runbook.md');
    expect(doc.name).toBe('my-runbook.md');
  });

  it('returns undefined name when no frontmatter and no filename', () => {
    const md = `## 1 Step
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md);
    expect(doc.name).toBeUndefined();
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
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md);
    expect(doc.title).toBe('My Runbook Title');
  });
});

describe('finalizeStep coverage', () => {
  it('builds prompt from implicit text only', () => {
    const md = `## 1 Step
- PASS: COMPLETE

This is implicit prompt text.
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBe('This is implicit prompt text.');
  });

  it('returns undefined prompt when no text provided', () => {
    const md = `## 1 Step
- PASS: COMPLETE
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBeUndefined();
  });

  it('returns undefined substeps when step has no substeps', () => {
    const md = `## 1 Step
- PASS: COMPLETE

Do the work.
`;
    const steps = parseRunbook(md);
    expect(steps[0].substeps).toBeUndefined();
  });

  it('returns substeps array when step has substeps', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS: COMPLETE

Do work.
`;
    const steps = parseRunbook(md);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps![0].id).toBe('1');
  });

  it('returns undefined workflows when step has no runbook refs', () => {
    const md = `## 1 Step
- PASS: COMPLETE

Just text.
`;
    const steps = parseRunbook(md);
    expect(steps[0].workflows).toBeUndefined();
  });
});

// Intentional overlap with 'substep content filtering' above: these tests add
// stronger negative assertions (not.toContain) and trim verification to kill
// surviving mutants in the split/filter/join logic at parser.ts lines 155-163.
describe('content filtering detail', () => {
  it('filters runbook lines from substep content while keeping non-runbook lines', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS: CONTINUE
- FAIL: STOP

Check the items.

- setup.runbook.md
`;
    const steps = parseRunbook(md);
    const sub = steps[0].substeps?.[0];
    // Prompt should contain the text but NOT the runbook line
    expect(sub?.prompt).toContain('Check the items.');
    expect(sub?.prompt).not.toContain('setup.runbook.md');
    expect(sub?.workflows).toEqual(['setup.runbook.md']);
  });

  it('trims whitespace from filtered content', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS: CONTINUE

Single line of text.

- task.runbook.md
`;
    const steps = parseRunbook(md);
    const sub = steps[0].substeps?.[0];
    // Prompt should be trimmed
    expect(sub?.prompt).toBe('Single line of text.');
  });
});

describe('paragraph conditional edge cases', () => {
  it('accepts paragraph-style transitions immediately after step header', () => {
    const md = `## 1 Step

PASS: CONTINUE
FAIL: STOP

Do the work.
`;
    const steps = parseRunbook(md);
    expect(steps[0].transitions?.pass.action).toEqual({ type: 'CONTINUE' });
    expect(steps[0].transitions?.fail.action).toEqual({ type: 'STOP' });
    expect(steps[0].prompt).toBe('Do the work.');
  });

  it('accepts paragraph-style transitions immediately after substep header', () => {
    const md = `## 1 Step

### 1.1 Sub

PASS: CONTINUE
FAIL: STOP

Do substep work.
`;
    const steps = parseRunbook(md);
    const sub = steps[0].substeps?.[0];
    expect(sub?.transitions?.pass.action).toEqual({ type: 'CONTINUE' });
    expect(sub?.prompt).toBe('Do substep work.');
  });
});

describe('parser edge cases for mutation coverage', () => {
  it('ignores code blocks outside any step', () => {
    const md = `# Title

\`\`\`bash
echo outside
\`\`\`

## 1 Step
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].command).toBeUndefined();
  });

  it('parses markdown with no steps at all and skipValidation', () => {
    const md = `# Just a title

Some text but no steps.
`;
    const doc = parseRunbookDocument(md, undefined, { skipValidation: true });
    expect(doc.steps).toHaveLength(0);
    expect(doc.title).toBe('Just a title');
  });

  it('runs validation by default and throws for invalid runbooks', () => {
    const md = `## 1 Step
- PASS: GOTO 99
- FAIL: STOP
`;
    expect(() => parseRunbookDocument(md)).toThrow();
  });

  it('skips validation when skipValidation is true', () => {
    const md = `## 1 Step
- PASS: GOTO 99
- FAIL: STOP
`;
    const doc = parseRunbookDocument(md, undefined, { skipValidation: true });
    expect(doc.steps).toHaveLength(1);
  });

  it('parses text after substep as a new step', () => {
    const md = `## 1 Step

### 1.1 Sub
- PASS: CONTINUE

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
- PASS: CONTINUE

\`\`\`bash
echo hello
\`\`\`

### 1.2 Another Sub
- PASS: COMPLETE

Do other work.
`;
    const steps = parseRunbook(md);
    expect(steps[0].substeps).toHaveLength(2);
    expect(steps[0].substeps![0].command?.code).toBe('echo hello');
    expect(steps[0].substeps![1].prompt).toBe('Do other work.');
  });

  it('preserves prompt text across multiple paragraphs in step', () => {
    const md = `## 1 Step
- PASS: COMPLETE

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
- PASS: CONTINUE
- FAIL: STOP

Do first.

### 1.2 Second
- PASS: COMPLETE
- FAIL: STOP

Do second.
`;
    const steps = parseRunbook(md);
    expect(steps[0].substeps).toHaveLength(2);
    expect(steps[0].substeps![0].transitions?.pass.action).toEqual({ type: 'CONTINUE' });
    expect(steps[0].substeps![1].transitions?.pass.action).toEqual({ type: 'COMPLETE' });
  });

  it('handles step with only transitions and no other content', () => {
    const md = `## 1 Step
- PASS: CONTINUE
- FAIL: STOP

## 2 Step
- PASS: COMPLETE
`;
    const steps = parseRunbook(md);
    expect(steps[0].prompt).toBeUndefined();
    expect(steps[0].command).toBeUndefined();
    expect(steps[0].substeps).toBeUndefined();
    expect(steps[0].workflows).toBeUndefined();
    expect(steps[0].transitions?.pass.action).toEqual({ type: 'CONTINUE' });
  });

  it('validates NEXT usage in substep context with FOR clause', () => {
    const md = `## 1 Step
- FOR i IN 1 TO 3
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Sub
- PASS: NEXT
- FAIL: STOP

Do iteration.
`;
    const steps = parseRunbook(md);
    expect(steps[0].forClause).toEqual({ variable: 'i', start: 1, end: 3 });
    expect(steps[0].substeps![0].transitions?.pass.action).toEqual({ type: 'NEXT' });
  });

  it('H3 header with unparsable format is ignored when only content', () => {
    // H3 that doesn't match substep pattern — hasSeenContent becomes true
    // but no substep is created
    const md = `## 1 Step

### Random notes
`;
    const steps = parseRunbook(md);
    expect(steps[0].substeps).toBeUndefined();
  });

  it('list items in preamble are not processed as step content', () => {
    const md = `# Title

Here is a list:
- Item one
- Item two

## 1 Step
- PASS: COMPLETE
`;
    const doc = parseRunbookDocument(md);
    expect(doc.steps).toHaveLength(1);
    expect(doc.description).toContain('Here is a list:');
  });
});
