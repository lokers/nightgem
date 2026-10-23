---
description: Stop a running nightgem run; it aborts all sessions and still writes REPORT.md
---

Stop the nightgem run: $ARGUMENTS

1. A slug is required. If none was given, run `{{NODE}} {{BIN}} status` to list the runs and
   ask me which one with the `question` tool.
2. Show the run's current state and cost first: `{{NODE}} {{BIN}} status <slug>`. If it is
   already in a terminal state (`completed`, `failed`, `stalled`, `aborted-budget`,
   `stopped`), say so, point to the report, and stop here.
3. Confirm with the `question` tool before stopping (options: stop it (recommended), leave it
   running). Say that stopping aborts every session, kills the run server and writes
   REPORT.md from what exists so far. Work already committed in the worktrees is kept;
   in-flight work may be incomplete.
4. If I confirm, run `{{NODE}} {{BIN}} stop <slug>` and show its output.
5. Tell me where the report is (the report path printed by `status <slug>`). The report is
   written by the orchestrator a short while after the stop signal. If it is not there yet,
   say so and suggest `/nightgem-status <slug>` in a minute. If the job was not running,
   the CLI marks the run `stopped` and I can regenerate the report with
   `{{NODE}} {{BIN}} report <slug>`.
6. Never print secrets (the run server password, `.env` files). Do not push, merge, or
   dispatch new work.
