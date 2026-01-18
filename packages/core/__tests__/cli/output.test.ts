import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  formatPosition,
  formatStepNumber,
  printSeparator,
  printStepSeparator,
  printMetadata,
  printActionBlock,
  printStepBlock,
  printCommandExec,
  printRunbookComplete,
  printRunbookStopped,
  printRunbookStoppedAtStep,
  printRunbookStashed,
  printNoActiveRunbook,
  TestWriter,
  setColorEnabled,
  resetColorCache,
} from '../../src/cli/index.js';
import type { Step } from '../../src/runbook/types.js';

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

    it('formats position with string total for dynamic runbooks', () => {
      expect(formatPosition({ current: '1', total: '{N}' })).toBe('1/1*');
    });

    it('formats position with substep and string total', () => {
      expect(formatPosition({ current: '1', total: '{N}', substep: '2' })).toBe(
        '1.2/1*'
      );
    });

    it('formats named step without total', () => {
      expect(formatPosition({ current: 'RECOVER', total: 6 })).toBe('RECOVER');
    });

    it('formats named step with substep without total', () => {
      expect(formatPosition({ current: 'RECOVER', total: 6, substep: '1' })).toBe(
        'RECOVER.1'
      );
    });
  });

  describe('formatStepNumber', () => {
    it('formats step number without substep', () => {
      expect(formatStepNumber({ current: '2', total: 5 })).toBe('2');
    });

    it('formats step number with substep', () => {
      expect(formatStepNumber({ current: '2', total: 5, substep: '1' })).toBe('2.1');
    });

    it('formats named step', () => {
      expect(formatStepNumber({ current: 'RECOVER', total: 6 })).toBe('RECOVER');
    });

    it('formats named step with substep', () => {
      expect(formatStepNumber({ current: 'RECOVER', total: 6, substep: '2' })).toBe('RECOVER.2');
    });
  });

  describe('printSeparator', () => {
    it('prints separator line', () => {
      printSeparator(writer);
      expect(writer.getLines()).toEqual(['-----']);
    });
  });

  describe('printStepSeparator', () => {
    it('prints separator with step number', () => {
      printStepSeparator({ current: '2', total: 5 }, writer);
      const output = writer.getOutput();
      expect(output).toContain('───');
      expect(output).toContain('2');
    });

    it('prints separator with substep number', () => {
      printStepSeparator({ current: '1', total: 3, substep: '2' }, writer);
      const output = writer.getOutput();
      expect(output).toContain('1.2');
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
        'From:     1',
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
      expect(writer.getLines()).toEqual(['Action:   GOTO 3', 'From:     1']);
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

    it('prints action with command field', () => {
      printActionBlock(
        {
          action: 'RETRY (1/1)',
          from: { current: '1', total: 1 },
          command: 'npm run deploy:check',
          result: 'FAIL',
        },
        writer
      );
      expect(writer.getLines()).toEqual([
        'Action:   RETRY (1/1)',
        'From:     1',
        'Command:  npm run deploy:check',
        'Result:   FAIL',
      ]);
    });

    it('prints action with at field showing current position', () => {
      printActionBlock(
        {
          action: 'CONTINUE',
          from: { current: '1', total: 5 },
          command: 'npm test',
          result: 'PASS',
          at: { current: '2', total: 5 },
        },
        writer
      );
      expect(writer.getLines()).toEqual([
        'Action:   CONTINUE',
        'From:     1',
        'Command:  npm test',
        'Result:   PASS',
        'At:       2/5',
      ]);
    });
  });

  describe('printStepBlock', () => {
    it('prints step heading and prompt (no step position line)', () => {
      const step: Step = {
        name: '1',
        description: 'First step',
        isDynamic: false,
        prompt: 'Do something.',
        command: { code: 'npm test' },
      };
      printStepBlock({ current: '1', total: 3 }, step, writer);

      const output = writer.getOutput();
      // Step position is now shown via separator and At: in action block, not here
      expect(output).not.toContain('Step:');
      expect(output).toContain('## 1. First step');
      expect(output).toContain('Do something.');
      // Command is now shown via printCommandExec, not in step block
      expect(output).not.toContain('```');
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
      // Step position is now in action block, not step block
      expect(output).not.toContain('Step:');
      expect(output).toContain('## 1. Process Batch');
      expect(output).not.toContain('## {N}.');
    });

    it('prints dynamic step with substep and resolved placeholders', () => {
      const step: Step = {
        name: '{N}',
        description: 'Process Batch',
        isDynamic: true,
        prompt: 'Process item {n}.',
      };
      printStepBlock({ current: '2', total: '{N}', substep: '3' }, step, writer);

      const output = writer.getOutput();
      // Step position is now in action block, not step block
      expect(output).not.toContain('Step:');
      expect(output).toContain('Process item 3.');
    });
  });

  describe('printCommandExec', () => {
    it('prints command with $ prefix', () => {
      printCommandExec('npm test', writer);
      expect(writer.getOutput()).toContain('$ npm test');
    });
  });

  describe('printRunbookComplete', () => {
    it('prints runbook complete message', () => {
      printRunbookComplete(undefined, writer);
      expect(writer.getOutput()).toContain('Runbook:  COMPLETE');
    });
  });

  describe('printRunbookStopped', () => {
    it('prints stopped message', () => {
      printRunbookStopped(undefined, writer);
      expect(writer.getOutput()).toContain('Runbook:  STOP');
    });
  });

  describe('printRunbookStoppedAtStep', () => {
    it('prints stop message', () => {
      printRunbookStoppedAtStep({ current: '2', total: 5 }, undefined, writer);
      expect(writer.getOutput()).toContain('Runbook:  STOP');
    });
  });

  describe('printRunbookStashed', () => {
    it('prints step position and stashed message', () => {
      printRunbookStashed({ current: '2', total: 5 }, writer);
      expect(writer.getOutput()).toContain('Step:     2/5');
      expect(writer.getOutput()).toContain('Runbook:  STASHED');
    });
  });

  describe('printNoActiveRunbook', () => {
    it('prints no active runbook message', () => {
      printNoActiveRunbook(writer);
      expect(writer.getLines()).toEqual(['No active runbook.']);
    });
  });
});
