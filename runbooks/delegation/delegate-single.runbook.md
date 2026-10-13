---
name: delegate-single
description: One delegated child — claim, drive, Collect, and the agent-confusion refusals around it
tags:
  - delegation

scenarios:
  pass:
    description: The sub-agent claims the ticket and passes its child; collect applies the pass
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET} --agent-id reviewer-1
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      collected:
        - step: '1.1'
          status: collected
          result: pass
      steps:
        - from: '1.1'
          result: PASS
          aggregated: true

  fail:
    description: The child fails; collect applies the fail and FAIL ANY STOP stops the parent
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET}
      - "! rd fail --token ${CHILD_TOKEN} --step Check"
      - "! rd collect --token ${TOKEN}"
    result: STOP
    expect:
      collected:
        - step: '1.1'
          status: collected
          result: fail

  pending:
    description: Collect before the child finishes reports it pending and applies nothing
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET}
      - rd collect --token ${TOKEN}
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      collected:
        - step: '1.1'
          status: pending
        - step: '1.1'
          status: collected
          result: pass

  unclaimed:
    description: Collect before any agent claims the ticket reports the child unclaimed
    commands:
      - rd run delegate-single.runbook.md
      - rd collect --token ${TOKEN}
      - rd claim ${TICKET}
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      collected:
        - status: unclaimed
        - status: collected

  double-claim-refused:
    description: A second claim of the same ticket is refused ALREADY_CLAIMED; the first child is unaffected
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET}
      - "! rd claim ${TICKET}"
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      errors:
        - code: ALREADY_CLAIMED
          command: claim

  claim-after-parent-terminal-refused:
    description: Once the parent has stopped, its ticket is refused PARENT_RUN_FINISHED and nothing is created
    commands:
      - rd run delegate-single.runbook.md
      - rd stop --token ${TOKEN}
      - "! rd claim ${TICKET}"
    result: STOP
    expect:
      errors:
        - code: PARENT_RUN_FINISHED
          command: claim

  child-command-after-parent-terminal-refused:
    description: A claimed child's command after its parent stopped is refused PARENT_RUN_FINISHED
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET}
      - rd stop --token ${TOKEN}
      - "! rd pass --token ${CHILD_TOKEN} --step Check"
    result: STOP
    expect:
      errors:
        - code: PARENT_RUN_FINISHED
          command: pass

  stale-child-refused:
    description: The owner decides the substep and re-enters the step; the stale child's command is DELEGATION_CANCELLED, and the fresh ticket is claimed and Collected
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET}
      - rd pass --token ${TOKEN} --step 1.1
      - rd fail --token ${TOKEN} --step 2
      - "! rd pass --token ${CHILD_TOKEN} --step Check"
      - rd claim ${TICKET_2}
      - rd pass --token ${CHILD_TOKEN_2} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      errors:
        - code: DELEGATION_CANCELLED
          command: pass

  lost-ticket-retried:
    description: The owner lost the ticket; retry cancels the unclaimed child and prints a new ticket, and the old one is refused DELEGATION_CANCELLED
    commands:
      - rd run delegate-single.runbook.md
      - rd retry --token ${TOKEN} --step 1.1
      - "! rd claim ${TICKET}"
      - rd claim ${TICKET_2}
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      errors:
        - code: DELEGATION_CANCELLED
          command: claim
      collected:
        - step: '1.1'
          status: collected
          result: pass

  lost-child-token-retried:
    description: The sub-agent lost its child's token; retry cancels the claimed child, whose commands are refused, and a fresh child is claimed and Collected
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET}
      - rd retry --token ${TOKEN} --step 1.1
      - "! rd pass --token ${CHILD_TOKEN} --step Check"
      - rd claim ${TICKET_2}
      - rd pass --token ${CHILD_TOKEN_2} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      errors:
        - code: DELEGATION_CANCELLED
          command: pass
      collected:
        - step: '1.1'
          status: collected
          result: pass

  release-collected-as-fail:
    description: The sub-agent releases the child it claimed; the child is abandoned and collect applies it as a fail
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET} --agent-id reviewer-1
      - rd release ${CHILD_RUN} --agent-id reviewer-1
      - "! rd collect --token ${TOKEN}"
    result: STOP
    expect:
      collected:
        - step: '1.1'
          status: collected
          result: fail

  release-other-agent-refused:
    description: A release naming another agent than the claim recorded is AGENT_MISMATCH; the child is unaffected
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET} --agent-id reviewer-1
      - "! rd release ${CHILD_RUN} --agent-id reviewer-2"
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      errors:
        - code: AGENT_MISMATCH
          command: release

  wrong-run-step-refused:
    description: The child's token naming the parent's step is INVALID_STEP; nothing is written
    commands:
      - rd run delegate-single.runbook.md
      - rd claim ${TICKET}
      - "! rd pass --token ${CHILD_TOKEN} --step 1.1"
      - "! rd pass --token ${TOKEN} --step Check"
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      errors:
        - code: INVALID_STEP
          command: pass
        - code: INVALID_STEP
          command: pass
---

# Delegate (Single)

## 1. Delegate the check

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- delegation-child-manual.runbook.md

## 2. Verify

- PASS COMPLETE
- FAIL GOTO 1

Verify the delegated work.
