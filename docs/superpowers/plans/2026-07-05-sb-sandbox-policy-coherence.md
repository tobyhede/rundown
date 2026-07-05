# SB Sandbox Policy Coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CLI `--allow-*` filesystem grants reach OS sandbox enforcement, normalize sandbox grant paths across macOS realpath aliases, and allow Seatbelt metadata traversal needed for Node module resolution under `/Users`.

**Architecture:** Keep the CLI a thin policy-context constructor: `--allow-*` continues to enter core through `PolicyEvaluatorOptions.cliGrants`. Core exposes a sandbox-facing effective rule view that includes runtime grants, the sandbox mapper canonicalizes grant roots once, and the macOS Seatbelt backend emits metadata-only ancestor permissions without granting file contents. Integration tests prove policy grants produce real syscall success under the platform sandbox.

**Tech Stack:** TypeScript / Node 24, Jest ESM tests, `@rundown-org/core` policy and sandbox layers, macOS Seatbelt (`sandbox-exec`), Linux Landlock helper integration tests.

---

## Scope

Issues: #549, #550, #552.

In scope:

- #550: CLI `--allow-read` and `--allow-write` grants must be visible to sandbox profile generation.
- #552: sandbox grant paths must be realpath-normalized so `/var/folders/...` and `/private/var/folders/...` match consistently.
- #549: Seatbelt profiles must include metadata-only read access for required `/Users` ancestors so Node can traverse to repo scripts and modules.
- Add integration coverage proving grant-to-syscall success.

Out of scope:

- Do not depend on R2 or R3 branches.
- Do not add CLI-specific sandbox workarounds.
- Do not alter command-step lifecycle/recovery semantics for #545/#547/#520.
- Do not migrate persisted runbook state.

## File Structure

### Modified

- `packages/core/src/policy/evaluator.ts` — expose sandbox-relevant read/write rules that include CLI and session grants while preserving `getEffectiveRules()` for existing policy-only callers, and separately identify higher-precedence runtime grants.
- `packages/core/src/sandbox/policy-mapper.ts` — use sandbox-relevant rules, canonicalize allow/deny roots, filter deny paths that are covered by higher-precedence runtime grants, compute metadata-only ancestor paths, and return them in `SandboxOptions`.
- `packages/core/src/sandbox/types.ts` — add `metadataReadPaths?: string[]` with TSDoc.
- `packages/core/src/sandbox/macos.ts` — emit `file-read-metadata` literal rules for `metadataReadPaths` and keep content grants scoped to read/read-write paths.
- `packages/core/__tests__/sandbox/policy-mapper.test.ts` — mapper regression coverage for CLI/session grants and canonical path behavior.
- `packages/core/__tests__/sandbox/macos.test.ts` — mocked Seatbelt profile coverage for metadata rules and canonical aliases.
- `packages/core/__tests__/sandbox/linux-spec-builder.test.ts` — prove Landlock ignores `metadataReadPaths` and still classifies read/write grants correctly.

### Created

- `packages/core/__tests__/sandbox/macos.enforcement.integration.test.ts` — real Seatbelt grant-to-syscall tests, skipped when not on macOS or Seatbelt is unavailable unless explicitly required.
- `packages/cli/__tests__/integration/sandbox-policy-grants.test.ts` — CLI command-step coverage proving `--allow-read` / `--allow-write` reach sandboxed execution on hosts with an available sandbox.

---

## Task 1: Make Runtime Grants Visible To Sandbox Mapping

**Files:**

- Modify: `packages/core/src/policy/evaluator.ts`
- Modify: `packages/core/src/sandbox/policy-mapper.ts`
- Test: `packages/core/__tests__/sandbox/policy-mapper.test.ts`

- [ ] **Step 1: Add failing mapper tests for CLI grants**

Add these tests inside `describe('policyToSandboxOptions', ...)` in `packages/core/__tests__/sandbox/policy-mapper.test.ts`:

