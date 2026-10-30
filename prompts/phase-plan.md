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
3. Also in PLAN.md, a `## Verification matrix` with **one row per success criterion in `{{specMd}}`** (every item of its
   success or acceptance criteria): the criterion, the task id(s) that deliver it, and the proof, which is either the exact
   test or command that proves it or `manual:` followed by exact steps a human can follow. A criterion needs a `manual:` row
   when no test or command can prove it (visual judgement, a real device or an external system): runs have no browser or dev
   server, on purpose, so do not plan around one. No criterion may be left out, and no row may have an empty proof.

   ```
   ## Verification matrix

   | Success criterion | Task(s) | Proof |
   | --- | --- | --- |
   | <criterion, as worded in the SPEC> | api-endpoint | `go test ./pkg/...` (TestCreate) |
   | <criterion, as worded in the SPEC> | ui-page | manual: open the page, click Save, expect the toast |
   ```
4. Also in PLAN.md: each repo's integration branch `<type>/<TICKET|slug>` and worktree
   `<repo>/.worktrees/{{slug}}/_integration`, the cross-repo order (from the workspace instructions in your system
   instructions, else by dependency), which tasks run in parallel, and a
   "Risky changes" list (new dependency, migration, API contract change) with the reason each is unavoidable.
5. Ask @oracle for a mandatory plan review. It also checks the Verification matrix against the SPEC and answers REVISE if a criterion is missing. Revise PLAN.md for every required change. At most 2 review rounds.
   If @oracle still answers REVISE after round 2, proceed with your best plan and log a Decision with `needsHumanAttention: true`.
   **Fail closed.** If @oracle returns no verdict (an error, a timeout, an empty answer or one without APPROVE or REVISE), ask
   once more. If the second try also gives no verdict, proceed with your best plan, log a Decision with
   `needsHumanAttention: true` saying the plan review did not run, and leave `oracleApproved` unset. Never substitute your
   own review for @oracle's, and never read a missing verdict as approval.
6. Append a `plan` Decision to `{{decisionsJsonl}}`, mirror it to `{{decisionsMd}}`, with the oracle verdict in `oracleApproved`.
   Log other choices (resolved spec gaps, base-branch notes, risky changes) as Decisions too.
7. Write the task board to `{{statusMd}}` with every task `todo`, and append a `todo` TaskEvent per task to `{{tasksJsonl}}`
   (`phase: "plan"`, `attempt: 0`, the planned branch and worktree path).
8. On a resumed run, `{{planMd}}` and some TaskEvents may already exist from an interrupted plan phase: read them and finish the
   plan instead of starting over, and do not append duplicate `todo` events for tasks that are already logged.
   Append the phase-done TaskEvent for `phase:plan`, then stop. Do not create worktrees or dispatch implementation.

Formats, the workspace instructions and the never-list are in your system instructions.
