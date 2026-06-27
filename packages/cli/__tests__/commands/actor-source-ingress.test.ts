import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  getActiveState,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('--actor-source / RD_ACTOR_SOURCE ingress', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('accepts a valid --actor-source flag without disturbing a read-only command', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    // `status` does not construct actor context (so it neither validates nor
    // uses the source), but the capture-only flag must parse cleanly.
    const result = await runCliInProcess('--actor-source plugin status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/unknown option/i);
  });

  // CROSS-PLAN PIN (Plan 7 / MCP): the MCP server spawns
  // `npx --no rundown --actor-source mcp <subcommand> ...` — the flag is a
  // PROGRAM-LEVEL token BEFORE the subcommand, and MCP cannot use the
  // RD_ACTOR_SOURCE env bridge (docs/reference/mcp.md §4: the CLI MUST inherit
  // the server env unmodified). These tests pin that `--actor-source` is parsed
  // pre-subcommand and advertised at program level, so a refactor cannot quietly
  // move it onto a per-subcommand registration and break MCP.
  it('parses --actor-source as a program-level token placed BEFORE the subcommand', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    // mcp source, no claim, bare pass while NOT pending: must transition
    // normally (proving the pre-subcommand flag was consumed, not rejected as an
    // unknown option, and not mistaken for a subcommand argument). `pass` is
    // migrated in Task 6; until then the flag is captured-but-unused and the
    // transition still succeeds.
    const result = await runCliInProcess('--actor-source mcp pass --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/unknown option/i);
    const state = await getActiveState(workspace);
    expect(state?.step).toBe('2');
  });

  it('advertises --actor-source at the program level in --help', async () => {
    const result = await runCliInProcess('--help', workspace);

    // Program-level help (not a subcommand help) must list the flag, proving it
    // is registered on the program, not on an individual subcommand.
    expect(result.stdout).toMatch(/--actor-source/);
  });
});
