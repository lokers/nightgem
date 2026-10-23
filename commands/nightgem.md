---
description: Write a spec interactively, then launch a detached, budget-capped autonomous build (plan, build, review, report)
agent: orchestrator
---

Start the nightgem flow for: $ARGUMENTS

This is a spec interview plus a launch step. You run the **interactive spec phase only**. The
autonomous phase runs in a separate detached process. After launch you do nothing else.

## Part 1: Spec

1. Read the user profile: run `{{NODE}} {{BIN}} profile show --json` via the shell and parse
   the output. Use its `workspaceRoot` as `<workspace>` below and its `.tracker` for step 2.
   If `instructionsFile` is set, read that file and apply it as workspace-specific guidance
   throughout the spec phase (repo conventions, cross-repo order, autonomy notes).
   If the command fails (no profile yet), show the error, tell me to run
   `{{NODE}} {{BIN}} install --workspace <dir>`, and stop.
2. Issue tracker (optional). Use only the settings in `.tracker`:
   - If `tracker.keyPattern` and `tracker.fetchCommand` are both set and the input contains
     a match for the key pattern (for example `JIRA-123`), fetch the issue first: take
     `tracker.fetchCommand`, replace `{KEY}` with the matched key, and run it via the shell.
     If the issue links to other issues and `tracker.linkedFetchCommand` is set, replace
     `{KEYS}` in it with the linked keys (space-separated) and run that too.
   - If `tracker.notes` is set, show it to me and follow its guidance about tooling.
   - **Auto-claim, only if `tracker.autoClaim.enabled` is true.** It applies only to the
     top-level issue, and only when its status equals `tracker.autoClaim.when.status` and,
     if `tracker.autoClaim.when.unassigned` is true, its assignee is empty. In that case run
     `tracker.autoClaim.command` (with `{KEY}` replaced), then re-fetch the issue with
     `tracker.autoClaim.verifyCommand` (with `{KEY}` replaced) and confirm the change in
     one line (new status and assignee). If the command or the verification fails, report
     it in one line and continue with the spec.
   - In every other case (auto-claim disabled, status or assignee does not match, linked
     issues) leave the issue **untouched**; just mention its current status and assignee.
   - If there is no tracker configured, or the input does not match the key pattern, ask me
     to paste the ticket content (or describe the task) and continue from that.
   - The autonomous run never writes to the issue tracker, and this command does not either,
     apart from the opt-in auto-claim above.
3. Dispatch @explorer in the background to map the affected code in the relevant repos under
   `<workspace>` (read-only), and @librarian if external library behavior matters.
4. Load the `spec-driven-development` skill and draft `<workspace>/.specs/<task-slug>/SPEC.md`.
   `<task-slug>` is kebab-case, `[a-z0-9-]`, at most 60 characters (for example
   `jira-123-add-widget`). Name every affected repo and any API contract change.
5. Interview me with the `question` tool (2-3 questions per round, recommended option first)
   until the open questions are resolved. Update SPEC.md after each round.

### SPEC.md requirements (the launcher parses these)

- A `Status:` line near the top, `Status: DRAFT` while you work.
- A section headed `## Affected repos` containing a table. The **first column** holds the
  repo name in backticks, for example `` `acme-api` ``, and each must be a git repo directly
  under `<workspace>`. Do not put anything else in the first column.
- A section headed `## Autonomy notes`. Because nobody is available overnight, write down:
  - what the agents may decide alone (naming, internal structure, test layout, small
    refactors needed for the task, which of several equivalent approaches to take);
  - what needs @oracle approval before it is done: a new dependency, a DB migration, an API
    contract change, or anything else the spec does not mention that is risky. Each such
    change is logged in DECISIONS.md and listed under "Needs human attention" in REPORT.md.
    If @oracle rejects it, the task is BLOCKED;
  - what is out of scope and must not be touched;
  - the verification the repos should run (the repo's own tests, lint, typecheck, build; no
    docker or browser e2e);
  - cross-repo order if more than one repo is involved (for example the API provider first,
    then the generated client, then the consumers).
- Success criteria that can be checked by the repo's own tooling.
- State plainly that the run never pushes, opens PRs, merges, or touches the issue tracker.

## Part 2: Spec gate

Show a short summary of SPEC.md (objective, affected repos, autonomy notes, success
criteria) and ask for approval with the `question` tool (options: approve, change
something). Loop until it is approved. Do not plan or write code.

On approval, change the status line to `Status: APPROVED (<today's date, YYYY-MM-DD>)`.

## Part 3: Budget and launch

Ask in **one** `question` round, two questions:

1. Budget in USD. Options: `100` (recommended, default), `25`, `50`, `custom`. If I pick
   custom, ask for the number. The soft stop is at 85% of the budget (nothing new is
   dispatched, work winds down) and the hard stop at 100% (every session is aborted).
2. Launch now (recommended), or keep the spec only.

If I keep the spec only, tell me the exact launch line and stop:
`{{NODE}} {{BIN}} launch <slug> --budget <n>`.

If I launch now:

1. Run `{{NODE}} {{BIN}} doctor` and show its output. Lines starting with `FAIL` are hard
   failures. Never launch past a hard failure.
   - If the **only** hard failure is `AC power`, tell me to plug in the charger, then re-run
     doctor, and continue only when it passes.
   - For any other hard failure, show it with the detail and stop. Suggest the fix from the
     troubleshooting guide (`docs/troubleshooting.md` in the checkout that contains
     `bin/nightgem.mjs`, or https://github.com/lokers/nightgem/blob/main/docs/troubleshooting.md) where one applies.
2. Run `{{NODE}} {{BIN}} launch <slug> --budget <n>` and show the output as it is. If it
   exits non-zero, show the error and stop. Do not retry with different flags unless I ask.
3. Tell me, briefly:
   - The run is **detached** (launchd). I can close the TUI, the terminal or the desktop app
     and it keeps going. The Mac must stay on AC power.
   - Watch it with `/nightgem-status <slug>`. Stop it with `/nightgem-stop <slug>`
     (it still writes the report).
   - The morning deliverable is local branches in `<repo>/.worktrees/<slug>` and
     `<workspace>/.specs/<slug>/REPORT.md`. Nothing is pushed.

## Rules

- After launch, **never plan or implement in this session**. Do not dispatch agents, do not
  touch worktrees, do not "help" the run. The detached orchestrator owns everything.
- Never push, open PRs, merge, or transition issues (the opt-in auto-claim is the only
  tracker write, and only before the spec is drafted).
- Never print or read secrets: the run server password, `.env` files, API keys.
- Do not edit any file other than the spec under `<workspace>/.specs/<slug>/`.
