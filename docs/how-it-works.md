# How it works

[← README](../README.md) · [How it works](how-it-works.md) · [Profile](profile.md) · [Safety model](safety-model.md) · [Troubleshooting](troubleshooting.md) · [OpenCode notes](opencode-notes.md)

The [README](../README.md#how-it-works) has the short version (the gem-factory night shift). This page has the lifecycle, the budget accounting, resuming a run, the artifacts, the OpenCode.app notes and a checklist for your first real run.

## Lifecycle

```
/nightgem (interactive, normal permissions)
   spec -> approval -> budget -> doctor -> launch
                                              |
        launchd job (detached, caffeinate) ---+
                                              v
   orchestrator process  ->  sandboxed `opencode serve` (unattended profile)
        plan   -> oracle plan review                     (root session 1)
        build  -> worktrees, deps, parallel lanes,       (root session 2)
                  per-task verify, fix-ups (max 3)
        review -> integration branch verification,       (root session 3)
                  oracle final review
        report -> deterministic REPORT.md (no LLM)
```

- The interactive part is a spec interview: optional tracker fetch, recon of your repos, the `spec-driven-development` skill, question rounds, then `SPEC.md` and an approval gate.
- The autonomous part is a Node/TypeScript orchestrator that drives its **own** `opencode serve` (dedicated port, own password, own database) with the oh-my-opencode-slim agents: orchestrator, explorer, librarian, oracle, fixer, designer.
- Each phase is a separate root session, which gives exact per-phase cost and less compaction. State passes between phases through files in `<workspaceRoot>/.specs/<slug>/`.
- Worktrees: `<repo>/.worktrees/<slug>/<task>` on `<type>/<TICKET|slug>-<task>`. Each repo also gets an integration branch `<type>/<TICKET|slug>` in `<repo>/.worktrees/<slug>/_integration`. Full verification runs there. Branches are cut from the freshly fetched default branch.
- Failure policy: up to 3 fix-up attempts per task, @oracle is consulted after the 2nd, then the task is BLOCKED and its dependents are skipped. Independent lanes continue.
- Risky changes the spec does not mention (new dependency, migration, API contract change) need @oracle approval. Each is logged in `DECISIONS.md` and listed under "Needs human attention".
- A watchdog nudges an idle root session (at most 10 times), aborts sessions that are silent for 20 minutes, backs off on 429/5xx, and ends the run after a 10 h wall clock.
- Run states: `launching`, `running`, `winding-down`, `stopping`, then one of `completed`, `failed`, `stalled`, `aborted-budget`, `stopped`. A terminal run is never acted on again, so a restart of the job does nothing; only [`resume`](#resume) continues it.
- The run ends with the lock released, the server process group killed and the launchd job (`dev.nightgem.<slug>`) removed.

### What `SPEC.md` needs

The launcher refuses a spec unless:

- it has a `Status: APPROVED (...)` line;
- an `## Affected repos` table has, in its first column, backticked repo names such as `` `acme-api` ``, each a git repo directly under the workspace (`--repos a,b` overrides the table).

The spec should also have an `## Autonomy notes` section: what agents may decide alone, what needs @oracle approval, what is out of scope, and how to verify. The `/nightgem` command writes all of this for you.

## Budget accounting

| Threshold | Meaning |
|---|---|
| Soft stop, **85%** | Nothing new is dispatched. In-flight work winds down, a short `phase-review-lite` (an oracle-only review; the guard lets the oracle through the soft stop) runs, then the report is written. State `winding-down`. |
| Hard stop, **100%** | Every session is aborted, then the report is written. State `aborted-budget`. |

- Cost comes from OpenCode's `Session.Info.cost` (USD) summed over the root session and every descendant. That figure already includes title generation and compaction. The run has its own `XDG_DATA_HOME`, so every session in its database belongs to the run. No provider billing API is used.
- Totals are reconciled by polling every 30–60 s and before each threshold decision. The server event stream is only used for speed.
- If OpenCode reports no cost but tokens are present, the cost is estimated from a pinned price table (unknown models are priced as the most expensive default) and marked `estimated` in `cost.jsonl`.
- **Overshoot is bounded, not zero.** At the hard stop the orchestrator interrupts every running descendant, interrupts the root again (a finishing child wakes its parent), re-polls for 30 s, then kills the server process group. The tolerated overshoot is roughly one in-flight step per busy session, and an aborted stream can be billed without ever being recorded. The report states this caveat.
- **The budget is per attempt.** A run is one or more attempts (the first launch, then each [`resume`](#resume)). The 85% and 100% stops compare an attempt's own spend with that attempt's budget; the run's cumulative cost is reported next to it.
- **The figure is an estimate.** It depends on OpenCode's pricing table for the configured provider and models. Compare with `opencode stats` on the run database when in doubt.
- **`webfetch` calls with a `prompt` are not recorded.** The secondary model call behind them does not create a session, so its spend is invisible. The guard strips the prompt (or denies the call) to keep this from happening, and `warming` is kept off.

## Resume

A run that ended before it finished can continue instead of starting over:

```
nightgem resume <slug> --budget <usd>
```

**When you can resume.** The run must be `stopped`, `aborted-budget`, `failed` or `stalled`. A `completed` run is never resumed (launch a new slug), and an active run is refused until it ends.

**After a crash.** If the orchestrator died without finishing (the job is gone but `RUN.json` still says an active state: `launching`, `running`, `winding-down` or `stopping`), its last attempt is still open and `resume` refuses it. Run `nightgem stop <slug>` first: with the job not running, `stop` closes the attempt as `stopped` (reason `stopped-after-crash`), releases a dead lock and writes the report. Then `resume`.

**What it does.**

- **`--budget` is required and is extra money.** It is the budget of the new attempt, on top of what the earlier attempts spent. The 85% and 100% stops apply to *this attempt's* spend, not to the run total. `RUN.json` keeps one entry per attempt in `attempts` (start, end, state, stop reason, budget, attempt spend).
- **The run continues from the first unfinished phase** and runs every later phase, always ending with the report. A phase an earlier attempt finished is skipped. The review counts as finished only if it produced `run-complete.json`; the `phase-review-lite` after a wind-down does not count.
- **Tasks parked by a wind-down are re-opened.** The wind-down tags them (`blockedReason` starting with `wind-down:`), and the build phase treats them as `todo` again. Tasks that are blocked for real reasons (a rejected decision, failed fix-ups) stay blocked.
- **Worktrees and branches are reused, never reset.** Before anything is written, `resume` checks that the worktree and branch of every task that had started still exist and are inside the run's worktree root. A missing one is refused with the path; nothing is rebuilt silently. Tasks that never started (`skipped`) are not checked; `blocked` ones are.
- **The frozen run context is reused.** The profile snapshot, skills, instructions and repos from the first attempt govern the whole run, so it continues under the rules it was planned with. `doctor`, the rule preflight and the canary still run against the live environment.
- **Old review files are renamed with an attempt suffix** before a review runs again: `FINAL_REVIEW-attempt<n>.md` and `.run/run-complete-attempt<n>.json` (and the review-lite marker in the control dir). `REPORT.md` links them as "Earlier reviews".
- **Stop flags are reset**, and the tripwire baseline is rebuilt from the repos as they are now.

`resume` also refuses a live launchd job or a lock held by a live process. If it fails after writing the new attempt, it rolls back: the previous terminal state is restored and the new attempt stays in the history, closed as `failed` with the stop reason `resume-failed`. That attempt never ran, so the next `resume` ignores it when choosing where to continue (and numbers its attempt after it). See [Troubleshooting](troubleshooting.md#resume-refusals).

**`launch` and an existing slug.** `launch` never overwrites a run: if `<slug>` already has a `RUN.json` it refuses, and tells you to `resume` it (when it is resumable) or use a new slug. The one exception is a launch that failed before the run ever started (state `failed`, no start time, no sessions, no attempt): it holds no history, so the same slug can be launched again. A run that failed at preflight (`preflight-failed`, for example when the heredoc/`mktemp` canary fails) counts as started: fix the cause, then `resume` it or use a new slug.

**In the report.** After a resume the Run section says "Resumed (n attempts)" and has an Attempts table. The cost section shows the cumulative total, and the budget percentage is the last attempt's spend over its own budget. `status` shows the same, for the last attempt that actually ran (a `resume-failed` attempt is not counted). The report's Attempts table still lists a failed resume with its stop reason.

## Artifacts

All under `<workspaceRoot>/.specs/<slug>/` unless noted.

| Path | Purpose |
|---|---|
| `SPEC.md` | The approved spec (read-only for agents) |
| `PLAN.md` | Plan written in the plan phase, reviewed by @oracle |
| `STATUS.md` | Live task table, updated on every state change |
| `DECISIONS.md` | Every agent decision, with @oracle verdicts for risky ones |
| `REPORT.md` | Final report: outcome, attempts of a resumed run, per-task branch, worktree, commits, verification exits, oracle verdict, BLOCKED reasons, "Needs human attention", cost per phase. "Nothing was pushed" is tri-state (✅ no, ❌ yes, ⚠️ unknown), and unknown is listed under Needs human attention. See [Suppressions and skipped tests](#suppressions-and-skipped-tests). |
| `FINAL_REVIEW.md` | The oracle's final review. After a resume the earlier ones are kept as `FINAL_REVIEW-attempt<n>.md` (and `.run/run-complete-attempt<n>.json`) |
| `.run/RUN.json` | State, phase, cost total, attempts, session ids, PID, port, server URL, profile and skills summary (zod-validated) |
| `.run/cost.jsonl` | Cost ledger lines (`session-info` or `estimate`) |
| `.run/tasks.jsonl` | Task events appended by agents |
| `.run/decisions.jsonl` | Structured decisions |
| `.run/events.jsonl` | Redacted server event stream |
| `.run/orchestrator.log` | Orchestrator log |
| `.run/opencode.json`, `.run/.opencode/**` | Readable copy of the profile, slim overrides, per-run prompt appends (read-only, mode 0444) |
| `~/Library/Application Support/nightgem/<slug>/` | Password file, heartbeat, control flags, `run-context.json`, launchd plist and logs (0700) |
| `~/Library/Application Support/nightgem/<slug>/xdg-data/` | The run's own OpenCode database (isolated `XDG_DATA_HOME`) |
| `<repo>/.worktrees/<slug>/<task>` and `/_integration` | Task and integration worktrees on local branches |

## Suppressions and skipped tests

The never-list forbids weakening, skipping or deleting tests, and @oracle is asked to check it. `REPORT.md` also checks it without a model: under `## Safety checks`, `### Suppressions and skipped tests` scans `git diff -U0 <base>...HEAD` of each integration branch (the base is `origin/<default>` when that ref exists, else the local default) and lists, with file and line:

- **added** suppressions and skips: `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `.skip(`, `.only(`, `xit(`, `xdescribe(`, `t.Skip(`, `//nolint`, `# noqa`, `# type: ignore`, `@Disabled`, `@Ignore`, `pytest.mark.skip` (documentation files such as `.md` are not scanned);
- **deleted test files**, and test files with a **net loss of assertions** (`expect(` or `assert…` lines removed minus added).

A branch with hits gets ⚠️ and a pointer under "Needs human attention". The check is a heuristic that informs you: it never fails the run, a diff that cannot be read is shown as "not scanned", and a deliberate, justified suppression shows up too, so read each hit before you act on it.

## Desktop app (OpenCode.app)

- **Launching works from the app.** `/nightgem` is a normal global command. The run always gets its own detached server, never the app's embedded one, so closing the app does not stop it.
- **Attaching to watch live is best effort and unverified.** `status` prints `OPENCODE_SERVER_PASSWORD=$(cat <pwfile>) opencode --server <url>`, which works from a terminal. The server offers single-use pairing links through `POST /api/pair`, but connecting the app to a custom server with a password has not been tested interactively.
- Sessions of the run live in the run's own database, so they do not appear in the app or the TUI unless attached.

## First real run checklist

The first unattended run on a real ticket is the real test of everything above. Keep it small:

- [ ] **A small, single-repo ticket** (one repo in `## Affected repos`, a handful of tasks), with a modest budget.
- [ ] **Paste the full ticket content into `SPEC.md`** (description, acceptance criteria, comments that matter). The run cannot reach the tracker: tracker CLIs are denied and their logins unreadable.
- [ ] **Do not touch the workspace repos during the run** (no commits, checkouts, stashes or builds in the main checkouts). The tripwires watch HEAD, branch, status and the stash count of every repo and will end the run.
- [ ] **A dedicated, spend-capped API key** in the provider config, not your everyday key.
- [ ] **The tools verify needs are installed**, as listed in `repos.<name>.tools`. A missing tool shows up as a failed task.
- [ ] **A slug without the standalone words push, gh, ssh or stash.** The slug ends up in worktree paths that the permission globs also see.
- [ ] Plug in AC power, run `doctor`, and check that the spec repos' `origin` is reachable: the launcher pre-fetches it, and nothing can fetch once the run is going.
- [ ] Morning: read `REPORT.md` first, then the branches. Nothing is pushed; pushing and the PR are yours.
