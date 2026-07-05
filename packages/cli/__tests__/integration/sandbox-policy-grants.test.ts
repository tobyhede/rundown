import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { checkSandboxAvailability } from '@rundown-org/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseJsonEvents,
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

    async function writeDenyByDefaultPolicy(): Promise<void> {
      await writeFile(
        join(workspace.cwd, '.rundownrc.json'),
        JSON.stringify({
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
        }),
      );
    }

    async function writePolicyWithFileGrants(args: {
      readAllow?: string[];
      writeAllow?: string[];
    }): Promise<void> {
      await writeFile(
        join(workspace.cwd, '.rundownrc.json'),
        JSON.stringify({
          version: 1,
          default: {
            mode: 'deny',
            run: { allow: ['node'], deny: [] },
            read: { allow: args.readAllow ?? [], deny: [] },
            write: { allow: args.writeAllow ?? [], deny: [] },
            env: { allow: ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'], deny: [] },
          },
          overrides: [],
          grants: [],
        }),
      );
    }

    function expectSandboxedCommandCompleted(stdout: string, success: boolean): void {
      const event = parseJsonEvents(stdout).find((candidate) => {
        return candidate.type === 'command_completed';
      });
      expect(event).toBeDefined();
      expect(event).toEqual(
        expect.objectContaining({
          type: 'command_completed',
          sandboxed: true,
          success,
          policyDenied: false,
        }),
      );
    }

    it('lets --allow-read reach a sandboxed command step', async () => {
      await writeDenyByDefaultPolicy();
      const inputPath = join(workspace.cwd, 'schema-secret.json');
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
          `node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(${JSON.stringify(
            inputPath,
          )}, "utf8"))'`,
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
      expectSandboxedCommandCompleted(result.stdout, true);

      await writeFile(
        join(workspace.cwd, 'read-denied.runbook.md'),
        [
          '# Read grant',
          '',
          '## 1. Read schema',
          '- PASS COMPLETE',
          '',
          '```bash',
          `node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(${JSON.stringify(
            inputPath,
          )}, "utf8"))'`,
          '```',
          '',
        ].join('\n'),
      );

      const denied = await runCliInProcess(
        ['run', 'read-denied.runbook.md', '--yes', '--sandbox', '--allow-run', 'node'],
        workspace,
      );

      expect(denied.exitCode).not.toBe(0);
      expectSandboxedCommandCompleted(denied.stdout, false);
    });

    it('lets --allow-write reach a sandboxed command step', async () => {
      await writeDenyByDefaultPolicy();
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
          `node -e 'require("fs").writeFileSync(${JSON.stringify(outputPath)}, "ok")'`,
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
      expectSandboxedCommandCompleted(result.stdout, true);
      expect(await readFile(outputPath, 'utf8')).toBe('ok');

      const deniedPath = join(outputDir, 'denied.txt');
      await writeFile(
        join(workspace.cwd, 'write-denied.runbook.md'),
        [
          '# Write grant',
          '',
          '## 1. Write output',
          '- PASS COMPLETE',
          '',
          '```bash',
          `node -e 'require("fs").writeFileSync(${JSON.stringify(deniedPath)}, "ok")'`,
          '```',
          '',
        ].join('\n'),
      );

      const denied = await runCliInProcess(
        ['run', 'write-denied.runbook.md', '--yes', '--sandbox', '--allow-run', 'node'],
        workspace,
      );

      expect(denied.exitCode).not.toBe(0);
      expectSandboxedCommandCompleted(denied.stdout, false);
    });

    it('lets policy-file read and write grants reach sandboxed command steps', async () => {
      const inputPath = join(workspace.cwd, 'policy-schema.json');
      const outputDir = join(workspace.cwd, 'policy-dist');
      const outputPath = join(outputDir, 'out.txt');
      await mkdir(outputDir);
      await writeFile(inputPath, '{"ok":true}');
      await writePolicyWithFileGrants({
        readAllow: [inputPath],
        writeAllow: [`${outputDir}/**`],
      });
      await writeFile(
        join(workspace.cwd, 'policy-grants.runbook.md'),
        [
          '# Policy grants',
          '',
          '## 1. Read and write',
          '- PASS COMPLETE',
          '',
          '```bash',
          `node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(${JSON.stringify(
            inputPath,
          )}, "utf8")); fs.writeFileSync(${JSON.stringify(outputPath)}, "ok")'`,
          '```',
          '',
        ].join('\n'),
      );

      const result = await runCliInProcess(
        ['run', 'policy-grants.runbook.md', '--yes', '--sandbox', '--allow-run', 'node'],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expectSandboxedCommandCompleted(result.stdout, true);
      expect(await readFile(outputPath, 'utf8')).toBe('ok');
    });
  });
}
