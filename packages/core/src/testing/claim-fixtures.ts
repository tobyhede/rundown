import {
  assertClaimLookupKey,
  assertClaimSecretHash,
  type ClaimRecord,
} from '../runbook/claim-id.js';
import { assertRunId } from '../runbook/run-id.js';

const DEFAULT_RUN_ID = assertRunId(`rd_${'0'.repeat(32)}`);
const DEFAULT_AT = '2026-01-01T00:00:00.000Z';

/**
 * Build a `ClaimRecord` fixture for tests.
 *
 * Mirrors the precedent in `src/testing/effective-vars.ts`: tests need an
 * ergonomic constructor that routes through the same brand seam as production,
 * so the claim-record shape stays in one place. Before this factory, twelve
 * suites each spelled the shape out independently, which is what made a required
 * field addition a twelve-file manual sweep — and what let fixtures behind
 * `as unknown as` casts rot silently (#519).
 *
 * NOT for tests that assert on schema validation outcomes or feed a real
 * `loadSession`: those must hand the parser a shape the type system would have
 * rejected, so they keep their raw literals deliberately.
 *
 * @param overrides - Fields to override on the default valid record.
 * @returns A structurally valid `ClaimRecord`.
 */
export function makeClaimRecord(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claimKey: assertClaimLookupKey(`rdclk_${'a'.repeat(32)}`),
    secretHash: assertClaimSecretHash(`sha256:${'b'.repeat(64)}`),
    controlledRunId: DEFAULT_RUN_ID,
    grants: [{ action: 'mutate-run', runId: DEFAULT_RUN_ID }],
    issuedAt: DEFAULT_AT,
    updatedAt: DEFAULT_AT,
    lastProgressAt: DEFAULT_AT,
    ...overrides,
  };
}
