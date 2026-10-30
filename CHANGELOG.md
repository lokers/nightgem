# Changelog

All notable changes to nightgem are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it leaves experimental status.

## [Unreleased]

## [0.2.1] - 2026-10-30

Runs check their own work harder: reviews loop until fixed and fail closed, every success criterion is traced to evidence, risky tasks get their own review, the report flags silenced checks, and a retrospective command turns run friction into fixes.

### Upgrading from 0.2.0

- Update between runs, not during one: `git pull && npm ci` in the clone.
- Re-run `install` to get `/nightgem-retro` and the updated `/nightgem` command. Commands you edited are left alone unless you pass `--force` (a `.bak` copy is kept).
- Optional: set `review.maxRounds` (1 to 5, default 2) in your profile. A profile with this key is rejected by 0.2.0, so add it only after updating.
- Optional: add `"**/CONSTRAINTS.md"` to `deny.editPaths` so runs cannot change a repo's quality bar (see [docs/profile.md](docs/profile.md)).
- A full review can now take up to `review.maxRounds` fix rounds, so a run may spend a little more of its budget on review than in 0.2.0.
- Runs and `RUN.json` files from 0.2.0 keep working. A resumed 0.2.0 run uses the default of 2 rounds.

### Added

- `/nightgem-retro <slug>`: an interactive retrospective for a finished run. It reads the run's artifacts read-only, groups the friction into findings with evidence, classifies each fix (profile, instructions file, a repo's docs, nightgem), applies profile and instructions diffs only after you approve them, drafts (never files) issue text for nightgem, and writes `RETRO.md`. `install` installs it with the other commands (re-run `install` to get it) (#15)
- Review levels: the plan gives every task `Review: standard` or `deep` and a review focus (security, performance, api, migration, ui). `deep` is required for auth or input handling, migrations, API contracts and performance-sensitive code. A `deep` task gets an @oracle task review before its merge into the integration branch (using the matching skill only if it is listed), and its findings go into the task's fix-up loop. If that review does not run, the task is merged but marked `NONE (task review did not run)`, reviewed by the final review and flagged in the report (#12)
- A repo's `CONSTRAINTS.md`, when present, is read by the planner, fixer, designer and oracle as acceptance criteria and checked by the final review. `/nightgem` mentions an optional `## Quality bar` section in the spec (re-run `install` to update the command) (#12)
- New profile field `review.maxRounds` (integer 1 to 5, default 2) sets how many review → fix → re-review rounds the full review phase may take. Each round re-checks only the open BLOCKER and MAJOR findings, the phase stops early when none remain, and a finding is retried at most once (#11)
- Reviews fail closed: when an @oracle review returns no verdict the orchestrator retries once, then logs a Decision for the human and never substitutes its own review. `FINAL_REVIEW.md` then starts with `VERDICT: NONE`, and `REPORT.md` flags a missing `FINAL_REVIEW.md`, one without a `VERDICT:` line, and a `NONE` or `REJECT` verdict under "Needs human attention" (#11)
- Plans trace each SPEC success criterion to evidence: `PLAN.md` gets a `## Verification matrix` (task(s) and the proving test or command, or `manual:` steps) and @oracle's plan review answers `REVISE` if a criterion is missing. The review phases write `MANUAL_CHECKS.md`, a checklist of what to verify by hand, the final review reports each criterion as met, unmet or manual, and `REPORT.md` gets a deterministic `## Verify by hand` section (#13)
- `REPORT.md` flags added suppressions and skipped tests, deleted test files and test files with fewer assertions, found in the diff of each integration branch, under a new `### Suppressions and skipped tests` check in "Safety checks" and a pointer in "Needs human attention". It also flags any change to a `CONSTRAINTS.md`, reads the diff with fixed git options so a repo's config cannot hide files, and lists branches it could not scan under "Needs human attention". It is a deterministic heuristic and never fails the run (#14)

### Changed

- The full review phase no longer stops after one fix-up round: it runs up to `review.maxRounds` rounds (default 2). The soft-stop review still never fixes anything (#11)

### Known limitations

- The suppression scan is a heuristic over the diff: it can miss a check silenced in another way, and it never fails the run.
- Runs still have no browser or dev server: UI criteria land in `MANUAL_CHECKS.md` for a human.
- Unchanged from 0.2.0: some harmless commands that only mention a denied tool are refused (#10); the guard checks each command on its own; bash and `sh` heredocs need a writable working directory; tested only against OpenCode 2.0.29 and oh-my-opencode-slim 3.x, macOS only.

## [0.2.0] - 2026-10-24

Runs stop fighting the sandbox, a smoother first run, and resumable runs.

### Upgrading from 0.1.0

- Update between runs, not during one: `git pull && npm ci` in the clone. A clone runs `src/` directly, so a stale `dist/` is never used.
- Re-run `install` (`node <checkout>/bin/nightgem.mjs install`, or `nightgem install` after `npm link`) to refresh the slash commands. Commands you edited are left alone unless you pass `--force` (a `.bak` copy is kept).
- Optional: run `npm link` in the clone to put `nightgem` on your PATH. Until then `doctor` shows a `cli on PATH` warning; the slash commands work either way.
- `doctor` (and so `launch`) now fails hard when oh-my-opencode-slim is configured but not in OpenCode's cache, pinned or not. Start OpenCode once so it downloads the plugin.
- `launch <slug>` no longer overwrites an existing run. Use `nightgem resume <slug> --budget <usd>` or a new slug. Only a launch that failed before the run started can be retried; a run that failed at preflight counts as started.
- Runs from 0.1.0 keep working. A `RUN.json` without `attempts` reads as one attempt, and a stopped, over-budget, failed or stalled 0.1.0 run can be resumed if its worktrees still exist. `RUN.json` stays at schema version 2. After a resume, `budgetUsd` is the current attempt's budget and `attempts` holds the history.
- Every run now checks before the first phase that heredocs and `mktemp` work in the run shell. If not, it ends `failed` (`preflight-failed`) before doing any work. See [Troubleshooting](docs/troubleshooting.md#preflight-canary-failures).

### Security

- nightgem's own git calls (tripwires, report, remote reads, the startup fetch) no longer run programs planted in a repo's `.git/config`, `.git/info/attributes` or hooks (`core.fsmonitor`, filters, textconv, `diff.external`, pager, `uploadpack`, credential helpers, ...): one hardened runner passes fixed and per-driver `-c` overrides and a trusted environment (#7)

### Added

- `nightgem resume <slug> --budget <usd>` continues a `stopped`, `aborted-budget`, `failed` or `stalled` run as a new attempt. `--budget` is required and is that attempt's own budget, on top of what was already spent. It starts at the first unfinished phase, re-opens tasks a wind-down parked, and reuses the worktrees (it refuses if one is missing) and the frozen run context. A resume that fails to start is rolled back and recorded as a `resume-failed` attempt (#9)
- `stop` on a run whose job is gone (a crash) now closes its open attempt (`stopped-after-crash`), so crash → `stop` → `resume` works. It also closes an attempt left open on a run that already ended (#9)
- `/nightgem-status` suggests `resume` for a resumable run and `stop` first after a crash (re-run `install` to update the command) (#9)
- `npm link` puts `nightgem` on your PATH from a clone (the bins resolve `src/` and `dist/` through the symlink), `uninstall` prints the `npm unlink -g nightgem` hint, and the docs use `nightgem <command>` (#8)
- `doctor` warns when `nightgem` is missing from the PATH or points at another checkout (`cli on PATH`), and `doctor --verbose` prints the full detail of every check (#8)

### Changed

- The budget applies per attempt: the 85% and 100% stops compare the current attempt's spend with its own budget. A run that is never resumed behaves as before. `status` shows the current attempt, its budget use and the run total. `REPORT.md` adds an Attempts table and the cumulative cost, and links the earlier final reviews (#9)
- Heredocs and a bare `mktemp` now work inside a run: `TMPPREFIX` points into the run tmp dir (zsh heredocs) and a read-only `mktemp` shim is first on `PATH`. The sandbox write allowance is unchanged: bash and `sh` heredocs still need a writable working directory (the run dir or a worktree). The run tmp dir is wiped when the server starts, and the preflight canary now fails the run (`preflight-failed`) if any of this stops working or if `/private/var/tmp` becomes writable (#7)
- `doctor` fails (hard) when oh-my-opencode-slim is configured but not yet in OpenCode's cache, pinned or not (0.1.0 accepted a pinned version and only warned otherwise), and tells you to start OpenCode once (#8)
- `doctor` and the `launch` warnings print at most 200 characters per line, with long details summarised (#8)
- `launch` refuses a slug that already has a run instead of overwriting it; a launch that failed before it started can be retried. A run that failed at preflight counts as started: fix the cause, then `resume` it or use a new slug (#9)

### Fixed

- `doctor` finds oh-my-opencode-slim in an OpenCode 2.x `plugins` list too, not only in the older `plugin` key
- The guard no longer blocks plain path arguments and directory-like `NAME=value` assignments that merely end in a denied command name, such as `ls docs/gh` or `export TMPDIR=…/T/opencode`. It still refuses anything that could run them, and `GHBIN=/usr/bin/gh` (not a directory-like name) (#7)
- The guard refuses a shell command that contains non-ASCII whitespace (such as a no-break space) or a control character right away, with a clear reason, and the tokenizer can no longer loop on it (#7)

### Known limitations

- Some harmless commands that only mention a denied tool are still refused: quoted arguments, heredocs next to such a path, and heredoc bodies in the permission profile (#10).
- The guard checks each command on its own: a variable set in one command and run as `$VAR` later is not caught (the profile, sandbox and scrubbed credentials still apply).
- bash and `sh` heredocs need a writable working directory.
- Tested only against OpenCode 2.0.29 and oh-my-opencode-slim 3.x; macOS only.

## [0.1.0] - 2026-10-23

First public release. Experimental: macOS only, run from a clone (not published to npm yet).

### Added

- **Spec-first overnight runs.** `/nightgem <idea | ticket key>` runs a spec interview with an approval gate; `launch` then starts a detached, `caffeinate`d launchd job that plans, builds, tests, reviews and writes a deterministic `REPORT.md`. Slash commands `/nightgem`, `/nightgem-status` and `/nightgem-stop`.
- **Budget control.** A cost ledger summed from OpenCode session costs, a soft stop at 85% (wind down plus an oracle-only review) and a hard stop at 100%.
- **Parallel lanes.** One git worktree per task and an integration branch per repo, driven through oh-my-opencode-slim agents (orchestrator, explorer, librarian, oracle, fixer, designer). Everything stays on local branches.
- **Layered safety model.** No push capability in the environment (fetch-only ssh wrapper, push URLs rewritten to a dead transport for every remote of every spec repo, an explicit `pushurl` included), an unattended permission profile with no `ask`, a guard plugin, a `sandbox-exec` write boundary, MCP servers switched off, auto-reject of permission requests, and tripwires on your checkouts. See [docs/safety-model.md](docs/safety-model.md).
- **Preflight at every launch.** A probe corpus evaluated with OpenCode's permission evaluator, plus a three-layer canary (guard, sandbox and environment, optional small-model check). A launch is refused if anything forbidden succeeds.
- **User profile.** All user-specific facts (workspace, tracker, extra denies, models, instructions) live in `~/.config/nightgem/profile.jsonc`, validated with zod, with a starter written by `install`. See [docs/profile.md](docs/profile.md).
- **Skill detection** across the standard roots, with enforced excludes and optional workspace skills offered by name.
- **CLI.** `launch`, `status`, `stop`, `report`, `doctor` (including `--audit-repo`), `profile path|show|validate`, `render`, `install` and `uninstall` (the installer only touches files that carry its marker and an unchanged hash).
- **Model portability.** `doctor` fails when a model the run would use is unavailable and names `models.<agent>` / `NIGHTGEM_<AGENT>_MODEL`, so other providers work once every agent key is set.
- **Public docs and community files.** README, safety model, troubleshooting, OpenCode notes, CONTRIBUTING, SECURITY and CODE_OF_CONDUCT, plus brand assets.

### Security

- A remote URL or `pushurl` with an embedded credential is a hard `doctor` and `launch` failure (the message names the repo and the remote, never the URL).
- The canary checks every push URL of every remote of every spec repo, not only `origin`.
- `status`, `stop` and the launchd cleanup refuse a `RUN.json` whose `slug` is not the requested run or whose `launchdLabel` is not a plain label ending in `.<slug>`. The cleanup passes the label to `sh` as an argument, not inside the script text.
- The provider API key is **not** protected by the kernel and network egress is open. Use a dedicated, spend-capped API key. See the residual risks in [docs/safety-model.md](docs/safety-model.md#residual-risks).

### Known limitations

- Tested only against OpenCode 2.0.29 and oh-my-opencode-slim 3.x.
- macOS only; depends on `sandbox-exec`, which Apple has deprecated.
- Cost is an estimate, and overshoot at the hard stop is bounded, not zero.
- Attaching OpenCode.app to a running job to watch it live is untested.
- Shell heredocs fail inside the sandbox (they cannot create their temp file), so agents fall back to the file-write tool.

[Unreleased]: https://github.com/lokers/nightgem/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/lokers/nightgem/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lokers/nightgem/releases/tag/v0.2.0
[0.1.0]: https://github.com/lokers/nightgem/releases/tag/v0.1.0
