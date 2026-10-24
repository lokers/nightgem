<div align="center">

<img src="assets/brand/hero.jpg" alt="nightgem, spec at dusk, gems at dawn: a night-shift gem factory. A foreman robot takes rough stones from a crate and sends them along conveyor lanes to cutting, grinding and polishing, through a central machine with robotic arms, to an inspector robot who checks a finished emerald under a loupe, next to screens showing a verified branch and a project report." width="100%">

**Write a spec at dusk. Wake up to verified local branches.**

[![CI](https://github.com/lokers/nightgem/actions/workflows/ci.yml/badge.svg)](https://github.com/lokers/nightgem/actions/workflows/ci.yml)
![status: experimental](https://img.shields.io/badge/status-experimental-orange)
![macOS only](https://img.shields.io/badge/platform-macOS%20only-lightgrey)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Quickstart](#5-minute-quickstart) · [How it works](#how-it-works) · [Safety](#safety-at-a-glance) · [Profile](#profile) · [FAQ](#faq)

</div>

You write and approve a spec. Overnight, a detached [OpenCode](https://opencode.ai) run plans, builds, tests and reviews it, inside a USD budget and a sandbox.
In the morning you find verified **local** branches and a `REPORT.md`. Nothing is pushed.
nightgem needs [OpenCode](https://opencode.ai) with [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) 3.x, and macOS.

> [!WARNING]
> **Experimental (0.2.0).** It runs an AI agent unattended on your machine. Read the [disclaimer](#disclaimer) and the [safety model](docs/safety-model.md) first.

## 5-minute quickstart

Check the [prerequisites](#prerequisites) first (macOS, Node, OpenCode with oh-my-opencode-slim 3.x, five skills, a model provider). `doctor` below tells you what is missing.

```
git clone https://github.com/lokers/nightgem && cd nightgem
npm ci && npm run build && npm link                # puts `nightgem` on your PATH
nightgem install --workspace ~/work                 # slash commands + starter profile
nightgem doctor                                     # tells you what is missing
```

(In a clone the bin runs `src/` through `tsx` automatically; `npm run build` produces `dist/`. `npm link` only symlinks the clone into your global npm prefix: nothing is published or downloaded.)

Then, in the OpenCode TUI or OpenCode.app:

1. Run `/nightgem JIRA-123` or `/nightgem add a widget to acme-web`, and answer the interview. The spec lands in `<workspaceRoot>/.specs/<slug>/SPEC.md`; approve it at the gate.
2. Pick the budget (25 / 50 / 100 / custom USD) and choose **launch now**. The command runs `doctor`, then `launch`. Fix any hard failure first (plug in AC power).
3. Close the TUI. Keep the Mac on AC power. Check in with `/nightgem-status <slug>`; stop with `/nightgem-stop <slug>`.
4. In the morning read `<workspaceRoot>/.specs/<slug>/REPORT.md`, then review the branches in `<repo>/.worktrees/<slug>`. Pushing and PRs are yours.

`install` writes `~/.config/opencode/commands/nightgem*.md` and, if you have none, a starter `~/.config/nightgem/profile.jsonc`. It never touches an existing profile. `uninstall` removes only the commands it installed and you did not edit. To remove the PATH link as well, run `npm unlink -g nightgem`.

<details>
<summary><b>Not using Anthropic?</b> Set a model for every agent</summary>

`doctor` hard-fails when a model the run would use is unavailable, and names `models.<agent>` / `NIGHTGEM_<AGENT>_MODEL`. Set **every** agent key in `~/.config/nightgem/profile.jsonc` (replace the placeholders with ids from `opencode models`):

```jsonc
"models": {
  "orchestrator": "provider/large-model",
  "oracle":       "provider/large-model",
  "fixer":        "provider/medium-model",
  "designer":     "provider/medium-model",
  "explorer":     "provider/small-model",
  "librarian":    "provider/small-model",
  "observer":     "provider/small-model"   // also the run's small_model
}
```

</details>

A spec is launchable only with a `Status: APPROVED (...)` line and an `## Affected repos` table whose first column lists backticked repo names (git repos directly under the workspace). The `/nightgem` command writes both for you.

## Prerequisites

| Requirement | Needed | Notes |
|---|---|---|
| macOS | yes | Uses `launchd` (detached job), `caffeinate` (no sleep) and `sandbox-exec` (write boundary). Linux and Windows are not supported. |
| Node.js ≥ 22.12 | yes | An absolute `node` path is needed for the launchd job. |
| git | yes | Repos live directly under your workspace. Runs use local worktrees and branches only. |
| [OpenCode](https://opencode.ai) 2.0.x | yes | Tested with **2.0.29**. `doctor` warns on a patch mismatch and fails on a major one. |
| **oh-my-opencode-slim**, major **3** | **yes** | `npx oh-my-opencode-slim@latest install`, then pin the plugin to 3.x in your global `opencode.json`. The run relies on slim's specialist agents, background dispatch, per-run prompt appends and config overrides. There is no plain-OpenCode fallback. |
| 5 required skills | yes | `spec-driven-development`, `planning-and-task-breakdown`, `test-driven-development`, `incremental-implementation`, `code-review-and-quality`. Install with `npx skills add addyosmani/agent-skills`. `doctor` fails if one is missing. |
| A model provider | yes | Anthropic models are the built-in defaults. Any other provider works once you [set every agent's model](#5-minute-quickstart). |
| An issue-tracker CLI | optional | Only to fetch a ticket in the spec phase. Without one, you paste the ticket. |
| Per-repo toolchains | optional | `npm`, `go` and `cargo` are inferred from the repo; others come from `repos.<name>.tools` in the profile. A missing tool is a `doctor` warning. |

nightgem is **not published to npm yet**. You run it from a clone.

## How it works

A night shift at a gem factory. You hand the foreman an approved spec; by morning there is a tray of finished gems.

| Factory | In nightgem |
|---|---|
| Raw stones | The approved `SPEC.md`, split into tasks in `PLAN.md` (checked by the oracle). |
| **Foreman** | The `orchestrator` agent, driven by a Node/TypeScript supervisor on its own sandboxed `opencode serve`. |
| **Conveyor belts** | Parallel lanes: one git worktree per task, `<repo>/.worktrees/<slug>/<task>`. |
| **Workers** | `explorer` (recon), `fixer` (implements and fixes), `designer` (UI work), plus `librarian` for docs. |
| **Inspector with a loupe** | The `oracle` agent reviews the plan, risky decisions, and the final integration branch. |
| **Morning tray** | Verified local branches and a deterministic `REPORT.md` (no LLM involved). |

```
/nightgem (interactive)
  spec -> approval -> budget -> doctor -> launch
                                            |
                      launchd job (detached, caffeinate)
                                            v
          orchestrator -> sandboxed `opencode serve`
                                            |
  plan (oracle review)
    -> build (parallel lanes, verify, <= 3 fix-ups)
    -> review (integration + oracle)
    -> REPORT.md
```

Each phase is its own root session, so cost is exact per phase. Failure policy: up to 3 fix-ups per task, the oracle is consulted after the second, then the task is BLOCKED and its dependents are skipped. Details, artifacts and the first-run checklist: [docs/how-it-works.md](docs/how-it-works.md).

## Budget

| Threshold | Meaning |
|---|---|
| Soft stop, **85%** | Nothing new is dispatched. In-flight work winds down, a short oracle-only review runs, then the report is written. |
| Hard stop, **100%** | Every session is aborted, then the report is written (`aborted-budget`). |

Cost is OpenCode's own per-session figure, summed over the run's sessions; no provider billing API is used. It is an **estimate**, and overshoot at the hard stop is bounded, not zero. See [docs/how-it-works.md](docs/how-it-works.md#budget-accounting). Each `resume` brings its own `--budget`, so a resumed run's total can go past the first budget.

## Safety at a glance

The run never waits on a human and never pushes. Layers overlap so that no single rule has to be perfect.

- **No push capability.** Fetch-only ssh wrapper, push URLs rewritten to a dead transport, no credentials, `~/.ssh` unreadable, outbound port 22 refused. Covers every remote of every spec repo (any host); a remote URL that embeds a password or token makes `doctor` and launch fail.
- **Kernel write boundary.** `opencode serve` runs under `sandbox-exec`: writes only inside the workspace and the run's own dirs.
- **Unattended permission profile.** Never `ask`; `git push`, `git stash`, forge/tracker CLIs and publishing are denied, and MCP servers are switched off.
- **Guard plugin** blocks secret reads, out-of-bounds writes and network git, in addition to the profile.
- **Preflight canary at every launch** proves the layers hold. The launch is refused if anything forbidden succeeds.
- **Tripwires** watch your repos every 5 minutes and end the run if HEAD, branch, status or stash change.
- **Not a boundary:** your provider API key is readable by the server, and network egress is open. Use a **dedicated, spend-capped API key**.

Full model and every residual risk: **[docs/safety-model.md](docs/safety-model.md)**.

## Profile

Everything specific to you (workspace, tracker, extra denies, models, extra instructions) lives in a **user profile** outside this repo: `~/.config/nightgem/profile.jsonc`, or the path in `NIGHTGEM_PROFILE`. It is JSONC, validated with zod, and only `version` and `workspaceRoot` are required.

```jsonc
{
  "version": 1,
  "workspaceRoot": "~/work",
  "instructionsFile": "~/.config/nightgem/instructions.md",
  "repos": { "acme-api": { "tools": ["go", "buf"] } },
  "tracker": { "fetchCommand": "my-tracker view {KEY} --json" },
  "deny": { "commands": ["internal-deploy"], "secretPaths": [".config/acme-cli"] },
  "models": { "fixer": "provider/medium-model" }
}
```

| Field | Meaning |
|---|---|
| `workspaceRoot` | **Required.** Directory holding your git repos; specs go in `.specs/` under it, and it is the sandbox write root. Rejected if it is `/`, `$HOME` or an ancestor, overlaps `~/Library`, `~/.config` or `~/.ssh`, or sits inside a git work tree. |
| `instructionsFile` | Markdown with your conventions, rendered into the agent prompts. |
| `repos.<name>.tools` | Executables `doctor` and `launch` expect for that repo. |
| `tracker.*` | Ticket fetch commands and opt-in auto-claim, spec phase only. |
| `skills.*` | Extra required skills, enforced excludes, extra skill roots. |
| `deny.*` | Extra denied commands, shell globs, secret paths (relative to `$HOME`) and edit globs. |
| `models.<agent>` | `provider/model[#variant]` per agent. Precedence: `NIGHTGEM_<AGENT>_MODEL`, then the profile, then the Anthropic defaults. |
| `audit.bannedTerms` | Terms `doctor --audit-repo` must find 0 times. Local only. |

The complete field reference, skill detection and tracker behaviour are in **[docs/profile.md](docs/profile.md)**.

## CLI reference

`npm link` (see the quickstart) puts `nightgem` on your PATH. Without the link, run `node <checkout>/bin/nightgem.mjs <command>` instead. The installed slash commands and the launchd job always use absolute paths, so they work either way.

| Command | What it does |
|---|---|
| `launch <slug> --budget <usd> [--repos a,b]` | Checks the spec is `APPROVED`, runs `doctor`, snapshots the run context and starts the detached launchd job. Refuses a slug that already has a run (use `resume` or a new slug). |
| `status [slug]` | State, phase, cost against the attempt's budget, heartbeat, paths. Without a slug it lists every run. |
| `resume <slug> --budget <usd>` | Continues a stopped, over-budget, failed or stalled run as a new attempt, with `--budget` as extra money for it. After a crash run `stop <slug>` first. See [Resume](docs/how-it-works.md#resume). |
| `stop <slug>` | Aborts all sessions and writes the report. A run whose job is gone (a crash) is closed, so it can be resumed. |
| `report <slug>` | Regenerates `REPORT.md` from the artifacts and git. No LLM, no network. |
| `doctor [--verbose] [--audit-repo [--dir <repo>]]` | Environment checks for an unattended run. Each check prints one line of at most 200 characters; `--verbose` prints the full detail. `--audit-repo` scans tracked files for personal data instead. |
| `profile path\|show [--json]\|validate` | Locate, print or validate the profile. |
| `render <slug> --out <dir>` | Render the run's generated config, sandbox profile and prompts for inspection, without launching. |
| `install [--workspace <dir>] [--force]` / `uninstall` | Install or remove the slash commands (and the starter profile). |

Exit codes: `0` ok, `1` error or hard `doctor` failure, `2` usage error.

## Troubleshooting

Doctor failures, canary failures, stale locks and stalled runs: **[docs/troubleshooting.md](docs/troubleshooting.md)**.

## FAQ

**Does it push or open PRs?** No. The run has no push credentials, no ssh key and no route to port 22, and git push is denied in several layers. You review local branches and push yourself.

**Why oh-my-opencode-slim?** The run uses slim's specialist agents, its background dispatch and per-run prompt appends. There is no plain-OpenCode fallback.

**Can I use a provider other than Anthropic?** Yes. Set `models.<agent>` for every agent (see the [quickstart](#5-minute-quickstart)); `doctor` checks the models are available.

**How much does a run cost?** Whatever you set as the budget, roughly: 85% soft stop, 100% hard stop, plus a small bounded overshoot. Pick a modest budget for a first run.

**Linux or Windows?** No. nightgem depends on `launchd`, `caffeinate` and `sandbox-exec`.

**What if the Mac sleeps or goes on battery?** The job uses `caffeinate`, but `doctor` requires AC power because a run on battery can be cut short.

**Can I use OpenCode.app?** Launching works from the app; the run always gets its own detached server. Attaching the app to watch live is untested, but a terminal attach works (`status` prints the command).

**Is it on npm?** Not yet. Run it from a clone.

**Where are my results?** `<workspaceRoot>/.specs/<slug>/REPORT.md` and the branches under `<repo>/.worktrees/<slug>/`.

## Author

nightgem is written and maintained by **Lukasz Goslawski** ([@lokers](https://github.com/lokers) on GitHub). Questions, ideas and bug reports are welcome as [issues](https://github.com/lokers/nightgem/issues); for security problems, follow [SECURITY](SECURITY.md).

## Disclaimer

nightgem is **experimental** software that runs an AI agent unattended and spends real money. Use a **dedicated, spend-capped API key**, run it on a machine and account where you could live with the worst case, and review everything it builds before you use it. You are responsible for the cost of every run and for any code it produces. The software is provided as is, without warranty of any kind, under the [MIT License](LICENSE).

## Contributing and project

[CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md) · [CHANGELOG](CHANGELOG.md) · [AGENTS.md](AGENTS.md) (conventions and module map) · [docs/opencode-notes.md](docs/opencode-notes.md) (OpenCode behaviours this relies on) · [brand assets](assets/brand/README.md)

Development: `npm ci && npm run type-check && HOME=$(mktemp -d) npm test`.
