# Unified Claim Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace readable run/claim identifiers as mutation authority with one bearer `claim_id` primitive that verifies a secret and authorizes mutations through explicit grants.

**Architecture:** Core owns claim bearer parsing, secret hashing, persisted claim proofs, grant construction, and authorization decisions. CLI, MCP, and plugin surfaces pass claim evidence to core and never construct trusted actor context directly. Persisted session state stores lookup keys, secret hashes, grants, timestamps, and linkage data, never the full reusable bearer `claim_id`.

**Tech Stack:** TypeScript, Node `crypto`, XState-backed `@rundown-org/core` services, Zod schemas, Commander CLI, Jest integration/unit tests, Markdown docs.

---

## Scope Decision

Use one coherent plan for issue #574 because the security property crosses the same authority boundary in every package:

- Core claim primitives and session schema must change before CLI/API flags can safely use `--claim-id` as a bearer credential.
- `rundown run` and `rundown claim` both issue the same public authority primitive, so splitting them risks two incompatible claim encodings.
- Mutating commands, docs, CLI output schemas, MCP, and plugin command builders must agree that `run_id` is an identifier and `claim_id` is the only mutation authority.

This plan intentionally does not implement the superseded `runCapability` / `claim_capability` design.

## Claim Encoding Decision

Use one opaque public `claim_id` string with a non-secret lookup key and a secret segment:

```text
rdclm_<32 lowercase hex lookup key>_<43 base64url secret>
```

Persist only:

- `claimKey`: `rdclk_<32 lowercase hex lookup key>`
- `secretHash`: `sha256:<64 lowercase hex chars>`
- `grants`: explicit grant data
- timestamps and relationship data needed to validate target linkage

The `claim_id` returned to the caller is a bearer credential. It is never written to `.rundown/session.json`, `.rundown/runs/*.json`, status output, docs examples of persisted state, or error details.

## Grant Model

Initial grants:

```typescript
export interface DelegationClaimLinkage {
  readonly childRunId: RunId;
  readonly tokenHash: DelegationTokenHash;
  readonly parentRunId: RunId;
  readonly parentStepId: string;
  readonly parentStep: string;
  readonly parentFrameKey: FrameKey;
  readonly parentEntry: number;
}

export type ClaimGrant =
  | { readonly action: 'mutate-run'; readonly runId: RunId }
  | { readonly action: 'delegate-from-run'; readonly runId: RunId }
  | { readonly action: 'collect-for-run'; readonly runId: RunId }
  | { readonly action: 'abort-delegation'; readonly runId: RunId; readonly stepId?: string }
  | { readonly action: 'retry-delegation'; readonly runId: RunId; readonly stepId?: string }
  | ({ readonly action: 'report-delegation-result' } & DelegationClaimLinkage);

export type ClaimAuthorizationRequest =
  | { readonly action: 'mutate-run'; readonly runId: RunId }
  | { readonly action: 'delegate-from-run'; readonly runId: RunId }
  | { readonly action: 'collect-for-run'; readonly runId: RunId }
  | { readonly action: 'abort-delegation'; readonly runId: RunId; readonly stepId: string }
  | { readonly action: 'retry-delegation'; readonly runId: RunId; readonly stepId: string }
  | ({ readonly action: 'report-delegation-result' } & DelegationClaimLinkage);
```

There is no `ClaimRecord.kind` policy branch. A claim has a grant or it does not.

`DelegationClaimLinkage` deliberately preserves parity with the current delegated
claim record fields:
`childRunId`, `parentRunId`, `parentStepId`, `parentStep`, `parentFrameKey`,
`parentEntry`, and `tokenHash`. The grant model changes how authority is proven
and checked; it does not redesign delegation relationship storage.

## Authority Resolution Decision

Bare mutation is not a separate direct-CLI authority lane, and core must not scan
persisted claim records to infer a secret bearer from non-secret lookup keys.
There is one narrow default context: a non-delegated runbook with no delegation
activity may treat an omitted `--claim-id` as the orchestrator claim minted by
`rundown run`. In that state only one claim can exist for the run, and no child
or sibling process authority boundary has been introduced.

For every mutating command:

1. If `--claim-id` is present, core parses and verifies that bearer claim.
2. If `--claim-id` is omitted and the target run has no delegation activity,
   core may use the default orchestrator context for that same run.
3. If `--claim-id` is omitted and delegation state exists, the target is a
   claimed child, or the operation is delegation/recovery/collection specific,
   core refuses with `ACTOR_CONTEXT_REQUIRED` and asks for `--claim-id`.

The CLI must not verify claim secrets or construct `VerifiedClaim` values. CLI,
MCP, and plugin surfaces pass bearer claim evidence to core; core resolves,
verifies, and authorizes in one shared path.

## File Structure

Core claim primitives:

- Modify `packages/core/src/runbook/claim-id.ts`: replace readable claim id generation with bearer `claim_id` generation/parsing, secret hashing, constant-time verification, `ClaimLookupKey`, `ClaimSecretHash`, `DelegationClaimLinkage`, `ClaimGrant`, `ClaimAuthorizationRequest`, `ClaimRecord`, `VerifiedClaim`, and grant constructors.
- Modify `packages/core/src/runbook/index.ts`: export new claim types and helpers.
- Modify `packages/core/src/schemas.ts`: validate claim lookup keys, hashes, grants, and session claim map keyed by lookup key. Remove the current `claimId` mirror requirement.
- Modify `packages/core/src/runbook/session-service.ts`: mint claims carrying run-control grants for `rundown run`, mint first-claim-only claims carrying child-run/report grants for `rundown claim`, verify bearer claims, support the default orchestrator context for non-delegated runs, and resolve active targets from verified grants.
- Modify `packages/core/src/runbook/actor-context.ts`: replace trusted `run_controller` and shape-only `claim` evidence with core-resolved verified claim evidence.
- Modify `packages/core/src/runbook/command-policy.ts`: replace role-derived authority checks with `authorize(VerifiedClaim, ClaimAuthorizationRequest)` grant checks.
- Modify `packages/core/src/runbook/command-target-resolver.ts`: resolve command targets by verified claim and refuse identifier-only mutation authority.
- Modify `packages/core/src/runbook/lifecycle-command-service.ts`: require verified claim authorization for pass/fail, complete/stop, goto, delegate/retry, and collection seams.
- Modify `packages/core/src/runbook/collection-service.ts`: authorize collection through `collect-for-run`.
- Create or extend a core abort/recovery seam under `packages/core/src/runbook/`: move abort/retry recovery policy out of CLI and authorize `abort-delegation` / `retry-delegation` grants in core.
- Modify `packages/core/src/runbook/subprocess-mutation-boundary.ts`: treat `--claim-id` as explicit bearer authority and keep bare/identifier-only mutation restrictions.

Core tests:

- Modify `packages/core/__tests__/runbook/delegation-schemas.test.ts`: new claim record schema, session map key validation, no persisted bearer value.
- Modify `packages/core/__tests__/runbook/session-service.test.ts`: claim issuance, token replay refusal, secret verification, session secrecy, linkage parity, and default orchestrator context constraints.
- Create `packages/core/__tests__/runbook/claim-id.test.ts`: bearer parsing, hashing, verification, grant constructors, grant authorization.
- Modify `packages/core/__tests__/runbook/actor-context.test.ts`: update caller-evidence tests for verified-claim evidence and remove run-controller authority expectations.
- Modify `packages/core/__tests__/runbook/command-target-resolver.test.ts`.
- Modify `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`.
- Add or modify core abort/recovery seam tests for `abort-delegation` and `retry-delegation` grant authorization.
- Modify `packages/core/__tests__/runbook/collection-service.test.ts`.
- Modify `packages/core/__tests__/runbook/subprocess-mutation-boundary.test.ts`.

CLI:

- Modify `packages/cli/src/helpers/claim-id-option.ts`: parse bearer claim IDs with the new pattern.
- Modify `packages/cli/src/helpers/run-option.ts`: stop exposing `--run` as mutation authority. Keep read-only parsing only where still needed.
- Modify `packages/cli/src/helpers/caller-evidence.ts`: pass bearer claim evidence only; do not verify claims or construct `VerifiedClaim` in CLI.
- Modify `packages/cli/src/helpers/runbook-pipeline.ts`: have `startRunbook` emit an initial `claim_id`; have `claimAndLaunch` return the delegated child bearer `claim_id`.
- Modify `packages/cli/src/helpers/transitions.ts`, `packages/cli/src/helpers/terminal-command.ts`, `packages/cli/src/helpers/goto-workflow.ts`, and `packages/cli/src/helpers/status.ts`: thread verified claim evidence instead of run-controller evidence.
- Modify `packages/cli/src/commands/run.ts`: return `claim_id` from JSON start output.
- Modify `packages/cli/src/commands/claim.ts`: continue returning `claim_id`, now as a bearer value.
- Modify `packages/cli/src/commands/pass.ts`, `packages/cli/src/commands/fail.ts`, `packages/cli/src/commands/goto.ts`, `packages/cli/src/commands/complete.ts`, `packages/cli/src/commands/stop.ts`, `packages/cli/src/commands/collect.ts`, `packages/cli/src/commands/delegate.ts`, `packages/cli/src/commands/stash.ts`, `packages/cli/src/commands/pop.ts`, and `packages/cli/src/commands/abort.ts`: remove mutating `--run` authority and require `--claim-id` for delegation-exposed mutations.

MCP and plugin:

- Modify `packages/mcp/src` command/tool definitions that currently pass `--run` or old claim identifiers for mutation.
- Modify `packages/claude-code-plugin/src` command builders and subprocess guards that mention `--run` as mutating authority.
- Modify plugin skills/runbooks that instruct agents to mutate with `--run <rd_...>`.

Docs:

- Modify `docs/spec/cli-output.md`: `rundown run` and `rundown claim` JSON include bearer `claim_id`; mutating examples use `--claim-id`; no `runCapability` / `claim_capability`.
- Modify `docs/reference/runtime.md`: persisted session example stores lookup key, hash, grants, and no reusable bearer.
- Modify `docs/reference/cli.md` and generated CLI help docs after command flag changes.
- Modify `docs/reference/mcp.md`: mutating MCP tools accept/pass bearer `claim_id` evidence rather than run identifiers.
- Modify `docs/internal/architecture.md`: replace actor-context role-authority language with verified-claim grant authorization.
- Modify `docs/internal/plugin-trust-model.md`: describe plugin subprocess mutation lanes as claim-authorized lanes that delegate verification to core.

## Task 1: Add Bearer Claim Primitive and Grant Authorization

**Files:**
- Modify: `packages/core/src/runbook/claim-id.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Create: `packages/core/__tests__/runbook/claim-id.test.ts`

- [ ] **Step 1: Write failing claim primitive tests**

Create `packages/core/__tests__/runbook/claim-id.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import {
  assertClaimBearer,
  claimKeyFromBearer,
  createDelegatedChildGrants,
  createRunControlGrants,
  generateClaimBearer,
  grantAllows,
  hashClaimSecret,
  parseClaimBearer,
  verifyClaimSecret,
} from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

