import {
  type HookInput,
  type GateResult,
  logger,
  safeJoin,
  isValidRunbookPath,
  findRunbookByFrontmatter,
} from '../shared/index.js';
import { rundown } from '../workflow/hooks/rundown.js';

/**
 * Execute the skill start gate.
 *
 * Parses skill frontmatter for `runbook:` field and auto-starts
 * the declared runbook when a skill begins.
 *
 * @param input - The hook input containing event details and context
 * @returns Gate result with optional additional context from runbook execution
 * @remarks Does not throw — errors are caught internally and appropriate values returned (empty context on error)
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
    rundown(['run', runbook], input.cwd);
    return Promise.resolve({
      additionalContext: `Started runbook: ${runbook}`,
    });
  } catch {
    // Graceful degradation - runbook start failed
    return Promise.resolve({});
  }
}
