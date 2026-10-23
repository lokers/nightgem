# Contributing to nightgem

Thanks for helping. nightgem runs an AI agent unattended on someone's machine, so the bar for the safety layers is high and the bar for everything else is friendly. Please read this page once before you open a pull request. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For vulnerabilities, see [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

- **macOS only.** nightgem depends on `sandbox-exec` and `launchd`. The unit tests do not need either, but the real runs do.
- **Node ≥ 22.12.** CI tests Node 22 and 24.
- Install the dependencies:

```
git clone https://github.com/lokers/nightgem.git
cd nightgem
npm ci
```

Run `npm run build && npm link` once to put `nightgem` on your PATH, then use `nightgem <command>` (or `npm run cli -- <command>`, which runs `src/` directly).

## Tests

Run both before every commit:

```
npm run type-check && HOME=$(mktemp -d) npm test
```

- Always use a throwaway `HOME`. Tests must never read or write your real `~`, `~/.config` or `~/Library`.
- No test may use the network, the real OpenCode, GitHub or a model. Use the recorded fixtures in `test/fixtures/` and fakes.
- `test/leaks.test.ts` scans the **tracked** files for personal paths, emails, real ticket keys and hostnames. Commit (or `git add`) your new files first, or the test will not see them.
- Do not weaken, skip or delete a test to get to green, and do not add `@ts-ignore` or lint suppressions to get past a failing check. Fix the cause.

CI runs the same commands on `macos-latest`, plus `npm run build`, `npm run pack:check` and a secret scan.

## Code conventions

- TypeScript ESM. **Named exports only**, no default exports.
- **zod at every I/O boundary**: files, server payloads, CLI input.
- **Small pure modules with injectable dependencies.** Pass `exec`, `fs`, the clock, `home` and `env` in; do not reach for globals or the real `process.env` in logic.
- Build paths with `src/paths.ts`, never by hand.
- Never print secrets: not the run server password, not API keys, not `.env` contents. Redact before logging.
- The user's profile is the only source of user facts. Do not hard-code a workspace path, tracker, repo name, skill name or deny entry in `src/`, `prompts/` or `profile/`.
- [AGENTS.md](AGENTS.md) has the longer version, including the module map and the rules for changing `src/contracts.ts`.

## Commits

