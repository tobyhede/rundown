# Linux Network Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-deny Linux network isolation to the existing first-party `rd-landlock` sandbox helper, with explicit policy opt-in for network access and observable enforcement status.

**Architecture:** Keep runbook transition behavior in the existing core state machine untouched; this work is policy, sandbox DTO/protocol, command-observation plumbing, native helper enforcement, tests, and docs. The core TypeScript sandbox layer sends a typed network posture to `rd-landlock` over fd 3, the Rust helper installs a seccomp filter after Landlock filesystem restrictions and before fd-4 status + `exec`, and fd-4 status is parsed fail-closed when required network fields are absent or malformed.

**Tech Stack:** TypeScript, Zod, Jest, fast-check, XState observation effects, Rust 2021, `libc`, `landlock`, seccomp classic BPF installed with `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, filter_program)`, pnpm.

---

## Current Code Map

- `packages/core/src/policy/schema.ts`: Zod policy schema, `DEFAULT_POLICY`, Linux allow-list-only default derivation.
- `packages/core/src/policy/evaluator.ts`: effective policy lookup by runbook override; add typed network posture lookup here.
- `packages/core/src/sandbox/types.ts`: `SandboxOptions` and `SandboxExecutionResult`; add `SandboxNetworkPolicy`, `network`, `networkPolicy`, and `networkSandboxed`.
- `packages/core/src/sandbox/policy-mapper.ts`: maps effective policy to sandbox DTOs; add `network: evaluator.getEffectiveNetworkPolicy()` and raw-policy equivalent.
- `packages/core/src/sandbox/linux.ts`: `LandlockSpec`, `buildSpec`, fd-4 `parseStatus`, `LandlockSandbox.resolveStatus`; add network spec/status validation and result fields.
- `packages/core/src/runbook/executor.ts`: enforces the sandbox-unavailable fallback rules and copies sandbox result fields to `ExecutionResult`; add fail-closed behavior for `network: deny` when `sandboxStrict:false` would otherwise run unsandboxed.
- `packages/core/src/runbook/actors/command-exec-actor.ts`: copies `ExecutionResult` into command actor output; add network fields to completed and policy-denied outputs where applicable.
- `packages/core/src/events/types.ts` and `packages/core/src/events/execution-observation.ts`: carries `COMMAND_COMPLETED` observation payload fields; add network fields.
- `packages/core/src/runbook/actor-service.ts`: already spreads `collector.commandOutput` into `commandCompletedEffect`; no behavioral change expected beyond type compatibility.
- `packages/core/__tests__/policy/schema.test.ts`: schema/default tests.
- `packages/core/__tests__/policy/evaluator.test.ts`: effective policy tests.
- `packages/core/__tests__/sandbox/policy-mapper.test.ts`: sandbox DTO mapper tests.
- `packages/core/__tests__/sandbox/linux-spec-builder.test.ts`: fd-3 spec builder tests.
- `packages/core/__tests__/sandbox/linux-status.test.ts` and `linux-execute.test.ts`: fd-4 parser/result tests.
- `packages/core/__tests__/sandbox/linux-status.properties.test.ts`: property tests for status parsing.
- `packages/core/__tests__/runbook/actors/command-exec-actor.test.ts`, `packages/core/__tests__/events/command-completed-abi.test.ts`, `packages/core/__tests__/events/execution-observation.test.ts`: observation propagation tests.
- `native/rd-landlock/src/spec.rs`: fd-3 spec parser; add `NetworkPolicy`.
- `native/rd-landlock/src/status.rs`: fd-4 status serializer; add network field on `Applied`.
- `native/rd-landlock/src/main.rs`: apply Landlock, then seccomp network filter, then write status and exec.
- `native/rd-landlock/src/sys.rs`: only existing production Rust module allowed to use unsafe; add raw seccomp/prctl syscall helpers here.
- Create `native/rd-landlock/src/network.rs`: safe network policy enforcement wrapper and classic BPF program construction.
- `native/rd-landlock/tests/protocol.rs` and `tests/enforcement.rs`: Rust protocol/enforcement tests.
- `packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts`: TS real-helper integration tests.
- `docs/reference/security.md`: policy and sandbox user docs.

## Implementation Notes

- Do not change state-machine transition rules in `packages/core/src/runbook/compiler.ts` unless a compile error proves type propagation requires it. This feature is sandbox/policy/helper work.
- Classic seccomp cannot inspect pointed-to `struct sockaddr *` contents for `connect(2)` or `bind(2)`. The first implementation must enforce network denial by filtering socket-family creation: allow sockets created with the `AF_UNIX` domain, allow local metadata sockets created with the `AF_NETLINK` domain, and deny every other socket family with `EACCES`. Preserve AF_UNIX local IPC and AF_NETLINK local metadata operations. Deny io_uring entry points so `IORING_OP_SOCKET` cannot bypass the socket-family checks, and reject x32 syscall-number variants on x86_64 before the default allow path. Do not broadly deny `connect` or `bind` in this first implementation.
- The helper must fail closed: if `network: "deny"` is active and seccomp installation fails, write an fd-4 error status whose message starts with `network sandbox failed:` and do not exec.
- Core must also fail closed before spawning when OS sandboxing is requested, unavailable, `sandboxStrict:false`, and the effective network policy is `deny`. `sandboxStrict:false` may relax filesystem ABI-floor refusal, but it must not silently convert required network denial into network access. Unsandboxed execution remains available only through explicit sandbox disablement (`sandbox:false` / `--no-sandbox`) or an effective `network: allow` policy.
- macOS enforces the effective network posture through Seatbelt profile rules.
  When the policy is `network: 'deny'`, the generated profile denies
  `network-outbound` and `network-inbound`, and result DTOs report
  `networkPolicy: 'deny'` with `networkSandboxed: true`. When the policy is
  `network: 'allow'`, the profile allows those operations and result DTOs report
  `networkSandboxed: false`.
- Allowing `AF_NETLINK` is deliberate in the first implementation. It is a local
  kernel/userspace metadata channel rather than an IP exfiltration channel, and
  denying it breaks common local behavior such as `getifaddrs(3)`,
  `os.networkInterfaces()`, interface enumeration, and some NSS paths. The
  implementation must include at least one realistic compatibility test under
  `network: 'deny'` that exercises these local lookups.
- `--no-sandbox` and `--allow-all` already bypass sandbox execution at a higher level; do not add a state-machine special case for them.
- The plan intentionally contains no commit steps. The user explicitly requested no commit.

### Task 1: Policy Schema and Effective Network Posture

**Files:**
- Modify: `packages/core/src/policy/schema.ts`
- Modify: `packages/core/src/policy/evaluator.ts`
- Test: `packages/core/__tests__/policy/schema.test.ts`
- Test: `packages/core/__tests__/policy/evaluator.test.ts`

