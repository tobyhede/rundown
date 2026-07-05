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
   interpret the first step's output (including a delegation) the moment it
   appears, rather than scrambling for the protocol after `rundown run` has fired:

   ```text
   Skill(skill: "rundown:running-runbooks")
   ```

   If the runbook contains a `- DELEGATE` step, also load the delegation
   protocol:

   ```text
   Skill(skill: "rundown:delegating-runbooks")
   ```

3. **Start it.**

   ```bash
   rundown run <name>
   ```

   Capture the run id when you start the runbook: `rundown run` prints it at
   start and every subsequent event carries it as `runbookId`. You need it for
   every mutating command you issue as the orchestrator of a delegation-exposed
   run.

   Pass inputs if the runbook requires them:

   ```bash
   rundown run <name> --input key=value
   ```

   If `rundown run` reports missing required inputs, supply them and re-run.

4. **Execute.** Follow the loaded
   [running-runbooks](../running-runbooks/SKILL.md) protocol: respond to each
   step with `rundown pass` / `rundown fail` and trust Rundown for transitions.
   On a delegation-exposed run (any runbook with a `- DELEGATE` step), these
   become `rundown pass --run <rd_…>` / `rundown fail --run <rd_…>` — the bare
   form is for standalone runs only and otherwise refuses with
   `ACTOR_CONTEXT_REQUIRED`.

## Reference

- [running-runbooks](../running-runbooks/SKILL.md) — the execution protocol
- [writing-runbooks](../writing-runbooks/SKILL.md) — authoring runbooks
