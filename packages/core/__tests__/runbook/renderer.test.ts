// __tests__/runbook/renderer.test.ts
import { describe, it, expect } from '@jest/globals';
import {
  renderAction,
  renderTransitions,
  renderSubstep,
  renderStep,
  renderRunbook,
} from '../../src/runbook/renderer/renderer.js';
import { parseRunbook } from '../../src/runbook/index.js';
import { parseRunbookDocument } from '@rundown-org/parser';
import type { Step, Substep, Runbook } from '../../src/runbook/types.js';

describe('renderAction', () => {
  it('renders CONTINUE', () => {
    expect(renderAction({ type: 'CONTINUE' })).toBe('CONTINUE');
  });

  it('renders DONE', () => {
    expect(renderAction({ type: 'COMPLETE' })).toBe('COMPLETE');
  });

  it('renders STOP without message', () => {
    expect(renderAction({ type: 'STOP' })).toBe('STOP');
  });

  it('renders STOP with message', () => {
    expect(renderAction({ type: 'STOP', message: 'fix tests' })).toBe('STOP "fix tests"');
  });

  it('renders GOTO step only', () => {
    expect(renderAction({ type: 'GOTO', target: { step: '3' } })).toBe('GOTO 3');
  });

  it('renders GOTO with substep', () => {
    expect(renderAction({ type: 'GOTO', target: { step: '3', substep: '2' } })).toBe('GOTO 3.2');
  });

  it('renders GOTO NEXT', () => {
    expect(renderAction({ type: 'GOTO', target: { step: 'NEXT' } })).toBe('GOTO NEXT');
  });

  it('renders NEXT', () => {
    expect(renderAction({ type: 'NEXT' })).toBe('NEXT');
  });

  it('renders BREAK', () => {
    expect(renderAction({ type: 'BREAK' })).toBe('BREAK');
  });

  it('renders COMPLETE with message', () => {
    expect(renderAction({ type: 'COMPLETE', message: 'all done' })).toBe('COMPLETE "all done"');
  });
});

