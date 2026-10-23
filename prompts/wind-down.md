WIND-DOWN for run `{{slug}}` ({{reason}}; spent ${{costUsd}} of ${{budgetUsd}}). Obey this immediately. No human is present.

1. **Dispatch no new tasks.** Do not start any new worktree or review. The guard now allows dispatching to @oracle only.
2. Let running lanes finish their current step, or stop them. Do not start fix-up attempts.
3. For each task with uncommitted work in its worktree, run its verify commands.
   - If verification **passes**, commit it with a `wip:` subject prefix (`wip: <what>`, keep the repo's commit-format rules,
     including any in the workspace instructions).
   - If it **fails**, leave it uncommitted and record that in the task's `blockedReason`.
4. Append a TaskEvent for every unfinished task to `{{tasksJsonl}}` (`blocked` for started tasks, `skipped` for tasks never
   started), and update `{{statusMd}}`. **Tag every task you park**: its `blockedReason` (the reason field, for `skipped` tasks
   too) must start with `wind-down:`, for example `"wind-down: unfinished at soft stop"`. A later resume re-opens exactly the
   tasks with that tag, so do not use the prefix for tasks that are blocked for another reason. Log a Decision of kind `other` with
   `needsHumanAttention: true` that says the run was wound down and why.
5. Write the `## Narrative` section of `{{reportMd}}` (only that section; the code writes the rest): what is done, what is
   unfinished, and what the human should look at first.
6. Leave every integration branch in a reviewable state: committed (`wip:` where needed), no half-finished merge, and no
   uncommitted changes in the `_integration` worktrees. After this wind-down a short, oracle-only review of the
   integration branches follows (no fix-ups, no new tasks), so the branches must be ready to read.
7. Then **stop**. Do not use `git stash` or network git. Do not push, open PRs, or touch the issue tracker.
