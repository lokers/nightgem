# OpenCode 2.0.29 notes

[← README](../README.md) · [How it works](how-it-works.md) · [Profile](profile.md) · [Safety model](safety-model.md) · [Troubleshooting](troubleshooting.md) · [OpenCode notes](opencode-notes.md)

What nightgem relies on in OpenCode and oh-my-opencode-slim, as observed live against OpenCode **2.0.29** with oh-my-opencode-slim **3.0.4** on macOS. These are behaviours of third-party software, so re-check them when you move the pinned version. For how nightgem uses them, see the [safety model](safety-model.md) and [how it works](how-it-works.md). Recorded server responses live in `test/fixtures/opencode-2.0.29/recorded/` and back the contract tests.

Legend: **verified** = observed live. **inferred** = read from the schema or source. **unverified** = not tested.

**On this page:** [Server API (v2)](#server-api-v2) · [Sessions, models and cost](#sessions-models-and-cost) · [Configuration: what is read, and in what order](#configuration-what-is-read-and-in-what-order) · [Permissions](#permissions) · [MCP servers](#mcp-servers) · [Shell outside the permission system](#shell-outside-the-permission-system) · [Children, interrupts and waking](#children-interrupts-and-waking) · [Slim per-run appends](#slim-per-run-appends) · [launchd](#launchd) · [sandbox-exec](#sandbox-exec) · [Desktop app](#desktop-app)

## Server API (v2)

- Every route is under `/api/*` (118 operations). Auth is HTTP Basic with the fixed user `opencode` and the password from `OPENCODE_SERVER_PASSWORD`. The web UI at `/` is unauthenticated, `/api/*` is not.
- There is no `/session/:id/abort` and no `session.idle` event. The routes in use:

| Purpose | Route |
|---|---|
| Version handshake | `GET /api/info` (`version`) |
| Registered agents and their rules | `GET /api/agent` |
| Create a session | `POST /api/session` (always pass `model`) |
| Send a prompt | `POST /api/session/:id/prompt` |
| Messages | `GET /api/session/:id/message` |
| Interrupt | `POST /api/session/:id/interrupt` |
| Running sessions | `GET /api/session/active` |
| Pending permission requests | `GET /api/permission/request`, `GET /api/session/:id/permission` |
| Answer a request | `POST /api/session/:id/permission/:rid/reply` (`decision`: `once`, `always`, `reject`) |
| Evaluate a rule without a model | `POST /api/session/:id/permission` |
| Run a shell command as no agent | `POST /api/session/:id/shell` |
| Rebuild loaded locations | `POST /api/location/reload` |
| Event stream (SSE) | `GET /api/event` |

- **A thin fetch + SSE client is used, not the SDK.** The 1.19.x SDK has drifted from 2.0.29 (51 operations against 118, with routes that no longer exist and a missing `/api/location/reload`).
- `GET /api/agent` is empty for roughly 5 to 15 seconds after start while slim registers. Poll until `orchestrator` is present. `opencode debug agents` lags behind file changes, so preflight must query the live `/api/agent`, not the CLI.
- `GET /api/session` is **global**: it lists every project's sessions in the shared database. Isolate the database with a per-run `XDG_DATA_HOME` (verified, auth included) so that "every session in this database" belongs to the run.
- Terminal events are `session.execution.succeeded|failed|interrupted`. Other useful events: `session.step.ended` (carries `cost`, `tokens`), `session.usage.updated` (cumulative cost), `session.inbox.enqueued` (`synthetic` items wake a parent), `permission.asked`, `permission.replied`, `session.compaction.*`, `session.shell.ended`. Frames are `data: {id, created, type, location, data}`, with a `: heartbeat` comment about every 10 s.
- There is no `message.updated` event. Use `session.step.ended` and `session.usage.updated`.

## Sessions, models and cost

- **A session created over the API uses the server default model, not the agent's model** (a free model with cost 0 when nothing is configured). Slim's per-agent model overrides apply only to slim-delegated children. Create the root session with an explicit `model`, and also set `"model"` in the config content.
- `Session.Info.cost` is the full tally: messages **plus title generation plus compaction**. Those two are not in the sum of assistant message costs, so the ledger reads `Session.Info.cost`, not message costs. Children carry `parentID`, `location.directory` and `projectID` of the parent, and their own cost.
- `webfetch` called with a `prompt` uses a stateless generate call: no session, no cost anywhere. Strip or deny the `prompt`. Keep slim/OpenCode `warming` off for the same reason.

## Configuration: what is read, and in what order

Rule precedence, last match wins: slim agent defaults, global `opencode.json`, `<cwd>/opencode.json(c)` and `<cwd>/.opencode/opencode.json(c)`, then **`OPENCODE_CONFIG_CONTENT` (applied last, so highest precedence, and an agent cannot edit an env var)**, then a built-in `browser * deny`.

| Read (verified) | Not read (verified) |
|---|---|
| `<cwd>/opencode.json`, `opencode.jsonc` | `<cwd>/.opencode/config.json` |
| `<cwd>/.opencode/opencode.json`, `opencode.jsonc` | `<cwd>/config.json` |
| `OPENCODE_CONFIG_CONTENT` (JSON in env) | |
| `OPENCODE_CONFIG` (path to a file) | |
| `<cwd>/.opencode/oh-my-opencode-slim.jsonc` or `.json` | |

- Do **not** set `OPENCODE_CONFIG_DIR`: the slim agents never registered with it. Do not set `OPENCODE_DISABLE_PROJECT_CONFIG=1`: it disables slim's project config.
- Slim walks **every ancestor** `.opencode/` directory when running under the v2 host (no `.git` stop). `doctor` therefore asserts that no ancestor of the run directory has an `.opencode/` or `opencode.json`.
- `service.json` is ignored by a `serve` started without `--service`.
- A rule change in a cwd file applies after `POST /api/location/reload` (pending permissions are cancelled and agents briefly vanish). `OPENCODE_CONFIG_CONTENT` cannot change at all, which keeps the profile immutable for the run.
- Plugins: only a **package directory** (with `package.json`) declared as `"plugins":[{"package":"/abs/dir"}]` loads. A bare `.mjs`, an autoloaded `.opencode/plugins/*.mjs` and `file://` URLs did not. The surface is v2: `export default { id, setup(ctx) { ctx.tool.hook("execute.before", async (e) => { ... }) } }`, with `e = {tool, sessionID, agent, messageID, id, input}`. The hook fires for the root and for every child; throwing blocks the call (the model sees `{"type":"unknown","message":...}`); mutating `e.input` works.

## Permissions

- A permission is an ordered list of `{action, resource, effect}`. The **last** rule whose action and resource both match wins. No match means `ask`.
- With an `ask` in serve mode the tool call blocks and the session stays `running` forever, with a `permission.asked` event. So the run profile must contain no `ask`, and anything that still asks is rejected over the API. Rejecting one pending request also cancels the other pending ones in that session.
- **Wildcard matcher** (read from the binary and checked against the live evaluator, 950 probes, 0 mismatches):
  - `*` matches anything, including `/`, spaces and newlines.
  - `?` matches exactly one character.
  - A **trailing ` *` is optional**: `tracker *` also matches the bare `tracker`, and `*/tracker *` also matches `ls libs/tracker`.
  - The pattern is anchored at both ends and **case-sensitive**.
  - `. + ^ $ { } ( ) | [ ]` are literal. Character classes such as `[;&|]` do not work.
  - Backslashes are read as `/` in both input and pattern.
- **Shell resources.** Compound commands are split into per-segment resources (`echo b | cat` gives `["echo b","cat"]`; `$(echo h)` adds `echo h`). `sh -c '...'`, `bash -lc "..."` and `eval` stay one string, so word-based globs such as `*git*push*` are needed besides prefix patterns. Env prefixes stay in the segment (`FOO=1 echo i`). Redirect targets stay inside the segment string and are **not** checked as `edit` or `external_directory` paths.
- **Edit resources are cwd-relative.** For a file inside the session directory, the `edit` and `write` tools hand the `edit` rule a path relative to that directory (`tasks.jsonl`, not the absolute path). Sessions run with cwd `<run>`, so an `edit` allow for a file there must be written in both spellings; files outside the run directory (worktrees, the plan) arrive as absolute paths.
- Globs like `*git*push*` also deny harmless text such as `git commit -m "fix push handling"`. Prompts tell agents to avoid those words in shell strings or to use `-F file`.
- **The evaluator**: `POST /api/session/:id/permission {action, resources[], agent}` returns `allow|deny|ask` without calling a model. This is the preflight: a table of `(action, resource)` probes runs in seconds. A cheap live model canary only confirms the resource mapping.
- Every child session gets the **full rule list of its own agent**, so the profile does not need to be per-agent.
- **The `skill` permission action** is valid on 2.0.29 (verified live: `POST /api/session/:id/permission` accepts `action: "skill"`, and a config-level `{skill, <name>, deny}` rule is honoured by the evaluator). Slim's `disabled_skills` (exact names) becomes a `skill <name> deny` rule on every agent in `GET /api/agent`. The skill still appears in `GET /api/skill`: it is denied per agent, not hidden. The evaluator endpoint does not apply those agent-level rules (it answered `allow` for an agent whose rules ended in `skill * deny`), only config-level ones, so the preflight cannot probe them through it.

## MCP servers

- **Tool naming.** An MCP tool is named `<server>_<tool>`, each part with every character outside `[A-Za-z0-9_-]` replaced by `_` (read from the 2.0.29 binary). A permission rule `{action: "<server>_*", resource: "*", effect: "deny"}` covers every tool of one server, and the evaluator answers `deny` for `<server>_<anything>`. `mcpToolPrefix` in `src/profile.ts` does the same sanitising.
- **Config layout.** In the normalised v2 config the servers live under `mcp.servers.<name>`. A v1-style file (`mcp: { <name>: {...} }`) is migrated on load, and a user file may use either layout, so `src/mcp.ts` reads the key names of both. It takes names only, from the config syntax tree. `GET /api/config` returns the server definitions with their values, so this tool never copies a value anywhere.
- **Where servers come from.** The global `opencode.json` is loaded by the run server: a local stdio server defined there is `connected` in `GET /api/mcp` a few seconds after start (not at the first request). Slim adds its own `context7` and `gh_grep`.
- **What does not switch a server off.** Slim's `disabled_mcps` and a `<server>_*` permission deny do not stop opencode from starting and connecting a user-defined server (live: `connected` with both in place). They only make its tools unreachable. The server process would still run inside the sandbox with its own credentials.
- **What does.** The v1 flag `enabled: false` is migrated to `disabled: true`, and a server with `disabled: true` is reported as `disabled` by `GET /api/mcp` and never started. An entry in `mcp.servers` needs `type` and `command` (local) or `url` (remote): a **partial** entry such as `{ disabled: true }` or `{ enabled: false }` is silently dropped on load (the document's `mcp` comes back `null`, no error), so it does not override anything.
- **What the run does.** For every server name of the user's config the run config (`OPENCODE_CONFIG_CONTENT`, and the readable copy `<run>/opencode.json`) carries the inert stand-in `mcp.servers.<name> = { type: "local", command: ["/usr/bin/false"], disabled: true }`. Deep merge replaces the user's command (and a remote entry's `type`) and sets `disabled`; the user's `environment`/`headers` stay in their own file and are never copied. Live result (temp HOME, sandbox on, a local stdio stub with a fake `environment` secret and a remote server with a fake `Authorization` header, both only in the global file): after 10 s `GET /api/mcp` reports both as `disabled`, no stub process exists, the config is accepted and the server starts, with and without slim loaded. The `<server>_*` denies and slim `disabled_mcps` stay as a backstop.
- Slim's own built-in servers (`context7`, `gh_grep`) are not in the user's config and are not touched by this.

## Shell outside the permission system

- `POST /api/session/:id/shell` takes only `{command, id?}`, answers 204 and reports `session.shell.ended` (`shell.exit`, `output.output`). It starts no model turn.
- It **bypasses both the permission rules and the guard plugin**, because it runs as no agent. It still runs in the server's own environment, **inside the sandbox**. It is therefore a deterministic probe of the sandbox and env layers only.
- Every shell child inherits the server environment, including `OPENCODE_SERVER_PASSWORD`. The profile denies `env` and `printenv`, and the guard refuses env dumps, but a script reading its own environment would still see it. Stripping it through a `shell.env` hook is unverified on v2.
- The default foreground shell timeout is 120000 ms (`timeout: 0` disables it). Whether a `background: true` process outlives its session is unverified, so the process-group kill is the backstop.

## Children, interrupts and waking

- Interrupting the root does **not** stop its children: they are independent sessions. Interrupting a child kills its tool processes and ends its execution with `session.execution.interrupted`.
- A child that finishes or is interrupted enqueues a `synthetic` steer item on its parent, which **starts a new execution on an idle root** and spends money. A hard stop therefore interrupts each running descendant (from `/api/session/active` plus the parent chain), then interrupts the root again, then re-polls and repeats before killing the process group.
- Interrupting a *running* root was not exercised (unverified).

## Slim per-run appends

- `<cwd>/.opencode/oh-my-opencode-slim/<agent>_append.md` (`orchestrator`, `fixer`, `designer`, `oracle`, `explorer`, `librarian`) **replaces** the global one: the first match wins and the global append is skipped. The text lands in the agent's `system` prompt and is re-sent each turn. Surviving compaction is inferred, not tested.
- `<cwd>/.opencode/oh-my-opencode-slim.jsonc` overrides `agents.<name>.{model,variant}`, and accepts `backgroundJobs`, `interview`, `disabled_*` and `acpAgents`. It is merged over the user-level slim config.

## launchd

- A generated plist bootstrapped with `launchctl bootstrap gui/$UID` runs independent of the caller (ppid 1, own process group), which a plain `nohup` child of a tool call does not (the call's process group is killed at its end).
- Keys: `Label`, `ProgramArguments` (absolute caffeinate, node and script paths), `WorkingDirectory`, `RunAtLoad=true`, `KeepAlive=false`, `AbandonProcessGroup=false`, `ProcessType=Interactive`, `EnvironmentVariables` (launchd gives a minimal environment, so pass PATH, HOME and everything serve needs), `StandardOutPath`/`StandardErrorPath`.
- **Serve must be spawned non-detached** (same process group as the orchestrator). With `AbandonProcessGroup=false`, killing the orchestrator then takes serve down within about a second.
- `caffeinate -ims node ...` exec's node, so node is the job's main pid and gets SIGTERM directly. `pmset -g assertions` shows the caffeinate assertions.
- `launchctl kill SIGTERM` reaches node, serve stops, exit 0, no restart. After `bootout` the job disappears only after a few seconds: poll instead of assuming.
- Quitting the real TUI or desktop app was not tested interactively (unverified); the evidence is the job's ppid 1.

## sandbox-exec

- Running the whole `opencode serve` under `sandbox-exec -f <profile>` is viable. A profile of `(allow default)(deny file-write*)` plus a write allowlist (workspace, the run's temp and data dirs, `~/.local/share|state/opencode`, `~/.cache`, `~/.npm`, `~/Library/Caches|Logs`, a few `/dev` nodes) lets startup, model calls, `git fetch` and in-allowlist writes work. Redirects, symlink tricks and interpreter writes outside the allowlist fail with `Operation not permitted`, including the cases a text-based guard cannot see.
- **SBPL limits seen on the host**: path rules are literal or `subpath`/`regex`, not globs, so each allowed directory is its own `subpath`. Credential reads can be denied (`~/.ssh`, `~/.aws`, ...), but `~/.config/opencode` cannot, since the server must read it. Outbound connections can be denied per port (the run port, 22). `(deny process-exec ...)` on `launchctl`, `osascript` and `crontab` holds regardless of the command line.
- `sandbox-exec` is deprecated by Apple but works on current macOS. Tool caches may need more `subpath` entries when a build fails on a denied path (for example `~/.cache/ms-playwright`, node-gyp): widen one `subpath` at a time.
- A fetch-only `GIT_SSH_COMMAND` wrapper plus `pushInsteadOf` to a non-existent transport stops pushes, but `git -c remote.X.pushurl=file://... push` bypasses `pushInsteadOf` for local `file://` remotes. For local bare origins only the profile rules and the guard stop that. Set `GIT_SSH_VARIANT=ssh` (otherwise git sends an `ssh -G` probe that the wrapper blocks noisily) and `SSH_AUTH_SOCK=` empty.

## Desktop app

Whether OpenCode.app can attach to a custom server with a password is unverified. The CLI attaches with `OPENCODE_SERVER_PASSWORD=... opencode --server <url>`, and `POST /api/pair` returns a single-use pairing code (`{code, expires_in}`) for `GET /auth/connect/:code`.
