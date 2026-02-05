---
name: using-rundown
description: Using the Rundown CLI to transform static markdown docs into interactive workflows. CLI commands control progress - when working with runbooks, responding to step prompts, or managing runbook state
use_when: Use when working with rundown runbooks.
---

# Using Rundown

Rundown runbooks are markdown docs that define steps, commands, and transition rules.
The CLI executes the runbook, guiding agents (and humans) step-by-step through the process.

## Quick Reference

`rd run <file>` then for each step:
  - Command: wait
  - Prompt: act then `rd pass` or `rd fail`


## Rundown Runbooks

A rundown runbook guides you through a sequence of steps.
A step can either:
 - automatically run a Command
 - output a Prompt for you to follow

Each step has a `PASS` and `FAIL` condition that determines the transition to the next step.

Command steps:
 - execute automatically
 - output to stdout for review
 - exit code determines result and transition:
   - `0` is `PASS`
   - Non-zero is `FAIL`

Prompt steps:
 - output instructions to follow
 - manually trigger transition by calling the `rd pass` or `rd fail` commands

The default transitions for all steps:
  - `PASS: CONTINUE` (proceed to next step)
  - `FAIL: STOP` (halt execution)


## Core Workflow

1. `rd run <file>` - run the runbook
2. For each step:
    - Command: wait for execution and transition on exit code
    - Prompt: follow instructions exactly, then call `rd pass` or `rd fail`
3. Repeat for each step until `COMPLETE` or `STOP`


## Example

Given a runbook `deploy.md`:

````markdown
## 1. Run tests
- PASS: CONTINUE
- FAIL: STOP

```bash
npm test
```

## 2. Review changes
Check git diff for unintended changes.

## 3. Deploy

```bash
npm run deploy
```
````

Execution flow:
1. `rd run deploy.md` - starts runbook
2. Step 1 auto-executes `npm test` - advances on exit 0
3. Step 2 outputs prompt instruction
4. `rd pass` - manually mark the prompt instruction result as `PASS`
5. Step 3 auto-executes `npm run deploy` - advances and completes on exit 0


## Supporting Commands

| Command               | Description                                                 |
| --------------------- | ----------------------------------------------------------- |
| run [file]            |  Start a runbook, queue a step, or bind an agent            |
| pass|yes [options]    |  Mark current step as passed (triggers PASS transition)     |
| fail|no [options]     |  Mark current step as failed (triggers FAIL transition)     |
| status [options]      |  Show current runbook state                                 |
| stop [options]        |  Abort current runbook                                      |
| help [command]        |  display help for command                                   |

Note: `pass` has aliases `yes` and `ok`. `fail` has alias `no`.

## Important

- You MUST use the Rundown CLI when skill instruction, command, or prompt includes a reference to a runbook
- You MUST follow all step prompt instructions exactly
- You MUST complete ALL steps - DO NOT abandon a runbook
