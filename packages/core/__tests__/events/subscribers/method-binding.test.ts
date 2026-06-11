/**
 * Regression tests for subscriber method binding.
 *
 * These tests verify that JSONSubscriber.handle and CLISubscriber.handle
 * can be passed as callback references to ExecutionEventEmitter.subscribe()
 * without losing their `this` context.
 *
 * The implementation uses arrow function class properties which are
 * automatically bound to the instance. This test guards against regression
 * if someone changes them to regular methods.
 */
import { describe, it, expect } from '@jest/globals';
import { ExecutionEventEmitter } from '../../../src/events/emitter.js';
import { JSONSubscriber } from '../../../src/events/subscribers/json.js';
import { CLISubscriber } from '../../../src/events/subscribers/cli.js';
describe('Subscriber method binding', () => {
  describe('JSONSubscriber.handle binding', () => {
    it('maintains this context when passed directly to subscribe()', () => {
      // This test verifies that passing jsonSubscriber.handle directly
      // to emitter.subscribe() works correctly - the handle method must
      // retain access to this.events to push events.
      const emitter = new ExecutionEventEmitter('wf-test', {
        source: 'project',
        path: 'test.runbook.md',
      });
      const jsonSubscriber = new JSONSubscriber();

      // Pass handle directly as callback - this is how fail.ts uses it
      emitter.subscribe(jsonSubscriber.handle);

      emitter.emit({
        type: 'RUNBOOK_STARTED',
        payload: {
          prompted: false,
          statePath: '.rundown/runs/wf-test.json',
        },
      });

      // If handle lost its this binding, this would be empty or throw
      expect(jsonSubscriber.getEvents()).toHaveLength(1);
      expect(jsonSubscriber.getEvents()[0].type).toBe('RUNBOOK_STARTED');
    });

    it('collects multiple events when handle is passed as callback', () => {
      const emitter = new ExecutionEventEmitter('wf-test', {
        source: 'project',
        path: 'test.runbook.md',
      });
      const jsonSubscriber = new JSONSubscriber();

      emitter.subscribe(jsonSubscriber.handle);

      emitter.emit({
        type: 'RUNBOOK_STARTED',
        payload: {
          prompted: false,
          statePath: '.rundown/runs/wf-test.json',
        },
      });
      emitter.emit({
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'CONTINUE',
          from: '1',
          at: '2',
          result: 'PASS',
        },
      });
      emitter.emit({
        type: 'RUNBOOK_COMPLETED',
        payload: {
          finalPosition: { current: '2', total: 2 },
        },
      });

      const summary = jsonSubscriber.getSummary();
      expect(summary.status).toBe('complete');
      expect(summary.events).toHaveLength(3);
    });
  });

  describe('CLISubscriber.handle binding', () => {
    it('maintains this context when passed directly to subscribe()', () => {
      // This test verifies that passing cliSubscriber.handle directly
      // to emitter.subscribe() works correctly - the handle method must
      // retain access to this.writer and this.handleXxx methods.
      const emitter = new ExecutionEventEmitter('wf-test', {
        source: 'project',
        path: 'test.runbook.md',
      });
      const output: string[] = [];
      const mockWriter = {
        writeLine: (text?: string) => {
          output.push(text ?? '');
        },
        write: (text: string) => {
          output.push(text);
        },
        writeLines: (lines: string[]) => {
          for (const l of lines) output.push(l);
        },
        writeError: (text: string) => {
          output.push(text);
        },
        writeJson: () => {
          /* no-op for test */
        },
      };
      const cliSubscriber = new CLISubscriber(mockWriter);

      // Pass handle directly as callback - this is how fail.ts uses it
      emitter.subscribe(cliSubscriber.handle);

      // If handle lost its this binding, this would throw
      // "Cannot read properties of undefined (reading 'handleRunbookStarted')"
      expect(() => {
        emitter.emit({
          type: 'RUNBOOK_STARTED',
          payload: {
            prompted: false,
            statePath: '.rundown/runs/wf-test.json',
          },
        });
      }).not.toThrow();

      // Verify output was written (proves this.writer was accessible)
      expect(output.length).toBeGreaterThan(0);
    });

    it('handles multiple event types when handle is passed as callback', () => {
      const emitter = new ExecutionEventEmitter('wf-test', {
        source: 'project',
        path: 'test.runbook.md',
      });
      const output: string[] = [];
      const mockWriter = {
        writeLine: (text?: string) => {
          output.push(text ?? '');
        },
        write: (text: string) => {
          output.push(text);
        },
        writeLines: (lines: string[]) => {
          for (const l of lines) output.push(l);
        },
        writeError: (text: string) => {
          output.push(text);
        },
        writeJson: () => {
          /* no-op for test */
        },
      };
      const cliSubscriber = new CLISubscriber(mockWriter);

      emitter.subscribe(cliSubscriber.handle);

      // Emit various events - each calls different this.handleXxx methods
      emitter.emit({
        type: 'RUNBOOK_STARTED',
        payload: {
          prompted: false,
          statePath: '.rundown/runs/wf-test.json',
        },
      });
      emitter.emit({
        type: 'STEP_ENTERED',
        payload: {
          position: { current: '1', total: 2 },
          stepName: '1',
          description: 'Test step',
          hasCommand: true,
          isSubstep: false,
          prompted: false,
          artifacts: {},
        },
      });
      emitter.emit({
        type: 'COMMAND_STARTED',
        payload: {
          command: 'echo test',
          displayCommand: 'echo test',
          position: { current: '1', total: 2 },
        },
      });
      emitter.emit({
        type: 'RUNBOOK_COMPLETED',
        payload: {
          finalPosition: { current: '2', total: 2 },
          message: 'Done',
        },
      });

      // If any handler lost this context, we would have thrown
      // Verify all events were processed by checking output was written
      expect(output.length).toBeGreaterThan(0);
    });
  });
});
