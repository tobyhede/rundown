// src/workflow/hooks/subagent-stop.ts
import {
  assertDelegationTokenHash,
  DELEGATION_TOKEN_PREFIX,
  hashDelegationToken,
  readConsumedDelegationClosureForCwd,
} from '@rundown-org/core';
import {
  DelegationActiveTokenMetadataSchema,
  DelegationActiveTokensMetadataSchema,
  type HookInput,
} from '../../shared/index.js';
import { Session, type SessionUpdateDecision } from '../../session.js';

/**
 * Result from handling a SubagentStop hook event.
 *
 * Returned by {@link handleSubagentStop} to communicate whether the subagent
 * stop produced actionable context or a policy/runtime violation.
 */
export interface SubagentStopResult {
  /** Summary of the action taken (e.g. delegation abort message). Undefined when no action was needed. */
  context?: string;
  /** Description of the policy or runtime error that caused the stop. Undefined when the subagent stopped normally. */
  violation?: string;
}

/**
 * Result of locating (without mutating) the stopping agent's delegation token
 * in session metadata.
 *
 * `found` carries the token hash plus `consumedMeta` — the metadata blob with
 * the located entry removed — which the caller persists ONLY once closure is
 * verified. Verify-before-consume (#470 defect 2): locating is pure, so a
 * re-fired SubagentStop finds the entry again while closure is still required.
 */
type LocatedDelegationToken =
  | { readonly kind: 'none' }
  | { readonly kind: 'tampered' }
  | {
      readonly kind: 'found';
      readonly tokenHash: string;
      /** Metadata with the located entry removed — persisted only once closure is verified. */
      readonly consumedMeta: Record<string, unknown>;
    };

function stripActiveTokensKey(meta: Record<string, unknown>): Record<string, unknown> {
  const { delegation_active_tokens: _activeTokens, ...rest } = meta;
  return rest;
}

/**
 * Locate the legacy global delegation token in session metadata without
 * mutating it. Pure: same validation as the previous consume path, but the
 * caller decides whether `consumedMeta` is ever persisted.
 *
 * @param meta - Session metadata blob
 * @returns Located token (with consumed-shape metadata), none, or tampered
 */
function locateLegacyDelegationToken(meta: Record<string, unknown>): LocatedDelegationToken {
  const raw = meta.delegation_active_token;
  const tokenHashValue = typeof raw === 'string' ? raw : undefined;
  if (!tokenHashValue) {
    return { kind: 'none' };
  }
  const normalizedTokenHashValue = tokenHashValue.startsWith(DELEGATION_TOKEN_PREFIX)
    ? hashDelegationToken(tokenHashValue)
    : tokenHashValue;
  let tokenHash: string;
  try {
    tokenHash = assertDelegationTokenHash(normalizedTokenHashValue);
  } catch {
    return { kind: 'tampered' };
  }
  const { delegation_active_token: _removed, ...rest } = meta;
  return { kind: 'found', tokenHash, consumedMeta: rest };
}

/**
 * Locate the stopping agent's delegation token in session metadata without
 * mutating it. Verifies the record is in the expected state (schema-valid,
 * agent identity matches, token hash canonical) BEFORE the caller may consume
 * it — an unverifiable record is `tampered`, never silently advanced past.
 *
 * @param meta - Session metadata blob
 * @param input - SubagentStop hook input carrying agent identity
 * @returns Located token (with consumed-shape metadata), none, or tampered
 */
function locateDelegationTokenForAgent(
  meta: Record<string, unknown>,
  input: HookInput,
): LocatedDelegationToken {
  if (!input.agent_id) {
    return locateLegacyDelegationToken(meta);
  }
  const rawMap = meta.delegation_active_tokens;
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return locateLegacyDelegationToken(meta);
  }
  const parsedMap = DelegationActiveTokensMetadataSchema.safeParse(rawMap);
  if (!parsedMap.success) {
    return { kind: 'tampered' };
  }
  const map = parsedMap.data;
  if (!Object.hasOwn(map, input.agent_id)) {
    return locateLegacyDelegationToken(meta);
  }
  const parsed = DelegationActiveTokenMetadataSchema.safeParse(map[input.agent_id]);
  if (!parsed.success) {
    return { kind: 'tampered' };
  }
  const entry = parsed.data;
  if (entry.agent_id !== input.agent_id) {
    return { kind: 'tampered' };
  }
  if (input.session_id && entry.session_id && entry.session_id !== input.session_id) {
    return { kind: 'tampered' };
  }
  // Defense-in-depth: the schema already validates tokenHash via the same
  // predicate, so the throw is unreachable today. Wrap anyway in case the
  // schema and assert diverge in future.
  let tokenHash: string;
  try {
    tokenHash = assertDelegationTokenHash(entry.tokenHash);
  } catch {
    return { kind: 'tampered' };
  }
  const { [input.agent_id]: _removed, ...remaining } = map;
  // Hygiene: drop the entire `delegation_active_tokens` key when the last
  // entry would be consumed, keeping the metadata blob minimal.
  const consumedMeta =
    Object.keys(remaining).length > 0
      ? { ...meta, delegation_active_tokens: remaining }
      : stripActiveTokensKey(meta);
  return { kind: 'found', tokenHash, consumedMeta };
}

