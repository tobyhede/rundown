# Brand-cast forgery fixtures

Every file here is a deliberate violation of
`local/no-rendered-unit-command-cast`
(`eslint-rules/no-rendered-unit-command-cast.mjs`), plus one negative control
that must stay clean. `scripts/__tests__/eslint-brand-cast-guard.test.mjs` lints
the directory through the real `eslint.config.js` and asserts which ones the
rule flags.

They are real, committed `.ts` files rather than string literals in the test
because the rule is type-aware: it resolves the asserted-to type through the
TypeScript checker, so the file has to be a member of `tsconfig.eslint.json`'s
program with the bytes ESLint reports on and the bytes TypeScript parsed being
the same bytes. `packages/core/__tests__/**/*.ts` is in that program, and the
relative import below reaches the REAL brand declaration, so the checker
resolves the same symbol a production cast would name.

Three properties of this location are load-bearing, and all three are asserted
by the test rather than left to comment:

- The directory is listed in `eslint.ignores.js`, so an ordinary
  `pnpm run check:lint:typed` and an editor's ESLint watcher skip it. Without
  that, ten deliberate violations would fail the repository lint gate forever.
  The test re-includes them with `new ESLint({ ignore: false })`, which changes
  file SELECTION only — the rule configuration these files resolve is untouched.
- It is outside `packages/core/src`, so it is outside `tsconfig.json`'s build
  `include` (never emitted to `dist`) and outside the Stryker `mutate` glob
  (never planned as a mutation scope by `scripts/mutation-shard-plan.mjs`).
- It is inside `tsconfig.test.json`'s `include`, so `check:types` type-checks
  it. That is deliberate: every forgery below is legal TypeScript, which is
  precisely why a lint rule and not the compiler has to be the thing that stops
  it.

Adding a file here without referencing it from the test is a hard failure — the
test asserts the directory listing and its own case list are the same set.
