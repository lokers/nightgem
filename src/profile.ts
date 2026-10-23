/**
 * Renders the per-run opencode config (permission layers 1-3: profile rules, safety env and tool denies).
 *
 * - `configContent` goes into `OPENCODE_CONFIG_CONTENT` of the serve process: the last-applied, agent-immutable
 *   config layer. It carries `model`, `small_model`, the guard plugin and the ordered permission list.
 * - `slimOverrides` go into `<run>/.opencode/oh-my-opencode-slim.jsonc`.
 * - `readableCopy` goes into `<run>/opencode.json` (a human-readable record; it is also loaded by opencode, but
 *   sits below OPENCODE_CONFIG_CONTENT, and duplicates the identical rules, so it is harmless). It omits `plugins`
 *   so the guard is not loaded twice.
 *
 * Permission format (v2, verified against OpenCode 2.0.29): an ordered list of `{action, resource, effect}`; the LAST matching
 * rule wins; globs support `*` and `?` only (see `cmdAnywhere` for the exact matcher). The list starts with `* * allow` to cancel inherited `ask` rules, so no rule in
 * the result may ever have the effect `ask` (a hung ask would stall an unattended run).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP, CONTROL_DIR_NAME, ENV_PREFIX } from './brand.ts';
import type { PermissionEffect, SafetyInputs } from './contracts.ts';
import { xdgDataHome } from './paths.ts';

export type Rule = { action: string; resource: string; effect: PermissionEffect };

export interface AgentModelOverride {
  model: string;
  variant?: string;
}

export interface RenderRunConfigInput {
  slug: string;
  home: string;
  workspaceRoot: string;
  /** `<specs>/<slug>/.run` (the serve cwd). */
  runDir: string;
  /** `~/Library/Application Support/nightgem/<slug>`. */
  controlDir: string;
  /** The run's own `$TMPDIR`. */
  tmpDir: string;
  /** `providerID/modelID` for the run: the orchestrator and oracle (fixer/designer default to Sonnet, see `defaultAgentModels`). */
  model: string;
  /** `providerID/modelID` for `small_model` and the observer. */
  smallModel: string;
  /** Absolute path of the guard package dir (`profile/guard`). */
  guardDir: string;
  /**
   * Optional per-agent overrides, `agent -> { model: "providerID/modelID", variant? }`, merged over
   * `defaultAgentModels(model, smallModel)` and `DEFAULT_AGENT_VARIANTS` (orchestrator/oracle: model; fixer/designer:
   * sonnet-5-5; explorer/librarian: haiku-5-5; observer: smallModel). An override's variant wins over the default variant;
   * an override without one keeps the default variant of that agent.
   */
  agentModels?: Partial<Record<string, AgentModelOverride>>;
  /**
   * Names of the MCP servers configured in the user's global opencode config (ONLY the key names of its `mcp` object; the
   * wiring must read nothing else from there). Every one is switched off for the run: listed in slim `disabled_mcps` and its
   * tools (`<server>_*`) denied, because a global MCP server (a forge or tracker one, say) would otherwise give a run
   * push / PR / tracker access that the shell denies and the guard never see. Omitted or empty: no server is disabled.
   */
  mcpServerNames?: string[];
  /**
   * File names directly under `<specs>/<slug>/.run/` that agents may edit. Default `DEFAULT_RUN_WRITABLE`
   * (tasks.jsonl, decisions.jsonl, run-complete.json); everything else in `.run/` is denied. Pass `[]` to close it
   * entirely. Must match the guard's NIGHTGEM_RUN_WRITABLE (`buildGuardEnv` uses the same default).
   */
  runDirWritable?: string[];
  /**
   * Profile-derived safety inputs, REQUIRED: the generic defaults plus its lists. Nothing is defaulted for a caller
   * that forgets it, so no renderer can end up weaker than intended. Consumed here for the
   * extra command / shell-pattern / secret-path / edit-path denies, the skill roots (external_directory + the
   * `~/.config/opencode/skills` read carve-out) and the slim `disabled_skills`. `safety.workspaceRoot` must equal `workspaceRoot`.
   */
  safety: SafetyInputs;
}

export interface RenderedRunConfig {
  configContent: {
    model: string;
    small_model: string;
    warming: false;
    plugins: Array<{ package: string }>;
    permissions: Rule[];
    /** One inert, disabled stand-in per MCP server of the user's config; never the server's own definition. Absent when there are none. */
    mcp?: { servers: Record<string, { type: 'local'; command: string[]; disabled: true }> };
  };
  configContentJson: string;
  slimOverrides: SlimOverrides;
  readableCopy: { model: string; small_model: string; warming: false; permissions: Rule[]; mcp?: { servers: Record<string, { type: 'local'; command: string[]; disabled: true }> } };
}

export interface SlimOverrides {
  agents: Record<string, { model: string; variant?: string }>;
  backgroundJobs: {
    maxSessionsPerAgent: number;
    wallClockTimeoutMs: number;
    concurrency: { defaultConcurrency: number };
  };
  interview: { autoOpenBrowser: boolean };
  acpAgents: Record<string, never>;
  disabled_tools: string[];
  disabled_skills: string[];
  disabled_mcps: string[];
}

const rule = (action: string, resource: string, effect: PermissionEffect): Rule => ({ action, resource, effect });

