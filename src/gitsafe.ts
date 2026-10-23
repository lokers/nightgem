/**
 * The one way nightgem runs git OUTSIDE the sandbox (tripwires, report, remote reads, the startup fetch).
 *
 * Why: the sandbox lets agents write anywhere under the workspace root, which includes `<repo>/.git/config`,
 * `.git/info/attributes`, `.git/hooks/` and `.git/modules/*` of every checkout and worktree. Git runs programs named
 * in that config (`core.fsmonitor`, `filter.<d>.clean`, `diff.<d>.textconv`, `remote.<r>.uploadpack`, credential
 * helpers, ...). A plain `git status` from the orchestrator would then run an agent-planted program with full rights.
 *
 * What this does, per call:
 * 1. A trusted environment: no system config, no pager, no prompts, no external diff, an allow-list of transports
 *    (no `ext::`), and a fixed `GIT_SSH_COMMAND` unless the caller sets one (it beats `core.sshCommand`).
 * 2. Fixed `-c` overrides for every program-running setting that has one fixed name (fsmonitor, hooks, pager, ...).
 * 3. Dynamic `-c` overrides: the keys the repo's own config (`local` and `worktree` scope, includes followed) defines
 *    under a driver or remote name (`filter.<d>.*`, `diff.<d>.*`, `merge.<d>.driver`, `pager.<cmd>`, credential
 *    helpers) are read with `git config --list --show-scope -z` (reading config runs nothing) and set back to
 *    the trusted value: the one in the global config, else an inert one. The global `~/.gitconfig` is trusted because
 *    `$HOME` is not writable from the sandbox.
 * 4. Flags right after the subcommand: `--no-ext-diff --no-textconv` (log/diff/show), `--upload-pack=git-upload-pack`
 *    and `--no-recurse-submodules` (fetch/pull), `--upload-pack=...` (ls-remote), `--receive-pack=...` (push).
 *
 * Command-line `-c` (scope `command`) beats every config file and include, so a planted value never wins. The `-c`
 * values travel in `GIT_CONFIG_PARAMETERS`, so git's own child processes (submodule status, `upload-pack` of a local
 * remote) get the fixed overrides too.
 *
 * Residual: the dynamic overrides are computed from the config as read a moment before the command runs, so a writer
 * that changes the config in between is not covered for the name-keyed settings (the fixed ones are not racy).
 */
import { resolve } from 'node:path';

import { execa } from 'execa';

export type GitEnv = Readonly<Record<string, string | undefined>>;

export interface SafeGitOptions {
  cwd: string;
  /** The full environment git runs with (nothing else is inherited). Pass `process.env` for the default behaviour. */
  env: GitEnv;
  timeoutMs?: number;
  /** Default true: a non-zero exit rejects. `false` resolves with the result instead. */
  reject?: boolean;
  /** Default `'pipe'`. */
  stdin?: 'pipe' | 'ignore';
  /** Text written to git's stdin (for example `git credential fill`). */
  input?: string;
  /** Extra variables set last (for example a fetch-only `GIT_SSH_COMMAND`). */
  extraEnv?: Readonly<Record<string, string>>;
}

export interface SafeGitResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  timedOut: boolean;
}

/** Transports a nightgem git call may use. `ext::` and every other remote helper scheme are refused. */
export const ALLOWED_PROTOCOLS = 'file:git:http:https:ssh';

/** Settings with one fixed name that make git run a program (or do something risky) when set in a repo's config. */
export const FIXED_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.askPass', ''],
  ['core.gitProxy', ''],
  ['core.alternateRefsCommand', 'exit 0'],
  ['core.untrackedCache', 'false'],
  ['diff.external', ''],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['protocol.ext.allow', 'never'],
  ['protocol.file.allow', 'user'],
];

