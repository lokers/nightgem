# Profile reference

[← README](../README.md) · [How it works](how-it-works.md) · [Profile](profile.md) · [Safety model](safety-model.md) · [Troubleshooting](troubleshooting.md) · [OpenCode notes](opencode-notes.md)

The profile is the only source of user-specific facts. It is JSONC, validated with zod, and never lives in the nightgem repo. This page is the full reference; the [README](../README.md#profile) has the short version.

- Location: `~/.config/nightgem/profile.jsonc`, or the path in `NIGHTGEM_PROFILE`.
- `install --workspace <dir>` writes a commented starter (`templates/profile.starter.jsonc`) with an empty `repos`, `tracker`, `deny` and `models`, no extra skills, and the workspace you gave. Everything but `version` and `workspaceRoot` is optional. An existing profile is never touched.
- A missing profile is a single `doctor` failure with the install hint. `profile validate` checks the file, `profile show [--json]` prints it, `profile path` prints where it is read from.
- At launch the CLI **snapshots the resolved context** (profile, skill detection, instructions text, model map, safety inputs) to `run-context.json` in the run's control directory (mode 0600, outside the agents' reach). The orchestrator reads only that snapshot and never re-resolves the profile.

## Example

```jsonc
{
  "version": 1,
  "workspaceRoot": "~/work",
  "instructionsFile": "~/.config/nightgem/instructions.md",
  "repos": { "acme-api": { "tools": ["go", "golangci-lint", "buf"] } },
  "tracker": {
    "keyPattern": "[A-Z][A-Z0-9]+-\\d+",
    "fetchCommand": "my-tracker view {KEY} --json",
    "linkedFetchCommand": "my-tracker view {KEYS} --json",
    "autoClaim": {
      "enabled": false,
      "when": { "status": "Backlog", "unassigned": true },
      "command": "my-tracker assign {KEY} --assignee me",
      "verifyCommand": "my-tracker view {KEY} --json"
    },
    "notes": "Work items are in project JIRA. Linked items matter."
  },
  "skills": { "required": [], "exclude": ["private-*"], "extraRoots": ["~/team-skills"] },
  "deny": {
    "commands": ["internal-deploy"],
    "shellPatterns": ["*acme-runner*"],
    "secretPaths": [".config/acme-cli"],
    "editPaths": ["**/api-spec.yaml", "**/generated/**"]
  },
  "models": { "fixer": "provider/medium-model#high", "explorer": "provider/small-model" },
  "audit": { "bannedTerms": [] }
}
```

## Fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1`. |
| `workspaceRoot` | **yes** | Directory that holds your git repos. Specs go in `<workspaceRoot>/.specs/<slug>/`, repo discovery and tripwires cover the git repos directly under it, and it is the sandbox write root and the `external_directory` allow. `~` is expanded. It is rejected (hard `doctor` failure) if it is `/`, `$HOME` or an ancestor of it, overlaps `~/Library`, `~/.config`, `~/.ssh` or the control root, or is inside a git work tree. |
| `instructionsFile` | no | Markdown with your workspace conventions (cross-repo flows, commit formats, generated-code rules, build caveats). Read at launch and rendered into the orchestrator, fixer, oracle and designer prompt appends through `{{workspaceInstructions}}`. Default: "follow each repo's AGENTS.md / CLAUDE.md". |
| `repos.<name>.tools` | no | Executables `doctor` and `launch` expect for that repo's verify commands (warning if missing from the job PATH). They are checked in addition to the tools inferred from `package.json` scripts (`npm`), `go.mod` (`go`) and `Cargo.toml` (`cargo`). |
| `tracker.keyPattern` | no | Regex for ticket keys in the idea text. Default `[A-Z][A-Z0-9]+-\d+`. |
| `tracker.fetchCommand` | no | Shell template with `{KEY}`. Run in the spec phase to fetch a ticket. |
| `tracker.linkedFetchCommand` | no | Template with `{KEYS}` for linked tickets. |
| `tracker.autoClaim` | no | Opt-in, default off. `when.status` / `when.unassigned` pick which tickets qualify; `command` and `verifyCommand` (both required when `enabled`) contain `{KEY}`. |
| `tracker.notes` | no | Free text shown to the spec phase. |
| `skills.required` | no | Extra required skills, on top of the five built-in ones. |
| `skills.exclude` | no | Names or globs that are never offered to a run. Enforced, not only hidden (see [Skills](#skills)). |
| `skills.extraRoots` | no | Extra directories that contain `<name>/SKILL.md` folders. |
| `deny.commands` | no | Extra command names to deny, added to the built-in defaults. |
| `deny.shellPatterns` | no | Extra shell-resource globs to deny. |
| `deny.secretPaths` | no | Extra secret locations, **relative to `$HOME`** (`.config/acme-cli`). Read-denied by the sandbox and refused by the guard. |
| `deny.editPaths` | no | Edit-deny globs (generated clients, API specs). The built-in default is empty. |
| `models.<agent>` | no | `provider/model` or `provider/model#variant` for `orchestrator`, `fixer`, `designer`, `explorer`, `librarian`, `oracle`, and `observer` (the small model: it is also the run's `small_model`; env override `NIGHTGEM_SMALL_MODEL`). |
| `audit.bannedTerms` | no | Terms that `doctor --audit-repo` must find 0 times in tracked files. Matched case-insensitively. Local only. |

### Models

**Precedence:** `NIGHTGEM_<AGENT>_MODEL` at launch time, then the profile's `models`, then the built-in defaults. The result is frozen into the run snapshot.

Built-in defaults are Anthropic ids: `anthropic/claude-opus-5-5` for the orchestrator and oracle (`NIGHTGEM_MODEL`), `anthropic/claude-sonnet-5-5` for the fixer and designer, `anthropic/claude-haiku-5-5` for the explorer, librarian and small model (`NIGHTGEM_SMALL_MODEL`). Cost estimates are priced per model, so a medium-model-heavy run costs noticeably less than an all-large one.

If you use another provider, set **every** agent key in `models` (orchestrator, oracle, fixer, designer, explorer, librarian, observer). `doctor` hard-fails when a model the run would use is unavailable, and the message names `models.<agent>` and `NIGHTGEM_<AGENT>_MODEL`. `doctor` lists models the way a run sees them, with an empty `XDG_DATA_HOME`: providers authenticated only through `~/.local/share/opencode/auth.json` are not listed (a run cannot use them either), while providers configured in `opencode.json` (with `{file:}` or env keys) are. A malformed `NIGHTGEM_<AGENT>_MODEL` is a failure, not a silent fallback.

## Skills

Skills are detected at launch by `src/skills.ts`, as plain folders `<root>/<name>/SKILL.md`. Roots, in order:

1. `~/.config/opencode/skills`
2. `~/.agents/skills`
3. `~/.claude/skills`
4. the `skills` key of your global `opencode.json` (only the `skills` and `plugin` keys are read; `~` is expanded)
5. the profile's `skills.extraRoots`

Every path is realpath'd, so a symlinked skill is counted once. The first root wins and collisions are reported. Project-level skill directories are **not** scanned: sessions run with cwd `<run>`, so OpenCode would not discover them either.

- **Required vs optional.** The five core skills (and any `skills.required`) must be present: a missing one is a `doctor` failure that prints the install command. Every other detected skill is **optional** and is offered to the agents **by name** in the prompt appends. Put extra skills in one of the roots above (for example with `npx skills add <source>`) and they show up in the next launch. The sandbox and permission read-allow rules follow the detected roots.
- **`exclude`.** Names or globs in `skills.exclude` are never offered, and the exclusion is **enforced**: detection expands the patterns to exact names, and those names go into slim's `disabled_skills`. Slim turns each one into a `skill <name> deny` rule on every agent (verified live on OpenCode 2.0.29). The skill still appears in `GET /api/skill`, so it is *denied per agent*, not hidden from discovery. A pattern that would exclude a required skill is a hard `doctor` failure.
- **Default disables.** Skills whose name matches `*jira*`, `*release*`, `*ship*`, `*changelog*` or `*publish*` are disabled the same way, because tracker, release and publish workflows make no sense unattended. The prompt appends list only skills that are not disabled.
- `~/.config/opencode/skills` sits inside the `.config/opencode` secret root. A narrow, read-only carve-out for `~/.config/opencode/skills/**` (read/grep/glob) is made when that directory is one of the detected roots; `opencode.json` and the rest of the directory stay denied. A root is dropped from the run's access (fail closed) when it is `$HOME` or an ancestor of it, or overlaps a secret location such as one of your `deny.secretPaths`. Roots that fail validation are listed in a `skill roots rejected` doctor warning.

## Tracker

The tracker is used **only in the spec phase**, by `/nightgem`, which reads your settings with `nightgem profile show --json`. The overnight run denies every tracker CLI, so everything the run needs must be pasted into `SPEC.md`.

- `fetchCommand` is run with `{KEY}` replaced by the key found in your idea text (matched with `keyPattern`). `linkedFetchCommand` gets `{KEYS}` for linked tickets.
- With no tracker configured, the spec phase asks you to paste the ticket.
- **Auto-claim is opt-in.** Only when `autoClaim.enabled` is true, and only for tickets that match `when` (for example status `Backlog` and unassigned), the spec phase runs `command` and then `verifyCommand`. Otherwise it never mutates the tracker.
