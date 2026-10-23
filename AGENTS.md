# nightgem: agent instructions

It launches a detached, budget-capped autonomous OpenCode run from an approved spec. Read [README.md](README.md) for the overview, [docs/safety-model.md](docs/safety-model.md) for the safety layers and residual risks, [docs/profile.md](docs/profile.md) for the profile, [docs/how-it-works.md](docs/how-it-works.md) for the lifecycle, budget and artifacts, [docs/troubleshooting.md](docs/troubleshooting.md) for failures, and [docs/opencode-notes.md](docs/opencode-notes.md) for the OpenCode 2.0.29 behaviours the code relies on. Community files: [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md).

## Stack

TypeScript ESM, Node ≥ 22.12, `tsx`, `vitest`, `zod` v4, `commander`, `execa`, `jsonc-parser`. The OpenCode server API is spoken through a thin fetch + SSE client (no SDK). OpenCode 2.0.29 is the tested version, and oh-my-opencode-slim 3.x is required.

## Commands

```
npm ci
npm run build           # dist/ (the bin runs src/ through tsx in a clone, so this is not needed to develop)
npm run type-check      # tsc --noEmit
npm test                # vitest run
npm run cli -- <cmd>    # tsx src/cli.ts launch|status|stop|report|doctor|profile|render|install|uninstall
node bin/nightgem.mjs <cmd>    # the same CLI, as users run it
```

Run tests with a throwaway HOME: `HOME=$(mktemp -d) npm test`. Run `npm run type-check && HOME=$(mktemp -d) npm test` before every commit.

## Docs

- `README.md` is the public front page: keep it short (about 300 lines) and put detail in `docs/`. Other code and slash commands point at its sections (`Prerequisites`, `Profile`, `Troubleshooting`), so do not rename those headings.
- `test/docs-anchors.test.ts` checks every relative link and `#anchor` in the README, `docs/*.md`, CONTRIBUTING, SECURITY and CHANGELOG, plus `README.md#…` / `docs/…#…` references in `src/`, `commands/` and `templates/`. If you rename a heading, fix the links. Anchors are GitHub-style slugs of the heading text.
- A change in behaviour, commands, environment variables or the safety model updates the docs in the same commit, and a user-visible change gets a line in `CHANGELOG.md` (Keep a Changelog format).
- Docs follow the same data rules as code (below): neutral examples only.

## Conventions

- **Named exports only.** No default exports.
- **zod at every I/O boundary**: files (`RUN.json`, `*.jsonl`, control flags), server payloads, CLI input. Server schemas are loose (`looseObject`) so unknown fields never break parsing.
- **Small pure modules with injectable dependencies.** Pass in `exec`, `fs`, clock, `home`, and the `RunApi`. Do not reach for globals or `process.env` inside logic. Tests inject fakes.
- **Explicit `home` / `env` / `fs`, never the real HOME.** New profile, skill-detection, doctor and install code takes `home`, `env` and `fs` as parameters with **no defaults**. Tests build a temp HOME (the vitest setup file also sets one and clears `NIGHTGEM_*` / `OPENCODE_*`) and must never read or write the developer's real `~`, `~/.config` or `~/Library`. Data fixtures use neutral absolute paths such as `/Users/alice/work`.
- **No network in tests.** Use the recorded fixtures in `test/fixtures/opencode-2.0.29/recorded/` and fakes. No test may call the real OpenCode, GitHub, or a model.
- **Never print secrets.** Not the run server password, not the contents of its file, not `.env` files, not API keys. Redact before logging. `OPENCODE_SERVER_PASSWORD` must never appear in output, logs, reports or test snapshots.
- Paths come from `src/paths.ts`. Do not build run, control or worktree paths by hand, and keep the containment checks.
- Never push, open PRs, or merge from this repo's tooling or tests. The run itself must never do so either.
- Do not modify the user's global OpenCode config or unrelated global commands. The only global files this project owns are the slash commands it installs, `~/.config/opencode/commands/nightgem*.md`, which carry a managed-marker comment. `uninstall` removes only marked files whose hash still matches.
- **The profile is the only source of user facts.** No workspace path, tracker, repo name, skill name or deny entry is hard-coded in `src/`, `prompts/` or `profile/`. Read them from the resolved run context (the profile snapshot).

## No personal or company data in the repo

Tracked files must not contain personal paths, company or employer names, product names other than nightgem, OpenCode, oh-my-opencode-slim, Anthropic (as a model-provider example) and GitHub, real ticket keys, emails (the maintainer contact in the policy files is the one exception) or hostnames. This is enforced by `src/audit.ts`, by `test/leaks.test.ts` (generic checks) and by `doctor --audit-repo` (plus your local `audit.bannedTerms`).

- Examples and fixtures use `acme-api` / `acme-web` as repo names, `JIRA-123` as a ticket key, `/Users/alice` (or `/Users/alice/work`) as a home path, `example.invalid` / `example.com` as hosts, and `{{WORKSPACE}}` / `{{HOME}}` placeholders in corpora.
- Recorded fixtures are scrubbed before they are committed. Do not paste raw terminal output, logs or session recordings without scrubbing them.
- Add banned terms only to your local profile, never to the repo.

## Commits

