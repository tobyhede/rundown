# 608 PR 12 — deterministic delegation credentials addendum

<!-- cspell:words HMAC -->

> **Status:** Binding PR 12 correction after the PR 11-head planning audit.
>
> **Supersedes:** The plaintext issuance-receipt option in
> `2026-08-01-608-pr12-planning-audit-pr11-head.md`. Every other unaffected
> finding, branch gate, architecture constraint, task, and stop condition in
> that audit remains in force.
>
> **Branch gate:** Planning may continue against PR 11's reviewed head, but PR
> 12 implementation must not branch until PR 11 merges and that reviewed head
> is an ancestor of freshly fetched `origin/main`.

## Decision summary

PR 12 must remove plaintext delegation tokens from every persisted surface.
It must not add a plaintext response receipt, encrypted token blob, project
master key, or database-held derivation key.

Delegation credentials will instead be derived with HMAC-SHA256 from:

- the secret segment of the exact verified parent claim bearer;
- a fresh, persisted, non-secret issuance nonce; and
- the canonical parent run, step, frame, and entry coordinates.

The existing public token shape remains `rdtk_` followed by 32 RFC 4648 base32
characters. Only the first 20 bytes of the HMAC output are encoded, preserving
the current 160-bit token material. The existing SHA-256 delegation-token hash
remains the persisted lookup and correlation value.

The plaintext token may exist transiently in process memory only at an explicit
credential-delivery boundary. It must never enter `RunbookState`, the opaque
XState snapshot, session persistence, SQLite, logs, diagnostics, status output,
or recovery records.

## Why this addendum is required

The PR 11-head audit proposed a durable issuance receipt as one possible answer
to committed-but-unobserved output. That option is rejected: persisting the
plaintext bearer, even in a narrowly scoped receipt, violates the credential
storage requirement.

The current implementation already persists plaintext delegation tokens in two
places:

1. `StepDelegation.token` inside serialized run state; and
2. `RunbookContext.delegateFrontier[].token` inside the persisted XState
   snapshot.

`rundown status` reads the first field to reveal a pending token, and delegation
inference reads it to implement an idempotent echo. Moving run state from JSON
files to SQLite carried that pre-existing behavior into `runs.state_json`; the
plaintext is domain state, not execution-lock data.

PR 12 must remove both persistence paths. Fixing only manual `rundown delegate`
would leave automatic frontier tokens in the snapshot and would not establish
the invariant.

## Credential vocabulary

Keep the three credential classes distinct:

| Credential | Purpose | Plaintext lifetime | Persisted form |
| --- | --- | --- | --- |
| Delegation token (`rdtk_…`) | Lets a child claim one delegation | Intentional parent-to-child delivery only | SHA-256 hash plus non-secret derivation descriptor |
| Claim bearer (`rdclm_…`) | Authorizes a controller or child to mutate its granted runs | Caller-held and verified in process | Lookup key plus SHA-256 secret hash |
| Execution token | Proves one process owns one execution epoch | Owning process only | SHA-256 hash in execution ownership rows |

The **claim secret** is not a new user-facing value. It is the 43-character
secret suffix already contained in a `ClaimId`. `parseClaimBearer` separates
the public lookup component from this secret. Core verifies the supplied secret
against the persisted hash before it may be used for derivation.

PR 11's execution token is not a derivation root. Its raw value dies with the
owning process, so it cannot reconstruct a token after a committed process dies.
Using its persisted hash, the persisted claim-secret hash, or public run
coordinates as a key would let a database reader forge delegation credentials.

## Cryptographic contract

Add one core-owned deterministic derivation primitive. Its conceptual contract
is:

```text
derivationKey = HMAC-SHA256(
  claimSecret,
  "rundown/delegation-key/v1"
)

tokenMaterial = HMAC-SHA256(
  derivationKey,
  canonical([
    "rundown/delegation-token/v1",
    issuanceNonce,
    parentRunId,
    parentStepId,
    parentFrameKey,
    parentEntry
  ])
)

token = "rdtk_" + base32(tokenMaterial[0..20])
```

The implementation must use an unambiguous canonical encoding, such as
length-prefixed UTF-8 fields, rather than delimiter concatenation. Domain and
version labels are mandatory so claim secrets cannot accidentally share a
cryptographic namespace with another capability.

The exact API may use a callable that closes over a verified secret, but its
data-level input must contain:

```ts
interface DelegationCredentialCoordinate {
  readonly issuanceNonce: DelegationIssuanceNonce;
  readonly parentRunId: RunId;
  readonly parentStepId: string;
  readonly parentFrameKey: FrameKey;
  readonly parentEntry: number;
}
```

The corresponding persisted descriptor contains no bearer material:

