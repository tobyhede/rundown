import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  formatPosition,
  printSeparator,
  printMetadata,
  printActionBlock,
  printStepBlock,
  printCommandExec,
  printWorkflowComplete,
  printWorkflowStopped,
  printWorkflowStoppedAtStep,
  printWorkflowStashed,
  printNoActiveWorkflow,
  TestWriter,
  setColorEnabled,
  resetColorCache,
} from '../../src/cli/index.js';
import type { Step } from '../../src/workflow/types.js';

describe('output formatter', () => {
  let writer: TestWriter;

  beforeEach(() => {
    writer = new TestWriter();
    resetColorCache();
    setColorEnabled(false);
  });

  describe('formatPosition', () => {
    it('formats position without substep', () => {
      expect(formatPosition({ current: '2', total: 5 })).toBe('2/5');
    });

    it('formats position with substep', () => {
      expect(formatPosition({ current: '2', total: 5, substep: '1' })).toBe(
        '2.1/5'
      );
    });

    it('formats position with string total for dynamic workflows', () => {
      expect(formatPosition({ current: '1', total: '{N}' })).toBe('1/1*');
    });

    it('formats position with substep and string total', () => {
      expect(formatPosition({ current: '1', total: '{N}', substep: '2' })).toBe(
        '1.2/1*'
      );
    });
  });

  describe('printSeparator', () => {
    it('prints separator line', () => {
      printSeparator(writer);
      expect(writer.getLines()).toEqual(['-----']);
    });
  });

  describe('printMetadata', () => {
    it('prints metadata without prompt line in default mode', () => {
      printMetadata(
        {
          file: 'runbooks/build.md',
          state: '.claude/rundown/runs/wf-123.json',
        },
        writer
      );
      expect(writer.getLines()).toEqual([
        'File:     runbooks/build.md',
        'State:    .claude/rundown/runs/wf-123.json',
      ]);
    });

    it('prints prompt line when prompted is true', () => {
      printMetadata(
        {
          file: 'runbooks/build.md',
          state: '.claude/rundown/runs/wf-123.json',
          prompted: true,
        },
        writer
      );
      expect(writer.getOutput()).toContain('Prompt:   Yes');
    });

    it('omits prompt line when prompted is false', () => {
      printMetadata(
        {
          file: 'runbooks/build.md',
          state: '.claude/rundown/runs/wf-123.json',
          prompted: false,
        },
        writer
      );
      expect(writer.getOutput()).not.toContain('Prompt:   Yes');
      expect(writer.getOutput()).not.toContain('Prompt:   No');
    });
  });

  describe('printActionBlock', () => {
    it('prints action only (start command)', () => {
      printActionBlock({ action: 'START' }, writer);
      expect(writer.getLines()).toEqual(['Action:   START']);
    });

    it('prints action with from and result (pass command)', () => {
      printActionBlock(
        {
          action: 'CONTINUE',
          from: { current: '1', total: 5 },
          result: 'PASS',
        },
        writer
      );
      expect(writer.getLines()).toEqual([
        'Action:   CONTINUE',
        'From:     1/5',
        'Result:   PASS',
      ]);
    });

    it('prints action with from but no result (goto command)', () => {
      printActionBlock(
        {
          action: 'GOTO 3',
          from: { current: '1', total: 5 },
        },
        writer
      );
      expect(writer.getLines()).toEqual(['Action:   GOTO 3', 'From:     1/5']);
    });

    it('prints retry with count', () => {
      printActionBlock(
        {
          action: 'RETRY (1/3)',
          from: { current: '2', total: 5 },
          result: 'FAIL',
        },
        writer
      );
      expect(writer.getOutput()).toContain('Action:   RETRY (1/3)');
    });
  });

  describe('printStepBlock', () => {
    it('prints step position and content', () => {
      const step: Step = {
        name: '1',
        description: 'First step',
        isDynamic: false,
        prompt: 'Do something.',
        command: { code: 'npm test' },
      };
      printStepBlock({ current: '1', total: 3 }, step, writer);

      const output = writer.getOutput();
      expect(output).toContain('Step:     1/3');
      expect(output).toContain('## 1. First step');
      expect(output).toContain('Do something.');
      expect(output).toContain('npm test');
    });

    it('prints dynamic step with resolved instance number', () => {
      const step: Step = {
        name: '{N}',
        description: 'Process Batch',
        isDynamic: true,
        prompt: 'Process the batch.',
      };
      printStepBlock({ current: '1', total: '{N}' }, step, writer);

      const output = writer.getOutput();
      expect(output).toContain('Step:     1/1*');
      expect(output).toContain('## 1. Process Batch');
      expect(output).not.toContain('## {N}.');
    });

    it('prints dynamic step with substep', () => {
      const step: Step = {
        name: '{N}',
        description: 'Process Batch',
        isDynamic: true,
        prompt: 'Process item {n}.',
      };
      printStepBlock({ current: '2', total: '{N}', substep: '3' }, step, writer);

      const output = writer.getOutput();
      expect(output).toContain('Step:     2.3/2*');
      expect(output).toContain('Process item 3.');
    });
  });

  describe('printCommandExec', () => {
    it('prints command with $ prefix', () => {
      printCommandExec('npm test', writer);
      expect(writer.getOutput()).toContain('$ npm test');
    });
  });

  describe('printWorkflowComplete', () => {
    it('prints workflow complete message', () => {
      printWorkflowComplete(undefined, writer);
      expect(writer.getOutput()).toContain('Runbook:  COMPLETE');
    });
  });

  describe('printWorkflowStopped', () => {
    it('prints stopped message', () => {
      printWorkflowStopped(undefined, writer);
      expect(writer.getOutput()).toContain('Runbook:  STOP');
    });
  });

  describe('printWorkflowStoppedAtStep', () => {
    it('prints stop message', () => {
      printWorkflowStoppedAtStep({ current: '2', total: 5 }, undefined, writer);
      expect(writer.getOutput()).toContain('Runbook:  STOP');
    });
  });

  describe('printWorkflowStashed', () => {
    it('prints step position and stashed message', () => {
      printWorkflowStashed({ current: '2', total: 5 }, writer);
      expect(writer.getOutput()).toContain('Step:     2/5');
      expect(writer.getOutput()).toContain('Runbook:  STASHED');
    });
  });

  describe('printNoActiveWorkflow', () => {
    it('prints no active runbook message', () => {
      printNoActiveWorkflow(writer);
      expect(writer.getLines()).toEqual(['No active runbook.']);
    });
  });
});
