---
name: following-plans
description: Algorithmic decision tree for when to follow plan exactly vs when to report STOPPED - prevents scope creep and unauthorized deviations
when_to_use: embedded in agent prompts during plan execution, not called directly
version: 1.0.0
---

# Following Plans

## Overview

This skill is **embedded in agent prompts** during plan execution. It provides an algorithmic decision tree for determining when to follow the plan exactly vs when to report STOPPED.

**Purpose:** Prevent agents from rationalizing "simpler approaches" that were already considered and rejected during design.

## When to Use

This skill is **embedded in agent prompts during plan execution**. It applies when:

- Agent executing implementation plan encounters situation requiring deviation
- Current approach in plan seems problematic or won't work
- Agent discovers syntax errors or naming issues in plan
- Agent wants to use "simpler approach" than plan specifies
- Tests fail with planned approach
- Plan contains contradictions or errors

**This skill prevents:**
- Unauthorized architectural changes during execution
- Scope creep from "better ideas" during implementation
- Rationalization of deviations without approval
- Silent changes that break plan assumptions

## Quick Reference

```
Is change syntax/naming only?
├─ YES → Fix it, note in completion, STATUS: OK
└─ NO → Does it change approach/architecture?
    ├─ YES → Report STATUS: STOPPED with reason
    └─ NO → Follow plan exactly, STATUS: OK
```

**Allowed without STOPPED:**
- Syntax corrections (wrong function name in plan)
- Error handling implementation details
- Variable naming choices
- Code organization within file
- Test implementation details

**Requires STOPPED:**
- Different algorithm or approach
- Different library/framework
- Different data structure/API design
- Skipping/adding planned functionality
- Refactoring not in plan

## Implementation Boundaries

When evaluating changes from plan:

| Domain | Within Boundaries (tsv pass) | Exceeds Boundaries (tsv fail) |
|--------|-----------------------------|-------------------------------|
| Logic | syntax/naming | algorithm changes |
| Deps | calls within lib | swap library |
| Scope | edge cases | add/skip features |
| Interface | private | public APIs/schemas |

## Algorithmic Decision Tree

**Follow this exactly. No interpretation.**

### Step 1: Check if this is a syntax/naming fix

```
Is the change you want to make limited to:
- Correcting function/variable names
- Fixing syntax errors
- Updating import paths
- Correcting typos in code

YES → Make the change
      Add note to task completion: "Fixed syntax: {what you fixed}"
      Continue to Step 4

NO → Continue to Step 2
```

### Step 2: Check if this changes approach/architecture

```
Does your change alter:
- The overall approach or algorithm
- The architecture or structure
- Which libraries/frameworks to use
- The data model or API design

YES → STOP
      Report STATUS: STOPPED
      Continue to Step 3

NO → Continue to Step 4
```

### Step 3: Report STOPPED (Required Format)

<EXTREMELY-IMPORTANT>
```
STATUS: STOPPED
REASON: [Explain why plan approach won't work and what you want to do instead]
TASK: [Task identifier from plan]

Example:
STATUS: STOPPED
REASON: Plan specifies JWT auth but existing service uses OAuth2. Implementing JWT would require refactoring auth service.
TASK: Task 3 - Implement authentication middleware
```

**STOP HERE. Do not proceed with implementation.**
</EXTREMELY-IMPORTANT>

### Step 4: Follow plan exactly

```
Implement the task exactly as specified in plan.

Report STATUS: OK when complete.
```

## Status Reporting (REQUIRED)

<EXTREMELY-IMPORTANT>
**Every task completion MUST include STATUS.**
</EXTREMELY-IMPORTANT>

### STATUS: OK

Use when task completed as planned:
```
STATUS: OK
TASK: Task 3 - Implement authentication middleware
SUMMARY: Implemented JWT authentication middleware per plan specification.
```

### STATUS: STOPPED

Use when plan approach won't work:
```
STATUS: STOPPED
REASON: [Clear explanation]
TASK: [Task identifier]
```