```ts
interface DelegationCredentialDescriptor
  extends DelegationCredentialCoordinate {
  readonly version: 1;
  readonly issuerClaimKey: ClaimLookupKey;
}
```

`issuerClaimKey` identifies which verified bearer can reconstruct the token. It
is not authority by itself. A fresh manual issuance, automatic issuance, or real
retry generates a new public nonce. An echo or committed-result reconciliation
reuses the persisted descriptor exactly.

The parent entry must come from core's shared frame-entry inference helper. No
frontend may infer it independently.

## Authority contract

Every operation that creates or reproduces a delegation token requires the
exact verified claim bearer recorded by `issuerClaimKey`.

For manual issuance this means `rundown delegate` must present `--claim-id` for
fresh, retry, and token-bearing echo outcomes. Core verifies the bearer and its
`delegate-from-run` or `retry-delegation` grant before constructing an in-memory
derivation capability.

For transition-triggered automatic issuance, the lifecycle mutation that enters
a DELEGATE frontier must carry verified run-control authority. Bare mutation may
not cross into a state that issues credentials. The refusal remains machine/core
owned and renders through the existing actor-context taxonomy.

The raw claim id, its secret, and the derivation key must not be placed in
persisted context, a snapshot, prepared state, a result diagnostic, a log, or
status output.

