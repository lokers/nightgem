/**
 * `doctor`: environment checks run before `launch`. Hard failures block the launch.
 */
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';

import { CLI_BIN_PATH, cliInvocation, type DoctorCheck, type ExecFn } from './cli-deps.ts';
import type { RunContextSnapshot } from './contracts.ts';
import { detectSkills, type SkillDetectionResult, type SkillsFs } from './skills.ts';
import { loadProfile, ProfileError, resolveProfilePath, type LoadedProfile, type ProfileEnv, type ProfileFs } from './userprofile.ts';

export type { DoctorCheck } from './cli-deps.ts';

export const EXPECTED_OPENCODE_VERSION = '2.0.29';
export const MIN_FREE_GB = 20;
/** The oh-my-opencode-slim major the run config and prompts are written for. */
export const EXPECTED_SLIM_MAJOR = 3;
export const SLIM_PACKAGE = 'oh-my-opencode-slim';
/** The command that creates the starter profile, with the real invocation of this checkout's CLI. */
export const installHint = (nodePath?: string): string => `${cliInvocation(nodePath)} install --workspace <dir>`;
export const SKILLS_HINT = 'npx skills add addyosmani/agent-skills';

export interface DoctorFs {
  exists(path: string): boolean;
  /** File contents, or undefined when it cannot be read. Needed for the toolchain check (package.json scripts). */
  readText?(path: string): string | undefined;
  /** Resolve symlinks. Needed for the `cli on PATH` check; without it a path stands for itself. */
  realpath?(path: string): string | undefined;
}

export interface DoctorOptions {
  exec: ExecFn;
  fs: DoctorFs;
  /** Absolute node path launchd will run. Default `process.execPath`. */
  nodePath?: string;
  /**
   * Directory whose free space is checked: the workspace root. Optional: defaults to `runContext.workspaceRoot`. With neither
   * (no profile), "free disk" FAILs instead of crashing.
   */
  workspaceRoot?: string;
  /** The resolved run context, when there is one. */
  runContext?: RunContextSnapshot;
  /**
   * Why there is no run context (`resolveRunContext` threw). A `ProfileError` becomes the one `profile` FAIL with the install
   * hint (the preflight's own profile check, same name, is then dropped); anything else becomes a `run context` FAIL.
   */
  runContextError?: Error;
  lockIsFree?: () => Promise<boolean>;
  /** Spec repos of the run to launch. When given, each repo's verify tools are checked (warnings only). */
  specRepos?: ReadonlyArray<{ name: string; path: string }>;
  /**
   * The environment of the user's shell. When given, the soft `cli on PATH` check resolves `nightgem` on ITS `PATH`
   * (not the launchd job PATH). Without it the check is skipped.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Absolute `bin/nightgem.mjs` of this checkout, compared with what `nightgem` on the PATH resolves to. Default: this checkout's. */
  cliBinPath?: string;
  /** The PATH the job will run with (NOT the caller's). Required with `specRepos`. */
  jobPath?: string;
  /** Profile `repos` (name -> tools). A repo listed here is checked for these tools in addition to the generic defaults. */
  repoTools?: Readonly<Record<string, { tools: readonly string[] }>>;
  preflight?: () => Promise<DoctorCheck[]>;
}

export interface DoctorResult {
  checks: DoctorCheck[];
}

/** True when any failing check is hard. */
export function hasHardFailure(result: DoctorResult): boolean {
  return result.checks.some((c) => !c.ok && c.hard);
}

export function hardFailures(result: DoctorResult): DoctorCheck[] {
  return result.checks.filter((c) => !c.ok && c.hard);
}

