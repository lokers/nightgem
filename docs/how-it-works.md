# How it works

[← README](../README.md) · [How it works](how-it-works.md) · [Profile](profile.md) · [Safety model](safety-model.md) · [Troubleshooting](troubleshooting.md) · [OpenCode notes](opencode-notes.md)

The [README](../README.md#how-it-works) has the short version (the gem-factory night shift). This page has the lifecycle, the budget accounting, the artifacts, the OpenCode.app notes and a checklist for your first real run.

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
- Run states: `launching`, `running`, `winding-down`, `stopping`, then one of `completed`, `failed`, `stalled`, `aborted-budget`, `stopped`. A terminal run is never acted on again, so a restart does nothing.
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
- **The figure is an estimate.** It depends on OpenCode's pricing table for the configured provider and models. Compare with `opencode stats` on the run database when in doubt.
- **`webfetch` calls with a `prompt` are not recorded.** The secondary model call behind them does not create a session, so its spend is invisible. The guard strips the prompt (or denies the call) to keep this from happening, and `warming` is kept off.

## Artifacts

All under `<workspaceRoot>/.specs/<slug>/` unless noted.

| Path | Purpose |
|---|---|
| `SPEC.md` | The approved spec (read-only for agents) |
| `PLAN.md` | Plan written in the plan phase, reviewed by @oracle |
| `STATUS.md` | Live task table, updated on every state change |
| `DECISIONS.md` | Every agent decision, with @oracle verdicts for risky ones |
| `REPORT.md` | Final report: outcome, per-task branch, worktree, commits, verification exits, oracle verdict, BLOCKED reasons, "Needs human attention", cost per phase. "Nothing was pushed" is tri-state (✅ no, ❌ yes, ⚠️ unknown), and unknown is listed under Needs human attention. |
| `.run/RUN.json` | State, phase, cost total, session ids, PID, port, server URL, profile and skills summary (zod-validated) |
| `.run/cost.jsonl` | Cost ledger lines (`session-info` or `estimate`) |
| `.run/tasks.jsonl` | Task events appended by agents |
| `.run/decisions.jsonl` | Structured decisions |
| `.run/events.jsonl` | Redacted server event stream |
| `.run/orchestrator.log` | Orchestrator log |
| `.run/opencode.json`, `.run/.opencode/**` | Readable copy of the profile, slim overrides, per-run prompt appends (read-only, mode 0444) |
| `~/Library/Application Support/nightgem/<slug>/` | Password file, heartbeat, control flags, `run-context.json`, launchd plist and logs (0700) |
| `~/Library/Application Support/nightgem/<slug>/xdg-data/` | The run's own OpenCode database (isolated `XDG_DATA_HOME`) |
| `<repo>/.worktrees/<slug>/<task>` and `/_integration` | Task and integration worktrees on local branches |

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
