/**
 * Seam invariant (CLI layer): `executeCommandWithPolicyCheck` routes every
 * command through the single core gate `executor.ts executeCommandWithPolicy`
 * whenever policy is enforced, and only skips it (the documented trust path)
 * when `isPolicyEnforced()` is false.
 *
 * Pinned invariant:
 *
 *   When policy enforcement is ON, the CLI never reaches the un-gated core
 *   `executeCommand` / `executeCommandWithEnv` directly — it delegates to
 *   `executeCommandWithPolicy` (which performs `checkCommand` before spawn).
 *   When enforcement is OFF (--allow-all / trust mode), the CLI takes the
 *   explicit un-gated path; that is the ONLY bypass.
 *
 * This complements the core-level invariants in
 * `packages/core/__tests__/runbook/executor-policy-gate.invariant.test.ts`,
 * which prove the gate itself never spawns on a deny. Here we prove the CLI
 * front end actually enters that gate rather than re-implementing a parallel
 * execution path.
 *
 * Mock strategy follows the package convention (see `execution-loop.test.ts`):
 * capture the real `@rundown-org/core` first, then spread it and override only
 * the three execution functions; spread the real `./policy-context.js` and
 * override only the policy getters.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ExecutionResult, PolicyEvaluator, PolicyPrompter } from '@rundown-org/core';

const RESULT: ExecutionResult = { success: true, exitCode: 0 };

// Capture the real modules before registering the mocks (unstable_mockModule
// does not hoist, so these top-level awaits run first).
const actualCore = await import('@rundown-org/core');
const actualPolicyContext = await import('../../src/services/policy-context.js');

const executeCommandMock = jest.fn<typeof actualCore.executeCommand>(async () => RESULT);
const executeCommandWithEnvMock = jest.fn<typeof actualCore.executeCommandWithEnv>(
  async () => RESULT,
);
const executeCommandWithPolicyMock = jest.fn<typeof actualCore.executeCommandWithPolicy>(
  async () => RESULT,
);

jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  executeCommand: executeCommandMock,
  executeCommandWithEnv: executeCommandWithEnvMock,
  executeCommandWithPolicy: executeCommandWithPolicyMock,
}));

const isPolicyEnforcedMock = jest.fn<() => boolean>();
const getPolicyEvaluatorMock = jest.fn<() => PolicyEvaluator>();
const getPolicyPrompterMock = jest.fn<() => PolicyPrompter>();
const getSandboxOptionsMock = jest.fn<() => { sandbox: boolean; sandboxStrict: boolean }>();

jest.unstable_mockModule('../../src/services/policy-context.js', () => ({
  ...actualPolicyContext,
  isPolicyEnforced: isPolicyEnforcedMock,
  getPolicyEvaluator: getPolicyEvaluatorMock,
  getPolicyPrompter: getPolicyPrompterMock,
  getSandboxOptions: getSandboxOptionsMock,
}));

// Import the unit under test AFTER mocks are registered.
const { executeCommandWithPolicyCheck } = await import('../../src/services/execution.js');

// A spied fake evaluator so we can assert the CLI handed OUR evaluator to the gate.
const fakeEvaluator = {
  setRunbookPath: jest.fn(),
  checkCommand: jest.fn(),
} as unknown as PolicyEvaluator;
const fakePrompter = {} as PolicyPrompter;

describe('executeCommandWithPolicyCheck — CLI seam invariant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPolicyEvaluatorMock.mockReturnValue(fakeEvaluator);
    getPolicyPrompterMock.mockReturnValue(fakePrompter);
    getSandboxOptionsMock.mockReturnValue({ sandbox: true, sandboxStrict: true });
  });

  // Property 5a — enforcement ON ⇒ routed through the gate (never the un-gated fns).
  it('routes through executeCommandWithPolicy when policy is enforced, never the un-gated path', async () => {
    isPolicyEnforcedMock.mockReturnValue(true);

    await executeCommandWithPolicyCheck('git status', '/work', 'deploy.runbook.md');

    expect(executeCommandWithPolicyMock).toHaveBeenCalledTimes(1);
    const [command, cwd, options] = executeCommandWithPolicyMock.mock.calls[0] as [
      string,
      string,
      { evaluator?: PolicyEvaluator; sandbox?: boolean; sandboxStrict?: boolean },
    ];
    expect(command).toBe('git status');
    expect(cwd).toBe('/work');
    // The gate must receive an evaluator — the gate's own no-evaluator trust
    // path must not be reachable from the enforced CLI branch.
    expect(options.evaluator).toBe(fakeEvaluator);
    expect(options.sandbox).toBe(true);
    expect(options.sandboxStrict).toBe(true);

    // The un-gated core functions are NOT called directly.
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(executeCommandWithEnvMock).not.toHaveBeenCalled();
  });

  // Property 5b — enforcement OFF ⇒ explicit trust path, gate not entered.
  it('takes the un-gated trust path (no gate, no evaluator lookup) when policy is NOT enforced', async () => {
    isPolicyEnforcedMock.mockReturnValue(false);

    await executeCommandWithPolicyCheck('git status', '/work', 'deploy.runbook.md');

    // The gate is never entered; the bypass requires enforcement to be off.
    expect(executeCommandWithPolicyMock).not.toHaveBeenCalled();
    expect(getPolicyEvaluatorMock).not.toHaveBeenCalled();
    // With no rdInjected, the no-env un-gated path is used.
    expect(executeCommandMock).toHaveBeenCalledWith('git status', '/work', undefined, {});
  });

  // Property 5b corollary — trust path with rdInjected still bypasses the gate.
  it('trust path with rdInjected uses executeCommandWithEnv but still skips the gate', async () => {
    isPolicyEnforcedMock.mockReturnValue(false);

    await executeCommandWithPolicyCheck('git status', '/work', undefined, {
      RD_WORK_PATH: '/work/.rundown',
    });

    expect(executeCommandWithPolicyMock).not.toHaveBeenCalled();
    expect(getPolicyEvaluatorMock).not.toHaveBeenCalled();
    expect(executeCommandWithEnvMock).toHaveBeenCalledTimes(1);
    const [command, cwd] = executeCommandWithEnvMock.mock.calls[0];
    expect(command).toBe('git status');
    expect(cwd).toBe('/work');
  });

  // Property 5a corollary — enforcement ON with rdInjected still routes through
  // the gate, forwarding rdInjected in the options (the enforced path is always
  // preferred; rdInjected never diverts to an un-gated branch).
  it('routes through executeCommandWithPolicy with rdInjected when policy is enforced', async () => {
    isPolicyEnforcedMock.mockReturnValue(true);

    await executeCommandWithPolicyCheck('git status', '/work', 'deploy.runbook.md', {
      RD_WORK_PATH: '/work/.rundown',
    });

    expect(executeCommandWithPolicyMock).toHaveBeenCalledTimes(1);
    const [, , options] = executeCommandWithPolicyMock.mock.calls[0] as [
      string,
      string,
      { rdInjected?: Record<string, string> },
    ];
    expect(options.rdInjected).toEqual({ RD_WORK_PATH: '/work/.rundown' });
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(executeCommandWithEnvMock).not.toHaveBeenCalled();
  });
});