```typescript
  it('includes CLI read grants in sandbox read-only paths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      cliGrants: { read: ['/repo/schema.json'] },
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readOnlyPaths).toContain('/repo/schema.json');
    expect(options.readWritePaths).not.toContain('/repo/schema.json');
  });

  it('includes CLI write grants in sandbox read-write paths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      cliGrants: { write: ['/repo/dist/**'] },
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readWritePaths).toContain('/repo/dist');
    expect(options.readOnlyPaths).not.toContain('/repo/dist');
  });

  it('does not emit deny paths that are covered by a higher-precedence CLI read grant', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: ['/repo/.env'] },
        write: { allow: [], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      cliGrants: { read: ['/repo/.env'] },
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readOnlyPaths).toContain('/repo/.env');
    expect(options.denyPaths).not.toContain('/repo/.env');
    expect(options.denyPatterns).not.toContain('/repo/.env');
  });

  it('does not emit deny paths that are covered by a higher-precedence session write grant', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: ['/repo/dist/secret.txt'] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, { repoRoot: '/repo' });
    evaluator.addSessionGrant('write', '/repo/dist/secret.txt');

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readWritePaths).toContain('/repo/dist/secret.txt');
    expect(options.denyPaths).not.toContain('/repo/dist/secret.txt');
    expect(options.denyPatterns).not.toContain('/repo/dist/secret.txt');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/policy-mapper.test.ts
```

Expected: the new grant visibility tests fail because `policyToSandboxOptions()` uses `getEffectiveRules()`, which does not include `cliGrants` or session grants. The new grant-over-deny tests fail because configured deny paths are still emitted into the sandbox even when a higher-precedence runtime grant covers the same path.

- [ ] **Step 3: Add a sandbox-facing rule method**

In `packages/core/src/policy/evaluator.ts`, add this exported interface after `PolicyEvaluatorOptions`:

```typescript
/**
 * Permission rules used by OS sandbox generation.
 *
 * `allow` contains every path that should be granted to the sandbox. `deny`
 * contains configured deny rules. `runtimeGrantAllow` contains only
 * higher-precedence CLI/session grants, so the sandbox mapper can keep deny
 * generation coherent with evaluator precedence.
 */
export interface SandboxPermissionRules extends PermissionRules {
  /** Higher-precedence CLI/session grants that must override configured denies. */
  runtimeGrantAllow: string[];
}
```

Then add this method after `getEffectiveRules(...)`:

```typescript
  /**
   * Get permission rules for OS sandbox generation.
   *
   * This includes static policy rules, persisted grants, CLI grants, and
   * session grants. Runtime grants must reach the OS sandbox because command
   * steps are child processes and file access inside them is enforced by the
   * sandbox backend, not by per-path evaluator checks.
   *
   * @param type - Permission type to resolve.
   * @returns Permission rules relevant to sandbox allow-list and deny generation.
   */
  getSandboxRules(type: 'read' | 'write'): SandboxPermissionRules {
    const rules = this.getEffectiveRules(type);
    const cliGrants = this.options.cliGrants?.[type] ?? [];
    const sessionGrants = this.sessionGrants
      .filter((grant) => grant.type === type)
      .map((grant) => grant.pattern);

    const runtimeGrantAllow = [...cliGrants, ...sessionGrants];

    return {
      allow: [...rules.allow, ...runtimeGrantAllow],
      deny: rules.deny,
      runtimeGrantAllow,
    };
  }
```

- [ ] **Step 4: Use sandbox-facing rules in the mapper**

In `packages/core/src/sandbox/policy-mapper.ts`, replace:

```typescript
  const readRules = evaluator.getEffectiveRules('read');
  const writeRules = evaluator.getEffectiveRules('write');
```

with:

```typescript
  const readRules = evaluator.getSandboxRules('read');
  const writeRules = evaluator.getSandboxRules('write');
```

Add this helper near `buildSandboxPathSets(...)`:

```typescript
function filterDenyPathsCoveredByRuntimeGrants(
  denyPaths: readonly string[],
  runtimeGrantPaths: readonly string[],
): string[] {
  return denyPaths.filter((denyPath) => {
    return !runtimeGrantPaths.some((grantPath) => isWithinRoot(denyPath, grantPath));
  });
}

function filterDenyPatternsCoveredByRuntimeGrants(
  denyPatterns: readonly string[],
  runtimeGrantPaths: readonly string[],
): string[] {
  return denyPatterns.filter((denyPattern) => {
    if (hasGlob(denyPattern)) {
      return true;
    }
    return !runtimeGrantPaths.some((grantPath) => isWithinRoot(denyPattern, grantPath));
  });
}
```

After `denyPatterns` and `denyPaths` are computed, add:

```typescript
  const runtimeGrantPaths = resolvePathPatterns(
    [...readRules.runtimeGrantAllow, ...writeRules.runtimeGrantAllow],
    repoRoot,
    tmpDir,
  );
  const effectiveDenyPatterns = filterDenyPatternsCoveredByRuntimeGrants(
    denyPatterns,
    runtimeGrantPaths,
  );
  const effectiveDenyPaths = filterDenyPathsCoveredByRuntimeGrants(denyPaths, runtimeGrantPaths);
```

Return `effectiveDenyPaths` instead of raw `denyPaths`:

```typescript
    denyPaths: [...new Set(effectiveDenyPaths)],
    denyPatterns: [...new Set(effectiveDenyPatterns)],
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/policy-mapper.test.ts
```

Expected: `policy-mapper.test.ts` passes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/policy/evaluator.ts packages/core/src/sandbox/policy-mapper.ts packages/core/__tests__/sandbox/policy-mapper.test.ts
git commit -m "fix: include runtime grants in sandbox policy mapping"
```

---

## Task 2: Canonicalize Sandbox Grant Paths

**Files:**

- Modify: `packages/core/src/sandbox/policy-mapper.ts`
- Test: `packages/core/__tests__/sandbox/policy-mapper.test.ts`

- [ ] **Step 1: Add failing tests for canonical grant paths**

Add these imports to `packages/core/__tests__/sandbox/policy-mapper.test.ts` if they are not already present:

```typescript
import { realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
```

Add these tests inside `describe('policyToSandboxOptions', ...)`:

```typescript
  it('realpath-normalizes read grants that pass through a symlink', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const dir = join(repoRoot, 'schema-dir');
      await mkdir(dir);
      const alias = join(aliasRoot, 'schema-link');
      await symlink(dir, alias);
      const canonicalDir = await realpath(dir);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [join(alias, '**')], deny: [] },
          write: { allow: [], deny: [] },
        },
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readOnlyPaths).toContain(canonicalDir);
      expect(options.readOnlyPaths).not.toContain(alias);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('realpath-normalizes future write grants through the nearest existing symlink ancestor', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const dist = join(repoRoot, 'dist');
      await mkdir(dist);
      const alias = join(aliasRoot, 'dist-link');
      await symlink(dist, alias);
      const futurePath = join(alias, 'new-file.txt');
      const canonicalRepo = await realpath(repoRoot);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [] },
          write: { allow: [futurePath], deny: [] },
        },
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readWritePaths).toContain(join(canonicalRepo, 'dist', 'new-file.txt'));
      expect(options.readWritePaths).not.toContain(futurePath);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('normalizes the macOS tmpdir alias from /var/folders to /private/var/folders when present', async () => {
    const tmp = tmpdir();
    if (process.platform !== 'darwin' || !tmp.startsWith('/var/folders/')) {
      return;
    }
    const canonicalTmp = await realpath(tmp);
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: ['{tmp}/rundown-sandbox-test/**'], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      tmpDir: tmp,
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
      tmpDir: tmp,
    });

    expect(options.readWritePaths).toContain(join(canonicalTmp, 'rundown-sandbox-test'));
    expect(options.readWritePaths).not.toContain(join(tmp, 'rundown-sandbox-test'));
  });

  it('applies the same canonicalization to policyConfigToSandboxOptions', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const dir = join(repoRoot, 'raw-policy-read');
      await mkdir(dir);
      const alias = join(aliasRoot, 'raw-policy-link');
      await symlink(dir, alias);
      const canonicalDir = await realpath(dir);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [join(alias, '**')], deny: [] },
          write: { allow: [], deny: [] },
        },
      };

      const options = policyConfigToSandboxOptions(policy, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readOnlyPaths).toContain(canonicalDir);
      expect(options.readOnlyPaths).not.toContain(alias);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify failure or missing normalization**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/policy-mapper.test.ts