describe('renderTransitions', () => {
  it('renders pass and fail transitions', () => {
    const result = renderTransitions({
      all: true,
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP', message: 'failed' } },
    });
    expect(result).toBe('- PASS ALL: CONTINUE\n- FAIL ANY: STOP "failed"');
  });

  it('renders transitions with retry prefix', () => {
    const result = renderTransitions({
      all: true,
      pass: { kind: 'pass', retry: 2, action: { type: 'STOP' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
    });
    expect(result).toBe('- PASS ALL: RETRY 2 STOP\n- FAIL ANY: CONTINUE');
  });

  it('omits modifier when modifierImplicit is set', () => {
    const result = renderTransitions({
      all: true,
      modifierImplicit: true,
      pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    });
    expect(result).toBe('- PASS: GOTO 2\n- FAIL: STOP');
  });
});

describe('renderSubstep', () => {
  it('renders substep with parent step number (N.M format)', () => {
    const substep: Substep = { id: '1', description: 'First reviewer' };
    expect(renderSubstep(substep, '3')).toBe('### 3.1 First reviewer');
  });

  it('renders substep with agent type', () => {
    const substep: Substep = { id: '2', description: 'Second reviewer', agentType: 'code-agent' };
    expect(renderSubstep(substep, '1')).toBe('### 1.2 Second reviewer (code-agent)');
  });

  it('renders substep with child runbooks', () => {
    const substep: Substep = {
      id: '1',
      description: 'With child runbook',
      workflows: ['task.runbook.md'],
    };
    expect(renderSubstep(substep, '1')).toBe('### 1.1 With child runbook\n\n- task.runbook.md');
  });
});

describe('renderStep', () => {
  it('renders basic step', () => {
    const step: Step = {
      name: '1',
      description: 'First step',
    };
    const result = renderStep(step);
    expect(result).toContain('## 1. First step');
  });

  it('renders step with substeps including parent step number', () => {
    const step: Step = {
      name: '3',
      description: 'Dispatch reviewers',
      substeps: [
        { id: '1', description: 'First reviewer' },
        { id: '2', description: 'Second reviewer', agentType: 'code-agent' },
      ],
    };
    const result = renderStep(step);
    expect(result).toContain('### 3.1 First reviewer');
    expect(result).toContain('### 3.2 Second reviewer (code-agent)');
  });

  it('renders step with command', () => {
    const step: Step = {
      name: '1',
      description: 'Run tests',
      command: { code: 'npm test' },
    };
    const result = renderStep(step);
    expect(result).toContain('```bash');
    expect(result).toContain('npm test');
    expect(result).toContain('```');
  });

  it('renders step with non-bash command language', () => {
    const step: Step = {
      name: '1',
      description: 'Run script',
      command: { code: 'print("hello")', lang: 'python' },
    };
    const result = renderStep(step);
    expect(result).toContain('```python');
    expect(result).toContain('print("hello")');
    expect(result).not.toContain('```bash');
  });

  it('renders FOR clause before transitions', () => {
    const step: Step = {
      name: '2',
      description: 'Review the plan',
      forClause: { variable: 'pass', start: 1, end: 2 },
      transitions: {
        all: false,
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: 'Synthesize' } } },
      },
      substeps: [{ id: '1', description: 'Review' }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR pass IN 2');
    expect(result).toContain('- PASS ANY: CONTINUE');
    expect(result).toContain('- FAIL ALL: GOTO Synthesize');
  });

  it('renders shorthand for runbook-list-derived substep', () => {
    const step = {
      name: '2',
      substepsDerivedFromRunbookList: true,
      description: 'Review the plan',
      substeps: [
        {
          id: '1',
          description: '',
          workflows: ['review-technical-accuracy.runbook.md'],
        },
      ],
    } as Step;
    const result = renderStep(step);
    expect(result).toContain('- review-technical-accuracy.runbook.md');
    expect(result).not.toContain('### 2.1');
  });

  it('renders shorthand runbook-list-derived substep with prompt', () => {
    const step = {
      name: '2',
      substepsDerivedFromRunbookList: true,
      description: 'Review the plan',
      substeps: [
        {
          id: '1',
          description: '',
          prompt: 'Review the following items carefully.',
          workflows: ['review.runbook.md'],
        },
      ],
    } as Step;
    const result = renderStep(step);
    expect(result).toContain('Review the following items carefully.');
    expect(result).toContain('- review.runbook.md');
    expect(result).not.toContain('### 2.1');
  });
});

describe('renderForClause coverage', () => {
  it('renders FOR with source and default start', () => {
    const step: Step = {
      name: '1',
      description: 'Iterate',
      forClause: { variable: 'item', start: 1, end: undefined, source: 'items' },
      substeps: [{ id: '1', description: 'Process' }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR item IN {{ items }}');
  });

  it('renders FOR with windowed source', () => {
    const step: Step = {
      name: '1',
      description: 'Iterate',
      forClause: { variable: 'item', start: 2, end: 5, source: 'items' },
      substeps: [{ id: '1', description: 'Process' }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR item IN 2 TO 5 OF {{ items }}');
  });

  it('renders FOR with unnamed variable and explicit start', () => {
    const step: Step = {
      name: '1',
      description: 'Iterate',
      forClause: { start: 2, end: 5 },
      substeps: [{ id: '1', description: 'Process' }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR 2 TO 5');
  });

  it('renders FOR with unnamed variable and implicit start', () => {
    const step: Step = {
      name: '1',
      description: 'Iterate',
      forClause: { start: 1, end: 5 },
      substeps: [{ id: '1', description: 'Process' }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR 5');
  });
});

describe('renderSubstep with parent prefix', () => {
  it('uses numeric prefix for static parent', () => {
    const substep: Substep = {
      id: '1',
      description: 'First task',
    };

    const rendered = renderSubstep(substep, '2');
    expect(rendered).toBe('### 2.1 First task');
  });

  it('uses named step prefix for named parent', () => {
    const substep: Substep = {
      id: 'Recover',
      description: 'Recovery task',
    };

    const rendered = renderSubstep(substep, 'ErrorHandler');
    expect(rendered).toBe('### ErrorHandler.Recover Recovery task');
  });
});

describe('round-trip: parse -> render -> parse', () => {
  it('round-trips simple runbook', () => {
    const original = `## 1. First step

Some description

## 2. Second step

More description`;

    const parsed1 = parseRunbook(original);
    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    expect(parsed2).toHaveLength(2);
    expect(parsed2[0].name).toBe('1');
    expect(parsed2[0].description).toBe('First step');
    expect(parsed2[1].name).toBe('2');
    expect(parsed2[1].description).toBe('Second step');
  });

  it('round-trips command with sh language', () => {
    const original = `## 1. Run script

\`\`\`sh
echo hello
\`\`\`

## 2. Next step`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].command?.lang).toBe('sh');

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('```sh');

    const parsed2 = parseRunbook(rendered);
    expect(parsed2[0].command?.lang).toBe('sh');
  });

  it('round-trips runbook with substeps', () => {
    const original = `## 1. Dispatch reviewers
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 First reviewer (code-review-agent)
### 1.2 Second reviewer (code-agent)

## 2. Complete`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].substeps).toHaveLength(2);

    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    // Verify substeps survive round-trip
    expect(parsed2[0].substeps).toHaveLength(2);
    expect(parsed2[0].substeps?.[0].id).toBe('1');
    expect(parsed2[0].substeps?.[0].description).toBe('First reviewer');
    expect(parsed2[0].substeps?.[0].agentType).toBe('code-review-agent');
    expect(parsed2[0].substeps?.[1].id).toBe('2');
    expect(parsed2[0].substeps?.[1].agentType).toBe('code-agent');
  });

  it('round-trips runbook with GOTO substep targets', () => {
    const original = `## 1. First step
- PASS: GOTO 2.1
- FAIL: STOP

## 2. Target step

### 2.1 First substep
### 2.2 Second substep
- PASS ALL: CONTINUE
- FAIL ANY: STOP`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'GOTO', target: { step: '2', substep: '1' } },
    });

    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    expect(parsed2[0].transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'GOTO', target: { step: '2', substep: '1' } },
    });
  });

  it('round-trips transitions without modifiers (no ALL/ANY in output)', () => {
    const original = `## 1. First step
- PASS: GOTO 2
- FAIL: STOP

## 2. Second step`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].transitions?.modifierImplicit).toBe(true);

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('- PASS: GOTO 2');
    expect(rendered).toContain('- FAIL: STOP');
    expect(rendered).not.toMatch(/PASS\s+(ALL|ANY)/);
    expect(rendered).not.toMatch(/FAIL\s+(ALL|ANY)/);

    // Verify re-parse produces same result
    const parsed2 = parseRunbook(rendered);
    expect(parsed2[0].transitions?.modifierImplicit).toBe(true);
    expect(parsed2[0].transitions?.pass.action).toEqual({
      type: 'GOTO',
      target: { step: '2', substep: undefined },
    });
    expect(parsed2[0].transitions?.fail.action).toEqual({ type: 'STOP' });
  });

  it('round-trips transitions with explicit modifiers (ALL/ANY preserved)', () => {
    const original = `## 1. First step
- PASS ALL: CONTINUE
- FAIL ANY: STOP

## 2. Second step`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].transitions?.modifierImplicit).toBeUndefined();

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('- PASS ALL: CONTINUE');
    expect(rendered).toContain('- FAIL ANY: STOP');
  });

  it('validates substep child runbooks parsing', () => {
    const markdown = `## 1. Setup

### 1.1 Initialize

 - setup.runbook.md

## 2. Continue`;

    const parsed = parseRunbook(markdown);
    expect(parsed[0].substeps?.[0].workflows).toEqual(['setup.runbook.md']);
  });

  it('round-trips step-level runbook-list shorthand via implicit substep', () => {
    const original = `## 1. Review the plan
- FOR pass IN 1 TO 2
- FAIL ANY: GOTO Synthesize

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md

## Synthesize`;

    const parsed1 = parseRunbook(original);
    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    expect(parsed2[0].forClause).toEqual({ variable: 'pass', start: 1, end: 2 });
    expect(parsed2[0].substepsDerivedFromRunbookList).toBe(true);
    expect(parsed2[0].substeps?.map((substep) => substep.workflows)).toEqual([
      ['review-technical-accuracy.runbook.md'],
      ['review-structural-integrity.runbook.md'],
    ]);
  });
});

