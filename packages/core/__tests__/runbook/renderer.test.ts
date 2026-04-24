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
import { assertHasSubsteps } from '../helpers/step-factories.js';

const DEFAULT_TRANSITIONS = {
  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
};

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
    const result = renderTransitions(
      {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP', message: 'failed' } },
      },
      { strategy: 'ALL' },
    );
    expect(result).toBe('- PASS ALL CONTINUE\n- FAIL ANY STOP "failed"');
  });

  it('renders transitions with retry prefix', () => {
    const result = renderTransitions(
      {
        pass: { kind: 'pass', retry: 2, action: { type: 'STOP' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
      },
      { strategy: 'ALL' },
    );
    expect(result).toBe('- PASS ALL RETRY 2 STOP\n- FAIL ANY CONTINUE');
  });

  it('omits modifier when no aggregation', () => {
    const result = renderTransitions({
      pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    });
    expect(result).toBe('- PASS GOTO 2\n- FAIL STOP');
  });
});

describe('renderSubstep', () => {
  it('renders substep with parent step number (N.M format)', () => {
    const substep: Substep = {
      id: '1',
      description: 'First reviewer',
      transitions: DEFAULT_TRANSITIONS,
    };
    expect(renderSubstep(substep, '3')).toBe('### 3.1 First reviewer');
  });

  it('renders substep without agent type', () => {
    const substep: Substep = {
      id: '2',
      description: 'Second reviewer',
      transitions: DEFAULT_TRANSITIONS,
    };
    expect(renderSubstep(substep, '1')).toBe('### 1.2 Second reviewer');
  });

  it('renders substep with child runbooks', () => {
    const substep: Substep = {
      id: '1',
      description: 'With child runbook',
      runbooks: ['task.runbook.md'],
      transitions: DEFAULT_TRANSITIONS,
    };
    expect(renderSubstep(substep, '1')).toBe('### 1.1 With child runbook\n\n- task.runbook.md');
  });

  it('renders DELEGATE annotation before runbook bullets', () => {
    const substep = {
      id: '1',
      description: 'Delegated child',
      runbooks: ['task.runbook.md'],
      delegate: true as const,
      transitions: DEFAULT_TRANSITIONS,
    } as Substep;
    expect(renderSubstep(substep, '1')).toBe(
      '### 1.1 Delegated child\n\n- DELEGATE\n- task.runbook.md',
    );
  });
});

