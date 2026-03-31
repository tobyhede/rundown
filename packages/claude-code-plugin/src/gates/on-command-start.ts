import {
  type HookInput,
  type GateResult,
  logger,
  safeJoin,
  isValidRunbookPath,
  findRunbookByFrontmatter,
} from '../shared/index.js';
import { rundown } from '../workflow/hooks/rundown.js';
import { extractExecError, formatRunbookError } from './format-helpers.js';

/**
 * Execute the command start gate.
 *
 * Parses command frontmatter for `runbook:` field and auto-starts
 * the declared runbook when a slash command is invoked.
 *
 * @param input - The hook input containing event details and context
 * @returns Gate result with optional additional context from runbook execution
 * @remarks Does not throw — errors are caught internally and appropriate values returned (empty context on error)
 */
export function execute(input: HookInput): Promise<GateResult> {
  // Only handle SlashCommandStart
  if (input.hook_event_name !== 'SlashCommandStart') {
    return Promise.resolve({});
  }

  const commandName = input.command;
  if (!commandName) return Promise.resolve({});

  // Find command file and parse frontmatter
  const runbook = findRunbookByFrontmatter(commandName, input.cwd, {
    buildPath: (root, name) => safeJoin(root, 'commands', `${name}.md`),
  });
  if (!runbook) return Promise.resolve({});

  // Validate runbook path to prevent command injection and path traversal
  if (!isValidRunbookPath(runbook)) {
    void logger.warn('Invalid runbook path rejected', { runbook, command: commandName });
    return Promise.resolve({});
  }

  // Start runbook via CLI and capture output
  try {
    const output = rundown(['run', runbook], input.cwd);
    return Promise.resolve({
      additionalContext: formatRunbookOutput(runbook, output),
    });
  } catch (error) {
    const errorOutput = extractExecError(error);
    return Promise.resolve({
      additionalContext: formatRunbookError(runbook, errorOutput),
    });
  }
}

/**
 * Format successful runbook start output with instructions
 * @param runbook - Path or name of the started runbook
 * @param output - CLI output from the runbook start command
 * @returns Formatted markdown string with runbook status and usage instructions
 */
function formatRunbookOutput(runbook: string, output: string): string {
  return `
---
## RUNBOOK ACTIVE: ${runbook}

The runbook has been started automatically. You MUST follow the runbook steps.

### How to Use
- \`rd pass\` / \`rd yes\` - Mark step complete, advance
- \`rd fail\` / \`rd no\` - Mark step failed, branch
- \`rd status\` - See current step
- \`rd goto <n>\` - Jump to step

### Current State
\`\`\`
${output.trim()}
\`\`\`

**IMPORTANT**: Follow runbook prompts. Do NOT skip steps.
---
`.trim();
}