/** Only these scopes are trusted: `$HOME` is not writable from the sandbox. Everything else came from a repo. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

const FILTER_RE = /^filter\.(.+)\.(clean|smudge|process|required)$/i;
const DIFF_DRIVER_RE = /^diff\.(.+)\.(textconv|command)$/i;
const MERGE_DRIVER_RE = /^merge\.(.+)\.(driver|recursive)$/i;
const PAGER_RE = /^pager\..+$/i;
const CREDENTIAL_HELPER_RE = /^credential\.(?:.+\.)?helper$/i;

/**
 * Flags that go right after the subcommand. `remote.<r>.uploadpack` / `receivepack` are FIRST-wins in git ("more than
 * one uploadpack given, using the first"), so no `-c` can override a planted one; the command-line option does.
 */
const SUBCOMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  log: ['--no-ext-diff', '--no-textconv'],
  diff: ['--no-ext-diff', '--no-textconv'],
  show: ['--no-ext-diff', '--no-textconv'],
  fetch: ['--no-recurse-submodules', '--upload-pack=git-upload-pack'],
  pull: ['--no-recurse-submodules', '--upload-pack=git-upload-pack'],
  'ls-remote': ['--upload-pack=git-upload-pack'],
  push: ['--receive-pack=git-receive-pack'],
};

interface ConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** Parse `git config --list --show-scope -z`: records are `scope NUL key NL value NUL` (a bare key has no NL). */
export function parseConfigList(out: string): ConfigEntry[] {
  const parts = out.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] as string;
    const kv = parts[i + 1] as string;
    const nl = kv.indexOf('\n');
    entries.push(nl < 0 ? { scope, key: kv, value: '' } : { scope, key: kv.slice(0, nl), value: kv.slice(nl + 1) });
  }
  return entries;
}

/**
 * The extra `[key, value]` overrides for a repo's config entries. Pure. For every program-running key that an
 * untrusted scope (local, worktree) defines, the value is the last trusted one if there is one, else an inert value.
 */
export function dynamicOverrides(entries: readonly ConfigEntry[]): Array<[string, string]> {
  const trusted = entries.filter((e) => TRUSTED_SCOPES.has(e.scope));
  const untrusted = entries.filter((e) => !TRUSTED_SCOPES.has(e.scope));
  const trustedLast = (key: string): string | undefined => {
    const k = key.toLowerCase();
    for (let i = trusted.length - 1; i >= 0; i--) if ((trusted[i] as ConfigEntry).key.toLowerCase() === k) return (trusted[i] as ConfigEntry).value;
    return undefined;
  };
  const out = new Map<string, string>();
  const neutralise = (key: string, inert: string): void => {
    if (!out.has(key)) out.set(key, trustedLast(key) ?? inert);
  };
  let credentialHelperPlanted = false;

  for (const e of untrusted) {
    let m: RegExpExecArray | null;
    if ((m = FILTER_RE.exec(e.key))) {
      const d = m[1] as string;
      neutralise(`filter.${d}.clean`, '');
      neutralise(`filter.${d}.smudge`, '');
      neutralise(`filter.${d}.process`, '');
      neutralise(`filter.${d}.required`, 'false');
    } else if ((m = DIFF_DRIVER_RE.exec(e.key))) {
      const d = m[1] as string;
      neutralise(`diff.${d}.textconv`, '');
      neutralise(`diff.${d}.command`, '');
    } else if ((m = MERGE_DRIVER_RE.exec(e.key))) {
      neutralise(`merge.${m[1] as string}.driver`, '');
    } else if (PAGER_RE.test(e.key)) {
      neutralise(e.key, 'false');
    } else if (CREDENTIAL_HELPER_RE.test(e.key)) {
      credentialHelperPlanted = true;
    }
  }

  const list = [...out];
  if (credentialHelperPlanted) {
    // Helpers accumulate across sections and an empty value resets the whole list: reset, then re-add the trusted ones in order.
    list.push(['credential.helper', '']);
    for (const e of trusted) if (CREDENTIAL_HELPER_RE.test(e.key)) list.push([e.key, e.value]);
  }
  return list;
}

