import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const writingRunbooksDir = path.join(__dirname, '..', '..', 'skills', 'writing-runbooks');

/**
 * Read the writing-runbooks skill's artifact guidance. The rendering-helpers
 * reference lives in `artifacts.md`; SKILL.md carries the summary and the
 * common-mistakes guidance. Both are concatenated so the assertions hold
 * regardless of which file within the skill documents a given row.
 */
function readSkill(): string {
  const skill = readFileSync(path.join(writingRunbooksDir, 'SKILL.md'), 'utf-8');
  const artifacts = readFileSync(path.join(writingRunbooksDir, 'artifacts.md'), 'utf-8');
  return `${skill}\n${artifacts}`;
}

/**
 * These assertions pin the documented artifact-rendering behaviour to what the
 * core renderer actually does (see
 * `packages/core/src/runbook/renderer/artifact-helper.ts`):
 *
 * - direct alias `{{ Alias }}` -> `renderArtifactValue` -> local path
 * - `{{ path Alias }}` -> `renderArtifactPathValue` -> local path
 * - `{{ artifact Alias }}` -> `renderArtifactRecordValue` -> artifact URI
 *
 * The historical docs incorrectly described `{{ Alias }}` as rendering the URI.
 */
describe('writing-runbooks skill artifact rendering guidance', () => {
  it('documents direct alias and path helper as local-path renderings', () => {
    const skill = readSkill();

    // The rendering-helpers table row for the direct alias must say "local"
    // path, not "URI".
    expect(skill).toMatch(/\|\s*`\{\{ Alias \}\}`\s*\|\s*Local[^|]*path/i);
    expect(skill).toMatch(/\|\s*`\{\{ path Alias \}\}`\s*\|\s*Local[^|]*path/i);
  });

  it('documents the artifact helper as the URI rendering', () => {
    const skill = readSkill();

    expect(skill).toMatch(/\|\s*`\{\{ artifact Alias \}\}`\s*\|\s*Artifact URI/i);
  });

  it('does not claim the direct alias renders an artifact URI', () => {
    const skill = readSkill();

    // The bug was the direct-alias row reading "Artifact URI value(s)".
    expect(skill).not.toMatch(/`\{\{ Alias \}\}`\s*\|\s*Artifact URI/);
    // The common-mistakes guidance must not say `{{ Alias }}` renders a URI.
    expect(skill).not.toMatch(/`\{\{ Alias \}\}` and `\{\{ artifact Alias \}\}` render URI/);
  });
});