[Conventional commits](https://www.conventionalcommits.org/) with a **sentence-case** subject:

```
feat: Add budget ledger
fix: Handle stale lock
docs: Update safety model
ci: Add macOS test workflow
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `chore` and `ci`. Keep the subject short and say *why* in the body when it is not obvious. Examples, tests and docs in this repo use only the neutral ticket key `JIRA-123`.

## Issues

Work is tracked in [GitHub issues](https://github.com/lokers/nightgem/issues), grouped into milestones per release.

- Reference the issue in the body of every commit that works on it. Write `Refs #12` for partial work, and `Closes #12` in the commit (or pull request description) that completes it. GitHub closes the issue as completed when that commit reaches `main`.
- One issue can need several commits or pull requests. Use `Closes` only on the last one.
- After the merge, check that the issue is closed as completed and links the commit or pull request. If it did not close (for example, the keyword was missing), close it by hand with a comment naming the commit: `gh issue close 12 --reason completed --comment "Done in <sha>"`.
- Close an issue you decide not to do as "not planned", with the reason.
- The CHANGELOG line for the change ends with the issue number, for example `(#12)`.
- A release closes its milestone; anything left open moves to the next milestone.

## Branches and worktrees

- Fork the repo and branch from a freshly fetched `main`. Name the branch `<type>/<topic>`, where the type is the conventional-commit type: `feat/budget-ledger`, `fix/stale-lock`.
- A git worktree keeps your main checkout clean, for example: `git worktree add .worktrees/stale-lock -b fix/stale-lock origin/main`. Run `npm ci` in a new worktree before you test. `.worktrees/` is git-ignored.
- One topic per pull request. Small, reviewable pull requests are merged faster.
- Do not push to, or force-push over, someone else's branch.

## No personal or company data

Tracked files must not contain personal paths, company or employer names, product names other than nightgem, OpenCode and oh-my-opencode-slim, real ticket keys, email addresses (the maintainer contact in the policy files is the one exception) or internal hostnames. This is enforced by `src/audit.ts`, `test/leaks.test.ts` and `nightgem doctor --audit-repo`.

- Use `acme-api` / `acme-web` as repo names, `JIRA-123` as a ticket key, `/Users/alice` or `/Users/alice/work` as a home path, `example.com` / `example.invalid` as hosts, and `{{WORKSPACE}}` / `{{HOME}}` placeholders in corpora.
- Scrub recorded fixtures before you commit them. Never paste raw terminal output, logs, run reports or session recordings without reading them line by line.
- Put your own "banned terms" in your local profile (`audit.bannedTerms`), never in the repo.

## Safety-critical files

These files decide whether an unattended run can push, escape its directory, leak a secret or overspend. A mistake here is not a bug that shows up as a red test; it shows up as a stranger's code, keys or money. A change that touches them needs **a maintainer review**, and the probes and tests that go with the change must be **extended, not loosened**.

| Path | Why it needs extra review |
|---|---|
| `profile/` (guard plugin `index.mjs` and `decide.mjs`, `corpus.txt`, `git-ssh-fetch-only.sh`) | The guard is the main text-level defence against `git push`, secret reads, out-of-bounds writes and forge CLIs. The corpus is the record of every bypass we know about. The ssh wrapper is what makes fetch work and push impossible. |
| `src/profile.ts` | The permission rules, the safety environment (no credentials, no push transport) and the tool denies. A single `ask` or a too-wide `allow` changes what an unattended run may do. |
| `src/sandbox.ts` | The kernel write boundary. Widening it exposes more of the machine to every command the agents run. |
| `src/rulecheck.ts` | The launch preflight. If it passes something it should refuse, the run starts unsafe. |
| `src/userprofile.ts` and `src/skills.ts` | Workspace-root and skill-root validation: a bad root widens the sandbox write boundary. Skill exclusion is enforced, not cosmetic. |
| `src/install.ts` | The ownership marker and hash check. It must never overwrite or delete a file it does not own. |
| `test/guard.test.ts`, `test/profile.test.ts`, `test/rulecheck.test.ts` | The bypass corpus and the invariants (no `ask`, push always denied). Loosening these is the same as loosening the code they protect. |
| `src/tripwires.ts`, `src/budget.ts`, the stop sequences in `src/orchestrator.ts` | Detection of tampering and the hard spend stop. Take extra care and add tests. |

Rules for these files:

- The profile must contain no `ask` anywhere. The validation test must stay.
- Widen the sandbox allowlist one subpath at a time, only when a real build step needs it, and explain why in the commit body.
- Add a probe for every new bypass you find (see below).
- **Never delete a probe to get to green.** If a probe fails, the code is wrong. If you believe the probe is wrong, say so in the pull request and let a maintainer decide.
- Explain in the pull request what you considered and what you tested. "Tests pass" is not enough for these files.

Also be careful with `src/contracts.ts`, `src/paths.ts` and `src/glob.ts`: many modules depend on them, and runs already on disk must keep working.

## How to add a probe

A probe is a line in `profile/corpus.txt` that describes a command (or tool input) and what the safety layers must do with it. They are evaluated at every launch by the rule preflight, and the guard tests run them on every `npm test`.

1. Read the header of `profile/corpus.txt` for the line format and a few existing examples, and look at how `test/guard.test.ts` and `test/rulecheck.test.ts` consume it.
2. Write down the bypass: the exact command or input, and the layer that should have stopped it (permission profile, guard, sandbox or environment).
3. Add the probe line to `profile/corpus.txt`, using placeholders (`{{WORKSPACE}}`, `{{HOME}}`) and neutral names, never real paths.
4. Run `HOME=$(mktemp -d) npm test`. The new probe should **fail** first. If it does not, the layer already handles it, and the probe is still worth keeping as a regression test.
5. Fix the guard or profile until the probe passes without loosening any other probe.
6. For a guard fix, add a unit case in `test/guard.test.ts` as well, including a near-miss that must stay allowed (for example, a branch name that merely contains `push`).
7. Mention the probe in the pull request, tick the safety-critical box in the checklist, and update the README's safety model or residual risks if the behaviour a user relies on changed.

## Pull request checklist

The pull request template has the same list. Before you ask for review:

- [ ] `npm run type-check` passes.
- [ ] `HOME=$(mktemp -d) npm test` passes, including `test/leaks.test.ts`, and I did not skip, delete or weaken a test.
- [ ] `npm run build` and `npm run pack:check` pass, if I touched packaging, `bin/` or `package.json`.
- [ ] No personal or company data, secrets, or real ticket keys in any tracked file, fixture or commit message.
- [ ] The commit subjects are conventional and in sentence case.
- [ ] The pull request description or the final commit says `Closes #<issue>` for every issue it completes, and `Refs #<issue>` for partial work.
- [ ] **If I touched a safety-critical file:** I said so in the pull request, I extended the probes and tests, I deleted no probe, and I know a maintainer review is required.
- [ ] README and docs are updated for any change in behaviour, commands, environment variables or the safety model.

## Questions

[Open an issue](https://github.com/lokers/nightgem/issues) if something here is unclear. Improvements to this guide are welcome too.