**Missing STATUS = gate will block you from proceeding.**

## Red Flags (Rationalization Defense)

If you're thinking ANY of these thoughts, you're about to violate the plan:

| Thought | Reality |
|---------|---------|
| "This simpler approach would work better" | Simpler approach was likely considered and rejected in design. Report STOPPED. |
| "The plan way seems harder than necessary" | Plan reflects design decisions you don't have context for. Follow plan or report STOPPED. |
| "I can just use library X instead" | Library choice is architectural decision. Report STOPPED. |
| "This is a minor architectural change" | All architecture changes require approval. Report STOPPED. |
| "The tests would pass if I just..." | Making tests pass ≠ meeting requirements. Follow plan or report STOPPED. |
| "I'll note the deviation in my summary" | Deviations require explicit approval BEFORE implementation. Report STOPPED. |

**All of these mean: STOP. Report STATUS: STOPPED.**

## What Counts as "Following Plan Exactly"

**Allowed without STOPPED:**
- Syntax corrections (wrong function name in plan)
- Error handling implementation details (plan says "validate input", you choose validation approach)
- Variable naming (plan says "store user data", you choose variable name)
- Code organization within a file (where to place helper functions)
- Test implementation details (plan says "add tests", you write specific test cases)

**Requires STOPPED:**
- Different algorithm or approach
- Different library/framework
- Different data structure
- Different API design
- Skipping planned functionality
- Adding unplanned functionality
- Refactoring not in plan

## Common Scenarios

### Scenario: Plan has wrong function name

```
Plan says: "Call getUserData()"
Reality: Function is actually getUser()

Decision: Fix syntax
Action: Use getUser(), note in completion
Status: OK
```

### Scenario: Plan approach seems unnecessarily complex

```
Plan says: "Implement manual JWT verification"
Your thought: "Library X does this better and simpler"

Decision: Architectural change
Action: Report STOPPED
Status: STOPPED
Reason: Plan specifies manual JWT verification but library X provides simpler approach. Should we use library instead?
```

### Scenario: Tests fail with planned approach

```
Plan says: "Use synchronous file reads"
Reality: Tests timeout with sync reads, async would fix

Decision: Approach change
Action: Report STOPPED
Status: STOPPED
Reason: Synchronous file reads cause test timeouts. Need async approach or different solution.
```

### Scenario: Plan contradicts itself

```
Plan Task 3: "Use PostgreSQL"
Plan Task 5: "Query MongoDB"

Decision: Plan error
Action: Report STOPPED
Status: STOPPED
Reason: Plan specifies both PostgreSQL (Task 3) and MongoDB (Task 5). Which should be used?
```

## Common Mistakes

**Mistake:** "This simpler approach would work better"
- **Why wrong:** Simpler approach was likely considered and rejected in design
- **Fix:** Report STATUS: STOPPED, don't implement

**Mistake:** "This is a minor architectural change"
- **Why wrong:** All architecture changes require approval
- **Fix:** Report STATUS: STOPPED for any approach/architecture change

**Mistake:** "I'll note the deviation in my summary"
- **Why wrong:** Deviations require explicit approval BEFORE implementation
- **Fix:** Report STATUS: STOPPED before making changes

**Mistake:** "The tests would pass if I just use library X instead"
- **Why wrong:** Making tests pass ≠ meeting requirements, library choice is architectural
- **Fix:** Report STATUS: STOPPED, explain issue

**Mistake:** "Forgot to include STATUS in my completion report"
- **Why wrong:** Missing STATUS = gate will block you from proceeding
- **Fix:** Always include STATUS: OK or STATUS: STOPPED

## Remember

- **Syntax fixes**: Allowed (note in completion)
- **Approach changes**: Report STOPPED
- **Architecture changes**: Report STOPPED
- **Plan errors**: Report STOPPED
- **Always provide STATUS**: OK or STOPPED
- **When in doubt**: Report STOPPED

**Better to report STOPPED unnecessarily than to deviate from plan without approval.**
