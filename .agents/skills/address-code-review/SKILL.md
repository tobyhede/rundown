---
name: address-code-review
description: Verify and fix code review findings — this session's review plus any pasted from parallel agents — each confirmed defect fixed test-first with a regression test.
disable-model-invocation: true
---

# address-code-review

Turn code review findings into verified fixes. A finding is a claim, not a fact: every one earns a **verdict** backed by evidence before any code changes, and a confirmed defect goes **red first** — a regression test that fails on the current code — so the test outlives the fix.

## Inputs

The findings already in this session's context (a code review run earlier in the conversation), merged with any pasted into the invocation — that is how parallel agents' findings arrive. With neither, stop and ask for findings. This skill starts from a list of findings; producing that list is a review's job.

## Steps

1. **Ledger.** Merge every finding into one ledger: a short id minted here and used in every prompt and in the report, file:line, claim, failure scenario, severity, source. Normalise each source's severity to critical/major/minor and keep the original wording beside it. The same defect reported twice is one entry with two sources. Order most-severe first. Completion: every input finding appears in the ledger exactly once.

2. **Partition.** Group findings by the files their claims cite, pooling any two findings that share one. The groups are disjoint by construction, so they dispatch as a single parallel batch. Completion: every ledger entry sits in exactly one group, and no file appears in two groups.

3. **Delegate.** Route each group through the focused skill or smallest combination of focused skills whose descriptions match its ledger entries; use a general-purpose agent only when no focused skill matches. Dispatch one agent per group, all groups in one parallel batch, pooling the smallest groups if that would exceed a workable number of concurrent agents. Name the selected skills and their paths in each prompt, require the delegate to read them before acting, and carry the group's ledger entries verbatim — a delegate cannot see this conversation, so a prompt naming ids alone arrives empty. Each agent works its entries most-severe first:
   - **Investigate and verify.** Read the code and either reproduce the failure scenario or trace exactly why it cannot happen. Verdict: `confirmed`, `refuted`, or `needs-decision` for a finding that turns on a product or design decision. Each verdict carries its evidence, and `needs-decision` states the question.
   - **Fix, red first.** A confirmed finding that describes behaviour gets its regression test first: the test fails on the current code for that exact failure scenario, and only then is made to pass. A behavioural finding that will not go red is evidence the verdict was wrong — return to verification rather than fixing blind. A confirmed finding with no behaviour to regress — naming, duplication, a convention or ADR point — is fixed without a new test.
   - **Stay inside the group.** A fix that needs a file outside the group stops there and returns that entry unfixed, naming the file it wanted.

   Each agent returns, per entry: the verdict, its evidence, and for a fixed entry the regression test's file:line and the red output that proved the finding real. A batch that returns deferred entries re-partitions just those by step 2's rule and dispatches again; a batch that defers every entry it was given is a cycle, so those entries pool into one group worked by a single agent, which is not bound by its group's file set — the constraint keeps concurrent agents off one file, and there is no second writer left. Completion: every ledger entry has a verdict and none is left deferred.

4. **Verify the tree.** Run the repository's verification bar (AGENTS.md "Before claiming done") and report the real output. A failure returns the responsible entry — or entries, where the failure is not attributable to one — to step 3, and the bar runs again. Completion: a green run, with its output reported.

5. **Report.** Map each ledger entry to exactly one outcome:
   - `fixed` — the change, plus the regression test's file:line, or `no test — no behaviour to regress`.
   - `refuted` — the evidence.
   - `needs-decision` — the decision the user must make.

   Completion: every ledger entry carries an outcome; a dropped or merged finding is visible in the report, never silent.
