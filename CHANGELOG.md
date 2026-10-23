# Changelog

All notable changes to nightgem are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it leaves experimental status.

## [Unreleased]

### Added

- `npm link` puts `nightgem` on your PATH from a clone (the bins resolve `src/` and `dist/` through the symlink), `uninstall` prints the `npm unlink -g nightgem` hint, and the docs use `nightgem <command>` (#8)
- `doctor` warns when `nightgem` is missing from the PATH or points at another checkout (`cli on PATH`), and `doctor --verbose` prints the full detail of every check (#8)

### Changed

- Heredocs and a bare `mktemp` now work inside a run: `TMPPREFIX` points into the run tmp dir (zsh heredocs) and a read-only `mktemp` shim is first on `PATH`. The sandbox write allowance is unchanged: bash and `sh` heredocs still need a writable working directory (the run dir or a worktree). The run tmp dir is wiped when the server starts, and the canary now fails the launch if any of this stops working or if `/private/var/tmp` becomes writable (#7)
- `doctor` fails (hard) when oh-my-opencode-slim is configured but not yet in OpenCode's cache, and tells you to start OpenCode once (#8)
- `doctor` and the `launch` warnings print at most 200 characters per line, with long details summarised (#8)
- `launch` refuses a slug that already has a run instead of overwriting it; a launch that failed before it started can be retried (#9)

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

[0.1.0]: https://github.com/lokers/nightgem/releases/tag/v0.1.0
