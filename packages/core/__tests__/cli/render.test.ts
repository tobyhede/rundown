import { describe, it, expect } from '@jest/globals';
import { renderStepForCLI } from '../../src/cli/render.js';
import type { Step, Substep } from '../../src/runbook/types.js';

describe('renderStepForCLI', () => {
  it('renders step with heading and prompt (command shown via printCommandExec)', () => {
    const step: Step = {
      name: '1',
      description: 'Install dependencies',
      isDynamic: false,
      prompt: 'Run npm install to set up project.',
      command: { code: 'npm install' },
    };

    const result = renderStepForCLI(step);

    // Check heading and prompt are present
    expect(result).toContain('## 1. Install dependencies');
    expect(result).toContain('Run npm install');
    // Command is now shown via printCommandExec, not in rendered step
    expect(result).not.toContain('```');
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
    expect(result).not.toContain('```');
  });

  it('renders step without prompts (heading only)', () => {
    const step: Step = {
      name: '3',
      description: 'Run build',
      isDynamic: false,
      command: { code: 'npm run build' },
    };

    const result = renderStepForCLI(step);

    expect(result).toContain('## 3. Run build');
    // Command is now shown via printCommandExec, not in rendered step
    expect(result).not.toContain('npm run build');
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
      prompt: 'Process batch {N}.',
    };

    const result = renderStepForCLI(step, '1');

    expect(result).toContain('## 1. Process Batch');
    expect(result).toContain('Process batch 1.');
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

  it('does not render command in step output (command shown via printCommandExec)', () => {
    const step: Step = {
      name: '{N}',
      description: 'Process Batch',
      isDynamic: true,
      prompt: 'Process the batch.',
      command: { code: 'process-batch --instance {N} --item {n}' },
    };

    const result = renderStepForCLI(step, '2', '5');

    // Heading and prompt are present
    expect(result).toContain('## 2. Process Batch');
    expect(result).toContain('Process the batch.');
    // Command is not rendered here - shown via printCommandExec
    expect(result).not.toContain('process-batch');
    expect(result).not.toContain('```');
  });
});

describe('substep rendering', () => {
  it('renders substep with H3 heading and instance.substep format', () => {
    const substep: Substep = {
      id: '{n}',
      description: 'Process Item',
      isDynamic: true,
      prompt: 'Process next item.',
    };

    const result = renderStepForCLI(substep, '1', '2');

    expect(result).toContain('### 1.2. Process Item');
    expect(result).toContain('Process next item.');
    expect(result).not.toContain('{n}');
  });

  it('substitutes {N} and {n} in substep prompt', () => {
    const substep: Substep = {
      id: '{n}',
      description: 'Process Item',
      isDynamic: true,
      prompt: 'Processing item {n} in batch {N}.',
    };

    const result = renderStepForCLI(substep, '3', '5');

    expect(result).toContain('### 3.5. Process Item');
    expect(result).toContain('Processing item 5 in batch 3.');
  });

  it('renders static substep with correct heading', () => {
    const substep: Substep = {
      id: '1',
      description: 'First Substep',
      isDynamic: false,
      prompt: 'Do the first thing.',
    };

    const result = renderStepForCLI(substep, '2', '1');

    expect(result).toContain('### 2.1. First Substep');
  });

  it('does not render substep command in output (shown via printCommandExec)', () => {
    const substep: Substep = {
      id: '{n}',
      description: 'Process Item',
      isDynamic: true,
      command: { code: 'process --batch {N} --item {n}' },
    };

    const result = renderStepForCLI(substep, '2', '3');

    // Heading is present
    expect(result).toContain('### 2.3. Process Item');
    // Command is not rendered - shown via printCommandExec
    expect(result).not.toContain('process');
    expect(result).not.toContain('```');
  });
});
