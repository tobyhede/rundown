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
 * Execute the skill start gate.
 *
 * Parses skill frontmatter for `runbook:` field and auto-starts
 * the declared runbook when a skill begins.
 *
 * @param input - The hook input containing event details and context
 * @returns Gate result with optional additional context from runbook execution
 * @remarks Does not throw — errors are caught internally and appropriate values returned (structured error context on failure)
 */
export function execute(input: HookInput): Promise<GateResult> {
  // Only handle SkillStart
  if (input.hook_event_name !== 'SkillStart') {
    return Promise.resolve({});
  }

  const skillName = input.skill;
  if (!skillName) return Promise.resolve({});

  // Find skill file and parse frontmatter
  const runbook = findRunbookByFrontmatter(skillName, input.cwd, {
    buildPath: (root, name) => safeJoin(root, 'skills', name, 'SKILL.md'),
  });
  if (!runbook) return Promise.resolve({});

  // Validate runbook path to prevent command injection and path traversal
  if (!isValidRunbookPath(runbook)) {
    void logger.warn('Invalid runbook path rejected', { runbook, skill: skillName });
    return Promise.resolve({});
  }

  // Start runbook via CLI
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
 * Format runbook start output with running-runbooks skill invocation.
 *
 * @param runbook - Path or name of the started runbook
 * @param output - CLI output from the runbook start command
 * @returns Formatted context with runbook state and skill invocation instruction
 */
function formatRunbookOutput(runbook: string, output: string): string {
  return `
---
## RUNBOOK ACTIVE: ${runbook}

Invoke the running-runbooks skill: \`Skill(skill: "rundown:running-runbooks")\`

\`\`\`
${output.trim()}
\`\`\`
---
`.trim();
}