There is exactly one exception, and it is defined here: the
`runbook_started.claim_id` field emitted after run activation commits (see
[Run-start ordering](#run-start-ordering)). That field is the sole
credential-delivery channel for the run-control bearer — it hands the caller the
exact bearer it must later present as `--claim-id`, and no other event, command,
or rendered surface may carry it. Even there the value is delivery-only: it must
not be written back into `RunbookState`, the XState snapshot, session
persistence, SQLite, logs, diagnostics, recovery records, or `rundown status`
output, and it must be redacted from every refusal and error envelope. The claim
secret and the derivation key have no exception at all — they are never emitted
on any surface.

Pass a least-privilege `DelegationTokenDeriver` callable through the compiler's
runtime `invoke.input` closure. This is a Category C dependency: machine-owned
behavior with an injected runtime capability.

Claim rotation does not invalidate a delegation token already delivered to a
child; its persisted token hash remains authoritative. Rotation does remove the
new controller's ability to reproduce the old plaintext token. A mismatched
`issuerClaimKey` must fail closed and require explicit cancel/reissue rather than
deriving a replacement against the old hash.

## Persisted state and public output separation

`DelegateFrontierEntry` currently serves as both machine context and public
credential output. Split those responsibilities.

Persist a frontier intent containing only identifiers, the credential
descriptor, and token hash. Derive the existing public token-bearing
`DelegateFrontierEntry` only while constructing the intentional `STEP_ENTERED`
event for an authorized caller.

Likewise, remove `StepDelegation.token`. `StepDelegation` retains the token hash,
credential descriptor, child reference, context snapshot, linkage, timestamps,
and lifecycle data.

The following persisted surfaces must be proven free of the raw token:

- `runs.state_json` and every parsed `RunbookState`;
- `RunbookState.snapshot` / XState context;
- session tables and reconstructed `SessionData`;
- completion and resolved-completion payloads;
- execution-attempt and recovery rows;
- logs, errors, diagnostics, and mutation evidence.

This is a current-model schema change, not a persisted-state migration.
`RunbookState.schemaVersion` remains `1`; incompatible active state is rejected
and restarted in accordance with the repository's no-migration rule.

## Status and echo contract

Bare `rundown status` is read-only and receives no bearer authority. It must no
longer return a raw pending delegation token. It continues to return the
delegation state, coordinate, child/runbook identity, and token hash.

Do not add `--claim-id` to `status` merely to turn a read-only command into a
credential-delivery endpoint.

An idempotent `rundown delegate` echo may return the existing token only after
the caller presents and verifies the same issuer claim. The token is re-derived
from the persisted descriptor; it is never loaded from storage.

JSON and text output retain the current raw token only on intentional
credential-delivery variants:

- successful fresh delegation;
- successful retry;
- same-issuer strong echo; and
- authorized automatic `STEP_ENTERED` frontier output.

Every refusal, status, diagnostic, and transaction result remains redacted.

## Run-start ordering

Initial machine initialization can enter a DELEGATE step before
`pushRunbookWithRunControlClaim` currently mints the root claim. The derivation
design therefore requires a prepared-claim seam:

1. Pre-mint the run-control bearer and proof-backed claim record in memory.
2. Bind a derivation callable for that exact bearer into machine initialization.
3. Initialize the machine with credential descriptors and token hashes only.
4. Activate the run and install the already-prepared run-control claim in the
   existing atomic session mutation.
5. Emit `runbook_started.claim_id` and any derived `STEP_ENTERED` delegation
   tokens only after activation commits. These are the design's only two
   credential-delivery surfaces — `runbook_started.claim_id` is the single
   defined exception to the no-credential-in-events rule in the
   [Authority contract](#authority-contract), and it carries the run-control
   bearer alone (never the claim secret or the derivation key). Both values are
   transient output: neither may be written into `RunbookState`, the XState
   snapshot, session persistence, SQLite, logs, diagnostics, recovery records,
   or `rundown status` output, and both stay redacted in every refusal and
   error envelope.

Do not push an active run before initialization; that creates an
active-but-uninitialized durable window. Do not mint a second claim during
activation; the descriptor would then be bound to a bearer the caller never
receives.

Ordinary launch failures keep the existing best-effort cleanup. A hard process
death before activation may leave only an inactive orphan run, which is pruned
or restarted; it must not leave a usable plaintext credential or active claim.

## Retry and committed-result identity

Deterministic derivation recovers credential material, but retry still needs an
operation identity so a repeated command can distinguish committed-response
recovery from an intentional second rotation.

A token-located retry already supplies that identity: the previous token hashes
to the exact delegation attempt being replaced. Persist the non-secret
`supersedesTokenHash` on the replacement descriptor or equivalent machine-owned
retry metadata. Repeating the old-token request with the same issuer claim
returns the already-committed replacement token rather than rotating again.

Step-located and inferred retry do not carry an old bearer. Their machine
contract must be refusal-biased:

- the first request replaces the located attempt;
- a same-issuer replay over the resulting pending replacement echoes that
  replacement; and
- a further intentional rotation must name the current token.

Do not use timestamps, process ids, or "latest attempt" heuristics to infer
whether output was observed. If this contract cannot be represented without
ambiguity in the public retry forms, stop and raise a CLI idempotency-key design
instead of silently minting twice.

All fresh/retry reconciliation must remain under PR 11's exact execution and
authority protocol. Determinism does not replace `captureAuthority`,
`acquireAll`, `commitOwnedState`, `commitOwnedRunSet`, or committed-attempt
reconciliation.

## Implementation tasks

### Task 1 — RED: pin plaintext absence and derivation

- Add delegation-token tests proving identical secret plus descriptor produces
  an identical canonical token.
- Prove changing secret, nonce, run, step, frame, or entry changes the token.
- Prove the output retains the current format and hashes through the existing
  `hashDelegationToken` contract.
- Prove domain/version labels and canonical field boundaries affect the output.
- Serialize representative pending, claimed, cancelled, automatic-frontier, and
  retry states; assert neither the raw token nor claim secret occurs anywhere in
  the serialized state or snapshot.
- Inspect the SQLite database after issuance and assert neither secret occurs in
  any stored JSON or normalized field.

### Task 2 — implement the credential primitive and persisted descriptor

- Add branded issuance-nonce and credential-descriptor types in core.
- Add one deterministic token derivation helper and a narrow runtime deriver
  capability.
- Replace `StepDelegation.token` with the required descriptor.
- Update Zod schemas to require the current descriptor and reject the old
  plaintext shape. Do not accept both shapes and do not hydrate legacy tokens.
- Keep `tokenHash` and all child-claim lookup/linkage behavior unchanged.

### Task 3 — split persisted frontier intent from public output

- Replace token-bearing persisted frontier entries with descriptor-bearing
  intents.
- Update compiler actions and snapshot context to persist intents only.
- Inject the runtime deriver into `delegationIssueActor` through `invoke.input`.
- Derive public `STEP_ENTERED` tokens only after the corresponding prepared
  state commits under PR 11 ownership.
- Preserve the public `DelegateFrontierEntry` and command-sequence token shape.
- Cover multiple auto-issued substeps and FOR frames for coordinate separation.

### Task 4 — prepare and atomically activate the root claim

- Split run-control claim minting into a pure in-memory preparation seam plus an
  atomic session installation seam.
- Pre-mint once before actor initialization and bind its deriver in memory.
- Install that exact prepared claim while activating the run; never mint a
  replacement during activation.
- Preserve one run-control claim per run and existing grant construction.
- Prove initialization/activation failure emits neither credential and leaves no
  active unclaimed run.

### Task 5 — migrate manual fresh issuance and echo

- Require verified claim authority before the issuable or token-echo path.
- Generate a fresh public nonce only after all write-free preconditions pass.
- Have XState prepare the descriptor-bearing next state.
- Commit through the PR 11 runner and PR 12 aggregate/session projection.
- Derive the successful output from the in-memory capability and committed
  descriptor.
- Re-run with the same claim and prove the same token is returned with no state
  write and no fresh nonce.
- Rotate the parent claim and prove the old token is neither disclosed nor
  replaced implicitly.

### Task 6 — migrate retry issuance

- Generate a new descriptor for a real retry; never reuse the old nonce.
- Persist the non-secret superseded-attempt identity required for replay.
- Atomically release terminal child targeting, supersede the old completion,
  and commit the replacement parent state under the PR 12 run-set transaction.
- Re-run token-located retry with the old token and same parent claim; prove the
  exact replacement token is returned without another rotation.
- Re-run step/inferred retry and pin the refusal-biased echo contract.
- Prove a new intentional retry naming the current token derives a different
  credential.

### Task 7 — remove status and inference plaintext dependencies

- Remove raw token projection from delegation status entries and their JSON/text
  renderers.
- Update inference to classify pending delegations from lifecycle, descriptor,
  and token hash rather than `token !== undefined`.
- Make same-issuer echo derive through the authorized core capability.
- Remove stale docs and comments describing status as pending-token recovery.
- Search production code for token-bearing persisted shapes and require zero
  remaining matches outside explicit output/local variables.

### Task 8 — crash, race, and redaction evidence

- Kill after ownership acquisition but before the effect boundary; retry may
  prepare a new unobserved nonce and must commit at most one token hash.
- Kill after effect start but before commit; recovery must expose no token and
  must not leave a persisted descriptor without the matching state transition.
- Kill after commit but before output; the same parent claim must reconstruct
  the exact committed token without invoking fresh issuance.
- Interleave parent-claim removal and rotation between capture and commit; the
  transaction refuses and emits no credential.
- Interleave token replacement between capture and commit; the loser cannot
  derive or reveal the winner's token.
- Assert JSON and text refusals, logs, status, recovery diagnostics, and database
  bytes contain neither delegation token nor claim secret.

### Task 9 — documentation and gates

- Update CLI and output-schema references for claim-authorized delegation,
  token-free status, and same-issuer echo/retry behavior.
- Preserve `rundown claim <delegation-token>` and successful delegation output
  shapes.
- Run focused core derivation/schema/actor/compiler/lifecycle suites.
- Run `pnpm run build` before focused CLI run/delegate/status/execution suites.
- Run the PR 12 multi-process and scenario suites.
- Run `pnpm run test:mutate:changed` and disposition every changed-range
  survivor or `NoCoverage` result.
- Run `pnpm run verify` immediately before push.

## Provisional file inventory

Expected core production surfaces:

- `packages/core/src/runbook/delegation-token.ts`
- `packages/core/src/runbook/types.ts`
- `packages/core/src/schemas.ts`
- `packages/core/src/events/types.ts`
- `packages/core/src/runbook/delegation-service.ts`
- `packages/core/src/runbook/delegation-inference.ts`
- `packages/core/src/runbook/actors/delegation-issue-actor.ts`
- `packages/core/src/runbook/compiler.ts`
- `packages/core/src/runbook/actor-service.ts`
- `packages/core/src/runbook/lifecycle-command-service.ts`
- `packages/core/src/runbook/retry-hook.ts`, only until its PR 12 actor migration
- `packages/core/src/runbook/session-service.ts`

Expected CLI production surfaces:

- `packages/cli/src/helpers/runbook-pipeline.ts`
- `packages/cli/src/services/execution.ts`
- `packages/cli/src/commands/delegate.ts`
- `packages/cli/src/helpers/status-builder.ts`

Expected tests include the dedicated token, schema, create/retry delegation,
inference, issue actor, compiler, actor service, lifecycle service, session
service, run pipeline, execution, delegate, status, output-schema, and PR 12
multi-process suites. Update the inventory against fresh `origin/main` after PR
11 merges; do not treat this list as authorization for unrelated edits.

No SQLite DDL is expected for credential derivation. The descriptor lives in
the current run-state JSON model stored in `runs.state_json`. Add DDL only if a
later, separately justified operation-id protocol cannot be represented in the
machine-owned state and existing execution-attempt model.

## Stop conditions

Stop and raise the design question if any implementation requires:

- persisting a raw delegation token, claim bearer, claim secret, derived HMAC
  key, encrypted bearer blob, or bearer-equivalent reversible seed;
- deriving from a persisted hash or public coordinate without a live verified
  secret;
- placing the claim id or derivation callable in persisted XState context;
- letting bare status or an unauthorized echo deliver a credential;
- minting a second run-control claim after initialization used the first;
- guessing whether a retry response was observed;
- retaining a frontend-owned lifecycle or persistence decision; or
- weakening PR 11 authority, execution, aggregate commit, or recovery checks.

