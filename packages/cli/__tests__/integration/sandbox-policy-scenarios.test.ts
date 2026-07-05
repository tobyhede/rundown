import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { checkSandboxAvailability } from '@rundown-org/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseCliJsonObject,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const availability = await checkSandboxAvailability();
const required = process.env.RUNDOWN_REQUIRE_SANDBOX === '1';

if (!availability.available) {
  const reason = availability.reason ?? 'unknown reason';
  if (required) {
    describe('sandbox policy scenario coverage', () => {
      it('sandbox must be available when RUNDOWN_REQUIRE_SANDBOX=1', () => {
        throw new Error(`Expected a working sandbox but it is unavailable: ${reason}`);
      });
    });
  } else {
    console.info(`[sandbox-policy-scenarios] skipped - sandbox unavailable: ${reason}`);
    describe.skip(`sandbox policy scenario coverage - ${reason}`, () => {
      it('runs sandbox policy scenarios', () => {
        /* skipped */
      });
    });
  }
} else {
  describe('sandbox policy scenario coverage', () => {
    let workspace: TestWorkspace;

    beforeEach(async () => {
      workspace = await createTestWorkspace();
      await writeScenarioRunbooks(workspace);
    });

    afterEach(async () => {
      await workspace.cleanup();
    });

    it.each([
      'allow-read',
      'allow-write',
      'deny-read',
      'deny-write',
    ])('scenario: %s', (scenarioName) => {
      const result = runCli(
        ['scenario', 'run', 'sandbox-policy-scenarios.runbook.md', scenarioName],
        workspace,
      );

      const output = parseCliJsonObject(result.stdout);
      if (scenarioName.startsWith('allow-')) {
        expect(result.exitCode).toBe(0);
        expect(output).toEqual(
          expect.objectContaining({ result: true, expected: 'COMPLETE', actual: 'COMPLETE' }),
        );
      } else {
        expect(result.exitCode).toBe(0);
        expect(output).toEqual(
          expect.objectContaining({ result: true, expected: 'STOP', actual: 'STOP' }),
        );
      }
    });
  });
}

async function writeScenarioRunbooks(workspace: TestWorkspace): Promise<void> {
  const inputPath = join(workspace.cwd, 'scenario-schema.json');
  const outputDir = join(workspace.cwd, 'scenario-dist');
  const outputPath = join(outputDir, 'out.txt');
  const deniedOutputPath = join(outputDir, 'denied.txt');
  const restrictivePolicy = JSON.stringify({
    version: 1,
    default: {
      mode: 'deny',
      run: { allow: ['node'], deny: [] },
      read: { allow: [], deny: [] },
      write: { allow: [], deny: [] },
      env: { allow: ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'], deny: [] },
    },
    overrides: [],
    grants: [],
  });
  const writePolicyCommand = `node -e 'require("fs").writeFileSync(".rundownrc.json", ${JSON.stringify(
    restrictivePolicy,
  )})'`;
  await mkdir(outputDir);
  await writeFile(inputPath, '{"ok":true}');
  await writeFile(
    join(workspace.cwd, 'sandbox-read.runbook.md'),
    [
      '# Sandbox Read',
      '',
      '## 1. Read schema',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      `node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(${JSON.stringify(
        inputPath,
      )}, "utf8"))'`,
      '```',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(workspace.cwd, 'sandbox-write.runbook.md'),
    [
      '# Sandbox Write',
      '',
      '## 1. Write output',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      `node -e 'require("fs").writeFileSync(${JSON.stringify(outputPath)}, "ok")'`,
      '```',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(workspace.cwd, 'sandbox-write-denied.runbook.md'),
    [
      '# Sandbox Write Denied',
      '',
      '## 1. Write denied output',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      `node -e 'require("fs").writeFileSync(${JSON.stringify(deniedOutputPath)}, "ok")'`,
      '```',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(workspace.cwd, 'sandbox-policy-scenarios.runbook.md'),
    [
      '---',
      'name: sandbox-policy-scenarios',
      'scenarios:',
      '  allow-read:',
      '    description: CLI read grant reaches sandbox execution through scenario run',
      '    commands:',
      `      - ${writePolicyCommand}`,
      `      - rd run sandbox-read.runbook.md --yes --sandbox --allow-run node --allow-read ${inputPath}`,
      '    result: COMPLETE',
      '  allow-write:',
      '    description: CLI write grant reaches sandbox execution through scenario run',
      '    commands:',
      `      - ${writePolicyCommand}`,
      `      - rd run sandbox-write.runbook.md --yes --sandbox --allow-run node --allow-write ${outputDir}`,
      '    result: COMPLETE',
      '  deny-read:',
      '    description: Missing read grant fails under sandbox execution through scenario run',
      '    commands:',
      `      - ${writePolicyCommand}`,
      '      - "! rd run sandbox-read.runbook.md --yes --sandbox --allow-run node"',
      '    result: STOP',
      '  deny-write:',
      '    description: Missing write grant fails under sandbox execution through scenario run',
      '    commands:',
      `      - ${writePolicyCommand}`,
      '      - "! rd run sandbox-write-denied.runbook.md --yes --sandbox --allow-run node"',
      '    result: STOP',
      '---',
      '# Sandbox Policy Scenarios',
      '',
      '## 1. Placeholder',
      '- PASS COMPLETE',
      '',
      'Scenario container.',
      '',
    ].join('\n'),
  );
}
