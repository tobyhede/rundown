export type * from './types.js';
export * from './emitter.js';
export * from './transition-observation.js';
// Named exports, not a wildcard. `execution-observation.ts` also declares the entry
// seam's internals — `StepEntryMetadata`, `StepEntryObservationInput`, and
// `deriveStepEnteredEffect` — and a wildcard put all three on
// `@rundown-org/core` without any file naming them. That matters because #820
// deleted the deriver's two cursor-mismatch guards on the grounds that the entry
// has exactly ONE producer, `deriveExecutionUnitEntry`, which reads the cursor
// and the snapshot off the same `RunbookState`. A front end that could reach the
// deriver with a hand-built entry is precisely the bug class those guards
// caught. `packages/core/__tests__/events/entry-seam-barrel.test.ts` and its
// `.typecheck.ts` sibling pin both halves of this list.
export {
  commandCompletedEffect,
  commandStartedEffect,
  createExecutionEffectCollector,
  policyDeniedEffect,
  projectDelegateFrontier,
} from './execution-observation.js';
export type {
  CommandStartedObservationInput,
  ExecutionEffectCollector,
  ExecutionObservationEffect,
  ExecutionObservationEvent,
  MachineExecutionObserver,
} from './execution-observation.js';
export * from './subscribers/index.js';