- [ ] **Step 1: Add failing schema tests for default-deny network posture**

Add these tests to `packages/core/__tests__/policy/schema.test.ts`:

```typescript
it('defaults omitted network policy to deny', () => {
  const result = parsePolicy({ version: 1 });

  expect(result.default.network).toBe('deny');
});

it('parses explicit default network allow', () => {
  const result = parsePolicy({
    version: 1,
    default: {
      network: 'allow',
    },
  });

  expect(result.default.network).toBe('allow');
});

it('parses runbook network override', () => {
  const result = parsePolicy({
    version: 1,
    overrides: [
      {
        runbook: 'deploy/*.runbook.md',
        network: 'allow',
      },
    ],
  });

  expect(result.overrides[0].network).toBe('allow');
});

it('rejects invalid network policy values', () => {
  expect(() =>
    parsePolicy({
      version: 1,
      default: {
        network: 'prompt',
      },
    }),
  ).toThrow();
});
```

Also add this assertion to the existing `DEFAULT_POLICY` block:

```typescript
it('denies network by default', () => {
  expect(DEFAULT_POLICY.default.network).toBe('deny');
});
```

Add this assertion to the existing `DEFAULT_POLICY_LINUX` block:

```typescript
it('preserves the canonical network default', () => {
  expect(DEFAULT_POLICY_LINUX.default.network).toBe(DEFAULT_POLICY.default.network);
});

it('preserves the canonical policy mode on Linux', () => {
  expect(DEFAULT_POLICY_LINUX.default.mode).toBe(DEFAULT_POLICY.default.mode);
});
```

- [ ] **Step 2: Add failing evaluator tests for effective network posture**

Add these tests near the evaluator metadata/effective-policy tests in `packages/core/__tests__/policy/evaluator.test.ts`:

```typescript
it('returns deny as the effective network policy by default', () => {
  const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

  expect(evaluator.getEffectiveNetworkPolicy()).toBe('deny');
});

it('returns the default network policy when no override matches', () => {
  const policy = parsePolicy({
    version: 1,
    default: {
      mode: 'prompted',
      network: 'allow',
      run: { allow: [], deny: [] },
      read: { allow: [], deny: [] },
      write: { allow: [], deny: [] },
      env: { allow: [], deny: [] },
    },
    overrides: [
      {
        runbook: 'deploy/*.runbook.md',
        network: 'deny',
      },
    ],
  });
  const evaluator = new PolicyEvaluator(policy, {
    repoRoot,
    runbookPath: 'test/local.runbook.md',
  });

  expect(evaluator.getEffectiveNetworkPolicy()).toBe('allow');
});

it('uses the matching runbook network override', () => {
  const policy = parsePolicy({
    version: 1,
    default: {
      mode: 'prompted',
      network: 'deny',
      run: { allow: [], deny: [] },
      read: { allow: [], deny: [] },
      write: { allow: [], deny: [] },
      env: { allow: [], deny: [] },
    },
    overrides: [
      {
        runbook: 'deploy/*.runbook.md',
        network: 'allow',
      },
    ],
  });
  const evaluator = new PolicyEvaluator(policy, {
    repoRoot,
    runbookPath: 'deploy/prod.runbook.md',
  });

  expect(evaluator.getEffectiveNetworkPolicy()).toBe('allow');
});
```

- [ ] **Step 3: Run policy tests and verify they fail for missing network support**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/policy/schema.test.ts packages/core/__tests__/policy/evaluator.test.ts
```

Expected: FAIL with TypeScript/runtime errors mentioning missing `network` fields or `getEffectiveNetworkPolicy`.

- [ ] **Step 4: Implement policy schema fields and typed evaluator method**

In `packages/core/src/policy/schema.ts`, add the network schema and type near `PolicyModeSchema`:

```typescript
/** Network sandbox posture for OS-sandboxed commands. */
export const NetworkPolicySchema = z.enum(['deny', 'allow']);
/** Inferred type from {@link NetworkPolicySchema}: `'deny' | 'allow'`. */
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
```

Extend `DefaultPolicySchema`:

```typescript
  /** Network access posture for sandboxed commands */
  network: NetworkPolicySchema.default('deny'),
```

Extend `PolicyOverrideSchema`:

```typescript
  /** Override network access posture */
  network: NetworkPolicySchema.optional(),
```

Add `network: 'deny'` to `PolicyConfigSchema`'s default policy object and to `DEFAULT_POLICY.default`.

Do not rewrite the `default` object in `toAllowListOnly` by explicit field
listing. The current `default: { ...policy.default, run, read, write, env }`
spread is load-bearing: it preserves `mode` and any future scalar defaults while
still replacing the mutable rule objects. Because `network` is a string
primitive, the existing spread copies it safely. Only keep the existing spread
and ensure the replacement rule objects remain deep-copied:

```typescript
    default: {
      ...policy.default,
      run: {
        allow: Array.from(policy.default.run.allow),
        deny: Array.from(policy.default.run.deny),
      },
      read: {
        allow: Array.from(policy.default.read.allow),
        deny: [],
      },
      write: {
        allow: Array.from(policy.default.write.allow),
        deny: [],
      },
      env: {
        allow: Array.from(policy.default.env.allow),
        deny: Array.from(policy.default.env.deny),
      },
    },
```

In `packages/core/src/policy/evaluator.ts`, import the type:

```typescript
import {
  type NetworkPolicy,
  type PolicyConfig,
  type PolicyGrant,
  type PermissionRules,
  getDefaultPolicy,
} from './schema.js';
```

Add this public method before `getEffectiveRules`:

```typescript
  /**
   * Get the effective network sandbox posture, applying runbook overrides.
   *
   * Network posture is not a glob-rule permission. It is a coarse sandbox
   * capability setting: `deny` installs network isolation, `allow` skips it.
   *
   * @returns The effective network policy for the current runbook
   */
  getEffectiveNetworkPolicy(): NetworkPolicy {
    if (this.options.runbookPath) {
      for (const override of this.policy.overrides) {
        if (picomatch.isMatch(this.options.runbookPath, override.runbook) && override.network) {
          return override.network;
        }
      }
    }
    return this.policy.default.network;
  }
```

- [ ] **Step 5: Run policy tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/policy/schema.test.ts packages/core/__tests__/policy/evaluator.test.ts
```

Expected: PASS.

### Task 2: Sandbox DTO, fd-3 Spec, fd-4 Status, and Result Parsing

**Files:**
- Modify: `packages/core/src/sandbox/types.ts`
- Modify: `packages/core/src/sandbox/policy-mapper.ts`
- Modify: `packages/core/src/sandbox/linux.ts`
- Test: `packages/core/__tests__/sandbox/policy-mapper.test.ts`
- Test: `packages/core/__tests__/sandbox/linux-spec-builder.test.ts`
- Test: `packages/core/__tests__/sandbox/linux-status.test.ts`
- Test: `packages/core/__tests__/sandbox/linux-execute.test.ts`
- Test: `packages/core/__tests__/sandbox/linux-status.properties.test.ts`