/**
 * How opencode 2.0.29 matches a rule resource (`VN` in the binary; mirrored by `wildcardMatch` in
 * `test/fixtures/profile/fake-run-api.ts` and pinned in `test/profile.test.ts`):
 *  - `*` matches anything, including `/`, spaces and newlines; `?` matches exactly one character;
 *  - a TRAILING ` *` IS OPTIONAL: `jira *` also matches the bare `jira`, and a star-slash-jira-space-star pattern also
 *    matches `ls libs/jira` (the optional tail is what made the old `jira` rules deny a directory listing);
 *  - anchored at both ends, case-sensitive, everything else (`[ ] ( ) | . + ^ $ { }`) literal, `\` read as `/`.
 * So a pattern that starts with a star and a slash matches every path that merely ENDS in that name. Use it only where the name is never a
 * directory worth listing (acli, and the commands of `deny.commands`); other real binaries are matched by the anchored `binaryPathPatterns`.
 */

/** Characters that start a command inside a longer shell string (the `*` before them swallows what precedes). */
const SHELL_LEADS = ['*;', '*&', '*|', '*(', "*'", '*"', '*`', '*\n'] as const;
/** The same separators followed by a space (`a && jira x`, `a; jira x`). A newline (a multi-line command) needs no space after it. */
const SPACED_LEADS = ['*; ', '*& ', '*| ', '*( '] as const;
/** Commands that run their first argument as a command (mirrors WRAPPERS in profile/guard/decide.mjs). */
const WRAPPER_WORDS = ['sudo', 'command', 'builtin', 'time', 'nice', 'nohup', 'exec', 'env', 'xargs', 'stdbuf', 'timeout'] as const;

/**
 * `cmd`, `cmd *`, `cmd` as any argument-like word (`* cmd *`: covers `env cmd`, `sudo cmd`, `xargs cmd`) and `cmd`
 * after every shell separator: globs have no character classes, so spell them out. Does NOT match `a/cmd` (a path).
 */
export function cmdAnywhere(c: string): string[] {
  return [c, `${c} *`, `* ${c} *`, ...SHELL_LEADS.map((l) => `${l}${c} *`)];
}

/**
 * `cmd` only where a command starts: the start of the string, after a shell separator or after a wrapper word. `ls cmd`,
 * `cat libs/cmd/x` and `ls libs/cmd` do not match. For names that are common directory names (`jira`).
 */
export function commandPositionPatterns(c: string): string[] {
  const leads = ['', ...SHELL_LEADS, ...SPACED_LEADS];
  const wrappers = WRAPPER_WORDS.flatMap((w) => [`${w} ${c} *`, `* ${w} ${c} *`]);
  return [...new Set([c, ...leads.map((l) => `${l}${c} *`), ...wrappers])];
}

/**
 * An executable invoked by path (`/opt/homebrew/bin/gh pr`, `~/.claude/local/claude -p`, `bash -lc "/usr/bin/gh x"`).
 * Anchored to a command start so that `ls docs/gh` and `cat src/claude/x.ts` are not caught; relative paths
 * (`node_modules/.bin/gh`) are left to the guard, which compares the command basename.
 */
export function binaryPathPatterns(c: string): string[] {
  const leads = ['', ...SHELL_LEADS, ...SPACED_LEADS];
  const roots = ['/', '~/', '$HOME/', '${HOME}/'];
  return leads.flatMap((l) => roots.map((r) => `${l}${r}*/${c} *`));
}

/** A real binary: the bare word, any word position, after separators, and invoked by absolute path. */
export function denyBinary(c: string): string[] {
  return [...cmdAnywhere(c), ...binaryPathPatterns(c)];
}

/**
 * A long-running flag spelled as its own argument: `--watch`, `--watchAll`, `--watch=true`. `--watch=false` and
 * `--watchAll=false` (what an agent passes to turn watching OFF) are not matched. Globs have only `*`, so the
 * terminators are spelled out.
 */
export function flagPatterns(flag: string): string[] {
  const ends = ['', ' *', ';*', '&*', '|*', ')*', '"*', "'*", '\n*'];
  return [...ends.map((e) => `*${flag}${e}`), `*${flag}=true*`, `*${flag}=1*`, `*${flag}=yes*`];
}

/** Publishing and registry-login commands (no run may publish anything). */
export function publishPatterns(): string[] {
  return [
    '*npm*publish*',
    '*yarn*publish*',
    '*pnpm*publish*',
    '*bun*publish*',
    ...['dist-tag', 'deprecate', 'login', 'adduser'].map((c) => `*npm ${c}*`),
    '*npx np',
    '*npx np *',
    '*npx np@*',
    '*lerna*publish*',
    '*changeset*publish*',
    '*vsce*publish*',
    '*ovsx*publish*',
    '*cargo*publish*',
    '*twine*upload*',
    '*semantic-release*',
    '*goreleaser*',
  ];
}

/** Tools that need a human or reach outside the run: denied in the profile and disabled in slim. */
export const TOOL_DENIES = [
  'question',
  'wait_for_user',
  'interview_submit_state',
  'acp_run',
  'marketplace_*',
] as const;

