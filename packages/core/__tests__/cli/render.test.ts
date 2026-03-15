import { describe, it, expect } from '@jest/globals';
import { buildDisplayStepModel, renderStepForCLI } from '../../src/cli/render.js';
import type { Step, Substep } from '../../src/runbook/types.js';

function renderForTest(
  item: Step | Substep,
  instanceNumber?: string,
  showCommand?: boolean,
): string {
  return renderStepForCLI(buildDisplayStepModel(item, instanceNumber, showCommand));
}

describe('renderStepForCLI', () => {
  it('renders step with heading and prompt (command shown via printCommandExec)', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: 'Install dependencies',
      prompt: 'Run npm install to set up project.',
      command: { code: 'npm install' },
    };

    const result = renderForTest(step);

    // Check heading and prompt are present
    expect(result).toContain('## 1. Install dependencies');
    expect(result).toContain('Run npm install');
    // Command is now shown via printCommandExec, not in rendered step
    expect(result).not.toContain('```');
  });

  it('renders step without command', () => {
    const step: Step = {
      kind: 'base',
      name: '2',
      description: 'Review changes',
      prompt: 'Review the diff and approve.',
    };

    const result = renderForTest(step);

    expect(result).toContain('## 2. Review changes');
    expect(result).toContain('Review the diff and approve.');
    expect(result).not.toContain('```');
  });

  it('renders step without prompts (heading only)', () => {
    const step: Step = {
      kind: 'command',
      name: '3',
      description: 'Run build',
      command: { code: 'npm run build' },
    };

    const result = renderForTest(step);

    expect(result).toContain('## 3. Run build');
    // Command is now shown via printCommandExec, not in rendered step
    expect(result).not.toContain('npm run build');
  });

  it('omits transitions and substeps', () => {
    const step: Step = {
      kind: 'substeps',
      name: '1',
      description: 'With extras',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
      substeps: [{ id: '1', description: 'Substep' }],
    };

    const result = renderForTest(step);

    expect(result).not.toContain('CONTINUE');
    expect(result).not.toContain('STOP');
    expect(result).not.toContain('Substep');
  });
});

describe('step rendering with instance number', () => {
  it('renders step with instance number in heading', () => {
    const step: Step = {
      kind: 'base',
      name: '1',
      description: 'Process Item',
      prompt: 'Process item.',
    };

    const result = renderForTest(step, '1');

    expect(result).toContain('## 1. Process Item');
    expect(result).toContain('Process item.');
  });

  it('renders step with prompt unchanged', () => {
    const step: Step = {
      kind: 'base',
      name: '1',
      description: 'First step',
      prompt: 'Do something.',
    };

    const result = renderForTest(step);

    expect(result).toContain('## 1. First step');
  });

  it('does not render command in step output (command shown via printCommandExec)', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: 'Process',
      prompt: 'Process the batch.',
      command: { code: 'process-batch' },
    };

    const result = renderForTest(step, '2');

    // Heading and prompt are present
    expect(result).toContain('## 1. Process');
    expect(result).toContain('Process the batch.');
    // Command is not rendered here - shown via printCommandExec
    expect(result).not.toContain('process-batch');
    expect(result).not.toContain('```');
  });
});

describe('substep rendering', () => {
  it('renders substep with H3 heading and instance.substep format', () => {
    const substep: Substep = {
      id: '1',
      description: 'Process Item',
      prompt: 'Process next item.',
    };

    const result = renderForTest(substep, '1');

    expect(result).toContain('### 1.1. Process Item');
    expect(result).toContain('Process next item.');
  });

  it('renders substep with different id', () => {
    const substep: Substep = {
      id: '2',
      description: 'Process Item',
      prompt: 'Processing item.',
    };

    const result = renderForTest(substep, '3');

    expect(result).toContain('### 3.2. Process Item');
    expect(result).toContain('Processing item.');
  });

  it('renders static substep with correct heading', () => {
    const substep: Substep = {
      id: '1',
      description: 'First Substep',
      prompt: 'Do the first thing.',
    };

    const result = renderForTest(substep, '2');

    expect(result).toContain('### 2.1. First Substep');
  });

  it('renders substep with empty description as heading-only ID', () => {
    const substep: Substep = {
      id: '1',
      description: '',
    };

    const result = renderForTest(substep, '2');

    expect(result).toBe('### 2.1');
    expect(result).not.toMatch(/\s$/);
  });

  it('does not render substep command in output (shown via printCommandExec)', () => {
    const substep: Substep = {
      id: '1',
      description: 'Process Item',
      command: { code: 'process-batch' },
    };

    const result = renderForTest(substep, '2');

    // Heading is present
    expect(result).toContain('### 2.1. Process Item');
    // Command is not rendered - shown via printCommandExec
    expect(result).not.toContain('process');
    expect(result).not.toContain('```');
  });

  it('renders command as code block when showCommand is true', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: 'Run tests',
      command: { code: 'npm test', lang: 'bash' } as any,
    };

    const result = renderForTest(step, undefined, true);

    expect(result).toContain('```bash\nnpm test\n```');
  });

  it('renders command with different language tag when showCommand is true', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: 'Run python script',
      command: { code: 'print("hello")', lang: 'python' } as any,
    };

    const result = renderForTest(step, undefined, true);

    expect(result).toContain('```python\nprint("hello")\n```');
  });
});