Conventional commits with a sentence-case subject: `feat: Add budget ledger`, `fix: Handle stale lock`, `docs: Update README`. Reference the GitHub issue in the commit body: `Refs #N` for partial work, `Closes #N` on the commit that completes it, and end the CHANGELOG line with `(#N)`. After it lands on `main`, check the issue closed as completed (`gh issue view N --json state,stateReason`); if not, close it with `gh issue close N --reason completed --comment "Done in <sha>"`. Work on a branch such as `feat/<topic>` or `fix/<topic>`, in a git worktree under `.worktrees/<topic>`. Do not push, open PRs or merge from this repo's tooling or tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Module map

| Path | Role |
|---|---|
| `src/contracts.ts` | zod schemas, enums, `RunApi` interface |
| `src/paths.ts` | all run/control/worktree paths and containment |
| `src/state.ts` | `RUN.json` store, lock, terminal guard |
| `src/budget.ts`, `src/pricing.ts` | ledger, thresholds, estimate prices |
| `src/userprofile.ts`, `src/skills.ts`, `src/audit.ts`, `src/glob.ts` | user profile and workspace validation, skill detection, leak audit, glob matcher |
| `src/profile.ts`, `src/rulecheck.ts` | permission profile and env rendering, preflight |
| `src/sandbox.ts` | `sandbox-exec` profile |
| `profile/` | guard plugin package, probe corpus, fetch-only ssh wrapper |
| `prompts/`, `src/prompts.ts` | autonomous prompts and appends |
| `src/report.ts`, `src/gitinfo.ts` | deterministic `REPORT.md` |
| `src/watchdog.ts`, `src/tripwires.ts` | watchdog state machine, tripwires |
| `src/launcher.ts`, `src/plist.ts`, `src/doctor.ts`, `src/specmeta.ts`, `src/cli.ts`, `src/cli-deps.ts`, `bin/` | CLI |
| `src/remotes.ts` | remote URLs of the spec repos, the `pushInsteadOf` / `insteadOf` no-push rules, credential detection |
| `src/wiring.ts` | real `CliDeps` and orchestrator deps: run context resolution and snapshot, preflight and canary |
| `src/install.ts`, `src/render.ts`, `commands/`, `templates/` | `install`/`uninstall`, `render`, slash command templates, starter profile |
| `src/server.ts`, `src/client.ts`, `src/events.ts`, `src/orchestrator.ts` | runtime (serve lifecycle, client, events, wiring) |
| `docs/` | `safety-model.md`, `profile.md`, `how-it-works.md`, `troubleshooting.md`, and `opencode-notes.md` (observed OpenCode 2.0.29 behaviour: API routes, permissions, sandbox, launchd) |
| `assets/brand/` | logo, hero and social-card assets (see its README) |
| `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` | community and release files |
| `test/` | vitest tests (including `leaks.test.ts` and `docs-anchors.test.ts`); `test/fixtures/opencode-2.0.29/` holds the recorded server responses |

## Changing `src/contracts.ts`

Every module uses it: the profile, ledger, state, report, CLI, client, events and orchestrator. A change to a schema or to `RunApi` ripples everywhere and can break files and runs already on disk. The same caution applies to `src/userprofile.ts` (the profile schema), `src/paths.ts`, `src/glob.ts`, `test/fixtures/paths.ts` and `vitest.config.ts`.

- Prefer additive changes (new optional fields, new enum members at the end) over renames or removals.
- Version-bump `RunManifest` for any breaking change, and keep reading the old version if a run could be in flight. Reads go through `parseRunManifest`, which accepts v1 and v2 and returns v2; writes are always the current version.
- Update the fixtures and `test/contracts.test.ts`, and run the whole suite, not just the module you touched.
- When working in a parallel lane, do not edit it. Report BLOCKED with the exact change needed. The same goes for `package.json`, the lockfile, `tsconfig.json`, `vitest.config.ts` and `src/paths.ts`.

## Safety-critical files: oracle review required

These files decide whether an unattended run can push, escape its directory, leak a secret or overspend. Any change to them needs an @oracle review before it is merged, and the tests that go with them must be extended, not loosened:

- `profile/` (guard plugin `index.mjs`/`decide.mjs`, `corpus.txt`, `git-ssh-fetch-only.sh`)
- `src/profile.ts` (permission rules, safety env, tool denies)
- `src/sandbox.ts` (the write boundary)
- `src/rulecheck.ts` (the launch preflight)
- `src/userprofile.ts` (workspace-root and skill-root validation: a bad root widens the sandbox write boundary) and `src/skills.ts` (skill exclusion is enforced, not cosmetic)
- `src/install.ts` (ownership marker and hash check: it must never overwrite or delete a file it does not own)
- the guard logic and its bypass corpus (`test/guard.test.ts`, `test/profile.test.ts`, `test/rulecheck.test.ts`)
- also take care with `src/tripwires.ts`, `src/budget.ts` and the stop sequences in `src/orchestrator.ts`

Rules for these files:

- The profile must contain no `ask` anywhere. The validation test must stay.
- Widen the sandbox allowlist one subpath at a time, only when a real build step needs it, and say why in the commit body.
- Add a probe to the corpus for every new bypass you find. Never delete a probe to get to green.
- Do not weaken a test, skip it, or add `@ts-ignore` / lint suppressions to get past a failing safety check. Fix the cause.
