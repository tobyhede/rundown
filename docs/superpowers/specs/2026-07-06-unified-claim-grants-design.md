# Unified Claim Grants Design

## Context

Issue #574 replaces the superseded R4 public `runCapability` /
`claim_capability` design with a single public authority primitive:
`claim_id`.

The security problem remains: plaintext identifiers such as `run_id` and
persisted claim ids must not act as mutation authority. The replacement design
keeps the public API simple while moving authority checks into core-owned claim
verification and explicit grants.

## Design Decision

A claim is not an orchestrator claim or a delegated-child claim by kind. A claim
is a bearer authority record. After the presented `claim_id` proves possession
of its secret, the claim either grants the requested operation on the requested
target or it does not.

Core policy MUST NOT branch on a persisted `ClaimRecord.kind` such as
`orchestrator` or `delegated-child`. Those names are roles, not authority
primitives. Persisting them invites policy to infer permission from labels
instead of from explicit grants.

## Claim Shape

The persisted record stores a lookup key, a non-reusable proof of the bearer
secret, timestamps, and grants. It never stores the full bearer `claim_id`.

```typescript
interface ClaimRecord {
  readonly claimKey: ClaimLookupKey;
  readonly secretHash: ClaimSecretHash;
  readonly grants: readonly ClaimGrant[];
  readonly issuedAt: string;
  readonly updatedAt: string;
}
```

`claimKey` is a non-secret lookup value derived from or embedded in the public
`claim_id`. `secretHash` verifies the secret part of the bearer value using
constant-time comparison. The exact string encoding is an implementation detail,
but the persisted session file must not contain a reusable bearer credential.

## Grants

Grants are explicit permissions over resources. They are data, not roles.

Initial grant vocabulary:

```typescript
type ClaimGrant =
  | { readonly action: 'mutate-run'; readonly runId: RunId }
  | { readonly action: 'delegate-from-run'; readonly runId: RunId }
  | { readonly action: 'collect-for-run'; readonly runId: RunId }
  | { readonly action: 'abort-delegation'; readonly runId: RunId; readonly stepId?: string }
  | { readonly action: 'retry-delegation'; readonly runId: RunId; readonly stepId?: string }
  | {
      readonly action: 'report-delegation-result';
      readonly childRunId: RunId;
      readonly parentRunId: RunId;
      readonly tokenHash: DelegationTokenHash;
    };
```

`rundown run <runbook>` mints a claim with grants over the started run, such as
`mutate-run`, `delegate-from-run`, `collect-for-run`, and operator recovery
grants.

`rundown claim <delegation_token>` mints or refreshes a claim with grants over
the claimed child run, such as `mutate-run` for the child and
`report-delegation-result` for the parent linkage verified by the token.

The distinction between these records is the grant set, not a claim kind.

## Authorization Flow

All actor mutations accept `--claim-id <claim_id>`.

Core resolves and authorizes the command as follows:

1. Parse the bearer `claim_id`.
2. Resolve its non-secret lookup key to a persisted `ClaimRecord`.
3. Verify the presented secret against `secretHash`.
4. Resolve the requested mutation target from core state.
5. Ask whether any grant authorizes the exact operation on the exact target.
6. Refuse closed if parsing, lookup, proof verification, target resolution, or
   grant matching fails.

In pseudocode:

```typescript
function authorize(
  claim: VerifiedClaim,
  request: MutationRequest,
): AuthorizationDecision {
  return claim.grants.some((grant) => grantAllows(grant, request))
    ? { kind: 'allowed' }
    : { kind: 'denied', reason: 'claim_grant_required' };
}
```

No frontend constructs trusted actor context directly. CLI, MCP, and plugin
surfaces pass bearer claim evidence to core; core verifies it and derives the
authorization decision.

## Public API

`run_id` remains an identifier only.

`rundown run <runbook>` returns an initial `claim_id` for the created run.

`rundown claim <delegation_token>` returns a `claim_id` for the claimed child
work.

Mutating commands use a single authority shape:

```bash
rundown pass --claim-id "$CLAIM_ID"
rundown fail --claim-id "$CLAIM_ID"
rundown delegate --claim-id "$CLAIM_ID" --step 2.1
rundown collect --claim-id "$CLAIM_ID"
rundown abort --claim-id "$CLAIM_ID" --step 2.1
```

Read-only commands may still expose identifiers where useful, but identifiers
must not authorize mutation.

## Recovery

Abandoned child recovery is authorized by grants on the operator's current
claim. It is not modeled by reading or synthesizing the child's bearer secret.

For example, a claim with `abort-delegation` and `retry-delegation` grants may
abort or retry the delegation it controls. A child claim that only grants
`mutate-run` on the child and `report-delegation-result` cannot drive parent
pipeline recovery unless it also has an explicit grant for that action.

## Rejected Designs

Separate public `--run-capability` and `--claim-capability` flags are rejected.
They solve the bearer-secret problem but duplicate existing command concepts and
make the public API harder to reason about.

A persisted claim `kind` such as `orchestrator` or `delegated-child` is rejected.
It turns authorization into role-label branching. The policy question is always
whether the verified claim grants the requested action on the requested target.

## Acceptance Criteria

- `rundown run` returns a bearer `claim_id` usable for permitted mutations on
  the created run.
- `rundown claim <token>` returns a bearer `claim_id` usable for permitted
  mutations on the claimed child.
- All actor mutations accept `--claim-id`.
- Core rejects identifier-only mutation authority.
- Persisted session/run state stores only non-reusable claim proofs, lookup
  keys, grants, and linkage data.
- Reading `.rundown/session.json` does not reveal a reusable mutation
  credential.
- Authorization decisions are expressed as `VerifiedClaim + ClaimGrant[]`
  checks, not `ClaimRecord.kind` checks.
- Orchestrator/operator recovery is represented by explicit grants, not child
  impersonation.
- Documentation and tests no longer expose or require public
  `runCapability` / `claim_capability` credentials.
