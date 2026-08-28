/**
 * Testing re-export of the internal {@link RunbookStore}.
 *
 * `RunbookStore` is deliberately absent from the public barrel — production
 * consumers reach persistence through `RunbookStateManager` and the service
 * seams. Concurrency witnesses, however, need the class itself:
 * `RunbookStore.prototype.captureRunAuthorityState` is the exact
 * capture-before-lease-acquisition boundary where a genuine concurrent writer
 * can be landed (see `effectful-actor-mutation-runner.test.ts` in this package
 * and the cli #849 regression witness), and spying on it requires the one
 * module instance production code loads.
 *
 * This entry resolves to that same module in both consumers: the cli jest
 * config maps `@rundown-org/core/testing/runbook-store` onto this source file,
 * whose relative import of `runbook-store.js` is the identical resolved path
 * `@rundown-org/core` itself imports, so a prototype spy installed through
 * this entry reaches the store instances the CLI constructs. Out-of-package
 * tests previously deep-imported `core/src/...` relatively, which broke both
 * `tsc --noEmit` (TS6059 rootDir) and the Stryker sandbox copy.
 */
export { RunbookStore } from '../runbook/storage/runbook-store.js';
