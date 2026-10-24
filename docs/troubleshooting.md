# Troubleshooting

[← README](../README.md) · [How it works](how-it-works.md) · [Profile](profile.md) · [Safety model](safety-model.md) · [Troubleshooting](troubleshooting.md) · [OpenCode notes](opencode-notes.md)

Run `nightgem doctor` first. Lines starting with `FAIL` block a launch; `warn` lines do not. `doctor` never crashes on a missing or broken profile: that is a single `FAIL profile` line. Each check prints one line of at most 200 characters, long details are summarised, and `nightgem doctor --verbose` prints the full text.

## Doctor failures

| Failure | Fix |
|---|---|
| `profile` (missing or invalid) | Run `install --workspace <dir>` to write a starter, or fix the file; `profile validate` prints the errors. |
| `profile` (workspace rejected) | The `workspaceRoot` must exist, hold your repos, and not be `/`, `$HOME` or an ancestor, overlap `~/Library`, `~/.config`, `~/.ssh` or the control root, or sit inside a git work tree. |
| `oh-my-opencode-slim` | Run `npx oh-my-opencode-slim@latest install` and pin the plugin to 3.x in your global `opencode.json`. Then start OpenCode once (the TUI or `opencode run`) so the plugin is downloaded into its cache: the sandboxed run server cannot install it, and without it only the built-in agents register and the preflight fails with missing agents. |
| `oh-my-opencode-slim` ("configured but not in OpenCode's cache") | A hard failure, pinned (`@3.0.4`) or not: the plugin is in your `opencode.json` but OpenCode has not downloaded it yet, and the sandboxed run server cannot. Start OpenCode once (the TUI, or `opencode run "hi"`), then run `doctor` again. |
| `cli on PATH` (warning) | `nightgem` is not on your PATH, or it points at another checkout. The slash commands work without it. In this checkout run `npm link` (missing), or `npm unlink -g nightgem && npm link` (stale: the line names the other checkout). |
| `required skills` | Run `npx skills add addyosmani/agent-skills`. If a name is listed as excluded, remove the matching `skills.exclude` pattern. |
| `AC power` | Plug in the charger and run `doctor` again. A run on battery can be cut short by sleep. |
| `lock` ("another run holds the lock") | One run at a time. Check `status`. If the run is dead, see [Stale lock](#stale-lock). |
| `opencode version` | Install OpenCode 2.0.x (tested 2.0.29). A major mismatch fails; a patch mismatch warns. |
| `sandbox-exec` / `launchctl` missing | Not a standard macOS install. The run cannot be sandboxed or detached. |
| `free disk` | Free at least 20 GB under the workspace. |
| `node path` | The launchd job needs an absolute node path. Fix `PATH` or your node version manager's default, then retry. |
| `models` (a model the run would use is unavailable) | `opencode models` must list every model the run uses. The message names `models.<agent>` and `NIGHTGEM_<AGENT>_MODEL`. On a non-Anthropic provider set **every** agent key (orchestrator, oracle, fixer, designer, explorer, librarian, observer) in the profile; see [the profile reference](profile.md#models). |
| `remote urls`: "remote origin has credentials in its URL" | A remote URL or pushurl contains a password, or a token used as the user name (a 32+ character user name counts). The message names the repo and the remote, never the URL. Remove the secret: `git remote set-url <name> <url without secret>`, then authenticate with a credential helper (`git config credential.helper osxkeychain`) or switch the remote to ssh (`git remote set-url <name> git@host:org/repo.git`). `doctor` checks every git repo directly under the workspace, and `launch` refuses to start while one has a credential in a URL. Rotate the token if it was ever pushed or shared. See the [safety model](safety-model.md#layers). |
| `remote pushurls` (warning), or `launch` refusing with "has a pushurl that is also a prefix of a fetch URL" | The "push to several remotes" setup: a `remote.<name>.pushurl` equal to the fetch `url`, plus extra pushurls. The run blocks pushes by rewriting each pushurl to `nopush://`, and a pushurl identical to the fetch URL would break fetch too, so the spec repo is refused. Remove the duplicate pushurl, the one equal to the fetch URL: `git config --unset remote.<name>.pushurl '^<the fetch url, regex-escaped>$'` (or edit `.git/config`). The other, extra pushurls are fine; if you still want to push to the fetch URL by hand, name it explicitly, `git push <url>`. `doctor` only warns, per repo; a spec repo is refused at `launch`. |
| `no ancestor opencode config` | Remove `.opencode/` or `opencode.json` from the workspace and every ancestor of it; OpenCode and slim read every ancestor of the run dir. |
| rule preflight | A rule resolves to `ask`/`allow` where it must deny. Read the failing probe; do not launch around it. |
| per-repo tools, tracker CLI (warnings) | Install the tool, or list the right executables in `repos.<name>.tools`. A missing tool shows up later as a failed task. |

What `doctor` checks, in full: OpenCode version (2.0.x, tested 2.0.29), the slim plugin and its major version (missing, not yet downloaded into OpenCode's cache, or another major fails), whether `nightgem` on your PATH is this checkout (warning), the five required skills plus `skills.required` (and that no exclude pattern removes one), skill name collisions and rejected roots (warnings), profile validity and the workspace rules, an absolute node path, `/usr/bin/sandbox-exec`, `launchctl`, **AC power**, at least 20 GB free disk under the workspace, the run lock, no ancestor `opencode.json` / `.opencode/` above the workspace, the installed pieces of this checkout (orchestrator entry, guard plugin, ssh wrapper, probe corpus), remote URLs of the spec repos, per-repo tools (warning), the tracker CLI (warning) and that the run models are available. The rule preflight and the canary run at launch.

## Preflight canary failures

Before the first phase the orchestrator runs the rule check and a three-layer canary (see the [safety model](safety-model.md#preflight-canary)). A failure ends the run as `failed` (`preflight-failed`) with the reasons in the `RUN.json` defects.

| Message | Meaning and fix |
|---|---|
| canary `(guard)` | The guard's `decide()` gave a different verdict than the probe table expects. Treat as a guard regression (`test/guard.test.ts` should fail too); do not launch around it. |
| canary `"<probe>" ran successfully` | A forbidden operation worked through `/shell` (a sandbox or env hole) or in the LLM canary. Fix the layer; never skip the canary to launch. |
| canary `"<probe>" failed (exit n, expected it to work)` | A probe that must succeed did not: "heredoc into a file in the run tmp dir", "heredoc through /bin/bash -c", "heredoc through /bin/sh -c" or one of the `mktemp` probes. The run shell cannot make temp files. Check `TMPDIR` / `TMPPREFIX` and the `mktemp` shim, see [opencode-notes.md](opencode-notes.md). The bash and `sh` heredoc probes also need a writable working directory. |
| canary `setup failed` / `did not finish normally` | The canary itself could not run. Check `orchestrator.log` for the `preflight.canary` lines and that `git` works. A hang proves nothing, so this is a failure, not a pass. |
| `canary-inconclusive` (defect, not a failure) | The small model declined to try the probes twice. The deterministic layers already passed, so the run proceeded. Safe to ignore unless it recurs on every launch. |

Fix the cause, then `resume <slug> --budget <usd>` or use a new slug; `launch` refuses the slug because the run started.

`NIGHTGEM_SKIP_LLM_CANARY=1` skips layer 3 only. `NIGHTGEM_SKIP_CANARY=1` skips all three and `NIGHTGEM_SANDBOX=0` skips the kernel-level probes; both exist for tests only. Do not use them for a real run.

## Resume refusals

`resume <slug> --budget <usd>` checks everything before it writes anything, so a refusal changes nothing, except that a stale loaded-but-not-running launchd job may be booted out. When a run has just ended, `resume` also waits up to about 5 s for the previous orchestrator's delayed launchd cleanup before it starts the job. See [Resume](how-it-works.md#resume).

| Message | Fix |
|---|---|
| "is completed; there is nothing to resume" | A finished run cannot be resumed. Launch a new slug. |
| "is still active" | Check it with `status`. If it is really running, wait or `stop <slug>`; `resume` only takes over a run that has ended. |
| "The last attempt (n) ... is still open" | The orchestrator crashed before it could close its attempt. Run `stop <slug>` first (it closes the attempt as `stopped-after-crash`), then `resume`. |
| "worktree(s) of started tasks ... missing or not usable" | A worktree or branch of a task that had started is gone, moved, outside the run's worktree root or on another branch (the message lists each path). `skipped` tasks never started, so they are not checked; `blocked` ones are. `resume` never rebuilds a worktree silently. Restore it with `git worktree add <path> <branch>`, or launch a new slug. |
| "The launchd job ... is running although RUN.json says the run is ..." | The job is alive although `RUN.json` says the run ended. If the run just finished, wait a few seconds and retry. Otherwise check `status`, then `stop <slug>`. |
| "The launchd job ... is loaded again / running again after the previous run ended" | The previous orchestrator's delayed cleanup had not finished. Try again in a few seconds. |
| "The stale launchd job ... is still loaded after bootout" | A leftover job that is not running did not go away after `launchctl bootout`. Run the `launchctl bootout gui/<uid>/<label>` command the message prints, then retry. |
| "Cannot tell whether the launchd job ... is loaded (...)" | `launchctl print` failed in a way other than "service not found" (no `launchctl`, a permission or domain error). nightgem will not guess, so `resume` refuses, and `stop` ("... is running") and `launch` ("... is already loaded") refuse the same way. Fix what `launchctl` reports, then retry. |
| "Another process (pid n) holds the run lock" | One run at a time. Check `status` of that run, and wait for it or `stop` it. A dead holder is taken over. |
| "The run lock file is being written by another process, or is unreadable and younger than 5 s" | Retry in a few seconds; an unreadable lock older than that is taken over. |
| `stop`: "A launch or resume of ... is in progress" | A live process holds this run's lock because a `launch` or `resume` is still starting it. `stop` will not mark the run stopped under it. Wait a few seconds and run `stop` again. |
| "failed before it ever started" | Nothing to continue. `launch` the slug again. |
| "frozen run context cannot be read" | `run-context.json` in the control dir is missing or invalid, so the run cannot continue under its original rules. Launch a new slug. |
| "Invalid budget" | `--budget` is required and must be a number above 0. |

A resumed run that ends at once as `failed` with the stop reason `attempt-invariant` (and a defect of that name in `RUN.json`) did not start from a clean state: the new attempt was already closed, its budget did not match `RUN.json`, or a stop flag from an earlier process was still set in `control.json` (for example a crash during a stop). The run touched nothing. Run `resume <slug> --budget <usd>` again, which resets the flags; if it repeats, read `orchestrator.log` (`attempt.invariant_failed`) and the defect message.

## Lock handoff

`launch` takes the lock and exits right after `launchctl bootstrap`; the orchestrator waits up to 60 s for the CLI to let go. A lock held by a different live run is refused at once.

## Stale lock

The lock records a PID. If the PID is gone, the next `launch` or `doctor` treats the lock as stale and takes it over. If a run is stuck in `launching` or `running` with a dead job, check `launchctl print gui/$(id -u)/<label>` (the label is in `RUN.json`), run `stop <slug>` to mark it `stopped` (this also closes its attempt, so the run can be resumed, and writes the report).

## A stalled run

`status` shows an old heartbeat or no cost movement. Read `orchestrator.log` first, then `events.jsonl`. States `stalled` and `failed` already have a report. Common causes: repeated 429/5xx from the provider (the watchdog backs off up to 45 minutes), a hung shell that the 20-minute rule has not yet aborted, or the Mac sleeping on battery. `stop <slug>` is always safe and still writes the report. A `stalled` or `failed` run can then be continued with [`resume`](#resume-refusals).

## Reading the logs

All under `<workspaceRoot>/.specs/<slug>/.run/` unless noted.

- `orchestrator.log`: phase changes, budget thresholds, nudges, tripwire results, the hard-stop sequence, defects such as an auto-rejected `permission.asked`.
- `events.jsonl`: the redacted event stream. Useful searches: `permission.asked` (must be zero), `session.execution.failed`, `session.tool.failed`, and `question` (must be zero).
- `cost.jsonl`: the ledger. Lines marked `estimated` come from the price table.
- Launchd stdout/stderr are in the control dir, `~/Library/Application Support/nightgem/<slug>/`.

## Other things people hit

- **A task fails on a denied path.** The sandbox write allowlist is narrow. A build step that needs another cache directory fails with `Operation not permitted`; the fix is a deliberate, single-`subpath` widening in `src/sandbox.ts` (see [CONTRIBUTING](../CONTRIBUTING.md#safety-critical-files)), not a workaround in the run.
- **A command is denied that looks harmless.** The permission globs apply to the whole command string, so text such as `git commit -m "fix push handling"` is denied. Use `-F file`, the `write`/`edit` tool, or different wording. Slugs and task ids containing the standalone tokens `push`, `gh`, `ssh` or `stash` are rejected for the same reason.
- **A hook stashes and the run ends.** A tripwire sees the stash count change. Disable that hook for the run, or exclude it with the repo's own conventions.
- **You changed a repo during the run.** The tripwires watch HEAD, branch, status and stash of every repo under the workspace and end the run. Work in a separate clone while a run is active.
