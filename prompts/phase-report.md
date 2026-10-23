Phase: report (run `{{slug}}`). Act only within this phase.

No human is present. Do not ask questions.

The run's code generates the deterministic part of `{{reportMd}}` (tasks, branches, commits, verify exit codes, costs).
You write **only** a `## Narrative` section. Do not touch any other section, and never change any number the code wrote.

1. Read `{{statusMd}}`, `{{tasksJsonl}}`, `{{decisionsMd}}`, `{{specsDir}}/FINAL_REVIEW.md` (if present) and `{{specMd}}`.
   Read-only git is fine for facts. Do not run builds or tests.
2. Put the `## Narrative` section into `{{reportMd}}`. If the file exists, replace only that section. If not, create the file
   with just that section. Keep it to about 10 to 25 lines of plain prose and bullets:
   - what was built, against the goal in the spec, and what was left undone;
   - what is uncertain or fragile, and why;
   - **Needs human attention**: every Decision with `needsHumanAttention: true`, BLOCKED tasks with their reasons;
   - how to review: the integration branches and worktree paths, and the suggested next step (review, then push and PR by hand).
3. State facts only from the files. Do not invent numbers, results or commands. Say "not verified" where it is true.
4. Stop. Do not push, open PRs, or touch the issue tracker.