/**
 * An MCP server name from the user's global opencode config (the keys of its `mcp` object). Plain names only: the name is
 * spelled into a tool-name glob (`<name>_*`), so wildcards and separators are refused. opencode names an MCP tool
 * `<server>_<tool>` with every character outside `[A-Za-z0-9_-]` in the server name replaced by `_`, hence `mcpToolPrefix`.
 */
export function normalizeMcpServerName(raw: string): string {
  const n = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(n)) throw new Error(`Invalid mcpServerNames entry "${raw}" (expected a plain MCP server name)`);
  return n;
}

/** The command of the inert stand-in written over a disabled MCP server; it exits at once and is never the user's command. */
export const INERT_MCP_COMMAND = '/usr/bin/false';

export const mcpToolPrefix = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

/** Distinct, validated `mcpServerNames`. */
export function mcpServerNames(names: readonly string[] | undefined): string[] {
  return [...new Set((names ?? []).map(normalizeMcpServerName))];
}

/** Concrete tool names for slim `disabled_tools` (no wildcards there). */
export const SLIM_DISABLED_TOOLS = [
  'question',
  'wait_for_user',
  'interview_submit_state',
  'acp_run',
  'marketplace_manage',
  'marketplace_inspect',
] as const;

/** The only files in `.specs/<slug>/.run/` agents append to (see the prompts). */
export const DEFAULT_RUN_WRITABLE: readonly string[] = ['tasks.jsonl', 'decisions.jsonl', 'run-complete.json'];

export const SLIM_AGENTS_HEAVY = ['orchestrator', 'oracle', 'fixer', 'designer'] as const;
export const SLIM_AGENTS_LIGHT = ['explorer', 'librarian', 'observer'] as const;

/** Per-agent defaults (the usual slim preset): fixer/designer run on Sonnet, explorer/librarian on Haiku. */
export const DEFAULT_FIXER_MODEL = 'anthropic/claude-sonnet-5-5';
export const DEFAULT_SCOUT_MODEL = 'anthropic/claude-haiku-5-5';

/** Reasoning variants of the default slim preset (`~/.config/opencode/oh-my-opencode-slim.json`, field `variant`). `observer` has none. */
export const DEFAULT_AGENT_VARIANTS: Readonly<Record<string, string>> = {
  orchestrator: 'high',
  oracle: 'xhigh',
  fixer: 'high',
  designer: 'medium',
  explorer: 'low',
  librarian: 'low',
};

/**
 * Default `agent -> providerID/modelID`: orchestrator and oracle run the run `model`; fixer and designer Sonnet; explorer
 * and librarian Haiku; the observer (not in the preset) the `smallModel`. `RenderRunConfigInput.agentModels` overrides any of them.
 */
export function defaultAgentModels(model: string, smallModel: string): Record<string, string> {
  return {
    orchestrator: model,
    oracle: model,
    fixer: DEFAULT_FIXER_MODEL,
    designer: DEFAULT_FIXER_MODEL,
    explorer: DEFAULT_SCOUT_MODEL,
    librarian: DEFAULT_SCOUT_MODEL,
    observer: smallModel,
  };
}

/**
 * Secret locations relative to $HOME (keep in sync with `SECRET_HOME_ROOTS` in profile/guard/secrets.mjs, the guard's
 * obfuscation-aware layer). The profile layer is literal: it only catches the plain `~`, `$HOME`, `${HOME}` and absolute forms.
 */
export const SECRET_HOME_PATHS = [
  '.config/opencode',
  '.local/share/opencode',
  '.ssh',
  '.aws',
  '.config/gcloud',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  '.config/gh',
  '.config/glab-cli',
  '.config/linear',
  'Library/Keychains',
  `Library/Application Support/${CONTROL_DIR_NAME}`,
] as const;

/**
 * A HOME-relative secret path from `deny.secretPaths`: a plain path (no wildcards, no `..`, not absolute), returned
 * without a leading `~/` or a trailing `/`. Throws on anything else so a typo cannot silently widen or drop a deny.
 */
