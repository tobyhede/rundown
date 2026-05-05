/**
 * Shared helper for creating bridged execution event emitters.
 *
 * This module provides a factory function for creating ExecutionEventEmitter
 * instances that bridge events to the unified OutputEmitter system.
 *
 * @module helpers/execution-emitter
 */

import {
  ExecutionEventEmitter,
  RunbookRefSchema,
  type RunbookRef,
  type RunbookState,
} from '@rundown-org/core';
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
 * @param runbookRef - Optional canonical runbook reference derived at preparation time
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
  runbookRef?: RunbookRef,
): ExecutionEventEmitter {
  const emitter = new ExecutionEventEmitter(
    runbookState.id,
    resolveRunbookRef(runbookState, runbookRef),
  );

  // Bridge execution events to the unified output system
  emitter.subscribe((event) => {
    output.executionEvent(event);
  });

  return emitter;
}

function resolveRunbookRef(runbookState: RunbookState, runbookRef?: RunbookRef): RunbookRef {
  return runbookRef
    ? RunbookRefSchema.parse(runbookRef)
    : runbookState.runbookRef
      ? RunbookRefSchema.parse(runbookState.runbookRef)
      : createFallbackProjectRunbookRef(runbookState);
}

function createFallbackProjectRunbookRef(runbookState: RunbookState): RunbookRef {
  for (const candidate of [runbookState.runbookPath, runbookState.runbook]) {
    const ref = {
      source: 'project' as const,
      path: toCanonicalRunbookRefPath(candidate),
    };
    const result = RunbookRefSchema.safeParse(ref);
    if (result.success) {
      return result.data;
    }
  }

  return RunbookRefSchema.parse({
    source: 'project',
    path: toCanonicalRunbookRefPath(runbookState.runbookPath),
  });
}

function toCanonicalRunbookRefPath(value: string): string {
  const normalized = value.startsWith('./') ? value.slice(2) : value;
  if (normalized.endsWith('.runbook.md')) {
    return normalized;
  }
  if (normalized.endsWith('.md')) {
    return `${normalized.slice(0, -'.md'.length)}.runbook.md`;
  }
  return normalized;
}
