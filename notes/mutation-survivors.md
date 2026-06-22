# Mutation Survivors: Artifact Resolver, Coalescing, and Update-Op Dispatch

Date: 2026-05-08

Command (run from `packages/core`):

```bash
npx stryker run --inPlace --force --mutate src/runbook/artifact-manifest.ts:193-213,src/runbook/artifact-directive-resolver.ts:75-181,src/runbook/state-update-ops.ts,src/runbook/state.ts:422-440 --testFiles __tests__/runbook/artifact-manifest.test.ts,__tests__/runbook/artifact-directive-resolver.test.ts,__tests__/runbook/state-update-ops.test.ts,__tests__/runbook/state.test.ts
```

Report (paths relative to repo root; written by Stryker into
`packages/core/reports/mutation/`):

- `packages/core/reports/mutation/mutation-report.json`
- `packages/core/reports/mutation/index.html`

Targeted range result:

- `src/runbook/artifact-manifest.ts:193-213`: 14 killed, 0 survived
- `src/runbook/artifact-directive-resolver.ts:75-181`: 63 killed, 6 survived
- `src/runbook/state-update-ops.ts`: 15 killed, 0 survived (full file)
- `src/runbook/state.ts:422-440` (`update()` dispatch): 20 killed, 0 survived

Remaining justified survivors:

- `artifact-directive-resolver.ts:102` (`exacts.length > 0`), mutants 12, 13,
  14, 15. This branch controls whether wildcard resolution rereads the manifest
  after exact declarations have run. Under the resolver's deterministic public
  contract, both branches produce the same wildcard record set:
  `recordsForExacts` is updated after every exact declaration, and when there
  are no exact declarations there is no internal manifest-changing operation
  between the initial read and wildcard resolution. The reread exists to
  preserve a fresh disk view after exact writes, including best-effort
  observation of external concurrent manifest changes. That concurrency timing
  is not injectable through `resolveArtifactDeclarations`, so these mutants are
  equivalent for deterministic unit tests.

- `artifact-directive-resolver.ts:152`
  (`record.contextId === options.contextId`), mutant 37.
  `findExistingExactRecord()` receives records read through
  `readArtifactManifest(options, options.contextId)`, and that reader rejects
  any manifest row whose `contextId` differs from the requested manifest
  context. Exact records created inside the same resolver call also use
  `options.contextId`. A wrong-context row cannot reach this predicate through
  the exported resolver API. The remaining exact identity fields (`runId`,
  `runbook.source`, `runbook.path`, and `key`) are covered by targeted
  near-match tests.

- `artifact-directive-resolver.ts:169`
  (`record.contextId !== options.contextId`), mutant 54. Wildcard records come
  from the same context-scoped manifest reader, or from exact records created in
  the current context. A wrong-context row cannot reach this loop through the
  exported resolver API because the manifest reader rejects it earlier. The
  matcher half of this guard is covered by the same-context nonmatching-key
  test.