describe('renderStep', () => {
  it('renders basic step', () => {
    const step: Step = {
      kind: 'base',
      name: '1',
      description: 'First step',
      transitions: DEFAULT_TRANSITIONS,
    };
    const result = renderStep(step);
    expect(result).toContain('## 1. First step');
  });

  it('renders step with substeps including parent step number', () => {
    const step: Step = {
      kind: 'substeps',
      name: '3',
      description: 'Dispatch reviewers',
      transitions: DEFAULT_TRANSITIONS,
      substeps: [
        { id: '1', description: 'First reviewer', transitions: DEFAULT_TRANSITIONS },
        { id: '2', description: 'Second reviewer', transitions: DEFAULT_TRANSITIONS },
      ],
    };
    const result = renderStep(step);
    expect(result).toContain('### 3.1 First reviewer');
    expect(result).toContain('### 3.2 Second reviewer');
  });

  it('renders step with command', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: 'Run tests',
      command: { code: 'npm test' },
      transitions: DEFAULT_TRANSITIONS,
    };
    const result = renderStep(step);
    expect(result).toContain('```bash');
    expect(result).toContain('npm test');
    expect(result).toContain('```');
  });

  it('renders step with non-bash command language', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: 'Run script',
      command: { code: 'print("hello")', lang: 'python' },
      transitions: DEFAULT_TRANSITIONS,
    };
    const result = renderStep(step);
    expect(result).toContain('```python');
    expect(result).toContain('print("hello")');
    expect(result).not.toContain('```bash');
  });

  it('renders FOR clause before transitions', () => {
    const step: Step = {
      kind: 'for',
      name: '2',
      description: 'Review the plan',
      forClause: { variable: 'pass', start: 1, end: 2 },
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: 'Synthesize' } } },
      },
      aggregation: { strategy: 'ANY' },
      substeps: [{ id: '1', description: 'Review', transitions: DEFAULT_TRANSITIONS }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR pass IN 2');
    expect(result).toContain('- PASS ANY CONTINUE');
    expect(result).toContain('- FAIL ALL GOTO Synthesize');
  });

  it('renders shorthand for runbook-list-derived substep', () => {
    const step = {
      kind: 'substeps',
      name: '2',
      substepsDerivedFromRunbookList: true,
      description: 'Review the plan',
      transitions: DEFAULT_TRANSITIONS,
      substeps: [
        {
          id: '1',
          description: '',
          runbooks: ['review-technical-accuracy.runbook.md'],
          transitions: DEFAULT_TRANSITIONS,
        },
      ],
    } as Step;
    const result = renderStep(step);
    expect(result).toContain('- review-technical-accuracy.runbook.md');
    expect(result).not.toContain('### 2.1');
  });

  it('renders shorthand runbook-list-derived substep with step-level prompt', () => {
    const step = {
      kind: 'substeps',
      name: '2',
      substepsDerivedFromRunbookList: true,
      description: 'Review the plan',
      prompt: 'Review the following items carefully.',
      transitions: DEFAULT_TRANSITIONS,
      substeps: [
        {
          id: '1',
          description: '',
          runbooks: ['review.runbook.md'],
          transitions: DEFAULT_TRANSITIONS,
        },
      ],
    } as Step;
    const result = renderStep(step);
    expect(result).toContain('Review the following items carefully.');
    expect(result).toContain('- review.runbook.md');
    expect(result).not.toContain('### 2.1');
  });

  it('renders step prompt when runbook-list shorthand has step-level prose', () => {
    const step = {
      kind: 'substeps',
      name: '3',
      description: 'Delegate subagents to review the plan',
      prompt: 'Delegate 4x subagents to review the plan.',
      substepsDerivedFromRunbookList: true,
      transitions: DEFAULT_TRANSITIONS,
      substeps: [
        {
          id: '1',
          description: '',
          runbooks: ['review-plan-technical-accuracy.runbook.md'],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          id: '2',
          description: '',
          runbooks: ['review-plan-structural-integrity.runbook.md'],
          transitions: DEFAULT_TRANSITIONS,
        },
      ],
    } as Step;
    const result = renderStep(step);
    expect(result).toContain('Delegate 4x subagents to review the plan.');
    expect(result).toContain('- review-plan-technical-accuracy.runbook.md');
    expect(result).toContain('- review-plan-structural-integrity.runbook.md');
    expect(result).not.toContain('### 3.1');
  });
});

describe('renderForClause coverage', () => {
  it('renders FOR with source and default start', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'Iterate',
      forClause: { variable: 'item', start: 1, source: 'items' },
      transitions: DEFAULT_TRANSITIONS,
      substeps: [{ id: '1', description: 'Process', transitions: DEFAULT_TRANSITIONS }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR item IN {{ items }}');
  });

  it('renders FOR with windowed source', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'Iterate',
      forClause: { variable: 'item', start: 2, end: 5, source: 'items' },
      transitions: DEFAULT_TRANSITIONS,
      substeps: [{ id: '1', description: 'Process', transitions: DEFAULT_TRANSITIONS }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR item IN 2 TO 5 OF {{ items }}');
  });

  it('renders FOR with unnamed variable and explicit start', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'Iterate',
      forClause: { start: 2, end: 5 },
      transitions: DEFAULT_TRANSITIONS,
      substeps: [{ id: '1', description: 'Process', transitions: DEFAULT_TRANSITIONS }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR 2 TO 5');
  });

  it('renders FOR with unnamed variable and implicit start', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'Iterate',
      forClause: { start: 1, end: 5 },
      transitions: DEFAULT_TRANSITIONS,
      substeps: [{ id: '1', description: 'Process', transitions: DEFAULT_TRANSITIONS }],
    };
    const result = renderStep(step);
    expect(result).toContain('- FOR 5');
  });

  it('throws when rendering FOR step with unresolved bounds', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'Iterate',
      forClause: { unresolved: true as const, variable: 'item', start: 1, end: { ref: 'Max' } },
      transitions: DEFAULT_TRANSITIONS,
      substeps: [{ id: '1', description: 'Process', transitions: DEFAULT_TRANSITIONS }],
    } as Step;
    expect(() => renderStep(step)).toThrow('Cannot render unresolved FOR clause bounds');
  });
});