export function normalizeSecretPath(raw: string): string {
  const rel = raw.trim().replace(/^~\//, '').replace(/\/+$/, '');
  if (rel === '' || rel.startsWith('/') || /[*?[\]{}\\\0\n\r]/.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error(`Invalid deny.secretPaths entry "${raw}" (expected a plain HOME-relative path)`);
  }
  return rel;
}

/** The built-in secret paths plus the validated `deny.secretPaths` (deduplicated, built-ins first). */
export function secretHomePaths(safety?: Pick<SafetyInputs, 'deny'>): string[] {
  return [...new Set([...SECRET_HOME_PATHS, ...(safety?.deny.secretPaths ?? []).map(normalizeSecretPath)])];
}

/** Shell resource patterns that mention a secret location, in every plain spelling of $HOME. */
export function secretPathShellPatterns(home: string, secretPaths: readonly string[] = SECRET_HOME_PATHS): string[] {
  return secretPaths.flatMap((rel) => ['~', '$HOME', '${HOME}', home].map((h) => `*${h}/${rel}*`));
}

/**
 * Normalisation of the free-form `deny` lists, in ONE place (used by `buildPermissions`, `shellDenyPatterns`, `guardSafetyPayload`
 * and `deriveProbes`, so the profile, the guard and the probes cannot disagree):
 *  - a relative edit glob (`vendored/**`) becomes `**` + `/` + the glob, because opencode matches the absolute path;
 *  - a shell pattern without wildcard (`internal-sync`) becomes `*internal-sync*`, the substring meaning the guard already has.
 * Blank entries are dropped; the result is deduplicated.
 */
export function normalizeEditPath(raw: string): string {
  const g = raw.trim();
  return g.startsWith('/') || g.startsWith('*') ? g : `**/${g}`;
}

export function normalizeShellPattern(raw: string): string {
  const p = raw.trim();
  return /[*?]/.test(p) ? p : `*${p}*`;
}

export function normalizeDeny(deny: SafetyInputs['deny']): SafetyInputs['deny'] {
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  return {
    commands: uniq(deny.commands.map(normalizeDeniedCommand)),
    shellPatterns: uniq(deny.shellPatterns.filter((p) => p.trim() !== '').map(normalizeShellPattern)),
    secretPaths: uniq(deny.secretPaths.map(normalizeSecretPath)),
    editPaths: uniq(deny.editPaths.filter((g) => g.trim() !== '').map(normalizeEditPath)),
  };
}

/** Distinct, trimmed, non-empty `disabledSkills`: the one list behind slim's `disabled_skills` and the `skill` deny rules. */
export function disabledSkillNames(safety: Pick<SafetyInputs, 'disabledSkills'>): string[] {
  return [...new Set(safety.disabledSkills.map((n) => n.trim()).filter(Boolean))];
}

/** A command name from `deny.commands`: one plain word (no path, no glob), so it can be spelled into the patterns safely. */
export function normalizeDeniedCommand(raw: string): string {
  const c = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(c)) throw new Error(`Invalid deny.commands entry "${raw}" (expected a plain command name)`);
  return c;
}

/**
 * Generic defaults: common third-party CLIs a run must not drive. Forge CLIs and agent runners are denied wherever
 * they appear as a command word; the issue-tracker CLIs `jira` and `linear` only in command position, because those are
 * also common directory names (`ls libs/jira`). `acli` additionally matches as a path suffix (see `shellDenyPatterns`).
 * Anything specific to one user's tooling comes in through `SafetyInputs.deny` instead.
 */
export const DEFAULT_DENIED_COMMANDS = ['gh', 'glab', 'opencode', 'claude', 'cursor-agent', 'codex', 'aider'] as const;
export const DEFAULT_DENIED_TRACKER_BINARIES = ['acli'] as const;
export const DEFAULT_DENIED_COMMAND_HEADS = ['jira', 'linear'] as const;

/** The only skills subtree inside a secret root that runs may read; `deny.secretPaths` cannot widen it. */
export const SKILLS_CARVE_OUT = '.config/opencode/skills';

const EMPTY_DENY: SafetyInputs['deny'] = { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] };

const isUnder = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`);

export interface SkillRootAccess {
  /** Roots the run may enter (`external_directory` allow `<root>/**`). */
  external: string[];
  /** Roots below the `~/.config/opencode/skills` carve-out: read/grep/glob are allowed there although the parent is a secret root. */
  carveOuts: string[];
}

/**
 * Classifies `SafetyInputs.skillRoots`. A root is dropped (fail closed) when it is not an absolute plain path, is `/`,
 * `$HOME` or an ancestor of it, or overlaps a secret location (inside it or an ancestor of it) other than through the skills carve-out.
 */
export function skillRootAccess(home: string, skillRoots: readonly string[], secretPaths: readonly string[]): SkillRootAccess {
  const carve = `${home}/${SKILLS_CARVE_OUT}`;
  const secrets = secretPaths.map((rel) => `${home}/${rel}`);
  const out: SkillRootAccess = { external: [], carveOuts: [] };
  const parentSecret = `${home}/.config/opencode`;
  const overlaps = (root: string, ignore?: string): boolean => secrets.some((x) => x !== ignore && (isUnder(root, x) || isUnder(x, root)));
  for (const raw of skillRoots) {
    const root = raw.replace(/\/+$/, '');
    if (!root.startsWith('/') || /[*?[\]{}\0\n\r]/.test(root) || root.split('/').includes('..')) continue;
    if (isUnder(home, root)) continue; // `/`, $HOME and its ancestors
    if (isUnder(root, carve)) {
      // the one allowed overlap with a secret root is the opencode config dir itself; any other secret path in the way wins
      if (overlaps(root, parentSecret)) continue;
      out.carveOuts.push(root);
      out.external.push(root);
      continue;
    }
    if (overlaps(root)) continue; // inside a secret location, or an ancestor of one (`~/.config`)
    out.external.push(root);
  }
  out.external = [...new Set(out.external)];
  out.carveOuts = [...new Set(out.carveOuts)];
  return out;
}

/** The explicit `workspaceRoot` and `safety.workspaceRoot` must name the same directory (a trailing slash is tolerated). */
export function assertSameWorkspace(workspaceRoot: string, safety?: SafetyInputs): void {
  if (safety && safety.workspaceRoot.replace(/\/+$/, '') !== workspaceRoot.replace(/\/+$/, '')) {
    throw new Error(`safety.workspaceRoot (${safety.workspaceRoot}) does not match workspaceRoot (${workspaceRoot})`);
  }
}