- [ ] **Step 1: Add failing mapper tests for `SandboxOptions.network`**

In `packages/core/__tests__/sandbox/policy-mapper.test.ts`, add:

```typescript
it('maps default effective network policy to sandbox options', () => {
  const evaluator = new PolicyEvaluator(DEFAULT_POLICY_LINUX);
  const options = policyToSandboxOptions(evaluator, { cwd: '/test' });

  expect(options.network).toBe('deny');
});

it('maps runbook network allow override to sandbox options', () => {
  const policy: PolicyConfig = {
    version: 1,
    default: DEFAULT_POLICY_LINUX.default,
    overrides: [
      {
        runbook: 'deploy/*.runbook.md',
        network: 'allow',
      },
    ],
    grants: [],
  };
  const evaluator = new PolicyEvaluator(policy, {
    repoRoot: '/repo',
    runbookPath: 'deploy/prod.runbook.md',
  });

  const options = policyToSandboxOptions(evaluator, {
    cwd: '/repo',
    repoRoot: '/repo',
  });

  expect(options.network).toBe('allow');
});
```

In the `policyConfigToSandboxOptions` describe block, add:

```typescript
it('maps raw policy default network posture', () => {
  const options = policyConfigToSandboxOptions(
    {
      version: 1,
      default: {
        mode: DEFAULT_POLICY_LINUX.default.mode,
        run: DEFAULT_POLICY_LINUX.default.run,
        read: DEFAULT_POLICY_LINUX.default.read,
        write: DEFAULT_POLICY_LINUX.default.write,
        env: DEFAULT_POLICY_LINUX.default.env,
        network: 'allow',
      },
      overrides: [],
      grants: [],
    },
    { cwd: '/repo' },
  );

  expect(options.network).toBe('allow');
});
```

- [ ] **Step 2: Add failing fd-3 spec builder tests**

Update the `base` fixture in `packages/core/__tests__/sandbox/linux-spec-builder.test.ts` with:

```typescript
  network: 'deny',
```

Add:

```typescript
it('serializes network posture to the helper spec', () => {
  (existsSync as jest.Mock).mockReturnValue(true);

  const denyOptions: SandboxOptions = {
    cwd: base.cwd,
    repoRoot: base.repoRoot,
    readOnlyPaths: base.readOnlyPaths,
    readWritePaths: base.readWritePaths,
    denyPaths: base.denyPaths,
    denyPatterns: base.denyPatterns,
    env: base.env,
    allowUnsandboxed: base.allowUnsandboxed,
    network: 'deny',
  };
  const allowOptions: SandboxOptions = {
    cwd: base.cwd,
    repoRoot: base.repoRoot,
    readOnlyPaths: base.readOnlyPaths,
    readWritePaths: base.readWritePaths,
    denyPaths: base.denyPaths,
    denyPatterns: base.denyPatterns,
    env: base.env,
    allowUnsandboxed: base.allowUnsandboxed,
    network: 'allow',
  };

  expect(buildSpec('x', denyOptions).network).toBe('deny');
  expect(buildSpec('x', allowOptions).network).toBe('allow');
});
```

- [ ] **Step 3: Add failing fd-4 status parser tests**

In `packages/core/__tests__/sandbox/linux-status.test.ts`, add:

```typescript
function optionsWithStatus(
  network: 'deny' | 'allow',
  statusLine: string,
  allowUnsandboxed: boolean = false,
): SandboxOptions {
  return {
    cwd: base.cwd,
    repoRoot: base.repoRoot,
    readOnlyPaths: base.readOnlyPaths,
    readWritePaths: base.readWritePaths,
    denyPaths: base.denyPaths,
    denyPatterns: base.denyPatterns,
    env: {
      PATH: base.env.PATH,
      FAKE_STATUS_LINE: statusLine,
      FAKE_EXIT: '0',
    },
    allowUnsandboxed,
    network,
  };
}

it('applied deny status carries network posture', async () => {
  const r = await sb().execute(
    'echo hi',
    optionsWithStatus('deny', '{"status":"applied","abi":3,"downgraded":false,"network":"deny"}'),
  );

  expect(r.policyDenied).toBe(false);
  expect(r.networkPolicy).toBe('deny');
  expect(r.networkSandboxed).toBe(true);
});

it('applied allow status reports network unsandboxed', async () => {
  const r = await sb().execute(
    'echo hi',
    optionsWithStatus(
      'allow',
      '{"status":"applied","abi":3,"downgraded":false,"network":"allow"}',
    ),
  );

  expect(r.policyDenied).toBe(false);
  expect(r.networkPolicy).toBe('allow');
  expect(r.networkSandboxed).toBe(false);
});

it('missing network on applied status fails closed', async () => {
  const r = await sb().execute(
    'echo hi',
    optionsWithStatus('deny', '{"status":"applied","abi":3,"downgraded":false}', true),
  );

  expect(r.policyDenied).toBe(true);
  expect(r.sandboxed).toBe(false);
});

it('wrong network value on applied status fails closed', async () => {
  const r = await sb().execute(
    'echo hi',
    optionsWithStatus(
      'deny',
      '{"status":"applied","abi":3,"downgraded":false,"network":"maybe"}',
      true,
    ),
  );

  expect(r.policyDenied).toBe(true);
  expect(r.sandboxed).toBe(false);
});
```

Update `packages/core/__tests__/sandbox/linux-execute.test.ts` applied status strings to include `"network":"deny"` and add expectations:

```typescript
expect(r.networkPolicy).toBe('deny');
expect(r.networkSandboxed).toBe(true);
```

For the `allow` case added above, expect `networkSandboxed` false.

- [ ] **Step 4: Update property tests to treat `network` as required on applied statuses**

In `packages/core/__tests__/sandbox/linux-status.properties.test.ts`, extend the near-valid arbitrary:

```typescript
const networkIshArb = fc.oneof(
  fc.constantFrom('deny', 'allow'),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(undefined),
);
```

Add `network: networkIshArb` to the `fc.record` shape.

In `expectSchemaValid`, update the applied branch:

```typescript
      expect(result.network === 'deny' || result.network === 'allow').toBe(true);
```

