import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
import { buildDelegateActorIngress } from '../../src/commands/delegate.js';

// Robust source-propagation driver: a pure exported helper that delegate uses to
// build its ActorIngress from the resolved source. Module-spying a first-party
// named export is unreliable under this package's jest config (`isolatedModules:
// true` + `useESM: true`), so the driver is a direct unit test of the helper —
// mirroring Task 6's `buildTransitionActorContext`. This FAILS to compile/run
// before Step 4 extracts the helper, which is what TDD-drives the migration.
describe('buildDelegateActorIngress threads the actor source', () => {
  it('tags ingress.source when a source is supplied', () => {
    expect(buildDelegateActorIngress('plugin')).toEqual({ source: 'plugin' });
    expect(buildDelegateActorIngress('mcp')).toEqual({ source: 'mcp' });
  });

  it('produces an empty ingress (no source) when the source is undefined', () => {
    expect(buildDelegateActorIngress(undefined)).toEqual({});
  });
});

// A coarse end-to-end pin that the flag is at least accepted on the delegate
// path (the behavioral effect of source is invisible at the CLI because
// deriveEffectiveRole ignores source — so the unit test above is the real
// driver; this only guards against the flag being rejected as unknown).
describe('delegate accepts --actor-source without error', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('accepts --actor-source plugin and proceeds to delegation resolution', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('--actor-source plugin delegate', workspace);

    // `simple.runbook.md` has no delegatable substep, so a bare delegate cannot
    // succeed. Pin the EXACT downstream outcome rather than just "not
    // INVALID_ACTOR_SOURCE": reaching RD-813 proves `--actor-source plugin`
    // passed option parsing AND actor-source ingress validation and entered the
    // delegation-resolution path. A weaker check would also pass on an
    // INVALID_ACTOR_SOURCE / unknown-option envelope.
    expect(result.stdout).not.toMatch(/unknown option/i);
    expect((JSON.parse(result.stdout) as { code?: string }).code).toBe('RD-813');
  });
});
