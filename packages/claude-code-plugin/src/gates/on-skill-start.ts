import { type HookInput, type GateResult, logger, safeJoin, sanitizePathSegment } from '../shared/index.js';
import { execFileSync } from 'child_process';
import * as fs from 'fs';

/**
 * On Skill Start Gate
 *
 * Parses skill frontmatter for `runbook:` field and auto-starts
 * the declared runbook when a skill begins.
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

  // Start runbook via CLI (using execFileSync to prevent shell injection)
  try {
    execFileSync('rundown', ['run', runbook], { cwd: input.cwd, stdio: 'pipe' });
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


/**
 * Parse runbook field from YAML frontmatter
 */
export function parseRunbookFromFrontmatter(content: string): string | undefined {
  // Match YAML frontmatter block (supports both LF and CRLF line endings)
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return undefined;

  // Extract runbook field from frontmatter
  const runbookMatch = /^runbook:\s*(.+)$/m.exec(match[1]);
  return runbookMatch?.[1];
}