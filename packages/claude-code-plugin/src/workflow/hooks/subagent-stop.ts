// src/workflow/hooks/subagent-stop.ts
import {
  assertDelegationTokenHash,
  DELEGATION_TOKEN_PREFIX,
  hashDelegationToken,
  readConsumedDelegationClosure,
  RunbookStateManager,
} from '@rundown-org/core';
import {
  DelegationActiveTokenMetadataSchema,
  DelegationActiveTokensMetadataSchema,
  type HookInput,
} from '../../shared/index.js';
import { Session } from '../../session.js';

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

type ConsumedDelegationToken =
  | {
      readonly kind: 'consumed';
      readonly tokenHash: string;
      readonly metadata: Record<string, unknown>;
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'tampered' };

async function consumeLegacyDelegationToken(
  session: Session,
  meta: Record<string, unknown>,
): Promise<ConsumedDelegationToken> {
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
  await session.set('metadata', rest);
  return { kind: 'consumed', tokenHash, metadata: rest };
}

function stripActiveTokensKey(meta: Record<string, unknown>): Record<string, unknown> {
  const { delegation_active_tokens: _activeTokens, ...rest } = meta;
  return rest;
}

async function consumeDelegationTokenForAgent(
  session: Session,
  input: HookInput,
): Promise<ConsumedDelegationToken> {
  const meta = await session.get('metadata');

  if (input.agent_id) {
    const rawMap = meta.delegation_active_tokens;
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
      return consumeLegacyDelegationToken(session, meta);
    }
    const parsedMap = DelegationActiveTokensMetadataSchema.safeParse(rawMap);
    if (!parsedMap.success) {
      return { kind: 'tampered' };
    }
    const map = parsedMap.data;
    if (!Object.hasOwn(map, input.agent_id)) {
      return consumeLegacyDelegationToken(session, meta);
    }
    const rawEntry = map[input.agent_id];
    const parsed = DelegationActiveTokenMetadataSchema.safeParse(rawEntry);
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
    const tokenHash = assertDelegationTokenHash(entry.tokenHash);

    const { [input.agent_id]: _removed, ...remaining } = map;
    // Hygiene: drop the entire `delegation_active_tokens` key when the last
    // entry is consumed. Leaving an empty object would parse fine on the next
    // read (the guard at line 248 treats {} the same as missing), but
    // removing it keeps the metadata blob minimal and easier to inspect.
    const nextMeta =
      Object.keys(remaining).length > 0
        ? { ...meta, delegation_active_tokens: remaining }
        : stripActiveTokensKey(meta);
    await session.set('metadata', nextMeta);
    return { kind: 'consumed', tokenHash, metadata: nextMeta };
  }

  return consumeLegacyDelegationToken(session, meta);
}

async function consumedDelegationStillRequiresClosure(
  cwd: string,
  tokenHash: string,
): Promise<boolean> {
  const manager = new RunbookStateManager(cwd);
  const states = await manager.list();
  return readConsumedDelegationClosure(states, tokenHash).requiresClosure;
}

// ---------------------------------------------------------------------------
// Hook handler
// ---------------------------------------------------------------------------

/**
 * Handle a SubagentStop hook by consuming any active delegation token and
 * emitting a violation requiring explicit closure via `rd pass`/`rd fail`.
 *
 * Reads (and consumes, once) active delegation token metadata from session
 * metadata at `input.cwd`. Identified hook payloads consume only their
 * matching `delegation_active_tokens[input.agent_id]` entry; legacy payloads
 * without `agent_id` consume the older global `delegation_active_token`.
 *
 * Outcome:
 * - **No active token** (`kind: 'none'`): returns `{}`.
 * - **Tampered metadata** (`kind: 'tampered'`): returns an `unknown`-state
 *   context message instructing the orchestrator to consult `rd status`.
 * - **Token consumed and closed**: returns `{}` when Rundown state shows the
 *   matching delegated child has already reached a terminal lifecycle or the
 *   delegation was cancelled.
 * - **Token consumed and still open** (default): returns a `violation`
 *   requiring the delegated work to be closed explicitly. The message covers
 *   both states the consumed token may be in: claimed (recovered via `rd pass`
 *   / `rd fail --claim-id`) or unclaimed (recovered via `rd delegate --retry`
 *   or `rd abort <token>`).
 *
 * Never destroys child runbook state.
 *
 * @param input - Hook event payload. `input.hook_event_name` gates execution,
 *   `input.cwd` opens the session, and optional `agent_id`/`session_id` scope
 *   per-agent token consumption.
 * @returns A promise for a {@link SubagentStopResult}.
 * @throws {Error} Rejects if session metadata I/O fails (e.g. the session file
 *   is unreadable, not writable, or corrupt).
 */
export async function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

  const session = new Session(input.cwd);
  const consumed = await consumeDelegationTokenForAgent(session, input);
  if (consumed.kind === 'none') {
    return {};
  }
  if (consumed.kind === 'tampered') {
    return {
      context:
        'Subagent stopped with an active delegation. Unable to verify child runbook state — check with `rd status`.',
    };
  }

  try {
    if (!(await consumedDelegationStillRequiresClosure(input.cwd, consumed.tokenHash))) {
      return {};
    }
  } catch {
    // Fall through to the explicit-closure violation when state inspection
    // cannot prove the delegation is already closed.
  }

  return {
    violation:
      'Delegated Rundown work was active when the subagent stopped. Run `rd status` to discover the active delegation, then close it explicitly: if a claim id was issued (the subagent ran `rd claim`), use `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`; if the token was never claimed, retry with `rd delegate --retry` or cancel with `rd abort <token>`.',
  };
}
