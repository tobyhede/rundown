import { type HookInput, type GateResult, logger } from '../shared/index.js';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Workflow Skill Start Gate
 *
 * Parses skill frontmatter for `workflow:` field and auto-starts
 * the declared workflow when a skill begins.
 */
export function execute(input: HookInput): Promise<GateResult> {
  // Only handle SkillStart
  if (input.hook_event_name !== 'SkillStart') {
    return Promise.resolve({});
  }

  const skillName = input.skill;
  if (!skillName) return Promise.resolve({});

  // Find skill file and parse frontmatter
  const workflow = findSkillWorkflow(skillName, input.cwd);
  if (!workflow) return Promise.resolve({});

  // Validate workflow path to prevent command injection and path traversal
  if (!/^[\w./-]+$/.test(workflow) || workflow.includes('..')) {
    void logger.warn('Invalid workflow path rejected', { workflow, skill: skillName });
    return Promise.resolve({});
  }

  // Start workflow via CLI (using execFileSync to prevent shell injection)
  try {
    execFileSync('rundown', ['run', workflow], { cwd: input.cwd, stdio: 'pipe' });
    return Promise.resolve({
      additionalContext: `Started workflow: ${workflow}`
    });
  } catch {
    // Graceful degradation - workflow start failed
    return Promise.resolve({});
  }
}

/**
 * Find skill SKILL.md and extract workflow from frontmatter
 */
function findSkillWorkflow(skillName: string, cwd: string): string | undefined {
  // Parse namespace:name format
  const colonIndex = skillName.indexOf(':');
  const name = colonIndex >= 0 ? skillName.substring(colonIndex + 1) : skillName;

  // Search paths for SKILL.md
  const searchPaths = [
    // Plugin skills (via CLAUDE_PLUGIN_ROOT)
    path.join(process.env.CLAUDE_PLUGIN_ROOT ?? '', 'skills', name, 'SKILL.md'),
    // User skills (in project .claude directory)
    path.join(cwd, '.claude', 'skills', name, 'SKILL.md')
  ];

  for (const skillPath of searchPaths) {
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      const workflow = parseWorkflowFromFrontmatter(content);
      if (workflow) return workflow;
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Parse workflow field from YAML frontmatter
 */
export function parseWorkflowFromFrontmatter(content: string): string | undefined {
  // Match YAML frontmatter block
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return undefined;

  // Extract workflow field from frontmatter
  const workflowMatch = /^workflow:\s*(.+)$/m.exec(match[1]);
  return workflowMatch?.[1];
}