/** The first non-option token of a `git` argument list (skipping `-C <dir>` / `-c <k=v>`), and the effective directory. */
export function inspectArgs(args: readonly string[], cwd: string): { subcommand: string | undefined; subIndex: number; dir: string } {
  let dir = cwd;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-C') {
      dir = resolve(dir, args[i + 1] ?? '.');
      i++;
    } else if (a === '-c' || a === '--exec-path' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      if (a !== '--exec-path') i++;
    } else if (!a.startsWith('-')) {
      return { subcommand: a, subIndex: i, dir };
    }
  }
  return { subcommand: undefined, subIndex: -1, dir };
}

/** The trusted environment git runs with. `GIT_EXTERNAL_DIFF` is removed; a caller-set `GIT_SSH_COMMAND` is kept. */
export function safeEnv(base: GitEnv, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== 'GIT_EXTERNAL_DIFF') env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_ALLOW_PROTOCOL = ALLOWED_PROTOCOLS;
  // GIT_SSH_COMMAND beats core.sshCommand; without it a planted core.sshCommand would run on ls-remote/fetch over ssh.
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = env.GIT_SSH ? shellQuote(env.GIT_SSH) : 'ssh';
  // GIT_PROXY_COMMAND beats every core.gitProxy (including the `<cmd> for <host>` form that `-c core.gitProxy=` cannot override).
  if (env.GIT_PROXY_COMMAND === undefined) env.GIT_PROXY_COMMAND = '';
  Object.assign(env, extra);
  return env;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `-c key=value` arguments. A key holding `=` cannot be written that way and goes through `GIT_CONFIG_COUNT` instead. */
function configArgs(overrides: ReadonlyArray<readonly [string, string]>, env: Record<string, string>): string[] {
  if (overrides.some(([k]) => k.includes('='))) {
    const base = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
    let n = Number.isFinite(base) && base > 0 ? base : 0;
    for (const [k, v] of overrides) {
      env[`GIT_CONFIG_KEY_${n}`] = k;
      env[`GIT_CONFIG_VALUE_${n}`] = v;
      n++;
    }
    env.GIT_CONFIG_COUNT = String(n);
    return [];
  }
  return overrides.flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

/** Run `git <args>` with every program-running setting of the repo neutralised. See the module comment. */
export async function runGitSafe(args: readonly string[], opts: SafeGitOptions): Promise<SafeGitResult> {
  const env = safeEnv(opts.env, opts.extraEnv);
  const timeout = opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {};
  const { subcommand, subIndex, dir } = inspectArgs(args, opts.cwd);

  // Reading config executes nothing. A failure here (corrupt config, no such directory) is a failure of the call.
  const listing = await execa('git', ['-C', dir, ...FIXED_OVERRIDES.flatMap(([k, v]) => ['-c', `${k}=${v}`]), 'config', '--list', '--show-scope', '-z'], {
    cwd: opts.cwd,
    env: { ...env },
    extendEnv: false,
    stdin: 'ignore',
    ...timeout,
  });
  const overrides = [...FIXED_OVERRIDES, ...dynamicOverrides(parseConfigList(String(listing.stdout)))];

  const finalArgs = [...args];
  if (subcommand !== undefined) {
    finalArgs.splice(subIndex + 1, 0, ...(SUBCOMMAND_FLAGS[subcommand] ?? []));
  }
  const cArgs = configArgs(overrides, env);
  const r = await execa('git', [...cArgs, ...finalArgs], {
    cwd: opts.cwd,
    env,
    extendEnv: false,
    reject: opts.reject ?? true,
    ...(opts.input !== undefined ? { input: opts.input } : { stdin: opts.stdin ?? 'pipe' }),
    ...timeout,
  });
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode, timedOut: r.timedOut === true };
}
