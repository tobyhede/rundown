import { type HookInput, type GateResult, logger, safeJoin, sanitizePathSegment, parseRunbookFromFrontmatter } from '../shared/index.js';
import { rundown } from '../workflow/hooks/rundown.js';
import * as fs from 'fs';

/**
 * Execute the skill start gate.
 *
 * Parses skill frontmatter for `runbook:` field and auto-starts
 * the declared runbook when a skill begins.
 *
 * @param input - The hook input containing event details and context
 * @returns Gate result with optional additional context from runbook execution
 */
export function execute(input: HookInput): Promise<GateResult> {
  // Only handle SkillStart
  if (input.hook_event_name !== 'SkillStart') {
    return Promise.resolve({});
  }

  const skillName = input.skill;
  if (!skillName) return Promise.resolve({});

  // Find skill file and parse frontmatter
  const runbook = findSkillRunbook(skillName, input.cwd);
  if (!runbook) return Promise.resolve({});

  // Validate runbook path to prevent command injection and path traversal
  if (!/^[\w./-]+$/.test(runbook) || runbook.includes('..')) {
    void logger.warn('Invalid runbook path rejected', { runbook, skill: skillName });
    return Promise.resolve({});
  }

  // Start runbook via CLI
  try {
    rundown(['run', runbook], input.cwd);
    return Promise.resolve({
      additionalContext: `Started runbook: ${runbook}`
    });
  } catch {
    // Graceful degradation - runbook start failed
    return Promise.resolve({});
  }
}

/**
 * Find skill SKILL.md and extract runbook from frontmatter
 */
function findSkillRunbook(skillName: string, cwd: string): string | undefined {
  // Parse namespace:name format
  const colonIndex = skillName.indexOf(':');
  // SECURITY: Sanitize components
  const name = sanitizePathSegment(colonIndex >= 0 ? skillName.substring(colonIndex + 1) : skillName);

  // Search paths for SKILL.md
  const searchPaths: string[] = [];

  // Plugin skills (via CLAUDE_PLUGIN_ROOT)
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    try {
      searchPaths.push(safeJoin(pluginRoot, 'skills', name, 'SKILL.md'));
    } catch {
      // Path traversal attempt or other path error - skip plugin path
    }
  }

  // User skills (in project .claude directory)
  try {
    searchPaths.push(safeJoin(cwd, '.claude', 'skills', name, 'SKILL.md'));
  } catch {
    // Path traversal attempt or other path error - skip user path
  }

  for (const skillPath of searchPaths) {
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      const runbook = parseRunbookFromFrontmatter(content);
      if (runbook) return runbook;
    } catch {
      continue;
    }
  }

  return undefined;
}
