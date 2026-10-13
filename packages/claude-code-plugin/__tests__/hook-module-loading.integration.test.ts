/**
 * The hook entrypoint loads only what an event needs (review finding H7).
 *
 * Every Bash call runs the PreToolUse(Bash) hook, so it must not pay for
 * `@rundown-org/core`: the stamp is a small string rewrite. The core-dependent gates
 * (Agent/Task dispatch, SubagentStop) load it lazily. Drives the built
 * entrypoint, as Claude Code does, with a module resolve hook reporting
 * whether core was ever resolved.
 */
import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Registers a resolve hook that reports `@rundown-org/core` on stderr. */
const REPORT_CORE = `data:text/javascript,${encodeURIComponent(
  [
    "import { registerHooks } from 'node:module';",
    'registerHooks({ resolve(specifier, context, next) {',
    "  if (specifier.startsWith('@rundown-org/core')) process.stderr.write('RESOLVED_CORE\\n');",
    '  return next(specifier, context);',
    '} });',
  ].join('\n'),
)}`;

function runHook(input: Record<string, unknown>) {
  return spawnSync('node', ['--import', REPORT_CORE, 'dist/cli.js'], {
    cwd: pluginRoot,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, RUNDOWN_LOG: '0' },
  });
}

describe('hook module loading', () => {
  it('stamps a Bash claim without loading @rundown-org/core', () => {
    const result = runHook({
      hook_event_name: 'PreToolUse',
      cwd: pluginRoot,
      tool_name: 'Bash',
      agent_id: 'agent-1',
      tool_input: { command: `rundown claim rdt_${'A'.repeat(43)}` },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        updatedInput: { command: `rundown claim --agent-id 'agent-1' rdt_${'A'.repeat(43)}` },
      },
    });
    expect(result.stderr).not.toContain('RESOLVED_CORE');
  });

  it('loads core for the dispatch gate, which needs it', () => {
    const result = runHook({
      hook_event_name: 'PreToolUse',
      cwd: pluginRoot,
      tool_name: 'Agent',
      tool_input: { prompt: 'Plain task.' },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('RESOLVED_CORE');
  });
});
