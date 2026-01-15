import { describe, it, expect } from '@jest/globals';
import { renderStepForCLI } from '../../src/cli/render.js';
import type { Step } from '../../src/workflow/types.js';

describe('renderStepForCLI', () => {
  it('renders step with prompts before command', () => {
    const step: Step = {
      name: '1',
      description: 'Install dependencies',
      isDynamic: false,
      prompt: 'Run npm install to set up project.',
      command: { code: 'npm install' },
    };

    const result = renderStepForCLI(step);

    // Check order: heading, prompt, command
    const headingIdx = result.indexOf('## 1. Install dependencies');
    const promptIdx = result.indexOf('Run npm install');
    const commandIdx = result.indexOf('npm install');

    expect(headingIdx).toBeLessThan(promptIdx);
    expect(promptIdx).toBeLessThan(commandIdx);
  });

  it('renders step without command', () => {
    const step: Step = {
      name: '2',
      description: 'Review changes',
      isDynamic: false,
      prompt: 'Review the diff and approve.',
    };

    const result = renderStepForCLI(step);

    expect(result).toContain('## 2. Review changes');
    expect(result).toContain('Review the diff and approve.');
    expect(result).not.toContain('```bash');
  });

  it('renders step without prompts', () => {
    const step: Step = {
      name: '3',
      description: 'Run build',
      isDynamic: false,
      command: { code: 'npm run build' },
    };

    const result = renderStepForCLI(step);

    expect(result).toContain('## 3. Run build');
    expect(result).toContain('npm run build');
  });

  it('omits transitions and substeps', () => {
    const step: Step = {
      name: '1',
      description: 'With extras',
      isDynamic: false,
      command: { code: 'npm test' },
      transitions: {
        all: true,
        pass: { type: 'CONTINUE' },
        fail: { type: 'STOP' },
      },
      substeps: [{ id: '1', description: 'Substep', isDynamic: false }],
    };

    const result = renderStepForCLI(step);

    expect(result).not.toContain('CONTINUE');
    expect(result).not.toContain('STOP');
    expect(result).not.toContain('Substep');
  });
});

describe('dynamic step rendering', () => {
  it('substitutes {N} with instance number in heading', () => {
    const step: Step = {
      name: '{N}',
      description: 'Process Batch',
      isDynamic: true,
      prompt: 'Process the batch.',
    };

    const result = renderStepForCLI(step, '1');

    expect(result).toContain('## 1. Process Batch');
    expect(result).not.toContain('{N}');
  });

  it('substitutes {N} and {n} with instance and substep numbers', () => {
    const step: Step = {
      name: '{N}',
      description: 'Process Batch',
      isDynamic: true,
      prompt: 'Process item {n} in batch {N}.',
    };

    const result = renderStepForCLI(step, '2', '3');

    expect(result).toContain('## 2. Process Batch');
    expect(result).toContain('Process item 3 in batch 2.');
  });

  it('leaves non-dynamic steps unchanged', () => {
    const step: Step = {
      name: '1',
      description: 'First step',
      isDynamic: false,
      prompt: 'Do something.',
    };

    const result = renderStepForCLI(step);

    expect(result).toContain('## 1. First step');
  });
});
