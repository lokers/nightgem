# Security policy

nightgem launches unattended, budget-capped OpenCode runs that can read and write code on your Mac. A hole in its safety layers is a security issue, so we want to hear about it.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |
| anything older | no |

nightgem is experimental. Only the latest 0.1.x release gets fixes. It is tested against OpenCode 2.0.29 and oh-my-opencode-slim 3.x; other versions are best effort.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

1. Preferred: use GitHub's private vulnerability reporting. Go to the [Security tab of `lokers/nightgem`](https://github.com/lokers/nightgem/security) and choose "Report a vulnerability".
2. Fallback: email `lokers@gmail.com` with the subject "nightgem security".

Include what you can: the nightgem commit or version, your macOS, Node and OpenCode versions, the profile settings that matter (redact secrets), and the smallest steps that reproduce it. A failing probe for `profile/corpus.txt` or a failing test is the best possible report.

This is a one-person, spare-time project. Expect an acknowledgement within about 7 days and a status update within about 30 days. Please give us a reasonable chance to fix the problem before you disclose it. We are happy to credit you in the fix, unless you prefer not to be named.

## Threat model summary

nightgem assumes the model driving a run is **well-intentioned but fallible**: it can be confused, can follow a bad instruction found in a repo or web page, and can run a command it should not. It does not assume a determined attacker who controls the model and has unlimited time. Safety is layered so that no single glob or rule has to be perfect.

### What the layers are meant to stop

- **Pushing code.** There is no push capability in the run's environment: a fetch-only ssh wrapper, `pushInsteadOf` rewrites to a transport that does not exist, no credential helper, no tokens, and no ssh agent. The kernel sandbox makes `~/.ssh` unreadable and refuses outbound port 22. The permission profile and the guard plugin also deny `git push`, `git stash`, forge and tracker CLIs and package publishing.
- **Writes outside the workspace.** The OpenCode server runs under `sandbox-exec` with `(deny file-write*)` and an allowlist (the workspace root, the run's temp and data dirs, tool caches). The permission profile only allows edits in the task worktrees and the run's own directories, and the guard checks write targets on symlink-resolved paths.
- **Reads of common secret locations.** The sandbox denies reads of credential locations the server does not need (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.netrc`, `~/.git-credentials`, keychains, and any `deny.secretPaths` you add). The guard refuses shell commands and `read`/`grep`/`glob` inputs that reference them, and `.env` files.
- **Overspending.** A cost ledger sums OpenCode's reported session cost, stops dispatching new work at 85% of the budget, and aborts every session at 100%.
- **Silent changes to your checkouts.** Tripwires check HEAD, branch, working-tree status and the stash count of every repo under the workspace every 5 minutes, and end the run on any change. Unattended permission rules are never `ask`.

A preflight check at every launch evaluates a probe corpus, and a canary proves that the guard, the sandbox and the environment layers actually hold. A launch is refused if any forbidden operation succeeds.

### Residual risks (read these before you trust it)

These are documented in the README and are **not** considered vulnerabilities, because they are known limits of the design:

- **Your provider API key is not protected by the kernel.** The sandbox blocks writes, not reads, of `~/.config/opencode`, because the server itself must read it. The guard refuses obvious references to it, but that is a text and path check, not a boundary. Bypasses include writing a script and then running it, and interpreter code that builds a path at run time. **Network egress is open**, so anything an agent can read it can also send out. Use a dedicated, spend-capped API key for overnight runs.
- **Command denials are textual.** A command built at run time, a script that is written and then run, or a git alias defined in a config file the guard does not read can slip past the guard. The kernel layers still hold for the dangerous ones (ssh has no key and no route), but `git stash`, `docker`, `brew`, cloud CLIs and similar have no kernel layer.
- **The workspace root is writable as a whole.** An agent could in principle modify another checkout under it. The permission rules, the guard and the tripwires detect or block this; the kernel does not.
- **The run server password is in the shell environment.** The sandbox network deny and a guard rule are the mitigations.
- **Host-control CLIs** (`launchctl`, `osascript`, `crontab`) are refused by all three layers, but another binary that talks to launchd (`open`, `at`) is not covered.
- **`sandbox-exec` is deprecated by Apple.** It works on current macOS. A future macOS may remove it, and launches will then be refused.
- **Cost is an estimate.** Overshoot at the hard stop is bounded, not zero, and some spend (an aborted stream, `webfetch` calls with a prompt) can go unrecorded.

nightgem does not make an unattended AI agent safe to point at a machine that holds data you cannot afford to lose. Run it on a machine and account where you could live with the worst case, keep backups, and read the morning report before you use anything it built.

## Scope

**In scope** (please report):

- A way for an agent in a run to push code, publish a package or reach a forge or tracker, that the documented layers should have stopped.
- A write outside the allowed paths, or a read of a protected secret location, that the sandbox or guard should have refused.
- A guard or profile bypass that is not already listed under residual risks, especially one with a working command line.
- A way to overspend a budget by more than the documented overshoot.
- A flaw in `install` / `uninstall` that overwrites or deletes a file nightgem does not own, or in the workspace-root and skill-root validation that widens the sandbox.
- Leaking the run server password, an API key or other secrets into logs, reports, the event stream or files that are committed.
- A way for content in a repo, a spec or a web page to turn into code execution outside the sandbox on the host.

**Out of scope:**

- The residual risks listed above, unless you found a new way to exploit them that is cheaper than described.
- Vulnerabilities in OpenCode, oh-my-opencode-slim, Node, macOS or your model provider. Report those upstream.
- Behaviour you get after turning a safety layer off yourself (for example with test-only environment variables) or after editing the generated run files.
- Attacks that need prior local code execution as your user outside a run.
- Model mistakes that stay inside the rules (bad code, a wrong design, wasted spend below the budget).
- Missing hardening for platforms other than macOS.
- Reports from automated scanners with no demonstrated impact.
