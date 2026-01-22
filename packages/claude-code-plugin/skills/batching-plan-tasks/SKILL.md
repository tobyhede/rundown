 Part 2: Batching Skill Definition

 Skill: cipherpowers:plan-to-batches

 Purpose: Transform an implementation plan into executable batches
 with code review checkpoints.

 When to use: After receiving a complete implementation plan, before
  execution begins.

 ---
 Input

 A plan file containing:
 - Numbered tasks (Task 0, 1, 2, ...)
 - Each task specifies files to modify
 - Some tasks have explicit dependencies (uses output from another
 task)

 ---
 Process

 Step 1: Build Dependency Graph

 For each task, identify:

 1. Explicit Dependencies - Task mentions using output from another
 task
   - Example: "Uses as_physics_position() from Task 0"
 2. File Conflicts - Tasks modifying the same file
   - Example: Tasks 1, 3, 4 all modify orbital_paths.rs
 3. Sequential Plugin Changes - Later tasks assume earlier task's
 changes
   - Example: Task 2 modifies plugin.rs after Task 1's changes to
 same file

 Output: Dependency matrix

 Task 0: [] (no dependencies)
 Task 1: [] (no dependencies)
 Task 2: [1] (plugin.rs state)
 Task 3: [1] (file conflict: orbital_paths.rs)
 Task 4: [0, 1, 3] (accessor dependency + file conflict)

 Step 2: Identify Parallelizable Groups

 Tasks can run in parallel IFF:
 - No dependency relationship (neither depends on the other)
 - No file conflicts (modify different files)
 - No implicit ordering (don't assume each other's changes)

 Parallel candidates for this plan:
 - Task 0 ↔ Task 1: Different files, no dependencies ✓ PARALLEL

 Step 3: Group into Batches

 Rules:
 1. Batch size: 2-4 tasks (default 3)
 2. All parallel tasks in one batch
 3. Sequential tasks in order of dependency
 4. Every batch ends with verification

 Algorithm:
 1. Start with tasks that have no dependencies → first batch
 (parallel if possible)
 2. Remove completed tasks from dependency lists
 3. Find tasks whose dependencies are now satisfied → next batch
 4. Repeat until all tasks batched

 Step 4: Insert Code Reviews

 - Code review after EVERY batch
 - For parallel batches: review all parallel work together
 - For sequential batches: review at end of batch (not between
 tasks)

 ---
 Output Format

 ## Batch Structure

 ### Parallel Batch N (X tasks)
 Execute in parallel.

 | Task | Description | Files |
 |------|-------------|-------|
 | Task X | ... | ... |
 | Task Y | ... | ... |

 **Why parallel:** [explanation]

 ### Code Review Checkpoint

 ---

 ### Sequential Batch M (Y tasks)
 Execute sequentially.

 | Task | Description | Depends On | Files |
 |------|-------------|------------|-------|
 | Task A | ... | Task X | ... |
 | Task B | ... | Task A | ... |

 **Why sequential:** [explanation]

 ### Code Review Checkpoint

 ---
 Worked Example: This Plan

 Input tasks:
 - Task 0: types layer changes
 - Task 1: remove toggle function
 - Task 2: scheduling changes
 - Task 3: change detection
 - Task 4: typed accessors

 Step 1 - Dependencies:
 0 → []
 1 → []
 2 → [1]
 3 → [1] (file)
 4 → [0, 1, 3] (accessor + file)

 Step 2 - Parallel check:
 - Task 0 files: types/render.rs, physics/components/mod.rs
 - Task 1 files: orbital_paths.rs, mod.rs, plugin.rs,
 orbital_path_visibility.rs
 - No overlap → Tasks 0 and 1 can parallel

 Step 3 - Batching:
 - Batch 1: [0, 1] parallel (no deps, no file conflicts)
 - After Batch 1: Tasks 2, 3, 4 have deps satisfied
 - Batch 2: [2, 3, 4] sequential (file conflicts between 3/4,
 plugin.rs ordering for 2)

 Step 4 - Code reviews:
 - Review after Batch 1
 - Review after Batch 2

 Output: 2 batches as shown in Part 1 above.

 ---
 Edge Cases

 All tasks sequential:
 - Single file being modified throughout
 - Break into batches of 3 with reviews between

 All tasks parallel:
 - No file conflicts, no dependencies
 - Single batch, but consider splitting if >4 tasks for manageable
 review

 Diamond dependencies:
     A
    / \
   B   C
    \ /
     D
 - Batch 1: A
 - Batch 2: B, C (parallel)
 - Batch 3: D

 ---
 Anti-Patterns

 1. Skipping code review - Reviews catch integration issues early
 2. Oversized batches - >4 tasks makes review overwhelming
 3. Undersized batches - 1 task per batch is too much overhead
 4. Ignoring file conflicts - Parallel edits to same file cause
 merge hell
 5. Missing implicit dependencies - One task assumes another's
 changes exist

 ---
 Verification Checklist

 After all batches complete:

 - mise run test:fast - All tests pass
 - mise run check - No new warnings
 - cargo run - Visual verification: paths render correctly
 - Toggle paths with 'O' key - Still works
 - Change camera focus (Tab key) - Paths update correctly
 - No visual jitter when stationary