- [ ] **Step 5: Run sandbox tests and verify they fail before implementation**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/sandbox/policy-mapper.test.ts packages/core/__tests__/sandbox/linux-spec-builder.test.ts packages/core/__tests__/sandbox/linux-status.test.ts packages/core/__tests__/sandbox/linux-execute.test.ts packages/core/__tests__/sandbox/linux-status.properties.test.ts
```

Expected: FAIL with missing `network` properties and status parser rejection gaps.

- [ ] **Step 6: Implement TypeScript sandbox DTO and parser changes**

In `packages/core/src/sandbox/types.ts`, add:

```typescript
/** Network access posture for OS-sandboxed commands. */
export type SandboxNetworkPolicy = 'deny' | 'allow';
```

Extend `SandboxOptions`:

```typescript
  /** Network access posture for this sandboxed execution */
  network: SandboxNetworkPolicy;
```

Extend `SandboxExecutionResult`:

```typescript
  /** Effective network posture requested for this execution. */
  networkPolicy?: SandboxNetworkPolicy;

  /** True when the Linux helper reported that network denial was installed. */
  networkSandboxed?: boolean;
```

In `packages/core/src/sandbox/policy-mapper.ts`, set `network` in both mapper return objects:

```typescript
    network: evaluator.getEffectiveNetworkPolicy(),
```

and:

```typescript
    network: policy.default.network,
```

In `packages/core/src/sandbox/linux.ts`, update `LandlockSpec`:

```typescript
  network: 'deny' | 'allow';
```

Update `buildSpec`:

```typescript
    network: options.network,
```

Update `HelperStatus`:

```typescript
  | { status: 'applied'; abi: number; downgraded: boolean; network: 'deny' | 'allow' }
```

Add:

```typescript
function isNetworkPolicy(v: unknown): v is 'deny' | 'allow' {
  return v === 'deny' || v === 'allow';
}
```

Update `parseStatus` applied branch:

```typescript
      return isFiniteNumber(o.abi) &&
        o.abi >= 1 &&
        typeof o.downgraded === 'boolean' &&
        isNetworkPolicy(o.network)
        ? { status: 'applied', abi: o.abi, downgraded: o.downgraded, network: o.network }
        : null;
```

Update `resolveStatus` applied result:

```typescript
        networkPolicy: status.network,
        networkSandboxed: status.network === 'deny',
```

For deny-path preflight and sandbox-unavailable results in `execute`, include the requested posture for diagnostics:

```typescript
        networkPolicy: options.network,
        networkSandboxed: false,
```

Do not accept an applied status without `network`; that is a protocol violation.

- [ ] **Step 7: Audit test fixtures for required `network`**

Audit these files for manual `SandboxOptions` literals. Any actual
`SandboxOptions` fixture must include `network: 'deny'` unless the test is
specifically for `allow`. Some listed files mostly mock sandbox calls and may
not need edits; do not force changes where no `SandboxOptions` literal exists:

```text
packages/core/__tests__/sandbox/linux-status.test.ts
packages/core/__tests__/sandbox/linux-execute.test.ts
packages/core/__tests__/sandbox/linux-deny-preflight.test.ts
packages/core/__tests__/sandbox/linux-interrupt.test.ts
packages/core/__tests__/sandbox/linux-teardown.test.ts
packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts
packages/core/__tests__/runbook/executor.test.ts
packages/core/__tests__/runbook/executor-policy-gate.invariant.test.ts
```

Update `packages/core/__tests__/sandbox/fixtures/fake-helper.mjs` default status:

```javascript
const line =
  process.env.FAKE_STATUS_LINE ??
  '{"status":"applied","abi":3,"downgraded":false,"network":"deny"}';
```

- [ ] **Step 8: Run sandbox tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/sandbox/policy-mapper.test.ts packages/core/__tests__/sandbox/linux-spec-builder.test.ts packages/core/__tests__/sandbox/linux-status.test.ts packages/core/__tests__/sandbox/linux-execute.test.ts packages/core/__tests__/sandbox/linux-status.properties.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run core type checks immediately after making `SandboxOptions.network` required**

Run:

```bash
pnpm --filter @rundown-org/core check:types
```

Expected: PASS. This gate must run here, not only in the final sweep, because
manual `SandboxOptions` fixtures are spread across tests and type checking is
the fastest way to catch any fixture that omitted the new required `network`
field.

### Task 3: Executor Fail-Closed Behavior and Observation Plumbing

**Files:**
- Modify: `packages/core/src/runbook/executor.ts`
- Modify: `packages/core/src/runbook/actors/command-exec-actor.ts`
- Modify: `packages/core/src/events/types.ts`
- Modify: `packages/core/src/events/execution-observation.ts`
- Test: `packages/core/__tests__/runbook/executor-policy-gate.invariant.test.ts`
- Test: `packages/core/__tests__/runbook/actors/command-exec-actor.test.ts`
- Test: `packages/core/__tests__/events/command-completed-abi.test.ts`
- Test: `packages/core/__tests__/events/execution-observation.test.ts`

- [ ] **Step 1: Add failing executor tests for sandbox-unavailable network denial**

In `packages/core/__tests__/runbook/executor-policy-gate.invariant.test.ts`, extend `fakeEvaluator` so tests can control the effective network policy:

```typescript
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
```

Add these tests after the existing strict-default sandbox-unavailable invariant:

```typescript
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
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(isSandboxAvailableMock).not.toHaveBeenCalled();
  expect(executeWithSandboxMock).not.toHaveBeenCalled();
});
```

Update the existing test named `falls back to unsandboxed execution with warning when sandbox unavailable and not strict` in `packages/core/__tests__/runbook/executor.test.ts` so the policy has `network: 'allow'`. Use `parsePolicy` or a complete `PolicyConfig` object with `default.network = 'allow'`; do not keep a test that expects fallback while the effective network policy is `deny`.

- [ ] **Step 2: Run executor tests and verify they fail before implementation**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/runbook/executor-policy-gate.invariant.test.ts packages/core/__tests__/runbook/executor.test.ts
```

Expected: FAIL because `sandboxStrict:false` still runs unsandboxed when network policy is `deny`.

- [ ] **Step 3: Implement executor fail-closed behavior for network denial**

In `packages/core/src/runbook/executor.ts`, compute the effective network policy after `finalEnv` is built and before the sandbox branch:

```typescript
  const networkPolicy = evaluator.getEffectiveNetworkPolicy();
```

In the `if (sandbox)` block, keep the existing strict fail-closed branch. Immediately after that branch and before the best-effort warning, add:

```typescript
    if (networkPolicy === 'deny') {
      return {
        success: false,
        exitCode: POLICY_DENIED_EXIT_CODE,
        denialReason:
          'Sandbox unavailable: network policy is deny and cannot be enforced without the OS sandbox. ' +
          'Re-run with --no-sandbox for a trusted unsandboxed run, or set network: allow for this runbook.',
        policyDenied: true,
        sandboxed: false,
        networkPolicy,
        networkSandboxed: false,
      };
    }
```

Update the existing strict fail-closed return object to include:

```typescript
        networkPolicy,
        networkSandboxed: false,
```

