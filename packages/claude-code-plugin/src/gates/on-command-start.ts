import { type HookInput, type GateResult, logger, safeJoin, sanitizePathSegment, parseRunbookFromFrontmatter } from '../shared/index.js';
import { rundown } from '../workflow/hooks/rundown.js';
import * as fs from 'fs';

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
  const runbook = findCommandRunbook(commandName, input.cwd);
  if (!runbook) return Promise.resolve({});

  // Validate runbook path to prevent command injection and path traversal
  if (!/^[\w./-]+$/.test(runbook) || runbook.includes('..')) {
    void logger.warn('Invalid runbook path rejected', { runbook, command: commandName });
    return Promise.resolve({});
  }

  // Start runbook via CLI and capture output
  try {
    const output = rundown(['run', runbook], input.cwd);
    return Promise.resolve({
      additionalContext: formatRunbookOutput(runbook, output)
    });
  } catch (error) {
    const execError = error as { message?: string; stdout?: string; stderr?: string };
    const errorOutput = execError.stdout ?? execError.stderr ?? execError.message ?? 'Unknown error';
    return Promise.resolve({
      additionalContext: formatRunbookError(runbook, errorOutput)
    });
  }
}

/**
 * Format successful runbook start output with instructions
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

/**
 * Format runbook error with recovery instructions
 */
function formatRunbookError(runbook: string, error: string): string {
  return `
---
## RUNBOOK ERROR: ${runbook}

### Error
\`\`\`
${error.trim()}
\`\`\`

### Manual Recovery
\`rd run ${runbook}\`
---
`.trim();
}

/**
 * Find command .md file and extract runbook from frontmatter
 */
function findCommandRunbook(commandName: string, cwd: string): string | undefined {
  // Parse namespace:name format (e.g., "rundown:write-plan" -> "write-plan")
  const colonIndex = commandName.indexOf(':');
  const name = sanitizePathSegment(colonIndex >= 0 ? commandName.substring(colonIndex + 1) : commandName);

  // Search paths for command file
  const searchPaths: string[] = [];

  // Plugin commands (via CLAUDE_PLUGIN_ROOT)
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    try {
      searchPaths.push(safeJoin(pluginRoot, 'commands', `${name}.md`));
    } catch {
      // Path traversal attempt - skip
    }
  }

  // Project commands
  try {
    searchPaths.push(safeJoin(cwd, '.claude', 'commands', `${name}.md`));
  } catch {
    // Path traversal attempt - skip
  }

  for (const cmdPath of searchPaths) {
    try {
      const content = fs.readFileSync(cmdPath, 'utf8');
      const runbook = parseRunbookFromFrontmatter(content);
      if (runbook) return runbook;
    } catch {
      continue;
    }
  }

  return undefined;
}

