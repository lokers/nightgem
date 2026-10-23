You went idle but the `{{phase}}` phase of run `{{slug}}` is not finished. No human is present, so do not ask anything.

Continue from the current state. Read `{{statusMd}}` and `{{tasksJsonl}}` (the latest line per id wins). Do not redo work that
is `done`, `blocked` or `skipped`, except a task parked by an earlier wind-down (`blockedReason` starting with `wind-down:`)
on a resumed run: that one is `todo` again.

Next pending task: **{{nextTask}}**. Pick it up now. If it is `running`, check its session and worktree before dispatching again.

Keep `{{statusMd}}` and `{{tasksJsonl}}` current on every transition. When the phase is complete, append its phase-done TaskEvent.
