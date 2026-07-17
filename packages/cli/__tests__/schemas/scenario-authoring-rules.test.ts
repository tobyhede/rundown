/**
 * Unit tests for the scenario authoring rule predicates.
 *
 * The lint suite applies these rules to the repository's real scenarios, which
 * proves today's corpus is clean but not that a rule still matches anything: a
 * rule that quietly stopped detecting violations would keep that suite green.
 * These tests pin each predicate against the evasions it exists to catch.
 */

import { describe, it, expect } from '@jest/globals';
import {
  commandHead,
  FABRICATION_RULES,
  SPAWNS_SUBPROCESS,
  usesOpaqueWrapper,
} from '../helpers/scenario-authoring-rules.js';

/** Matches a command against every fabrication rule. */
function fabricates(command: string): boolean {
  return FABRICATION_RULES.some((rule) => rule.pattern.test(command));
}

describe('fabrication rules', () => {
  it.each([
    'rd run x.runbook.md --artifacts Plan=rd://artifacts/ctx/rd_1/plan.json',
    'rd run x.runbook.md --artifacts-json \'R=["rd://artifacts/c/rd_1/a.json"]\'',
    'node -e \'fs.writeFileSync(".rundown/work/.rd-ctx/manifest.jsonl", row)\'',
    // The provenance directory is fabricated whatever the context id looks like:
    // an alphanumeric id, an underscore- or hyphen-led id, and a templated id are
    // all hand-derived paths.
    'node -e \'fs.mkdirSync(".rd-ctx123/run")\'',
    'node -e \'fs.mkdirSync(".rd-_leading/run")\'',
    'node -e \'fs.mkdirSync(".rd-{{ ContextId }}/run")\'',
  ])('rejects %p', (command) => {
    expect(fabricates(command)).toBe(true);
  });

  it.each([
    'rd run scenario-seed-artifacts.runbook.md --allow-all',
    "rd run x.runbook.md --artifacts-json 'R=${CAPTURE_ARTIFACT_ARRAY:review.json}' --allow-all",
    'rd run execute-plan.runbook.md --artifacts PlanPath=${CAPTURE_ARTIFACT:PlanPath}',
    'rd pass',
    'true delegation-child-manual-three-step.runbook.md',
  ])('accepts %p', (command) => {
    expect(fabricates(command)).toBe(false);
  });
});

describe('subprocess detection', () => {
  it.each([
    'node -e \'require("node:child_process").execFileSync("rd", ["status"])\'',
    'node -e \'const { execSync } = require("child_process"); execSync("rd pass")\'',
    'node -e \'spawnSync("rd", ["status"])\'',
  ])('rejects %p', (command) => {
    expect(SPAWNS_SUBPROCESS.test(command)).toBe(true);
  });

  it.each([
    // Reads a state file but never invokes the CLI — a legitimate fault
    // injector. A naive /\b(rd|rundown)\b/ test would match `.rundown/` here.
    'node -e \'JSON.parse(fs.readFileSync(".rundown/session.json","utf8"))\'',
    'rd run x.runbook.md --allow-all',
  ])('accepts %p', (command) => {
    expect(SPAWNS_SUBPROCESS.test(command)).toBe(false);
  });
});

describe('opaque wrapper detection', () => {
  it.each([
    // Inline code — the spelling the rule always caught.
    'node -e \'fs.writeFileSync("x", "{}")\'',
    'bash -c "echo hi"',
    'sh -c "echo hi"',
    // Helper scripts and package runners — forbidden by the same documented
    // rule, and previously undetected because they carry no -e/-c flag.
    'node scripts/seed.js',
    'python3 seed.py',
    './setup.sh',
    'bash scripts/setup.sh',
    'npm run seed',
    'pnpm exec something',
    'npx tsx seed.ts',
    // Hidden behind a shell operator rather than at the head of the command.
    'rd pass && node scripts/seed.js',
    'rd pass; ./helper.sh',
    // Prefixed forms must not evade the executable-position anchor.
    "! node -e 'process.exit(1)'",
    'FOO=bar node scripts/seed.js',
  ])('rejects %p', (command) => {
    expect(usesOpaqueWrapper(command)).toBe(true);
  });

  it.each([
    'rd run x.runbook.md --allow-all',
    'rd pass --claim-id ${CLAIM_ID}',
    '! rd fail',
    // The established staging no-op and fixture-writing builtin.
    'true delegation-child-manual-three-step.runbook.md',
    "printf '%s\\n' '## 1. Parent' > child.runbook.md",
    // Incidental mentions in arguments are not invocations.
    'rd run x.runbook.md --input shell=bash',
    'rd echo --result pass --message "run node to debug"',
  ])('accepts %p', (command) => {
    expect(usesOpaqueWrapper(command)).toBe(false);
  });
});

describe('commandHead', () => {
  it.each([
    ['rd pass', 'rd'],
    ['! rd fail', 'rd'],
    ['FOO=bar BAZ=1 node x.js', 'node'],
    ['  rd  status ', 'rd'],
    ['', ''],
  ])('extracts the executable from %p', (command, expected) => {
    expect(commandHead(command)).toBe(expected);
  });
});
