---
description: Show the live state, cost and report of a nightgem run
---

Report the status of the nightgem run: $ARGUMENTS
(If no slug is given, the CLI lists every run.)

1. Run `{{NODE}} {{BIN}} status $ARGUMENTS` via the shell and read its output.
2. Summarise it compactly: slug, state, phase, cost against budget (with percent), number of
   sessions, heartbeat age, and the paths to the log and report. If the state is
   `winding-down` say the soft stop (85%) was reached. If it is `aborted-budget`, say the
   hard stop was reached. If it is `stalled` or the heartbeat is old while the state is
   `running`, flag it and point to the troubleshooting guide (https://github.com/lokers/nightgem/blob/main/docs/troubleshooting.md).
   If the run has more than one attempt, give the current attempt's budget and spend and the
   run total.
   If the state is `stopped`, `aborted-budget`, `failed` or `stalled`, tell me it can continue
   as a new attempt with `{{NODE}} {{BIN}} resume <slug> --budget <usd>` (the budget is extra money for
   that attempt; never run it yourself), except a `failed` run with `Server: not started` and
   `Sessions: 0`: suggest launching it again. If the state is still active (`launching`,
   `running`, `winding-down`, `stopping`) but the heartbeat is marked STALE, the orchestrator may
   have crashed: tell me to run `{{NODE}} {{BIN}} stop <slug>` (it signals a live job, or closes a
   crashed run), then resume.
   A `completed` run cannot be resumed.
3. If `REPORT.md` exists at the report path the CLI printed, read it and summarise the
   headline (outcome, tasks done and blocked, cost) and the "Needs human attention" section
   item by item. Mention the branch and worktree of each task that finished.
4. If the run is still going, mention that I can attach to the run server to watch it live
   using the attach line from the CLI output. That is best effort and the desktop app attach
   is unverified. Do not run the attach command yourself.
5. **Never print secrets.** Do not read or print the password file in the run's control
   directory, any `.env` file, or the value of `OPENCODE_SERVER_PASSWORD`. If the CLI output
   contains a password value, redact it. The attach line may show the path of the password
   file; that is fine, its content is not.
6. Read-only: do not stop or restart the run and do not dispatch new work. Suggest
   `/nightgem-stop <slug>` if I need to stop it.