const ENV_READERS = ['cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'rg', 'sed', 'awk', 'source', '.', 'jq', 'nl', 'xxd', 'od', 'strings', 'base64'];
const ENV_READER_PREFIXES = ['', '*; ', '*&& ', '*|| ', '*| ', '*(', '*`', "*'", '*"', '*\n'];

/** `cat .env`, `grep K .env`, `. ./.env`, ... (also after a shell separator). */
export function envReaderPatterns(): string[] {
  return ENV_READERS.flatMap((r) => ENV_READER_PREFIXES.flatMap((pre) => [`${pre}${r} *.env`, `${pre}${r} *.env *`]));
}

/** Shell resource patterns that must resolve to deny. */
export function shellDenyPatterns(home?: string, safety?: SafetyInputs): string[] {
  const deny = normalizeDeny(safety?.deny ?? EMPTY_DENY);
  const extraCommands = deny.commands;
  return [
    // push in every form, and the transports behind it
    '*git*push*',
    '*receive-pack*',
    '*send-pack*',
    // git config / transport overrides
    '*git*-c remote.*',
    '*git*-c url.*',
    '*git*-c core.sshCommand*',
    '*git*-c credential.*',
    '*git*--config-env*',
    '*GIT_CONFIG*',
    '*GIT_SSH*',
    '*git config --global*',
    // git stash: refs/stash is shared across linked worktrees and trips the stash-count tripwire (the guard parses argv;
    // this glob cannot, so it also denies paths like `.../stash-ui/...`: the launcher rejects such slugs)
    '*git*stash*',
    '*git*-c alias.*',
    // common third-party CLIs that must not be driven from inside a run: forge CLIs and agent runners (DEFAULT_DENIED_COMMANDS)
    ...DEFAULT_DENIED_COMMANDS.flatMap(denyBinary),
    // issue-tracker CLIs that are installed and logged in on the host. `*/acli` deliberately matches any path
    // ending in the name (a directory called acli is not a real case).
    ...DEFAULT_DENIED_TRACKER_BINARIES.flatMap((c) => [...cmdAnywhere(c), `*/${c}`, `*/${c} *`, `* ${c}`]),
    // `jira` and `linear` are common directory names (`ls libs/jira`): only the command-position forms, never a path ending in it
    ...DEFAULT_DENIED_COMMAND_HEADS.flatMap((c) => [...commandPositionPatterns(c), ...binaryPathPatterns(c)]),
    // deny.commands from the user profile: same treatment as the forge CLIs above, plus the relative-path form (`./bin/c x`,
    // `node_modules/.bin/c x`, `../c x`): `*/c *` also matches a bare `*/c` because the trailing ` *` is optional
    ...extraCommands.flatMap((c) => [...denyBinary(c), `*/${c} *`]),
    // host control
    ...['security', 'launchctl', 'osascript', 'crontab'].flatMap(denyBinary),
    '*npm * -g*',
    '*npm * --global*',
    ...publishPatterns(),
    ...denyBinary('brew'),
    // cloud / k8s CLIs
    ...['aws', 'gcloud', 'gsutil', 'az', 'kubectl', 'docker', 'helm', 'argocd', 'terraform'].flatMap(denyBinary),
    // remote shells (the ssh wrapper only covers git)
    ...['ssh', 'scp', 'sftp', 'rsync'].flatMap(denyBinary),
    // anything that never terminates
    ...flagPatterns('--watch'),
    ...flagPatterns('--watchAll'),
    '*npm run dev*',
    '*npm run start*',
    '*npm run serve*',
    '*nx serve*',
    // code from the network / encoded into a shell
    '*curl * | *sh*',
    '*curl * | *bash*',
    '*wget * | *sh*',
    '*wget * | *bash*',
    '*base64*|*sh*',
    // eval is a shell builtin: no path form
    ...cmdAnywhere('eval'),
    // secrets via shell: `.env` as the operand of a reader (naming it, `ls .env*`, `cp .env.example .env` and
    // `echo .env >> .gitignore` stay possible; the guard checks the exact operand roles)
    ...envReaderPatterns(),
    '*.env.local*',
    '*.env.production*',
    '*.env.development*',
    '*printenv*',
    'env',
    'env | *',
    '*; env',
    '*; env | *',
    '*&& env',
    '*&& env | *',
    'export',
    'export -p*',
    '*; export -p*',
    '*&& export -p*',
    'set',
    'set | *',
    '*; set',
    '*&& set',
    'declare -p*',
    'declare -x*',
    'declare',
    'typeset -p*',
    'typeset -x*',
    'compgen -e*',
    'compgen -v*',
    '*OPENCODE_SERVER_PASSWORD*',
    '*OPENCODE_PASSWORD*',
    // secret locations via shell (the guard handles obfuscated spellings)
    '*/.config/opencode*',
    '*/.local/share/opencode*',
    '*/.ssh/*',
    '*/.ssh',
    '*/.aws/*',
    '*/.kube/*',
    '*/.config/gcloud*',
    '*/.config/gh/*',
    '*/.config/glab-cli*',
    '*/.config/linear*',
    '*Library/Keychains*',
    `*Library/Application Support/${CONTROL_DIR_NAME}*`,
    // NOTE: these also block shell access to ~/.config/opencode/skills (the secret root contains it). Only the
    // read/grep/glob tools get the skills carve-out; a skill's files are reachable through those.
    ...(home ? secretPathShellPatterns(home, secretHomePaths(safety)) : []),
    // deny.secretPaths from the user profile, also without a HOME spelling (`cd ~ && cat .corp/token` is the guard's job).
    // `*/rel *` covers the path followed by more words (`ls /Users/bob/rel | head`); it does not match a sibling `rel-x`
    ...deny.secretPaths.flatMap((rel) => [`*/${rel}`, `*/${rel}/*`, `*/${rel} *`]),
    // deny.shellPatterns from the user profile, raw (opencode wildcard syntax)
    ...deny.shellPatterns,
  ];
}

export function buildPermissions(i: Pick<RenderRunConfigInput, 'slug' | 'home' | 'workspaceRoot' | 'tmpDir' | 'runDirWritable' | 'safety' | 'mcpServerNames'>): Rule[] {
  assertSameWorkspace(i.workspaceRoot, i.safety);
  const secretPaths = secretHomePaths(i.safety);
  const skills = skillRootAccess(i.home, i.safety.skillRoots, secretPaths);
  const specDir = `${i.workspaceRoot}/.specs/${i.slug}`;
  const r: Rule[] = [rule('*', '*', 'allow')];

  // read: .env secrets (re-assert, because `* * allow` above cancels inherited rules); examples stay readable
  r.push(rule('read', '*.env', 'deny'), rule('read', '*.env.*', 'deny'));
  for (const ok of ['*.env.example', '*.env.defaults', '*.env.cursor.example', '*.env.sample', '*.env.template', '*.env.dist']) r.push(rule('read', ok, 'allow'));

  // read/grep/glob: the user's secret locations (second layer next to external_directory)
  for (const rel of secretPaths) {
    for (const action of ['read', 'grep', 'glob']) r.push(rule(action, `${i.home}/${rel}`, 'deny'), rule(action, `${i.home}/${rel}/*`, 'deny'));
  }

  // ... except the run's own truncated tool output, which lives below the (otherwise denied) control dir
  const toolOutput = join(xdgDataHome(i.slug, i.home), 'opencode', 'tool-output');
  for (const action of ['read', 'grep', 'glob']) r.push(rule(action, toolOutput, 'allow'), rule(action, `${toolOutput}/*`, 'allow'));

  // ... and the skills subtree of the opencode config dir: read-only, exactly `~/.config/opencode/skills/**` (a root
  // listed in `skillRoots`). `opencode.json`, `service.json` and the rest of `.config/opencode` stay denied above. A `..` in
  // the resource could climb out of the carve-out (the evaluator matches the raw string), so it is denied again after the
  // allows, and the `.env` denies are re-asserted (the allows come after them).
  for (const root of skills.carveOuts) {
    for (const action of ['read', 'grep', 'glob']) r.push(rule(action, root, 'allow'), rule(action, `${root}/*`, 'allow'), rule(action, `${root}/*..*`, 'deny'));
  }
  // scoped to the carve-out: the global `read *.env` denies come BEFORE the example allows, and re-pushing them globally here would
  // shadow `.env.example` / `.env.defaults` everywhere
  for (const root of skills.carveOuts) r.push(rule('read', `${root}/*.env`, 'deny'), rule('read', `${root}/*.env.*`, 'deny'));

  for (const p of shellDenyPatterns(i.home, i.safety)) r.push(rule('shell', p, 'deny'));

  for (const t of TOOL_DENIES) r.push(rule(t, '*', 'deny'));
  // every MCP server of the user's global config: its tools are `<server>_<tool>`
  for (const name of mcpServerNames(i.mcpServerNames)) r.push(rule(`${mcpToolPrefix(name)}_*`, '*', 'deny'));

  // config-level skill denies, next to slim's `disabled_skills` (the evaluator knows a `skill` action: verified live on 2.0.29)
  for (const name of disabledSkillNames(i.safety)) r.push(rule('skill', name, 'deny'));

  // edit: deny everything, allow worktrees / spec dir / tmp, then protect the control files again
  r.push(rule('edit', '*', 'deny'));
  for (const g of [`${i.workspaceRoot}/*/.worktrees/${i.slug}/**`, `${specDir}/**`, `${i.tmpDir}/**`]) r.push(rule('edit', g, 'allow'));
  for (const g of [
    '**/SPEC.md',
    '**/RUN.json',
    // the whole run dir: RUN.json, opencode.json, .opencode/**, the *.jsonl ledgers, logs (orchestrator-owned)
    `${specDir}/.run/**`,
    '**/.run/.opencode/**',
    '**/.run/opencode.json',
    // slim and opencode walk every ancestor of the run dir for config: keep those unwritable
    `${specDir}/.opencode/**`,
    `${specDir}/opencode.json*`,
    `${i.workspaceRoot}/.specs/.opencode/**`,
    `${i.workspaceRoot}/.specs/opencode.json*`,
    `${i.workspaceRoot}/.opencode/**`,
    `${i.workspaceRoot}/opencode.json*`,
    // deny.editPaths from the user profile (globs, e.g. generated code or API specs)
    ...normalizeDeny(i.safety.deny).editPaths,
  ]) {
    r.push(rule('edit', g, 'deny'));
  }
  // the only agent-writable files inside .run/ (RUN.json, cost.jsonl, events.jsonl, logs, config stay denied).
  // Two spellings of each: opencode hands the edit/write tools' `edit` rule a path RELATIVE to the session directory when
  // the file is inside it (`FileAccess.resolve` in 2.0.29), and every session runs with cwd `.run`, so the real resource is
  // `tasks.jsonl`, not the absolute path (the root cause of an earlier refusal: the absolute allow never matched, `edit *` deny won).
  // Files outside `.run` (PLAN.md, worktrees) keep arriving as absolute paths. A bare name matches only that exact name:
  // `sub/tasks.jsonl`, `tasks.jsonl.bak` and `RUN.json` stay denied by `edit * deny`.
  for (const name of i.runDirWritable ?? DEFAULT_RUN_WRITABLE) {
    if (/[/*?\\]/.test(name) || name === 'RUN.json' || name === 'opencode.json') throw new Error(`Invalid runDirWritable entry "${name}"`);
    r.push(rule('edit', `${specDir}/.run/${name}`, 'allow'), rule('edit', name, 'allow'));
  }

  // external directories
  r.push(rule('external_directory', '*', 'deny'));
  for (const g of [`${i.workspaceRoot}/**`, `${i.tmpDir}/**`, ...skills.external.map((root) => `${root}/**`), `${toolOutput}/**`]) {
    r.push(rule('external_directory', g, 'allow'));
  }
  return r;
}

export function renderRunConfig(i: RenderRunConfigInput): RenderedRunConfig {
  const permissions = buildPermissions(i);
  // The user's MCP servers are switched off at the source (live-checked on 2.0.29, docs/opencode-notes.md): a stand-in entry
  // per name in `mcp.servers` merges over the user's own definition. A partial `{ disabled: true }` is dropped as invalid
  // (type and command are required), so the stand-in is `{ type: 'local', command: [INERT_MCP_COMMAND], disabled: true }`: it
  // replaces the user's command, never copies it, and nothing of the definition (command, url, headers, environment) is
  // read or written. The `<server>_*` tool denies in `permissions` and slim's `disabled_mcps` stay as defence in depth.
  const mcpNames = mcpServerNames(i.mcpServerNames);
  const configContent: RenderedRunConfig['configContent'] = {
    model: i.model,
    small_model: i.smallModel,
    // spend from "transient model requests" is not attributable to any session (docs/opencode-notes.md): keep off
    warming: false as const,
    plugins: [{ package: i.guardDir }],
    permissions,
    ...(mcpNames.length > 0 ? { mcp: { servers: Object.fromEntries(mcpNames.map((n) => [n, { type: 'local' as const, command: [INERT_MCP_COMMAND], disabled: true as const }])) } } : {}),
  };

  const models = defaultAgentModels(i.model, i.smallModel);
  const overrides = i.agentModels ?? {};
  const agents: SlimOverrides['agents'] = {};
  for (const [a, m] of Object.entries(models)) {
    const o = overrides[a];
    const variant = o?.variant || DEFAULT_AGENT_VARIANTS[a];
    agents[a] = variant ? { model: o?.model ?? m, variant } : { model: o?.model ?? m };
  }
  for (const [a, o] of Object.entries(overrides)) {
    if (!o || a in agents) continue;
    agents[a] = o.variant ? { model: o.model, variant: o.variant } : { model: o.model };
  }

  const slimOverrides: SlimOverrides = {
    agents,
    backgroundJobs: {
      maxSessionsPerAgent: 4,
      wallClockTimeoutMs: 7_200_000,
      concurrency: { defaultConcurrency: 4 },
    },
    interview: { autoOpenBrowser: false },
    acpAgents: {},
    disabled_tools: [...SLIM_DISABLED_TOOLS],
    disabled_skills: disabledSkillNames(i.safety),
    disabled_mcps: mcpNames,
    // council stays off by omission: no `council` key (its presets are required for it to exist)
  };

  const { plugins: _plugins, ...rest } = configContent;
  void _plugins;
  return {
    configContent,
    configContentJson: JSON.stringify(configContent),
    slimOverrides,
    readableCopy: rest,
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const RUN_FILE_MODE = 0o444;

function writeReadOnly(file: string, content: string): void {
  if (existsSync(file)) chmodSync(file, 0o644);
  writeFileSync(file, content, { mode: 0o644 });
  chmodSync(file, RUN_FILE_MODE);
}

export interface WrittenRunFiles {
  opencodeJson: string;
  slimJsonc: string;
  appends: string[];
}

/**
 * Write `<runDir>/opencode.json` and `<runDir>/.opencode/oh-my-opencode-slim.jsonc` (both 0444). When `appendsDir` is
 * given, every `*_append.md` in it is copied to `<runDir>/.opencode/oh-my-opencode-slim/` (also 0444).
 */
export function writeRunDirFiles(runDir: string, rendered: RenderedRunConfig, appendsDir?: string): WrittenRunFiles {
  const dotOpencode = join(runDir, '.opencode');
  mkdirSync(dotOpencode, { recursive: true });
  const opencodeJson = join(runDir, 'opencode.json');
  const slimJsonc = join(dotOpencode, 'oh-my-opencode-slim.jsonc');
  writeReadOnly(opencodeJson, `${JSON.stringify(rendered.readableCopy, null, 2)}\n`);
  writeReadOnly(
    slimJsonc,
    `// Generated by ${APP}. Read-only. Do not edit.\n${JSON.stringify(rendered.slimOverrides, null, 2)}\n`,
  );
  const appends: string[] = [];
  if (appendsDir) {
    const dest = join(dotOpencode, 'oh-my-opencode-slim');
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(appendsDir).filter((f) => f.endsWith('_append.md')).sort()) {
      const target = join(dest, name);
      if (existsSync(target)) chmodSync(target, 0o644);
      copyFileSync(join(appendsDir, name), target);
      chmodSync(target, RUN_FILE_MODE);
      appends.push(target);
    }
  }
  return { opencodeJson, slimJsonc, appends };
}

// ---------------------------------------------------------------------------
// Environment helpers for the serve process (consumed by the run server)
// ---------------------------------------------------------------------------

export interface GuardEnvInput {
  slug: string;
  workspaceRoot: string;
  controlDir: string;
  tmpDir: string;
  port?: number;
  /** Same list (and default) as `RenderRunConfigInput.runDirWritable`. */
  runDirWritable?: string[];
  /**
   * REQUIRED. Becomes `NIGHTGEM_SAFETY` (JSON; read by `configFromEnv` in profile/guard/config.mjs): the deny lists and the skill
   * roots. `safety.workspaceRoot` must equal `workspaceRoot` (the write roots above are derived from `workspaceRoot`).
   */
  safety: SafetyInputs;
}

/** The part of `SafetyInputs` the guard needs, validated and normalised (the value of `NIGHTGEM_SAFETY`). */
export function guardSafetyPayload(safety: SafetyInputs): { skillRoots: string[]; deny: SafetyInputs['deny'] } {
  return { skillRoots: [...safety.skillRoots], deny: normalizeDeny(safety.deny) };
}

/** Env names read by `profile/git-ssh-fetch-only.sh` (the script keeps the literals; a test checks they agree). */
export const SSH_LOG_ENV = `${ENV_PREFIX}SSH_LOG`;
export const SSH_REAL_ENV = `${ENV_PREFIX}SSH_REAL`;

/** Env read by `profile/guard/index.mjs`. Allowed roots may contain `*` (one path segment). */
export function buildGuardEnv(i: GuardEnvInput): Record<string, string> {
  const roots = [`${i.workspaceRoot}/*/.worktrees/${i.slug}`, `${i.workspaceRoot}/.specs/${i.slug}`, i.tmpDir];
  const env: Record<string, string> = {
    [`${ENV_PREFIX}CONTROL_DIR`]: i.controlDir,
    [`${ENV_PREFIX}ALLOWED_WRITE_ROOTS`]: roots.join(':'),
  };
  if (i.port !== undefined) env[`${ENV_PREFIX}RUN_PORT`] = String(i.port);
  env[`${ENV_PREFIX}RUN_WRITABLE`] = (i.runDirWritable ?? DEFAULT_RUN_WRITABLE).join(':');
  assertSameWorkspace(i.workspaceRoot, i.safety);
  env[`${ENV_PREFIX}SAFETY`] = JSON.stringify(guardSafetyPayload(i.safety));
  return env;
}

export interface SafetyEnvInput {
  /** Absolute path of `profile/git-ssh-fetch-only.sh`. */
  sshWrapper: string;
  /** `url.nopush://.pushInsteadOf` values: remote URL prefixes whose pushes are rewritten to `nopush://` (defaults plus the computed ones). */
  pushInsteadOf?: string[];
  /** `url.nopush://.insteadOf` values: the exact explicit `pushurl`s (git ignores `pushInsteadOf` for a remote that has one). */
  insteadOf?: string[];
  sshLog?: string;
}

export const DEFAULT_NOPUSH_PREFIXES = ['git@github.com:', 'ssh://git@github.com/', 'https://github.com/'];

/** No push capability in the server env (credentials, ssh, pushInsteadOf). */
export function buildSafetyEnv(i: SafetyEnvInput): Record<string, string> {
  const pushInsteadOf = [...new Set(i.pushInsteadOf ?? DEFAULT_NOPUSH_PREFIXES)];
  const insteadOf = [...new Set(i.insteadOf ?? [])];
  const rules: Array<[string, string]> = [
    ...pushInsteadOf.map((p): [string, string] => ['url.nopush://.pushInsteadOf', p]),
    ...insteadOf.map((u): [string, string] => ['url.nopush://.insteadOf', u]),
  ];
  const env: Record<string, string> = {
    GIT_SSH_COMMAND: i.sshWrapper,
    GIT_SSH_VARIANT: 'ssh',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GH_TOKEN: 'invalid',
    GITHUB_TOKEN: 'invalid',
    SSH_AUTH_SOCK: '',
    GIT_CONFIG_COUNT: String(rules.length + 1),
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
  rules.forEach(([key, value], idx) => {
    env[`GIT_CONFIG_KEY_${idx + 1}`] = key;
    env[`GIT_CONFIG_VALUE_${idx + 1}`] = value;
  });
  if (i.sshLog) env[SSH_LOG_ENV] = i.sshLog;
  return env;
}
