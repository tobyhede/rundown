---
name: rundown
description: Use when asked to run or start a Rundown runbook by name (e.g. "run the planning runbook", "start the deploy runbook") and no runbook is active yet. The launcher that resolves a runbook and begins execution. Invocable as /rundown <runbook>.
---

# Rundown Launcher

The entrypoint for starting a runbook from a cold start. This skill resolves a
runbook by name, starts it, and hands off to the execution protocol. It does not
contain the protocol itself.

## When to Use

- A user asks to "run"/"start the X runbook" and no runbook is active yet.
- Invoked directly as `/rundown <runbook>` with a runbook name.

## When NOT to Use

- A runbook is already active or CLI output asks for pass/fail — use
  [running-runbooks](../running-runbooks/SKILL.md).
- Authoring or editing a runbook file — use
  [writing-runbooks](../writing-runbooks/SKILL.md).
- A runbook has its own bootstrap skill (e.g. `planning`) — invoke that skill;
  it starts itself.

## Steps

1. **Resolve the runbook.** If the name is ambiguous or you are unsure it
   exists, list discoverable runbooks:

   ```bash
   rundown ls --all
   ```

   Names support `namespace:name` (e.g. `rundown:planning` for the plugin
   source). A bare name resolves via the priority chain (project → plugin →
   bundled).

2. **Load the execution protocol — before starting.** So you are ready to
   interpret the first step's output the moment it appears, rather than
   scrambling for the protocol after `rundown run` has fired:

   ```text
   Skill(skill: "rundown:running-runbooks")
   ```

3. **Start it.**

   ```bash
   rundown run <name>
   ```

   Capture `owner_token` from the `runbook_started` event it prints. It is shown
   once and never again, and every `pass`, `fail`, `goto`, `stop`, and
   `complete` on this run needs it as `--token <owner_token>`.

   Pass inputs if the runbook requires them:

   ```bash
   rundown run <name> --input key=value
   ```

   If `rundown run` reports missing required inputs, supply them and re-run. If
   it refuses with `RUNBOOK_COMPOSITION_UNSUPPORTED`, a substep lists more than one runbook: report that to the user and stop. Inline child runbooks (a substep listing one runbook, without `- DELEGATE`) run on your Owner Token; see running-runbooks. When a `step_entered` lists delegated `children` with Claim Tickets, follow the [delegating-runbooks](../delegating-runbooks/SKILL.md) skill: dispatch a sub-agent per ticket and apply results with `rundown collect --token <owner_token>`.

4. **Execute.** Follow the loaded
   [running-runbooks](../running-runbooks/SKILL.md) protocol: respond to each
   step with `rundown pass --token <owner_token> --step <position>` (or
   `rundown fail`) and trust Rundown for transitions.

## Reference

- [running-runbooks](../running-runbooks/SKILL.md) — the execution protocol
- [delegating-runbooks](../delegating-runbooks/SKILL.md) — orchestrating delegated children
- [writing-runbooks](../writing-runbooks/SKILL.md) — authoring runbooks