Update the final unsandboxed return to include:

```typescript
    networkPolicy,
    networkSandboxed: false,
```

The behavior after this step must be:

- `sandbox:true`, unavailable, `sandboxStrict:true`: fail closed for filesystem and network enforcement.
- `sandbox:true`, unavailable, `sandboxStrict:false`, `network:'deny'`: fail closed for network enforcement.
- `sandbox:true`, unavailable, `sandboxStrict:false`, `network:'allow'`: allowed best-effort unsandboxed execution.
- `sandbox:false`: explicit trusted unsandboxed execution; do not query sandbox availability.

- [ ] **Step 4: Run executor tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/runbook/executor-policy-gate.invariant.test.ts packages/core/__tests__/runbook/executor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing actor and event propagation tests**

In `packages/core/__tests__/runbook/actors/command-exec-actor.test.ts`, update the existing successful sandboxed result fixture to include:

```typescript
        networkPolicy: 'deny',
        networkSandboxed: true,
```

Add expectations on the completed output:

```typescript
    expect(output.networkPolicy).toBe('deny');
    expect(output.networkSandboxed).toBe(true);
```

In `packages/core/__tests__/events/command-completed-abi.test.ts`, update the existing test input:

```typescript
      networkPolicy: 'deny',
      networkSandboxed: true,
```

Add payload assertions:

```typescript
      expect(effect.event.payload.networkPolicy).toBe('deny');
      expect(effect.event.payload.networkSandboxed).toBe(true);
```

In `packages/core/__tests__/events/execution-observation.test.ts`, add a focused test:

```typescript
it('copies network sandbox fields into COMMAND_COMPLETED payload', () => {
  const effect = commandCompletedEffect({
    kind: 'completed',
    command: 'node -e "0"',
    displayCommand: 'node -e "0"',
    success: true,
    result: 'pass',
    exitCode: 0,
    sandboxed: true,
    landlockAbi: 3,
    enforcementDowngraded: false,
    networkPolicy: 'deny',
    networkSandboxed: true,
    channels: [],
    position: { step: 1 },
  });

  expect(effect.event.type).toBe('COMMAND_COMPLETED');
  if (effect.event.type === 'COMMAND_COMPLETED') {
    expect(effect.event.payload.networkPolicy).toBe('deny');
    expect(effect.event.payload.networkSandboxed).toBe(true);
  }
});
```

- [ ] **Step 6: Run propagation tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/runbook/actors/command-exec-actor.test.ts packages/core/__tests__/events/command-completed-abi.test.ts packages/core/__tests__/events/execution-observation.test.ts
```

Expected: FAIL with missing fields on output/payload.

- [ ] **Step 7: Implement propagation fields**

In `packages/core/src/runbook/executor.ts`, extend `ExecutionResult`:

```typescript
  /** Effective network posture requested for sandboxed execution. */
  networkPolicy?: 'deny' | 'allow';
  /** True when network denial was installed by the Linux helper. */
  networkSandboxed?: boolean;
```

In the sandboxed return object from `executeCommandWithPolicy`, add:

```typescript
        networkPolicy: result.networkPolicy,
        networkSandboxed: result.networkSandboxed,
```

The sandbox-unavailable and final unsandboxed return objects already received `networkPolicy` and `networkSandboxed` in Step 3. Keep those fields in place.

In `packages/core/src/runbook/actors/command-exec-actor.ts`, extend `CommandExecutionCompletedOutput`:

```typescript
  /** Effective network posture requested for sandboxed execution. */
  readonly networkPolicy?: 'deny' | 'allow';
  /** True when network denial was installed by the Linux helper. */
  readonly networkSandboxed?: boolean;
```

Extend `CommandExecutionPolicyDeniedOutput` with the same fields because sandbox protocol failures can be policy-denial-shaped.

Copy fields into both actor output branches:

```typescript
        networkPolicy: result.networkPolicy,
        networkSandboxed: result.networkSandboxed,
```

In `packages/core/src/events/types.ts`, extend `CommandCompletedPayload`:

```typescript
  /** Effective network posture requested for sandboxed execution. */
  readonly networkPolicy?: 'deny' | 'allow';
  /** True when network denial was installed by the Linux helper. */
  readonly networkSandboxed?: boolean;
```

In `packages/core/src/events/execution-observation.ts`, extend `commandCompletedEffect` payload:

```typescript
        networkPolicy: input.networkPolicy,
        networkSandboxed: input.networkSandboxed,
```

- [ ] **Step 8: Run propagation tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/runbook/actors/command-exec-actor.test.ts packages/core/__tests__/events/command-completed-abi.test.ts packages/core/__tests__/events/execution-observation.test.ts
```

Expected: PASS.

### Task 4: Rust Helper Spec, Status, and Seccomp Installer

**Files:**
- Modify: `native/rd-landlock/Cargo.toml`
- Modify: `native/rd-landlock/src/spec.rs`
- Modify: `native/rd-landlock/src/status.rs`
- Modify: `native/rd-landlock/src/main.rs`
- Modify: `native/rd-landlock/src/sys.rs`
- Create: `native/rd-landlock/src/network.rs`
- Test: `native/rd-landlock/src/spec.rs`
- Test: `native/rd-landlock/src/status.rs`
- Test: `native/rd-landlock/src/sys.rs`
- Test: `native/rd-landlock/src/network.rs`
- Test: `native/rd-landlock/tests/protocol.rs`

- [ ] **Step 1: Add failing Rust spec/status tests**

In `native/rd-landlock/src/spec.rs`, add tests:

```rust
#[test]
fn network_defaults_to_deny() {
    let spec = parse_spec(r#"{"command":"true"}"#).expect("parse");
    assert_eq!(spec.network, NetworkPolicy::Deny);
}

#[test]
fn parses_network_allow() {
    let spec = parse_spec(r#"{"command":"true","network":"allow"}"#).expect("parse");
    assert_eq!(spec.network, NetworkPolicy::Allow);
}

#[test]
fn rejects_invalid_network_value() {
    let err = parse_spec(r#"{"command":"true","network":"maybe"}"#).unwrap_err();
    assert!(err.contains("invalid spec JSON"), "error: {err}");
}
```

Update the proptest `Ok(spec)` branch to touch `spec.network`:

```rust
let _ = (spec.command, spec.strict, spec.ro, spec.rox, spec.rw, spec.network);
```

In `native/rd-landlock/src/status.rs`, change the applied status test expectation to include network:

```rust
let line = to_status_line(&Status::Applied {
    abi: 3,
    downgraded: false,
    network: NetworkPolicy::Deny,
});
assert_eq!(
    line,
    "{\"status\":\"applied\",\"abi\":3,\"downgraded\":false,\"network\":\"deny\"}\n"
);
```

Also add:

