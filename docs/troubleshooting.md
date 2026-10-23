# Troubleshooting

[← README](../README.md) · [How it works](how-it-works.md) · [Profile](profile.md) · [Safety model](safety-model.md) · [Troubleshooting](troubleshooting.md) · [OpenCode notes](opencode-notes.md)

Run `nightgem doctor` first. Lines starting with `FAIL` block a launch; `warn` lines do not. `doctor` never crashes on a missing or broken profile: that is a single `FAIL profile` line.

## Doctor failures

| Failure | Fix |
|---|---|
| `profile` (missing or invalid) | Run `install --workspace <dir>` to write a starter, or fix the file; `profile validate` prints the errors. |
| `profile` (workspace rejected) | The `workspaceRoot` must exist, hold your repos, and not be `/`, `$HOME` or an ancestor, overlap `~/Library`, `~/.config`, `~/.ssh` or the control root, or sit inside a git work tree. |
| `oh-my-opencode-slim` | Run `npx oh-my-opencode-slim@latest install` and pin the plugin to 3.x in your global `opencode.json`. Then start OpenCode once (the TUI or `opencode run`) so the plugin is downloaded into its cache: the sandboxed run server cannot install it, and without it only the built-in agents register and the preflight fails with missing agents. |
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

What `doctor` checks, in full: OpenCode version (2.0.x, tested 2.0.29), the slim plugin and its major version (missing or another major fails; a version that cannot be determined warns), the five required skills plus `skills.required` (and that no exclude pattern removes one), skill name collisions and rejected roots (warnings), profile validity and the workspace rules, an absolute node path, `/usr/bin/sandbox-exec`, `launchctl`, **AC power**, at least 20 GB free disk under the workspace, the run lock, no ancestor `opencode.json` / `.opencode/` above the workspace, the installed pieces of this checkout (orchestrator entry, guard plugin, ssh wrapper, probe corpus), remote URLs of the spec repos, per-repo tools (warning), the tracker CLI (warning) and that the run models are available. The rule preflight and the canary run at launch.

## Preflight canary failures

Before the first phase the orchestrator runs the rule check and a three-layer canary (see the [safety model](safety-model.md#preflight-canary)). A failure ends the run as `failed` (`preflight-failed`) with the reasons in the `RUN.json` defects.

| Message | Meaning and fix |
|---|---|
| canary `(guard)` | The guard's `decide()` gave a different verdict than the probe table expects. Treat as a guard regression (`test/guard.test.ts` should fail too); do not launch around it. |
| canary `"<probe>" ran successfully` | A forbidden operation worked through `/shell` (a sandbox or env hole) or in the LLM canary. Fix the layer; never skip the canary to launch. |
| canary `setup failed` / `did not finish normally` | The canary itself could not run. Check `orchestrator.log` for the `preflight.canary` lines and that `git` works. A hang proves nothing, so this is a failure, not a pass. |
| `canary-inconclusive` (defect, not a failure) | The small model declined to try the probes twice. The deterministic layers already passed, so the run proceeded. Safe to ignore unless it recurs on every launch. |

`NIGHTGEM_SKIP_LLM_CANARY=1` skips layer 3 only. `NIGHTGEM_SKIP_CANARY=1` skips all three and `NIGHTGEM_SANDBOX=0` skips the kernel-level probes; both exist for tests only. Do not use them for a real run.

## Lock handoff

`launch` takes the lock and exits right after `launchctl bootstrap`; the orchestrator waits up to 60 s for the CLI to let go. A lock held by a different live run is refused at once.

## Stale lock

The lock records a PID. If the PID is gone, the next `launch` or `doctor` treats the lock as stale and takes it over. If a run is stuck in `launching` or `running` with a dead job, check `launchctl print gui/$(id -u)/<label>` (the label is in `RUN.json`), run `stop <slug>` to mark it `stopped`, then `report <slug>`.

## A stalled run

`status` shows an old heartbeat or no cost movement. Read `orchestrator.log` first, then `events.jsonl`. States `stalled` and `failed` already have a report. Common causes: repeated 429/5xx from the provider (the watchdog backs off up to 45 minutes), a hung shell that the 20-minute rule has not yet aborted, or the Mac sleeping on battery. `stop <slug>` is always safe and still writes the report.

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
