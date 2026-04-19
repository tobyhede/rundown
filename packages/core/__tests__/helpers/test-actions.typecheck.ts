/**
 * Compile-time contract tests for {@link withActionOverrides}.
 *
 * This file is intentionally NOT a `.test.ts` file. `tsconfig.test.json`
 * inherits `exclude: ["**\/*.test.ts"]` from the parent, so Jest test files
 * are invisible to tsc. By parking these checks in a plain `.ts` companion,
 * the `@ts-expect-error` directives below are evaluated on every run of
 * `npm run check:types`.
 *
 * Each block exercises one compile-time guarantee. A missing error on a
 * directive line produces `Unused '@ts-expect-error' directive` — which is
 * itself a compile error, so regressions fail the build.
 *
 * This file has no runtime effect.
 */

import { withActionOverrides } from './test-actions.js';

// Rejects unknown override keys.
withActionOverrides({
  // @ts-expect-error - "notAnAction" is not a key of RunbookActionImpls
  notAnAction: () => {
    /* stub */
  },
});

// Rejects overrides with the wrong params shape.
withActionOverrides({
  // @ts-expect-error - `setLastAction` params require { action, msg? }; `wrongField` is not part of that shape.
  setLastAction: (_, params: { wrongField: string }) => {
    void params.wrongField;
  },
});

// Accepts a correctly typed override — `params` must infer to { action, msg? }.
withActionOverrides({
  setLastAction: (_, params) => {
    void params.action;
    void params.msg;
  },
});