```rust
#[test]
fn applied_line_can_report_network_allow() {
    let line = to_status_line(&Status::Applied {
        abi: 3,
        downgraded: false,
        network: NetworkPolicy::Allow,
    });
    assert_eq!(
        line,
        "{\"status\":\"applied\",\"abi\":3,\"downgraded\":false,\"network\":\"allow\"}\n"
    );
}
```

- [ ] **Step 2: Run Rust unit tests and verify they fail**

Run:

```bash
cargo test --manifest-path native/rd-landlock/Cargo.toml
```

Expected: FAIL with missing `NetworkPolicy` and `network` fields.

- [ ] **Step 3: Implement Rust spec and status network fields**

In `native/rd-landlock/src/spec.rs`, add:

```rust
use serde::{Deserialize, Serialize};

/// Network access posture requested by core.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum NetworkPolicy {
    /// Install the seccomp network-denial filter before exec.
    Deny,
    /// Do not install the network filter.
    Allow,
}

fn default_network() -> NetworkPolicy {
    NetworkPolicy::Deny
}
```

Change the existing import from `use serde::Deserialize;` to the combined import above.

Extend `Spec`:

```rust
    /// Network posture. Defaults closed for older/malformed callers.
    #[serde(default = "default_network")]
    pub network: NetworkPolicy,
```

In `native/rd-landlock/src/status.rs`, import the enum:

```rust
use crate::spec::NetworkPolicy;
```

Extend `Status::Applied`:

```rust
    Applied {
        abi: u32,
        downgraded: bool,
        network: NetworkPolicy,
    },
```

- [ ] **Step 4: Create seccomp network module with AF_UNIX-preserving filter**

In `native/rd-landlock/src/main.rs`, add:

```rust
mod network;
```

Create `native/rd-landlock/src/network.rs`:

```rust
//! Network sandboxing via classic seccomp-BPF.
//!
//! Classic seccomp can inspect syscall numbers and integer arguments, but it
//! cannot dereference `struct sockaddr *` pointers. The first network sandbox
//! therefore filters socket-family creation: AF_UNIX sockets remain available
//! for local IPC, AF_NETLINK remains available for local kernel metadata
//! queries, every other socket family fails with EACCES, and alternate socket
//! creation paths through io_uring are denied. It does not revoke inherited or
//! pre-opened file descriptors, and AF_UNIX remains capable of receiving file
//! descriptors via SCM_RIGHTS from a cooperating local process.

use crate::spec::NetworkPolicy;
use crate::sys;

/// Apply the requested network policy to the current process.
pub fn apply_network_policy(policy: NetworkPolicy) -> Result<NetworkPolicy, String> {
    match policy {
        NetworkPolicy::Allow => Ok(NetworkPolicy::Allow),
        NetworkPolicy::Deny => {
            sys::install_network_seccomp_filter()
                .map_err(|e| format!("network sandbox failed: {e}"))?;
            Ok(NetworkPolicy::Deny)
        }
    }
}
```

In `native/rd-landlock/src/sys.rs`, implement seccomp through small, unit-tested builder functions rather than a single handwritten filter vector. Keep all raw `unsafe` syscalls in `sys.rs`.

Required implementation units:

- `SeccompAction`: local enum or constants for `Allow`, `KillProcess`, and `Errno(EACCES)`.
- `SocketFilterRule`: local enum or struct that represents the intended rule before it is lowered to `libc::sock_filter`.
- `build_network_filter_rules()`: returns a typed rule list with these semantics:
  - architecture mismatch kills the process;
  - `socket(AF_UNIX, type, protocol)` is allowed;
  - `socket(AF_NETLINK, type, protocol)` is allowed for local kernel metadata queries;
  - every other `socket()` address family is denied with `EACCES`;
  - `io_uring_setup`, `io_uring_enter`, and `io_uring_register` are denied with `EACCES`;
  - x32 syscall-number variants on x86_64 are rejected before the default allow path;
  - every other non-socket syscall remains allowed unless explicitly handled by this filter;
  - if `socketpair` filtering is included, `socketpair(AF_UNIX, type, protocol, sv)` is allowed and every other `socketpair()` address family is denied with `EACCES`.
- `lower_network_filter_rules()`: converts the typed rule list into `libc::sock_filter` and owns all jump-offset calculation. This function must have unit tests that prove every rule target is reachable.
- `install_network_seccomp_filter()`: sets `PR_SET_NO_NEW_PRIVS`, installs the lowered filter with `PR_SET_SECCOMP`, and returns a descriptive `Err(String)` on failure.

Add unit tests in `native/rd-landlock/src/sys.rs` before wiring the installer into `main.rs`:

```rust
#[test]
fn network_filter_plan_allows_af_unix_socket() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socket as i64, libc::AF_UNIX as u64),
        SimulatedAction::Allow
    );
}

#[test]
fn network_filter_plan_denies_af_inet_socket() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socket as i64, libc::AF_INET as u64),
        SimulatedAction::Errno(libc::EACCES)
    );
}

#[test]
fn network_filter_plan_denies_af_inet6_socket() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socket as i64, libc::AF_INET6 as u64),
        SimulatedAction::Errno(libc::EACCES)
    );
}

#[test]
fn network_filter_plan_allows_af_netlink_socket() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socket as i64, libc::AF_NETLINK as u64),
        SimulatedAction::Allow
    );
}

#[test]
fn network_filter_plan_denies_unclassified_socket_family_by_default() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socket as i64, 9999),
        SimulatedAction::Errno(libc::EACCES)
    );
}

#[test]
fn network_filter_plan_leaves_unrelated_syscalls_allowed() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_getpid as i64, 0),
        SimulatedAction::Allow
    );
}
```

If the implementation includes `socketpair` filtering, add both tests below. If the initial implementation deliberately omits `socketpair`, add a code comment in `build_network_filter_rules()` explaining that omission and rely on the integration test backlog to track it.

```rust
#[test]
fn network_filter_plan_allows_af_unix_socketpair_when_socketpair_is_filtered() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socketpair as i64, libc::AF_UNIX as u64),
        SimulatedAction::Allow
    );
}

#[test]
fn network_filter_plan_denies_af_inet_socketpair_when_socketpair_is_filtered() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socketpair as i64, libc::AF_INET as u64),
        SimulatedAction::Errno(libc::EACCES)
    );
}

#[test]
fn network_filter_plan_denies_af_netlink_socketpair_when_socketpair_is_filtered() {
    let rules = build_network_filter_rules();
    assert_eq!(
        simulate_network_filter(&rules, libc::SYS_socketpair as i64, libc::AF_NETLINK as u64),
        SimulatedAction::Errno(libc::EACCES)
    );
}
```

The `simulate_network_filter` helper is test-only. It should evaluate the typed rule list, not execute BPF. Its purpose is to lock the intended policy before lowering to `libc::sock_filter`. The lowered instruction tests must separately assert that all jump targets are in bounds and no handled branch is unreachable.