```

Expected: the symlink tests fail before canonicalization is implemented because sandbox paths keep the symlink spelling. On macOS with `/var/folders` tmpdirs, the tmp alias test fails before the fix because the mapper emits `/var/folders/...` instead of `/private/var/folders/...`.

- [ ] **Step 3: Add canonicalization helpers**

In `packages/core/src/sandbox/policy-mapper.ts`, add these helpers near `resolveCanonicalPath(...)`:

```typescript
function resolveCanonicalPathForGrant(value: string): string {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) {
      return absolute;
    }
    return path.join(resolveCanonicalPathForGrant(parent), path.basename(absolute));
  }
}

function normalizeSandboxPathList(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const candidate of paths) {
    normalized.add(resolveCanonicalPathForGrant(candidate));
  }
  return [...normalized];
}
```

- [ ] **Step 4: Normalize allow paths and deny paths before set construction**

In `policyToSandboxOptions(...)`, replace:

```typescript
  const readAllowPaths = resolvePathPatterns(readRules.allow, repoRoot, tmpDir);
  const writeAllowPaths = resolvePathPatterns(writeRules.allow, repoRoot, tmpDir);
```

with:

```typescript
  const readAllowPaths = normalizeSandboxPathList(
    resolvePathPatterns(readRules.allow, repoRoot, tmpDir),
  );
  const writeAllowPaths = normalizeSandboxPathList(
    resolvePathPatterns(writeRules.allow, repoRoot, tmpDir),
  );
```

Replace:

```typescript
    denyPaths: [...new Set(effectiveDenyPaths)],
```

with:

```typescript
    denyPaths: normalizeSandboxPathList(effectiveDenyPaths),
```

Also update the `runtimeGrantPaths` calculation added in Task 1 from:

```typescript
  const runtimeGrantPaths = resolvePathPatterns(
    [...readRules.runtimeGrantAllow, ...writeRules.runtimeGrantAllow],
    repoRoot,
    tmpDir,
  );
```

to:

```typescript
  const runtimeGrantPaths = normalizeSandboxPathList(
    resolvePathPatterns(
      [...readRules.runtimeGrantAllow, ...writeRules.runtimeGrantAllow],
      repoRoot,
      tmpDir,
    ),
  );
```

Make the same normalization changes in `policyConfigToSandboxOptions(...)`: normalize `readAllowPaths`, `writeAllowPaths`, and returned `denyPaths` with `normalizeSandboxPathList(...)`. There are no runtime grants in the raw-policy path, so it does not use `getSandboxRules(...)` or the runtime-grant deny filters.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/policy-mapper.test.ts
```

Expected: `policy-mapper.test.ts` passes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sandbox/policy-mapper.ts packages/core/__tests__/sandbox/policy-mapper.test.ts
git commit -m "fix: canonicalize sandbox grant paths"
```

---

## Task 3: Add Seatbelt Metadata Ancestor Grants

**Files:**

- Modify: `packages/core/src/sandbox/types.ts`
- Modify: `packages/core/src/sandbox/policy-mapper.ts`
- Modify: `packages/core/src/sandbox/macos.ts`
- Test: `packages/core/__tests__/sandbox/policy-mapper.test.ts`
- Test: `packages/core/__tests__/sandbox/macos.test.ts`
- Test: `packages/core/__tests__/sandbox/linux-spec-builder.test.ts`

- [ ] **Step 1: Add failing mapper test for metadata paths**

Add this test inside `describe('policyToSandboxOptions', ...)`:

```typescript
  it('includes metadata-read ancestors for sandbox grant roots', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: ['/Users/alice/project/schema.json'], deny: [] },
        write: { allow: ['/Users/alice/project/dist/**'], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, { repoRoot: '/Users/alice/project' });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/Users/alice/project',
      repoRoot: '/Users/alice/project',
    });

    expect(options.metadataReadPaths).toEqual(
      expect.arrayContaining(['/Users', '/Users/alice', '/Users/alice/project']),
    );
  });
