/**
 * Shared helper for creating bridged execution event emitters.
 *
 * This module provides a factory function for creating ExecutionEventEmitter
 * instances that bridge events to the unified OutputEmitter system.
 *
 * @module helpers/execution-emitter
 */

import { ExecutionEventEmitter, type RunbookState } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Create an event emitter for a runbook execution and bridge to OutputEmitter.
 *
 * This factory function creates an ExecutionEventEmitter that automatically
 * forwards all execution events to the unified output system, enabling both
 * text and JSON renderers to handle runbook execution events consistently.
 *
 * @param runbookState - The runbook state to create the emitter for
 * @param output - The OutputEmitter to bridge events to
 * @returns The ExecutionEventEmitter configured with event bridging
 *
 * @example
 * ```typescript
 * const emitter = createBridgedEmitter(state, output);
 * await runExecutionLoop(manager, state.id, steps, cwd, prompted, emitter, agent);
 * ```
 */
export function createBridgedEmitter(
  runbookState: RunbookState,
  output: OutputEmitter,
): ExecutionEventEmitter {
  const emitter = new ExecutionEventEmitter(runbookState.id, {
    name: runbookState.runbook,
    path: runbookState.runbookPath,
  });

  // Bridge execution events to the unified output system
  emitter.subscribe((event) => {
    output.executionEvent(event);
  });

  return emitter;
}
