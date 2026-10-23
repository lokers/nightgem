Phase: build (run `{{slug}}`). Act only within this phase.

No human is present. Do not ask questions. Decide and log.

1. Read `{{specMd}}`, `{{planMd}}`, `{{statusMd}}` and `{{tasksJsonl}}` (the latest line per id wins). Skip tasks that are
   already `done`, `blocked` or `skipped`. This phase may be resumed, so never redo finished work.
2. Per repo: create the `_integration` worktree and branch, per the system instructions. Do not run `git fetch`: `origin` was
   fetched before the run started, so base directly on `origin/<default-branch>` (the local default if there is no `origin`).
   Create each task worktree when the task becomes ready. Task ids and branch names must not contain the standalone words
   `push`, `gh` or `ssh`. Install dependencies in each new worktree (as the repo's AGENTS.md or CLAUDE.md says, for example `npm ci`)
   BEFORE any verification, since otherwise Node resolves the main checkout's `node_modules`.
3. Dispatch ready tasks (dependencies `done`) in the background to @fixer or @designer with self-contained prompts:
   absolute worktree path, owned files, acceptance criteria, repo conventions, commit format, verify commands, and
   "commit locally, do not push". Tell the worker to load `incremental-implementation` and `test-driven-development` if they are listed
   under Available skills in your system instructions.
   Run independent lanes in parallel (at most 4). No two writers share files. Keep each delegated task under about 45 minutes.
   Tell the worker to pass an explicit shell `timeout` (ms) for long commands: `npm ci`, nx and `go test` get 900000 to
   1080000, never more than 1080000. Task verify commands are project-scoped (`CI=1 npx nx run <proj>:test --outputStyle=stream`,
   `go test ./pkg/...`). The full or affected suite runs only in `_integration`.
4. On every state change append a TaskEvent to `{{tasksJsonl}}` and update `{{statusMd}}`.
5. When a task returns, check the diff and the exit codes yourself. On failure run the fix-up loop: up to 3 fix-up attempts,
   @oracle after the 2nd. Then BLOCKED, dependents `skipped`, independent lanes continue.
6. Cross-repo: follow the cross-repo order and the generated-code flow in the workspace instructions in your system
   instructions. Never hand-edit generated files: regenerate them with the repo's own generator.
7. Risky changes not covered by the spec (new dependency, migration, API contract change) need @oracle approval first.
   Log a Decision with `needsHumanAttention: true`. A rejection means the task is BLOCKED.
8. Merge each verified task branch into its repo's integration branch (`--no-ff`, in the `_integration` worktree) in
   dependency order. Run the repo's full lint, typecheck, test and build there (each with a shell `timeout` of 900000 to
   1080000, never more), and record the exit codes in a TaskEvent
   with `id: "integration:<repo>"`, `state` `done` or `blocked`, `branch` the integration branch, `phase: "build"`.
9. When no task is `todo`, `running`, `verifying` or `fixing`, append the phase-done TaskEvent for `phase:build` and stop.
   Do not run the final review in this phase.

Append log lines with a quoted-delimiter heredoc (`cat >> {{tasksJsonl}} <<'EOF'`) or the write tool, never `echo "..."`.
Never use `git stash` or network git. Never push, open PRs, merge to a default branch, or touch the issue tracker.