```

- [ ] **Step 2: Add failing Seatbelt profile test**

Add this test inside `describe('execute', ...)` in `packages/core/__tests__/sandbox/macos.test.ts`:

```typescript
    it('writes metadata-only ancestor rules into the generated profile', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(0);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      await sandbox.execute('node script.js', {
        ...mockOptions,
        metadataReadPaths: ['/Users', '/Users/test', '/Users/test/project'],
      });

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('(literal "/Users/test/project")'),
        expect.any(Object),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('(allow file-read-metadata'),
        expect.any(Object),
      );
    });
```

- [ ] **Step 3: Add `metadataReadPaths` to `SandboxOptions`**

In `packages/core/src/sandbox/types.ts`, add this property after `readWritePaths`:

```typescript
  /**
   * Paths that should allow metadata-only reads such as stat/lstat traversal.
   *
   * Seatbelt needs this for ancestor directories (for example `/Users` and
   * `/Users/name`) so runtimes can resolve allowed descendants without gaining
   * permission to read ancestor file contents. Backends that cannot express
   * metadata-only rights ignore this field.
   */
  metadataReadPaths?: string[];
```

- [ ] **Step 4: Compute metadata ancestors in the mapper**

In `packages/core/src/sandbox/policy-mapper.ts`, add:

```typescript
function collectAncestorPaths(paths: readonly string[]): string[] {
  const ancestors = new Set<string>(paths);
  for (const candidate of paths) {
    let current = path.dirname(candidate);
    while (current !== path.dirname(current)) {
      ancestors.add(current);
      current = path.dirname(current);
    }
  }
  ancestors.delete(path.sep);
  return [...ancestors].sort((a, b) => a.length - b.length);
}
```

Before the `return` in `policyToSandboxOptions(...)`, add:

```typescript
  const metadataReadPaths = collectAncestorPaths([
    repoRoot,
    options.cwd,
    tmpDir,
    ...readOnlyPaths,
    ...readWritePaths,
  ]);
```

Add this field to the returned object:

```typescript
    metadataReadPaths,
```

Apply the same `metadataReadPaths` computation in `policyConfigToSandboxOptions(...)`, using that function's `repoRoot`, `options.cwd`, `tmpDir`, `readOnlyPaths`, and `readWritePaths`.

- [ ] **Step 5: Emit metadata rules in Seatbelt**

In `packages/core/src/sandbox/macos.ts`, add this block in `generateSeatbeltProfile(...)` after `denyRules` is built:

```typescript
  const metadataReadRules = (options.metadataReadPaths ?? [])
    .map((p) => `  (literal "${escapePath(p)}")`)
    .join('\n');
```

Replace the existing hard-coded metadata block:

```scheme
(allow file-read-metadata
  (subpath "/private/var")
)
```

with:

```scheme
(allow file-read-metadata
  (subpath "/private/var")
${metadataReadRules}
)
```

- [ ] **Step 6: Keep Linux behavior explicit**

In `packages/core/__tests__/sandbox/linux-spec-builder.test.ts`, update the `base` options with:

```typescript
  metadataReadPaths: ['/repo-parent'],
```

Add this assertion to the `classifies grants and derives strict from allowUnsandboxed` test:

```typescript
    expect(spec.ro).not.toContain('/repo-parent');
    expect(spec.rw).not.toContain('/repo-parent');
