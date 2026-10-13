import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillsDir = path.join(__dirname, '..', '..', 'skills');

function readSkill(relativePath: string): string {
  return readFileSync(path.join(skillsDir, relativePath), 'utf-8');
}

/**
 * Extract the body of the Markdown section introduced by `heading`, up to (but
 * excluding) the next heading at the same or higher level.
 *
 * Heading detection ignores lines inside fenced code blocks, so a bash comment
 * such as `# ... work through steps ...` does not prematurely terminate the
 * section.
 *
 * @param markdown - Full Markdown document to slice.
 * @param heading - Exact heading line that starts the section (e.g. `## Claiming Delegated Work`).
 * @returns The section text including its heading, or `''` when the heading is absent.
 */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const boundary = new RegExp(`^#{1,${String(level)}}\\s`);
  let inFence = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && boundary.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('running-runbooks owner-token guidance', () => {
  it('teaches every mutating command with the owner token', () => {
    const skill = readSkill('running-runbooks/SKILL.md');

    expect(skill).toContain('rundown pass --token <owner_token> --step');
    expect(skill).toContain('rundown fail --token <owner_token> --step');
    for (const command of ['goto <step>', 'stop [message]', 'complete [message]']) {
      expect(skill).toContain(`rundown ${command} --token <owner_token>`);
    }
    // Never a bare transition: without --token every mutation is refused.
    expect(skill).not.toMatch(/rundown (?:pass|fail)\s+(?:#|$)/m);
  });

  it('teaches no retired authority', () => {
    const skill = readSkill('running-runbooks/SKILL.md');

    expect(skill).not.toContain('--claim-id');
    expect(skill).not.toContain('ACTOR_CONTEXT_REQUIRED');
    expect(skill).not.toMatch(/rundown (?:delegate|abort|stash|pop)\b/);
  });

  it('teaches a claimed child to drive with its own token and stop when cancelled', () => {
    const claimed = section(readSkill('running-runbooks/SKILL.md'), '## Claimed Delegations');

    expect(claimed).toContain('rundown claim <ticket>');
    expect(claimed).toMatch(/child's \*\*own\*\*\s+`owner_token`/);
    expect(claimed).toContain('`DELEGATION_CANCELLED`');
    expect(claimed).toContain('`PARENT_RUN_FINISHED`');
  });

  it('sends the orchestrator to collect, never to pass the delegated substep', () => {
    const composed = section(readSkill('running-runbooks/SKILL.md'), '## Composed Runbooks');

    expect(composed).toContain('`rundown collect --token <owner_token>`');
    expect(composed).toMatch(/never `pass` the delegated substep/);
    expect(composed).not.toContain('RUNBOOK_COMPOSITION_UNSUPPORTED');
  });

  it('says the token is printed once and cannot be recovered', () => {
    const owner = section(readSkill('running-runbooks/SKILL.md'), '## The Owner Token');

    expect(owner).toContain('`runbook_started`');
    expect(owner).toContain('cannot\nbe recovered');
    expect(owner).toContain('`rundown status --run <run_id>`');
  });
});

describe('delegating-runbooks Delegation protocol', () => {
  const skill = readSkill('delegating-runbooks/SKILL.md');

  it('has the orchestrator read tickets from step_entered children and collect with its own token', () => {
    const orchestrator = section(skill, '## Orchestrator Choreography');

    expect(orchestrator).not.toBe('');
    expect(orchestrator).toContain('children: [{ step, index?, runId, runbook, ticket }]');
    expect(orchestrator).toContain('rundown collect --token <owner_token>');
    expect(orchestrator).toContain('`children_collected`');
    for (const status of ['collected', 'already_collected', 'pending', 'unclaimed', 'cancelled']) {
      expect(orchestrator).toContain(`| \`${status}\``);
    }
  });

  it('puts the ticket and the claim command in the dispatched prompt, because the hooks are inert', () => {
    const orchestrator = section(skill, '## Orchestrator Choreography');

    expect(orchestrator).toMatch(/rundown claim rdt_… --agent-id/);
    expect(orchestrator).toContain('Skill(skill: "rundown:running-runbooks")');
    expect(orchestrator).toMatch(/hooks are inert/);
  });

  it('has the sub-agent claim, drive with the child token, and stop on cancellation', () => {
    const subAgent = section(skill, '## Sub-agent Choreography');

    expect(subAgent).toContain('rundown claim <ticket>');
    expect(subAgent).toContain('rundown pass --token <child owner_token> --step <child step>');
    expect(subAgent).toContain('`DELEGATION_CANCELLED`');
    expect(subAgent).toContain('`PARENT_RUN_FINISHED`');
    expect(subAgent).toMatch(/never collect/);
  });

  it('covers every Delegation refusal code', () => {
    const refusals = section(skill, '## Refusals');

    for (const code of [
      'UNKNOWN_TICKET',
      'ALREADY_CLAIMED',
      'DELEGATION_CANCELLED',
      'PARENT_RUN_FINISHED',
      'NOTHING_TO_COLLECT',
      'NOTHING_TO_RETRY',
      'AGENT_MISMATCH',
    ]) {
      expect(refusals).toContain(`\`${code}\``);
    }
  });

  it('recovers a lost ticket, an unclaimed child or a lost child token with retry, never by telling the user (#905)', () => {
    const orchestrator = section(skill, '## Orchestrator Choreography');

    expect(orchestrator).toContain('rundown retry --token <owner_token> --step <substep>');
    expect(orchestrator).toContain('`delegation_retried`');
    expect(skill).not.toMatch(/no agent\s+recovery/);
  });

  it('has a sub-agent that cannot finish its child release it with its agent id (#905)', () => {
    const subAgent = section(skill, '## Sub-agent Choreography');
    const orchestrator = section(skill, '## Orchestrator Choreography');

    expect(subAgent).toContain('rundown release <child run id> --agent-id <id>');
    expect(orchestrator).toMatch(/rundown release rd_… --agent-id/);
  });

  it('has every sub-agent pass its agent id on claim and on release, since nothing stamps it', () => {
    const subAgent = section(skill, '## Sub-agent Choreography');

    expect(skill).not.toMatch(/`--agent-id` is optional/);
    expect(skill).not.toMatch(/omit it if the claim did/);
    expect(subAgent).toContain('rundown claim <ticket> --agent-id <id>');
    expect(subAgent).toMatch(/same `--agent-id`/);
    expect(skill).toMatch(/nothing stamps it/);
  });

  it('teaches no retired or unbuilt delegation surface', () => {
    expect(skill).not.toContain('--claim-id');
    expect(skill).not.toContain('rdtk_');
    expect(skill).not.toContain('RD_CLAIM_TOKEN');
    expect(skill).not.toMatch(/rundown (?:delegate|abort)\b/);
    expect(skill).not.toMatch(
      /ACTOR_CONTEXT_REQUIRED|OPEN_DELEGATED_CHILDREN|DELEGATION_SUPERSEDED/,
    );
    expect(skill).not.toMatch(/#904/);
  });
});

describe('running-runbooks Delegation recovery (#905), in both plugin copies', () => {
  const copies = {
    claude: readSkill('running-runbooks/SKILL.md'),
    codex: readFileSync(
      path.join(skillsDir, '..', 'codex-plugin', 'skills', 'running-runbooks', 'SKILL.md'),
      'utf-8',
    ),
  };

  it.each(Object.entries(copies))(
    '%s: a claimed child that cannot finish is released, and a lost ticket is retried',
    (_copy, skill) => {
      const claimed = section(skill, '## Claimed Delegations');
      expect(claimed).toContain('rundown release <child run id> --agent-id <id>');
      expect(skill).toContain('rundown retry --token <owner_token> --step <substep>');
      expect(skill).not.toMatch(/no agent\s+recovery/);
    },
  );

  it.each(Object.entries(copies))(
    '%s: a claimed child passes its agent id on claim and on release, since nothing stamps it',
    (_copy, skill) => {
      const claimed = section(skill, '## Claimed Delegations');
      expect(claimed).not.toMatch(/--agent-id is optional|omit it if the claim did/);
      expect(claimed).toContain('rundown claim <ticket> --agent-id <id>');
      expect(claimed).toMatch(/same\s+`--agent-id`/);
      expect(claimed).toMatch(/nothing\s+stamps\s+it/);
    },
  );
});
