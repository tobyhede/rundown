/**
 * Repository-wide authoring rules for scenario command sequences.
 *
 * These rules were previously conventions in `docs/internal/scenarios.md` with
 * nothing enforcing them, and #498 exists because that gap let three scenarios
 * fabricate artifact provenance for months while looking like real coverage.
 *
 * **Why this lints parsed structure rather than file text.** The obvious check —
 * `grep -rn 'rd://artifacts/' runbooks/` — is unwinnable, because `rd://` is
 * both the fabrication pattern and the legitimate artifact *selector* language
 * used on `ARTIFACTS` directive lines in runbook bodies (see
 * `runbooks/artifacts/artifact-selector-query-filter.runbook.md`). The
 * difference is not in the characters, it is in where the string lives. These
 * rules read `scenarios.*.commands[]` as parsed frontmatter values, so body
 * text can never reach them and the selector language can never false-positive.
 *
 * This file must NOT live under `__tests__/integration/`: `test:unit` (and so
 * `pnpm run verify`) runs `jest --testPathIgnorePatterns='integration'`, which
 * is exactly why the integration harness's own authoring invariant broke
 * unnoticed on the #498 branch.
 */

import { describe, it, expect } from '@jest/globals';
import {
  findScenarioSuiteFiles,
  loadRunbookScenarioSources,
  type RunbookScenarioSource,
} from '../helpers/scenario-sources.js';
import { loadScenarioSuite } from '../../src/schemas/scenario-suite.js';
import {
  FABRICATION_RULES,
  SPAWNS_SUBPROCESS,
  usesOpaqueWrapper,
} from '../helpers/scenario-authoring-rules.js';

const sources: RunbookScenarioSource[] = loadRunbookScenarioSources();

/** A single scenario command, tagged with where it came from. */
interface CommandSite {
  readonly key: string;
  readonly file: string;
  readonly scenario: string;
  readonly command: string;
}

/** Every scenario command in the repository, in a stable order. */
const commandSites: CommandSite[] = sources.flatMap((source) =>
  Object.entries(source.scenarios ?? {}).flatMap(([scenario, definition]) =>
    definition.commands.map((command, index) => ({
      key: `${source.file}::${scenario}::${String(index)}`,
      file: source.file,
      scenario,
      command,
    })),
  ),
);

/**
 * Scenario commands where the shell command IS the fault being injected or the
 * untrusted input being forged — never a workflow step, and never an assertion.
 *
 * The distinguishing tell: a fault injector **mutates** state or forges input
 * that the run must reject. A command that only **reads** state to assert on it
 * is a jest test wearing a scenario costume, and belongs in `__tests__/`
 * instead (`docs/internal/scenarios.md`) — it does not belong here.
 *
 * Entries are matched by set equality, so a stale entry fails this suite just
 * as loudly as an unlisted violation.
 */
const FAULT_INJECTION_ALLOWLIST: readonly { readonly key: string; readonly reason: string }[] = [
  {
    key: 'artifacts/artifact-variable-review-plan.runbook.md::forged-file-record-rejected::0',
    reason:
      'Forges an artifact record as an untrusted public input so the run can assert the input channel rejects it. The forgery is the fault under test; replacing it with a real producer would delete the test.',
  },
  {
    key: 'delegation/delegate-claim-corruption.runbook.md::child-linkage-mismatch::3',
    reason:
      'Rewrites parentLinkage.tokenHash in session.json to simulate a tampered claim linkage. The corruption is the fault under test and cannot be produced through the CLI.',
  },
  {
    key: 'delegation/delegate-claim-corruption.runbook.md::child-missing::3',
    reason:
      'Deletes the child run state file to simulate a missing child run. The corruption is the fault under test and cannot be produced through the CLI.',
  },
];

describe('scenario sources', () => {
  it('discovers the repository runbook tree', () => {
    // A vacuous pass over zero runbooks would make every rule below meaningless.
    expect(sources.length).toBeGreaterThan(100);
    expect(commandSites.length).toBeGreaterThan(100);
  });

  it('every runbook has a schema-valid scenarios block', () => {
    // parseScenarios errors must fail here rather than silently drop the runbook
    // from the executing harness — under the strict schema (#498) a retired
    // `seed:` key makes a runbook invisible instead of rejected.
    const invalid = sources
      .filter((s) => s.errors.length > 0)
      .map((s) => `${s.file}: ${s.errors.join('; ')}`);
    expect(invalid).toEqual([]);
  });

  it('every runbook defines at least one scenario', () => {
    // Moved here from the integration harness, which `verify` never runs. A
    // runbook with no scenario is silently untested — the failure mode that let
    // artifact-variable-collate lose all coverage during #498.
    const missing = sources
      .filter((s) => !s.scenarios || Object.keys(s.scenarios).length === 0)
      .map((s) => s.file);
    expect(missing).toEqual([]);
  });
});

describe('scenario commands never fabricate artifact provenance (#498)', () => {
  it.each(FABRICATION_RULES)('no command $id', ({ pattern }) => {
    const violations = commandSites
      .filter((site) => pattern.test(site.command))
      .map((site) => `${site.key}\n    ${site.command.slice(0, 120)}`);
    expect(violations).toEqual([]);
  });

  it('no command spawns a subprocess (hidden rd invocations obscure run state)', () => {
    const violations = commandSites
      .filter((site) => SPAWNS_SUBPROCESS.test(site.command))
      .map((site) => `${site.key}\n    ${site.command.slice(0, 120)}`);
    expect(violations).toEqual([]);
  });
});

describe('opaque shell wrappers are confined to fault injection', () => {
  it('allowlist matches the real violations exactly, with no stale entries', () => {
    const violations = commandSites
      .filter((site) => usesOpaqueWrapper(site.command))
      .map((site) => site.key)
      .sort();
    const allowed = FAULT_INJECTION_ALLOWLIST.map((entry) => entry.key).sort();
    // Set equality, not a subset: an unlisted violation and a stale entry are
    // both failures. A subset assertion is how an allowlist rots into a rubber
    // stamp.
    expect(violations).toEqual(allowed);
  });

  it('every allowlist entry states a substantive reason', () => {
    const unjustified = FAULT_INJECTION_ALLOWLIST.filter((e) => e.reason.trim().length < 40).map(
      (e) => e.key,
    );
    expect(unjustified).toEqual([]);
  });

  it('allowlist has no duplicate keys', () => {
    const keys = FAULT_INJECTION_ALLOWLIST.map((e) => e.key);
    expect(keys).toEqual([...new Set(keys)]);
  });
});

describe('scenario suite files', () => {
  it('applies the same rules to standalone scenario suites', async () => {
    const suiteFiles = findScenarioSuiteFiles();
    // Discovery is by scan, so a broken glob must fail rather than pass over
    // nothing.
    expect(suiteFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of suiteFiles) {
      const result = await loadScenarioSuite(file);
      if (!result.ok) {
        violations.push(`${file}: ${result.error}`);
        continue;
      }
      for (const [name, testCase] of Object.entries(result.suite.cases)) {
        testCase.commands.forEach((command, index) => {
          const failed = [
            ...FABRICATION_RULES.filter((rule) => rule.pattern.test(command)).map((r) => r.id),
            ...(SPAWNS_SUBPROCESS.test(command) ? ['spawns a subprocess'] : []),
            ...(usesOpaqueWrapper(command) ? ['uses an opaque shell wrapper'] : []),
          ];
          if (failed.length > 0) {
            violations.push(`${file}::${name}::${String(index)} — ${failed.join(', ')}`);
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