describe('claim bearer credentials', () => {
  const parentRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const childRunId = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const tokenHash = assertDelegationTokenHash(`sha256:${'c'.repeat(64)}`);
  const linkage = {
    childRunId,
    tokenHash,
    parentRunId,
    parentStepId: '1.1',
    parentStep: 'Process item',
    parentFrameKey: buildFrameKey('1', 0),
    parentEntry: 1,
  };

  it('generates a bearer claim_id with a lookup key and secret segment', () => {
    const claimId = generateClaimBearer();

    expect(claimId).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
    expect(parseClaimBearer(claimId)).toEqual({
      claimId,
      claimKey: expect.stringMatching(/^rdclk_[a-f0-9]{32}$/),
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('derives the same non-secret lookup key from the bearer value', () => {
    const claimId = assertClaimBearer(
      'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    );

    expect(claimKeyFromBearer(claimId)).toBe('rdclk_11111111111111111111111111111111');
  });

  it('hashes and verifies only the secret segment using constant-time comparison', () => {
    const parsed = parseClaimBearer(generateClaimBearer());
    const secretHash = hashClaimSecret(parsed.secret);

    expect(secretHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyClaimSecret(parsed.secret, secretHash)).toBe(true);
    expect(verifyClaimSecret('wrong-secret', secretHash)).toBe(false);
  });

  it('creates explicit run-control grants for the started run', () => {
    expect(createRunControlGrants(parentRunId)).toEqual([
      { action: 'mutate-run', runId: parentRunId },
      { action: 'delegate-from-run', runId: parentRunId },
      { action: 'collect-for-run', runId: parentRunId },
      { action: 'abort-delegation', runId: parentRunId },
      { action: 'retry-delegation', runId: parentRunId },
    ]);
  });

  it('creates explicit delegated-child grants for the claimed child and parent report linkage', () => {
    expect(createDelegatedChildGrants({ linkage })).toEqual([
      { action: 'mutate-run', runId: childRunId },
      { action: 'report-delegation-result', ...linkage },
    ]);
  });

  it('authorizes by exact grant and target, not by claim kind', () => {
    const grants = createDelegatedChildGrants({ linkage });

    expect(grantAllows(grants[0], { action: 'mutate-run', runId: childRunId })).toBe(true);
    expect(grantAllows(grants[0], { action: 'mutate-run', runId: parentRunId })).toBe(false);
    expect(grantAllows(grants[1], {
      action: 'report-delegation-result',
      ...linkage,
    })).toBe(true);
    expect(grantAllows(grants[1], {
      action: 'report-delegation-result',
      ...linkage,
      tokenHash: assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`),
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- claim-id.test.ts
```

Expected: FAIL with missing exports such as `generateClaimBearer`, `parseClaimBearer`, and `ClaimGrant`.

- [ ] **Step 3: Implement claim bearer types and helpers**

Replace the top-level claim primitive section in `packages/core/src/runbook/claim-id.ts` with these exports, while preserving existing `ClaimRunbookResult` and `ClaimIdResolution` names for later steps to update:

All exported symbols introduced in this step must include TSDoc that follows the
repo standard: description, `@param` for each parameter, `@returns` for
non-void functions, and `@throws` for assertion helpers.

```typescript
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DelegationTokenHash } from './delegation-token.js';
import type { RunId } from './run-id.js';
import type { FrameKey } from './targeting.js';

declare const claimBearerBrand: unique symbol;
declare const claimLookupKeyBrand: unique symbol;
declare const claimSecretHashBrand: unique symbol;

/** Bearer credential printed as `claim_id` and accepted by `--claim-id`. */
export type ClaimId = string & { readonly [claimBearerBrand]: true };

/** Non-secret lookup key persisted in `.rundown/session.json`. */
export type ClaimLookupKey = string & { readonly [claimLookupKeyBrand]: true };

/** Hash of the secret segment of a claim bearer credential. */
export type ClaimSecretHash = string & { readonly [claimSecretHashBrand]: true };

/** Prefix for every public bearer claim id. */
export const CLAIM_ID_PREFIX = 'rdclm_';

/** Prefix for every persisted non-secret claim lookup key. */
export const CLAIM_LOOKUP_KEY_PREFIX = 'rdclk_';

/** Canonical public bearer claim id pattern. */
export const CLAIM_ID_PATTERN = /^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/;

/** Canonical persisted non-secret lookup key pattern. */
export const CLAIM_LOOKUP_KEY_PATTERN = /^rdclk_[a-f0-9]{32}$/;

/** Canonical claim secret hash pattern. */
export const CLAIM_SECRET_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Parsed components of a public bearer claim id. */
export interface ParsedClaimBearer {
  /** Original bearer value. */
  readonly claimId: ClaimId;
  /** Non-secret lookup key derived from the bearer. */
  readonly claimKey: ClaimLookupKey;
  /** Secret segment presented by the caller and never persisted. */
  readonly secret: string;
}

/** Explicit permission over one Rundown resource. */
export interface DelegationClaimLinkage {
  /** Claimed child runbook state id. */
  readonly childRunId: RunId;
  /** Hash of the delegation token that produced this child claim. */
  readonly tokenHash: DelegationTokenHash;
  /** Parent runbook state id that delegated the child. */
  readonly parentRunId: RunId;
  /** Parent step or substep id where the delegation originated. */
  readonly parentStepId: string;
  /** Parent step name at delegation time. */
  readonly parentStep: string;
  /** Parent execution frame key used for completion propagation. */
  readonly parentFrameKey: FrameKey;
  /** Parent entry counter used for completion propagation. */
  readonly parentEntry: number;
}

export type ClaimGrant =
  | { readonly action: 'mutate-run'; readonly runId: RunId }
  | { readonly action: 'delegate-from-run'; readonly runId: RunId }
  | { readonly action: 'collect-for-run'; readonly runId: RunId }
  | { readonly action: 'abort-delegation'; readonly runId: RunId; readonly stepId?: string }
  | { readonly action: 'retry-delegation'; readonly runId: RunId; readonly stepId?: string }
  | ({ readonly action: 'report-delegation-result' } & DelegationClaimLinkage);

/** Authorization request checked against a claim grant. */
export type ClaimAuthorizationRequest =
  | { readonly action: 'mutate-run'; readonly runId: RunId }
  | { readonly action: 'delegate-from-run'; readonly runId: RunId }
  | { readonly action: 'collect-for-run'; readonly runId: RunId }
  | { readonly action: 'abort-delegation'; readonly runId: RunId; readonly stepId: string }
  | { readonly action: 'retry-delegation'; readonly runId: RunId; readonly stepId: string }
  | ({ readonly action: 'report-delegation-result' } & DelegationClaimLinkage);

/** Persisted claim record stored in SessionData.claims. */
export interface ClaimRecord {
  /** Non-secret lookup key for this claim. */
  readonly claimKey: ClaimLookupKey;
  /** Hash of the bearer secret segment. */
  readonly secretHash: ClaimSecretHash;
  /** Run this claim can target for local run mutation. */
  readonly controlledRunId: RunId;
  /** Delegation relationship data, present only for claims created from delegation tokens. */
  readonly delegation?: DelegationClaimLinkage;
  /** Explicit permissions attached to this claim. */
  readonly grants: readonly ClaimGrant[];
  /** ISO timestamp when this claim was first created. */
  readonly issuedAt: string;
  /** ISO timestamp when this claim was last refreshed. */
  readonly updatedAt: string;
}

/** Claim record after bearer proof verification. */
export interface VerifiedClaim {
  /** Non-secret lookup key for this claim. */
  readonly claimKey: ClaimLookupKey;
  /** Run this verified claim can target for local run mutation. */
  readonly controlledRunId: RunId;
  /** Delegation relationship data, present only for claims created from delegation tokens. */
  readonly delegation?: DelegationClaimLinkage;
  /** Explicit permissions attached to this claim. */
  readonly grants: readonly ClaimGrant[];
}

export function isClaimId(value: unknown): value is ClaimId {
  return typeof value === 'string' && CLAIM_ID_PATTERN.test(value);
}

export function assertClaimBearer(value: string): ClaimId {
  if (!isClaimId(value)) {
    throw new Error(
      'Invalid claim id: expected rdclm_<32 lowercase hex lookup key>_<43 base64url characters>',
    );
  }
  return value;
}

export const assertClaimId = assertClaimBearer;

export function isClaimLookupKey(value: unknown): value is ClaimLookupKey {
  return typeof value === 'string' && CLAIM_LOOKUP_KEY_PATTERN.test(value);
}

export function assertClaimLookupKey(value: string): ClaimLookupKey {
  if (!isClaimLookupKey(value)) {
    throw new Error('Invalid claim lookup key: expected rdclk_<32 lowercase hex characters>');
  }
  return value;
}

export function assertClaimSecretHash(value: string): ClaimSecretHash {
  if (!CLAIM_SECRET_HASH_PATTERN.test(value)) {
    throw new Error('Invalid claim secret hash: expected sha256:<64 lowercase hex characters>');
  }
  return value as ClaimSecretHash;
}

export function parseClaimBearer(value: string): ParsedClaimBearer {
  const claimId = assertClaimBearer(value);
  const match = CLAIM_ID_PATTERN.exec(claimId);
  if (!match) {
    throw new Error('Invalid claim id');
  }
  const [, lookupBody, secret] = /^rdclm_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/.exec(claimId)!;
  return {
    claimId,
    claimKey: assertClaimLookupKey(`${CLAIM_LOOKUP_KEY_PREFIX}${lookupBody}`),
    secret,
  };
}

export function claimKeyFromBearer(value: ClaimId): ClaimLookupKey {
  return parseClaimBearer(value).claimKey;
}

export function generateClaimBearer(): ClaimId {
  const lookup = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return assertClaimBearer(`${CLAIM_ID_PREFIX}${lookup}_${secret}`);
}

export function hashClaimSecret(secret: string): ClaimSecretHash {
  return assertClaimSecretHash(`sha256:${createHash('sha256').update(secret).digest('hex')}`);
}

export function verifyClaimSecret(secret: string, expectedHash: ClaimSecretHash): boolean {
  const actual = Buffer.from(hashClaimSecret(secret).slice('sha256:'.length), 'hex');
  const expected = Buffer.from(expectedHash.slice('sha256:'.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createRunControlGrants(runId: RunId): readonly ClaimGrant[] {
  return [
    { action: 'mutate-run', runId },
    { action: 'delegate-from-run', runId },
    { action: 'collect-for-run', runId },
    { action: 'abort-delegation', runId },
    { action: 'retry-delegation', runId },
  ];
}

export function createDelegatedChildGrants(input: {
  readonly linkage: DelegationClaimLinkage;
}): readonly ClaimGrant[] {
  return [
    { action: 'mutate-run', runId: input.linkage.childRunId },
    {
      action: 'report-delegation-result',
      ...input.linkage,
    },
  ];
}

export function grantAllows(grant: ClaimGrant, request: ClaimAuthorizationRequest): boolean {
  switch (request.action) {
    case 'mutate-run':
    case 'delegate-from-run':
    case 'collect-for-run':
      return grant.action === request.action && grant.runId === request.runId;
    case 'abort-delegation':
    case 'retry-delegation':
      return (
        grant.action === request.action &&
        grant.runId === request.runId &&
        (grant.stepId === undefined || grant.stepId === request.stepId)
      );
    case 'report-delegation-result':
      return (
        grant.action === 'report-delegation-result' &&
        grant.childRunId === request.childRunId &&
        grant.parentRunId === request.parentRunId &&
        grant.parentStepId === request.parentStepId &&
        grant.parentStep === request.parentStep &&
        grant.parentFrameKey === request.parentFrameKey &&
        grant.parentEntry === request.parentEntry &&
        grant.tokenHash === request.tokenHash
      );
    default: {
      const _exhaustive: never = grant;
      return _exhaustive;
    }
  }
}

export function authorizeClaim(
  claim: VerifiedClaim,
  request: ClaimAuthorizationRequest,
): { readonly kind: 'allowed' } | { readonly kind: 'denied'; readonly reason: 'claim_grant_required' } {
  return claim.grants.some((grant) => grantAllows(grant, request))
    ? { kind: 'allowed' }
    : { kind: 'denied', reason: 'claim_grant_required' };
}
```

- [ ] **Step 4: Export new claim helpers**

In `packages/core/src/runbook/index.ts`, ensure the existing claim export still exports all public helpers:

```typescript
export * from './claim-id.js';
```

If it already exists, leave it unchanged.

- [ ] **Step 5: Run claim primitive tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- claim-id.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/claim-id.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/claim-id.test.ts
git commit -m "feat(core): add grant-based claim bearer primitive"
```

## Task 2: Update Session Claim Schema to Store Proofs and Grants

**Files:**
- Modify: `packages/core/src/schemas.ts`
- Modify: `packages/core/__tests__/runbook/delegation-schemas.test.ts`

- [ ] **Step 1: Replace claim schema tests**

In `packages/core/__tests__/runbook/delegation-schemas.test.ts`, replace the existing `ClaimRecordSchema` and `SessionDataSchema claims registry` tests with:

```typescript
describe('ClaimRecordSchema', () => {
  const validClaim = {
    claimKey: 'rdclk_11111111111111111111111111111111',
    secretHash: `sha256:${'a'.repeat(64)}`,
    controlledRunId: CHILD_RUN_ID,
    delegation: {
      childRunId: CHILD_RUN_ID,
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: 'Process item',
      parentFrameKey: buildFrameKey('1', 0),
      parentEntry: 1,
      tokenHash: `sha256:${'b'.repeat(64)}`,
    },
    grants: [
      { action: 'mutate-run', runId: CHILD_RUN_ID },
      {
        action: 'report-delegation-result',
        childRunId: CHILD_RUN_ID,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: 'Process item',
        parentFrameKey: buildFrameKey('1', 0),
        parentEntry: 1,
        tokenHash: `sha256:${'b'.repeat(64)}`,
      },
    ],
    issuedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:01.000Z',
  };

  it('accepts a complete proof-backed claim record with explicit grants', () => {
    expect(ClaimRecordSchema.safeParse(validClaim).success).toBe(true);
  });

  it('rejects persisted reusable bearer claim ids', () => {
    const result = ClaimRecordSchema.safeParse({
      ...validClaim,
      claimId: 'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    });

    expect(result.success).toBe(false);
  });

  it('rejects malformed lookup keys and secret hashes', () => {
    expect(ClaimRecordSchema.safeParse({ ...validClaim, claimKey: 'rdclm_plain' }).success).toBe(
      false,
    );
    expect(ClaimRecordSchema.safeParse({ ...validClaim, secretHash: 'sha256:not-hex' }).success).toBe(
      false,
    );
  });
});

describe('SessionDataSchema claims registry', () => {
  it('loads sessions without claims using an empty claims registry', () => {
    const result = SessionDataSchema.safeParse({ defaultStack: [PARENT_RUN_ID] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claims).toEqual({});
    }
  });

  it('rejects claim records whose map key differs from claimKey', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: [PARENT_RUN_ID],
      claims: {
        rdclk_11111111111111111111111111111111: {
          claimKey: 'rdclk_22222222222222222222222222222222',
          secretHash: `sha256:${'a'.repeat(64)}`,
          controlledRunId: CHILD_RUN_ID,
          grants: [{ action: 'mutate-run', runId: CHILD_RUN_ID }],
          issuedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:01.000Z',
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run schema tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- delegation-schemas.test.ts
```

Expected: FAIL because `ClaimRecordSchema` still expects `kind`, `claimId`, `childRunId`, and linkage fields.

- [ ] **Step 3: Update schema imports**

In `packages/core/src/schemas.ts`, change the claim import to include the new patterns:

```typescript
import {
  CLAIM_ID_PATTERN,
  CLAIM_LOOKUP_KEY_PATTERN,
  CLAIM_SECRET_HASH_PATTERN,
  type ClaimSecretHash,
  type DelegationClaimLinkage,
  type ClaimGrant,
  type ClaimId,
  type ClaimLookupKey,
  type ClaimRecord,
} from './runbook/claim-id.js';
```

- [ ] **Step 4: Replace claim schemas**

In `packages/core/src/schemas.ts`, replace `ClaimRecordSchema` and the claim section of `SessionDataSchema` with:

```typescript
export const ClaimLookupKeySchema = z
  .string()
  .regex(CLAIM_LOOKUP_KEY_PATTERN)
  .transform((value) => value as ClaimLookupKey);

export const ClaimSecretHashSchema = z
  .string()
  .regex(CLAIM_SECRET_HASH_PATTERN)
  .transform((value) => value as ClaimSecretHash);

const ReportDelegationResultGrantSchema = z
  .object({
    action: z.literal('report-delegation-result'),
    childRunId: RunIdSchema,
    tokenHash: DelegationTokenHashSchema,
    parentRunId: RunIdSchema,
    parentStepId: z.string().min(1),
    parentStep: z.string().min(1),
    parentFrameKey: FrameKeySchema,
    parentEntry: z.number().int().nonnegative(),
  })
  .strict();

const ClaimGrantSchema: z.ZodType<ClaimGrant> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mutate-run'), runId: RunIdSchema }),
  z.object({ action: z.literal('delegate-from-run'), runId: RunIdSchema }),
  z.object({ action: z.literal('collect-for-run'), runId: RunIdSchema }),
  z.object({ action: z.literal('abort-delegation'), runId: RunIdSchema, stepId: z.string().min(1).optional() }),
  z.object({ action: z.literal('retry-delegation'), runId: RunIdSchema, stepId: z.string().min(1).optional() }),
  ReportDelegationResultGrantSchema,
]);

const DelegationClaimLinkageSchema: z.ZodType<DelegationClaimLinkage> = z
  .object({
    childRunId: RunIdSchema,
    tokenHash: DelegationTokenHashSchema,
    parentRunId: RunIdSchema,
    parentStepId: z.string().min(1),
    parentStep: z.string().min(1),
    parentFrameKey: FrameKeySchema,
    parentEntry: z.number().int().nonnegative(),
  })
  .strict();

/** Zod schema for a persisted proof-backed claim record. */
export const ClaimRecordSchema: z.ZodType<ClaimRecord> = z
  .object({
    claimKey: ClaimLookupKeySchema,
    secretHash: ClaimSecretHashSchema,
    controlledRunId: RunIdSchema,
    delegation: DelegationClaimLinkageSchema.optional(),
    grants: z.array(ClaimGrantSchema).min(1),
    issuedAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

/** Zod schema for `.rundown/session.json`. */
export const SessionDataSchema = z
  .object({
    defaultStack: z.array(RunIdSchema).default([]),
    stashedRunbookId: RunIdSchema.optional(),
    claims: z.record(z.string(), ClaimRecordSchema).default({}),
  })
  .superRefine((session, ctx) => {
    for (const [claimKey, claim] of Object.entries(session.claims)) {
      if (!CLAIM_LOOKUP_KEY_PATTERN.test(claimKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', claimKey],
          message: 'claims key must be a canonical claim lookup key (rdclk_<32 lowercase hex characters>)',
        });
        continue;
      }

      if (claimKey !== claim.claimKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', claimKey, 'claimKey'],
          message: 'claims key must match claim.claimKey',
        });
      }
    }
  });
```

Also add `type ClaimSecretHash` to the claim import.

- [ ] **Step 5: Run schema tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- delegation-schemas.test.ts
```

Expected: PASS for schema tests. Other tests may still fail until session-service is migrated.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/__tests__/runbook/delegation-schemas.test.ts
git commit -m "feat(core): persist claim proofs and grants"
```

## Task 3: Migrate Session Service to Mint and Verify Claims

**Files:**
- Modify: `packages/core/src/runbook/session-service.ts`
- Modify: `packages/core/src/runbook/claim-id.ts`
- Modify: `packages/core/__tests__/runbook/session-service.test.ts`
- Modify: `packages/core/__tests__/runbook/claim-test-helpers.ts`

- [ ] **Step 1: Add failing session-service tests for run-control claim issuance and secrecy**

In `packages/core/__tests__/runbook/session-service.test.ts`, add:

```typescript
it('mints a claim with run-control grants without persisting the bearer claim_id', async () => {
  const manager = new RunbookStateManager(workspace);
  const sessionService = new SessionService(manager);
  const state = await manager.create('parent.runbook.md', makeRunbook(), { runId: PARENT_RUN_ID });

  const issued = await sessionService.issueRunControlClaim(state.id);
  const session = await manager.loadSession();

  expect(issued.claimId).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
  expect(Object.keys(session.claims)).toEqual([issued.claim.claimKey]);
  expect(JSON.stringify(session)).not.toContain(issued.claimId);
  expect(issued.claim.grants).toEqual([
    { action: 'mutate-run', runId: state.id },
    { action: 'delegate-from-run', runId: state.id },
    { action: 'collect-for-run', runId: state.id },
    { action: 'abort-delegation', runId: state.id },
    { action: 'retry-delegation', runId: state.id },
  ]);
});

it('verifies a bearer claim_id before returning a verified claim', async () => {
  const manager = new RunbookStateManager(workspace);
  const sessionService = new SessionService(manager);
  const state = await manager.create('parent.runbook.md', makeRunbook(), { runId: PARENT_RUN_ID });
  const issued = await sessionService.issueRunControlClaim(state.id);

  await expect(sessionService.verifyClaimId(issued.claimId)).resolves.toEqual({
    status: 'verified',
    claim: {
      claimKey: issued.claim.claimKey,
      controlledRunId: state.id,
      grants: issued.claim.grants,
    },
  });

  const tampered = issued.claimId.replace(/.$/, issued.claimId.endsWith('A') ? 'B' : 'A');
  await expect(sessionService.verifyClaimId(assertClaimId(tampered))).resolves.toEqual({
    status: 'invalid-secret',
    claimKey: issued.claim.claimKey,
  });
});
```

Before adding this test, inspect the existing top-level fixtures in `session-service.test.ts` and use the concrete workspace/runbook helpers already declared in that file. Do not introduce a second fixture style for this test.

- [ ] **Step 2: Add failing delegated claim issuance test**

In the same file, add:

```typescript
it('mints a claim with child mutation and parent report grants', async () => {
  const manager = new RunbookStateManager(workspace);
  const sessionService = new SessionService(manager);
  const persistedLinkage = linkageFor(PARENT_RUN_ID, 'b');
  await manager.create('parent.runbook.md', makeRunbook(), { runId: PARENT_RUN_ID });
  await manager.create('child.runbook.md', makeRunbook(), {
    runId: CHILD_RUN_ID,
    parentLinkage: persistedLinkage,
  });

  const result = await sessionService.claimRunbook(CHILD_RUN_ID, persistedLinkage);
  const claimed = assertClaimed(result);
  const expectedDelegation: DelegationClaimLinkage = {
    childRunId: CHILD_RUN_ID,
    tokenHash: persistedLinkage.tokenHash,
    parentRunId: persistedLinkage.parentRunId,
    parentStepId: persistedLinkage.parentStepId,
    parentStep: persistedLinkage.parentStep,
    parentFrameKey: persistedLinkage.parentFrameKey,
    parentEntry: persistedLinkage.parentEntry,
  };

  expect(claimed.claimId).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
  expect(claimed.claim.delegation).toEqual(expectedDelegation);
  expect(claimed.claim.grants).toEqual([
    { action: 'mutate-run', runId: CHILD_RUN_ID },
    { action: 'report-delegation-result', ...expectedDelegation },
  ]);

  const session = await manager.loadSession();
  expect(JSON.stringify(session)).not.toContain(claimed.claimId);
});
```

- [ ] **Step 3: Run session tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- session-service.test.ts
```

Expected: FAIL because `issueRunControlClaim`, `verifyClaimId`, and the new claim result shape do not exist yet.

- [ ] **Step 4: Add result types**

In `packages/core/src/runbook/claim-id.ts`, update claim result types:

```typescript
export type ClaimRunbookResult =
  | { readonly status: 'claimed'; readonly claimId: ClaimId; readonly claim: ClaimRecord }
  | { readonly status: 'already-claimed'; readonly childRunId: RunId; readonly claimKey: ClaimLookupKey }
  | { readonly status: 'missing-child'; readonly childRunId: RunId }
  | { readonly status: 'terminal-child'; readonly childRunId: RunId; readonly lifecycle: 'completed' | 'stopped' }
  | {
      readonly status: 'linkage-mismatch';
      readonly childRunId: RunId;
      readonly incoming: DelegationLinkage;
      readonly persisted: RunbookState['parentLinkage'];
    };

export type ClaimVerificationResult =
  | { readonly status: 'verified'; readonly claim: VerifiedClaim }
  | { readonly status: 'missing'; readonly claimKey: ClaimLookupKey }
  | { readonly status: 'invalid-secret'; readonly claimKey: ClaimLookupKey };

export type ClaimIdResolution =
  | { readonly status: 'claimed'; readonly claimId: ClaimId; readonly claim: VerifiedClaim; readonly record: ClaimRecord; readonly state: RunbookState }
  | { readonly status: 'missing'; readonly claimId: ClaimId }
  | { readonly status: 'invalid-secret'; readonly claimId: ClaimId }
  | { readonly status: 'stale'; readonly claim: VerifiedClaim; readonly reason: 'missing-state' }
  | { readonly status: 'terminal'; readonly claim: VerifiedClaim; readonly state: RunbookState; readonly lifecycle: 'completed' | 'stopped' }
  | { readonly status: 'unlinked'; readonly claim: VerifiedClaim; readonly reason: 'parent-missing' | 'parent-ended' | 'child-linkage-mismatch' | 'stashed' };
```

- [ ] **Step 5: Add claim record factories**

In `packages/core/src/runbook/claim-id.ts`, add:

```typescript
export function createClaimRecord(input: {
  readonly claimKey: ClaimLookupKey;
  readonly secretHash: ClaimSecretHash;
  readonly controlledRunId: RunId;
  readonly delegation?: DelegationClaimLinkage;
  readonly grants: readonly ClaimGrant[];
  readonly now: string;
}): ClaimRecord {
  return {
    claimKey: input.claimKey,
    secretHash: input.secretHash,
    controlledRunId: input.controlledRunId,
    ...(input.delegation ? { delegation: input.delegation } : {}),
    grants: input.grants,
    issuedAt: input.now,
    updatedAt: input.now,
  };
}

export function refreshedClaimRecord(record: ClaimRecord, now: string): ClaimRecord {
  return { ...record, updatedAt: now };
}
```

- [ ] **Step 6: Implement `issueRunControlClaim` and `verifyClaimId`**

In `packages/core/src/runbook/session-service.ts`, add methods to `SessionService`:

```typescript
async issueRunControlClaim(runId: RunId): Promise<{ readonly claimId: ClaimId; readonly claim: ClaimRecord }> {
  return this.withSessionLock(async () => {
    const now = new Date().toISOString();
    const parsed = parseClaimBearer(generateClaimBearer());
    const claim = createClaimRecord({
      claimKey: parsed.claimKey,
      secretHash: hashClaimSecret(parsed.secret),
      controlledRunId: runId,
      grants: createRunControlGrants(runId),
      now,
    });
    const session = await this.manager.loadSession();
    session.claims[claim.claimKey] = claim;
    await this.manager.saveSession(session);
    return { claimId: parsed.claimId, claim };
  });
}

async verifyClaimId(claimId: ClaimId): Promise<ClaimVerificationResult> {
  const parsed = parseClaimBearer(claimId);
  const session = await this.manager.loadSession();
  const record = session.claims[parsed.claimKey];
  if (!record) {
    return { status: 'missing', claimKey: parsed.claimKey };
  }
  if (!verifyClaimSecret(parsed.secret, record.secretHash)) {
    return { status: 'invalid-secret', claimKey: parsed.claimKey };
  }
      return {
        status: 'verified',
        claim: {
          claimKey: record.claimKey,
          controlledRunId: record.controlledRunId,
          ...(record.delegation ? { delegation: record.delegation } : {}),
          grants: record.grants,
        },
      };
}
```

Use the existing session lock helper name in this file. If the method is not named `withSessionLock`, place this logic inside the existing lock scope used by `claimRunbook`.

- [ ] **Step 7: Update `claimRunbook` to return bearer and persist only proof**

In `packages/core/src/runbook/session-service.ts`, replace new delegated claim creation with:

```typescript
const parsed = parseClaimBearer(generateClaimBearer());
const delegation: DelegationClaimLinkage = {
  childRunId,
  tokenHash: linkage.tokenHash,
  parentRunId: linkage.parentRunId,
  parentStepId: linkage.parentStepId,
  parentStep: linkage.parentStep,
  parentFrameKey: linkage.parentFrameKey,
  parentEntry: linkage.parentEntry,
};
const claim = createClaimRecord({
  claimKey: parsed.claimKey,
  secretHash: hashClaimSecret(parsed.secret),
  controlledRunId: childRunId,
  delegation,
  grants: createDelegatedChildGrants({ linkage: delegation }),
  now,
});
session.claims[claim.claimKey] = claim;
await this.manager.saveSession(session);
return { status: 'claimed', claimId: parsed.claimId, claim };
```

For an existing delegated child claim, do not mint or rotate a bearer from the
delegation token. The delegation token is pre-claim authority only; once a child
has claimed it, replaying `rundown claim <token>` must not produce fresh mutation
authority. Return a typed already-claimed refusal that includes only non-secret
diagnostics:

```typescript
return {
  status: 'already-claimed',
  childRunId: existing.controlledRunId,
  claimKey: existing.claimKey,
};
```

Recovery, retry, and re-delegation are authorized by existing claims with
`abort-delegation` / `retry-delegation` grants. They are not authorized by
reusing the original delegation token.

- [ ] **Step 8: Run session tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- session-service.test.ts
```

Expected: PASS for the new issuance/verification tests. Existing tests may need mechanical expectations updated from `claim.claimId` to `result.claimId` and from `claim.childRunId` to grant inspection.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runbook/claim-id.ts packages/core/src/runbook/session-service.ts packages/core/__tests__/runbook/session-service.test.ts packages/core/__tests__/runbook/claim-test-helpers.ts
git commit -m "feat(core): mint and verify grant claims in session service"
```

## Task 4: Replace Actor Role Authority With Verified Claim Authorization

**Files:**
- Modify: `packages/core/src/runbook/actor-context.ts`
- Modify: `packages/core/src/runbook/command-policy.ts`
- Modify: `packages/core/__tests__/runbook/command-policy.test.ts`

- [ ] **Step 1: Add failing command-policy tests for grant authorization**

In `packages/core/__tests__/runbook/command-policy.test.ts`, add:

```typescript
it('allows a mutation only when a verified claim has the exact grant', () => {
  const actorContext = verifiedClaimContext({
    claimId: 'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_' as ClaimId,
    claim: {
      claimKey: 'rdclk_11111111111111111111111111111111' as ClaimLookupKey,
      controlledRunId: parent.id,
      grants: [{ action: 'mutate-run', runId: parent.id }],
    },
  });

  expect(resolveCommandIntent({
    actorContext,
    intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
    targetSelector: { kind: 'claim', claimId: 'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_' as ClaimId },
    targetState: parent,
    openClaims: [],
  })).toMatchObject({ kind: 'allowed' });
});

it('denies a mutation when a verified claim has no matching grant', () => {
  const actorContext = verifiedClaimContext({
    claimId: 'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_' as ClaimId,
    claim: {
      claimKey: 'rdclk_11111111111111111111111111111111' as ClaimLookupKey,
      controlledRunId: child.id,
      grants: [{ action: 'mutate-run', runId: child.id }],
    },
  });

  expect(resolveCommandIntent({
    actorContext,
    intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
    targetSelector: { kind: 'claim', claimId: 'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_' as ClaimId },
    targetState: parent,
    openClaims: [],
  })).toEqual({
    kind: 'claim_grant_required',
    intent: 'delegating-run-advance',
    targetRunId: parent.id,
  });
});
```

- [ ] **Step 2: Run command-policy tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- command-policy.test.ts
```

Expected: FAIL because `verifiedClaimContext` and `claim_grant_required` do not exist.

- [ ] **Step 3: Replace actor context trusted variants**

In `packages/core/src/runbook/actor-context.ts`, replace `ActorContext` and `CallerEvidence` trusted variants with:

```typescript
import type { ClaimId, VerifiedClaim } from './claim-id.js';

export type ActorContext =
  | {
      readonly kind: 'verified_claim';
      readonly claimId: ClaimId;
      readonly claim: VerifiedClaim;
    }
  | { readonly kind: 'unknown' };

export const UNKNOWN_ACTOR_CONTEXT: ActorContext = { kind: 'unknown' };

export function verifiedClaimContext(input: {
  readonly claimId: ClaimId;
  readonly claim: VerifiedClaim;
}): ActorContext {
  return { kind: 'verified_claim', claimId: input.claimId, claim: input.claim };
}

export type CallerEvidence =
  | { readonly kind: 'claim_bearer'; readonly claimId: ClaimId }
  | { readonly kind: 'plugin'; readonly agentId?: string; readonly sessionId?: string }
  | { readonly kind: 'mcp'; readonly toolName?: string }
  | { readonly kind: 'unknown' };

export function actorContextFromEvidence(evidence: CallerEvidence): ActorContext {
  return UNKNOWN_ACTOR_CONTEXT;
}
```

Remove `trustedRunControllerContext`, `claimControllerContext`,
`deriveEffectiveRole`, and frontend-created verified-claim dependencies from
this file. Keep any exported compatibility functions only if tests still import
them, but make them return `UNKNOWN_ACTOR_CONTEXT` and mark them deprecated in
TSDoc for deletion in this branch.

Core command/lifecycle services will call the new authority resolver after target
resolution and then construct `verifiedClaimContext(...)` internally. Frontends
never construct `verified_claim` evidence.

- [ ] **Step 4: Update command policy outcome and grant checks**

In `packages/core/src/runbook/command-policy.ts`, add an outcome:

```typescript
| {
    readonly kind: 'claim_grant_required';
    readonly intent: CommandIntent['kind'];
    readonly targetRunId?: RunId;
  }
```

Add request derivation. Fresh delegation and retry are separate authorization
requests: retry must not require the generic `delegate-from-run` grant in
addition to `retry-delegation`.

First make the `CommandIntent` union explicit about retry carrying a concrete
step id before `requestForIntent` reads `intent.stepId`:

```typescript
type CommandIntent =
  | { readonly kind: 'delegating-run-advance'; readonly command: 'pass' | 'fail'; readonly targeted: boolean }
  | { readonly kind: 'terminal-run-force'; readonly command: 'complete' | 'stop'; readonly targeted: boolean }
  | { readonly kind: 'run-navigation'; readonly command: 'goto'; readonly targeted: boolean }
  | {
      readonly kind: 'delegation-issuance';
      readonly command: 'delegate';
      readonly targeted: boolean;
    }
  | {
      readonly kind: 'delegation-issuance';
      readonly command: 'retry';
      readonly targeted: true;
      readonly stepId: string;
    }
  | { readonly kind: 'delegation-collection' }
  | { readonly kind: 'inspect' };
```

```typescript
function requestForIntent(
  intent: CommandIntent,
  targetState: RunbookState | undefined,
): ClaimAuthorizationRequest | undefined {
  if (!targetState) return undefined;
  switch (intent.kind) {
    case 'delegating-run-advance':
    case 'terminal-run-force':
    case 'run-navigation':
      return { action: 'mutate-run', runId: targetState.id };
    case 'delegation-issuance':
      if (intent.command === 'delegate') {
        return { action: 'delegate-from-run', runId: targetState.id };
      }
      if (intent.command === 'retry') {
        return {
          action: 'retry-delegation',
          runId: targetState.id,
          stepId: intent.stepId,
        };
      }
      return undefined;
    case 'delegation-collection':
      return { action: 'collect-for-run', runId: targetState.id };
    case 'inspect':
      return undefined;
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}
```

Do not use this generic mapper for child-to-parent report propagation. The
propagation seam must build a `report-delegation-result` request from the
child's full `DelegationClaimLinkage` and authorize it separately before the
parent write.

At the top of `resolveCommandIntent`, before open-claims/collection guards, enforce:

```typescript
const request = requestForIntent(input.intent, input.targetState);
if (request !== undefined) {
  if (input.actorContext.kind !== 'verified_claim') {
    return { kind: 'actor_context_required', intent: input.intent.kind };
  }
  const decision = authorizeClaim(input.actorContext.claim, request);
  if (decision.kind === 'denied') {
    return {
      kind: 'claim_grant_required',
      intent: input.intent.kind,
      ...(input.targetState ? { targetRunId: input.targetState.id } : {}),
    };
  }
}
```

- [ ] **Step 5: Run command-policy tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- command-policy.test.ts
```

Expected: PASS after updating old assertions that expected role-derived outcomes to expect `allowed` or `denied` grant decisions.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/actor-context.ts packages/core/src/runbook/command-policy.ts packages/core/__tests__/runbook/command-policy.test.ts
git commit -m "feat(core): authorize commands with verified claim grants"
```

## Task 5: Resolve Command Targets From Verified Claims

**Files:**
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Modify: `packages/core/__tests__/runbook/command-target-resolver.test.ts`
- Modify: `packages/core/src/runbook/session-service.ts`

- [ ] **Step 1: Add failing target resolver tests for invalid bearer and grant mismatch**

In `packages/core/__tests__/runbook/command-target-resolver.test.ts`, add:

```typescript
it('refuses a claim id with an invalid secret', async () => {
  const result = await resolveCommandTarget(
    fakeReader({
      claimResolution: { status: 'invalid-secret', claimId },
      failOnDefaultRead: true,
    }),
    { claimId },
  );

  expect(result).toEqual({
    kind: 'stale_claim',
    claimId,
    message: `Claim id ${claimId} is not valid for this session.`,
  });
});

it('resolves a verified claim to the run named by its mutate-run grant', async () => {
  const verified = {
    claimKey: 'rdclk_11111111111111111111111111111111' as ClaimLookupKey,
    controlledRunId: child.id,
    grants: [{ action: 'mutate-run', runId: child.id }],
  };

  const result = await resolveCommandTarget(
    fakeReader({
      claimResolution: { status: 'claimed', claimId, claim: verified, record: makeRecord(verified), state: child },
      expectedIncludeStashed: false,
      failOnDefaultRead: true,
    }),
    { claimId },
  );

  expect(result).toEqual({ kind: 'claim', claimId, claim: verified, state: child });
});
```

- [ ] **Step 2: Add failing default orchestrator context tests**

In `packages/core/__tests__/runbook/command-target-resolver.test.ts`, add:

```typescript
it('uses the default orchestrator context for a non-delegated run', async () => {
  const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: parent.id };
  const orchestratorClaim: VerifiedClaim = {
    claimKey: 'rdclk_11111111111111111111111111111111' as ClaimLookupKey,
    controlledRunId: parent.id,
    grants: [{ action: 'mutate-run', runId: parent.id }],
  };

  const result = await resolveMutationAuthority({
    targetReader: fakeReader({
      defaultOrchestratorClaim: orchestratorClaim,
      hasDelegationActivity: false,
    }),
    targetState: parent,
    request,
  });

  expect(result).toEqual({
    kind: 'verified',
    authority: { kind: 'default_orchestrator', claimKey: orchestratorClaim.claimKey },
    claim: orchestratorClaim,
  });
});

it('refuses omitted claim authority once delegation activity exists', async () => {
  const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: parent.id };
  const orchestratorClaim: VerifiedClaim = {
    claimKey: 'rdclk_11111111111111111111111111111111' as ClaimLookupKey,
    controlledRunId: parent.id,
    grants: [{ action: 'mutate-run', runId: parent.id }],
  };

  const result = await resolveMutationAuthority({
    targetReader: fakeReader({
      defaultOrchestratorClaim: orchestratorClaim,
      hasDelegationActivity: true,
    }),
    targetState: parent,
    request,
  });

  expect(result).toEqual({ kind: 'refused', reason: 'claim-required' });
});
```

- [ ] **Step 3: Add shared mutation authority resolver**

In `packages/core/src/runbook/command-target-resolver.ts`, add a shared resolver
used by transition, terminal, delegation, collection, stash/pop, and abort
seams:

```typescript
export type MutationAuthorityResolution =
  | {
      readonly kind: 'verified';
      readonly authority:
        | { readonly kind: 'bearer'; readonly claimId: ClaimId; readonly claimKey: ClaimLookupKey }
        | { readonly kind: 'default_orchestrator'; readonly claimKey: ClaimLookupKey };
      readonly claim: VerifiedClaim;
    }
  | {
      readonly kind: 'refused';
      readonly reason: 'missing' | 'invalid-secret' | 'claim-required' | 'no-authorizing-claim';
    };

export async function resolveMutationAuthority(input: {
  readonly targetReader: TargetReader;
  readonly presentedClaimId?: ClaimId;
  readonly targetState: RunbookState;
  readonly request: ClaimAuthorizationRequest;
}): Promise<MutationAuthorityResolution> {
  if (input.presentedClaimId !== undefined) {
    const verified = await input.targetReader.verifyClaimId(input.presentedClaimId);
    if (verified.status !== 'verified') {
      return {
        kind: 'refused',
        reason: verified.status === 'invalid-secret' ? 'invalid-secret' : 'missing',
      };
    }
    return authorizeClaim(verified.claim, input.request).kind === 'allowed'
      ? {
          kind: 'verified',
          authority: {
            kind: 'bearer',
            claimId: input.presentedClaimId,
            claimKey: verified.claim.claimKey,
          },
          claim: verified.claim,
        }
      : { kind: 'refused', reason: 'no-authorizing-claim' };
  }

  if (await input.targetReader.hasDelegationActivity(input.targetState.id)) {
    return { kind: 'refused', reason: 'claim-required' };
  }
  const defaultClaim = await input.targetReader.getDefaultOrchestratorClaim(input.targetState.id);
  return defaultClaim !== undefined && authorizeClaim(defaultClaim, input.request).kind === 'allowed'
    ? {
        kind: 'verified',
        authority: { kind: 'default_orchestrator', claimKey: defaultClaim.claimKey },
        claim: defaultClaim,
      }
    : { kind: 'refused', reason: 'claim-required' };
}
```

`getDefaultOrchestratorClaim` returns only the run-control claim minted by
`rundown run` for the same non-delegated run. It must not scan arbitrary
persisted claims looking for a matching grant. Once the run has delegation
activity, omitted `--claim-id` is refused so sibling processes and delegated
children must present the bearer credential explicitly.

Add local helper:

```typescript
function makeRecord(claim: VerifiedClaim): ClaimRecord {
  return {
    claimKey: claim.claimKey,
    secretHash: `sha256:${'a'.repeat(64)}` as ClaimSecretHash,
    controlledRunId: claim.controlledRunId,
    ...(claim.delegation ? { delegation: claim.delegation } : {}),
    grants: claim.grants,
    issuedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}
```

- [ ] **Step 4: Run resolver tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- command-target-resolver.test.ts
```

Expected: FAIL because the resolver still treats claim records as plaintext child records and has no invalid-secret outcome.

- [ ] **Step 5: Update `getActiveForClaimId` to verify bearer before target resolution**

In `packages/core/src/runbook/session-service.ts`, change `getActiveForClaimId` to:

```typescript
async getActiveForClaimId(
  claimId: ClaimId,
  options: { readonly includeStashed?: boolean } = {},
): Promise<ClaimIdResolution> {
  const parsed = parseClaimBearer(claimId);
  const session = await this.manager.loadSession();
  const record = session.claims[parsed.claimKey];
  if (!record) {
    return { status: 'missing', claimId };
  }
  if (!verifyClaimSecret(parsed.secret, record.secretHash)) {
    return { status: 'invalid-secret', claimId };
  }

  const claim: VerifiedClaim = {
    claimKey: record.claimKey,
    controlledRunId: record.controlledRunId,
    ...(record.delegation ? { delegation: record.delegation } : {}),
    grants: record.grants,
  };
  const mutateGrant = record.grants.find(
    (grant): grant is Extract<ClaimGrant, { action: 'mutate-run' }> => grant.action === 'mutate-run',
  );
  if (!mutateGrant) {
    return { status: 'stale', claim, reason: 'missing-state' };
  }

  if (options.includeStashed !== true && session.stashedRunbookId === mutateGrant.runId) {
    return { status: 'unlinked', claim, reason: 'stashed' };
  }

  const state = await this.manager.load(mutateGrant.runId);
  if (!state) {
    return { status: 'stale', claim, reason: 'missing-state' };
  }
  if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
    return { status: 'terminal', claim, state, lifecycle: state.lifecycle };
  }
  return { status: 'claimed', claimId, claim, record, state };
}
```

Keep existing parent-linkage validation by deriving `report-delegation-result` grants when present:

```typescript
const reportGrant = record.grants.find(
  (grant): grant is Extract<ClaimGrant, { action: 'report-delegation-result' }> =>
    grant.action === 'report-delegation-result',
);
if (reportGrant !== undefined) {
  if (!linkageMatchesReportGrant(state.id, state.parentLinkage, reportGrant)) {
    return { status: 'unlinked', claim, reason: 'child-linkage-mismatch' };
  }
  const parent = await this.manager.load(reportGrant.parentRunId);
  if (!parent) return { status: 'unlinked', claim, reason: 'parent-missing' };
  if (parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
    return { status: 'unlinked', claim, reason: 'parent-ended' };
  }
}
```

Implement `linkageMatchesReportGrant` near the existing linkage helpers:

```typescript
function linkageMatchesReportGrant(
  childRunId: RunId,
  linkage: RunbookState['parentLinkage'],
  grant: Extract<ClaimGrant, { action: 'report-delegation-result' }>,
): boolean {
  return (
    linkage?.kind === 'delegation' &&
    childRunId === grant.childRunId &&
    linkage.parentRunId === grant.parentRunId &&
    linkage.parentStepId === grant.parentStepId &&
    linkage.parentStep === grant.parentStep &&
    linkage.parentFrameKey === grant.parentFrameKey &&
    linkage.parentEntry === grant.parentEntry &&
    linkage.tokenHash === grant.tokenHash
  );
}
```

- [ ] **Step 6: Remove run target authority from resolver options**

In `packages/core/src/runbook/command-target-resolver.ts`, keep `runId` only for read-only command target resolution if a caller still needs it, but remove `runId` from transition/terminal mutation paths. For `ResolveTransitionTargetOptions`, delete:

```typescript
readonly runId?: RunId;
```

For `TransitionTargetResolution`, delete the `run` and `unknown_run` variants. Update `resolveTransitionTarget` so only `claimId` and default paths remain. Default path must fail on delegation-exposed mutations unless `resolveMutationAuthority` has produced a verified claim from bearer evidence or the default orchestrator context for a non-delegated run.

- [ ] **Step 7: Run resolver tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- command-target-resolver.test.ts
```

Expected: PASS after updating old `--run` mutation tests to assert refusal or moving them to read-only command tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/runbook/session-service.ts packages/core/src/runbook/command-target-resolver.ts packages/core/__tests__/runbook/command-target-resolver.test.ts
git commit -m "feat(core): resolve command targets from verified claim bearers"
```

## Task 6: Thread Claim Grants Through Lifecycle, Collection, and Recovery Commands

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/collection-service.ts`
- Modify: `packages/core/src/runbook/subprocess-mutation-boundary.ts`
- Create or modify: `packages/core/src/runbook/abort-command-service.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify: `packages/core/__tests__/runbook/subprocess-mutation-boundary.test.ts`
- Create or modify: `packages/core/__tests__/runbook/abort-command-service.test.ts`

- [ ] **Step 1: Add failing lifecycle tests for `delegate-from-run` and `retry-delegation` grants**

In `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`, add
tests that call `RunbookLifecycleCommandService.issueDelegation` with bearer
claim evidence. Configure the service fixture's fake authority resolver/session
reader so core verifies `claimId` into the specified `VerifiedClaim`; do not
construct `verified_claim` caller evidence in the test input.

```typescript
it('allows delegation issuance only with delegate-from-run grant on the target run', async () => {
  const service = makeLifecycleService();
  service.authorityFixture.verifyAs({
    claimKey,
    controlledRunId: parentRunId,
    grants: [{ action: 'delegate-from-run', runId: parentRunId }],
  });

  const outcome = await service.issueDelegation({
    mode: 'fresh',
    callerEvidence: { kind: 'claim_bearer', claimId },
    explicitStep: '1.1',
    requestedRunbook: 'child.runbook.md',
  });

  expect(outcome.kind).toBe('delegated');
});

it('refuses delegation retry when the verified claim lacks retry-delegation', async () => {
  const service = makeLifecycleService();
  service.authorityFixture.verifyAs({
    claimKey,
    controlledRunId: parentRunId,
    grants: [{ action: 'mutate-run', runId: parentRunId }],
  });

  const outcome = await service.issueDelegation({
    mode: 'retry',
    callerEvidence: { kind: 'claim_bearer', claimId },
    locator: { kind: 'step', step: '1.1' },
  });

  expect(outcome).toMatchObject({ kind: 'refused', policy: { kind: 'claim_grant_required' } });
});
```

Use existing fixture factories in the file for `makeLifecycleService`, `claimId`, `claimKey`, and run ids. If the file has no such helpers, add local constants using `assertClaimId`, `assertClaimLookupKey`, and `assertRunId`.

- [ ] **Step 2: Add failing collection test for `collect-for-run` grant**

In `packages/core/__tests__/runbook/collection-service.test.ts`, add:

```typescript
it('refuses collection when the verified claim lacks collect-for-run on the target run', async () => {
  const service = makeCollectionService();
  const outcome = await service.collect({
    callerEvidence: { kind: 'claim_bearer', claimId },
    targetSelector: { kind: 'claim', claimId },
  });

  expect(outcome).toMatchObject({ kind: 'refused', policy: { kind: 'claim_grant_required' } });
});
```

- [ ] **Step 3: Run lifecycle and collection tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- lifecycle-command-service.test.ts collection-service.test.ts
```

Expected: FAIL because these seams still understand run-controller evidence and role outcomes.

- [ ] **Step 4: Update lifecycle seam inputs**

In `packages/core/src/runbook/lifecycle-command-service.ts`, remove `targetRunId?: RunId` from mutation inputs and replace policy calls with core-resolved claim authority. In `issueDelegation`, derive target state first, derive the exact authorization request, then call the shared authority resolver:

```typescript
const authority = await this.#resolveMutationAuthority({
  presentedClaimId:
    input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined,
  targetState,
  request,
});
if (authority.kind !== 'verified') return authority.refusal;

const policy = resolveCommandIntent({
  actorContext: verifiedClaimContext({
    claimId: authority.claimId,
    claim: authority.claim,
  }),
  intent: {
    kind: 'delegation-issuance',
    command: input.mode === 'retry' ? 'retry' : 'delegate',
    ...(input.mode === 'retry' ? { stepId: retryStepId } : {}),
    targeted: input.mode === 'retry' || input.explicitStep !== undefined,
  },
  targetSelector: input.targetSelector,
  targetState,
});
```

Do not add a fake claim id or a `claim-authority` target selector in production
code. Target selection remains separate from authority. The authority resolver
returns a verified claim; the existing target selector continues to describe
what is being mutated.

- [ ] **Step 5: Map recovery grants explicitly**

For retry flows in `packages/core/src/runbook/lifecycle-command-service.ts`,
derive the exact recovery request, resolve bearer evidence through core
authority resolution, and only then construct verified actor context for policy
checking:

```typescript
const request: ClaimAuthorizationRequest = {
  action: 'retry-delegation',
  runId: targetRunId,
  ...(stepId !== undefined ? { stepId } : {}),
};
const authority = await this.#resolveMutationAuthority({
  presentedClaimId:
    input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined,
  targetState,
  request,
});
if (authority.kind !== 'verified') {
  return authority.refusal;
}
const policy = resolveCommandIntent({
  actorContext: verifiedClaimContext({
    claimId: authority.claimId,
    claim: authority.claim,
  }),
  intent: {
    kind: 'delegation-issuance',
    command: 'retry',
    stepId,
    targeted: true,
  },
  targetSelector: input.targetSelector,
  targetState,
});
if (policy.kind !== 'allowed') {
  return {
    kind: 'refused',
    policy: { kind: 'claim_grant_required', intent: 'delegation-issuance', targetRunId },
  };
}
```

Create `packages/core/src/runbook/abort-command-service.ts` if no core abort seam
exists. Move the policy-bearing parts of `packages/cli/src/commands/abort.ts`
into that core service. The CLI remains responsible only for Category-A flag
parsing, output rendering, and exit-code mapping.

For abort flows in the core abort command service, use the same bearer-to-core
resolution path:

```typescript
const request: ClaimAuthorizationRequest = {
  action: 'abort-delegation',
  runId: targetRunId,
  ...(stepId !== undefined ? { stepId } : {}),
};
const authority = await this.#resolveMutationAuthority({
  presentedClaimId:
    input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined,
  targetState,
  request,
});
if (authority.kind !== 'verified') return authority.refusal;
const decision = authorizeClaim(authority.claim, request);
```

- [ ] **Step 6: Update collection service authorization**

In `packages/core/src/runbook/collection-service.ts`, replace local authority
checks with:

```typescript
const request: ClaimAuthorizationRequest = { action: 'collect-for-run', runId: targetState.id };
const authority = await this.#resolveMutationAuthority({
  presentedClaimId:
    input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined,
  targetState,
  request,
});
if (authority.kind !== 'verified') return authority.refusal;
const policy = resolveCommandIntent({
  actorContext: verifiedClaimContext({
    claimId: authority.claimId,
    claim: authority.claim,
  }),
  intent: { kind: 'delegation-collection' },
  targetSelector: input.targetSelector,
  targetState,
});
```

Ensure `resolveCommandIntent` maps this to a `collect-for-run` request.

- [ ] **Step 7: Update subprocess mutation boundary**

In `packages/core/src/runbook/subprocess-mutation-boundary.ts`, keep `--claim-id` as explicit authority and remove any code that treats `--run` as authority. Add or update tests so:

```typescript
expect(classifySubprocessMutation(['rundown', 'pass', '--run', 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])).toEqual({
  kind: 'identifier-mutation-without-authority',
  command: 'pass',
});

expect(classifySubprocessMutation(['rundown', 'pass', '--claim-id', validBearerClaimId])).toEqual({
  kind: 'explicit-authority',
  command: 'pass',
});
```

- [ ] **Step 8: Run core seam tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- lifecycle-command-service.test.ts collection-service.test.ts subprocess-mutation-boundary.test.ts abort-command-service.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/src/runbook/collection-service.ts packages/core/src/runbook/subprocess-mutation-boundary.ts packages/core/src/runbook/abort-command-service.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts packages/core/__tests__/runbook/collection-service.test.ts packages/core/__tests__/runbook/subprocess-mutation-boundary.test.ts packages/core/__tests__/runbook/abort-command-service.test.ts
git commit -m "feat(core): enforce grants across lifecycle mutations"
```

## Task 7: Return Initial Claim From `rundown run` and Bearer Claim From `rundown claim`

**Files:**
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts`
- Modify: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/commands/claim.ts`
- Modify: `packages/cli/__tests__/integration/delegate-workflow.test.ts`
- Modify: `packages/cli/__tests__/integration/inline-child-launch.test.ts`

- [ ] **Step 1: Add failing CLI integration test for `rundown run` claim issuance**

In `packages/cli/__tests__/integration/delegate-workflow.test.ts`, add:

```typescript
it('rundown run returns a bearer claim_id and session does not persist it', async () => {
  const workspace = await makeWorkspace({
    'parent.runbook.md': '# Parent\n\n## 1. Step\nDone\n',
  });

  const result = await runCliInProcess(['run', 'parent.runbook.md', '--prompted'], workspace);
  expect(result.exitCode).toBe(0);
  const event = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((value) => value.kind === 'runbook-started');

  expect(event.claim_id).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);

  const session = await readFile(join(workspace, '.rundown/session.json'), 'utf8');
  expect(session).not.toContain(event.claim_id);
  expect(session).toContain('rdclk_');
  expect(session).toContain('secretHash');
  expect(session).toContain('delegate-from-run');
});
```

- [ ] **Step 2: Update claim integration assertions**

Where existing tests assert `claim_id` matches `/^rdclm_[A-Za-z0-9_-]{22}$/`, change the expectation to:

```typescript
expect(claim.claim_id).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
```

Add a session secrecy assertion after one claim:

```typescript
const session = await readFile(join(workspace, '.rundown/session.json'), 'utf8');
expect(session).not.toContain(String(claim.claim_id));
expect(session).toContain('report-delegation-result');
```

- [ ] **Step 3: Run CLI integration tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- delegate-workflow.test.ts inline-child-launch.test.ts
```

Expected: FAIL because run output does not include `claim_id` and old claim ids still use the short readable format.

- [ ] **Step 4: Issue run claim in launch pipeline**

In `packages/cli/src/helpers/runbook-pipeline.ts`, extend `RunbookStartResult` success shape to carry `claimId?: ClaimId`:

```typescript
export type RunbookStartResult =
  | { readonly ok: true; readonly loopResult: ExecutionLoopResult; readonly stateId: RunId; readonly claimId?: ClaimId }
  | RunbookStartFailure;
```

Inside `launchRunbook`, after `sessionService.pushRunbook(state.id)` for default-stack launches, call:

```typescript
const issuedClaim =
  sessionActivation.kind === 'default-stack'
    ? await sessionService.issueRunControlClaim(state.id)
    : undefined;
```

Return:

```typescript
return { ok: true, loopResult, stateId: launchedStateId, ...(issuedClaim ? { claimId: issuedClaim.claimId } : {}) };
```

- [ ] **Step 5: Emit claim_id in run started output**

In the run-start output mapper used by `emitRunbookStarted`, include `claim_id` when `launchRunbook` has one. If `emitRunbookStarted` currently runs before claim issuance, move claim issuance before creating the emitted event and pass it as:

```typescript
emitRunbookStarted(emitter, initializedState, options.prompted, issuedClaim?.claimId);
```

Update the emitter helper signature to write:

```typescript
...(claimId !== undefined ? { claim_id: claimId } : {})
```

- [ ] **Step 6: Return bearer from claim command path**

In `packages/cli/src/helpers/runbook-pipeline.ts`, update `claimAndLaunch` success result to use `claimResult.claimId`:

```typescript
return {
  ok: true,
  claimId: claimResult.claimId,
  childRunId,
  loopResult: launch.loopResult,
};
```

Update any output action for claim to emit:

```typescript
claim_id: claimResult.claimId,
```

not `claimResult.claim.claimId`.

- [ ] **Step 7: Run CLI integration tests**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- delegate-workflow.test.ts inline-child-launch.test.ts
```

Expected: PASS for updated claim issuance and secrecy assertions.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/helpers/runbook-pipeline.ts packages/cli/src/commands/run.ts packages/cli/src/commands/claim.ts packages/cli/__tests__/integration/delegate-workflow.test.ts packages/cli/__tests__/integration/inline-child-launch.test.ts
git commit -m "feat(cli): return bearer claim ids for run and claim"
```

## Task 8: Migrate CLI Mutating Commands to `--claim-id` Authority Only

**Files:**
- Modify: `packages/cli/src/helpers/claim-id-option.ts`
- Modify: `packages/cli/src/helpers/run-option.ts`
- Modify: `packages/cli/src/helpers/caller-evidence.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Modify: `packages/cli/src/helpers/terminal-command.ts`
- Modify: `packages/cli/src/helpers/goto-workflow.ts`
- Modify: `packages/cli/src/commands/pass.ts`
- Modify: `packages/cli/src/commands/fail.ts`
- Modify: `packages/cli/src/commands/goto.ts`
- Modify: `packages/cli/src/commands/complete.ts`
- Modify: `packages/cli/src/commands/stop.ts`
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/cli/src/commands/stash.ts`
- Modify: `packages/cli/src/commands/pop.ts`
- Modify: `packages/cli/src/commands/abort.ts`
- Modify: `packages/cli/__tests__/cli.test.ts`
- Modify: `packages/cli/__tests__/services/execution-action.test.ts`
- Modify: `packages/cli/__tests__/integration/delegate-workflow.test.ts`

- [ ] **Step 1: Add failing CLI tests that reject mutating `--run`**

In `packages/cli/__tests__/integration/delegate-workflow.test.ts`, add:

```typescript
it('rejects --run as mutation authority on delegation-exposed runs', async () => {
  const workspace = await makeDelegatingWorkspace();
  let result = await runCliInProcess(['run', 'parent.runbook.md', '--prompted'], workspace);
  const runStarted = parseJsonLines(result.stdout).find((event) => event.kind === 'runbook-started');

  result = await runCliInProcess(['pass', '--run', runStarted.runbookId], workspace);

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: 'error',
    code: 'INVALID_SYNTAX',
    error: expect.stringContaining('--run is not mutation authority'),
  });
});
```

If this repository emits errors on stderr in this helper, assert against the helper's existing error stream.

- [ ] **Step 2: Add passing-path test using run claim**

In the same file, add:

```typescript
it('uses the run claim_id from rundown run to mutate the parent run', async () => {
  const workspace = await makeWorkspace({
    'parent.runbook.md': '# Parent\n\n## 1. Step\nDone\n',
  });
  const result = await runCliInProcess(['run', 'parent.runbook.md', '--prompted'], workspace);
  const runStarted = parseJsonLines(result.stdout).find((event) => event.kind === 'runbook-started');

  const pass = await runCliInProcess(['pass', '--claim-id', runStarted.claim_id], workspace);

  expect(pass.exitCode).toBe(0);
});
```

- [ ] **Step 3: Run CLI tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- delegate-workflow.test.ts
```

Expected: FAIL because `--run` still acts as mutation authority and run claims are not threaded into caller evidence.

- [ ] **Step 4: Update claim-id parser message and pattern**

In `packages/cli/src/helpers/claim-id-option.ts`, update the error:

```typescript
output.error(
  'Invalid claim id. Expected rdclm_<32 lowercase hex lookup key>_<43 base64url characters>.',
  'INVALID_CLAIM_ID',
);
```

- [ ] **Step 5: Reject `--run` for mutating commands**

In `packages/cli/src/helpers/run-option.ts`, replace the mutating parser with:

```typescript
export function rejectRunMutationAuthority(
  raw: string | undefined,
  output: OutputEmitter,
): { readonly ok: true } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  output.error(
    '--run is not mutation authority. Use the bearer claim_id returned by `rundown run` or `rundown claim` with --claim-id.',
    'INVALID_SYNTAX',
  );
  output.flush();
  process.exitCode = 1;
  return { ok: false };
}
```

Keep `parseRunOption` only for read-only commands that still accept run identifiers.

- [ ] **Step 6: Pass bearer claim evidence without verification**

In `packages/cli/src/helpers/caller-evidence.ts`, replace
`readLifecycleCallerEvidence` with a parser-only evidence builder:

```typescript
export interface LifecycleEvidenceInput {
  readonly claimId?: ClaimId;
}

export function readLifecycleCallerEvidence(input: LifecycleEvidenceInput = {}): CallerEvidence {
  if (input.claimId === undefined) {
    return { kind: 'unknown' };
  }
  return { kind: 'claim_bearer', claimId: input.claimId };
}
```

Core mutation seams decide whether omitted `claimId` can use the default
orchestrator context for a non-delegated run. CLI must not verify claim secrets,
inspect session claims, or construct `VerifiedClaim`.

- [ ] **Step 7: Update command actions**

For each mutating command listed in this task:

1. Keep `.option('--claim-id <claimId>', 'Bearer claim id returned by rundown run or rundown claim')`.
2. Remove `.option('--run <runId>', ...)` or keep it only to reject with `rejectRunMutationAuthority`.
3. Parse `--claim-id` with `parseClaimIdOption`.
4. Build caller evidence with `readLifecycleCallerEvidence({ claimId })`.
5. Pass bearer evidence to core seams; core resolves explicit bearer authority
   or the non-delegated default orchestrator context.

For `packages/cli/src/commands/delegate.ts`, replace `runTargetedSeamFields` with:

```typescript
function claimTargetedSeamFields(input: {
  readonly claimId: ClaimId | undefined;
}): { readonly callerEvidence: CallerEvidence } {
  return {
    callerEvidence: readLifecycleCallerEvidence({ claimId: input.claimId }),
  };
}
```

- [ ] **Step 8: Run CLI unit and integration tests**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- cli.test.ts execution-action.test.ts
pnpm --filter @rundown-org/cli test:integration -- delegate-workflow.test.ts
```

Expected: PASS after updating snapshots and error messages from `--run` guidance to `--claim-id`.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/helpers/claim-id-option.ts packages/cli/src/helpers/run-option.ts packages/cli/src/helpers/caller-evidence.ts packages/cli/src/helpers/transitions.ts packages/cli/src/helpers/terminal-command.ts packages/cli/src/helpers/goto-workflow.ts packages/cli/src/commands/pass.ts packages/cli/src/commands/fail.ts packages/cli/src/commands/goto.ts packages/cli/src/commands/complete.ts packages/cli/src/commands/stop.ts packages/cli/src/commands/collect.ts packages/cli/src/commands/delegate.ts packages/cli/src/commands/stash.ts packages/cli/src/commands/pop.ts packages/cli/src/commands/abort.ts packages/cli/__tests__/cli.test.ts packages/cli/__tests__/services/execution-action.test.ts packages/cli/__tests__/integration/delegate-workflow.test.ts
git commit -m "feat(cli): require bearer claim ids for mutations"
```

## Task 9: Update MCP and Plugin Surfaces

**Files:**
- Modify: `packages/mcp/src`
- Modify: `packages/mcp/__tests__`
- Modify: `packages/claude-code-plugin/src`
- Modify: `packages/claude-code-plugin/__tests__`
- Modify: `packages/claude-code-plugin/skills`

- [ ] **Step 1: Search for stale authority guidance**

Run:

```bash
rg -n "runCapability|claim_capability|--run <|--run \\$|run_controller|claim_capability|--claim-capability|--run-capability" packages/mcp packages/claude-code-plugin
```

Expected: Output lists every MCP/plugin site that still references old or superseded authority forms.

- [ ] **Step 2: Add failing MCP command-builder tests**

In the relevant `packages/mcp/__tests__/*command*` test file, add:

```typescript
it('builds mutating commands with bearer --claim-id authority', () => {
  expect(buildCommand({ tool: 'pass', claimId: CLAIM_ID })).toEqual([
    'rundown',
    'pass',
    '--claim-id',
    CLAIM_ID,
  ]);
});

it('does not accept runId as mutating authority', () => {
  expect(() => buildCommand({ tool: 'pass', runId: RUN_ID })).toThrow(
    'Mutating Rundown tools require claimId authority',
  );
});
```

- [ ] **Step 3: Run MCP tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/mcp test:unit
```

Expected: FAIL where tools still accept `runId` for mutation.

- [ ] **Step 4: Update MCP tool schemas and builders**

In MCP tool definitions, for every mutating tool use:

```typescript
claimId: z.string().regex(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/),
```

Remove mutating `runId` inputs. Keep `runId` only on read-only tools. Command builders must emit:

```typescript
['rundown', commandName, '--claim-id', input.claimId]
```

and must not emit `--text`.

- [ ] **Step 5: Update plugin subprocess guards and skills**

In `packages/claude-code-plugin/src`, update subprocess mutation checks so `--claim-id` with the new bearer pattern is the only accepted explicit authority. Replace user-facing guidance:

```text
Use the claim_id returned by `rundown run` or `rundown claim` with `rundown <command> --claim-id <claim_id>`.
```

Remove references to `runCapability`, `claim_capability`, `--run-capability`, and mutating `--run <rd_...>`.
Do not add temporary compatibility aliases or shim names for these rejected
authority forms under `packages/`.

- [ ] **Step 6: Run MCP and plugin tests**

Run:

```bash
pnpm --filter @rundown-org/mcp test:unit
pnpm --filter @rundown-org/claude-code-plugin test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src packages/mcp/__tests__ packages/claude-code-plugin/src packages/claude-code-plugin/__tests__ packages/claude-code-plugin/skills
git commit -m "feat: align MCP and plugin authority with claim grants"
```

## Task 10: Update Documentation and CLI Output Contracts

**Files:**
- Modify: `docs/spec/cli-output.md`
- Modify: `docs/reference/runtime.md`
- Modify: `docs/reference/cli.md`
- Modify: `docs/reference/mcp.md`
- Modify: `docs/internal/architecture.md`
- Modify: `docs/internal/plugin-trust-model.md`
- Modify: generated CLI help docs if `pnpm run docs:cli-help` changes them

- [ ] **Step 1: Update CLI output spec examples**

In `docs/spec/cli-output.md`, update `rundown run` JSON examples to include:

```json
{
  "kind": "runbook-started",
  "runbookId": "rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "claim_id": "rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_"
}
```

Update `rundown claim` JSON examples so `claim_id` uses the new bearer pattern:

```json
{
  "kind": "claim",
  "action": "claimed",
  "claim_id": "rdclm_22222222222222222222222222222222_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_",
  "run_id": "rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

Replace mutation guidance with:

```markdown
Use the returned `claim_id` with `rundown pass --claim-id <claim_id>`,
`rundown fail --claim-id <claim_id>`, `rundown delegate --claim-id <claim_id>`,
and `rundown collect --claim-id <claim_id>`.
```

- [ ] **Step 2: Update runtime persisted session example**

In `docs/reference/runtime.md`, replace the session claim example with:

```json
{
  "defaultStack": ["rd_11111111111111111111111111111111"],
  "stashedRunbookId": null,
  "claims": {
    "rdclk_11111111111111111111111111111111": {
      "claimKey": "rdclk_11111111111111111111111111111111",
      "secretHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "grants": [
        { "action": "mutate-run", "runId": "rd_11111111111111111111111111111111" },
        { "action": "delegate-from-run", "runId": "rd_11111111111111111111111111111111" },
        { "action": "collect-for-run", "runId": "rd_11111111111111111111111111111111" }
      ],
      "issuedAt": "2026-07-06T00:00:00.000Z",
      "updatedAt": "2026-07-06T00:00:00.000Z"
    }
  }
}
```

Add:

```markdown
The public bearer `claim_id` is returned only by issuance commands. It is not persisted in session or run state. Reading `.rundown/session.json` reveals lookup keys and hashes, not reusable mutation credentials.
```

- [ ] **Step 3: Remove superseded public capability language**

Run:

```bash
rg -n "runCapability|claim_capability|--run-capability|--claim-capability|--run <rd_…>.*orchestrator|run_controller|ClaimRecord\\.kind|claim kind|claim-authority" docs/reference docs/internal docs/spec packages
```

Expected: zero matches under `packages/` and current docs
(`docs/reference/`, `docs/internal/`, and `docs/spec/`). No public docs,
internal current-architecture docs, or package code keep the superseded
capability model, role/kind policy language, temporary compatibility aliases, or
the removed `claim-authority` target selector. Historical rejected-design prose
may remain only under `docs/superpowers/specs/2026-07-06-unified-claim-grants-design.md`.

Update the docs with these concrete rules:

- `docs/reference/cli.md`: mutating commands document `--claim-id <claim_id>` as bearer evidence. `--run` is either read-only target selection or omitted from mutation examples.
- `docs/reference/mcp.md`: mutating tools accept/pass bearer `claim_id`; no MCP tool can authorize a mutation from a run id alone.
- `docs/internal/architecture.md`: actor context is core-resolved from verified claims and grants; CLI/MCP/plugin evidence is untrusted input.
- `docs/internal/plugin-trust-model.md`: plugin subprocess mutation paths are claim-authorized lanes, and the plugin never verifies or mints trusted claim context.

- [ ] **Step 4: Regenerate/check CLI docs**

Run:

```bash
pnpm run docs:cli-help
pnpm run check:docs:cli-help
```

Expected: generated CLI help is updated and the check passes.

- [ ] **Step 5: Commit**

```bash
git add docs/spec/cli-output.md docs/reference/runtime.md docs/reference/cli.md docs/reference/mcp.md docs/internal/architecture.md docs/internal/plugin-trust-model.md docs/reference/cli-help.md
git commit -m "docs: document unified claim grant authority"
```

If `docs/reference/cli-help.md`, `docs/reference/mcp.md`, or `docs/internal/plugin-trust-model.md` does not exist or is not changed, omit it from `git add`.

## Task 11: Add Security Regression Coverage

**Files:**
- Create: `packages/cli/__tests__/integration/claim-authority-security.test.ts`
- Create: `packages/core/__tests__/runbook/claim-authorization.properties.test.ts`
- Create: `packages/core/__tests__/runbook/claim-authority-boundary.source-text.test.ts`
- Modify: `packages/core/__tests__/runbook/session-service.test.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify: `packages/core/__tests__/runbook/abort-command-service.test.ts`

- [ ] **Step 1: Add session-read attack integration test**

Create `packages/cli/__tests__/integration/claim-authority-security.test.ts`.
The test must start or claim a runbook, read `.rundown/session.json` and
`.rundown/runs/*.json`, then prove no persisted value can be reused as authority:

```typescript
it('does not let a sibling process steal authority from persisted state', async () => {
  const workspace = await makeWorkspace({
    'parent.runbook.md': '# Parent\n\n## 1. Step\nDone\n',
  });

  const run = await runCliInProcess(['run', 'parent.runbook.md', '--prompted'], workspace);
  const claimId = extractRunStartedClaimId(run.stdout);
  const parsed = parseClaimBearer(assertClaimId(claimId));

  const stateText = await readRundownStateText(workspace);
  expect(stateText).not.toContain(claimId);
  expect(stateText).not.toContain(parsed.secret);
  expect(stateText).not.toMatch(/rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}/);

  const forged = `rdclm_${parsed.claimKey.slice('rdclk_'.length)}_${'A'.repeat(43)}`;
  for (const badAuthority of [parsed.claimKey, forged, 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const result = await runCliInProcess(['pass', '--claim-id', badAuthority], workspace);
    expect(result.exitCode).toBe(1);
  }
});
```

Use existing CLI integration helpers for workspace creation, JSON extraction,
and state-file reads where available. If a helper is missing, add it to the
test file rather than production code.

- [ ] **Step 2: Add identifier-only mutation rejection matrix**

In the same integration test file, add a table-driven test covering mutating
commands that previously accepted `--run` or bare ambient authority:

```typescript
it.each([
  ['pass', ['pass']],
  ['fail', ['fail']],
  ['goto', ['goto', '2']],
  ['complete', ['complete']],
  ['stop', ['stop']],
  ['collect', ['collect']],
  ['delegate', ['delegate']],
  ['stash', ['stash']],
  ['pop', ['pop']],
  ['abort', ['abort', 'rdtk_invalid']],
] as const)('requires claim authority for %s when default orchestrator context is unavailable', async (_name, args) => {
  const workspace = await workspaceWithDelegationActivity();
  const bare = await runCliInProcess(args, workspace);
  expect(bare.exitCode).toBe(1);
  expect(parseFinalCliJsonObject(bare.stdout).code).toBe('ACTOR_CONTEXT_REQUIRED');

  const withRun = await runCliInProcess([...args, '--run', 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], workspace);
  expect(withRun.exitCode).toBe(1);
  expect(JSON.stringify(parseFinalCliJsonObject(withRun.stdout))).toContain('--claim-id');
});
```

The fixture must start a parent run, mint the orchestrator claim, and create
delegation activity such as an issued or claimed child. The test must prove that
once delegation state exists, omitted `--claim-id` and identifier-only `--run`
do not use the non-delegated default orchestrator context.

- [ ] **Step 3: Add token replay and terminal claim tests**

In `packages/core/__tests__/runbook/session-service.test.ts`, add tests that:

- claiming an unclaimed token returns one bearer `claim_id`;
- replaying the same `rundown claim <token>` path after claim returns
  `already-claimed` and no bearer;
- terminal child claims do not mint usable credentials;
- old bearers are not invalidated by token replay because replay cannot rotate
  the stored proof;
- grants and `DelegationClaimLinkage` are preserved exactly.

- [ ] **Step 4: Add grant mismatch tests at behavioral seams**

Add positive and negative tests for each grant:

- `delegate-from-run` in `lifecycle-command-service.test.ts`;
- `retry-delegation` in `lifecycle-command-service.test.ts`;
- `collect-for-run` in `collection-service.test.ts`;
- `abort-delegation` in `abort-command-service.test.ts`;
- `report-delegation-result` in child completion / propagation tests.

For `report-delegation-result`, include a test where a claim with
`mutate-run` on the child can close the child but cannot write to the parent
unless the full `DelegationClaimLinkage` grant matches.

- [ ] **Step 5: Add property tests for grant authorization**

Create `packages/core/__tests__/runbook/claim-authorization.properties.test.ts`
with properties proving:

- arbitrary nonmatching grants never authorize a request;
- a matching grant authorizes only the exact target;
- optional `stepId` on recovery grants behaves as a wildcard only on grants,
  never on requests;
- serialized `ClaimRecord` values never contain bearer-shaped `rdclm_...`
  strings or raw secret segments.

- [ ] **Step 6: Add source-text guard for rejected designs**

Create `packages/core/__tests__/runbook/claim-authority-boundary.source-text.test.ts`
that scans `packages/`, `docs/reference/`, `docs/internal/`, and
`docs/spec/` for forbidden new authority patterns. Exclude
`packages/core/__tests__/runbook/claim-authority-boundary.source-text.test.ts`
itself from the file list so the guard does not match its own assertions:

```typescript
expect(source).not.toMatch(/ClaimRecord\\.kind/);
expect(source).not.toMatch(/kind:\s*['"]claim-record['"]/);
expect(source).not.toMatch(/--run-capability|--claim-capability/);
expect(source).not.toMatch(/runCapability|claim_capability/);
expect(source).not.toMatch(/kind:\s*['"]claim-authority['"]/);
expect(source).not.toMatch(/role-specific-mutation-without-authority/);
```

Exclude historical prospective docs under `docs/superpowers/`.
Expected result is zero matches under `packages/` and current docs; do not keep
temporary compatibility names in implementation files.

- [ ] **Step 7: Run security regression tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- claim-authorization.properties.test.ts claim-authority-boundary.source-text.test.ts session-service.test.ts lifecycle-command-service.test.ts collection-service.test.ts abort-command-service.test.ts
pnpm --filter @rundown-org/cli test:integration -- claim-authority-security.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/__tests__/runbook/claim-authorization.properties.test.ts packages/core/__tests__/runbook/claim-authority-boundary.source-text.test.ts packages/core/__tests__/runbook/session-service.test.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts packages/core/__tests__/runbook/collection-service.test.ts packages/core/__tests__/runbook/abort-command-service.test.ts packages/cli/__tests__/integration/claim-authority-security.test.ts
git commit -m "test: cover unified claim authority attack paths"
```

## Task 12: Full Verification and Cleanup

**Files:**
- Modify only files changed by earlier tasks if verification exposes a defect.

- [ ] **Step 1: Run focused core tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- claim-id.test.ts delegation-schemas.test.ts session-service.test.ts command-policy.test.ts command-target-resolver.test.ts lifecycle-command-service.test.ts collection-service.test.ts subprocess-mutation-boundary.test.ts abort-command-service.test.ts claim-authority-boundary.source-text.test.ts
pnpm --filter @rundown-org/core test:property -- claim-authorization.properties.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused CLI tests**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- cli.test.ts execution-action.test.ts
pnpm --filter @rundown-org/cli test:integration -- delegate-workflow.test.ts inline-child-launch.test.ts claim-authority-security.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package type checks**

Run:

```bash
pnpm run check:types:core
pnpm run check:types:cli
pnpm run check:types:mcp
pnpm run check:types:plugin
```

Expected: PASS.

- [ ] **Step 4: Run lint and docs checks**

Run:

```bash
pnpm run check:format
pnpm run check:md
pnpm run check:lint:fast
pnpm run check:lint:typed
pnpm run check:docs:cli-help
```

Expected: PASS.

- [ ] **Step 5: Run full pre-PR verification**

Run:

```bash
pnpm run verify
```

Expected: PASS.

- [ ] **Step 6: Inspect persisted state manually**

Run this in a temporary workspace:

```bash
tmpdir="$(mktemp -d)"
printf '# Parent\n\n## 1. Step\nDone\n' > "$tmpdir/parent.runbook.md"
(cd "$tmpdir" && node /Users/tobyhede/psrc/rundown/packages/cli/dist/cli.js run parent.runbook.md --prompted > out.jsonl)
claim_id="$(node -e "const fs=require('fs'); for (const line of fs.readFileSync(process.argv[1],'utf8').trim().split('\\n')) { const v=JSON.parse(line); if (v.claim_id) { console.log(v.claim_id); process.exit(0); } }" "$tmpdir/out.jsonl")"
grep -R "$claim_id" "$tmpdir/.rundown" && exit 1 || echo "claim bearer not persisted"
```

Expected:

```text
claim bearer not persisted
```

- [ ] **Step 7: Final commit**

If verification required fixes, commit them:

```bash
git add packages docs
git commit -m "test: verify unified claim grant authority"
```

If no files changed after the previous commits, do not create an empty commit.

## Self-Review Checklist

- [ ] The plan implements the grant-based model from `docs/superpowers/specs/2026-07-06-unified-claim-grants-design.md`.
- [ ] No task introduces `runCapability`, `claim_capability`, `--run-capability`, or `--claim-capability`.
- [ ] No task adds `ClaimRecord.kind` or policy branching on claim roles.
- [ ] `rundown run` and `rundown claim` both return a bearer `claim_id`.
- [ ] Mutating commands use `--claim-id`; `run_id` remains an identifier/read context only.
- [ ] Persisted session state stores lookup keys, secret hashes, grants, and timestamps, not reusable bearer credentials.
- [ ] Recovery authority is represented by `abort-delegation` and `retry-delegation` grants.
- [ ] Tests prove reading `.rundown/session.json` does not reveal reusable mutation authority.
- [ ] The plan uses TDD, exact commands, expected results, and frequent commits.