async function consumedDelegationStillRequiresClosure(
  cwd: string,
  tokenHash: string,
): Promise<boolean> {
  const closure = await readConsumedDelegationClosureForCwd(
    cwd,
    assertDelegationTokenHash(tokenHash),
  );
  return closure.requiresClosure;
}

/** Outcome of the locked locate → verify → conditional-consume transaction. */
type SubagentStopOutcome = 'none' | 'closed' | 'tampered' | 'requires-closure';

const CLOSURE_VIOLATION =
  'Delegated Rundown work was active when the subagent stopped. Run `rundown status` to discover the active delegation, then close it explicitly in your own lane: if a claim id was issued (the subagent ran `rundown claim`), use `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`; if the token was never claimed, either claim and close it — `rundown claim <rdtk_…>` then `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>` — or leave it unclaimed and report the token back so the orchestrator can retry from its own bearer lane with `rundown delegate --retry <token> --claim-id <claim_id>`. Cancel with `rundown abort <token>`.';

const TAMPERED_VIOLATION =
  'Subagent stopped with an active delegation, but its session record could not be verified (corrupt or tampered metadata). Failing closed: run `rundown status` to inspect delegation state and close any open delegation explicitly before stopping.';

// ---------------------------------------------------------------------------
// Hook handler
// ---------------------------------------------------------------------------

/**
 * Handle a SubagentStop hook: verify-before-consume (#470 defect 2).
 *
 * Runs one locked transaction over session metadata: locate the stopping
 * agent's token (per-agent map, falling back to the legacy global key), verify
 * against Rundown state that the delegation no longer requires closure, and
 * only then consume the entry. When closure is still required — or cannot be
 * proven — the entry is deliberately KEPT so a re-fired SubagentStop
 * (stop_hook_active) finds it again and re-issues the block: the enforcement is
 * idempotent. `stop_hook_active` is intentionally not consulted as a bypass —
 * doing so would reintroduce the defect.
 *
 * Outcome:
 * - **No active token**: returns `{}`.
 * - **Verified closed**: consumes the entry and returns `{}`.
 * - **Still requires closure** (or closure unprovable): keeps the entry and
 *   returns a `violation` requiring explicit closure. The message is read by
 *   the stopping subagent (the child), so it keeps that agent in its own lane:
 *   claimed work is recovered via `rundown pass --claim-id` or
 *   `rundown fail --claim-id`, and an unclaimed token is either claimed and
 *   closed the same way, or reported back so the orchestrator retries it from
 *   its own bearer lane with
 *   `rundown delegate --retry <token> --claim-id <claim_id>` (or
 *   `rundown abort <token>`).
 *   The child is never told to name the parent run — that is the orchestrator's
 *   lane, not the child's.
 * - **Tampered metadata**: fails CLOSED with a `violation` (the record cannot
 *   be verified, so the stop must not be waved through).
 *
 * Never destroys child runbook state.
 *
 * @param input - Hook event payload. `input.hook_event_name` gates execution,
 *   `input.cwd` opens the session, and optional `agent_id`/`session_id` scope
 *   per-agent token verification.
 * @returns A promise for a {@link SubagentStopResult}.
 * @throws {Error} Rejects if session metadata I/O or locking fails (the
 *   on-subagent-stop gate converts this into a fail-closed block).
 */
export async function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

  const session = new Session(input.cwd);
  const outcome = await session.update(
    'metadata',
    async (meta): Promise<SessionUpdateDecision<Record<string, unknown>, SubagentStopOutcome>> => {
      const located = locateDelegationTokenForAgent(meta, input);
      if (located.kind !== 'found') {
        return { commit: false, result: located.kind === 'none' ? 'none' : 'tampered' };
      }
      let requiresClosure = true;
      try {
        requiresClosure = await consumedDelegationStillRequiresClosure(
          input.cwd,
          located.tokenHash,
        );
      } catch {
        // Closure could not be PROVEN — treat as still requiring closure and
        // keep the token so a re-fired SubagentStop re-issues the block.
      }
      if (requiresClosure) {
        return { commit: false, result: 'requires-closure' };
      }
      // Verified closed: consuming is now safe — a re-fired SubagentStop
      // correctly finds nothing and allows the stop.
      return { commit: true, value: located.consumedMeta, result: 'closed' };
    },
  );

  switch (outcome) {
    case 'none':
    case 'closed':
      return {};
    case 'tampered':
      return { violation: TAMPERED_VIOLATION };
    case 'requires-closure':
      return { violation: CLOSURE_VIOLATION };
  }
}