```

No production Linux change is required because `buildSpec(...)` does not read `metadataReadPaths`.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/policy-mapper.test.ts packages/core/__tests__/sandbox/macos.test.ts packages/core/__tests__/sandbox/linux-spec-builder.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/sandbox/types.ts packages/core/src/sandbox/policy-mapper.ts packages/core/src/sandbox/macos.ts packages/core/__tests__/sandbox/policy-mapper.test.ts packages/core/__tests__/sandbox/macos.test.ts packages/core/__tests__/sandbox/linux-spec-builder.test.ts
git commit -m "fix: grant Seatbelt metadata traversal for sandbox paths"
```

---

## Task 4: Add Real Seatbelt Grant-To-Syscall Integration Coverage

**Files:**

- Create: `packages/core/__tests__/sandbox/macos.enforcement.integration.test.ts`

- [ ] **Step 1: Create the macOS integration test**

Create `packages/core/__tests__/sandbox/macos.enforcement.integration.test.ts`:

```typescript
/**
 * Real-enforcement integration test for the macOS Seatbelt sandbox.
 *
 * Behaviour by environment:
 *   - Seatbelt available -> assert real grant-to-syscall success.
 *   - Seatbelt unavailable/non-macOS -> skip so CI and Linux dev machines stay green.
 *   - RUNDOWN_REQUIRE_SEATBELT=1 and unavailable -> fail.
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SeatbeltSandbox } from '../../src/sandbox/macos.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const sandbox = new SeatbeltSandbox();
const availability = await sandbox.getAvailability();
const required = process.env.RUNDOWN_REQUIRE_SEATBELT === '1';

function metadataAncestorsFor(path: string): string[] {
  const ancestors: string[] = [];
  let current = path;
  while (current !== dirname(current)) {
    ancestors.unshift(current);
    current = dirname(current);
  }
  return ancestors.filter((ancestor) => ancestor !== '/');
}

if (!availability.available) {
  const reason = availability.reason ?? 'unknown reason';
  if (required) {
    describe('SeatbeltSandbox real enforcement (integration)', () => {
      it('Seatbelt must be available when RUNDOWN_REQUIRE_SEATBELT=1', () => {
        throw new Error(`Expected a working Seatbelt sandbox but it is unavailable: ${reason}`);
      });
    });
  } else {
    console.info(`[seatbelt-integration] skipped - sandbox unavailable: ${reason}`);
    describe.skip(`SeatbeltSandbox real enforcement (integration) - ${reason}`, () => {
      it('enforces filesystem policy', () => {
        /* skipped */
      });
    });
  }
} else {
  describe('SeatbeltSandbox real enforcement (integration)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rundown-seatbelt-it-'));
    const grantedReadDir = join(root, 'read');
    const grantedWriteDir = join(root, 'write');
    const secretDir = join(root, 'secret');
    mkdirSync(grantedReadDir);
    mkdirSync(grantedWriteDir);
    mkdirSync(secretDir);
    writeFileSync(join(grantedReadDir, 'ok.txt'), 'ok');
    writeFileSync(join(secretDir, 'secret.txt'), 'top secret');

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const run = (command: string, options: Partial<SandboxOptions> = {}) =>
      sandbox.execute(command, {
        cwd: root,
        repoRoot: root,
        readOnlyPaths: [grantedReadDir],
        readWritePaths: [grantedWriteDir],
        metadataReadPaths: [root, grantedReadDir, grantedWriteDir],
        denyPaths: [],
        denyPatterns: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        allowUnsandboxed: false,
        ...options,
      } satisfies SandboxOptions);

    it('allows a real read syscall inside a granted read-only path', async () => {
      const result = await run(
        `node -e "const fs=require('fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(
          join(grantedReadDir, 'ok.txt'),
        )}, 'utf8'))"`,
      );

      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });

    it('allows a real write syscall inside a granted read-write path', async () => {
      const target = join(grantedWriteDir, 'written.txt');
      const result = await run(
        `node -e "require('fs').writeFileSync(${JSON.stringify(target)}, 'written')"`,
      );

      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('written');
    });

    it('blocks a real read syscall outside granted paths', async () => {
      const result = await run(
        `node -e "require('fs').readFileSync(${JSON.stringify(join(secretDir, 'secret.txt'))})"`,
      );

      expect(result.sandboxed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    it('allows Node startup and cwd package reads from a /Users-rooted repo using metadata ancestors', async () => {
      const repoCwd = realpathSync(process.cwd());
      if (!repoCwd.startsWith('/Users/')) {
        console.info(`[seatbelt-integration] skipped /Users metadata case for cwd ${repoCwd}`);
        return;
      }

      const result = await sandbox.execute(
        'node -e "require(\'fs\').readFileSync(require.resolve(\'./package.json\'), \'utf8\')"',
        {
          cwd: repoCwd,
          repoRoot: repoCwd,
          readOnlyPaths: [repoCwd],
          readWritePaths: [],
          metadataReadPaths: metadataAncestorsFor(repoCwd),
          denyPaths: [],
          denyPatterns: [],
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          allowUnsandboxed: false,
        } satisfies SandboxOptions,
      );

      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });
  });
}
```

- [ ] **Step 2: Run the new integration test**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/macos.enforcement.integration.test.ts
```

