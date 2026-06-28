# Follow-up: full `delegate` migration behind the lifecycle command seam

> **Status:** captured follow-up (review / verify / refactor-if-required).
> Raised during execution of
> `docs/superpowers/plans/2026-06-28-core-lifecycle-command-seam.md`.

## Decision taken

For this cycle, `rd delegate` is migrated to the lifecycle command seam as a
**transitional policy precheck only** (the seam owns evidence → actor context →
`resolveCommandIntent` issuance gate and the `DELEGATION_COLLECTION_PENDING`
refusal rendering). The CLI (`packages/cli/src/commands/delegate.ts`) retains:

- target inference (`inferRunbookFromStep`, `inferDelegationTarget`,
  `deriveDelegateFrontier`, `resolveDelegateTarget`);
- child runbook + variable resolution;
- the `createDelegation` call;
- persistence (`manager.update(..., { substepStates })`);
- `--retry` (`retryDelegation`) resolution and execution.

This satisfies the plan's allowance for a short-lived transitional precheck. It
is **not** a full delegate migration.

## Follow-up to review / verify / refactor

Per the side-effect categorisation in `CLAUDE.md`, command execution and
delegation issuance are machine-owned (Category B/C) operations. Leaving
inference + `createDelegation` + persistence in the CLI is interim architectural
debt: the CLI is meant to be a thin wrapper that dispatches into core APIs.

A follow-up cycle should evaluate moving the **full bare delegate operation**
behind the seam:

- resolve the active target in core;
- map caller evidence to `ActorContext` in core;
- run delegation-issuance policy in core;
- resolve child runbook + variables (the filesystem/runbook-ref resolution is
  Category B — pure-ish runbook logic — and should sit in core, with the CLI
  passing only raw `--input*` and the requested runbook arg);
- call `createDelegation` in core;
- persist parent/child state changes through core-managed services;
- return typed output data (`delegated` / `already-delegated` / refusal,
  `token`, `token_hash`, `parent_run_id`) for the CLI renderer.

### Verification checklist for the follow-up

- [ ] Confirm the transitional precheck does not create or persist a delegation
      by itself (it is gate-only).
- [ ] Confirm no behavioural drift in `delegate.test.ts`,
      `delegate-workflow`, `delegation-claim`, `delegation-propagation`,
      `report-then-collect`, and `collection-pending-lifecycle` coverage.
- [ ] Decide whether child-runbook path/variable resolution is Category A
      (CLI filesystem) or Category B (core runbook logic); place it accordingly.
- [ ] Once migrated, retire the CLI inline inference/persistence and rename the
      Task 6 commit framing from "policy precheck" to a full migration.