describe('renderSubstep with parent prefix', () => {
  it('uses numeric prefix for static parent', () => {
    const substep: Substep = {
      id: '1',
      description: 'First task',
      transitions: DEFAULT_TRANSITIONS,
    };

    const rendered = renderSubstep(substep, '2');
    expect(rendered).toBe('### 2.1 First task');
  });

  it('uses named step prefix for named parent', () => {
    const substep: Substep = {
      id: 'Recover',
      description: 'Recovery task',
      transitions: DEFAULT_TRANSITIONS,
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
    expect((parsed1[0] as any).command?.lang).toBe('sh');

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('```sh');

    const parsed2 = parseRunbook(rendered);
    expect((parsed2[0] as any).command?.lang).toBe('sh');
  });

  it('round-trips runbook with substeps', () => {
    const original = `## 1. Dispatch reviewers
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First reviewer
### 1.2 Second reviewer

## 2. Complete`;

    const parsed1 = parseRunbook(original);
    expect((parsed1[0] as any).substeps).toHaveLength(2);

    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    // Verify substeps survive round-trip
    expect((parsed2[0] as any).substeps).toHaveLength(2);
    expect((parsed2[0] as any).substeps?.[0].id).toBe('1');
    expect((parsed2[0] as any).substeps?.[0].description).toBe('First reviewer');
    expect((parsed2[0] as any).substeps?.[1].id).toBe('2');
    expect((parsed2[0] as any).substeps?.[1].description).toBe('Second reviewer');
  });

  it('round-trips runbook with GOTO substep targets', () => {
    const original = `## 1. First step
- PASS GOTO 2.1
- FAIL STOP

## 2. Target step

### 2.1 First substep
### 2.2 Second substep
- PASS ALL CONTINUE
- FAIL ANY STOP`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'GOTO', target: { step: '2', substep: '1' } },
    });

    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    expect(parsed2[0].transitions.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'GOTO', target: { step: '2', substep: '1' } },
    });
  });

  it('round-trips transitions without modifiers (no ALL/ANY in output)', () => {
    const original = `## 1. First step
- PASS GOTO 2
- FAIL STOP

## 2. Second step`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].aggregation).toBeUndefined();

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('- PASS GOTO 2');
    expect(rendered).toContain('- FAIL STOP');
    expect(rendered).not.toMatch(/PASS\s+(ALL|ANY)/);
    expect(rendered).not.toMatch(/FAIL\s+(ALL|ANY)/);

    // Verify re-parse produces same result
    const parsed2 = parseRunbook(rendered);
    expect(parsed2[0].aggregation).toBeUndefined();
    expect(parsed2[0].transitions.pass.action).toEqual({
      type: 'GOTO',
      target: { step: '2', substep: undefined },
    });
    expect(parsed2[0].transitions.fail.action).toEqual({ type: 'STOP' });
  });

  it('round-trips transitions with explicit modifiers (ALL/ANY preserved)', () => {
    const original = `## 1. First step
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Sub
- PASS DEFER
- FAIL DEFER

## 2. Second step`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].aggregation?.strategy).toBe('ALL');

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('- PASS ALL CONTINUE');
    expect(rendered).toContain('- FAIL ANY STOP');
  });

  it('validates substep child runbooks parsing', () => {
    const markdown = `## 1. Setup

### 1.1 Initialize

 - setup.runbook.md

## 2. Continue`;

    const parsed = parseRunbook(markdown);
    expect((parsed[0] as any).substeps?.[0].runbooks).toEqual(['setup.runbook.md']);
  });

  it('round-trips step-level runbook-list shorthand via implicit substep', () => {
    const original = `## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY GOTO Synthesize

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md

## Synthesize`;

    const parsed1 = parseRunbook(original);
    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    expect((parsed2[0] as any).forClause).toEqual({ variable: 'pass', start: 1, end: 2 });
    expect((parsed2[0] as any).substepsDerivedFromRunbookList).toBe(true);
    expect((parsed2[0] as any).substeps?.map((substep: any) => substep.runbooks)).toEqual([
      ['review-technical-accuracy.runbook.md'],
      ['review-structural-integrity.runbook.md'],
    ]);
  });

  it('round-trips DELEGATE annotation on H3 substep', () => {
    const original = `## 1. Dispatch reviewers

### 1.1 First reviewer

- DELEGATE
- review.runbook.md

## 2. Synthesize`;

    const parsed1 = parseRunbook(original);
    expect((parsed1[0] as any).substeps?.[0].delegate).toBe(true);

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('- DELEGATE');

    const parsed2 = parseRunbook(rendered);
    expect((parsed2[0] as any).substeps?.[0].delegate).toBe(true);
    expect((parsed2[0] as any).substeps?.[0].runbooks).toEqual(['review.runbook.md']);
  });

  it('round-trips DELEGATE annotation on runbook-list shorthand substep', () => {
    const original = `## 1. Dispatch reviewers

- review-a.runbook.md
  - DELEGATE
- review-b.runbook.md
  - DELEGATE

## 2. Synthesize`;

    const parsed1 = parseRunbook(original);
    const substeps1 = (parsed1[0] as any).substeps;
    expect(substeps1).toHaveLength(2);
    expect(substeps1[0].delegate).toBe(true);
    expect(substeps1[1].delegate).toBe(true);

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered.match(/- DELEGATE/g)).toHaveLength(2);

    const parsed2 = parseRunbook(rendered);
    const substeps2 = (parsed2[0] as any).substeps;
    expect(substeps2).toHaveLength(2);
    expect(substeps2[0].delegate).toBe(true);
    expect(substeps2[1].delegate).toBe(true);
  });

  it('round-trips FOR without forClause transitions', () => {
    const original = `## 1. Process items

- FOR item IN 1 TO 3
- PASS GOTO 2
- FAIL STOP "processing failed"

### 1.1 Check item

Do the check.

## 2. Done`;

    const parsed1 = parseRunbook(original);
    expect((parsed1[0] as any).forClause?.transitions).toBeUndefined();
    expect((parsed1[0] as any).forClause?.aggregation).toBeUndefined();

    const rendered = parsed1.map(renderStep).join('\n\n');
    // No indented forClause transitions rendered
    expect(rendered).not.toMatch(/^ {2}- PASS/m);
    expect(rendered).not.toMatch(/^ {2}- FAIL/m);
    // Step-level non-default transitions ARE rendered
    expect(rendered).toContain('- PASS GOTO 2');
    expect(rendered).toContain('- FAIL STOP "processing failed"');

    const parsed2 = parseRunbook(rendered);
    expect((parsed2[0] as any).forClause?.transitions).toBeUndefined();
    expect((parsed2[0] as any).forClause?.aggregation).toBeUndefined();
    // Step-level transitions survive round-trip
    expect(parsed2[0].transitions.pass.action).toEqual({
      type: 'GOTO',
      target: { step: '2', substep: undefined },
    });
    expect(parsed2[0].transitions.fail.action).toEqual({
      type: 'STOP',
      message: 'processing failed',
    });
  });

  it('round-trips FOR with default transitions and H3 substeps', () => {
    const original = `## 1. Process items

- FOR item IN 1 TO 3

### 1.1 Check item

Do the check.

## 2. Done`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].kind).toBe('for');

    const rendered = parsed1.map(renderStep).join('\n\n');
    // Blank line must separate FOR clause from H3
    expect(rendered).toContain('- FOR item IN 3\n\n### 1.1');

    const parsed2 = parseRunbook(rendered);
    expect(parsed2[0].kind).toBe('for');
    assertHasSubsteps(parsed2[0]);
    expect(parsed2[0].substeps).toHaveLength(1);
    expect(parsed2[0].substeps[0].description).toBe('Check item');
  });

  it('round-trips FOR with default transitions and shorthand substeps with prompt', () => {
    const original = `## 1. Review the plan

- FOR pass IN 1 TO 2

Review the following items carefully.

- review.runbook.md

## 2. Done`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].kind).toBe('for');

    const rendered = parsed1.map(renderStep).join('\n\n');
    expect(rendered).toContain('Review the following items carefully.');
    const parsed2 = parseRunbook(rendered);

    expect(parsed2[0].kind).toBe('for');
    expect((parsed2[0] as any).forClause).toEqual({ variable: 'pass', start: 1, end: 2 });
    expect((parsed2[0] as any).substepsDerivedFromRunbookList).toBe(true);
    expect(parsed2[0].prompt).toBe('Review the following items carefully.');
  });

  it('round-trips FOR with default transitions and step prompt', () => {
    const original = `## 1. Process items

- FOR item IN 1 TO 3

Process each item carefully.

### 1.1 Check item

## 2. Done`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].kind).toBe('for');
    expect(parsed1[0].prompt).toBe('Process each item carefully.');

    const rendered = parsed1.map(renderStep).join('\n\n');
    const parsed2 = parseRunbook(rendered);

    expect(parsed2[0].kind).toBe('for');
    expect(parsed2[0].prompt).toBe('Process each item carefully.');
    assertHasSubsteps(parsed2[0]);
    expect(parsed2[0].substeps).toHaveLength(1);
  });

  it('round-trips substeps without aggregation', () => {
    const original = `## 1. Sequential check

### 1.1 First check

Do check one.

### 1.2 Second check

Do check two.

## 2. Done`;

    const parsed1 = parseRunbook(original);
    expect(parsed1[0].aggregation).toBeUndefined();

    const rendered = parsed1.map(renderStep).join('\n\n');
    // Default transitions suppressed by hasNonDefaultTransitions
    expect(rendered).not.toMatch(/- PASS\b/);
    expect(rendered).not.toMatch(/- FAIL\b/);
    // No ALL/ANY modifiers
    expect(rendered).not.toMatch(/\bALL\b/);
    expect(rendered).not.toMatch(/\bANY\b/);

    const parsed2 = parseRunbook(rendered);
    expect(parsed2[0].aggregation).toBeUndefined();
    // Substeps survive round-trip
    assertHasSubsteps(parsed2[0]);
    expect(parsed2[0].substeps).toHaveLength(2);
    expect(parsed2[0].substeps[0].description).toBe('First check');
    expect(parsed2[0].substeps[1].description).toBe('Second check');
  });
});