Expected on macOS with Seatbelt: tests pass and prove actual syscall success/failure. Expected elsewhere: suite is skipped unless `RUNDOWN_REQUIRE_SEATBELT=1`.

- [ ] **Step 3: Keep Landlock real enforcement green**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts
```

Expected on Linux with Landlock: tests pass. Expected elsewhere: existing suite skips unless `RUNDOWN_REQUIRE_LANDLOCK=1`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/sandbox/macos.enforcement.integration.test.ts
git commit -m "test: cover real sandbox grant enforcement"
```

---

## Task 5: Add CLI Command-Step Reproduction Coverage

**Files:**

- Create: `packages/cli/__tests__/integration/sandbox-policy-grants.test.ts`

- [ ] **Step 1: Write integration tests that exercise CLI grants through command steps**

Create `packages/cli/__tests__/integration/sandbox-policy-grants.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { checkSandboxAvailability } from '@rundown-org/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const availability = await checkSandboxAvailability();
const required = process.env.RUNDOWN_REQUIRE_SANDBOX === '1';

if (!availability.available) {
  const reason = availability.reason ?? 'unknown reason';
  if (required) {
    describe('sandbox policy grants integration', () => {
      it('sandbox must be available when RUNDOWN_REQUIRE_SANDBOX=1', () => {
        throw new Error(`Expected a working sandbox but it is unavailable: ${reason}`);
      });
    });
  } else {
    console.info(`[sandbox-policy-grants] skipped - sandbox unavailable: ${reason}`);
    describe.skip(`sandbox policy grants integration - ${reason}`, () => {
      it('exercises CLI grants under OS sandboxing', () => {
        /* skipped */
      });
    });
  }
} else {
  describe('sandbox policy grants integration', () => {
    let workspace: TestWorkspace;

    beforeEach(async () => {
      workspace = await createTestWorkspace();
    });

    afterEach(async () => {
      await workspace.cleanup();
    });

    it('lets --allow-read reach a sandboxed command step', async () => {
      const inputPath = join(workspace.cwd, 'schema.json');
      await writeFile(inputPath, '{"ok":true}');
      await writeFile(
        join(workspace.cwd, 'read-grant.runbook.md'),
        [
          '# Read grant',
          '',
          '## 1. Read schema',
          '- PASS COMPLETE',
          '',
          '```bash',
          `node -e "const fs=require('fs'); JSON.parse(fs.readFileSync(${JSON.stringify(inputPath)}, 'utf8'))"`,
          '```',
          '',
        ].join('\n'),
      );

      const result = await runCliInProcess(
        [
          'run',
          'read-grant.runbook.md',
          '--yes',
          '--sandbox',
          '--allow-run',
          'node',
          '--allow-read',
          inputPath,
        ],
        workspace,
      );

      expect(result.exitCode).toBe(0);
    });

    it('lets --allow-write reach a sandboxed command step', async () => {
      const outputDir = join(workspace.cwd, 'dist');
      const outputPath = join(outputDir, 'out.txt');
      await mkdir(outputDir);
      await writeFile(
        join(workspace.cwd, 'write-grant.runbook.md'),
        [
          '# Write grant',
          '',
          '## 1. Write output',
          '- PASS COMPLETE',
          '',
          '```bash',
          `node -e "require('fs').writeFileSync(${JSON.stringify(outputPath)}, 'ok')"`,
          '```',
          '',
        ].join('\n'),
      );

      const result = await runCliInProcess(
        [
          'run',
          'write-grant.runbook.md',
          '--yes',
          '--sandbox',
          '--allow-run',
          'node',
          '--allow-write',
          outputDir,
        ],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(await readFile(outputPath, 'utf8')).toBe('ok');
    });
  });
}
```

- [ ] **Step 2: Run the CLI integration tests**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- --runTestsByPath packages/cli/__tests__/integration/sandbox-policy-grants.test.ts
```