describe('FOR clause with nested transitions', () => {
  it('renders FOR clause with nested transitions as indented bullets', () => {
    const step: Step = {
      name: '1',
      description: 'Review',
      forClause: {
        variable: 'pass',
        start: 1,
        end: 3,
        transitions: {
          all: true,
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
        },
      },
      substeps: [{ id: '1', description: 'Check' }],
    };

    const result = renderStep(step);
    expect(result).toContain('- FOR pass IN 3');
    expect(result).toContain('  - PASS ALL: CONTINUE');
    expect(result).toContain('  - FAIL ANY: BREAK');
  });

  it('renders FOR clause without transitions (no nested bullets)', () => {
    const step: Step = {
      name: '1',
      description: 'Review',
      forClause: {
        variable: 'pass',
        start: 1,
        end: 3,
      },
      substeps: [{ id: '1', description: 'Check' }],
    };

    const result = renderStep(step);
    expect(result).toContain('- FOR pass IN 3');
    expect(result).not.toContain('  - PASS');
    expect(result).not.toContain('  - FAIL');
  });

  it('round-trips FOR clause with nested transitions', () => {
    const markdown = `## 1. Review

- FOR pass IN 1 TO 3
  - PASS ALL: CONTINUE
  - FAIL ANY: BREAK

### 1.1 Check

\`\`\`bash
echo check
\`\`\``;

    const parsed1 = parseRunbookDocument(markdown);
    expect(parsed1.steps).toHaveLength(1);
    expect(parsed1.steps[0].forClause?.transitions).toBeDefined();
    expect(parsed1.steps[0].forClause?.transitions?.pass.action.type).toBe('CONTINUE');
    expect(parsed1.steps[0].forClause?.transitions?.fail.action.type).toBe('BREAK');

    const rendered = renderStep(parsed1.steps[0]);
    const parsed2 = parseRunbookDocument(rendered);

    // Verify transitions survive round-trip
    expect(parsed2.steps[0].forClause?.transitions).toBeDefined();
    expect(parsed2.steps[0].forClause?.transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect(parsed2.steps[0].forClause?.transitions?.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'BREAK' },
    });
  });
});

describe('renderRunbook', () => {
  it('renders runbook with title and description', () => {
    const runbook: Runbook = {
      title: 'My Runbook',
      description: 'A test runbook',
      steps: [
        { name: '1', description: 'First step' },
        { name: '2', description: 'Second step' },
      ],
    };
    const result = renderRunbook(runbook);
    expect(result).toContain('# My Runbook');
    expect(result).toContain('A test runbook');
    expect(result).toContain('## 1. First step');
    expect(result).toContain('## 2. Second step');
  });

  it('renders runbook without title', () => {
    const runbook: Runbook = {
      steps: [{ name: '1', description: 'Only step' }],
    };
    const result = renderRunbook(runbook);
    expect(result).not.toMatch(/^# /m);
    expect(result).toContain('## 1. Only step');
  });

  it('renders runbook with empty steps', () => {
    const runbook: Runbook = {
      title: 'Empty',
      steps: [],
    };
    const result = renderRunbook(runbook);
    expect(result).toContain('# Empty');
  });
});