If a reviewed crate-level abstraction is already available in this repository when the work is implemented, prefer that abstraction over handwritten jump offset logic. Do not add a new dependency only to avoid writing tests.

- [ ] **Step 5: Wire helper order: Landlock first, seccomp second, status third**

In `native/rd-landlock/src/main.rs`, update the `Decision::Apply` branch:

```rust
        Decision::Apply { downgraded } => {
            ruleset::apply_ruleset(negotiated, &spec)
                .map_err(|e| Status::Error { message: e })?;
            let network = network::apply_network_policy(spec.network)
                .map_err(|e| Status::Error { message: e })?;
            Ok((
                Status::Applied {
                    abi: negotiated,
                    downgraded,
                    network,
                },
                spec,
            ))
        }
```

This preserves the required order:

1. parse spec,
2. negotiate ABI,
3. decide strict filesystem enforcement,
4. apply Landlock filesystem ruleset,
5. install seccomp if `network: deny`,
6. write fd-4 status,
7. exec.

- [ ] **Step 6: Add protocol tests for helper status wire**

In `native/rd-landlock/tests/protocol.rs`, add:

```rust
#[test]
fn omitted_network_defaults_to_deny_before_enforcement_attempt() {
    let spec = serde_json::json!({
        "command": "true",
        "strict": true,
        "ro": [],
        "rox": [],
        "rw": [],
    })
    .to_string();

    let (status, _code) = run_spec(&spec);
    // On a host that can enforce Landlock+seccomp this may be applied; on a
    // host without enforcement it may be denied/error. The important protocol
    // guarantee for omitted network is covered by spec.rs unit tests.
    assert!(
        status.contains("\"status\":\"") && !status.trim().is_empty(),
        "status: {status}"
    );
}
```

Do not assert seccomp success in this ungated protocol test; machines without Landlock or seccomp would make it flaky.

- [ ] **Step 7: Run Rust tests**

Run:

```bash
cargo test --manifest-path native/rd-landlock/Cargo.toml
```

Expected: PASS on normal hosts for unit/protocol tests. Ignored real-enforcement tests remain ignored.

### Task 5: Real Linux Network Enforcement Integration Tests

**Files:**
- Modify: `native/rd-landlock/tests/enforcement.rs`
- Modify: `packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts`

- [ ] **Step 1: Add ignored Rust enforcement tests for TCP denial and AF_UNIX preservation**

In `native/rd-landlock/tests/enforcement.rs`, add helper command builders if needed:

```rust
fn python_available_command(script: &str) -> String {
    format!("python3 -c {}", shell_single_quote(script))
}
```

Add ignored tests:

```rust
#[test]
#[ignore = "requires a real Landlock >= v3 kernel and seccomp filter support"]
fn network_deny_blocks_tcp_socket_creation() {
    let spec = serde_json::json!({
        "command": python_available_command(
            "import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)"
        ),
        "strict": true,
        "network": "deny",
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();

    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
    assert!(status.contains("\"network\":\"deny\""), "status: {status}");
    assert_ne!(code, 0, "AF_INET socket creation must be blocked");
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel and seccomp filter support"]
fn network_deny_allows_af_unix_socket_creation() {
    let spec = serde_json::json!({
        "command": python_available_command(
            "import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.close()"
        ),
        "strict": true,
        "network": "deny",
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();

    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
    assert!(status.contains("\"network\":\"deny\""), "status: {status}");
    assert_eq!(code, 0, "AF_UNIX socket creation must remain available");
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel and seccomp filter support"]
fn network_allow_does_not_block_tcp_socket_creation() {
    let spec = serde_json::json!({
        "command": python_available_command(
            "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.close()"
        ),
        "strict": true,
        "network": "allow",
        "rox": SYSTEM_ROX,
        "ro": ["/etc"],
    })
    .to_string();

    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
    assert!(status.contains("\"network\":\"allow\""), "status: {status}");
    assert_eq!(code, 0, "network allow must not install the socket filter");
}
```

- [ ] **Step 2: Add TypeScript real-helper integration tests**

In `packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts`, update the `run` helper to accept network:

```typescript
    const run = (
      command: string,
      readOnlyPaths: string[],
      readWritePaths: string[] = [],
      network: 'deny' | 'allow' = 'deny',
    ) =>
      sandbox.execute(command, {
        cwd: grantedDir,
        repoRoot: root,
        readOnlyPaths,
        readWritePaths,
        denyPaths: [],
        denyPatterns: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        allowUnsandboxed: false,
        network,
      } satisfies SandboxOptions);
```

Add tests inside the available describe block:

```typescript
it('blocks AF_INET socket creation when network is denied', async () => {
  const result = await run(
    `python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)'`,
    [grantedDir],
    [],
    'deny',
  );

  expect(result.sandboxed).toBe(true);
  expect(result.networkPolicy).toBe('deny');
  expect(result.networkSandboxed).toBe(true);
  expect(result.success).toBe(false);
  expect(result.exitCode).not.toBe(0);
});

it('allows AF_UNIX socket creation when network is denied', async () => {
  const result = await run(
    `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.close()'`,
    [grantedDir],
    [],
    'deny',
  );

  expect(result.sandboxed).toBe(true);
  expect(result.networkPolicy).toBe('deny');
  expect(result.networkSandboxed).toBe(true);
  expect(result.success).toBe(true);
  expect(result.exitCode).toBe(0);
});

it('does not block AF_INET socket creation when network is allowed', async () => {
  const result = await run(
    `python3 -c 'import socket; s=socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.close()'`,
    [grantedDir],
    [],
    'allow',
  );

  expect(result.sandboxed).toBe(true);
  expect(result.networkPolicy).toBe('allow');
  expect(result.networkSandboxed).toBe(false);
  expect(result.success).toBe(true);
  expect(result.exitCode).toBe(0);
});

