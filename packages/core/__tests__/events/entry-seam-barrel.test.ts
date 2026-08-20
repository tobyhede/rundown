import { describe, it, expect } from '@jest/globals';
import * as coreBarrel from '../../src/index.js';
import * as eventsBarrel from '../../src/events/index.js';
import * as runbookBarrel from '../../src/runbook/index.js';

/**
 * What `@rundown-org/core` may NOT hand a front end.
 *
 * `RunbookActorService.enterExecutionUnit` is the single seam for entering an
 * execution unit, and two invariants rest on it having exactly one producer
 * downstream:
 *
 * - `deriveStepEnteredEffect` used to carry two cursor-mismatch guards, refusing
 *   an entry whose `stepId` / `substepId` disagreed with the snapshot. #820
 *   deleted them on the grounds that the entry now has ONE producer, which reads
 *   the cursor and the snapshot off the same `RunbookState`. That reasoning only
 *   holds while the deriver — and the metadata shapes it consumes — cannot be
 *   reached from outside core with a hand-built entry.
 * - `RenderedUnitCommand` is minted by a module-private `declare const` unique
 *   symbol, so the ONLY way to produce one outside its module is a type
 *   assertion. ESLint bans the assertion forms; not exporting the NAME is what
 *   makes them unwritable in the first place, because a caller that cannot name
 *   the type cannot assert to it, alias it, or reach it through a namespace
 *   import.
 *
 * A wildcard `export *` re-export puts every one of these on the public surface
 * without any file naming them, which is how they got there. This suite is the
 * gate: the runtime half below, and the compile-time half for the type-only
 * names in `entry-seam-barrel.typecheck.ts`.
 */
describe('core public surface — entry-seam internals', () => {
  it.each([
    { barrel: 'src/index.js', mod: coreBarrel },
    { barrel: 'src/events/index.js', mod: eventsBarrel },
  ])('keeps deriveStepEnteredEffect off $barrel', ({ mod }) => {
    expect(Object.hasOwn(mod, 'deriveStepEnteredEffect')).toBe(false);
  });

  // The negative above is only meaningful if this barrel really is the surface
  // it claims to be, so pin a symbol from the same module that IS public. Without
  // it, a barrel that exported nothing at all would pass.
  it.each([
    { barrel: 'src/index.js', mod: coreBarrel },
    { barrel: 'src/events/index.js', mod: eventsBarrel },
  ])('still re-exports the public observation helpers from $barrel', ({ mod }) => {
    expect(Object.hasOwn(mod, 'projectDelegateFrontier')).toBe(true);
    expect(Object.hasOwn(mod, 'createExecutionEffectCollector')).toBe(true);
  });

  // `deriveExecutionUnitEntry` stays exported deliberately — front-end test
  // doubles stand in for the service and must not re-implement its rendering,
  // and an ESLint no-restricted-imports boundary keeps every front end's `src/**`
  // off it. Pinned so narrowing the barrel above cannot take it out by accident.
  it('keeps deriveExecutionUnitEntry exported for test doubles', () => {
    expect(Object.hasOwn(runbookBarrel, 'deriveExecutionUnitEntry')).toBe(true);
    expect(Object.hasOwn(coreBarrel, 'deriveExecutionUnitEntry')).toBe(true);
  });
});