export function parseSemver(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function guarded(name: string, hard: boolean, fn: () => Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (err) {
    return { name, ok: false, hard, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** First dir of `jobPath` holding `tool`. */
function onPath(tool: string, jobPath: string, fs: DoctorFs): boolean {
  return jobPath.split(delimiter).some((dir) => dir !== '' && fs.exists(join(dir, tool)));
}

/** True when `<repo>/package.json` has a non-empty `scripts` object. */
function hasNpmScripts(repoPath: string, fs: DoctorFs): boolean {
  const text = fs.readText?.(join(repoPath, 'package.json'));
  if (text === undefined) return false;
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    return typeof scripts === 'object' && scripts !== null && Object.keys(scripts).length > 0;
  } catch {
    return false;
  }
}

/** Generic verify tools: `npm` for a package.json with scripts, `go` for a go.mod, `cargo` for a Cargo.toml. */
export function defaultRepoTools(repoPath: string, fs: DoctorFs): string[] {
  const need: string[] = [];
  if (hasNpmScripts(repoPath, fs)) need.push('npm');
  if (fs.exists(join(repoPath, 'go.mod'))) need.push('go');
  if (fs.exists(join(repoPath, 'Cargo.toml'))) need.push('cargo');
  return need;
}

/**
 * One warning-level check per spec repo: which of its verify tools are missing from the JOB path.
 * The tools are the generic defaults plus the profile's `repos.<name>.tools` when listed there.
 */
export function toolchainChecks(
  repos: ReadonlyArray<{ name: string; path: string }>,
  jobPath: string,
  fs: DoctorFs,
  repoTools: Readonly<Record<string, { tools: readonly string[] }>> = {},
): DoctorCheck[] {
  return repos.map((repo) => {
    const configured = repoTools[repo.name];
    // the configured tools ADD to the generic defaults (npm / go / cargo), they do not replace them
    const need = new Set<string>([...defaultRepoTools(repo.path, fs), ...(configured ? configured.tools : [])]);
    const missing = [...need].filter((t) => !onPath(t, jobPath, fs));
    const name = `toolchain ${repo.name}`;
    if (need.size === 0) return { name, ok: true, hard: false, detail: 'no verify tools to check' };
    return missing.length === 0
      ? { name, ok: true, hard: false, detail: `${[...need].join(', ')} found on the job PATH` }
      : { name, ok: false, hard: false, detail: `not on the job PATH: ${missing.join(', ')} (verify steps that need them will fail)` };
  });
}

/** The command name the link provides (`bin` in package.json). */
const BIN_NAME = 'nightgem';

/**
 * Soft check: does `nightgem` on the user's shell PATH resolve to THIS checkout? Pure lookup (a PATH walk plus realpath), no
 * process is spawned. Missing and stale links both warn with the exact fix; the slash commands work without the link.
 */
export function cliOnPathCheck(input: { env: Readonly<Record<string, string | undefined>>; fs: DoctorFs; cliBinPath: string }): DoctorCheck {
  const name = 'cli on PATH';
  const real = (p: string): string => input.fs.realpath?.(p) ?? p;
  const checkout = dirname(dirname(real(input.cliBinPath)));
  const found = (input.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && isAbsolute(dir))
    .map((dir) => join(dir, BIN_NAME))
    .find((candidate) => input.fs.exists(candidate));
  if (found === undefined) {
    return { name, ok: false, hard: false, detail: `${BIN_NAME} is not on the PATH (the slash commands still work). To add it, run \`npm link\` in ${checkout}` };
  }
  const target = real(found);
  if (target === real(input.cliBinPath)) return { name, ok: true, hard: false, detail: `${BIN_NAME} -> ${checkout}` };
  const other = /\/bin\/[^/]+$/.test(target) ? dirname(dirname(target)) : target;
  return {
    name,
    ok: false,
    hard: false,
    detail: `${BIN_NAME} on the PATH resolves to ${other}, not this checkout. To fix it, run \`npm unlink -g ${BIN_NAME} && npm link\` in ${checkout}`,
  };
}

export async function doctor(opts: DoctorOptions): Promise<DoctorResult> {
  const { exec, fs } = opts;
  const nodePath = opts.nodePath ?? process.execPath;
  const workspaceRoot = opts.workspaceRoot ?? opts.runContext?.workspaceRoot;
  const checks: DoctorCheck[] = [];

  if (opts.runContextError) {
    const e = opts.runContextError;
    checks.push(e instanceof ProfileError ? profileErrorCheck(e) : { name: 'run context', ok: false, hard: true, detail: e.message });
  }

  checks.push(
    await guarded('opencode version', true, async () => {
      const r = await exec('opencode', ['--version']);
      const got = parseSemver(`${r.stdout} ${r.stderr}`);
      if (r.exitCode !== 0 || !got) {
        return { name: 'opencode version', ok: false, hard: true, detail: `opencode --version failed (exit ${r.exitCode})` };
      }
      const want = parseSemver(EXPECTED_OPENCODE_VERSION) as [number, number, number];
      const gotStr = got.join('.');
      if (gotStr === EXPECTED_OPENCODE_VERSION) {
        return { name: 'opencode version', ok: true, hard: false, detail: gotStr };
      }
      const majorMismatch = got[0] !== want[0];
      return {
        name: 'opencode version',
        ok: false,
        hard: majorMismatch,
        detail: `found ${gotStr}, pinned ${EXPECTED_OPENCODE_VERSION}${majorMismatch ? ' (major mismatch)' : ' (warning)'}`,
      };
    }),
  );

  checks.push(
    await guarded('node path', true, async () => {
      const ok = isAbsolute(nodePath) && fs.exists(nodePath);
      return { name: 'node path', ok, hard: true, detail: ok ? nodePath : `node not found at absolute path "${nodePath}"` };
    }),
  );

  checks.push(
    await guarded('sandbox-exec', true, async () => {
      const ok = fs.exists('/usr/bin/sandbox-exec');
      return { name: 'sandbox-exec', ok, hard: true, detail: ok ? '/usr/bin/sandbox-exec' : '/usr/bin/sandbox-exec is missing' };
    }),
  );

  checks.push(
    await guarded('AC power', true, async () => {
      const r = await exec('pmset', ['-g', 'batt']);
      const ok = r.exitCode === 0 && /AC Power/i.test(r.stdout);
      const src = /Now drawing from '([^']+)'/.exec(r.stdout)?.[1] ?? 'unknown';
      return { name: 'AC power', ok, hard: true, detail: ok ? 'on AC power' : `not on AC power (source: ${src})` };
    }),
  );

  checks.push(
    await guarded('free disk', true, async () => {
      if (workspaceRoot === undefined) {
        return { name: 'free disk', ok: false, hard: true, detail: 'no workspace root (no usable profile), so free space cannot be checked' };
      }
      const r = await exec('df', ['-k', workspaceRoot]);
      const line = r.stdout.trim().split('\n').pop() ?? '';
      const availKb = Number(line.trim().split(/\s+/)[3]);
      if (r.exitCode !== 0 || !Number.isFinite(availKb)) {
        return { name: 'free disk', ok: false, hard: true, detail: `could not read free space for ${workspaceRoot}` };
      }
      const gb = availKb / 1024 / 1024;
      const ok = gb >= MIN_FREE_GB;
      return { name: 'free disk', ok, hard: true, detail: `${gb.toFixed(1)} GB free (need ${MIN_FREE_GB} GB)` };
    }),
  );

  checks.push(
    await guarded('lock', true, async () => {
      if (!opts.lockIsFree) return { name: 'lock', ok: true, hard: true, detail: 'lock check not provided' };
      const free = await opts.lockIsFree();
      return { name: 'lock', ok: free, hard: true, detail: free ? 'free' : 'another run holds the lock' };
    }),
  );

  checks.push(
    await guarded('launchctl', true, async () => {
      const ok = fs.exists('/bin/launchctl');
      return { name: 'launchctl', ok, hard: true, detail: ok ? '/bin/launchctl' : '/bin/launchctl is missing' };
    }),
  );

  if (opts.env) checks.push(cliOnPathCheck({ env: opts.env, fs, cliBinPath: opts.cliBinPath ?? CLI_BIN_PATH }));

  if (opts.specRepos && opts.jobPath !== undefined) checks.push(...toolchainChecks(opts.specRepos, opts.jobPath, fs, opts.repoTools));

  if (opts.preflight) {
    try {
      const seen = new Set(checks.map((c) => c.name));
      checks.push(...(await opts.preflight()).filter((c) => !(c.name === 'profile' && seen.has('profile'))));
    } catch (err) {
      checks.push({ name: 'preflight', ok: false, hard: true, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return { checks };
}

/** The longest default doctor line (and launch warning), in characters. */
export const MAX_LINE = 200;
const VERBOSE_HINT = ' ... (run `doctor --verbose` for the full text)';

/** A check that carries a one-line `summary`, used in place of a `detail` that does not fit. Extra field: other code ignores it. */
type SummarizedCheck = DoctorCheck & { summary?: string };
const withSummary = (check: DoctorCheck, summary: string): DoctorCheck => ({ ...check, summary }) as SummarizedCheck;

/**
 * `<prefix><detail>` as ONE line of at most MAX_LINE characters. The full detail when it fits, else the check's summary,
 * else the first line cut short with a pointer to `--verbose`. With `verbose` the detail is printed as is.
 */
export function compactLine(prefix: string, check: DoctorCheck, verbose = false): string {
  const detail = check.detail;
  if (verbose) return `${prefix}${detail}`;
  const fits = (text: string): boolean => !text.includes('\n') && prefix.length + text.length <= MAX_LINE;
  if (fits(detail)) return `${prefix}${detail}`;
  const summary = (check as SummarizedCheck).summary;
  if (summary !== undefined && fits(summary)) return `${prefix}${summary}`;
  const first = (summary ?? detail).split('\n')[0] ?? '';
  const room = Math.max(0, MAX_LINE - prefix.length - VERBOSE_HINT.length);
  return `${prefix}${first.slice(0, room).trimEnd()}${VERBOSE_HINT}`;
}

export function formatDoctor(result: DoctorResult, opts: { verbose?: boolean } = {}): string {
  return result.checks
    .map((c) => compactLine(`${c.ok ? 'ok  ' : c.hard ? 'FAIL' : 'warn'}  ${c.name}: `, c, opts.verbose))
    .join('\n');
}

/** The `warning: ...` line `launch` prints for a failed soft check: always compact. */
export function formatWarning(check: DoctorCheck): string {
  return compactLine(`warning: ${check.name}: `, check);
}

// ---------------------------------------------------------------------------
// Environment checks (profile, slim plugin, skills, tracker, ancestor config)
// ---------------------------------------------------------------------------

/** The slice of `node:fs` the environment checks use. `import * as fs from 'node:fs'` satisfies it. */
export type EnvironmentFs = ProfileFs & SkillsFs;

export interface EnvironmentInput {
  /** Explicit: nothing here reads the real HOME or `process.env`. */
  home: string;
  env: ProfileEnv;
  fs: EnvironmentFs;
  /** Resolve a binary name to a path, or undefined. When omitted the tracker check is skipped. */
  which?: (bin: string) => string | undefined;
}

export interface SlimStatus {
  status: 'ok' | 'absent' | 'wrong-major' | 'uncached' | 'unknown';
  /** Package version when determined. */
  version?: string;
  detail: string;
}

/** Entries of the `plugin` key (a string, or `[name, options]`). Only that key is read: the file also holds provider keys. */
export function readPluginSpecs(text: string): string[] {
  try {
    const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
    const node = tree ? findNodeAtLocation(tree, ['plugin']) : undefined;
    const value: unknown = node ? getNodeValue(node) : undefined;
    if (!Array.isArray(value)) return typeof value === 'string' ? [value] : [];
    return value.map((v) => (Array.isArray(v) ? v[0] : v)).filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

function readJsonVersion(fs: Pick<SkillsFs, 'readFileSync'>, file: string): string | undefined {
  try {
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && SEMVER_RE.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Package version from the opencode cache: the flat `node_modules`, else `npm/<spec>/<stamp>/node_modules` (newest stamp first). */
function cachedSlimVersion(home: string, specVersion: string | undefined, fs: EnvironmentFs): string | undefined {
  const cache = join(home, '.cache', 'opencode');
  const flat = readJsonVersion(fs, join(cache, 'node_modules', SLIM_PACKAGE, 'package.json'));
  if (flat) return flat;
  const npmDir = join(cache, 'npm');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(npmDir).filter((d) => d === SLIM_PACKAGE || d.startsWith(`${SLIM_PACKAGE}@`));
  } catch {
    return undefined;
  }
  const exact = `${SLIM_PACKAGE}@${specVersion ?? 'latest'}`;
  dirs.sort((a, b) => Number(b === exact) - Number(a === exact) || a.localeCompare(b));
  for (const d of dirs) {
    let stamps: string[] = [];
    try {
      stamps = fs.readdirSync(join(npmDir, d)).sort().reverse();
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      const v = readJsonVersion(fs, join(npmDir, d, stamp, 'node_modules', SLIM_PACKAGE, 'package.json'));
      if (v) return v;
    }
  }
  return undefined;
}

/** Is oh-my-opencode-slim configured in the global opencode.json, and which version is installed? Read-only. */
export function detectSlim(input: { home: string; fs: EnvironmentFs }): SlimStatus {
  const { home, fs } = input;
  const dir = join(home, '.config', 'opencode');
  const file = ['opencode.json', 'opencode.jsonc'].map((f) => join(dir, f)).find((f) => fs.existsSync(f));
  // no global config means no "plugin" list, so slim cannot be enabled: a hard failure, not "cannot tell"
  if (!file) return { status: 'absent', detail: `no global opencode.json at ${join(dir, 'opencode.json')}, so ${SLIM_PACKAGE} is not enabled (install it: see the README prerequisites)` };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'unknown', detail: `cannot read ${file}` };
  }
  const entry = readPluginSpecs(text).find((p) => p === SLIM_PACKAGE || p.startsWith(`${SLIM_PACKAGE}@`));
  if (entry === undefined) return { status: 'absent', detail: `${SLIM_PACKAGE} is not in the "plugin" list of ${file} (install it: see the README prerequisites)` };
  const specVersion = entry.includes('@') ? entry.slice(entry.indexOf('@') + 1) : undefined;
  const cached = cachedSlimVersion(home, specVersion, fs);
  if (cached === undefined) {
    // not downloaded yet: hard, pinned or not. A pinned semver is still reported as the version the spec asks for.
    const pinned = specVersion && SEMVER_RE.test(specVersion) ? specVersion : undefined;
    return {
      status: 'uncached',
      ...(pinned ? { version: pinned } : {}),
      detail: `${entry} is configured but not in OpenCode's cache. Start OpenCode once (the TUI, or \`opencode run "hi"\`) so it downloads the plugin, then rerun doctor`,
    };
  }
  const version = cached;
  const major = Number(version.split('.')[0]);
  if (major !== EXPECTED_SLIM_MAJOR) {
    return { status: 'wrong-major', version, detail: `${SLIM_PACKAGE} ${version} found, major ${EXPECTED_SLIM_MAJOR} required` };
  }
  return { status: 'ok', version, detail: `${SLIM_PACKAGE} ${version}` };
}

export function slimCheck(status: SlimStatus): DoctorCheck {
  const name = 'oh-my-opencode-slim';
  if (status.status === 'ok') return { name, ok: true, hard: false, detail: status.detail };
  // 'uncached' is hard: the sandboxed run server cannot download the plugin, so the launch would fail later with missing agents
  if (status.status === 'unknown') return { name, ok: false, hard: false, detail: status.detail };
  return { name, ok: false, hard: true, detail: status.detail };
}

/** The one `profile` FAIL for a failed load: a missing profile carries the install hint, the rest the reasons. */
export function profileErrorCheck(err: ProfileError): DoctorCheck {
  const name = 'profile';
  if (err.code === 'missing') return { name, ok: false, hard: true, detail: `no profile at ${err.path}. Create one with: ${installHint()}` };
  if (err.code === 'invalid-workspace') {
    const reasons = err.reasons ?? [];
    const check: DoctorCheck = { name, ok: false, hard: true, detail: `${err.path}: workspaceRoot rejected:\n${reasons.map((r) => `  - ${r}`).join('\n')}` };
    return withSummary(check, `${err.path}: workspaceRoot rejected: ${reasons.join('; ')}`);
  }
  return { name, ok: false, hard: true, detail: err.message };
}

/** The profile check: path, validity and the workspace-root rejection reasons. A missing profile is one FAIL with the install hint. */
export function profileCheck(input: { home: string; env: ProfileEnv; fs: EnvironmentFs }): { check: DoctorCheck; loaded?: LoadedProfile } {
  const path = resolveProfilePath({ home: input.home, env: input.env });
  const name = 'profile';
  try {
    const loaded = loadProfile({ path, home: input.home, env: input.env, fs: input.fs });
    return { check: { name, ok: true, hard: true, detail: `${path} (valid; workspace ${loaded.profile.workspaceRoot})` }, loaded };
  } catch (err) {
    if (err instanceof ProfileError) return { check: profileErrorCheck(err) };
    return { check: { name, ok: false, hard: true, detail: err instanceof Error ? err.message : String(err) } };
  }
}

/** Required skills and skill-root diagnostics. */
export function skillChecks(det: SkillDetectionResult): DoctorCheck[] {
  const name = 'required skills';
  const checks: DoctorCheck[] = [];
  const excludedReq = new Set(det.excludedRequired);
  const missing = det.missingRequired.filter((n) => !excludedReq.has(n));
  if (missing.length === 0 && excludedReq.size === 0) {
    checks.push({ name, ok: true, hard: true, detail: `all required skills found (${det.available.length} skills available)` });
  } else {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
    if (excludedReq.size > 0) parts.push(`excluded by the profile (skills.exclude): ${[...excludedReq].join(', ')}`);
    const check: DoctorCheck = { name, ok: false, hard: true, detail: `${parts.join('; ')}. Install with: ${SKILLS_HINT}` };
    const shown = missing.slice(0, 3).join(', ') + (missing.length > 3 ? ', ...' : '');
    checks.push(withSummary(check, `${missing.length + excludedReq.size} required skills missing or excluded${shown ? ` (${shown})` : ''}. Install with: ${SKILLS_HINT}`));
  }
  if (det.collisions.length > 0) {
    const n = det.collisions.length;
    checks.push(
      withSummary(
        {
          name: 'skill name collisions',
          ok: false,
          hard: false,
          detail: det.collisions.map((c) => `${c.name} (${c.paths.join(' vs ')}; the first wins)`).join('; '),
        },
        `${n} skill name${n === 1 ? '' : 's'} collide (the first root wins); run \`doctor --verbose\` for the list`,
      ),
    );
  }
  if (det.rootRejected.length > 0) {
    const n = det.rootRejected.length;
    checks.push(
      withSummary(
        {
          name: 'skill roots rejected',
          ok: false,
          hard: false,
          detail: det.rootRejected.map((r) => `${r.root}: ${r.reasons.join(', ')}`).join('; '),
        },
        `${n} skill root${n === 1 ? '' : 's'} rejected (not scanned); run \`doctor --verbose\` for the list`,
      ),
    );
  }
  return checks;
}

/** First word of a command template (the binary). */
function commandBinary(cmd: string): string | undefined {
  const m = /^\s*(?:\w+=\S*\s+)*(\S+)/.exec(cmd);
  return m?.[1];
}

/** Warn when the tracker's fetch command does not resolve. */
export function trackerChecks(profile: LoadedProfile['profile'], which: (bin: string) => string | undefined): DoctorCheck[] {
  const cmd = profile.tracker.fetchCommand;
  if (!cmd) return [];
  const bin = commandBinary(cmd);
  if (!bin) return [];
  const name = 'tracker command';
  const found = bin.includes('/') ? (isAbsolute(bin) ? bin : undefined) : which(bin);
  return found ? [{ name, ok: true, hard: false, detail: `${bin} -> ${found}` }] : [{ name, ok: false, hard: false, detail: `"${bin}" (tracker.fetchCommand) does not resolve on the PATH; the spec phase cannot fetch issues` }];
}

const CONFIG_NAMES = ['.opencode', 'opencode.json', 'opencode.jsonc'] as const;

/**
 * opencode and slim walk EVERY ancestor of the run dir (`<workspace>/.specs/<slug>/.run`) for project config: none may hold one.
 * A `.opencode` directory that only holds `bin` (the official installer's layout) is not config.
 */
export function ancestorConfigCheck(workspaceRoot: string, fs: Pick<SkillsFs, 'existsSync' | 'readdirSync'>): DoctorCheck {
  const found: string[] = [];
  let dir = join(workspaceRoot, '.specs');
  for (;;) {
    for (const f of CONFIG_NAMES) {
      const p = join(dir, f);
      if (!fs.existsSync(p)) continue;
      if (f === '.opencode') {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(p);
        } catch {
          /* a file named .opencode: report it */
        }
        if (entries.length > 0 && entries.every((e) => e === 'bin' || e === 'node_modules')) continue;
      }
      found.push(p);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const check: DoctorCheck = { name: 'no ancestor opencode config', ok: found.length === 0, hard: true, detail: found.length === 0 ? 'none above the run dir' : `found: ${found.join(', ')}` };
  return found.length === 0 ? check : withSummary(check, `${found.length} opencode config(s) above the run dir, first: ${found[0]}; run \`doctor --verbose\` for the list`);
}

export interface EnvironmentResult {
  checks: DoctorCheck[];
  profile?: LoadedProfile;
  detection?: SkillDetectionResult;
  slim: SlimStatus;
}

/** Profile, slim, skills, tracker and ancestor-config checks. Pure: every input is explicit. */
export function environmentChecks(input: EnvironmentInput): EnvironmentResult {
  const { home, env, fs } = input;
  const checks: DoctorCheck[] = [];
  const pc = profileCheck({ home, env, fs });
  checks.push(pc.check);
  const slim = detectSlim({ home, fs });
  checks.push(slimCheck(slim));
  if (!pc.loaded) return { checks, slim };

  const { profile } = pc.loaded;
  const configPath = ['opencode.json', 'opencode.jsonc'].map((f) => join(home, '.config', 'opencode', f)).find((f) => fs.existsSync(f));
  const detection = detectSkills({
    home,
    fs,
    ...(configPath ? { opencodeConfigPath: configPath } : {}),
    extraRoots: profile.skills.extraRoots,
    exclude: profile.skills.exclude,
    required: profile.skills.required,
  });
  checks.push(...skillChecks(detection));
  if (input.which) checks.push(...trackerChecks(profile, input.which));
  checks.push(ancestorConfigCheck(profile.workspaceRoot, fs));
  return { checks, profile: pc.loaded, detection, slim };
}
