Phase: plan (run `{{slug}}`). Act only within this phase.

No human is present. Do not ask questions. Decide and log.

1. Read `{{specMd}}` fully. Read the AGENTS.md, CLAUDE.md and `.cursor/rules` of every repo it affects.
2. Load the `planning-and-task-breakdown` skill if it is listed under Available skills in your system instructions. Write `{{planMd}}` with small, verifiable tasks. For each task give:
   - `id`: kebab-case, letters, digits and `-` only, at most 60 chars, never `_integration`, and no standalone `push`, `gh` or
     `ssh` word (use `alerts`, `release-web`, ...): the guard and launcher reject them in branch names;
   - repo, worktree path `<repo>/.worktrees/{{slug}}/<id>`, branch `<type>/<TICKET|slug>-<id>`;
   - owned files (disjoint across tasks), depends-on, agent (@fixer, or @designer for UI polish);
   - acceptance criteria and the exact non-interactive verify commands from that repo's docs (no watch mode);
   - an estimate under about 45 minutes. Split larger work;
   - project-scoped verify commands for the task lane (`npx nx run <proj>:test`, `go test ./pkg/...`). The full suite runs
     only in `_integration`.
3. Also in PLAN.md: each repo's integration branch `<type>/<TICKET|slug>` and worktree
   `<repo>/.worktrees/{{slug}}/_integration`, the cross-repo order (from the workspace instructions in your system
   instructions, else by dependency), which tasks run in parallel, and a
   "Risky changes" list (new dependency, migration, API contract change) with the reason each is unavoidable.
4. Ask @oracle for a mandatory plan review. Revise PLAN.md for every required change. At most 2 review rounds.
   If @oracle still answers REVISE after round 2, proceed with your best plan and log a Decision with `needsHumanAttention: true`.
5. Append a `plan` Decision to `{{decisionsJsonl}}`, mirror it to `{{decisionsMd}}`, with the oracle verdict in `oracleApproved`.
   Log other choices (resolved spec gaps, base-branch notes, risky changes) as Decisions too.
6. Write the task board to `{{statusMd}}` with every task `todo`, and append a `todo` TaskEvent per task to `{{tasksJsonl}}`
   (`phase: "plan"`, `attempt: 0`, the planned branch and worktree path).
7. Append the phase-done TaskEvent for `phase:plan`, then stop. Do not create worktrees or dispatch implementation.

Formats, the workspace instructions and the never-list are in your system instructions.