it('keeps a realistic local runtime command working when network is denied', async () => {
  const result = await run(
    `node -e 'require("os").userInfo(); require("os").networkInterfaces();'`,
    [grantedDir],
    [],
    'deny',
  );

  expect(result.sandboxed).toBe(true);
  expect(result.networkPolicy).toBe('deny');
  expect(result.networkSandboxed).toBe(true);
  expect(result.success).toBe(true);
  expect(result.exitCode).toBe(0);
});
```

If CI images do not guarantee `python3`, guard these tests with a local availability check:

```typescript
const hasPython3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
```

and use `it.skip` only when `hasPython3` is false. Do not skip when `RUNDOWN_REQUIRE_LANDLOCK=1`.

The local runtime compatibility test is expected to pass because the first
filter deliberately allows `AF_NETLINK`. If it fails, stop and inspect the
syscall failure before changing assertions; a failure likely means the filter
blocked a local metadata path that the design intended to preserve.

- [ ] **Step 3: Run gated integration tests on a Linux Landlock host**

Run:

```bash
pnpm --filter @rundown-org/core build:native
RUNDOWN_REQUIRE_LANDLOCK=1 pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts
cargo test --manifest-path native/rd-landlock/Cargo.toml --test enforcement -- --ignored
```

Expected: PASS on a Linux host with Landlock >= v3 and seccomp filter support. On non-Linux or unsupported local hosts, run without `RUNDOWN_REQUIRE_LANDLOCK=1` and expect the TS suite to skip with an availability reason.

### Task 6: Documentation

**Files:**
- Modify: `docs/reference/security.md`
- Modify: `docs/superpowers/specs/2026-07-04-linux-network-sandbox-design.md` only if the implemented behavior intentionally differs from the spec

- [ ] **Step 1: Update security reference docs**

In `docs/reference/security.md`, add a Linux network sandbox subsection near the OS sandbox policy section:

````markdown
### Linux Network Sandbox

On Linux, sandboxed commands run with filesystem restrictions from the bundled
`rd-landlock` helper and network access denied by default. The network sandbox
uses seccomp to allow only local Unix-domain IPC and netlink metadata socket
families before the command is executed. It also denies io_uring entry points so
commands cannot create sockets through `IORING_OP_SOCKET`.

Policy files can opt a trusted runbook into network access:

```yaml
default:
  network: deny

overrides:
  - runbook: "deploy/*.runbook.md"
    network: allow
```

`network: deny` is the default when the field is omitted. `network: allow`
skips the network filter but keeps filesystem sandboxing enabled.

The first Linux implementation preserves `AF_UNIX` sockets for local IPC.
It also preserves `AF_NETLINK` for local kernel metadata operations such as
interface enumeration.
Classic seccomp cannot inspect `sockaddr` pointer contents passed to
`connect(2)` or `bind(2)`, so Rundown filters socket-family creation instead of
claiming host, port, or protocol-level network rules. On x86_64, the filter
also rejects x32 syscall-number variants before the default allow path.
The filter does not revoke inherited or pre-opened file descriptors. Because
`AF_UNIX` remains available for local IPC, a cooperating local process can still
transfer an already-open descriptor through `SCM_RIGHTS`; do not treat
`network: deny` as a boundary against such cooperation.

`--no-sandbox` disables both filesystem and network sandboxing. `--allow-all`
is a broader trust mode that bypasses policy and sandboxing.

macOS caveat: the `network` policy field is parsed on every platform, but the
mechanism is backend-specific. On macOS, the Seatbelt profile emits
`(deny network-outbound)` and `(deny network-inbound)` for effective
`network: deny`; sandboxed macOS commands report `networkPolicy: "deny"` with
`networkSandboxed: true`. `network: allow` emits the corresponding Seatbelt
network allow rules and reports `networkSandboxed: false`.
````

Use the four-backtick outer fence above so the nested YAML example remains valid Markdown.

- [ ] **Step 2: Run docs checks**

Run:

```bash
pnpm run check:md
pnpm run check:spell
```

Expected: PASS. If cspell flags `seccomp`, `AF_UNIX`, or `sockaddr`, add the terms to the repository spelling allow-list using the existing local convention; do not inline-disable the whole file.

### Task 7: Full Verification and Regression Sweep

**Files:**
- No new files unless a previous task revealed a focused missing test.

- [ ] **Step 1: Run focused TypeScript tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/policy/schema.test.ts packages/core/__tests__/policy/evaluator.test.ts packages/core/__tests__/sandbox/policy-mapper.test.ts packages/core/__tests__/sandbox/linux-spec-builder.test.ts packages/core/__tests__/sandbox/linux-status.test.ts packages/core/__tests__/sandbox/linux-execute.test.ts packages/core/__tests__/sandbox/linux-status.properties.test.ts packages/core/__tests__/runbook/actors/command-exec-actor.test.ts packages/core/__tests__/events/command-completed-abi.test.ts packages/core/__tests__/events/execution-observation.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Rust tests**

Run:

```bash
cargo test --manifest-path native/rd-landlock/Cargo.toml
```

Expected: PASS.

- [ ] **Step 3: Build native helper and core**

Run:

```bash
pnpm --filter @rundown-org/core build:native
pnpm --filter @rundown-org/core build
```

Expected: PASS.

- [ ] **Step 4: Run core type checks**

Run:

```bash
pnpm --filter @rundown-org/core check:types
```

Expected: PASS.

- [ ] **Step 5: Run full core unit test suite**

Run:

```bash
pnpm --filter @rundown-org/core test:unit
```

Expected: PASS.

- [ ] **Step 6: Run gated real enforcement on a suitable Linux host**

Run:

```bash
RUNDOWN_REQUIRE_LANDLOCK=1 pnpm --filter @rundown-org/core test:unit -- packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts
cargo test --manifest-path native/rd-landlock/Cargo.toml --test enforcement -- --ignored
```

Expected: PASS on CI/host with Landlock >= v3 and seccomp support. If unavailable locally, record the skip reason from `LandlockSandbox.getAvailability()` and rely on Linux CI for this step.

- [ ] **Step 7: Run repository pre-PR verification**

Run:

```bash
pnpm run verify
```

Expected: PASS.

## Self-Review Checklist

- [ ] Spec coverage: policy defaults and runbook overrides, sandbox DTO/spec/status, command observation fields, Rust seccomp enforcement, AF_UNIX preservation, integration tests, and docs are all represented by tasks.
- [ ] Linux default policy safety: `DEFAULT_POLICY_LINUX.default.mode` remains equal to `DEFAULT_POLICY.default.mode`; `toAllowListOnly` keeps `...policy.default` and does not fail open by dropping `mode`.
- [ ] Architecture: no task adds runbook behavior to CLI or bypasses the core sandbox/policy seams; state-machine transition rules remain untouched.
- [ ] Seccomp limitation: the plan explicitly avoids sockaddr-pointer inspection and starts by allowing only `AF_UNIX` and `AF_NETLINK` socket-family creation while denying io_uring socket creation bypass paths and x32 syscall-number variants.
- [ ] Platform truthfulness: macOS is documented as enforcing network deny through Seatbelt network rules and reporting `networkSandboxed:true` only when the Seatbelt sandbox is active with `network: deny`.
- [ ] Compatibility: at least one realistic local runtime command using local metadata lookups still works under `network: deny`.
- [ ] Fail-closed behavior: missing/malformed fd-4 network status fails closed; seccomp install failure reports an error status and prevents exec.
- [ ] Verification: focused tests, Rust tests, native build, type checks, gated Linux enforcement, docs checks, and `pnpm run verify` are listed with exact commands.