describe('FOR clause with nested transitions', () => {
  it('renders FOR clause with nested transitions as indented bullets', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'Review',
      forClause: {
        variable: 'pass',
        start: 1,
        end: 3,
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
        },
        aggregation: { strategy: 'ALL' },
      },
      transitions: DEFAULT_TRANSITIONS,
      substeps: [{ id: '1', description: 'Check', transitions: DEFAULT_TRANSITIONS }],
    };

    const result = renderStep(step);
    expect(result).toContain('- FOR pass IN 3');
    expect(result).toContain('  - PASS ALL CONTINUE');
    expect(result).toContain('  - FAIL ANY BREAK');
  });

  it('renders FOR clause without transitions (no nested bullets)', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'Review',
      forClause: {
        variable: 'pass',
        start: 1,
        end: 3,
      },
      transitions: DEFAULT_TRANSITIONS,
      substeps: [{ id: '1', description: 'Check', transitions: DEFAULT_TRANSITIONS }],
    };

    const result = renderStep(step);
    expect(result).toContain('- FOR pass IN 3');
    expect(result).not.toContain('  - PASS');
    expect(result).not.toContain('  - FAIL');
  });

  it('round-trips FOR clause with nested transitions', () => {
    const markdown = `## 1. Review

- FOR pass IN 1 TO 3
  - PASS ALL CONTINUE
  - FAIL ANY BREAK

### 1.1 Check

\`\`\`bash
echo check
\`\`\``;

    const { runbook: parsed1 } = parseRunbookDocument(markdown);
    expect(parsed1.steps).toHaveLength(1);
    expect((parsed1.steps[0] as any).forClause?.transitions).toBeDefined();
    expect((parsed1.steps[0] as any).forClause?.transitions?.pass.action.type).toBe('CONTINUE');
    expect((parsed1.steps[0] as any).forClause?.transitions?.fail.action.type).toBe('BREAK');
    expect((parsed1.steps[0] as any).forClause?.aggregation).toEqual({ strategy: 'ALL' });

    const rendered = renderStep(parsed1.steps[0]);
    const { runbook: parsed2 } = parseRunbookDocument(rendered);

    // Verify transitions survive round-trip
    expect((parsed2.steps[0] as any).forClause?.transitions).toBeDefined();
    expect((parsed2.steps[0] as any).forClause?.transitions?.pass).toEqual({
      kind: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
    });
    expect((parsed2.steps[0] as any).forClause?.transitions?.fail).toEqual({
      kind: 'fail',
      retry: 0,
      action: { type: 'BREAK' },
    });
    expect((parsed2.steps[0] as any).forClause?.aggregation).toEqual({ strategy: 'ALL' });
  });
});

describe('renderRunbook', () => {
  it('renders runbook with title and description', () => {
    const runbook: Runbook = {
      title: 'My Runbook',
      description: 'A test runbook',
      steps: [
        { kind: 'base', name: '1', description: 'First step', transitions: DEFAULT_TRANSITIONS },
        { kind: 'base', name: '2', description: 'Second step', transitions: DEFAULT_TRANSITIONS },
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
      steps: [
        { kind: 'base', name: '1', description: 'Only step', transitions: DEFAULT_TRANSITIONS },
      ],
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
