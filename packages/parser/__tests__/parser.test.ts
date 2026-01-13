import { describe, it, expect } from '@jest/globals';
import { parseWorkflow } from '../src/index.js';

describe('Step-level workflows', () => {
  it('parses workflow list in substep', () => {
    const markdown = `## 1. Execute

### 1.1 Execute workflow
- PASS: CONTINUE
- FAIL: STOP

 - task-details.runbook.md
`;
    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps![0].workflows).toEqual(['task-details.runbook.md']);
  });

  it('rejects step with both workflows and substeps', () => {
    const markdown = `## 1. Execute

 - task.runbook.md

### 1.1 Substep
- PASS: CONTINUE
- FAIL: STOP

Do work.
`;
    expect(() => parseWorkflow(markdown)).toThrow(/Violates Exclusivity Rule/i);
  });

  it('parses multiple workflows on substep', () => {
    const markdown = `## 1. Execute

### 1.1 Workflows
- PASS: CONTINUE
- FAIL: STOP

 - workflow-a.runbook.md
 - workflow-b.runbook.md
`;
    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps![0].workflows).toEqual([
      'workflow-a.runbook.md',
      'workflow-b.runbook.md'
    ]);
  });
});

describe('parseWorkflow with substep workflows', () => {
  it('should parse workflow list in substep', () => {
    const markdown = `# Test Workflow

## 1. Dispatch agents

### 1.{n} Review step
- PASS: CONTINUE
- FAIL: STOP

 - review.runbook.md
 - security.runbook.md
`;

    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps![0].workflows).toEqual([
      'review.runbook.md',
      'security.runbook.md'
    ]);
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
    const steps = parseWorkflow(markdown);
    expect(steps[0].command?.code).toBe('ls');
    expect(steps[1].command?.code).toBe('pwd');
  });

  it('treats prompt tag as rd prompt command', () => {
    const markdown = `## 1. Instruction
\`\`\`prompt
Please look at this example.
\`\`\`
`;
    const steps = parseWorkflow(markdown);
    // prompt blocks become rd prompt commands
    expect(steps[0].command).toEqual({
      code: "rd prompt 'Please look at this example.'"
    });
    expect(steps[0].prompt).toBeUndefined();  // No prompt text from prompt blocks
  });

  it('treats other tags as passive prose', () => {
    const markdown = `## 1. Example
\`\`\`json
{"key": "value"}
\`\`\`
`;
    const steps = parseWorkflow(markdown);
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
    const steps = parseWorkflow(md);
    // prompt block becomes command, text before it becomes prompt
    expect(steps[0].command).toEqual({
      code: "rd prompt 'npm run example --flag value'"
    });
    expect(steps[0].prompt).toBe('Show this to agent.');  // Text BEFORE code block
  });

  // Test escaping of single quotes in prompt blocks
  it('escapes single quotes in prompt code blocks', () => {
    const md = `## 1. Step with quotes
\`\`\`prompt
echo 'hello world'
\`\`\`
`;
    const steps = parseWorkflow(md);
    expect(steps[0].command).toEqual({
      code: "rd prompt 'echo '\\''hello world'\\'''"
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
    const steps = parseWorkflow(md);
    expect(steps[0].command).toEqual({
      code: 'npm run build',
    });
    // No need to check prompted - field doesn't exist anymore
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
    const steps = parseWorkflow(markdown);
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
    const steps = parseWorkflow(markdown);
    expect(steps[0].transitions?.pass).toEqual({
      kind: 'pass',
      action: { type: 'GOTO', target: { step: '2', substep: '1' } }
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
    expect(() => parseWorkflow(markdown)).toThrow(/substep does not exist/i);
  });

  it('rejects GOTO N.M into dynamic substeps', () => {
    const markdown = `
## 1. First
- PASS: GOTO 2.1
- FAIL: STOP

## 2. Dynamic

### 2.{n} Agent dispatch
- PASS ALL: CONTINUE
- FAIL ANY: STOP

Do work.
`;
    expect(() => parseWorkflow(markdown)).toThrow(/substep does not exist/i);
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
    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps![0].prompt).toBe('This is the implicit prompt text.');
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
    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps![0].transitions?.pass).toEqual({ kind: 'pass', action: { type: 'CONTINUE' } });
    expect(steps[0].substeps![0].transitions?.fail).toEqual({ kind: 'fail', action: { type: 'STOP', message: 'BLOCKED' } });
    expect(steps[0].substeps![1].transitions?.pass).toEqual({ kind: 'pass', action: { type: 'COMPLETE' } });
    expect(steps[0].substeps![1].transitions?.fail).toEqual({ kind: 'fail', action: { type: 'GOTO', target: { step: '1', substep: '1' } } });
  });

  it('single substep gets transitions not step', () => {
    const markdown = `## 1. Execute

### 1.1 First step
- PASS: CONTINUE
- FAIL: STOP

Do work.
`;
    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps![0].transitions?.pass).toEqual({ kind: 'pass', action: { type: 'CONTINUE' } });
    expect(steps[0].substeps![0].transitions?.fail).toEqual({ kind: 'fail', action: { type: 'STOP' } });
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
    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps![0].transitions?.fail).toEqual({
      kind: 'fail',
      action: { type: 'GOTO', target: { step: '1', substep: '2' } }
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
    expect(() => parseWorkflow(markdown)).toThrow(/substep.*does not exist|invalid/i);
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
    const steps = parseWorkflow(markdown);
    expect(steps[0].substeps).toHaveLength(1);
    expect(steps[0].substeps![0].command?.code).toBe('npm run lint');
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
    expect(() => parseWorkflow(markdown)).toThrow(/multiple code blocks/i);
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
    const steps = parseWorkflow(markdown);
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
    expect(() => parseWorkflow(markdown)).toThrow(/prompt.*must appear before/i);
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
    const steps = parseWorkflow(markdown);
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
    expect(() => parseWorkflow(markdown)).toThrow(/prompt.*must appear before/i);
  });

  // E5-R1: Edge case tests added from cross-check validation
  it('throws error when text appears after runbook list', () => {
    const markdown = `## 1. Step with runbooks
- PASS: CONTINUE

- setup.runbook.md
- cleanup.runbook.md

This text appears after runbooks - invalid.
`;
    expect(() => parseWorkflow(markdown)).toThrow(/prompt.*must appear before/i);
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
    const steps = parseWorkflow(markdown);
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
    const steps = parseWorkflow(markdown);
    expect(steps[0].prompt).toBe('Prompt text.');
  });
});

describe('parseWorkflow with named steps', () => {
  it('parses named step', () => {
    const md = `## 1 Main step
- PASS: COMPLETE

## Cleanup
- PASS: STOP

Handle cleanup`;

    const steps = parseWorkflow(md);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      name: '1',
      isDynamic: false,
    });
    expect(steps[1]).toMatchObject({
      name: 'Cleanup',
      isDynamic: false,
    });
  });

  it('parses named substep of numeric step', () => {
    const md = `## 1 Main step
### 1.1 First substep
### 1.Cleanup Handle cleanup`;

    const steps = parseWorkflow(md);
    expect(steps[0].substeps).toHaveLength(2);
    expect(steps[0].substeps![0]).toMatchObject({
      id: '1',
      isDynamic: false,
    });
    expect(steps[0].substeps![1]).toMatchObject({
      id: 'Cleanup',
      isDynamic: false,
    });
  });

  it('allows named step to coexist with static steps', () => {
    const md = `## 1 First
## 2 Second
## ErrorHandler
Handle errors`;

    const steps = parseWorkflow(md);
    expect(steps).toHaveLength(3);
    expect(steps[2].name).toBe('ErrorHandler');
  });

  it('allows named step to coexist with dynamic step', () => {
    const md = `## {N} Process each
### {N}.1 Do work

## ErrorHandler
Handle errors`;

    const steps = parseWorkflow(md);
    expect(steps).toHaveLength(2);
    expect(steps[0].isDynamic).toBe(true);
    expect(steps[1].name).toBe('ErrorHandler');
  });

  it('rejects reserved word as step name', () => {
    const md = `## NEXT Do something`;

    expect(() => parseWorkflow(md)).toThrow();
  });
});
