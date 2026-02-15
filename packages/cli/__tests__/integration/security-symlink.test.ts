import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace } from '../helpers/test-utils.js';
import { writeFile, symlink, unlink } from 'fs/promises';
import { lstatSync } from 'node:fs';
import { join, dirname } from 'path';
import { resolveVariables } from '../../src/services/variable-discovery.js';

describe('Security: Symlink Traversal', () => {
  let workspace: any;
  let secretPath: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const parentDir = dirname(workspace.cwd);
    secretPath = join(parentDir, `secret-outside-${Math.random().toString(36).slice(2)}.txt`);
    await writeFile(secretPath, 'SECRET_CONTENT');
  });

  afterEach(async () => {
    await workspace.cleanup();
    await unlink(secretPath).catch(() => {
      /* cleanup best-effort */
    });
  });

  it('should block resolveVariables from following symlinks escaping the project directory', async () => {
    const linkPath = join(workspace.cwd, 'secret-link');
    try {
      await symlink(secretPath, linkPath);
    } catch (e) {
      console.warn('Skipping symlink test due to symlink creation failure', e);
      return;
    }
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    // Call resolveVariables with a "file:secret-link" variable
    // It should ideally block this because it points outside the project.
    const result = await resolveVariables(
      {
        var: [`my_source=file:secret-link`],
      },
      workspace.cwd,
    );

    // If vulnerable, my_source WILL be in sources.
    // If secured, my_source WILL NOT be in sources (it would have been ignored with a warning).

    // CURRENT BEHAVIOR: It is now BLOCKED (SECURED)
    expect(result.sources).not.toHaveProperty('my_source');
    expect(result.vars).not.toHaveProperty('my_source');
  });
});