Expected: both tests pass on hosts with a supported sandbox. On unsupported hosts, the suite skips unless `RUNDOWN_REQUIRE_SANDBOX=1`, in which case it fails with the sandbox availability reason.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/__tests__/integration/sandbox-policy-grants.test.ts
git commit -m "test: prove CLI grants reach sandboxed command steps"
```

---

## Task 6: Dogfood Reproduction And Verification

**Files:**

- No source files.

- [ ] **Step 1: Build packages**

Run:

```bash
pnpm run build
```

Expected: build succeeds.

- [ ] **Step 2: Reproduce rdx validate gate under sandbox**

Create `/tmp/sb-rdx-repro.runbook.md`:

````markdown
# SB rdx validate repro

## 1. Validate docs
- PASS COMPLETE

```bash
rdx --validate docs/superpowers/plans/2026-07-05-delegation-lifecycle-roadmap-4.md
```
````

Run:

```bash
rundown run /tmp/sb-rdx-repro.runbook.md --yes --allow-run rdx,node --allow-read "$PWD" --allow-write "$PWD" --sandbox
```

Expected: command step succeeds or fails only for an actual `rdx --validate` content error, not for sandbox file-access denial.

- [ ] **Step 3: Reproduce verify gate under sandbox**

Create `/tmp/sb-verify-repro.runbook.md`:

````markdown
# SB verify repro

## 1. Verify
- PASS COMPLETE

```bash
pnpm run verify
```
````

Run:

```bash
rundown run /tmp/sb-verify-repro.runbook.md --yes --allow-run pnpm,node,npm --allow-read "$PWD" --allow-write "$PWD" --sandbox
```

Expected: `pnpm run verify` starts normally under the sandbox. Any failure must be a real verification failure, not `EPERM` from missing `/Users` metadata traversal or missing grant propagation.

- [ ] **Step 4: Run targeted regression tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --runTestsByPath packages/core/__tests__/sandbox/policy-mapper.test.ts packages/core/__tests__/sandbox/macos.test.ts packages/core/__tests__/sandbox/linux-spec-builder.test.ts packages/core/__tests__/sandbox/macos.enforcement.integration.test.ts packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts
```

Expected: all targeted core tests pass, with platform-specific enforcement tests skipped only when their backend is unavailable and the corresponding `RUNDOWN_REQUIRE_*` env var is not set.

- [ ] **Step 5: Run full pre-PR verification**

Run:

```bash
pnpm run verify
```

Expected: verify passes.

---

## Self-Review Notes

- #550 coverage: Task 1 and Task 5 prove CLI grants reach `SandboxOptions` and command-step execution.
- #552 coverage: Task 2 canonicalizes all sandbox grant roots, including future write targets via nearest-existing ancestor reconstruction.
- #549 coverage: Task 3 adds metadata-only ancestors and Task 4 proves real Node filesystem syscalls work under Seatbelt.
- Architecture: no CLI workaround; policy construction stays in CLI, behavior-bearing grant mapping lives in core policy/sandbox layers.
- Runtime grant precedence: Task 1 adds explicit CLI/session grant-over-deny mapper tests and a sandbox-facing rule model so emitted deny rules stay coherent with `PolicyEvaluator.checkPath()`.
